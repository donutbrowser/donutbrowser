//! Self-update of the portable Windows ZIP.
//!
//! The release's portable ZIP is checked against SHA256SUMS.txt like every
//! other update, then unpacked into `.update/staged` inside the portable
//! folder. At "Restart now" each program file moves aside into `.update/old`
//! and the new file takes its place: Windows lets a running executable be
//! renamed, never overwritten. `data`, `cache` and `logs` stay where they are.
//! The next start removes `.update`.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::app_auto_updater::AppReleaseAsset;

/// Scratch folder inside the portable folder. It keeps the download on the
/// portable drive, and a rename inside one volume cannot fail halfway.
const UPDATE_DIR: &str = ".update";
const STAGED_DIR: &str = "staged";
const OLD_DIR: &str = "old";
/// The main executable's name in the ZIP.
const PACKAGE_EXE: &str = "Donut.exe";
/// What the portable folder keeps across updates.
const KEPT: [&str; 4] = ["data", "cache", "logs", UPDATE_DIR];
/// An antivirus scan holds a new file for a moment after it is written.
const RENAME_ATTEMPTS: u32 = 20;
const RENAME_PAUSE: Duration = Duration::from_millis(250);

/// The portable ZIP for `arch` among a release's assets:
/// `Donut_<version>_x64-portable.zip`, or `Donut_x64-portable.zip` for a
/// nightly.
pub fn asset_url(assets: &[AppReleaseAsset], arch: &str) -> Option<String> {
  let suffix = format!("_{arch}-portable.zip");
  assets
    .iter()
    .find(|asset| asset.name.to_lowercase().ends_with(&suffix))
    .map(|asset| asset.browser_download_url.clone())
}

pub fn update_dir(install_dir: &Path) -> PathBuf {
  install_dir.join(UPDATE_DIR)
}

/// Unpacks a verified ZIP into `.update/staged`. Returns the folder that holds
/// the package's files.
pub async fn stage(
  zip: &Path,
  install_dir: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
  let staged = update_dir(install_dir).join(STAGED_DIR);
  if staged.exists() {
    fs::remove_dir_all(&staged)?;
  }
  crate::extraction::Extractor::instance()
    .extract_zip(zip, &staged, None)
    .await?;
  package_root(&staged).ok_or_else(|| format!("The portable ZIP has no {PACKAGE_EXE}").into())
}

/// The ZIP holds one `Donut-Portable` folder; files at the top count too.
fn package_root(staged: &Path) -> Option<PathBuf> {
  if staged.join(PACKAGE_EXE).is_file() {
    return Some(staged.to_path_buf());
  }
  fs::read_dir(staged)
    .ok()?
    .flatten()
    .map(|entry| entry.path())
    .find(|path| path.join(PACKAGE_EXE).is_file())
}

/// Moves every file of `package` into `install_dir`. The file it replaces
/// moves into `.update/old` first. The package's `Donut.exe` takes
/// `exe_name`, the name of the running executable. When a move fails, the
/// moves before it are undone. Returns the number of files replaced.
pub fn apply(package: &Path, install_dir: &Path, exe_name: &OsStr) -> io::Result<usize> {
  let old = update_dir(install_dir).join(OLD_DIR);
  if old.exists() {
    fs::remove_dir_all(&old)?;
  }
  let files = package_files(package)?;
  let mut done: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
  for relative in &files {
    let target_relative = if relative.as_os_str() == PACKAGE_EXE {
      PathBuf::from(exe_name)
    } else {
      relative.clone()
    };
    let target = install_dir.join(&target_relative);
    match swap(
      &package.join(relative),
      &target,
      &old.join(&target_relative),
    ) {
      Ok(aside) => done.push((target, aside)),
      Err(e) => {
        undo(&done);
        return Err(io::Error::new(
          e.kind(),
          format!("{}: {e}", target_relative.display()),
        ));
      }
    }
  }
  Ok(files.len())
}

