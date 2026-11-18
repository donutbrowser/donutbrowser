//! Runs the account's scheduled routines while the app is open. The cloud
//! keeps each routine's next fire; at that time this desktop claims the due
//! fires and runs them. A fire no desktop claims is recorded as missed.
//! While a routine has a webhook, whose fires come at no set time, this
//! desktop also claims every `HOOK_POLL`.

use super::cloud::{self, Routine};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// The longest wait before the routines are read again, for edits made on
/// another device.
const REREAD_EVERY: Duration = Duration::from_secs(10 * 60);
/// A list this fresh is used as it is.
const FRESH_FOR: Duration = Duration::from_secs(60);
/// Claim this long after a fire is due, for a clock a little behind the cloud's.
const CLAIM_DELAY: Duration = Duration::from_secs(2);
/// The wait after a claim, while the cloud moves the routine's next fire.
const AFTER_CLAIM: Duration = Duration::from_secs(15);
/// How often a desktop claims while a routine has a webhook.
const HOOK_POLL: Duration = Duration::from_secs(30);

static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);
static KNOWN: Mutex<Option<(Instant, Vec<Routine>)>> = Mutex::new(None);
static CLAIMS: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent routine claim");

/// A fresh routine list, from the page or a save: plan the next fire from it.
pub fn observe(routines: &[Routine]) {
  if let Ok(mut known) = KNOWN.lock() {
    *known = Some((Instant::now(), routines.to_vec()));
  }
  WAKE.notify_one();
}

/// A routine changed here: read the list again.
pub fn changed() {
  if let Ok(mut known) = KNOWN.lock() {
    *known = None;
  }
  WAKE.notify_one();
}

/// The earliest next fire of the enabled, scheduled routines, in unix seconds.
pub fn earliest_fire(routines: &[Routine]) -> Option<i64> {
  routines
    .iter()
    .filter(|routine| routine.enabled && routine.schedule.is_some())
    .filter_map(|routine| routine.next_run_at.as_deref())
    .filter_map(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
    .map(|at| at.timestamp())
    .min()
}

/// How long to wait for a fire at `at`, from `now` (unix seconds).
pub fn wait_for(at: Option<i64>, now: i64) -> Duration {
  match at {
    Some(at) if at > now => {
      (Duration::from_secs((at - now) as u64) + CLAIM_DELAY).min(REREAD_EVERY)
    }
    Some(_) => Duration::ZERO,
    None => REREAD_EVERY,
  }
}

pub fn start() {
  tauri::async_runtime::spawn(async {
    loop {
      let wait = step().await;
      tokio::select! {
        _ = tokio::time::sleep(wait) => {}
        _ = WAKE.notified() => {}
      }
    }
  });
}

async fn routines() -> Result<Vec<Routine>, String> {
  let fresh = KNOWN
    .lock()
    .ok()
    .and_then(|known| known.clone())
    .filter(|(at, _)| at.elapsed() < FRESH_FOR);
  if let Some((_, routines)) = fresh {
    return Ok(routines);
  }
  let routines = cloud::list_routines().await?;
  if let Ok(mut known) = KNOWN.lock() {
    *known = Some((Instant::now(), routines.clone()));
  }
  Ok(routines)
}

/// Whether an enabled routine has a webhook.
pub fn hooked(routines: &[Routine]) -> bool {
  routines
    .iter()
    .any(|routine| routine.enabled && routine.hook.is_some())
}

/// One pass: claim what is due, and say how long to sleep.
async fn step() -> Duration {
  if super::ensure_entitled().await.is_err() {
    return REREAD_EVERY;
  }
  let scheduling = super::can_schedule().await;
  let hooks = super::integrations::entitled().await;
  if !scheduling && !hooks {
    return REREAD_EVERY;
  }
  let routines = match routines().await {
    Ok(routines) => routines,
    Err(e) => {
      CLAIMS.failed(e);
      return REREAD_EVERY;
    }
  };
  let now = crate::proxy_manager::now_secs() as i64;
  let wait = if scheduling {
    wait_for(earliest_fire(&routines), now)
  } else {
    REREAD_EVERY
  };
  let polling = hooks && hooked(&routines);
  if !wait.is_zero() && !polling {
    return wait;
  }
  let mut claimed = false;
  match cloud::claim_fires().await {
    Ok(fires) => {
      CLAIMS.succeeded();
      claimed = !fires.is_empty();
      for fire in fires {
        log::info!(
          "Agent routine fire claimed routine={} batch={} trigger={}",
          fire.routine_id,
          fire.batch_id,
          fire.trigger.as_deref().unwrap_or("schedule")
        );
        tokio::spawn(async move {
          let _ =
            super::run_scheduled_fire(&fire.routine_id, &fire.batch_id, fire.input.as_deref())
              .await;
        });
      }
    }
    Err(e) => CLAIMS.failed(e),
  }
  if wait.is_zero() || claimed {
    changed();
  }
  if wait.is_zero() {
    AFTER_CLAIM
  } else {
    wait.min(HOOK_POLL)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent_tasks::cloud::RoutineSchedule;

  fn routine(enabled: bool, scheduled: bool, next: Option<&str>) -> Routine {
    Routine {
      id: "r".into(),
      name: "R".into(),
      prompt: "p".into(),
      start_url: None,
      profile_ids: vec!["p".into()],
      schedule: scheduled.then(|| RoutineSchedule {
        cron: "0 9 * * *".into(),
        timezone: "UTC".into(),
      }),
      max_credits_per_run: None,
      concurrency: None,
      enabled,
      effort: None,
      pace: None,
      caps: None,
      output: None,
      playbook_ids: Vec::new(),
      hook: None,
      next_run_at: next.map(str::to_string),
      created_at: None,
      updated_at: None,
    }
  }

  #[test]
  fn only_enabled_scheduled_routines_set_the_next_fire() {
    let list = [
      routine(false, true, Some("2026-11-19T08:00:00.000Z")),
      routine(true, false, Some("2026-11-19T08:30:00.000Z")),
      routine(true, true, Some("2026-11-19T10:00:00.000Z")),
      routine(true, true, Some("2026-11-19T09:00:00Z")),
      routine(true, true, None),
    ];
    assert_eq!(
      earliest_fire(&list),
      Some(
        chrono::DateTime::parse_from_rfc3339("2026-11-19T09:00:00Z")
          .unwrap()
          .timestamp()
      )
    );
    assert_eq!(earliest_fire(&[routine(true, true, None)]), None);
  }

  #[test]
  fn the_wait_ends_just_after_the_fire_and_never_exceeds_the_reread() {
    assert_eq!(wait_for(Some(1_000), 1_000), Duration::ZERO);
    assert_eq!(wait_for(Some(900), 1_000), Duration::ZERO);
    assert_eq!(
      wait_for(Some(1_060), 1_000),
      Duration::from_secs(60) + CLAIM_DELAY
    );
    assert_eq!(wait_for(Some(1_000_000), 1_000), REREAD_EVERY);
    assert_eq!(wait_for(None, 1_000), REREAD_EVERY);
  }
}
