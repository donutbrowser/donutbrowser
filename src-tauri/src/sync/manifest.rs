use chrono::{DateTime, Utc};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::SystemTime;

use super::types::{SyncError, SyncResult};

/// Default exclude patterns for volatile browser profile files.
/// Patterns use `**/` prefix to match at any directory depth, since the sync
/// engine scans from `profiles/{uuid}/` which contains `profile/Default/...`.
///
/// `Service Worker/ScriptCache` and `Service Worker/CacheStorage` are site
/// data, not caches: Chromium drops a service worker registration whose script
/// is missing, which loses the site's push subscription and offline data, and
/// an extension's background worker fails its first start. `Secure
/// Preferences` holds the extension, homepage and startup settings of profiles
/// written by browsers that kept tracked preferences there.
pub const DEFAULT_EXCLUDE_PATTERNS: &[&str] = &[
  "**/Cache/**",
  "**/Code Cache/**",
  "**/GPUCache/**",
  "**/GrShaderCache/**",
  "**/ShaderCache/**",
  "**/DawnCache/**",
  "**/DawnGraphiteCache/**",
  "**/Session Storage/**",
  "**/blob_storage/**",
  "**/Crashpad/**",
  "**/Crash Reports/**",
  "**/BrowserMetrics/**",
  "**/optimization_guide_model_store/**",
  "**/Safe Browsing/**",
  "**/component_crx_cache/**",
  "**/cache2/**",
  "**/startupCache/**",
  "**/safebrowsing/**",
  "**/storage/temporary/**",
  "**/storage/default/*/cache/**",
  "**/datareporting/**",
  "**/saved-telemetry-pings/**",
  "**/sessionstore-backups/**",
  "**/sessions/**",
  "**/serviceworker.txt",
  "**/AlternateServices.bin",
  "**/SiteSecurityServiceState.bin",
  "**/favicons.sqlite",
  "**/favicons.sqlite-*",
  "**/crashes/**",
  "**/minidumps/**",
  "*.tmp",
  "**/LOG",
  "**/LOG.old",
  "**/LOCK",
  "**/*-journal",
  "**/*-wal",
  "**/*-shm",
  "**/SingletonLock",
  // Rewritten by donut before every launch from the profile metadata that
  // already syncs; uploading it would only duplicate that state.
  "**/wayfern-identity.json",
  "**/wayfern-identity-result.json",
  "**/wayfern-persona.json",
  "**/SingletonSocket",
  "**/SingletonCookie",
  "**/GraphiteDawnCache/**",
  "**/DawnWebGPUCache/**",
  "**/GPUPersistentCache/**",
  "**/BrowserMetrics*",
  "**/.DS_Store",
  // Site storage a repair moved aside (`site_storage.rs`): kept on this
  // device only, until the person deletes it.
  "**/*.donut-backup-*",
  "**/*.donut-backup-*/**",
  // Profile metadata is a separately reconciled LWW config object. Including
  // it in the browser-file manifest creates two competing sync mechanisms and
  // lets a stale in-memory profile overwrite a metadata download.
  "metadata.json",
  ".donut-sync/**",
  // Orphaned local-only marker from earlier rollover-based fingerprint
  // regeneration. Keep excluding it so any markers left on disk from
  // prior builds never get uploaded.
  ".last-fp-refresh",
];

/// A single file entry in the manifest
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestFileEntry {
  pub path: String,
  pub size: u64,
  pub mtime: i64,
  pub hash: String,
}

/// The sync manifest for a profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
  pub version: u32,
  #[serde(rename = "profileId")]
  pub profile_id: String,
  #[serde(rename = "generatedAt")]
  pub generated_at: String,
  #[serde(rename = "updatedAt")]
  pub updated_at: String,
  #[serde(rename = "excludeGlobs")]
  pub exclude_globs: Vec<String>,
  pub files: Vec<ManifestFileEntry>,
  #[serde(default)]
  pub encrypted: bool,
}

impl SyncManifest {
  pub fn new(profile_id: String, exclude_globs: Vec<String>) -> Self {
    let now = Utc::now().to_rfc3339();
    Self {
      version: 1,
      profile_id,
      generated_at: now.clone(),
      updated_at: now,
      exclude_globs,
      files: Vec::new(),
      encrypted: false,
    }
  }

  pub fn updated_at_datetime(&self) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&self.updated_at)
      .ok()
      .map(|dt| dt.with_timezone(&Utc))
  }
}

