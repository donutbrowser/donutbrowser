//! The file the volume host writes once its volume is mounted, so the app can
//! find a volume that an earlier run started.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VolumeState {
  pub pid: u32,
  pub mount: PathBuf,
  pub capacity: u64,
}

impl VolumeState {
  /// Written to a temporary file first, so a reader never sees half of it.
  pub fn write(&self, path: &Path) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(self)?)?;
    std::fs::rename(&temporary, path)
  }

  pub fn read(path: &Path) -> Option<Self> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn state_round_trips_and_unreadable_state_is_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ephemeral-ram.json");
    assert_eq!(VolumeState::read(&path), None);

    let state = VolumeState {
      pid: 42,
      mount: dir.path().join("ephemeral-ram"),
      capacity: 512 << 20,
    };
    state.write(&path).unwrap();
    assert_eq!(VolumeState::read(&path), Some(state));
    assert!(!path.with_extension("tmp").exists());

    std::fs::write(&path, b"{").unwrap();
    assert_eq!(VolumeState::read(&path), None);
  }
}
