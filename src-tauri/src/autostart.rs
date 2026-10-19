//! Launch at login, and the profiles to open again at the next start.
//!
//! The login item is the autostart plugin's, named after the app's data
//! directory (`DonutBrowser`, `DonutBrowserDev` for a debug build), so it never
//! shares a name with the old daemon's entry that `legacy_autostart` removes.
//!
//! The profiles to reopen live in a file of their own: the frontend writes the
//! whole of `AppSettings` on every save, and would overwrite them there.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Make the login item match the setting. Called at startup and on every
/// settings save; a no-op when the plugin is not there (E2E builds).
pub fn apply(app: &tauri::AppHandle, enabled: bool) {
  #[cfg(not(feature = "e2e"))]
  {
    use tauri::Manager;
    let Some(manager) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() else {
      return;
    };
    let was_enabled = manager.is_enabled().ok();
    if enabled {
      // Written again even when present: the app may have moved since, and the
      // entry would then start a path that no longer exists.
      match manager.enable() {
        Ok(()) if was_enabled != Some(true) => log::info!("Launch at login enabled"),
        Ok(()) => {}
        Err(e) => log::warn!("Launch at login enable failed err=\"{e}\""),
      }
    } else if was_enabled != Some(false) {
      match manager.disable() {
        Ok(()) => log::info!("Launch at login disabled"),
        Err(e) => log::warn!("Launch at login disable failed err=\"{e}\""),
      }
    }
  }
  #[cfg(feature = "e2e")]
  let _ = (app, enabled);
}

/// Bring the login item in line with the stored setting.
pub fn reconcile(app: &tauri::AppHandle) {
  let enabled = crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .map(|settings| settings.launch_at_login)
    .unwrap_or(false);
  apply(app, enabled);
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct ReopenState {
  profile_ids: Vec<String>,
}

fn reopen_file() -> PathBuf {
  crate::app_dirs::settings_dir().join("reopen_profiles.json")
}

/// Store the ids; an empty list removes the file.
fn write_ids(path: &Path, profile_ids: Vec<String>) -> std::io::Result<()> {
  if profile_ids.is_empty() {
    return match std::fs::remove_file(path) {
      Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
      _ => Ok(()),
    };
  }
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)?;
  }
  let json = serde_json::to_vec(&ReopenState { profile_ids }).map_err(std::io::Error::other)?;
  let temp = path.with_extension("json.tmp");
  std::fs::write(&temp, json)?;
  std::fs::rename(&temp, path)
}

/// Read the ids and remove the file, so they are served once.
fn take_ids(path: &Path) -> Vec<String> {
  let ids = std::fs::read(path)
    .ok()
    .and_then(|raw| serde_json::from_slice::<ReopenState>(&raw).ok())
    .map(|state| state.profile_ids)
    .unwrap_or_default();
  if let Err(e) = write_ids(path, Vec::new()) {
    log::warn!("Reopen list removal failed err=\"{e}\"");
  }
  ids
}

fn reopen_enabled() -> bool {
  crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .map(|settings| settings.reopen_running_profiles)
    .unwrap_or(false)
}

fn is_running(profile: &crate::profile::BrowserProfile) -> bool {
  profile
    .process_id
    .is_some_and(crate::proxy_storage::is_process_running)
}

/// The profiles a reopen may launch: still there, not running already, not
/// temporary, and able to run on this OS.
fn reopenable(
  ids: Vec<String>,
  profiles: &[crate::profile::BrowserProfile],
  is_running: impl Fn(&crate::profile::BrowserProfile) -> bool,
) -> Vec<String> {
  let mut seen = std::collections::HashSet::new();
  ids
    .into_iter()
    .filter(|id| seen.insert(id.clone()))
    .filter(|id| {
      profiles
        .iter()
        .any(|p| p.id.to_string() == *id && !p.temporary && !p.is_cross_os() && !is_running(p))
    })
    .collect()
}

/// At exit: note the running profiles when the setting is on, else forget any
/// earlier list.
pub fn remember_running_profiles() {
  let ids: Vec<String> = if reopen_enabled() {
    crate::profile::ProfileManager::instance()
      .list_profiles()
      .unwrap_or_default()
      .iter()
      .filter(|p| !p.temporary && is_running(p))
      .map(|p| p.id.to_string())
      .collect()
  } else {
    Vec::new()
  };
  let count = ids.len();
  match write_ids(&reopen_file(), ids) {
    Ok(()) if count > 0 => log::info!("Profiles to reopen saved count={count}"),
    Ok(()) => {}
    Err(e) => log::warn!("Reopen list save failed err=\"{e}\""),
  }
}

/// The profiles that ran when Donut last quit, served once. Empty when the
/// setting is off.
#[tauri::command]
pub fn take_reopen_profiles() -> Vec<String> {
  let ids = take_ids(&reopen_file());
  if ids.is_empty() || !reopen_enabled() {
    return Vec::new();
  }
  let profiles = crate::profile::ProfileManager::instance()
    .list_profiles()
    .unwrap_or_default();
  let ids = reopenable(ids, &profiles, is_running);
  if !ids.is_empty() {
    log::info!("Profiles to reopen served count={}", ids.len());
  }
  ids
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::profile::BrowserProfile;

  #[test]
  fn the_reopen_list_is_served_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings").join("reopen_profiles.json");
    let ids = vec!["a".to_string(), "b".to_string()];

    write_ids(&path, ids.clone()).unwrap();
    assert_eq!(take_ids(&path), ids);
    assert!(!path.exists());
    assert!(take_ids(&path).is_empty());
  }

  #[test]
  fn an_empty_list_removes_the_file_and_a_broken_one_reads_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("reopen_profiles.json");
    write_ids(&path, vec!["a".to_string()]).unwrap();
    write_ids(&path, Vec::new()).unwrap();
    assert!(!path.exists());
    write_ids(&path, Vec::new()).unwrap();

    std::fs::write(&path, "{not json").unwrap();
    assert!(take_ids(&path).is_empty());
    assert!(!path.exists());
  }

  #[test]
  fn only_profiles_that_can_start_here_are_reopened() {
    let profile = |temporary: bool| BrowserProfile {
      id: uuid::Uuid::new_v4(),
      temporary,
      ..Default::default()
    };
    let idle = profile(false);
    let running = profile(false);
    let temporary = profile(true);
    let profiles = vec![idle.clone(), running.clone(), temporary.clone()];
    let ids = vec![
      idle.id.to_string(),
      running.id.to_string(),
      temporary.id.to_string(),
      uuid::Uuid::new_v4().to_string(),
      idle.id.to_string(),
    ];
    let reopened = reopenable(ids, &profiles, |p| p.id == running.id);
    assert_eq!(reopened, vec![idle.id.to_string()]);
  }
}