/// Local hash cache to avoid re-hashing unchanged files
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HashCache {
  pub entries: HashMap<String, HashCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashCacheEntry {
  pub size: u64,
  pub mtime: i64,
  pub hash: String,
}

impl HashCache {
  pub fn load(cache_path: &Path) -> Self {
    if !cache_path.exists() {
      return Self::default();
    }

    match fs::read_to_string(cache_path) {
      Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
      Err(_) => Self::default(),
    }
  }

  pub fn save(&self, cache_path: &Path) -> SyncResult<()> {
    if let Some(parent) = cache_path.parent() {
      fs::create_dir_all(parent).map_err(|e| {
        SyncError::IoError(format!(
          "Failed to create cache directory {}: {e}",
          parent.display()
        ))
      })?;
    }

    let json = serde_json::to_string_pretty(self)
      .map_err(|e| SyncError::SerializationError(format!("Failed to serialize hash cache: {e}")))?;

    fs::write(cache_path, json).map_err(|e| {
      SyncError::IoError(format!(
        "Failed to write hash cache {}: {e}",
        cache_path.display()
      ))
    })?;

    Ok(())
  }

  pub fn get(&self, path: &str, size: u64, mtime: i64) -> Option<&str> {
    self.entries.get(path).and_then(|entry| {
      if entry.size == size && entry.mtime == mtime {
        Some(entry.hash.as_str())
      } else {
        None
      }
    })
  }

  pub fn insert(&mut self, path: String, size: u64, mtime: i64, hash: String) {
    self
      .entries
      .insert(path, HashCacheEntry { size, mtime, hash });
  }
}

/// Build a GlobSet from exclude patterns
fn build_exclude_globset(patterns: &[String]) -> SyncResult<GlobSet> {
  let mut builder = GlobSetBuilder::new();
  for pattern in patterns {
    let glob = Glob::new(pattern)
      .map_err(|e| SyncError::InvalidData(format!("Invalid exclude pattern '{}': {e}", pattern)))?;
    builder.add(glob);
  }
  builder
    .build()
    .map_err(|e| SyncError::InvalidData(format!("Failed to build exclude globset: {e}")))
}

/// Compute blake3 hash of a file
/// Returns None if the file doesn't exist (was deleted)
fn hash_file(path: &Path) -> Result<Option<String>, SyncError> {
  let file = match File::open(path) {
    Ok(f) => f,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to open {}: {e}",
        path.display()
      )));
    }
  };

  let mut reader = BufReader::new(file);
  let mut hasher = blake3::Hasher::new();
  let mut buffer = [0u8; 65536]; // 64KB buffer

  loop {
    let bytes_read = reader
      .read(&mut buffer)
      .map_err(|e| SyncError::IoError(format!("Failed to read {}: {e}", path.display())))?;
    if bytes_read == 0 {
      break;
    }
    hasher.update(&buffer[..bytes_read]);
  }

  Ok(Some(hasher.finalize().to_hex().to_string()))
}

/// Get mtime as unix timestamp
/// Returns None if the file doesn't exist (was deleted)
fn get_mtime(path: &Path) -> Result<Option<i64>, SyncError> {
  let metadata = match path.metadata() {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => {
      return Err(SyncError::IoError(format!(
        "Failed to get metadata for {}: {e}",
        path.display()
      )));
    }
  };

  let mtime = metadata
    .modified()
    .map_err(|e| SyncError::IoError(format!("Failed to get mtime for {}: {e}", path.display())))?;

  Ok(Some(
    mtime
      .duration_since(SystemTime::UNIX_EPOCH)
      .map(|d| d.as_secs() as i64)
      .unwrap_or(0),
  ))
}

/// Generate a manifest for a profile directory
pub fn generate_manifest(
  profile_id: &str,
  profile_dir: &Path,
  cache: &mut HashCache,
) -> SyncResult<SyncManifest> {
  let exclude_patterns: Vec<String> = DEFAULT_EXCLUDE_PATTERNS
    .iter()
    .map(|s| s.to_string())
    .collect();
  let globset = build_exclude_globset(&exclude_patterns)?;

  let mut manifest = SyncManifest::new(profile_id.to_string(), exclude_patterns);
  let mut max_mtime: i64 = 0;

  if !profile_dir.exists() {
    log::debug!("Profile dir missing, empty manifest profile={profile_id}");
    return Ok(manifest);
  }

  fn walk_dir(
    dir: &Path,
    base_dir: &Path,
    globset: &GlobSet,
    cache: &mut HashCache,
    files: &mut Vec<ManifestFileEntry>,
    max_mtime: &mut i64,
  ) -> SyncResult<()> {
    let entries = fs::read_dir(dir).map_err(|e| {
      SyncError::IoError(format!("Failed to read directory {}: {e}", dir.display()))
    })?;

    for entry in entries {
      let entry = entry.map_err(|e| {
        SyncError::IoError(format!("Failed to read entry in {}: {e}", dir.display()))
      })?;

      let path = entry.path();
      let relative_path = path
        .strip_prefix(base_dir)
        .map_err(|_| SyncError::IoError("Failed to compute relative path".to_string()))?
        .to_string_lossy()
        .replace('\\', "/");

      // Check if excluded
      if globset.is_match(&relative_path) {
        continue;
      }

      // Get metadata - skip if file was deleted between directory read and metadata access
      let metadata = match path.metadata() {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
          log::debug!(
            "File disappeared during manifest generation, skipping: {}",
            path.display()
          );
          continue;
        }
        Err(e) => {
          return Err(SyncError::IoError(format!(
            "Failed to get metadata for {}: {e}",
            path.display()
          )));
        }
      };

      if metadata.is_dir() {
        walk_dir(&path, base_dir, globset, cache, files, max_mtime)?;
      } else if metadata.is_file() {
        let size = metadata.len();
        let mtime = match get_mtime(&path)? {
          Some(m) => m,
          None => {
            // File was deleted, skip it
            log::debug!(
              "File disappeared during manifest generation, skipping: {}",
              path.display()
            );
            continue;
          }
        };

        *max_mtime = (*max_mtime).max(mtime);

        // Check cache for existing hash
        let hash = if let Some(cached_hash) = cache.get(&relative_path, size, mtime) {
          cached_hash.to_string()
        } else {
          match hash_file(&path)? {
            Some(computed_hash) => {
              cache.insert(relative_path.clone(), size, mtime, computed_hash.clone());
              computed_hash
            }
            None => {
              // File was deleted, skip it
              log::debug!(
                "File disappeared during manifest generation, skipping: {}",
                path.display()
              );
              continue;
            }
          }
        };

        files.push(ManifestFileEntry {
          path: relative_path,
          size,
          mtime,
          hash,
        });
      }
    }

    Ok(())
  }

  walk_dir(
    profile_dir,
    profile_dir,
    &globset,
    cache,
    &mut manifest.files,
    &mut max_mtime,
  )?;

  // Sort files for deterministic manifest
  manifest.files.sort_by(|a, b| a.path.cmp(&b.path));

  // Update the updatedAt timestamp to max mtime, or to a local edit no mtime
  // shows (`mark_local_edit`), whichever is newer.
  let newest = max_mtime.max(local_edit_secs(profile_dir).unwrap_or(0));
  if newest > 0 {
    if let Some(dt) = DateTime::from_timestamp(newest, 0) {
      manifest.updated_at = dt.to_rfc3339();
    }
  }

  Ok(manifest)
}

