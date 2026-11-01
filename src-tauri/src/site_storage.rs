//! Site storage that has grown too large for the browser to open.
//!
//! One site's IndexedDB, Cache Storage or File System folders can grow to
//! tens of GiB, and a browser then quits soon after each launch. This module
//! measures each site's folders in a profile, and moves the folders of one
//! site aside inside the profile, so the profile launches again with its
//! cookies, logins, extensions and other sites intact. A moved folder stays
//! until the person deletes it.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::profile::{BrowserProfile, ProfileManager};

/// A site whose folders together pass this size is reported as oversized.
pub const OVERSIZED_SITE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// A browser that exits this soon after its launch exited like a crash.
pub const EARLY_EXIT_SECS: u64 = 5 * 60;
/// How long a measurement answers the profile info page.
const CACHE_MAX_AGE: Duration = Duration::from_secs(10 * 60);
/// Put between a folder's name and the time it was moved aside.
const BACKUP_MARKER: &str = ".donut-backup-";
const STAMP_FORMAT: &str = "%Y%m%d-%H%M%S";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
  IndexedDb,
  CacheStorage,
  FileSystem,
  StorageBucket,
}

impl StorageKind {
  fn as_str(self) -> &'static str {
    match self {
      StorageKind::IndexedDb => "indexed_db",
      StorageKind::CacheStorage => "cache_storage",
      StorageKind::FileSystem => "file_system",
      StorageKind::StorageBucket => "storage_bucket",
    }
  }

  /// The folder under the browser's data directory that holds one folder
  /// (or, for IndexedDB, up to two) per site.
  fn area(self) -> &'static str {
    match self {
      StorageKind::IndexedDb => "Default/IndexedDB",
      StorageKind::CacheStorage => "Default/Service Worker/CacheStorage",
      StorageKind::FileSystem => "Default/File System",
      StorageKind::StorageBucket => "Default/WebStorage",
    }
  }

  /// The site a folder belongs to, or `None` when the folder holds no site.
  fn site_key(self, folder: &str) -> Option<String> {
    match self {
      StorageKind::IndexedDb => Some(
        folder
          .strip_suffix(".indexeddb.leveldb")
          .or_else(|| folder.strip_suffix(".indexeddb.blob"))
          .unwrap_or(folder)
          .to_string(),
      ),
      StorageKind::CacheStorage => Some(folder.to_string()),
      // `Origins` and the like sit next to the numbered site folders.
      StorageKind::FileSystem | StorageKind::StorageBucket => (!folder.is_empty()
        && folder.bytes().all(|b| b.is_ascii_digit()))
      .then(|| folder.to_string()),
    }
  }
}

const KINDS: [StorageKind; 4] = [
  StorageKind::IndexedDb,
  StorageKind::CacheStorage,
  StorageKind::FileSystem,
  StorageKind::StorageBucket,
];

/// The folders of one site in one storage kind.
#[derive(Clone, Debug, Serialize)]
pub struct SiteStorage {
  /// Names the site to the commands: `<area>/<site key>`.
  pub id: String,
  pub kind: StorageKind,
  /// `https://host[:port]` when the folders tell it.
  pub origin: Option<String>,
  /// The site's folder name without the per-kind suffixes.
  pub folder: String,
  pub bytes: u64,
  #[serde(skip)]
  dirs: Vec<PathBuf>,
}