/// Puts `new` at `target`, keeping the file it replaces at `aside`.
fn swap(new: &Path, target: &Path, aside: &Path) -> io::Result<Option<PathBuf>> {
  let moved = if target.symlink_metadata().is_ok() {
    if let Some(parent) = aside.parent() {
      fs::create_dir_all(parent)?;
    }
    rename(target, aside)?;
    Some(aside.to_path_buf())
  } else {
    None
  };
  let placed = target
    .parent()
    .map_or(Ok(()), fs::create_dir_all)
    .and_then(|()| rename(new, target));
  if let Err(e) = placed {
    if let Some(aside) = &moved {
      let _ = rename(aside, target);
    }
    return Err(e);
  }
  Ok(moved)
}

fn undo(done: &[(PathBuf, Option<PathBuf>)]) {
  for (target, aside) in done.iter().rev() {
    let restored = match aside {
      Some(aside) => rename(aside, target),
      None => fs::remove_file(target),
    };
    if let Err(e) = restored {
      log::error!(
        "Portable update undo failed path=\"{}\" err=\"{e}\"",
        target.display()
      );
    }
  }
}

fn rename(from: &Path, to: &Path) -> io::Result<()> {
  let mut attempt = 1;
  loop {
    match fs::rename(from, to) {
      Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempt < RENAME_ATTEMPTS => {
        attempt += 1;
        std::thread::sleep(RENAME_PAUSE);
      }
      result => return result,
    }
  }
}

/// The package's files, relative to its root, without anything the portable
/// folder keeps.
fn package_files(package: &Path) -> io::Result<Vec<PathBuf>> {
  let mut files = Vec::new();
  let mut dirs = vec![PathBuf::new()];
  while let Some(dir) = dirs.pop() {
    for entry in fs::read_dir(package.join(&dir))? {
      let entry = entry?;
      let relative = dir.join(entry.file_name());
      if dir.as_os_str().is_empty() && KEPT.iter().any(|kept| entry.file_name() == *kept) {
        continue;
      }
      if entry.file_type()?.is_dir() {
        dirs.push(relative);
      } else {
        files.push(relative);
      }
    }
  }
  files.sort();
  Ok(files)
}

