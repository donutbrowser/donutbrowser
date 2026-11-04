//! How often a profile ran on this device, and for how long.
//!
//! Kept per device in `profile_activity.json` beside the profiles and never
//! synced: a launch must not change a profile's `updated_at`. Run time counts
//! only while Donut is open: quitting closes every open session, and a browser
//! Donut finds still running at the next start opens a new one.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileActivity {
  pub launches: u64,
  pub run_seconds: u64,
  /// Unix seconds the open session started; `None` while it is not running here.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub running_since: Option<u64>,
}

type Store = BTreeMap<String, ProfileActivity>;

/// One read-modify-write at a time.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
  crate::app_dirs::data_dir().join("profile_activity.json")
}

fn read_store() -> Store {
  std::fs::read(store_path())
    .ok()
    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    .unwrap_or_default()
}

fn update(change: impl FnOnce(&mut Store) -> bool) {
  let _guard = STORE_LOCK
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let mut store = read_store();
  if !change(&mut store) {
    return;
  }
  let written = serde_json::to_vec(&store)
    .map_err(std::io::Error::other)
    .and_then(|bytes| crate::profile::encryption::atomic_write(&store_path(), &bytes));
  if let Err(e) = written {
    log::warn!("Profile activity save failed err=\"{e}\"");
  }
}

fn now() -> u64 {
  crate::proxy_manager::now_secs()
}

/// Adds the open session's time to the total and closes it.
fn close(activity: &mut ProfileActivity, at: u64) -> bool {
  let Some(since) = activity.running_since.take() else {
    return false;
  };
  activity.run_seconds += at.saturating_sub(since);
  true
}

fn start(activity: &mut ProfileActivity, at: u64) {
  close(activity, at);
  activity.launches += 1;
  activity.running_since = Some(at);
}

/// A launch from this device started the browser.
pub fn launched(profile_id: &str) {
  let at = now();
  update(|store| {
    start(store.entry(profile_id.to_string()).or_default(), at);
    true
  });
}

/// Donut found the profile's browser running without launching it (after a
/// restart). The session counts from now; it is not a new launch.
pub fn resumed(profile_id: &str) {
  let at = now();
  update(|store| {
    let activity = store.entry(profile_id.to_string()).or_default();
    if activity.running_since.is_some() {
      return false;
    }
    activity.running_since = Some(at);
    true
  });
}

/// The profile's browser is no longer running.
pub fn stopped(profile_id: &str) {
  let at = now();
  update(|store| {
    store
      .get_mut(profile_id)
      .is_some_and(|activity| close(activity, at))
  });
}

/// Donut is quitting: every open session ends now.
pub fn close_all() {
  let at = now();
  update(|store| {
    let mut changed = false;
    for activity in store.values_mut() {
      changed |= close(activity, at);
    }
    changed
  });
}

/// The profile is gone for good.
pub fn forget(profile_id: &str) {
  update(|store| store.remove(profile_id).is_some());
}

/// The activity of one profile on this device; zero when it never ran here.
#[tauri::command]
pub fn get_profile_activity(profile_id: String) -> ProfileActivity {
  read_store().remove(&profile_id).unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_session_adds_its_time_once() {
    let mut activity = ProfileActivity::default();
    start(&mut activity, 100);
    assert_eq!(activity.launches, 1);
    assert_eq!(activity.running_since, Some(100));
    assert!(close(&mut activity, 160));
    assert!(!close(&mut activity, 500));
    assert_eq!(activity.run_seconds, 60);
    assert_eq!(activity.running_since, None);
  }

  #[test]
  fn a_launch_over_an_open_session_closes_it_first() {
    let mut activity = ProfileActivity::default();
    start(&mut activity, 100);
    start(&mut activity, 130);
    assert_eq!(activity.launches, 2);
    assert_eq!(activity.run_seconds, 30);
    assert_eq!(activity.running_since, Some(130));
  }

  #[test]
  fn a_clock_that_went_back_adds_nothing() {
    let mut activity = ProfileActivity::default();
    start(&mut activity, 100);
    close(&mut activity, 40);
    assert_eq!(activity.run_seconds, 0);
  }

  #[test]
  fn the_store_counts_launches_and_closes_on_quit() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(dir.path().to_path_buf());
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(get_profile_activity(id.clone()), ProfileActivity::default());
    launched(&id);
    launched(&id);
    let open = get_profile_activity(id.clone());
    assert_eq!(open.launches, 2);
    assert!(open.running_since.is_some());
    close_all();
    let closed = get_profile_activity(id.clone());
    assert_eq!(closed.running_since, None);
    resumed(&id);
    stopped(&id);
    assert_eq!(get_profile_activity(id.clone()).launches, 2);
    forget(&id);
    assert_eq!(get_profile_activity(id), ProfileActivity::default());
  }
}