/// Site folders a repair moved aside.
#[derive(Clone, Debug, Serialize)]
pub struct SiteStorageBackup {
  pub id: String,
  pub kind: StorageKind,
  pub origin: Option<String>,
  pub folder: String,
  pub bytes: u64,
  /// When the folders were moved aside, in unix seconds.
  pub created_at: Option<i64>,
  #[serde(skip)]
  dirs: Vec<PathBuf>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SiteStorageReport {
  pub oversized: Vec<SiteStorage>,
  pub backups: Vec<SiteStorageBackup>,
  pub threshold_bytes: u64,
}

struct Scan {
  sites: Vec<SiteStorage>,
  backups: Vec<SiteStorageBackup>,
}

/// The size of the files under `path`. Symbolic links are not followed, so a
/// link out of the profile never adds to its size.
fn dir_size(path: &Path) -> u64 {
  let mut total = 0u64;
  let mut stack = vec![path.to_path_buf()];
  while let Some(dir) = stack.pop() {
    let Ok(entries) = std::fs::read_dir(&dir) else {
      continue;
    };
    for entry in entries.flatten() {
      let Ok(file_type) = entry.file_type() else {
        continue;
      };
      if file_type.is_dir() {
        stack.push(entry.path());
      } else if file_type.is_file() {
        total = total.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
      }
    }
  }
  total
}

/// The site of a Cache Storage folder: its `index.txt` names the origin.
fn cache_storage_origin(dir: &Path) -> Option<String> {
  use std::io::Read;
  let mut head = Vec::new();
  std::fs::File::open(dir.join("index.txt"))
    .ok()?
    .take(64 * 1024)
    .read_to_end(&mut head)
    .ok()?;
  let start = find(&head, b"https://").or_else(|| find(&head, b"http://"))?;
  let origin: String = head[start..]
    .iter()
    .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'/'))
    .map(|&b| b as char)
    .collect();
  let origin = origin.trim_end_matches('/');
  let host = origin.split_once("://")?.1;
  (!host.is_empty() && !host.contains('/')).then(|| origin.to_string())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  haystack.windows(needle.len()).position(|w| w == needle)
}

/// The sites of the storage buckets, from the browser's quota database.
fn bucket_origins(data_dir: &Path) -> HashMap<String, String> {
  let path = data_dir
    .join("Default")
    .join("WebStorage")
    .join("QuotaManager");
  let Ok(conn) = rusqlite::Connection::open_with_flags(
    &path,
    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
  ) else {
    return HashMap::new();
  };
  let Ok(mut statement) = conn.prepare("SELECT id, storage_key FROM buckets") else {
    return HashMap::new();
  };
  let Ok(rows) = statement.query_map([], |row| {
    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
  }) else {
    return HashMap::new();
  };
  rows
    .flatten()
    .filter_map(|(id, key)| {
      let origin = key.split('^').next()?.trim_end_matches('/');
      origin
        .contains("://")
        .then(|| (id.to_string(), origin.to_string()))
    })
    .collect()
}

fn origin_of(
  kind: StorageKind,
  key: &str,
  dirs: &[PathBuf],
  buckets: &HashMap<String, String>,
) -> Option<String> {
  match kind {
    StorageKind::IndexedDb => crate::indexed_db::origin_of_folder(key),
    StorageKind::CacheStorage => dirs.iter().find_map(|dir| cache_storage_origin(dir)),
    StorageKind::FileSystem => None,
    StorageKind::StorageBucket => buckets.get(key).cloned(),
  }
}

fn stamp_time(stamp: &str) -> Option<i64> {
  let stamp = stamp.get(..15)?;
  let naive = chrono::NaiveDateTime::parse_from_str(stamp, STAMP_FORMAT).ok()?;
  naive
    .and_local_timezone(chrono::Local)
    .earliest()
    .map(|time| time.timestamp())
}