/// Removes what the last update left: the old program files, which could not
/// be deleted while they ran, and a staged update that was never applied.
pub fn clean_up(install_dir: &Path) {
  let dir = update_dir(install_dir);
  if !dir.exists() {
    return;
  }
  match fs::remove_dir_all(&dir) {
    Ok(()) => log::debug!("Portable update leftovers removed"),
    Err(e) => log::warn!(
      "Portable update leftovers not removed path=\"{}\" err=\"{e}\"",
      dir.display()
    ),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn asset(name: &str) -> AppReleaseAsset {
    AppReleaseAsset {
      name: name.to_string(),
      browser_download_url: format!("https://example.invalid/{name}"),
      size: 1,
      digest: None,
    }
  }

  fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
  }

  fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
  }

  /// A portable folder at version 1 with data, and version 2 staged.
  fn folder() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let install = tmp.path().join("Donut-Portable");
    write(&install.join("Donut.exe"), "app 1");
    write(&install.join("donut-proxy.exe"), "proxy 1");
    write(&install.join(".portable"), "");
    write(&install.join("data/profiles/a/Cookies"), "login");
    write(&install.join("logs/DonutBrowser.log"), "log");
    let package = update_dir(&install).join("staged/Donut-Portable");
    write(&package.join("Donut.exe"), "app 2");
    write(&package.join("donut-proxy.exe"), "proxy 2");
    write(&package.join("xray.exe"), "xray 2");
    write(&package.join("licenses/Xray-core-LICENSE.txt"), "license 2");
    write(&package.join(".portable"), "");
    (tmp, install, package)
  }

  #[test]
  fn picks_the_portable_zip_of_a_stable_or_nightly_release() {
    let stable = [
      asset("Donut_0.36.0_x64-setup.exe"),
      asset("Donut_0.36.0_x64-portable.zip"),
      asset("SHA256SUMS.txt"),
    ];
    assert_eq!(
      asset_url(&stable, "x64").as_deref(),
      Some("https://example.invalid/Donut_0.36.0_x64-portable.zip")
    );
    let nightly = [
      asset("Donut_nightly_x64-setup.exe"),
      asset("Donut_x64-portable.zip"),
    ];
    assert_eq!(
      asset_url(&nightly, "x64").as_deref(),
      Some("https://example.invalid/Donut_x64-portable.zip")
    );
    assert_eq!(asset_url(&stable, "aarch64"), None);
  }

  #[test]
  fn finds_the_package_in_its_folder_or_at_the_top() {
    let (_tmp, install, package) = folder();
    let staged = update_dir(&install).join(STAGED_DIR);
    assert_eq!(package_root(&staged), Some(package.clone()));
    assert_eq!(package_root(&package), Some(package));
    assert_eq!(package_root(&install.join("data")), None);
  }

  #[test]
  fn replaces_the_program_and_keeps_the_data() {
    let (_tmp, install, package) = folder();
    assert_eq!(
      apply(&package, &install, OsStr::new("Donut.exe")).unwrap(),
      5
    );
    assert_eq!(read(&install.join("Donut.exe")), "app 2");
    assert_eq!(read(&install.join("donut-proxy.exe")), "proxy 2");
    assert_eq!(read(&install.join("xray.exe")), "xray 2");
    assert_eq!(
      read(&install.join("licenses/Xray-core-LICENSE.txt")),
      "license 2"
    );
    assert_eq!(read(&install.join("data/profiles/a/Cookies")), "login");
    assert_eq!(read(&install.join("logs/DonutBrowser.log")), "log");
    let old = update_dir(&install).join(OLD_DIR);
    assert_eq!(read(&old.join("Donut.exe")), "app 1");
    assert_eq!(read(&old.join("donut-proxy.exe")), "proxy 1");

    clean_up(&install);
    assert!(!update_dir(&install).exists());
    assert!(install.join(".portable").exists());
  }

  #[test]
  fn a_renamed_executable_keeps_its_name() {
    let (_tmp, install, package) = folder();
    fs::rename(install.join("Donut.exe"), install.join("Work.exe")).unwrap();
    apply(&package, &install, OsStr::new("Work.exe")).unwrap();
    assert_eq!(read(&install.join("Work.exe")), "app 2");
    assert!(!install.join("Donut.exe").exists());
  }

  #[test]
  fn never_takes_data_from_a_package() {
    let (_tmp, install, package) = folder();
    write(&package.join("data/profiles/a/Cookies"), "empty");
    write(&package.join("logs/DonutBrowser.log"), "empty");
    apply(&package, &install, OsStr::new("Donut.exe")).unwrap();
    assert_eq!(read(&install.join("data/profiles/a/Cookies")), "login");
    assert_eq!(read(&install.join("logs/DonutBrowser.log")), "log");
  }

  #[test]
  fn a_failed_move_restores_the_old_version() {
    let (_tmp, install, package) = folder();
    // A file where the package has a folder: the license cannot move in,
    // after Donut.exe and donut-proxy.exe did.
    write(&install.join("licenses"), "in the way");
    assert!(apply(&package, &install, OsStr::new("Donut.exe")).is_err());
    assert_eq!(read(&install.join("Donut.exe")), "app 1");
    assert_eq!(read(&install.join("donut-proxy.exe")), "proxy 1");
    assert_eq!(read(&install.join("licenses")), "in the way");
    assert!(!install.join("xray.exe").exists());
    assert_eq!(read(&install.join("data/profiles/a/Cookies")), "login");
  }

  /// The property the update depends on: a running executable can be renamed
  /// and another file can take its name.
  #[cfg(target_os = "windows")]
  #[test]
  fn replaces_a_running_executable() {
    let (_tmp, install, package) = folder();
    let system = std::env::var_os("SystemRoot").unwrap();
    let ping = PathBuf::from(system).join("System32").join("PING.EXE");
    fs::copy(&ping, install.join("Donut.exe")).unwrap();
    let mut running = std::process::Command::new(install.join("Donut.exe"))
      .args(["-n", "30", "127.0.0.1"])
      .stdout(std::process::Stdio::null())
      .spawn()
      .unwrap();
    let result = apply(&package, &install, OsStr::new("Donut.exe"));
    let _ = running.kill();
    let _ = running.wait();
    result.unwrap();
    assert_eq!(read(&install.join("Donut.exe")), "app 2");
  }
}
