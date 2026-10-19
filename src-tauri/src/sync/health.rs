//! One state for the whole of sync, for the header indicator.
//!
//! The scheduler opens a pass when it has work, records each failure, and
//! closes the pass. `sync-health-changed` goes out only when the state or its
//! code changes, so a steady state costs nothing.

use super::types::SyncError;
use serde::Serialize;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncHealthState {
  Idle,
  Syncing,
  Offline,
  Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncHealth {
  pub state: SyncHealthState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub code: Option<String>,
  /// Unix seconds of the change.
  pub at: u64,
}

impl SyncHealth {
  fn same_as(&self, other: &SyncHealth) -> bool {
    self.state == other.state && self.code == other.code
  }
}

#[derive(Default)]
struct Tracker {
  current: Option<SyncHealth>,
  /// The worst failure of the pass in progress.
  pass_failure: Option<(SyncHealthState, String)>,
}

impl Tracker {
  /// Move to `next`, and return it when it differs from the current state.
  fn set(&mut self, state: SyncHealthState, code: Option<String>, at: u64) -> Option<SyncHealth> {
    let next = SyncHealth { state, code, at };
    if self.current.as_ref().is_some_and(|c| c.same_as(&next)) {
      return None;
    }
    self.current = Some(next.clone());
    Some(next)
  }

  fn begin_pass(&mut self, at: u64) -> Option<SyncHealth> {
    self.pass_failure = None;
    self.set(SyncHealthState::Syncing, None, at)
  }

  /// An unreachable server explains every other failure of the pass, so it
  /// replaces one; otherwise the first failure stands.
  fn record(&mut self, state: SyncHealthState, code: String) {
    let replace = match &self.pass_failure {
      None => true,
      Some((current, _)) => {
        state == SyncHealthState::Offline && *current != SyncHealthState::Offline
      }
    };
    if replace {
      self.pass_failure = Some((state, code));
    }
  }

  fn end_pass(&mut self, at: u64) -> Option<SyncHealth> {
    match self.pass_failure.take() {
      Some((state, code)) => self.set(state, Some(code), at),
      None => self.set(SyncHealthState::Idle, None, at),
    }
  }
}

static TRACKER: Mutex<Tracker> = Mutex::new(Tracker {
  current: None,
  pass_failure: None,
});

fn with_tracker<R>(f: impl FnOnce(&mut Tracker) -> R) -> R {
  let mut tracker = TRACKER.lock().unwrap_or_else(|e| e.into_inner());
  f(&mut tracker)
}

fn emit(change: Option<SyncHealth>) {
  let Some(health) = change else {
    return;
  };
  match (&health.state, &health.code) {
    (SyncHealthState::Offline | SyncHealthState::Error, Some(code)) => {
      log::info!("Sync health changed state={:?} code={code}", health.state)
    }
    _ => log::debug!("Sync health changed state={:?}", health.state),
  }
  if let Err(e) = crate::events::emit("sync-health-changed", &health) {
    log::warn!("Event emit failed event=sync-health-changed err=\"{e}\"");
  }
}

/// A scheduler pass with work to do is starting.
pub fn begin_pass() {
  emit(with_tracker(|t| {
    t.begin_pass(crate::proxy_manager::now_secs())
  }));
}

/// That pass is over.
pub fn end_pass() {
  emit(with_tracker(|t| {
    t.end_pass(crate::proxy_manager::now_secs())
  }));
}

pub fn record_failure(error: &SyncError) {
  if matches!(error, SyncError::Cancelled | SyncError::NotConfigured) {
    return;
  }
  let state = if error.is_offline() {
    SyncHealthState::Offline
  } else {
    SyncHealthState::Error
  };
  let code = error.user_code().0;
  with_tracker(|t| t.record(state, code));
}

/// The engine could not be built: no token, no network, no settings.
pub fn record_setup_failure(reason: &str) {
  let state = if super::types::engine_setup_is_offline(reason) {
    SyncHealthState::Offline
  } else {
    SyncHealthState::Error
  };
  let code = super::types::engine_setup_code_name(reason).to_string();
  with_tracker(|t| t.record(state, code));
}

/// Forget the state when the pipeline stops, so a signed-out app shows none.
pub fn reset() {
  with_tracker(|t| *t = Tracker::default());
}

/// The state now, or nothing when sync is not set up or has not run yet.
#[tauri::command]
pub fn get_sync_health() -> Option<SyncHealth> {
  if !super::is_sync_configured() {
    return None;
  }
  with_tracker(|t| t.current.clone())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_quiet_pass_goes_syncing_then_idle_and_repeats_nothing() {
    let mut t = Tracker::default();
    assert_eq!(t.begin_pass(1).unwrap().state, SyncHealthState::Syncing);
    assert_eq!(t.end_pass(2).unwrap().state, SyncHealthState::Idle);
    assert_eq!(
      t.begin_pass(3).unwrap().state,
      SyncHealthState::Syncing,
      "every pass with work shows as syncing"
    );
    assert_eq!(t.end_pass(4).unwrap().state, SyncHealthState::Idle);
    assert!(t.set(SyncHealthState::Idle, None, 5).is_none());
  }

  #[test]
  fn a_failure_ends_the_pass_in_error_with_its_code() {
    let mut t = Tracker::default();
    t.begin_pass(1);
    t.record(SyncHealthState::Error, "SYNC_AUTH_FAILED".into());
    t.record(SyncHealthState::Error, "SYNC_DATA_INVALID".into());
    let change = t.end_pass(2).unwrap();
    assert_eq!(change.state, SyncHealthState::Error);
    assert_eq!(change.code.as_deref(), Some("SYNC_AUTH_FAILED"));
  }

  #[test]
  fn offline_explains_other_failures_of_the_pass() {
    let mut t = Tracker::default();
    t.begin_pass(1);
    t.record(SyncHealthState::Error, "SYNC_DATA_INVALID".into());
    t.record(SyncHealthState::Offline, "SYNC_SERVER_UNREACHABLE".into());
    t.record(SyncHealthState::Error, "SYNC_AUTH_FAILED".into());
    let change = t.end_pass(2).unwrap();
    assert_eq!(change.state, SyncHealthState::Offline);
    assert_eq!(change.code.as_deref(), Some("SYNC_SERVER_UNREACHABLE"));
  }

  #[test]
  fn the_payload_matches_the_frontend_contract() {
    let health = SyncHealth {
      state: SyncHealthState::Offline,
      code: Some("SYNC_SERVER_UNREACHABLE".into()),
      at: 7,
    };
    assert_eq!(
      serde_json::to_value(&health).unwrap(),
      serde_json::json!({ "state": "offline", "code": "SYNC_SERVER_UNREACHABLE", "at": 7 })
    );
    let idle = SyncHealth {
      state: SyncHealthState::Idle,
      code: None,
      at: 8,
    };
    assert_eq!(
      serde_json::to_value(&idle).unwrap(),
      serde_json::json!({ "state": "idle", "at": 8 })
    );
  }
}