/// Compute the diff between local and remote manifests
#[derive(Debug, Default)]
pub struct ManifestDiff {
  pub files_to_upload: Vec<ManifestFileEntry>,
  pub files_to_download: Vec<ManifestFileEntry>,
  pub files_to_delete_local: Vec<String>,
  pub files_to_delete_remote: Vec<String>,
}

impl ManifestDiff {
  pub fn is_empty(&self) -> bool {
    self.files_to_upload.is_empty()
      && self.files_to_download.is_empty()
      && self.files_to_delete_local.is_empty()
      && self.files_to_delete_remote.is_empty()
  }
}

/// Compute what needs to be synced between local and remote
/// Which side a sync should believe when both have moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DiffBias {
  /// Newest `updated_at` wins. What an ordinary background sync uses.
  #[default]
  Auto,
  /// Remote wins regardless of timestamps.
  ///
  /// Used for exactly one thing: the pull that follows a remote session. A
  /// remote host has just written the authoritative copy of this profile, and
  /// the local directory is whatever it was before the session started. If the
  /// user launched locally in between, local mtimes are NEWER than the host's
  /// push, so `Auto` would upload the stale copy and put every file the host
  /// wrote into `files_to_delete_remote` — the whole session's work destroyed,
  /// silently. There is no timestamp comparison that gets this right, because
  /// the local clock genuinely is later; only the caller knows that the remote
  /// copy is the one that matters.
  PreferRemote,
  /// Remote wins, for the pull that follows a restore point: the server now
  /// holds the restored files, and the local copy is the one being replaced.
  Restore,
  /// Local wins regardless of timestamps: only this copy changed since the
  /// last sync, or both did and this one is kept (`SyncedSide`).
  PreferLocal,
}

/// Which copies changed since the last sync both sides agreed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Changed {
  /// No record of the last sync: timestamps decide, as before.
  Unknown,
  Neither,
  Local,
  Remote,
  Both,
}

impl Changed {
  /// The direction this change calls for; `Auto` when timestamps decide.
  /// Both changed keeps the local copy: a download would replace files this
  /// device changed with a copy that does not have those changes.
  pub fn bias(self) -> DiffBias {
    match self {
      Changed::Local | Changed::Both => DiffBias::PreferLocal,
      Changed::Remote => DiffBias::PreferRemote,
      Changed::Unknown | Changed::Neither => DiffBias::Auto,
    }
  }
}

/// A digest of a manifest's files by path and content. Times are left out:
/// a copy with the same content is the same copy.
pub fn files_digest(manifest: &SyncManifest) -> String {
  use sha2::Digest;
  let mut files: Vec<(&str, &str)> = manifest
    .files
    .iter()
    .map(|f| (f.path.as_str(), f.hash.as_str()))
    .collect();
  files.sort_unstable();
  let mut hasher = sha2::Sha256::new();
  for (path, hash) in files {
    hasher.update(path.as_bytes());
    hasher.update([0]);
    hasher.update(hash.as_bytes());
    hasher.update(*b"\n");
  }
  hasher
    .finalize()
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect()
}

fn synced_path(profile_dir: &Path) -> std::path::PathBuf {
  profile_dir.join(".donut-sync").join("synced")
}

/// Notes the copy both sides hold after a successful sync.
pub fn save_synced(profile_dir: &Path, manifest: &SyncManifest) -> std::io::Result<()> {
  let path = synced_path(profile_dir);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  fs::write(path, files_digest(manifest))
}

pub fn changed_since_sync(
  profile_dir: &Path,
  local: &SyncManifest,
  remote: &SyncManifest,
) -> Changed {
  let Some(synced) = fs::read_to_string(synced_path(profile_dir))
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
  else {
    return Changed::Unknown;
  };
  match (
    files_digest(local) != synced,
    files_digest(remote) != synced,
  ) {
    (false, false) => Changed::Neither,
    (true, false) => Changed::Local,
    (false, true) => Changed::Remote,
    (true, true) => Changed::Both,
  }
}

/// `Cookies,Local State`: the key files whose content differs between two
/// copies, or `-`.
pub fn differing_key_files(a: &SyncManifest, b: &SyncManifest) -> String {
  let hash_of = |m: &SyncManifest, path: &str| {
    m.files
      .iter()
      .find(|f| f.path == path)
      .map(|f| f.hash.clone())
  };
  let mut names: Vec<&str> = KEY_FILES
    .iter()
    .filter(|(path, _)| hash_of(a, path) != hash_of(b, path))
    .map(|(_, name)| *name)
    .collect();
  names.dedup();
  if names.is_empty() {
    "-".to_string()
  } else {
    names.join(",")
  }
}