/// Every site folder and every moved-aside folder in a browser data directory.
fn scan(data_dir: &Path) -> Scan {
  let mut sites: BTreeMap<(StorageKind, String), Vec<PathBuf>> = BTreeMap::new();
  let mut backups: BTreeMap<(StorageKind, String, String), Vec<PathBuf>> = BTreeMap::new();
  for kind in KINDS {
    let Ok(entries) = std::fs::read_dir(data_dir.join(kind.area())) else {
      continue;
    };
    for entry in entries.flatten() {
      if !entry.file_type().is_ok_and(|t| t.is_dir()) {
        continue;
      }
      let Some(name) = entry.file_name().to_str().map(str::to_string) else {
        continue;
      };
      match name.split_once(BACKUP_MARKER) {
        Some((base, stamp)) => {
          if let Some(key) = kind.site_key(base) {
            backups
              .entry((kind, key, stamp.to_string()))
              .or_default()
              .push(entry.path());
          }
        }
        None => {
          if let Some(key) = kind.site_key(&name) {
            sites.entry((kind, key)).or_default().push(entry.path());
          }
        }
      }
    }
  }

  let wants_buckets = sites
    .keys()
    .any(|(kind, _)| *kind == StorageKind::StorageBucket)
    || backups
      .keys()
      .any(|(kind, ..)| *kind == StorageKind::StorageBucket);
  let buckets = if wants_buckets {
    bucket_origins(data_dir)
  } else {
    HashMap::new()
  };

  Scan {
    sites: sites
      .into_iter()
      .map(|((kind, key), dirs)| SiteStorage {
        id: format!("{}/{key}", kind.area()),
        kind,
        origin: None,
        bytes: dirs.iter().map(|dir| dir_size(dir)).sum(),
        folder: key,
        dirs,
      })
      .map(|mut site| {
        site.origin = origin_of(site.kind, &site.folder, &site.dirs, &buckets);
        site
      })
      .collect(),
    backups: backups
      .into_iter()
      .map(|((kind, key, stamp), dirs)| SiteStorageBackup {
        id: format!("{}/{key}{BACKUP_MARKER}{stamp}", kind.area()),
        kind,
        origin: origin_of(kind, &key, &dirs, &buckets),
        bytes: dirs.iter().map(|dir| dir_size(dir)).sum(),
        created_at: stamp_time(&stamp),
        folder: key,
        dirs,
      })
      .collect(),
  }
}

fn report_of(scan: Scan, threshold: u64) -> SiteStorageReport {
  let mut oversized: Vec<SiteStorage> = scan
    .sites
    .into_iter()
    .filter(|site| site.bytes >= threshold)
    .collect();
  oversized.sort_by_key(|site| std::cmp::Reverse(site.bytes));
  let mut backups = scan.backups;
  backups.sort_by_key(|backup| std::cmp::Reverse(backup.created_at));
  SiteStorageReport {
    oversized,
    backups,
    threshold_bytes: threshold,
  }
}

/// A short, stable name for a site in the log, which never holds the site.
fn site_hash(id: &str) -> String {
  blake3::hash(id.as_bytes()).to_hex()[..12].to_string()
}

#[derive(Debug, PartialEq, Eq)]
enum StorageError {
  NotFound,
  UnsafePath,
  Io(std::io::ErrorKind),
}

impl StorageError {
  fn to_backend(&self) -> String {
    match self {
      StorageError::NotFound => crate::backend_error("SITE_STORAGE_NOT_FOUND"),
      StorageError::UnsafePath => crate::backend_error("SITE_STORAGE_UNSAFE_PATH"),
      StorageError::Io(kind) => crate::backend_error_with_detail("SITE_STORAGE_IO_FAILED", kind),
    }
  }
}

/// A folder that a repair or a delete may touch: a real folder (not a link)
/// whose parent resolves inside the data directory.
fn check_contained(root: &Path, dir: &Path) -> Result<(), StorageError> {
  let metadata = std::fs::symlink_metadata(dir).map_err(|_| StorageError::NotFound)?;
  if !metadata.file_type().is_dir() {
    return Err(StorageError::UnsafePath);
  }
  let parent = dir.parent().ok_or(StorageError::UnsafePath)?;
  let parent = parent
    .canonicalize()
    .map_err(|_| StorageError::UnsafePath)?;
  if !parent.starts_with(root) {
    return Err(StorageError::UnsafePath);
  }
  Ok(())
}

