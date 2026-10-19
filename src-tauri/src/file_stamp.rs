//! What a file looked like on disk, to tell whether a copy parsed from it is
//! still current without reading it again.

use std::path::Path;
use std::time::SystemTime;

/// Size and times of a file, and on Unix its inode and change time. An atomic
/// write replaces the file, so the inode changes on Unix; on Windows a
/// replace can keep the creation time, so size and mtime are all there is.
///
/// Two writes of the same length within one tick of the file clock look the
/// same, so a stamp taken while the file was that fresh equals nothing, and a
/// copy cached with it is read again.
#[derive(Debug, Clone)]
pub struct FileStamp {
  len: u64,
  modified: Option<SystemTime>,
  created: Option<SystemTime>,
  #[cfg(unix)]
  inode: (u64, u64, i64, i64),
  settled: bool,
}

/// Older than any file clock tick.
const SETTLED_AFTER: std::time::Duration = std::time::Duration::from_secs(2);

impl PartialEq for FileStamp {
  fn eq(&self, other: &Self) -> bool {
    #[cfg(unix)]
    let same_inode = self.inode == other.inode;
    #[cfg(not(unix))]
    let same_inode = true;
    self.settled
      && other.settled
      && same_inode
      && self.len == other.len
      && self.modified == other.modified
      && self.created == other.created
  }
}

impl Eq for FileStamp {}

impl FileStamp {
  pub fn of(meta: &std::fs::Metadata) -> Self {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let modified = meta.modified().ok();
    let settled = modified
      .and_then(|at| SystemTime::now().duration_since(at).ok())
      .is_some_and(|age| age >= SETTLED_AFTER);
    Self {
      len: meta.len(),
      modified,
      created: meta.created().ok(),
      #[cfg(unix)]
      inode: (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()),
      settled,
    }
  }

  /// The stamp of a regular file, or `None` when there is none at `path`.
  pub fn read(path: &Path) -> Option<Self> {
    std::fs::metadata(path)
      .ok()
      .filter(std::fs::Metadata::is_file)
      .map(|meta| Self::of(&meta))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn age(file: &Path, secs: u64) {
    std::fs::File::options()
      .write(true)
      .open(file)
      .unwrap()
      .set_modified(SystemTime::now() - std::time::Duration::from_secs(secs))
      .unwrap();
  }

  #[test]
  fn a_rewrite_changes_the_stamp_and_a_read_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    assert_eq!(FileStamp::read(&file), None);
    assert_eq!(FileStamp::read(dir.path()), None);

    std::fs::write(&file, b"{\"a\":1}").unwrap();
    age(&file, 10);
    let first = FileStamp::read(&file).unwrap();
    let _ = std::fs::read(&file).unwrap();
    assert_eq!(FileStamp::read(&file), Some(first.clone()));

    // Same length, replaced the way atomic writes replace a file.
    let staging = dir.path().join("a.json.tmp");
    std::fs::write(&staging, b"{\"a\":2}").unwrap();
    std::fs::rename(&staging, &file).unwrap();
    assert_ne!(FileStamp::read(&file), Some(first));
  }

  #[test]
  fn a_file_written_just_now_matches_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    std::fs::write(&file, b"{}").unwrap();
    let fresh = FileStamp::read(&file).unwrap();
    assert_ne!(fresh, fresh.clone());
  }
}