/// The files that hold a Wayfern profile's cookies and the key that opens
/// them, by manifest path. A sync that moves one without the other logs the
/// person out of every site, so the result line names what happened to each.
const KEY_FILES: &[(&str, &str)] = &[
  ("profile/os_crypt_key", "os_crypt_key"),
  ("profile/Local State", "Local State"),
  ("profile/Default/Network/Cookies", "Cookies"),
  ("profile/Default/Cookies", "Cookies"),
];

/// Key material a sync never deletes locally: without it every encrypted
/// cookie and password in the profile is lost, and a remote copy that lacks it
/// cannot replace it.
pub fn is_key_material(path: &str) -> bool {
  matches!(path, "profile/os_crypt_key" | "profile/Local State")
}

/// `os_crypt_key:downloaded,Cookies:replaced`: what `diff` does to the
/// profile's key files on this device, or `-` when it touches none. A download
/// over a file `local` has is `replaced`; key material the sync keeps instead
/// of deleting (`keeps_keys`) is `kept`.
pub fn key_file_changes(diff: &ManifestDiff, local: &SyncManifest, keeps_keys: bool) -> String {
  let changes: Vec<String> = KEY_FILES
    .iter()
    .filter_map(|(path, name)| {
      let action = if diff.files_to_download.iter().any(|f| f.path == *path) {
        if local.files.iter().any(|f| f.path == *path) {
          "replaced"
        } else {
          "downloaded"
        }
      } else if diff.files_to_delete_local.iter().any(|p| p == path) {
        if keeps_keys && is_key_material(path) {
          "kept"
        } else {
          "deleted"
        }
      } else {
        return None;
      };
      Some(format!("{name}:{action}"))
    })
    .collect();
  if changes.is_empty() {
    "-".to_string()
  } else {
    changes.join(",")
  }
}

pub fn compute_diff(local: &SyncManifest, remote: Option<&SyncManifest>) -> ManifestDiff {
  compute_diff_with_bias(local, remote, DiffBias::Auto)
}

pub fn compute_diff_with_bias(
  local: &SyncManifest,
  remote: Option<&SyncManifest>,
  bias: DiffBias,
) -> ManifestDiff {
  let mut diff = ManifestDiff::default();

  let Some(remote) = remote else {
    // No remote manifest - upload everything. Even under PreferRemote: there is
    // no remote copy to prefer, and refusing to upload would leave the profile
    // with no cloud copy at all.
    diff.files_to_upload = local.files.clone();
    return diff;
  };

  // Build hash maps for quick lookup
  let local_files: HashMap<&str, &ManifestFileEntry> =
    local.files.iter().map(|f| (f.path.as_str(), f)).collect();
  let remote_files: HashMap<&str, &ManifestFileEntry> =
    remote.files.iter().map(|f| (f.path.as_str(), f)).collect();

  // Safety: if local is empty but remote has files, always download from remote.
  // This prevents data loss when profile data files are deleted but metadata
  // survives — the newly generated manifest would have updated_at=NOW, which
  // would appear "newer" and cause all remote files to be deleted.
  if local.files.is_empty() && !remote.files.is_empty() {
    log::info!(
      "Local manifest empty, recovering from remote files={}",
      remote.files.len()
    );
    diff.files_to_download = remote.files.clone();
    return diff;
  }

  // Compare timestamps to determine direction
  let local_updated = local.updated_at_datetime();
  let remote_updated = remote.updated_at_datetime();

  let local_is_newer = match bias {
    DiffBias::PreferRemote | DiffBias::Restore => false,
    DiffBias::PreferLocal => true,
    DiffBias::Auto => match (local_updated, remote_updated) {
      (Some(l), Some(r)) => l > r,
      (Some(_), None) => true,
      (None, Some(_)) => false,
      (None, None) => true, // Default to uploading
    },
  };

  if local_is_newer {
    // Upload changed/new files, delete remote files that don't exist locally
    for (path, local_entry) in &local_files {
      match remote_files.get(path) {
        Some(remote_entry) if remote_entry.hash != local_entry.hash => {
          diff.files_to_upload.push((*local_entry).clone());
        }
        None => {
          diff.files_to_upload.push((*local_entry).clone());
        }
        _ => {}
      }
    }

    for path in remote_files.keys() {
      if !local_files.contains_key(path) {
        diff.files_to_delete_remote.push(path.to_string());
      }
    }
  } else {
    // Download changed/new files, delete local files that don't exist remotely
    for (path, remote_entry) in &remote_files {
      match local_files.get(path) {
        Some(local_entry) if local_entry.hash != remote_entry.hash => {
          diff.files_to_download.push((*remote_entry).clone());
        }
        None => {
          diff.files_to_download.push((*remote_entry).clone());
        }
        _ => {}
      }
    }

    for path in local_files.keys() {
      if !remote_files.contains_key(path) {
        diff.files_to_delete_local.push(path.to_string());
      }
    }
  }

  diff
}

fn local_edit_path(profile_dir: &Path) -> std::path::PathBuf {
  profile_dir.join(".donut-sync").join("local-edit")
}

fn local_edit_secs(profile_dir: &Path) -> Option<i64> {
  fs::read_to_string(local_edit_path(profile_dir))
    .ok()?
    .trim()
    .parse()
    .ok()
}