fn canonical_root(data_dir: &Path) -> Result<PathBuf, StorageError> {
  data_dir.canonicalize().map_err(|_| StorageError::NotFound)
}

/// A name next to `dir` that nothing uses yet.
fn backup_path(dir: &Path, stamp: &str) -> Option<PathBuf> {
  let name = dir.file_name()?.to_str()?;
  let parent = dir.parent()?;
  (0..100).find_map(|n| {
    let candidate = if n == 0 {
      parent.join(format!("{name}{BACKUP_MARKER}{stamp}"))
    } else {
      parent.join(format!("{name}{BACKUP_MARKER}{stamp}-{n}"))
    };
    std::fs::symlink_metadata(&candidate)
      .is_err()
      .then_some(candidate)
  })
}

/// Rename the folders of the named sites aside, all or none: a failed rename
/// moves back the folders already renamed.
fn move_aside(
  data_dir: &Path,
  ids: &[String],
  stamp: &str,
) -> Result<Vec<SiteStorage>, StorageError> {
  let root = canonical_root(data_dir)?;
  let sites = scan(data_dir).sites;
  let mut chosen = Vec::new();
  for id in ids {
    let site = sites
      .iter()
      .find(|site| &site.id == id)
      .ok_or(StorageError::NotFound)?;
    for dir in &site.dirs {
      check_contained(&root, dir)?;
    }
    chosen.push(site.clone());
  }

  let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();
  for dir in chosen.iter().flat_map(|site| site.dirs.iter()) {
    let result = backup_path(dir, stamp)
      .ok_or(StorageError::UnsafePath)
      .and_then(|target| {
        std::fs::rename(dir, &target)
          .map(|()| target)
          .map_err(|e| StorageError::Io(e.kind()))
      });
    match result {
      Ok(target) => done.push((dir.clone(), target)),
      Err(e) => {
        for (from, to) in done.iter().rev() {
          if let Err(undo) = std::fs::rename(to, from) {
            log::error!("Site storage move not undone err_kind={:?}", undo.kind());
          }
        }
        return Err(e);
      }
    }
  }
  Ok(chosen)
}

fn delete_backup_in(data_dir: &Path, id: &str) -> Result<SiteStorageBackup, StorageError> {
  let root = canonical_root(data_dir)?;
  let backup = scan(data_dir)
    .backups
    .into_iter()
    .find(|backup| backup.id == id)
    .ok_or(StorageError::NotFound)?;
  for dir in &backup.dirs {
    check_contained(&root, dir)?;
  }
  for dir in &backup.dirs {
    std::fs::remove_dir_all(dir).map_err(|e| StorageError::Io(e.kind()))?;
  }
  Ok(backup)
}

// --- Measurements kept between calls ----------------------------------------

struct Cached {
  at: SystemTime,
  report: SiteStorageReport,
}

static CACHE: LazyLock<Mutex<HashMap<String, Cached>>> = LazyLock::new(Default::default);

fn now_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or_default()
}

/// Whether a profile keeps site data on disk that this module can read.
fn measurable(profile: &BrowserProfile) -> bool {
  profile.browser == "wayfern" && !profile.ephemeral && !profile.password_protected
}

fn data_dir(profile: &BrowserProfile) -> PathBuf {
  profile.get_profile_data_path(&ProfileManager::instance().get_profiles_dir())
}

/// Measure a profile now and keep the result.
fn measure(profile: &BrowserProfile) -> SiteStorageReport {
  let report = if measurable(profile) {
    report_of(scan(&data_dir(profile)), OVERSIZED_SITE_BYTES)
  } else {
    SiteStorageReport {
      threshold_bytes: OVERSIZED_SITE_BYTES,
      ..Default::default()
    }
  };
  if let Ok(mut cache) = CACHE.lock() {
    cache.insert(
      profile.id.to_string(),
      Cached {
        at: SystemTime::now(),
        report: report.clone(),
      },
    );
  }
  report
}

