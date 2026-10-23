//! Whether the proxy or VPN of each profile enrolled in the cookie bot still
//! answers, checked from this computer.
//!
//! A run on a dead exit leases a host and bills its time for nothing, night
//! after night. A confirmed failure is declared to the server as
//! `exit_alive: false`, which holds the schedule until a check passes again.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use crate::cookie_bot::CookieBotSchedule;
use crate::profile::BrowserProfile;

const FIRST_TICK: Duration = Duration::from_secs(2 * 60);
const TICK: Duration = Duration::from_secs(10 * 60);
const RECHECK_SECS: u64 = 6 * 60 * 60;
const BEFORE_RUN_SECS: u64 = 2 * 60 * 60;
const BEFORE_RUN_RECHECK_SECS: u64 = 60 * 60;
/// A failure counts once a second one follows at least this long after the
/// first, so one bad moment on this computer's network stops no schedule.
const CONFIRM_SECS: u64 = 10 * 60;
const FAILING_RECHECK_SECS: u64 = 30 * 60;
/// The server's outcome for an exit that could not be reached, set from this
/// computer's checks or from a run that found it dead.
const PROXY_DEAD: &str = "proxy_dead";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ExitCheck {
  /// The exit and a hash of its settings, so an edited or swapped exit starts
  /// over.
  exit: String,
  checked_at: u64,
  ok: bool,
  /// When the current run of failures began.
  #[serde(default)]
  failing_since: Option<u64>,
  #[serde(default)]
  failures: u32,
  /// The last finished run a check followed.
  #[serde(default)]
  last_run_id: Option<String>,
}

impl ExitCheck {
  fn alive(&self) -> bool {
    let confirmed = self.failures >= 2
      && self
        .failing_since
        .is_some_and(|since| self.checked_at.saturating_sub(since) >= CONFIRM_SECS);
    !confirmed
  }

  fn next(
    previous: Option<&ExitCheck>,
    exit: &str,
    ok: bool,
    now: u64,
    last_run_id: Option<String>,
  ) -> ExitCheck {
    let previous = previous.filter(|check| check.exit == exit);
    let (failures, failing_since) = if ok {
      (0, None)
    } else {
      (
        previous.map_or(0, |check| check.failures) + 1,
        Some(
          previous
            .and_then(|check| check.failing_since)
            .unwrap_or(now),
        ),
      )
    };
    ExitCheck {
      exit: exit.to_string(),
      checked_at: now,
      ok,
      failing_since,
      failures,
      last_run_id: last_run_id.or_else(|| previous.and_then(|check| check.last_run_id.clone())),
    }
  }
}

/// The last check of a profile's exit, as the enrolment shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct ExitCheckView {
  /// Unix seconds.
  pub checked_at: u64,
  /// Whether that check reached the exit.
  pub ok: bool,
  /// What the desktop declares: false once the failures are confirmed.
  pub alive: bool,
}

/// Why a check of the exit is due now, if it is.
fn due(
  check: Option<&ExitCheck>,
  exit: &str,
  schedule: &CookieBotSchedule,
  finished_run: Option<&str>,
  now: u64,
) -> bool {
  let Some(check) = check.filter(|check| check.exit == exit) else {
    return true;
  };
  let age = now.saturating_sub(check.checked_at);
  if finished_run.is_some() && finished_run != check.last_run_id.as_deref() {
    return true;
  }
  if !check.ok {
    let wait = if check.alive() {
      CONFIRM_SECS
    } else {
      FAILING_RECHECK_SECS
    };
    return age >= wait;
  }
  if schedule.blocked_by.as_deref() == Some(PROXY_DEAD) && age >= FAILING_RECHECK_SECS {
    return true;
  }
  let run_soon = schedule
    .next_run_at
    .as_deref()
    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
    .is_some_and(|at| at.timestamp().saturating_sub(now as i64) <= BEFORE_RUN_SECS as i64);
  if run_soon && age >= BEFORE_RUN_RECHECK_SECS {
    return true;
  }
  age >= RECHECK_SECS
}

