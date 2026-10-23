//! The autostart entry that 0.14 to 0.17 installed for the old tray daemon, and
//! the files that daemon wrote.
//!
//! 0.18 to 0.24 removed the entry at launch. 0.25 deleted the daemon and that
//! cleanup with it, so a machine that went from 0.17 or earlier straight to 0.25
//! or later still carries an entry that points at a binary no longer shipped.
//! On macOS that entry is a LaunchAgent, and Login Items lists Donut as running
//! in the background long after the app has quit.

use std::io;
use std::path::{Path, PathBuf};

/// Remove the old daemon's autostart entry and files, if this machine still has
/// them.
pub fn remove() {
  remove_autostart_entry();

  if let (Some(dir), Some(stop_at)) = (daemon_data_dir(), dirs::data_dir()) {
    match remove_daemon_files(&dir, &stop_at) {
      Ok(0) => {}
      Ok(count) => log::info!(
        "Legacy daemon files removed dir={} count={count}",
        dir.display()
      ),
      Err(e) => log::warn!(
        "Legacy daemon files removal failed dir={} err=\"{e}\"",
        dir.display()
      ),
    }
  }
}

fn remove_autostart_entry() {
  #[cfg(any(target_os = "macos", target_os = "linux"))]
  {
    #[cfg(target_os = "macos")]
    let entry = dirs::home_dir().map(|home| {
      home
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist"))
    });
    #[cfg(target_os = "linux")]
    let entry = dirs::config_dir().map(|config| config.join("autostart/donut-daemon.desktop"));

    if let Some(path) = entry {
      match remove_entry(&path, unload) {
        Ok(true) => log::info!("Legacy daemon autostart removed path={}", path.display()),
        Ok(false) => {}
        Err(e) => log::warn!(
          "Legacy daemon autostart removal failed path={} err=\"{e}\"",
          path.display()
        ),
      }
    }
  }

  #[cfg(target_os = "windows")]
  {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;

    let Ok(run) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
      r"Software\Microsoft\Windows\CurrentVersion\Run",
      KEY_QUERY_VALUE | KEY_SET_VALUE,
    ) else {
      return;
    };
    match run.delete_value("DonutBrowserDaemon") {
      Ok(()) => log::info!("Legacy daemon autostart removed key=HKCU\\Run\\DonutBrowserDaemon"),
      Err(e) if e.kind() == io::ErrorKind::NotFound => {}
      Err(e) => log::warn!(
        "Legacy daemon autostart removal failed key=HKCU\\Run\\DonutBrowserDaemon err=\"{e}\""
      ),
    }
  }
}

#[cfg(target_os = "macos")]
const LAUNCH_AGENT_LABEL: &str = "com.donutbrowser.daemon";

/// launchctl's exit statuses for a job that is not loaded: 3 (ESRCH) and 113
/// ("Could not find specified service").
#[cfg(target_os = "macos")]
const LAUNCHCTL_NOT_LOADED: [i32; 2] = [3, 113];

/// Deleting the plist alone leaves the job loaded until the next login.
#[cfg(target_os = "macos")]
fn unload() {
  let target = format!("gui/{}/{LAUNCH_AGENT_LABEL}", unsafe { libc::getuid() });
  match std::process::Command::new("launchctl")
    .args(["bootout", &target])
    .output()
  {
    Ok(output) if output.status.success() => {
      log::info!("Legacy daemon LaunchAgent unloaded target={target}");
    }
    Ok(output)
      if output
        .status
        .code()
        .is_some_and(|code| LAUNCHCTL_NOT_LOADED.contains(&code)) => {}
    Ok(output) => log::warn!(
      "launchctl bootout failed target={target} status={} err=\"{}\"",
      output.status,
      String::from_utf8_lossy(&output.stderr).trim()
    ),
    Err(e) => log::warn!("launchctl bootout failed target={target} err=\"{e}\""),
  }
}

#[cfg(target_os = "linux")]
fn unload() {}

/// Delete the entry at `path`, calling `unload` first. `Ok(false)` when there
/// is no entry, in which case `unload` is not called.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn remove_entry(path: &Path, unload: impl FnOnce()) -> io::Result<bool> {
  if path.symlink_metadata().is_err() {
    return Ok(false);
  }
  unload();
  std::fs::remove_file(path)?;
  Ok(true)
}

/// The daemon's own data directory (`daemon/autostart.rs::get_data_dir` in
/// 0.14 to 0.24). Only the daemon wrote here, but on Linux it is also the
/// directory where VPN configs lived before they moved, so only the daemon's
/// files are removed, never the directory's other content.
fn daemon_data_dir() -> Option<PathBuf> {
  directories::ProjectDirs::from("com", "donutbrowser", "Donut Browser")
    .map(|dirs| dirs.data_dir().to_path_buf())
}