/// The kept measurement while it is recent and newer than the last launch.
fn cached(profile: &BrowserProfile) -> Option<SiteStorageReport> {
  let cache = CACHE.lock().ok()?;
  let entry = cache.get(&profile.id.to_string())?;
  let at_secs = entry.at.duration_since(UNIX_EPOCH).ok()?.as_secs();
  let fresh = entry.at.elapsed().is_ok_and(|age| age < CACHE_MAX_AGE)
    && at_secs >= profile.last_launch.unwrap_or(0);
  fresh.then(|| entry.report.clone())
}

fn find_profile(profile_id: &str) -> Result<BrowserProfile, String> {
  ProfileManager::instance()
    .list_profiles()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
    .into_iter()
    .find(|profile| profile.id.to_string() == profile_id)
    .ok_or_else(|| crate::backend_error("PROFILE_NOT_FOUND"))
}

async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
  crate::profile::manager::run_blocking(work)
    .await
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))
}

#[derive(Clone, Serialize)]
struct OversizedNotice {
  profile_id: String,
  sites: Vec<SiteStorage>,
}

/// Measure a profile whose browser just exited by itself. When it exited
/// soon after its launch and a site is oversized, tell the person.
pub fn check_after_exit(profile: BrowserProfile) {
  if !measurable(&profile) {
    return;
  }
  tauri::async_runtime::spawn(async move {
    let started = std::time::Instant::now();
    let early = profile
      .last_launch
      .is_some_and(|launched| now_secs().saturating_sub(launched) <= EARLY_EXIT_SECS);
    let measured = profile.clone();
    let Ok(report) = blocking(move || measure(&measured)).await else {
      return;
    };
    let Some(largest) = report.oversized.first() else {
      return;
    };
    log::info!(
      "Oversized site storage profile={} sites={} largest_bytes={} early_exit={early} elapsed_ms={}",
      profile.id,
      report.oversized.len(),
      largest.bytes,
      started.elapsed().as_millis()
    );
    if early {
      let notice = OversizedNotice {
        profile_id: profile.id.to_string(),
        sites: report.oversized,
      };
      if let Err(e) = crate::events::emit("site-storage-oversized", &notice) {
        log::warn!("Event emit failed event=site-storage-oversized err=\"{e}\"");
      }
    }
  });
}

/// Oversized sites and moved-aside folders of a profile.
#[tauri::command]
pub async fn get_profile_site_storage(profile_id: String) -> Result<SiteStorageReport, String> {
  let profile = find_profile(&profile_id)?;
  if let Some(report) = cached(&profile) {
    return Ok(report);
  }
  blocking(move || measure(&profile)).await
}

/// Hold off launches of a profile whose browser is not running. Moving a
/// site's folders under a running browser would corrupt them.
async fn hold_stopped(
  profile: &BrowserProfile,
) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
  let guard = crate::browser_runner::try_lock_profile_launch(&profile.id.to_string())
    .await
    .ok_or_else(|| crate::backend_error("PROFILE_RUNNING"))?;
  if crate::wayfern_identity_storage::is_running(profile).await {
    return Err(crate::backend_error("PROFILE_RUNNING"));
  }
  Ok(guard)
}