/// The exit a profile routes through and a hash of its settings, or `None`
/// when it has none this computer knows.
fn exit_key(profile: &BrowserProfile) -> Option<String> {
  use sha2::{Digest, Sha256};
  let (kind, id, settings) = if let Some(id) = profile.proxy_id.as_deref() {
    let proxy = crate::proxy_manager::PROXY_MANAGER
      .get_stored_proxies()
      .into_iter()
      .find(|proxy| proxy.id == id)?;
    ("proxy", id, serde_json::to_vec(&proxy.proxy_settings).ok()?)
  } else {
    let id = profile.vpn_id.as_deref()?;
    let config = crate::vpn::VPN_STORAGE.lock().ok()?.load_config(id).ok()?;
    ("vpn", id, config.config_data.into_bytes())
  };
  let digest = Sha256::digest(&settings);
  let hash: String = digest[..8]
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
  Some(format!("{kind}:{id}:{hash}"))
}

fn checks_path() -> PathBuf {
  crate::app_dirs::settings_dir().join("cookie_bot_exit_checks.json")
}

fn load() -> HashMap<String, ExitCheck> {
  std::fs::read(checks_path())
    .ok()
    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    .unwrap_or_default()
}

fn save(checks: &HashMap<String, ExitCheck>) {
  let path = checks_path();
  let tmp = path.with_extension("json.tmp");
  let written = serde_json::to_vec(checks)
    .map_err(std::io::Error::other)
    .and_then(|bytes| {
      if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
      }
      std::fs::write(&tmp, bytes)?;
      std::fs::rename(&tmp, &path)
    });
  if let Err(e) = written {
    log::warn!("Cookie bot exit checks save failed err=\"{e}\"");
  }
}

static CHECKS: LazyLock<Mutex<HashMap<String, ExitCheck>>> = LazyLock::new(|| Mutex::new(load()));
/// One check at a time: the timer and an enrolment can ask for the same one.
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn stored(profile_id: &str) -> Option<ExitCheck> {
  CHECKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .get(profile_id)
    .cloned()
}

fn store(profile_id: &str, check: ExitCheck) {
  let mut checks = CHECKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  checks.insert(profile_id.to_string(), check);
  save(&checks);
}

/// What the desktop declares about the profile's exit. An exit never
/// checked, or changed since its last check, counts as alive.
pub fn exit_alive(profile: &BrowserProfile) -> bool {
  let Some(exit) = exit_key(profile) else {
    return true;
  };
  stored(&profile.id.to_string())
    .filter(|check| check.exit == exit)
    .is_none_or(|check| check.alive())
}

fn view(profile: &BrowserProfile) -> Option<ExitCheckView> {
  let exit = exit_key(profile)?;
  stored(&profile.id.to_string())
    .filter(|check| check.exit == exit)
    .map(|check| ExitCheckView {
      checked_at: check.checked_at,
      ok: check.ok,
      alive: check.alive(),
    })
}

/// Put the last check of each profile this computer has on its enrolment.
pub fn attach_views(schedules: &mut [CookieBotSchedule]) {
  let Ok(profiles) = crate::profile::ProfileManager::instance().list_profiles() else {
    return;
  };
  for schedule in schedules {
    schedule.exit_check = profiles
      .iter()
      .find(|profile| profile.id.to_string() == schedule.profile_id)
      .and_then(view);
  }
}

async fn reach_exit(profile: &BrowserProfile) -> Result<(), String> {
  if let Some(proxy_id) = profile.proxy_id.as_deref() {
    let proxy = crate::proxy_manager::PROXY_MANAGER
      .get_stored_proxies()
      .into_iter()
      .find(|proxy| proxy.id == proxy_id)
      .ok_or("proxy not found")?;
    let result = crate::proxy_manager::PROXY_MANAGER
      .check_proxy_validity(proxy_id, &proxy.proxy_settings)
      .await?;
    return if result.is_valid {
      Ok(())
    } else {
      Err("proxy check failed".to_string())
    };
  }
  if let Some(vpn_id) = profile.vpn_id.as_deref() {
    return crate::check_vpn_validity_core(vpn_id).await.map(|_| ());
  }
  Ok(())
}