/// The daemon's state and log, and the stdout and stderr logs its LaunchAgent
/// sent launchd's output to on macOS.
const DAEMON_FILES: [&str; 4] = [
  "daemon-state.json",
  "daemon.log",
  "logs/daemon.out.log",
  "logs/daemon.err.log",
];

/// Delete the daemon's files in `dir`, then the directories they leave empty,
/// up to but not including `stop_at`. Returns how many files were deleted.
fn remove_daemon_files(dir: &Path, stop_at: &Path) -> io::Result<usize> {
  let mut count = 0;
  for name in DAEMON_FILES {
    match std::fs::remove_file(dir.join(name)) {
      Ok(()) => count += 1,
      Err(e) if e.kind() == io::ErrorKind::NotFound => {}
      Err(e) => return Err(e),
    }
  }
  if count > 0 {
    let _ = std::fs::remove_dir(dir.join("logs"));
    let mut current = Some(dir);
    while let Some(path) = current {
      if path == stop_at || !path.starts_with(stop_at) || std::fs::remove_dir(path).is_err() {
        break;
      }
      current = path.parent();
    }
  }
  Ok(count)
}

#[cfg(test)]
mod tests {
  use super::{remove_daemon_files, remove_entry, DAEMON_FILES};
  use std::cell::Cell;

  #[test]
  fn an_entry_is_unloaded_then_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("com.donutbrowser.daemon.plist");
    std::fs::write(&path, "<plist/>").unwrap();
    let unloaded = Cell::new(false);

    let removed = remove_entry(&path, || {
      assert!(path.exists(), "unload runs while the entry still exists");
      unloaded.set(true);
    })
    .unwrap();

    assert!(removed);
    assert!(unloaded.get());
    assert!(!path.exists());
  }

  /// `autostart` names its login item after the app; this cleanup must never
  /// match it.
  #[test]
  fn the_login_item_never_shares_a_name_with_the_old_daemon_entry() {
    let name = crate::app_dirs::app_name();
    for legacy in [
      "com.donutbrowser.daemon",
      "donut-daemon",
      "DonutBrowserDaemon",
    ] {
      assert_ne!(name, legacy);
    }
  }

  #[test]
  fn a_missing_entry_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let unloaded = Cell::new(false);

    let removed = remove_entry(&dir.path().join("donut-daemon.desktop"), || {
      unloaded.set(true)
    })
    .unwrap();

    assert!(!removed);
    assert!(
      !unloaded.get(),
      "nothing is unloaded when there is no entry"
    );
  }

  /// The path 0.14 to 0.24 wrote to, from the same `directories` call.
  #[cfg(target_os = "macos")]
  #[test]
  fn the_daemon_data_dir_is_the_one_old_versions_used() {
    let dir = super::daemon_data_dir().unwrap();
    assert!(dir.ends_with("Library/Application Support/com.donutbrowser.Donut-Browser"));
  }

  #[test]
  fn the_daemon_files_and_the_directories_they_leave_empty_are_removed() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().join("data");
    let dir = base.join("donutbrowser").join("Donut Browser").join("data");
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    for name in DAEMON_FILES {
      std::fs::write(dir.join(name), "x").unwrap();
    }

    assert_eq!(
      remove_daemon_files(&dir, &base).unwrap(),
      DAEMON_FILES.len()
    );
    assert!(!base.join("donutbrowser").exists());
    assert!(base.exists(), "the base data directory stays");
  }

  #[test]
  fn other_files_in_the_daemon_dir_are_kept() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().join("data");
    let dir = base.join("donutbrowser");
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    std::fs::write(dir.join("daemon.log"), "x").unwrap();
    std::fs::write(dir.join("logs/daemon.err.log"), "x").unwrap();
    std::fs::write(dir.join("vpn_configs.json"), "{}").unwrap();

    assert_eq!(remove_daemon_files(&dir, &base).unwrap(), 2);
    assert!(dir.join("vpn_configs.json").exists());
    assert!(!dir.join("daemon.log").exists());
    assert!(!dir.join("logs").exists());
  }

  #[test]
  fn nothing_is_touched_when_the_daemon_left_no_files() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("donutbrowser");
    std::fs::create_dir_all(dir.join("logs")).unwrap();

    assert_eq!(remove_daemon_files(&dir, root.path()).unwrap(), 0);
    assert!(dir.join("logs").exists());
  }
}