/// Move the folders of the named sites aside. Refused while the profile's
/// browser runs or launches.
#[tauri::command]
pub async fn repair_profile_site_storage(
  profile_id: String,
  storage_ids: Vec<String>,
) -> Result<SiteStorageReport, String> {
  let profile = find_profile(&profile_id)?;
  if !measurable(&profile) {
    return Err(crate::backend_error("SITE_STORAGE_NOT_FOUND"));
  }
  let _launch_guard = hold_stopped(&profile).await?;
  let stamp = chrono::Local::now().format(STAMP_FORMAT).to_string();
  let dir = data_dir(&profile);
  let sync_dir = ProfileManager::instance()
    .get_profiles_dir()
    .join(profile.id.to_string());
  let id = profile_id.clone();
  let moved = blocking(move || move_aside(&dir, &storage_ids, &stamp)).await?;
  match moved {
    Ok(sites) => {
      // The moved folders leave the synced files, so sync must take this
      // copy as the newer one, or it brings the remote folders back.
      if let Err(e) = crate::sync::manifest::mark_local_edit(&sync_dir) {
        log::warn!(
          "Site storage repair not marked for sync profile={id} err_kind={:?}",
          e.kind()
        );
      }
      for site in &sites {
        log::info!(
          "Site storage moved aside profile={id} site={} kind={} bytes={} folders={}",
          site_hash(&site.id),
          site.kind.as_str(),
          site.bytes,
          site.dirs.len()
        );
      }
    }
    Err(e) => {
      log::error!("Site storage move failed profile={id} err={e:?}");
      return Err(e.to_backend());
    }
  }
  blocking(move || measure(&profile)).await
}