/// Check the profile's exit and declare the result to the server when what it
/// believes has to change. `schedule` is the enrolment as last read, when the
/// caller has it.
async fn check_and_declare(
  profile: &BrowserProfile,
  schedule: Option<&CookieBotSchedule>,
  finished_run: Option<String>,
) {
  let _one = CHECKING.lock().await;
  let Some(exit) = exit_key(profile) else {
    return;
  };
  let profile_id = profile.id.to_string();
  let started = std::time::Instant::now();
  let reached = reach_exit(profile).await;
  // A failure counts only while the cloud answers: offline, this computer
  // cannot tell a dead exit from its own missing network.
  let schedule = match (&reached, schedule) {
    (Err(_), _) => match crate::cookie_bot::get_schedule(&profile_id).await {
      Ok(Some(schedule)) => Some(schedule),
      Ok(None) => return,
      Err(e) => {
        log::debug!(
          "Cookie bot exit check not counted, cloud unreachable profile={profile_id} err=\"{e}\""
        );
        return;
      }
    },
    (Ok(_), schedule) => schedule.cloned(),
  };

  let previous = stored(&profile_id).filter(|check| check.exit == exit);
  let was_alive = previous.as_ref().is_none_or(ExitCheck::alive);
  let check = ExitCheck::next(
    previous.as_ref(),
    &exit,
    reached.is_ok(),
    crate::proxy_manager::now_secs(),
    finished_run,
  );
  let alive = check.alive();
  store(&profile_id, check);

  let elapsed_ms = started.elapsed().as_millis();
  match &reached {
    Ok(()) => {
      log::debug!("Cookie bot exit check passed profile={profile_id} elapsed_ms={elapsed_ms}")
    }
    Err(e) => log::debug!(
      "Cookie bot exit check failed profile={profile_id} elapsed_ms={elapsed_ms} err=\"{e}\""
    ),
  }
  let blocked_dead = schedule
    .as_ref()
    .is_some_and(|schedule| schedule.blocked_by.as_deref() == Some(PROXY_DEAD));
  if alive != was_alive || (alive && blocked_dead) {
    log::info!("Cookie bot exit declared profile={profile_id} alive={alive}");
    crate::cookie_bot::declare_profile_state(profile).await;
  }
}

/// Check a profile's exit soon after it is enrolled.
pub fn check_after_enrolment(profile_id: &str) {
  let profile_id = profile_id.to_string();
  tauri::async_runtime::spawn(async move {
    let profile = crate::profile::ProfileManager::instance()
      .list_profiles()
      .ok()
      .and_then(|profiles| {
        profiles
          .into_iter()
          .find(|profile| profile.id.to_string() == profile_id)
      });
    if let Some(profile) = profile {
      check_and_declare(&profile, None, None).await;
    }
  });
}

/// The run that last finished on this enrolment, when it is newer than the
/// one the last check followed.
async fn newly_finished_run(
  schedule: &CookieBotSchedule,
  check: Option<&ExitCheck>,
) -> Option<String> {
  let last = schedule.last_run_id.as_deref()?;
  if check.and_then(|check| check.last_run_id.as_deref()) == Some(last) {
    return None;
  }
  let page = crate::cookie_bot::list_runs(Some(&schedule.profile_id), None, Some(1), None)
    .await
    .ok()?;
  page
    .runs
    .into_iter()
    .next()
    .filter(|run| run.ended_at.is_some())
    .map(|run| run.id)
    .filter(|id| check.and_then(|check| check.last_run_id.as_deref()) != Some(id.as_str()))
}

async fn tick() {
  let auth = &crate::cloud_auth::CLOUD_AUTH;
  if !auth.is_logged_in().await || !auth.can_use_cookie_bot().await {
    return;
  }
  let Ok(list) = crate::cookie_bot::list_schedules(None).await else {
    return;
  };
  let Ok(profiles) = crate::profile::ProfileManager::instance().list_profiles() else {
    return;
  };
  let now = crate::proxy_manager::now_secs();
  for schedule in list.schedules.iter().filter(|schedule| schedule.enabled) {
    let Some(profile) = profiles
      .iter()
      .find(|profile| profile.id.to_string() == schedule.profile_id)
    else {
      continue;
    };
    let Some(exit) = exit_key(profile) else {
      continue;
    };
    let previous = stored(&schedule.profile_id);
    let finished_run = newly_finished_run(schedule, previous.as_ref()).await;
    if due(
      previous.as_ref(),
      &exit,
      schedule,
      finished_run.as_deref(),
      now,
    ) {
      check_and_declare(profile, Some(schedule), finished_run).await;
    }
  }
}