/// Marks a profile's synced files as edited now, for a change no file mtime
/// shows: moving files out of the synced set (a site-data repair) keeps the
/// newest mtime, or lowers it, and sync would then take the remote copy back.
/// The profile's next manifest is at least this new. `profile_dir` is the
/// folder sync walks (`<profiles dir>/<profile id>`).
pub fn mark_local_edit(profile_dir: &Path) -> std::io::Result<()> {
  let path = local_edit_path(profile_dir);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  fs::write(path, Utc::now().timestamp().to_string())
}

/// Get the path to the hash cache file for a profile
pub fn get_cache_path(profile_dir: &Path) -> std::path::PathBuf {
  profile_dir.join(".donut-sync").join("cache.json")
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  #[test]
  fn test_hash_cache_operations() {
    let cache_dir = TempDir::new().unwrap();
    let cache_path = cache_dir.path().join("cache.json");

    let mut cache = HashCache::default();
    cache.insert(
      "test.txt".to_string(),
      100,
      1234567890,
      "abc123".to_string(),
    );

    assert_eq!(cache.get("test.txt", 100, 1234567890), Some("abc123"));
    assert_eq!(cache.get("test.txt", 100, 999), None); // Different mtime
    assert_eq!(cache.get("test.txt", 50, 1234567890), None); // Different size

    cache.save(&cache_path).unwrap();

    let loaded = HashCache::load(&cache_path);
    assert_eq!(loaded.get("test.txt", 100, 1234567890), Some("abc123"));
  }

  #[test]
  fn test_generate_manifest_empty_dir() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.profile_id, "test-profile");
    assert_eq!(manifest.version, 1);
    assert!(manifest.files.is_empty());
  }

  #[test]
  fn test_generate_manifest_with_files() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    fs::write(profile_dir.join("file1.txt"), "hello").unwrap();
    fs::write(profile_dir.join("file2.txt"), "world").unwrap();
    fs::create_dir_all(profile_dir.join("subdir")).unwrap();
    fs::write(profile_dir.join("subdir/file3.txt"), "nested").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.files.len(), 3);
    assert!(manifest.files.iter().any(|f| f.path == "file1.txt"));
    assert!(manifest.files.iter().any(|f| f.path == "file2.txt"));
    assert!(manifest.files.iter().any(|f| f.path == "subdir/file3.txt"));
  }

  #[test]
  fn test_generate_manifest_excludes_cache() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile");
    fs::create_dir_all(&profile_dir).unwrap();

    fs::write(profile_dir.join("file1.txt"), "keep").unwrap();
    fs::create_dir_all(profile_dir.join("Cache")).unwrap();
    fs::write(profile_dir.join("Cache/data"), "exclude").unwrap();
    fs::create_dir_all(profile_dir.join("Code Cache")).unwrap();
    fs::write(profile_dir.join("Code Cache/wasm"), "exclude").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].path, "file1.txt");
  }

  #[test]
  fn test_generate_manifest_excludes_nested_caches() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile_root");
    fs::create_dir_all(&profile_dir).unwrap();

    // Simulate real Chromium structure: profile/Default/Cache/...
    let default_dir = profile_dir.join("profile/Default");
    fs::create_dir_all(&default_dir).unwrap();
    fs::write(default_dir.join("Cookies"), "keep").unwrap();
    fs::create_dir_all(default_dir.join("Cache")).unwrap();
    fs::write(default_dir.join("Cache/data_0"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Code Cache/js")).unwrap();
    fs::write(default_dir.join("Code Cache/js/abc"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("GPUCache")).unwrap();
    fs::write(default_dir.join("GPUCache/data_0"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Session Storage")).unwrap();
    fs::write(default_dir.join("Session Storage/000003.log"), "exclude").unwrap();
    fs::create_dir_all(default_dir.join("Local Storage/leveldb")).unwrap();
    fs::write(default_dir.join("Local Storage/leveldb/000001.ldb"), "keep").unwrap();

    // Caches at user-data-dir level
    fs::create_dir_all(profile_dir.join("profile/ShaderCache")).unwrap();
    fs::write(profile_dir.join("profile/ShaderCache/data"), "exclude").unwrap();
    fs::create_dir_all(profile_dir.join("profile/Crashpad")).unwrap();
    fs::write(profile_dir.join("profile/Crashpad/report"), "exclude").unwrap();

    fs::write(profile_dir.join("metadata.json"), "{}").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
      !paths.contains(&"metadata.json"),
      "metadata.json is reconciled separately from browser files"
    );
    assert!(
      paths.contains(&"profile/Default/Cookies"),
      "Cookies should be synced"
    );
    assert!(
      paths.contains(&"profile/Default/Local Storage/leveldb/000001.ldb"),
      "Local Storage should be synced"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Cache")),
      "Cache directories should be excluded: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Session Storage")),
      "Session Storage should be excluded: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.contains("Crashpad")),
      "Crashpad should be excluded: {paths:?}"
    );
  }

  #[test]
  fn test_generate_manifest_keeps_site_data_and_secure_preferences() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile_root");
    let default_dir = profile_dir.join("profile/Default");
    for relative in [
      "Service Worker/Database/000001.log",
      "Service Worker/ScriptCache/index",
      "Service Worker/CacheStorage/index.txt",
      "Secure Preferences",
    ] {
      let path = default_dir.join(relative);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::write(&path, "keep").unwrap();
    }

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    for kept in [
      "profile/Default/Service Worker/Database/000001.log",
      "profile/Default/Service Worker/ScriptCache/index",
      "profile/Default/Service Worker/CacheStorage/index.txt",
      "profile/Default/Secure Preferences",
    ] {
      assert!(paths.contains(&kept), "{kept} must sync: {paths:?}");
    }
  }

  #[test]
  fn test_generate_manifest_excludes_sqlite_shm_sidecars() {
    let temp_dir = TempDir::new().unwrap();
    let profile_dir = temp_dir.path().join("profile_root");
    let default_dir = profile_dir.join("profile/Default");
    fs::create_dir_all(&default_dir).unwrap();

    fs::write(profile_dir.join("Cookies-shm"), "scratch").unwrap();
    fs::write(default_dir.join("History-shm"), "scratch").unwrap();
    fs::write(default_dir.join("History-wal"), "scratch").unwrap();
    fs::write(default_dir.join("History"), "keep").unwrap();

    let mut cache = HashCache::default();
    let manifest = generate_manifest("test-profile", &profile_dir, &mut cache).unwrap();

    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
      !paths.iter().any(|p| p.ends_with("-shm")),
      "SQLite -shm sidecars are scratch state and must not sync: {paths:?}"
    );
    assert!(
      !paths.iter().any(|p| p.ends_with("-wal")),
      "-wal sidecars stay excluded: {paths:?}"
    );
    assert!(
      paths.contains(&"profile/Default/History"),
      "the database itself must still sync: {paths:?}"
    );
  }

  #[test]
  fn test_compute_diff_upload_all_when_no_remote() {
    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: Utc::now().to_rfc3339(),
      updated_at: Utc::now().to_rfc3339(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "file1.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "abc".to_string(),
        },
        ManifestFileEntry {
          path: "file2.txt".to_string(),
          size: 20,
          mtime: 2000,
          hash: "def".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, None);

    assert_eq!(diff.files_to_upload.len(), 2);
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
  }

  /// A manifest with one file, at a stated time.
  fn manifest_at(updated_at: &str, files: &[(&str, &str)]) -> SyncManifest {
    SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: updated_at.to_string(),
      updated_at: updated_at.to_string(),
      exclude_globs: vec![],
      files: files
        .iter()
        .map(|(path, hash)| ManifestFileEntry {
          path: (*path).to_string(),
          size: 10,
          mtime: 1000,
          hash: (*hash).to_string(),
        })
        .collect(),
      encrypted: false,
    }
  }

  #[test]
  fn key_file_changes_name_what_a_sync_does_to_the_key_and_cookies() {
    let local = manifest_at(
      "2026-01-01T00:00:00Z",
      &[
        ("profile/os_crypt_key", "k1"),
        ("profile/Local State", "ls"),
        ("profile/Default/Network/Cookies", "c1"),
        ("profile/Default/History", "h1"),
      ],
    );
    let remote = manifest_at(
      "2026-01-02T00:00:00Z",
      &[
        ("profile/Default/Network/Cookies", "c2"),
        ("profile/Default/History", "h2"),
      ],
    );
    let diff = compute_diff(&local, Some(&remote));
    assert_eq!(
      key_file_changes(&diff, &local, true),
      "os_crypt_key:kept,Local State:kept,Cookies:replaced"
    );
    assert_eq!(
      key_file_changes(&diff, &local, false),
      "os_crypt_key:deleted,Local State:deleted,Cookies:replaced"
    );

    let empty = manifest_at("2026-01-01T00:00:00Z", &[("profile/x", "1")]);
    let fresh = manifest_at(
      "2026-01-02T00:00:00Z",
      &[("profile/x", "1"), ("profile/os_crypt_key", "k")],
    );
    let diff = compute_diff(&empty, Some(&fresh));
    assert_eq!(
      key_file_changes(&diff, &empty, true),
      "os_crypt_key:downloaded"
    );
    assert_eq!(
      key_file_changes(&compute_diff(&fresh, Some(&fresh)), &fresh, true),
      "-"
    );
    assert!(is_key_material("profile/os_crypt_key"));
    assert!(!is_key_material("profile/Default/Network/Cookies"));
  }

  #[test]
  fn prefer_remote_downloads_even_though_the_local_clock_is_later() {
    // The exact shape of the data-loss bug. A remote session finishes and the
    // host pushes the profile; the user then launches locally before the pull
    // lands, so every local mtime is newer than the host's write. Under Auto
    // that uploads the stale copy and deletes the session's own files.
    let local = manifest_at("2026-01-02T00:00:00Z", &[("Cookies", "before-session")]);
    let remote = manifest_at(
      "2026-01-01T00:00:00Z",
      &[("Cookies", "after-session"), ("History", "warmed")],
    );

    let lossy = compute_diff_with_bias(&local, Some(&remote), DiffBias::Auto);
    assert_eq!(lossy.files_to_delete_remote, vec!["History".to_string()]);
    assert_eq!(lossy.files_to_upload.len(), 1);

    let safe = compute_diff_with_bias(&local, Some(&remote), DiffBias::PreferRemote);
    assert!(
      safe.files_to_delete_remote.is_empty(),
      "a post-session pull must never delete what the host just wrote"
    );
    assert!(safe.files_to_upload.is_empty());
    let downloaded: Vec<&str> = safe
      .files_to_download
      .iter()
      .map(|f| f.path.as_str())
      .collect();
    assert_eq!(downloaded.len(), 2);
    assert!(downloaded.contains(&"Cookies"));
    assert!(downloaded.contains(&"History"));
  }

  #[test]
  fn prefer_remote_still_uploads_when_there_is_no_remote_copy() {
    // Nothing to prefer. Refusing to upload here would leave a profile with no
    // cloud copy because a session once ran against it.
    let local = manifest_at("2026-01-02T00:00:00Z", &[("Cookies", "only-local")]);
    let diff = compute_diff_with_bias(&local, None, DiffBias::PreferRemote);
    assert_eq!(diff.files_to_upload.len(), 1);
  }

  #[test]
  fn test_compute_diff_detect_changes() {
    let old_time = "2024-01-01T00:00:00Z";
    let new_time = "2024-01-02T00:00:00Z";

    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: new_time.to_string(),
      updated_at: new_time.to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "unchanged.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "same".to_string(),
        },
        ManifestFileEntry {
          path: "changed.txt".to_string(),
          size: 10,
          mtime: 2000,
          hash: "new_hash".to_string(),
        },
        ManifestFileEntry {
          path: "new_file.txt".to_string(),
          size: 5,
          mtime: 3000,
          hash: "new".to_string(),
        },
      ],
      encrypted: false,
    };

    let remote = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: old_time.to_string(),
      updated_at: old_time.to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "unchanged.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "same".to_string(),
        },
        ManifestFileEntry {
          path: "changed.txt".to_string(),
          size: 10,
          mtime: 1000,
          hash: "old_hash".to_string(),
        },
        ManifestFileEntry {
          path: "deleted.txt".to_string(),
          size: 8,
          mtime: 500,
          hash: "gone".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, Some(&remote));

    // Local is newer, so we upload changed/new and delete remote-only
    assert_eq!(diff.files_to_upload.len(), 2); // changed + new
    assert!(diff.files_to_upload.iter().any(|f| f.path == "changed.txt"));
    assert!(diff
      .files_to_upload
      .iter()
      .any(|f| f.path == "new_file.txt"));
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert_eq!(diff.files_to_delete_remote.len(), 1);
    assert!(diff
      .files_to_delete_remote
      .contains(&"deleted.txt".to_string()));
  }

  #[test]
  fn test_manifest_encrypted_flag_default() {
    let json = r#"{"version":1,"profileId":"test","generatedAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","excludeGlobs":[],"files":[]}"#;
    let manifest: SyncManifest = serde_json::from_str(json).unwrap();
    assert!(!manifest.encrypted);
  }

  #[test]
  fn test_manifest_with_encrypted_flag() {
    let json = r#"{"version":1,"profileId":"test","generatedAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z","excludeGlobs":[],"files":[],"encrypted":true}"#;
    let manifest: SyncManifest = serde_json::from_str(json).unwrap();
    assert!(manifest.encrypted);

    let serialized = serde_json::to_string(&manifest).unwrap();
    let deserialized: SyncManifest = serde_json::from_str(&serialized).unwrap();
    assert!(deserialized.encrypted);
  }

  #[test]
  fn test_compute_diff_empty_local_downloads_from_remote() {
    // When local has no files but remote does, always download from remote.
    // This prevents data loss when profile data is deleted but metadata survives.
    let local = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: Utc::now().to_rfc3339(),
      updated_at: Utc::now().to_rfc3339(), // NOW — appears newer than remote
      exclude_globs: vec![],
      files: vec![],
      encrypted: false,
    };

    let remote = SyncManifest {
      version: 1,
      profile_id: "test".to_string(),
      generated_at: "2024-01-01T00:00:00Z".to_string(),
      updated_at: "2024-01-01T00:00:00Z".to_string(),
      exclude_globs: vec![],
      files: vec![
        ManifestFileEntry {
          path: "Cookies".to_string(),
          size: 100,
          mtime: 1000,
          hash: "abc".to_string(),
        },
        ManifestFileEntry {
          path: "Local State".to_string(),
          size: 200,
          mtime: 1000,
          hash: "def".to_string(),
        },
      ],
      encrypted: false,
    };

    let diff = compute_diff(&local, Some(&remote));

    // Must download all remote files, NOT delete them
    assert_eq!(diff.files_to_download.len(), 2);
    assert!(diff.files_to_upload.is_empty());
    assert!(diff.files_to_delete_remote.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
  }

  fn file_at(path: &Path, body: &str, secs: u64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
    File::options()
      .write(true)
      .open(path)
      .unwrap()
      .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs))
      .unwrap();
  }

  #[test]
  fn site_storage_moved_aside_never_syncs() {
    let dir = TempDir::new().unwrap();
    let data = dir.path().join("profile/Default/IndexedDB");
    file_at(
      &data.join("https_kept.example_0/blob"),
      "kept",
      1_700_000_000,
    );
    let backup = data.join("https_studio.youtube.com_0.donut-backup-20261101-165020");
    file_at(&backup.join("1.indexeddb.blob/blob"), "big", 1_700_000_000);
    file_at(&backup.join("LOG.manifest"), "x", 1_700_000_000);
    let mut cache = HashCache::default();
    let manifest = generate_manifest("p", dir.path(), &mut cache).unwrap();
    let paths: Vec<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
      paths,
      ["profile/Default/IndexedDB/https_kept.example_0/blob"]
    );
  }

  /// A repair moves the newest files out of the synced set: without the mark
  /// the manifest gets older than the remote one and sync brings the remote
  /// folder back; with it, this copy wins and the remote files go.
  #[test]
  fn a_marked_local_edit_wins_over_the_remote_copy() {
    let dir = TempDir::new().unwrap();
    file_at(
      &dir.path().join("profile/Default/Preferences"),
      "p",
      1_600_000_000,
    );
    let mut cache = HashCache::default();
    let before = generate_manifest("p", dir.path(), &mut cache).unwrap();
    assert!(
      before.updated_at.starts_with("2020-09-13"),
      "{}",
      before.updated_at
    );

    let remote = manifest_at(
      "2024-01-01T00:00:00Z",
      &[
        ("profile/Default/Preferences", "other"),
        (
          "profile/Default/IndexedDB/https_studio.youtube.com_0/blob",
          "big",
        ),
      ],
    );
    let diff = compute_diff(&before, Some(&remote));
    assert!(
      !diff.files_to_download.is_empty(),
      "unmarked, the remote copy wins"
    );

    mark_local_edit(dir.path()).unwrap();
    let after = generate_manifest("p", dir.path(), &mut cache).unwrap();
    let marked = after.updated_at_datetime().unwrap();
    assert!(
      (Utc::now() - marked).num_seconds() < 60,
      "{}",
      after.updated_at
    );
    assert!(after
      .files
      .iter()
      .all(|f| !f.path.starts_with(".donut-sync")));
    let diff = compute_diff(&after, Some(&remote));
    assert!(diff.files_to_download.is_empty());
    assert_eq!(
      diff.files_to_delete_remote,
      ["profile/Default/IndexedDB/https_studio.youtube.com_0/blob"]
    );
  }

  fn cookie_jar(path: &Path, sid: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch(
      "CREATE TABLE IF NOT EXISTS cookies (host_key TEXT, name TEXT, value TEXT, PRIMARY KEY (host_key, name))",
    )
    .unwrap();
    db.execute(
      "INSERT OR REPLACE INTO cookies VALUES ('.google.com', 'SID', ?1)",
      [sid],
    )
    .unwrap();
  }

  fn with_hash(manifest: &SyncManifest, path: &str, hash: &str, updated_at: &str) -> SyncManifest {
    let mut out = manifest.clone();
    out.updated_at = updated_at.to_string();
    for file in &mut out.files {
      if file.path == path {
        file.hash = hash.to_string();
      }
    }
    out
  }

  /// Google rotates its session cookie on each device that runs the profile.
  /// A download must never put an older jar over one this device changed
  /// since the last sync, whatever the clocks say.
  #[test]
  fn a_cookie_jar_changed_on_both_sides_stays_local() {
    const COOKIES: &str = "profile/Default/Network/Cookies";
    let dir = TempDir::new().unwrap();
    let jar = dir.path().join(COOKIES);
    cookie_jar(&jar, "rotated-1");
    fs::write(dir.path().join("profile/Local State"), "{}").unwrap();
    let synced = generate_manifest("p", dir.path(), &mut HashCache::default()).unwrap();
    save_synced(dir.path(), &synced).unwrap();
    // Remote clocks run far ahead: by timestamps the remote copy always wins.
    let remote = with_hash(&synced, COOKIES, "remote-jar", "2099-01-01T00:00:00Z");

    // Only the remote copy changed: it comes down.
    let unchanged = generate_manifest("p", dir.path(), &mut HashCache::default()).unwrap();
    assert_eq!(
      changed_since_sync(dir.path(), &unchanged, &remote),
      Changed::Remote
    );
    let diff = compute_diff_with_bias(&unchanged, Some(&remote), Changed::Remote.bias());
    assert_eq!(diff.files_to_download.len(), 1);

    // This device rotated the cookie too.
    cookie_jar(&jar, "rotated-2");
    let local = generate_manifest("p", dir.path(), &mut HashCache::default()).unwrap();
    let auto = compute_diff(&local, Some(&remote));
    assert_eq!(
      auto.files_to_download[0].path, COOKIES,
      "timestamps alone would download"
    );

    let changed = changed_since_sync(dir.path(), &local, &remote);
    assert_eq!(changed, Changed::Both);
    let diff = compute_diff_with_bias(&local, Some(&remote), changed.bias());
    assert!(diff.files_to_download.is_empty());
    assert!(diff.files_to_delete_local.is_empty());
    assert_eq!(
      diff
        .files_to_upload
        .iter()
        .map(|f| f.path.as_str())
        .collect::<Vec<_>>(),
      [COOKIES]
    );
    assert_eq!(differing_key_files(&local, &remote), "Cookies");

    // Only this device changed: it goes up even against a later remote clock.
    let untouched = with_hash(
      &synced,
      COOKIES,
      &synced
        .files
        .iter()
        .find(|f| f.path == COOKIES)
        .unwrap()
        .hash,
      "2099-01-01T00:00:00Z",
    );
    assert_eq!(
      changed_since_sync(dir.path(), &local, &untouched),
      Changed::Local
    );
    let diff = compute_diff_with_bias(&local, Some(&untouched), Changed::Local.bias());
    assert!(diff.files_to_download.is_empty());
    assert_eq!(diff.files_to_upload.len(), 1);

    // After the sync both hold the local copy: nothing changed.
    save_synced(dir.path(), &local).unwrap();
    assert_eq!(
      changed_since_sync(dir.path(), &local, &local),
      Changed::Neither
    );
  }

  #[test]
  fn without_a_record_of_the_last_sync_timestamps_decide() {
    let dir = TempDir::new().unwrap();
    let local = manifest_at("2024-01-01T00:00:00Z", &[("profile/a", "1")]);
    let remote = manifest_at("2025-01-01T00:00:00Z", &[("profile/a", "2")]);
    assert_eq!(
      changed_since_sync(dir.path(), &local, &remote),
      Changed::Unknown
    );
    assert_eq!(Changed::Unknown.bias(), DiffBias::Auto);
  }
}