/// Delete folders a repair moved aside.
#[tauri::command]
pub async fn delete_profile_site_storage_backup(
  profile_id: String,
  backup_id: String,
) -> Result<SiteStorageReport, String> {
  let profile = find_profile(&profile_id)?;
  if !measurable(&profile) {
    return Err(crate::backend_error("SITE_STORAGE_NOT_FOUND"));
  }
  let dir = data_dir(&profile);
  let deleted = blocking(move || delete_backup_in(&dir, &backup_id)).await?;
  match deleted {
    Ok(backup) => log::info!(
      "Site storage backup deleted profile={profile_id} site={} kind={} bytes={}",
      site_hash(&backup.id),
      backup.kind.as_str(),
      backup.bytes
    ),
    Err(e) => {
      log::error!("Site storage backup delete failed profile={profile_id} err={e:?}");
      return Err(e.to_backend());
    }
  }
  blocking(move || measure(&profile)).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  const STUDIO: &str = "Default/IndexedDB/https_studio.youtube.com_0";

  fn sparse(path: &Path, len: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::File::create(path).unwrap().set_len(len).unwrap();
  }

  fn profile_with_studio(root: &Path, len: u64) {
    sparse(
      &root.join(STUDIO).join("1.indexeddb.blob").join("blob"),
      len,
    );
    sparse(
      &root
        .join(STUDIO)
        .join("1.indexeddb.leveldb")
        .join("000003.log"),
      10,
    );
    sparse(
      &root.join("Default/IndexedDB/https_mail.example_0/db/000003.log"),
      100,
    );
    sparse(&root.join("Default/Network/Cookies"), 4096);
    sparse(&root.join("Default/Login Data"), 2048);
    sparse(&root.join("Local State"), 512);
  }

  #[test]
  fn a_site_over_the_threshold_is_reported_with_its_origin() {
    let tmp = tempfile::tempdir().unwrap();
    profile_with_studio(tmp.path(), 3 * 1024 * 1024 * 1024);
    let report = report_of(scan(tmp.path()), OVERSIZED_SITE_BYTES);
    assert_eq!(report.oversized.len(), 1);
    let site = &report.oversized[0];
    assert_eq!(site.id, STUDIO);
    assert_eq!(site.origin.as_deref(), Some("https://studio.youtube.com"));
    assert_eq!(site.kind, StorageKind::IndexedDb);
    assert_eq!(site.bytes, 3 * 1024 * 1024 * 1024 + 10);
  }

  #[test]
  fn a_site_under_the_threshold_is_not_reported() {
    let tmp = tempfile::tempdir().unwrap();
    profile_with_studio(tmp.path(), OVERSIZED_SITE_BYTES - 11);
    assert!(report_of(scan(tmp.path()), OVERSIZED_SITE_BYTES)
      .oversized
      .is_empty());
    assert_eq!(report_of(scan(tmp.path()), 1000).oversized.len(), 1);
  }

  #[test]
  fn the_legacy_indexeddb_folders_of_one_site_count_together() {
    let tmp = tempfile::tempdir().unwrap();
    let idb = tmp.path().join("Default/IndexedDB");
    sparse(
      &idb.join("https_a.example_0.indexeddb.leveldb/000003.log"),
      600,
    );
    sparse(&idb.join("https_a.example_0.indexeddb.blob/1/00/1"), 500);
    let report = report_of(scan(tmp.path()), 1000);
    assert_eq!(report.oversized.len(), 1);
    assert_eq!(report.oversized[0].bytes, 1100);
    assert_eq!(report.oversized[0].dirs.len(), 2);
    assert_eq!(
      report.oversized[0].origin.as_deref(),
      Some("https://a.example")
    );
  }

  #[test]
  fn other_storage_kinds_are_measured() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = tmp
      .path()
      .join("Default/Service Worker/CacheStorage/abc123");
    sparse(&cache.join("data"), 5000);
    fs::write(
      cache.join("index.txt"),
      b"\x0a\x1chttps://cache.example/\x12\x00",
    )
    .unwrap();
    sparse(&tmp.path().join("Default/File System/000/p/00/1"), 5000);
    sparse(&tmp.path().join("Default/File System/Origins/LOG"), 5000);
    sparse(&tmp.path().join("Default/WebStorage/7/IndexedDB/x"), 5000);
    let report = report_of(scan(tmp.path()), 1000);
    let kinds: Vec<_> = report
      .oversized
      .iter()
      .map(|s| (s.kind, s.origin.clone()))
      .collect();
    assert_eq!(kinds.len(), 3, "{kinds:?}");
    assert!(kinds.contains(&(
      StorageKind::CacheStorage,
      Some("https://cache.example".into())
    )));
    assert!(kinds.contains(&(StorageKind::FileSystem, None)));
    assert!(kinds.contains(&(StorageKind::StorageBucket, None)));
  }

  #[test]
  fn repair_renames_only_the_site_and_keeps_the_rest() {
    let tmp = tempfile::tempdir().unwrap();
    profile_with_studio(tmp.path(), 3000);
    let moved = move_aside(tmp.path(), &[STUDIO.to_string()], "20261101-165020").unwrap();
    assert_eq!(moved.len(), 1);
    let backup = tmp
      .path()
      .join("Default/IndexedDB/https_studio.youtube.com_0.donut-backup-20261101-165020");
    assert!(backup.join("1.indexeddb.blob/blob").is_file());
    assert!(!tmp.path().join(STUDIO).exists());
    for kept in [
      "Default/Network/Cookies",
      "Default/Login Data",
      "Local State",
      "Default/IndexedDB/https_mail.example_0/db/000003.log",
    ] {
      assert!(tmp.path().join(kept).is_file(), "{kept} must stay");
    }

    let report = report_of(scan(tmp.path()), 1000);
    assert!(report.oversized.is_empty(), "a backup is not a site");
    assert_eq!(report.backups.len(), 1);
    assert_eq!(report.backups[0].bytes, 3010);
    assert_eq!(
      report.backups[0].origin.as_deref(),
      Some("https://studio.youtube.com")
    );
    assert!(report.backups[0].created_at.is_some());
  }

  #[test]
  fn a_second_repair_in_the_same_second_gets_its_own_name() {
    let tmp = tempfile::tempdir().unwrap();
    profile_with_studio(tmp.path(), 3000);
    move_aside(tmp.path(), &[STUDIO.to_string()], "20261101-165020").unwrap();
    profile_with_studio(tmp.path(), 3000);
    move_aside(tmp.path(), &[STUDIO.to_string()], "20261101-165020").unwrap();
    assert_eq!(scan(tmp.path()).backups.len(), 2);
  }

  #[test]
  fn an_unknown_site_is_refused_and_nothing_moves() {
    let tmp = tempfile::tempdir().unwrap();
    profile_with_studio(tmp.path(), 3000);
    let ids = [
      STUDIO.to_string(),
      "Default/IndexedDB/../../Local State".to_string(),
    ];
    assert_eq!(
      move_aside(tmp.path(), &ids, "20261101-165020").unwrap_err(),
      StorageError::NotFound
    );
    assert!(tmp.path().join(STUDIO).is_dir());
  }

  #[test]
  fn deleting_a_backup_removes_only_it() {
    let tmp = tempfile::tempdir().unwrap();
    profile_with_studio(tmp.path(), 3000);
    move_aside(tmp.path(), &[STUDIO.to_string()], "20261101-165020").unwrap();
    let id = scan(tmp.path()).backups[0].id.clone();
    assert_eq!(
      delete_backup_in(tmp.path(), STUDIO).unwrap_err(),
      StorageError::NotFound
    );
    delete_backup_in(tmp.path(), &id).unwrap();
    assert!(scan(tmp.path()).backups.is_empty());
    assert!(tmp
      .path()
      .join("Default/IndexedDB/https_mail.example_0")
      .is_dir());
  }

  #[cfg(unix)]
  #[test]
  fn a_link_out_of_the_profile_is_neither_measured_nor_moved() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    sparse(&outside.path().join("https_x.example_0/big"), 5000);
    let idb = tmp.path().join("Default/IndexedDB");
    fs::create_dir_all(&idb).unwrap();
    std::os::unix::fs::symlink(
      outside.path().join("https_x.example_0"),
      idb.join("https_x.example_0"),
    )
    .unwrap();
    assert!(
      scan(tmp.path()).sites.is_empty(),
      "a linked site folder is skipped"
    );

    // A linked area folder resolves out of the profile, so nothing in it moves.
    let other = tempfile::tempdir().unwrap();
    fs::create_dir_all(other.path().join("Default")).unwrap();
    sparse(&outside.path().join("area/https_y.example_0/big"), 5000);
    std::os::unix::fs::symlink(
      outside.path().join("area"),
      other.path().join("Default/IndexedDB"),
    )
    .unwrap();
    let id = "Default/IndexedDB/https_y.example_0".to_string();
    assert_eq!(scan(other.path()).sites.len(), 1);
    assert_eq!(
      move_aside(other.path(), &[id], "20261101-165020").unwrap_err(),
      StorageError::UnsafePath
    );
    assert!(outside.path().join("area/https_y.example_0/big").is_file());
  }

  #[tokio::test]
  async fn repair_is_refused_while_the_browser_runs_or_launches() {
    let running = BrowserProfile {
      id: uuid::Uuid::new_v4(),
      browser: "wayfern".into(),
      process_id: Some(std::process::id()),
      ..Default::default()
    };
    let refused = hold_stopped(&running).await.unwrap_err();
    assert!(refused.contains("PROFILE_RUNNING"), "{refused}");

    let launching = BrowserProfile {
      id: uuid::Uuid::new_v4(),
      browser: "wayfern".into(),
      process_id: Some(std::process::id()),
      ..Default::default()
    };
    let _launch = crate::browser_runner::try_lock_profile_launch(&launching.id.to_string())
      .await
      .unwrap();
    let refused = hold_stopped(&launching).await.unwrap_err();
    assert!(refused.contains("PROFILE_RUNNING"), "{refused}");
  }

  #[test]
  fn the_stamp_reads_back_as_a_time() {
    assert!(stamp_time("20261101-165020").is_some());
    assert!(stamp_time("20261101-165020-1").is_some());
    assert!(stamp_time("garbage").is_none());
  }

  #[test]
  fn the_log_name_of_a_site_hides_it() {
    let hash = site_hash(STUDIO);
    assert_eq!(hash.len(), 12);
    assert!(!hash.contains("youtube"));
  }
}
