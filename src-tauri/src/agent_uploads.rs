//! Files an agent hands to `file_upload`, written where the browser can read
//! them.
//!
//! The page reads an uploaded file when it sends the form or reads the file,
//! which can be long after the call, so each copy stays until the profile's
//! browser stops. An ephemeral profile's copies stay in its memory-backed
//! directory; startup removes whatever an earlier run left.

use std::path::{Path, PathBuf};

/// The most bytes one call may upload. A call arrives as one JSON-RPC message
/// of at most 1 MiB, and base64 grows the bytes by a third.
pub const MAX_UPLOAD_BYTES: usize = 700 * 1024;
/// The most files one call may upload.
pub const MAX_UPLOAD_FILES: usize = 10;
const MAX_NAME_BYTES: usize = 200;
/// The folder inside an ephemeral profile's directory.
const EPHEMERAL_FOLDER: &str = ".donut-agent-uploads";

/// One file to put in a file input.
#[derive(Debug, Clone, PartialEq)]
pub struct UploadFile {
  pub name: String,
  pub bytes: Vec<u8>,
}

fn root() -> PathBuf {
  crate::app_dirs::cache_dir().join("agent-uploads")
}

fn profile_root(profile_id: &str) -> PathBuf {
  match crate::ephemeral_dirs::get_ephemeral_dir(profile_id) {
    Some(dir) => dir.join(EPHEMERAL_FOLDER),
    None => root().join(profile_id),
  }
}

/// The name a file is uploaded under: the last part of `name`, with
/// characters no file system takes replaced. `None` when nothing usable is
/// left or it is too long.
pub fn clean_name(name: &str) -> Option<String> {
  let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
  let cleaned: String = last
    .chars()
    .filter(|c| !c.is_control())
    .map(|c| match c {
      '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
      c => c,
    })
    .collect();
  let cleaned = cleaned.trim().trim_end_matches('.').trim_end();
  if cleaned.is_empty()
    || cleaned.trim_start_matches('.').is_empty()
    || cleaned.len() > MAX_NAME_BYTES
  {
    return None;
  }
  Some(cleaned.to_string())
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
  std::fs::create_dir_all(dir)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
  }
  Ok(())
}

/// Write `files` to a new folder of the profile's, and answer their paths in
/// the same order.
pub fn stage(profile_id: &str, files: &[UploadFile]) -> std::io::Result<Vec<PathBuf>> {
  let base = profile_root(profile_id);
  create_private_dir(&base)?;
  let dir = base.join(uuid::Uuid::new_v4().to_string());
  create_private_dir(&dir)?;
  files
    .iter()
    .map(|file| {
      let path = dir.join(&file.name);
      std::fs::write(&path, &file.bytes)?;
      Ok(path)
    })
    .collect()
}

/// Remove every file staged for a profile.
pub fn remove_for_profile(profile_id: &str) {
  let dir = profile_root(profile_id);
  match std::fs::remove_dir_all(&dir) {
    Ok(()) => log::debug!("Agent uploads removed profile={profile_id}"),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
    Err(e) => log::warn!("Agent uploads removal failed profile={profile_id} err=\"{e}\""),
  }
}

/// Remove the files of every profile `running` says is stopped.
pub fn sweep(running: impl Fn(&str) -> bool) {
  let Ok(entries) = std::fs::read_dir(root()) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    if !running(&name) {
      let _ = std::fs::remove_dir_all(entry.path());
    }
  }
}

/// Remove what an earlier run left.
pub fn clear_all() {
  match std::fs::remove_dir_all(root()) {
    Ok(()) => log::info!("Removed agent uploads from an earlier run"),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
    Err(e) => log::warn!("Agent uploads cleanup failed err=\"{e}\""),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_name_keeps_its_last_part_and_loses_what_a_file_system_refuses() {
    assert_eq!(clean_name("resume.pdf").as_deref(), Some("resume.pdf"));
    assert_eq!(clean_name("../../etc/passwd").as_deref(), Some("passwd"));
    assert_eq!(
      clean_name("C:\\Users\\a\\photo.jpg").as_deref(),
      Some("photo.jpg")
    );
    assert_eq!(clean_name("a:b?.txt").as_deref(), Some("a_b_.txt"));
    assert_eq!(clean_name(" report.csv\n").as_deref(), Some("report.csv"));
    assert_eq!(clean_name("name.").as_deref(), Some("name"));
    assert_eq!(clean_name(".env").as_deref(), Some(".env"));
    for refused in ["", "..", ".", "dir/", "   ", "\u{0}"] {
      assert_eq!(clean_name(refused), None, "{refused:?}");
    }
    assert_eq!(clean_name(&"a".repeat(MAX_NAME_BYTES + 1)), None);
  }

  #[test]
  fn staged_files_hold_their_bytes_until_the_profile_is_cleared() {
    let cache = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_cache_dir(cache.path().to_path_buf());
    let profile = "11111111-2222-3333-4444-555555555555";
    let files = [
      UploadFile {
        name: "a.txt".to_string(),
        bytes: b"first".to_vec(),
      },
      UploadFile {
        name: "b.bin".to_string(),
        bytes: vec![0, 1, 2],
      },
    ];
    let paths = stage(profile, &files).unwrap();
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"first");
    assert_eq!(std::fs::read(&paths[1]).unwrap(), vec![0, 1, 2]);
    assert_eq!(paths[0].file_name().unwrap(), "a.txt");
    assert!(paths[0].starts_with(root().join(profile)));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = std::fs::metadata(paths[0].parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
      assert_eq!(mode & 0o777, 0o700);
    }

    let other = "99999999-2222-3333-4444-555555555555";
    stage(other, &files[..1]).unwrap();
    sweep(|id| id == other);
    assert!(!root().join(profile).exists());
    assert!(root().join(other).exists());
    remove_for_profile(other);
    assert!(!root().join(other).exists());
    stage(other, &files[..1]).unwrap();
    clear_all();
    assert!(!root().exists());
  }
}
