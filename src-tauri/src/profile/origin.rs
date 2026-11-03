//! How a profile came to this device: made here, cloned, imported, or
//! downloaded by sync. Kept per device in the profile's `.donut-sync` folder,
//! which sync never uploads, because the same profile has a different origin
//! on each device. Profiles from before this record read `unknown`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
  Created,
  Cloned,
  Imported,
  SyncedDown,
}

impl Origin {
  fn label(self) -> &'static str {
    match self {
      Self::Created => "created",
      Self::Cloned => "cloned",
      Self::Imported => "imported",
      Self::SyncedDown => "synced_down",
    }
  }
}

fn origin_file(profile_dir: &Path) -> PathBuf {
  profile_dir.join(".donut-sync").join("origin")
}

/// Note where the profile in `profile_dir` (`<profiles dir>/<id>`) came
/// from. Written when the profile appears here, over any record a copied
/// directory brought along.
pub fn record_in(profile_dir: &Path, origin: Origin) {
  let file = origin_file(profile_dir);
  if let Some(parent) = file.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let _ = std::fs::write(file, origin.label());
}

pub fn read_in(profile_dir: &Path) -> &'static str {
  match std::fs::read_to_string(origin_file(profile_dir))
    .unwrap_or_default()
    .trim()
  {
    "created" => "created",
    "cloned" => "cloned",
    "imported" => "imported",
    "synced_down" => "synced_down",
    _ => "unknown",
  }
}

pub fn record(profile_id: &uuid::Uuid, origin: Origin) {
  record_in(
    &crate::app_dirs::profiles_dir().join(profile_id.to_string()),
    origin,
  );
}

pub fn read(profile_id: &uuid::Uuid) -> &'static str {
  read_in(&crate::app_dirs::profiles_dir().join(profile_id.to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_unknown_without_a_record_and_the_latest_record_with_one() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_in(dir.path()), "unknown");
    record_in(dir.path(), Origin::SyncedDown);
    assert_eq!(read_in(dir.path()), "synced_down");
    record_in(dir.path(), Origin::Cloned);
    assert_eq!(read_in(dir.path()), "cloned");
  }

  #[test]
  fn the_record_is_outside_what_sync_uploads() {
    let dir = tempfile::tempdir().unwrap();
    record_in(dir.path(), Origin::Imported);
    let mut cache = crate::sync::manifest::HashCache::default();
    let manifest = crate::sync::manifest::generate_manifest("p", dir.path(), &mut cache).unwrap();
    assert!(manifest.files.is_empty());
  }
}
