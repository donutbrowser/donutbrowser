//! The release notes of an app update, kept from the moment it is downloaded
//! until the updated app first starts, so it can say what changed.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WhatsNew {
  pub version: String,
  pub notes: String,
}

fn path() -> PathBuf {
  crate::settings_manager::SettingsManager::instance()
    .get_settings_dir()
    .join("whats_new.json")
}

fn bare(version: &str) -> &str {
  version.trim().trim_start_matches('v')
}

/// Keep the notes of a downloaded update until it runs.
pub fn remember(version: &str, notes: &str) {
  if notes.trim().is_empty() {
    return;
  }
  let entry = WhatsNew {
    version: bare(version).to_string(),
    notes: notes.to_string(),
  };
  let written = serde_json::to_vec(&entry)
    .map_err(std::io::Error::other)
    .and_then(|bytes| crate::profile::encryption::atomic_write(&path(), &bytes));
  if let Err(e) = written {
    log::warn!(
      "Release notes not kept version={} err=\"{e}\"",
      entry.version
    );
  }
}

/// The notes kept for `current`, once: they are gone after this answers.
fn take_for(current: &str) -> Option<WhatsNew> {
  let entry: WhatsNew = serde_json::from_slice(&std::fs::read(path()).ok()?).ok()?;
  if bare(&entry.version) != bare(current) {
    return None;
  }
  let _ = std::fs::remove_file(path());
  Some(entry)
}

/// The notes of the update this app now runs, the first time it asks.
#[tauri::command]
pub fn take_whats_new() -> Option<WhatsNew> {
  take_for(&crate::app_auto_updater::AppAutoUpdater::get_current_version())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn notes_show_once_and_only_for_the_version_they_belong_to() {
    let dir = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(dir.path().to_path_buf());
    remember("v0.37.0", "## What's New\n- Faster");
    assert_eq!(take_for("0.36.9"), None, "the update has not run yet");
    let shown = take_for("v0.37.0").unwrap();
    assert_eq!(shown.version, "0.37.0");
    assert_eq!(take_for("0.37.0"), None, "only once");
    remember("0.38.0", "  ");
    assert_eq!(take_for("0.38.0"), None, "empty notes are not kept");
  }
}