/// Keep checking the exits of enrolled profiles while the app runs.
pub async fn run_checks() {
  tokio::time::sleep(FIRST_TICK).await;
  loop {
    tick().await;
    tokio::time::sleep(TICK).await;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const NOW: u64 = 1_800_000_000;
  const EXIT: &str = "proxy:p1:00";

  fn schedule() -> CookieBotSchedule {
    serde_json::from_value(serde_json::json!({
      "profile_id": "p1", "profile_name": "P", "platform": "windows", "enabled": true,
      "run_at_minute": 120, "days_mask": 127, "timezone": "UTC", "preset": "general",
      "max_minutes": 60,
    }))
    .unwrap()
  }

  fn check(ok: bool, checked_at: u64) -> ExitCheck {
    ExitCheck::next(None, EXIT, ok, checked_at, None)
  }

  #[test]
  fn one_failure_is_not_enough_to_stop_a_schedule() {
    let first = check(false, NOW);
    assert!(first.alive());
    let soon = ExitCheck::next(Some(&first), EXIT, false, NOW + 60, None);
    assert!(
      soon.alive(),
      "two failures a minute apart are one bad moment"
    );
    let later = ExitCheck::next(Some(&soon), EXIT, false, NOW + CONFIRM_SECS, None);
    assert!(!later.alive());
    let back = ExitCheck::next(Some(&later), EXIT, true, NOW + 2 * CONFIRM_SECS, None);
    assert!(back.alive());
    assert_eq!(back.failures, 0);
  }

  #[test]
  fn a_changed_exit_starts_over() {
    let first = check(false, NOW);
    let other = ExitCheck::next(Some(&first), "proxy:p1:ff", false, NOW + CONFIRM_SECS, None);
    assert_eq!(other.failures, 1);
    assert!(other.alive());
  }

  #[test]
  fn a_check_is_due_when_its_evidence_is_old_or_a_run_is_near() {
    let mut enrolment = schedule();
    assert!(due(None, EXIT, &enrolment, None, NOW));
    let fresh = check(true, NOW);
    assert!(!due(Some(&fresh), EXIT, &enrolment, None, NOW + 60));
    assert!(due(Some(&fresh), "proxy:p1:ff", &enrolment, None, NOW + 60));
    assert!(due(
      Some(&fresh),
      EXIT,
      &enrolment,
      None,
      NOW + RECHECK_SECS
    ));

    enrolment.next_run_at =
      chrono::DateTime::from_timestamp((NOW + 3_600) as i64, 0).map(|at| at.to_rfc3339());
    assert!(!due(Some(&fresh), EXIT, &enrolment, None, NOW + 600));
    assert!(due(
      Some(&fresh),
      EXIT,
      &enrolment,
      None,
      NOW + BEFORE_RUN_RECHECK_SECS
    ));
  }

  #[test]
  fn a_finished_run_and_a_server_block_ask_for_a_check() {
    let mut enrolment = schedule();
    let fresh = check(true, NOW);
    assert!(due(Some(&fresh), EXIT, &enrolment, Some("run-1"), NOW + 60));
    let followed = ExitCheck::next(Some(&fresh), EXIT, true, NOW, Some("run-1".to_string()));
    assert!(!due(
      Some(&followed),
      EXIT,
      &enrolment,
      Some("run-1"),
      NOW + 60
    ));

    enrolment.blocked_by = Some(PROXY_DEAD.to_string());
    assert!(!due(Some(&fresh), EXIT, &enrolment, None, NOW + 60));
    assert!(due(
      Some(&fresh),
      EXIT,
      &enrolment,
      None,
      NOW + FAILING_RECHECK_SECS
    ));
  }

  #[test]
  fn a_failure_is_confirmed_soon_and_a_dead_exit_is_rechecked_less_often() {
    let enrolment = schedule();
    let first = check(false, NOW);
    assert!(!due(Some(&first), EXIT, &enrolment, None, NOW + 60));
    assert!(due(
      Some(&first),
      EXIT,
      &enrolment,
      None,
      NOW + CONFIRM_SECS
    ));
    let dead = ExitCheck::next(Some(&first), EXIT, false, NOW + CONFIRM_SECS, None);
    assert!(!dead.alive());
    let checked = dead.checked_at;
    assert!(!due(
      Some(&dead),
      EXIT,
      &enrolment,
      None,
      checked + CONFIRM_SECS
    ));
    assert!(due(
      Some(&dead),
      EXIT,
      &enrolment,
      None,
      checked + FAILING_RECHECK_SECS
    ));
  }
}
