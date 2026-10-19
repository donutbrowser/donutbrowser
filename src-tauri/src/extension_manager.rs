use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use utoipa::ToSchema;

use crate::app_dirs::is_plain_path_part;
use crate::events;

/// Where an extension's payload came from. `archive` is a user-supplied
/// `.crx`/`.zip`; `unpacked` is a directory that held a top-level
/// `manifest.json`, the "Load unpacked" flow. An unpacked extension is still
/// stored as a zip so the archive pipeline (manifest parsing, icon extraction,
/// sync, launch staging) has exactly one payload shape to handle — except when
/// it is *linked*, in which case nothing is stored at all.
pub const SOURCE_KIND_ARCHIVE: &str = "archive";
pub const SOURCE_KIND_UNPACKED: &str = "unpacked";

fn default_source_kind() -> String {
  SOURCE_KIND_ARCHIVE.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Extension {
  pub id: String,
  pub name: String,
  /// The archive's identity, kept separately from the user's editable name.
  #[serde(default)]
  pub manifest_name: Option<String>,
  pub file_name: String,
  pub file_type: String,
  pub browser_compatibility: Vec<String>,
  pub created_at: u64,
  pub updated_at: u64,
  #[serde(default)]
  pub sync_enabled: bool,
  #[serde(default)]
  pub last_sync: Option<u64>,
  #[serde(default)]
  pub version: Option<String>,
  #[serde(default)]
  pub description: Option<String>,
  #[serde(default)]
  pub author: Option<String>,
  #[serde(default)]
  pub homepage_url: Option<String>,
  /// `archive` or `unpacked`. Absent in metadata written before unpacked
  /// support, which is exactly the archive case.
  #[serde(default = "default_source_kind")]
  pub source_kind: String,
  /// Absolute directory this extension is loaded from in place. `Some` means
  /// nothing is copied into the store: Chromium reads the folder directly, so
  /// edits land on the next browser start. Linked extensions are machine-local
  /// and never sync.
  #[serde(default)]
  pub linked_path: Option<String>,
}

impl Extension {
  /// A linked extension has no payload in the store, so every path that reads
  /// `file/<file_name>` has to branch on this.
  pub fn is_linked(&self) -> bool {
    self.linked_path.is_some()
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ExtensionGroup {
  pub id: String,
  pub name: String,
  pub extension_ids: Vec<String>,
  pub created_at: u64,
  pub updated_at: u64,
  #[serde(default)]
  pub sync_enabled: bool,
  #[serde(default)]
  pub last_sync: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExtensionGroupsData {
  groups: Vec<ExtensionGroup>,
}

fn now_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

fn extensions_base_dir() -> PathBuf {
  crate::app_dirs::extensions_dir()
}

/// Where an archive extension's unpacked files are kept between launches:
/// `tree/` holds them, `source` the stamp of the archive they came from.
fn unpacked_cache_dir(ext_id: &str) -> PathBuf {
  extensions_base_dir().join("unpacked_cache").join(ext_id)
}

/// Bumped when `ensure_icons_extracted` starts reading something new from a
/// manifest, so every extension is read once more.
const BACKFILL_VERSION: u32 = 1;
/// In an extension's folder: the stamp of the source the backfill last read.
const BACKFILL_STAMP_FILE: &str = ".backfill-stamp";

/// What tells one version of a file from the next: its name, size and
/// modification time. Replacing an archive gives it a new stamp.
fn file_stamp(path: &Path) -> Option<String> {
  let metadata = fs::metadata(path).ok()?;
  let modified = metadata
    .modified()
    .ok()?
    .duration_since(UNIX_EPOCH)
    .ok()?
    .as_nanos();
  Some(format!(
    "{}:{}:{modified}",
    path.file_name()?.to_string_lossy(),
    metadata.len()
  ))
}

fn is_message_placeholder(value: &str) -> bool {
  crate::vpn_extension_detect::message_placeholder_key(value).is_some()
}

/// Copy the tree `from` into `to`, hard-linking files where the volume
/// allows and copying where it does not. A `manifest.json` is always copied:
/// the launch rewrites the staged one.
fn stage_tree(from: &Path, to: &Path) -> std::io::Result<()> {
  fs::create_dir_all(to)?;
  for entry in fs::read_dir(from)? {
    let entry = entry?;
    let source = entry.path();
    let target = to.join(entry.file_name());
    let file_type = entry.file_type()?;
    if file_type.is_dir() {
      stage_tree(&source, &target)?;
    } else if file_type.is_file()
      && (entry.file_name() == "manifest.json" || fs::hard_link(&source, &target).is_err())
    {
      fs::copy(&source, &target)?;
    }
  }
  Ok(())
}

fn extension_groups_file() -> PathBuf {
  crate::app_dirs::data_subdir().join("extension_groups.json")
}

fn determine_browser_compatibility(file_type: &str) -> Vec<String> {
  match file_type {
    // `unpacked` is a linked folder, which has no archive but is still a
    // Chromium extension. Leaving it unmapped here would make it silently
    // ineligible at launch, which filters on this list.
    "crx" | "zip" | "unpacked" => vec!["chromium".to_string()],
    _ => vec![],
  }
}

fn get_file_type(file_name: &str) -> Option<String> {
  let ext = file_name.rsplit('.').next()?.to_lowercase();
  match ext.as_str() {
    "crx" | "zip" => Some(ext),
    _ => None,
  }
}

fn find_zip_start(data: &[u8]) -> usize {
  for i in 0..data.len().saturating_sub(3) {
    if data[i] == 0x50 && data[i + 1] == 0x4B && data[i + 2] == 0x03 && data[i + 3] == 0x04 {
      return i;
    }
  }
  0
}

/// Read and parse an extension archive's `manifest.json`. Handles the CRX3
/// header by seeking to the embedded ZIP. Shared with
/// `vpn_extension_detect`, which classifies from the raw manifest rather than
/// from the metadata subset persisted on `Extension`.
pub(crate) fn read_manifest_from_archive(
  file_data: &[u8],
  file_type: &str,
) -> Option<serde_json::Value> {
  let zip_start = if file_type == "crx" {
    find_zip_start(file_data)
  } else {
    0
  };

  let cursor = std::io::Cursor::new(file_data.get(zip_start..)?);
  let mut archive = zip::ZipArchive::new(cursor).ok()?;

  let mut contents = String::new();
  {
    let mut file = archive.by_name("manifest.json").ok()?;
    std::io::Read::read_to_string(&mut file, &mut contents).ok()?;
  }
  serde_json::from_str(&contents).ok()
}

/// Resolve a `__MSG_key__` placeholder against the archive's default locale
/// messages. Chromium extensions routinely localize `name`/`description`, and
/// showing the raw placeholder in a warning dialog reads as a bug.
pub(crate) fn resolve_archive_i18n(
  file_data: &[u8],
  file_type: &str,
  manifest: &serde_json::Value,
  value: &str,
) -> Option<String> {
  let key = crate::vpn_extension_detect::message_placeholder_key(value)?;
  let default_locale = manifest.get("default_locale")?.as_str()?;

  let zip_start = if file_type == "crx" {
    find_zip_start(file_data)
  } else {
    0
  };
  let cursor = std::io::Cursor::new(file_data.get(zip_start..)?);
  let mut archive = zip::ZipArchive::new(cursor).ok()?;

  let mut contents = String::new();
  {
    let mut file = archive
      .by_name(&format!("_locales/{default_locale}/messages.json"))
      .ok()?;
    std::io::Read::read_to_string(&mut file, &mut contents).ok()?;
  }
  let messages: serde_json::Value = serde_json::from_str(&contents).ok()?;
  crate::vpn_extension_detect::lookup_message(&messages, &key)
}

/// Read an unpacked extension's `manifest.json` off disk. The directory
/// equivalent of `read_manifest_from_archive`, so both payload shapes feed the
/// same metadata and icon extraction below.
/// The manifest `key` of a staged copy. Chromium derives the id of an unpacked
/// extension from its absolute path unless the manifest has a `key`, and the
/// staging path differs on every machine and OS, so a path id leaves the
/// extension's storage and settings on the machine that staged it. The key is
/// derived from the profile and the extension, so the id is the same on every
/// machine and still differs between profiles.
fn portable_manifest_key(profile_id: &str, ext_id: &str) -> Vec<u8> {
  use sha2::{Digest, Sha256};
  let mut hasher = Sha256::new();
  hasher.update(b"donut-staged-extension-key\0");
  hasher.update(profile_id.as_bytes());
  hasher.update([0u8]);
  hasher.update(ext_id.as_bytes());
  hasher.finalize().to_vec()
}

/// The extension id Chromium derives from a manifest `key`: the first 16 bytes
/// of its SHA-256, each nibble written as a letter from `a` to `p`.
fn extension_id_for_key(key: &[u8]) -> String {
  use sha2::{Digest, Sha256};
  Sha256::digest(key)[..16]
    .iter()
    .flat_map(|byte| [byte >> 4, byte & 0x0f])
    .map(|nibble| char::from(b'a' + nibble))
    .collect()
}

/// Whether two spellings name the same directory, as the browser records it.
fn same_dir(recorded: &str, dir: &Path) -> bool {
  let recorded = Path::new(recorded);
  let canonical = dir.canonicalize().ok();
  [Some(dir.to_path_buf()), canonical]
    .into_iter()
    .flatten()
    .any(|candidate| {
      let candidate = candidate.to_string_lossy().to_string();
      let candidate = candidate.strip_prefix(r"\\?\").unwrap_or(&candidate);
      if cfg!(windows) {
        recorded.to_string_lossy().eq_ignore_ascii_case(candidate)
      } else {
        recorded == Path::new(candidate)
      }
    })
}

/// The id under which the profile already keeps state for the extension staged
/// at `dir`, when that id is not `portable_id`. Such state was recorded before
/// staged copies carried a key.
fn recorded_path_id(profile_data_path: &Path, dir: &Path, portable_id: &str) -> Option<String> {
  let mut recorded_path_ids = Vec::new();
  for file in ["Preferences", "Secure Preferences"] {
    let Ok(contents) = fs::read_to_string(profile_data_path.join("Default").join(file)) else {
      continue;
    };
    let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&contents) else {
      continue;
    };
    let Some(settings) = prefs
      .pointer("/extensions/settings")
      .and_then(|v| v.as_object())
    else {
      continue;
    };
    if settings.contains_key(portable_id) {
      return None;
    }
    recorded_path_ids.extend(
      settings
        .iter()
        .filter(|(_, entry)| {
          entry
            .get("path")
            .and_then(|p| p.as_str())
            .is_some_and(|p| same_dir(p, dir))
        })
        .map(|(id, _)| id.clone()),
    );
  }
  recorded_path_ids.into_iter().next()
}

/// Give the staged copy at `dir` a manifest `key`, so the browser gives it the
/// same id on every machine. A manifest that already has a key keeps it. A
/// profile that already keeps state under the copy's path id keeps that id, so
/// an update never resets an extension on the machine it runs on.
fn give_portable_id(dir: &Path, profile_id: &str, ext_id: &str, profile_data_path: &Path) {
  use base64::Engine;

  let manifest_path = dir.join("manifest.json");
  let Ok(contents) = fs::read_to_string(&manifest_path) else {
    return;
  };
  let Ok(mut manifest) =
    serde_json::from_str::<serde_json::Value>(contents.trim_start_matches('\u{feff}'))
  else {
    log::warn!("Extension keeps a path id, its manifest is not plain JSON extension={ext_id}");
    return;
  };
  let Some(object) = manifest.as_object_mut() else {
    return;
  };
  if object.contains_key("key") {
    return;
  }
  let key = portable_manifest_key(profile_id, ext_id);
  let portable_id = extension_id_for_key(&key);
  if let Some(recorded) = recorded_path_id(profile_data_path, dir, &portable_id) {
    log::info!(
      "Extension keeps the id its data is under extension={ext_id} id={recorded} profile={profile_id}"
    );
    return;
  }
  object.insert(
    "key".to_string(),
    serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(key)),
  );
  match serde_json::to_vec_pretty(&manifest) {
    Ok(bytes) => {
      if let Err(e) = fs::write(&manifest_path, bytes) {
        log::warn!(
          "Extension keeps a path id, manifest write failed extension={ext_id} err=\"{e}\""
        );
      }
    }
    Err(e) => {
      log::warn!(
        "Extension keeps a path id, manifest encode failed extension={ext_id} err=\"{e}\""
      );
    }
  }
}

pub(crate) fn read_manifest_from_dir(dir: &Path) -> Option<serde_json::Value> {
  let contents = fs::read_to_string(dir.join("manifest.json")).ok()?;
  serde_json::from_str(&contents).ok()
}

/// Directory equivalent of `resolve_archive_i18n`.
pub(crate) fn resolve_dir_i18n(
  dir: &Path,
  manifest: &serde_json::Value,
  value: &str,
) -> Option<String> {
  let key = crate::vpn_extension_detect::message_placeholder_key(value)?;
  let default_locale = manifest.get("default_locale")?.as_str()?;
  let contents = fs::read_to_string(
    dir
      .join("_locales")
      .join(default_locale)
      .join("messages.json"),
  )
  .ok()?;
  let messages: serde_json::Value = serde_json::from_str(&contents).ok()?;
  crate::vpn_extension_detect::lookup_message(&messages, &key)
}

/// Where a manifest was read from, kept alongside it so localized fields can be
/// resolved. Chromium extensions routinely set `"name": "__MSG_extName__"`, and
/// storing that literal shows the placeholder to the user instead of the name.
pub(crate) enum ManifestSource<'a> {
  Archive { data: &'a [u8], file_type: &'a str },
  Dir(&'a Path),
}

impl ManifestSource<'_> {
  fn resolve(&self, manifest: &serde_json::Value, value: &str) -> Option<String> {
    match self {
      ManifestSource::Archive { data, file_type } => {
        resolve_archive_i18n(data, file_type, manifest, value)
      }
      ManifestSource::Dir(dir) => resolve_dir_i18n(dir, manifest, value),
    }
  }

  /// Read a manifest string, substituting a `__MSG_key__` placeholder with the
  /// default locale's message when there is one. A placeholder that cannot be
  /// resolved is dropped rather than shown raw.
  fn localized(&self, manifest: &serde_json::Value, key: &str) -> Option<String> {
    let raw = manifest.get(key).and_then(|v| v.as_str())?;
    if crate::vpn_extension_detect::message_placeholder_key(raw).is_some() {
      return self.resolve(manifest, raw);
    }
    Some(raw.to_string())
  }
}

/// `(name, version, description, author, homepage_url)`, with any
/// `__MSG_key__` placeholder already resolved through the manifest's default
/// locale.
type ManifestMetadata = (
  Option<String>,
  Option<String>,
  Option<String>,
  Option<String>,
  Option<String>,
);

fn extract_manifest_metadata(file_data: &[u8], file_type: &str) -> ManifestMetadata {
  match read_manifest_from_archive(file_data, file_type) {
    Some(v) => manifest_metadata(
      &v,
      &ManifestSource::Archive {
        data: file_data,
        file_type,
      },
    ),
    None => (None, None, None, None, None),
  }
}

pub(crate) fn manifest_metadata(
  manifest: &serde_json::Value,
  source: &ManifestSource<'_>,
) -> ManifestMetadata {
  let name = source.localized(manifest, "name");
  let version = manifest
    .get("version")
    .and_then(|v| v.as_str())
    .map(|s| s.to_string());
  let description = source.localized(manifest, "description");
  let author = source.localized(manifest, "author");
  let homepage_url = manifest
    .get("homepage_url")
    .or_else(|| manifest.get("homepage"))
    .and_then(|v| v.as_str())
    .map(|s| s.to_string());

  (name, version, description, author, homepage_url)
}

/// Pick the largest declared icon from a manifest, falling back to the
/// action/browser_action default icon. Shared by the archive and directory
/// readers so both agree on which icon represents an extension.
fn icon_path_from_manifest(manifest: &serde_json::Value) -> Option<String> {
  let mut best_path: Option<String> = None;
  let mut best_size: u32 = 0;

  if let Some(icons) = manifest.get("icons").and_then(|v| v.as_object()) {
    for (size_str, path_val) in icons {
      if let (Ok(size), Some(path)) = (size_str.parse::<u32>(), path_val.as_str()) {
        if size > best_size {
          best_size = size;
          best_path = Some(path.to_string());
        }
      }
    }
  }

  if best_path.is_none() {
    for key in &["action", "browser_action"] {
      if let Some(action) = manifest.get(*key) {
        if let Some(icon) = action.get("default_icon") {
          if let Some(path) = icon.as_str() {
            best_path = Some(path.to_string());
          } else if let Some(icons) = icon.as_object() {
            for (size_str, path_val) in icons {
              if let (Ok(size), Some(path)) = (size_str.parse::<u32>(), path_val.as_str()) {
                if size > best_size {
                  best_size = size;
                  best_path = Some(path.to_string());
                }
              }
            }
          }
        }
      }
    }
  }

  best_path
}

fn icon_extension(path: &str) -> String {
  path.rsplit('.').next().unwrap_or("png").to_lowercase()
}

fn extract_icon_from_archive(file_data: &[u8], file_type: &str) -> Option<(Vec<u8>, String)> {
  let zip_start = if file_type == "crx" {
    find_zip_start(file_data)
  } else {
    0
  };

  let cursor = std::io::Cursor::new(file_data.get(zip_start..)?);
  let mut archive = zip::ZipArchive::new(cursor).ok()?;

  let icon_path = {
    let mut contents = String::new();
    {
      let mut file = archive.by_name("manifest.json").ok()?;
      std::io::Read::read_to_string(&mut file, &mut contents).ok()?;
    }
    let manifest: serde_json::Value = serde_json::from_str(&contents).ok()?;
    icon_path_from_manifest(&manifest)?
  };

  let clean_path = icon_path.trim_start_matches('/');
  let mut file = archive.by_name(clean_path).ok()?;
  let mut data = Vec::new();
  std::io::Read::read_to_end(&mut file, &mut data).ok()?;

  Some((data, icon_extension(clean_path)))
}

/// Directory equivalent of `extract_icon_from_archive`. The icon path is
/// resolved against the extension root and kept inside it, so a manifest
/// pointing at `../../secret.png` cannot pull a file out of the folder.
fn extract_icon_from_dir(dir: &Path, manifest: &serde_json::Value) -> Option<(Vec<u8>, String)> {
  let icon_path = icon_path_from_manifest(manifest)?;
  let clean_path = icon_path.trim_start_matches('/');
  let resolved = resolve_inside(dir, clean_path)?;
  let data = fs::read(resolved).ok()?;
  Some((data, icon_extension(clean_path)))
}

/// Join `relative` onto `root`, refusing anything that escapes `root` (via
/// `..`, an absolute component, or a symlink pointing outside).
fn resolve_inside(root: &Path, relative: &str) -> Option<PathBuf> {
  let mut out = root.to_path_buf();
  for component in Path::new(relative).components() {
    match component {
      std::path::Component::Normal(part) => out.push(part),
      std::path::Component::CurDir => {}
      _ => return None,
    }
  }
  let canonical_root = root.canonicalize().ok()?;
  let canonical_out = out.canonicalize().ok()?;
  canonical_out.starts_with(&canonical_root).then_some(out)
}

/// Ceilings for reading an unpacked extension folder. A real extension is
/// orders of magnitude under both; these exist so pointing the importer at a
/// home directory fails fast instead of exhausting memory.
const MAX_UNPACKED_FILES: usize = 20_000;
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

/// Never part of an extension, and `.git` in particular can dwarf the payload.
fn is_ignored_unpacked_entry(name: &str) -> bool {
  name == ".git" || name == ".DS_Store"
}

/// Chromium takes `--load-extension` as a comma-separated list with no
/// escaping, so a comma anywhere in a path silently splits it into two
/// nonexistent paths and every extension in that launch fails to load. There
/// is no way to encode it, so such a path is rejected at import.
pub(crate) fn path_is_load_extension_safe(path: &Path) -> bool {
  !path.to_string_lossy().contains(',')
}

fn err_code(code: &str) -> Box<dyn std::error::Error> {
  serde_json::json!({ "code": code }).to_string().into()
}

/// A filesystem path named by an automation client (REST or MCP).
///
/// Automation loads an extension from whatever folder or archive the caller
/// names, so the location is the caller's to choose. What a request may not
/// do is climb: a `..` component is refused before the path is touched, and
/// the path is then used exactly as given.
pub fn client_named_path(raw: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
  if raw.contains("..") {
    return Err(err_code("EXTENSION_PATH_INVALID"));
  }
  Ok(PathBuf::from(raw))
}

/// Validate that `dir` is a loadable unpacked extension and return its parsed
/// manifest.
fn validate_unpacked_dir(dir: &Path) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
  if !dir.exists() {
    return Err(err_code("EXTENSION_DIR_NOT_FOUND"));
  }
  if !dir.is_dir() {
    return Err(err_code("EXTENSION_NOT_A_DIRECTORY"));
  }
  let manifest_path = dir.join("manifest.json");
  if !manifest_path.exists() {
    return Err(err_code("EXTENSION_MANIFEST_MISSING"));
  }
  let contents =
    fs::read_to_string(&manifest_path).map_err(|_| err_code("EXTENSION_MANIFEST_INVALID"))?;
  serde_json::from_str(&contents).map_err(|_| err_code("EXTENSION_MANIFEST_INVALID"))
}

/// Recursively collect an extension folder's files as (relative, absolute)
/// pairs, enforcing the size ceilings. Symlinks are not followed: an unpacked
/// extension that links outside its own root is not something to copy into the
/// store.
fn collect_unpacked_files(
  dir: &Path,
) -> Result<Vec<(String, PathBuf)>, Box<dyn std::error::Error>> {
  let mut files = Vec::new();
  let mut total_bytes: u64 = 0;
  let mut stack = vec![(dir.to_path_buf(), String::new())];

  while let Some((current, prefix)) = stack.pop() {
    for entry in fs::read_dir(&current)? {
      let entry = entry?;
      let name = entry.file_name().to_string_lossy().to_string();
      if is_ignored_unpacked_entry(&name) {
        continue;
      }
      let relative = if prefix.is_empty() {
        name.clone()
      } else {
        format!("{prefix}/{name}")
      };

      // `symlink_metadata` so a symlink is classified as a symlink rather than
      // as whatever it points at.
      let metadata = entry.path().symlink_metadata()?;
      if metadata.is_symlink() {
        continue;
      }
      if metadata.is_dir() {
        stack.push((entry.path(), relative));
        continue;
      }

      total_bytes = total_bytes.saturating_add(metadata.len());
      if total_bytes > MAX_UNPACKED_BYTES {
        return Err(err_code("EXTENSION_DIR_TOO_LARGE"));
      }
      files.push((relative, entry.path()));
      if files.len() > MAX_UNPACKED_FILES {
        return Err(err_code("EXTENSION_DIR_TOO_LARGE"));
      }
    }
  }

  Ok(files)
}

/// Pack an unpacked extension folder into a zip in memory, so a folder import
/// becomes an ordinary archive extension everywhere downstream.
fn zip_unpacked_dir(dir: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
  let files = collect_unpacked_files(dir)?;
  let mut buffer = std::io::Cursor::new(Vec::new());
  {
    let mut writer = zip::ZipWriter::new(&mut buffer);
    let options: zip::write::SimpleFileOptions =
      zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (relative, absolute) in files {
      let data = fs::read(&absolute)?;
      writer.start_file(relative, options)?;
      std::io::Write::write_all(&mut writer, &data)?;
    }
    writer.finish()?;
  }
  Ok(buffer.into_inner())
}

/// The stored archive name for a folder import, derived from the folder name so
/// the UI and the sync key stay recognisable.
fn unpacked_archive_name(dir: &Path) -> String {
  let stem = dir
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| "extension".to_string());
  let sanitized: String = stem
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
        c
      } else {
        '-'
      }
    })
    .collect();
  let trimmed = sanitized.trim_matches('-');
  if trimmed.is_empty() {
    "extension.zip".to_string()
  } else {
    format!("{trimmed}.zip")
  }
}

pub struct ExtensionManager;

impl ExtensionManager {
  pub fn new() -> Self {
    Self
  }

  fn get_extension_dir(&self, ext_id: &str) -> PathBuf {
    extensions_base_dir().join(ext_id)
  }

  fn get_metadata_path(&self, ext_id: &str) -> PathBuf {
    self.get_extension_dir(ext_id).join("metadata.json")
  }

  fn get_file_dir(&self, ext_id: &str) -> PathBuf {
    self.get_extension_dir(ext_id).join("file")
  }

  pub fn get_file_dir_public(&self, ext_id: &str) -> PathBuf {
    self.get_file_dir(ext_id)
  }

  // Extension CRUD

  pub fn add_extension(
    &self,
    name: String,
    file_name: String,
    file_data: Vec<u8>,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    let file_type =
      get_file_type(&file_name).ok_or_else(|| err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"))?;

    self.store_archive_extension(
      name,
      file_name,
      file_data,
      file_type,
      SOURCE_KIND_ARCHIVE.to_string(),
    )
  }

  /// Import a folder containing a top-level `manifest.json`, the "Load
  /// unpacked" flow. `link` keeps the folder where it is and loads it in place
  /// (edits apply on the next browser start, machine-local, never synced);
  /// otherwise the folder is packed into the store so it is portable and syncs
  /// like any other extension.
  pub fn add_unpacked_extension(
    &self,
    name: String,
    dir: &Path,
    link: bool,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    let manifest = validate_unpacked_dir(dir)?;

    if link {
      return self.store_linked_extension(name, dir, &manifest);
    }

    let file_data = zip_unpacked_dir(dir)?;
    self.store_archive_extension(
      name,
      unpacked_archive_name(dir),
      file_data,
      "zip".to_string(),
      SOURCE_KIND_UNPACKED.to_string(),
    )
  }

  /// Import an archive that already exists on disk. Used by the REST and MCP
  /// surfaces, where a caller supplies a server-local path rather than bytes.
  pub fn add_extension_from_path(
    &self,
    name: String,
    path: &Path,
    link: bool,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    if !path.exists() {
      return Err(err_code("EXTENSION_DIR_NOT_FOUND"));
    }
    if path.is_dir() {
      return self.add_unpacked_extension(name, path, link);
    }
    if link {
      // Linking means "load this folder in place"; there is nothing to link to
      // for a single archive file.
      return Err(err_code("EXTENSION_LINK_REQUIRES_DIRECTORY"));
    }
    let file_name = path
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .ok_or_else(|| err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"))?;
    let data = fs::read(path)?;
    self.add_extension(name, file_name, data)
  }

  /// Persist a new extension whose payload is a single archive.
  fn store_archive_extension(
    &self,
    name: String,
    file_name: String,
    file_data: Vec<u8>,
    file_type: String,
    source_kind: String,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    let browser_compatibility = determine_browser_compatibility(&file_type);
    if browser_compatibility.is_empty() || !is_plain_path_part(&file_name) {
      return Err(err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"));
    }
    let now = now_secs();

    let (manifest_name, version, description, author, homepage_url) =
      extract_manifest_metadata(&file_data, &file_type);

    let ext = Extension {
      id: uuid::Uuid::new_v4().to_string(),
      name: Self::resolve_name(name, manifest_name.clone())?,
      manifest_name,
      file_name: file_name.clone(),
      file_type,
      browser_compatibility,
      created_at: now,
      updated_at: now,
      sync_enabled: crate::sync::is_sync_configured(),
      last_sync: None,
      version,
      description,
      author,
      homepage_url,
      source_kind,
      linked_path: None,
    };

    let file_dir = self.get_file_dir(&ext.id);
    fs::create_dir_all(&file_dir)?;
    fs::write(file_dir.join(&file_name), &file_data)?;

    if let Some((icon_data, icon_ext)) = extract_icon_from_archive(&file_data, &ext.file_type) {
      self.write_icon(&ext.id, &icon_data, &icon_ext);
    }

    self.persist_new_extension(ext)
  }

  /// Persist a new extension that is loaded in place from `dir`. Nothing is
  /// copied, so sync is forced off: the remote could never reconstruct a path
  /// that only exists on this machine.
  fn store_linked_extension(
    &self,
    name: String,
    dir: &Path,
    manifest: &serde_json::Value,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    // dunce, not std: on Windows std returns the `\\?\C:\...` form, which the
    // Extensions page would show and `--load-extension` would be handed.
    let absolute = dunce::canonicalize(dir)?;
    if !path_is_load_extension_safe(&absolute) {
      return Err(err_code("EXTENSION_PATH_HAS_COMMA"));
    }

    let now = now_secs();
    let (manifest_name, version, description, author, homepage_url) =
      manifest_metadata(manifest, &ManifestSource::Dir(&absolute));

    let ext = Extension {
      id: uuid::Uuid::new_v4().to_string(),
      name: Self::resolve_name(name, manifest_name.clone())?,
      manifest_name,
      file_name: absolute
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default(),
      file_type: "unpacked".to_string(),
      browser_compatibility: determine_browser_compatibility("unpacked"),
      created_at: now,
      updated_at: now,
      sync_enabled: false,
      last_sync: None,
      version,
      description,
      author,
      homepage_url,
      source_kind: SOURCE_KIND_UNPACKED.to_string(),
      linked_path: Some(absolute.to_string_lossy().to_string()),
    };

    if let Some((icon_data, icon_ext)) = extract_icon_from_dir(&absolute, manifest) {
      self.write_icon(&ext.id, &icon_data, &icon_ext);
    }

    self.persist_new_extension(ext)
  }

  /// A manifest name always wins over the caller-supplied one, except when it
  /// is absent or blank.
  fn resolve_name(
    provided: String,
    manifest_name: Option<String>,
  ) -> Result<String, Box<dyn std::error::Error>> {
    let name = match manifest_name {
      Some(n) if !n.trim().is_empty() => n,
      _ => provided,
    };
    if name.trim().is_empty() {
      return Err(err_code("NAME_CANNOT_BE_EMPTY"));
    }
    Ok(name)
  }

  /// Returns whether the icon was written.
  fn write_icon(&self, ext_id: &str, data: &[u8], icon_ext: &str) -> bool {
    let icon_path = self
      .get_extension_dir(ext_id)
      .join(format!("icon.{icon_ext}"));
    fs::write(icon_path, data).is_ok()
  }

  fn persist_new_extension(&self, ext: Extension) -> Result<Extension, Box<dyn std::error::Error>> {
    let metadata_path = self.get_metadata_path(&ext.id);
    if let Some(parent) = metadata_path.parent() {
      fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&ext)?;
    fs::write(metadata_path, json)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if ext.sync_enabled {
      crate::team_activity::record("extension.add", &ext.id, Some(&ext.name), None);
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        let id = ext.id.clone();
        tauri::async_runtime::spawn(async move {
          scheduler.queue_extension_sync(id).await;
        });
      }
    }

    Ok(ext)
  }

  pub fn get_extension(&self, id: &str) -> Result<Extension, Box<dyn std::error::Error>> {
    if !is_plain_path_part(id) {
      return Err(format!("Extension with id '{id}' not found").into());
    }
    let metadata_path = self.get_metadata_path(id);
    if !metadata_path.exists() {
      return Err(format!("Extension with id '{id}' not found").into());
    }
    let content = fs::read_to_string(metadata_path)?;
    let ext: Extension = serde_json::from_str(&content)?;
    Ok(ext)
  }

  pub fn list_extensions(&self) -> Result<Vec<Extension>, Box<dyn std::error::Error>> {
    let base = extensions_base_dir();
    if !base.exists() {
      return Ok(Vec::new());
    }

    let mut extensions = Vec::new();
    for entry in fs::read_dir(base)? {
      let entry = entry?;
      if entry.file_type()?.is_dir() {
        let metadata_path = entry.path().join("metadata.json");
        if metadata_path.exists() {
          let content = fs::read_to_string(&metadata_path)?;
          if let Ok(ext) = serde_json::from_str::<Extension>(&content) {
            extensions.push(ext);
          }
        }
      }
    }

    extensions.sort_by_key(|a| a.created_at);
    Ok(extensions)
  }

  pub fn update_extension(
    &self,
    id: &str,
    name: Option<String>,
    file_name: Option<String>,
    file_data: Option<Vec<u8>>,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    let mut ext = self.get_extension(id)?;
    let explicit_name_provided = Self::apply_name(&mut ext, name)?;

    if let (Some(new_file_name), Some(data)) = (file_name, file_data) {
      let new_file_type =
        get_file_type(&new_file_name).ok_or_else(|| err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"))?;
      self.apply_archive_payload(
        &mut ext,
        new_file_name,
        &data,
        new_file_type,
        SOURCE_KIND_ARCHIVE.to_string(),
        explicit_name_provided,
      )?;
    }

    self.finish_update(ext)
  }

  /// Replace an extension's payload from a server-local path: a `.crx`/`.zip`
  /// archive, or a folder to pack in (or to link, with `link`). This is how an
  /// unpacked extension is re-imported after the source folder changes.
  pub fn update_extension_from_path(
    &self,
    id: &str,
    name: Option<String>,
    path: &Path,
    link: bool,
  ) -> Result<Extension, Box<dyn std::error::Error>> {
    let mut ext = self.get_extension(id)?;
    let explicit_name_provided = Self::apply_name(&mut ext, name)?;

    if !path.exists() {
      return Err(err_code("EXTENSION_DIR_NOT_FOUND"));
    }

    if path.is_dir() {
      let manifest = validate_unpacked_dir(path)?;
      if link {
        self.apply_linked_payload(&mut ext, path, &manifest, explicit_name_provided)?;
      } else {
        let data = zip_unpacked_dir(path)?;
        self.apply_archive_payload(
          &mut ext,
          unpacked_archive_name(path),
          &data,
          "zip".to_string(),
          SOURCE_KIND_UNPACKED.to_string(),
          explicit_name_provided,
        )?;
      }
    } else {
      if link {
        return Err(err_code("EXTENSION_LINK_REQUIRES_DIRECTORY"));
      }
      let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"))?;
      let file_type =
        get_file_type(&file_name).ok_or_else(|| err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"))?;
      let data = fs::read(path)?;
      self.apply_archive_payload(
        &mut ext,
        file_name,
        &data,
        file_type,
        SOURCE_KIND_ARCHIVE.to_string(),
        explicit_name_provided,
      )?;
    }

    self.finish_update(ext)
  }

  /// Returns whether the caller named the extension explicitly, which decides
  /// if a manifest name may overwrite it.
  fn apply_name(
    ext: &mut Extension,
    name: Option<String>,
  ) -> Result<bool, Box<dyn std::error::Error>> {
    match name {
      Some(new_name) => {
        if new_name.trim().is_empty() {
          return Err(err_code("NAME_CANNOT_BE_EMPTY"));
        }
        ext.name = new_name;
        Ok(true)
      }
      None => Ok(false),
    }
  }

  fn apply_archive_payload(
    &self,
    ext: &mut Extension,
    file_name: String,
    data: &[u8],
    file_type: String,
    source_kind: String,
    explicit_name_provided: bool,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let browser_compatibility = determine_browser_compatibility(&file_type);
    if browser_compatibility.is_empty() || !is_plain_path_part(&file_name) {
      return Err(err_code("EXTENSION_UNSUPPORTED_FILE_TYPE"));
    }

    let file_dir = self.get_file_dir(&ext.id);
    if file_dir.exists() {
      fs::remove_dir_all(&file_dir)?;
    }
    fs::create_dir_all(&file_dir)?;
    fs::write(file_dir.join(&file_name), data)?;

    ext.file_name = file_name;
    ext.file_type = file_type;
    ext.browser_compatibility = browser_compatibility;
    ext.source_kind = source_kind;
    // Replacing the payload with stored bytes ends any link.
    ext.linked_path = None;

    let (manifest_name, version, description, author, homepage_url) =
      extract_manifest_metadata(data, &ext.file_type);
    Self::apply_manifest_metadata(
      ext,
      manifest_name,
      version,
      description,
      author,
      homepage_url,
      explicit_name_provided,
    );

    if let Some((icon_data, icon_ext)) = extract_icon_from_archive(data, &ext.file_type) {
      self.write_icon(&ext.id, &icon_data, &icon_ext);
    }

    Ok(())
  }

  fn apply_linked_payload(
    &self,
    ext: &mut Extension,
    dir: &Path,
    manifest: &serde_json::Value,
    explicit_name_provided: bool,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let absolute = dunce::canonicalize(dir)?;
    if !path_is_load_extension_safe(&absolute) {
      return Err(err_code("EXTENSION_PATH_HAS_COMMA"));
    }

    // A linked extension keeps no payload in the store.
    let file_dir = self.get_file_dir(&ext.id);
    if file_dir.exists() {
      fs::remove_dir_all(&file_dir)?;
    }

    ext.file_name = absolute
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_default();
    ext.file_type = "unpacked".to_string();
    ext.browser_compatibility = determine_browser_compatibility(&ext.file_type);
    ext.source_kind = SOURCE_KIND_UNPACKED.to_string();
    ext.linked_path = Some(absolute.to_string_lossy().to_string());
    // The path only exists on this machine, so there is nothing to sync.
    ext.sync_enabled = false;

    let (manifest_name, version, description, author, homepage_url) =
      manifest_metadata(manifest, &ManifestSource::Dir(&absolute));
    Self::apply_manifest_metadata(
      ext,
      manifest_name,
      version,
      description,
      author,
      homepage_url,
      explicit_name_provided,
    );

    if let Some((icon_data, icon_ext)) = extract_icon_from_dir(&absolute, manifest) {
      self.write_icon(&ext.id, &icon_data, &icon_ext);
    }

    Ok(())
  }

  #[allow(clippy::too_many_arguments)]
  fn apply_manifest_metadata(
    ext: &mut Extension,
    manifest_name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    author: Option<String>,
    homepage_url: Option<String>,
    explicit_name_provided: bool,
  ) {
    if let Some(v) = version {
      ext.version = Some(v);
    }
    if let Some(d) = description {
      ext.description = Some(d);
    }
    if let Some(a) = author {
      ext.author = Some(a);
    }
    if let Some(h) = homepage_url {
      ext.homepage_url = Some(h);
    }
    ext.manifest_name = manifest_name.clone();
    if let Some(mn) = manifest_name {
      if !explicit_name_provided && !mn.trim().is_empty() {
        ext.name = mn;
      }
    }
  }

  fn finish_update(&self, mut ext: Extension) -> Result<Extension, Box<dyn std::error::Error>> {
    ext.updated_at = now_secs();

    let metadata_path = self.get_metadata_path(&ext.id);
    let json = serde_json::to_string_pretty(&ext)?;
    fs::write(metadata_path, json)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if ext.sync_enabled {
      crate::team_activity::record("extension.update", &ext.id, Some(&ext.name), None);
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        let eid = ext.id.clone();
        tauri::async_runtime::spawn(async move {
          scheduler.queue_extension_sync(eid).await;
        });
      }
    }

    Ok(ext)
  }

  pub fn delete_extension(
    &self,
    app_handle: &tauri::AppHandle,
    id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let ext = self.get_extension(id)?;
    let ext_dir = self.get_extension_dir(id);
    if ext_dir.exists() {
      fs::remove_dir_all(&ext_dir)?;
    }
    self.cleanup_staged_copies(id);

    // Remove from all groups
    let mut groups_data = self.load_groups_data()?;
    for group in &mut groups_data.groups {
      group.extension_ids.retain(|eid| eid != id);
    }
    self.save_groups_data(&groups_data)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if ext.sync_enabled {
      crate::team_activity::record("extension.delete", &ext.id, Some(&ext.name), None);
      let ext_id = id.to_string();
      let app_handle_clone = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        match crate::sync::SyncEngine::create_from_settings(&app_handle_clone).await {
          Ok(engine) => {
            if let Err(e) = engine.delete_extension(&ext_id).await {
              log::warn!("Remote extension delete failed extension={ext_id} err=\"{e}\"");
            }
          }
          Err(e) => {
            log::debug!(
              "Remote extension delete skipped: sync not configured extension={ext_id} err=\"{e}\""
            );
          }
        }
      });
    }

    Ok(())
  }

  // Extension Group CRUD

  fn load_groups_data(&self) -> Result<ExtensionGroupsData, Box<dyn std::error::Error>> {
    let path = extension_groups_file();
    if !path.exists() {
      return Ok(ExtensionGroupsData { groups: Vec::new() });
    }
    let content = fs::read_to_string(path)?;
    let data: ExtensionGroupsData = serde_json::from_str(&content)?;
    Ok(data)
  }

  fn save_groups_data(&self, data: &ExtensionGroupsData) -> Result<(), Box<dyn std::error::Error>> {
    let path = extension_groups_file();
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(data)?;
    fs::write(path, json)?;
    Ok(())
  }

  pub fn create_group(&self, name: String) -> Result<ExtensionGroup, Box<dyn std::error::Error>> {
    if name.trim().is_empty() {
      return Err(
        serde_json::json!({ "code": "NAME_CANNOT_BE_EMPTY" })
          .to_string()
          .into(),
      );
    }

    let mut data = self.load_groups_data()?;

    if data.groups.iter().any(|g| g.name == name) {
      return Err(format!("Extension group with name '{name}' already exists").into());
    }

    let now = now_secs();
    let group = ExtensionGroup {
      id: uuid::Uuid::new_v4().to_string(),
      name,
      extension_ids: Vec::new(),
      created_at: now,
      updated_at: now,
      sync_enabled: crate::sync::is_sync_configured(),
      last_sync: None,
    };

    data.groups.push(group.clone());
    self.save_groups_data(&data)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if group.sync_enabled {
      crate::team_activity::record("extension.group_create", &group.id, Some(&group.name), None);
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        let id = group.id.clone();
        tauri::async_runtime::spawn(async move {
          scheduler.queue_extension_group_sync(id).await;
        });
      }
    }

    Ok(group)
  }

  pub fn get_group(&self, id: &str) -> Result<ExtensionGroup, Box<dyn std::error::Error>> {
    let data = self.load_groups_data()?;
    data
      .groups
      .into_iter()
      .find(|g| g.id == id)
      .ok_or_else(|| format!("Extension group with id '{id}' not found").into())
  }

  pub fn list_groups(&self) -> Result<Vec<ExtensionGroup>, Box<dyn std::error::Error>> {
    let data = self.load_groups_data()?;
    Ok(data.groups)
  }

  pub fn update_group(
    &self,
    id: &str,
    name: Option<String>,
    extension_ids: Option<Vec<String>>,
  ) -> Result<ExtensionGroup, Box<dyn std::error::Error>> {
    if name.as_deref().is_some_and(|n| n.trim().is_empty()) {
      return Err(
        serde_json::json!({ "code": "NAME_CANNOT_BE_EMPTY" })
          .to_string()
          .into(),
      );
    }

    let mut data = self.load_groups_data()?;

    if let Some(ref new_name) = name {
      if data
        .groups
        .iter()
        .any(|g| g.name == *new_name && g.id != id)
      {
        return Err(format!("Extension group with name '{new_name}' already exists").into());
      }
    }

    let group = data
      .groups
      .iter_mut()
      .find(|g| g.id == id)
      .ok_or_else(|| format!("Extension group with id '{id}' not found"))?;

    if let Some(new_name) = name {
      group.name = new_name;
    }
    if let Some(new_ids) = extension_ids {
      group.extension_ids = new_ids;
    }
    group.updated_at = now_secs();

    let updated = group.clone();
    self.save_groups_data(&data)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if updated.sync_enabled {
      crate::team_activity::record(
        "extension.group_update",
        &updated.id,
        Some(&updated.name),
        None,
      );
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        let gid = updated.id.clone();
        tauri::async_runtime::spawn(async move {
          scheduler.queue_extension_group_sync(gid).await;
        });
      }
    }

    Ok(updated)
  }

  pub fn delete_group(
    &self,
    app_handle: &tauri::AppHandle,
    id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let mut data = self.load_groups_data()?;

    let was_sync_enabled = data
      .groups
      .iter()
      .find(|g| g.id == id)
      .map(|g| g.sync_enabled)
      .unwrap_or(false);

    let initial_len = data.groups.len();
    data.groups.retain(|g| g.id != id);
    if data.groups.len() == initial_len {
      return Err(format!("Extension group with id '{id}' not found").into());
    }
    self.save_groups_data(&data)?;

    // Clear extension_group_id from profiles that used this group
    let profile_manager = crate::profile::ProfileManager::instance();
    if let Ok(profiles) = profile_manager.list_profiles() {
      for mut p in profiles {
        if p.extension_group_id.as_deref() == Some(id) {
          p.extension_group_id = None;
          let _ = profile_manager.save_profile(&p);
        }
      }
    }

    if was_sync_enabled {
      crate::team_activity::record("extension.group_delete", id, None, None);
      let group_id_owned = id.to_string();
      let app_handle_clone = app_handle.clone();
      tauri::async_runtime::spawn(async move {
        match crate::sync::SyncEngine::create_from_settings(&app_handle_clone).await {
          Ok(engine) => {
            if let Err(e) = engine.delete_extension_group(&group_id_owned).await {
              log::warn!(
                "Remote extension group delete failed extension_group={group_id_owned} err=\"{e}\""
              );
            }
          }
          Err(e) => {
            log::debug!(
              "Remote extension group delete skipped: sync not configured extension_group={group_id_owned} err=\"{e}\""
            );
          }
        }
      });
    }

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    Ok(())
  }

  pub fn add_extension_to_group(
    &self,
    group_id: &str,
    extension_id: &str,
  ) -> Result<ExtensionGroup, Box<dyn std::error::Error>> {
    // Verify extension exists
    let _ = self.get_extension(extension_id)?;

    let mut data = self.load_groups_data()?;
    let group = data
      .groups
      .iter_mut()
      .find(|g| g.id == group_id)
      .ok_or_else(|| format!("Extension group with id '{group_id}' not found"))?;

    if !group.extension_ids.contains(&extension_id.to_string()) {
      group.extension_ids.push(extension_id.to_string());
      group.updated_at = now_secs();
    }

    let updated = group.clone();
    self.save_groups_data(&data)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if updated.sync_enabled {
      crate::team_activity::record(
        "extension.group_update",
        &updated.id,
        Some(&updated.name),
        crate::team_activity::fields(&["extensions"]),
      );
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        let gid = updated.id.clone();
        tauri::async_runtime::spawn(async move {
          scheduler.queue_extension_group_sync(gid).await;
        });
      }
    }

    Ok(updated)
  }

  pub fn remove_extension_from_group(
    &self,
    group_id: &str,
    extension_id: &str,
  ) -> Result<ExtensionGroup, Box<dyn std::error::Error>> {
    let mut data = self.load_groups_data()?;
    let group = data
      .groups
      .iter_mut()
      .find(|g| g.id == group_id)
      .ok_or_else(|| format!("Extension group with id '{group_id}' not found"))?;

    group.extension_ids.retain(|eid| eid != extension_id);
    group.updated_at = now_secs();

    let updated = group.clone();
    self.save_groups_data(&data)?;

    if let Err(e) = events::emit_empty("extensions-changed") {
      log::warn!("Event emit failed event=extensions-changed err=\"{e}\"");
    }

    if updated.sync_enabled {
      crate::team_activity::record(
        "extension.group_update",
        &updated.id,
        Some(&updated.name),
        crate::team_activity::fields(&["extensions"]),
      );
      if let Some(scheduler) = crate::sync::get_global_scheduler() {
        let gid = updated.id.clone();
        tauri::async_runtime::spawn(async move {
          scheduler.queue_extension_group_sync(gid).await;
        });
      }
    }

    Ok(updated)
  }

  // Sync helpers

  pub fn update_extension_internal(
    &self,
    ext: &Extension,
  ) -> Result<(), Box<dyn std::error::Error>> {
    if !is_plain_path_part(&ext.id) || !is_plain_path_part(&ext.file_name) {
      return Err(format!("Extension '{}' has an unsafe id or file name", ext.id).into());
    }
    let metadata_path = self.get_metadata_path(&ext.id);
    if let Some(parent) = metadata_path.parent() {
      fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(ext)?;
    fs::write(metadata_path, json)?;
    Ok(())
  }

  pub fn upsert_extension_internal(
    &self,
    ext: &Extension,
  ) -> Result<(), Box<dyn std::error::Error>> {
    self.update_extension_internal(ext)
  }

  pub fn delete_extension_internal(&self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    if !is_plain_path_part(id) {
      return Err(format!("Extension with id '{id}' not found").into());
    }
    let ext_dir = self.get_extension_dir(id);
    if ext_dir.exists() {
      fs::remove_dir_all(&ext_dir)?;
    }
    self.cleanup_staged_copies(id);
    // Remove from all groups
    let mut groups_data = self.load_groups_data()?;
    for group in &mut groups_data.groups {
      group.extension_ids.retain(|eid| eid != id);
    }
    self.save_groups_data(&groups_data)?;
    Ok(())
  }

  pub fn update_group_internal(
    &self,
    group: &ExtensionGroup,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let mut data = self.load_groups_data()?;
    if let Some(existing) = data.groups.iter_mut().find(|g| g.id == group.id) {
      existing.name = group.name.clone();
      existing.extension_ids = group.extension_ids.clone();
      existing.sync_enabled = group.sync_enabled;
      existing.last_sync = group.last_sync;
      existing.updated_at = group.updated_at;
      self.save_groups_data(&data)?;
    }
    Ok(())
  }

  pub fn upsert_group_internal(
    &self,
    group: &ExtensionGroup,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let mut data = self.load_groups_data()?;
    if let Some(existing) = data.groups.iter_mut().find(|g| g.id == group.id) {
      existing.name = group.name.clone();
      existing.extension_ids = group.extension_ids.clone();
      existing.sync_enabled = group.sync_enabled;
      existing.last_sync = group.last_sync;
      existing.updated_at = group.updated_at;
    } else {
      data.groups.push(group.clone());
    }
    self.save_groups_data(&data)?;
    Ok(())
  }

  pub fn delete_group_internal(&self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut data = self.load_groups_data()?;
    data.groups.retain(|g| g.id != id);
    self.save_groups_data(&data)?;
    Ok(())
  }

  /// Move an extension out of the store for the trash: its folder (metadata,
  /// payload, icon) goes to `into`, and it leaves every group. Returns it with
  /// the groups it was in, so a restore can put it back in them.
  pub fn take_for_trash(
    &self,
    id: &str,
    into: &Path,
  ) -> Result<(Extension, Vec<String>), Box<dyn std::error::Error>> {
    let ext = self
      .get_extension(id)
      .map_err(|_| err_code("EXTENSION_NOT_FOUND"))?;
    let mut data = self.load_groups_data()?;
    let groups: Vec<String> = data
      .groups
      .iter()
      .filter(|group| group.extension_ids.iter().any(|eid| eid == id))
      .map(|group| group.id.clone())
      .collect();
    self.cleanup_staged_copies(id);
    let ext_dir = self.get_extension_dir(id);
    crate::profile::trash::move_dir(&ext_dir, into)?;
    if !groups.is_empty() {
      for group in &mut data.groups {
        group.extension_ids.retain(|eid| eid != id);
      }
      if let Err(e) = self.save_groups_data(&data) {
        if let Err(back) = crate::profile::trash::move_dir(into, &ext_dir) {
          log::error!("Extension folder not put back extension={id} err=\"{back}\"");
        }
        return Err(e);
      }
    }
    Ok((ext, groups))
  }

  /// Put back an extension the trash kept in `from`, saved as `ext`, and add
  /// it again to those of `groups` that still exist. Returns the groups it
  /// rejoined, their edit time set to `now`.
  pub fn restore_from_trash(
    &self,
    ext: &Extension,
    from: &Path,
    groups: &[String],
    now: u64,
  ) -> Result<Vec<ExtensionGroup>, Box<dyn std::error::Error>> {
    if !is_plain_path_part(&ext.id) {
      return Err(err_code("EXTENSION_NOT_FOUND"));
    }
    let ext_dir = self.get_extension_dir(&ext.id);
    if ext_dir.exists() {
      // A registered extension would have been refused by the caller, so
      // this folder holds no metadata and is leftover garbage.
      log::warn!("Removing stale folder before restore extension={}", ext.id);
      fs::remove_dir_all(&ext_dir)?;
    }
    if from.is_dir() {
      crate::profile::trash::move_dir(from, &ext_dir)?;
    }
    self.update_extension_internal(ext)?;

    let mut data = self.load_groups_data()?;
    let mut rejoined = Vec::new();
    for group in data
      .groups
      .iter_mut()
      .filter(|group| groups.contains(&group.id))
    {
      if !group.extension_ids.contains(&ext.id) {
        group.extension_ids.push(ext.id.clone());
        group.updated_at = now;
        rejoined.push(group.clone());
      }
    }
    if !rejoined.is_empty() {
      self.save_groups_data(&data)?;
    }
    Ok(rejoined)
  }

  // Compatibility validation

  pub fn validate_group_compatibility(
    &self,
    group_id: &str,
    browser: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let group = self.get_group(group_id)?;
    let browser_type = match browser {
      "wayfern" => "chromium",
      _ => return Err(format!("Extensions are not supported for browser '{browser}'").into()),
    };

    for ext_id in &group.extension_ids {
      let ext = self.get_extension(ext_id)?;
      if !ext
        .browser_compatibility
        .contains(&browser_type.to_string())
      {
        return Err(
          format!(
            "Extension '{}' ({}) is not compatible with {} browsers",
            ext.name, ext.file_type, browser_type
          )
          .into(),
        );
      }
    }

    Ok(())
  }

  // Launch-time installation

  pub fn install_extensions_for_profile(
    &self,
    profile: &crate::profile::BrowserProfile,
    _profile_data_path: &std::path::Path,
  ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let group_id = match &profile.extension_group_id {
      Some(id) => id,
      None => return Ok(Vec::new()),
    };

    let group = self.get_group(group_id)?;
    if group.extension_ids.is_empty() {
      return Ok(Vec::new());
    }

    if profile.browser.as_str() != "wayfern" {
      return Ok(Vec::new());
    }

    let mut extension_paths = Vec::new();

    // Staging is per-profile. Chromium records the absolute staging path and
    // reads the extension's files lazily for the life of the process, so a
    // shared directory would let one profile's launch pull the files out from
    // under every browser already running.
    let unpacked_base = Self::unpacked_dir_for_profile(&profile.id.to_string());
    if unpacked_base.exists() {
      fs::remove_dir_all(&unpacked_base)?;
    }
    fs::create_dir_all(&unpacked_base)?;

    for ext_id in &group.extension_ids {
      if let Ok(ext) = self.get_extension(ext_id) {
        if !ext.browser_compatibility.contains(&"chromium".to_string()) {
          continue;
        }

        // A linked extension is loaded from where the user keeps it, so there
        // is nothing to stage.
        if let Some(linked) = &ext.linked_path {
          let linked_path = PathBuf::from(linked);
          if !linked_path.join("manifest.json").exists() {
            log::warn!(
              "Linked extension skipped: folder has no manifest.json extension={} path=\"{linked}\"",
              ext.id
            );
            continue;
          }
          if !path_is_load_extension_safe(&linked_path) {
            log::warn!(
              "Linked extension skipped: path has a comma --load-extension cannot express extension={}",
              ext.id
            );
            continue;
          }
          extension_paths.push(linked.clone());
          continue;
        }

        let src_file = self.get_file_dir(ext_id).join(&ext.file_name);
        if src_file.exists() {
          let unpack_dir = unpacked_base.join(ext_id);
          // The archive is unpacked once per version; a launch links the
          // files into its own staging folder. When the kept copy cannot be
          // used (on Windows a running browser can hold its old files), the
          // launch unpacks into its staging folder as before.
          let staged = Self::unpacked_tree(ext_id, &src_file)
            .and_then(|tree| stage_tree(&tree, &unpack_dir).map_err(Into::into))
            .or_else(|e| {
              log::debug!(
                "Unpacked extension copy unusable, unpacking for this launch extension={} err=\"{e}\"",
                ext.id
              );
              let _ = fs::remove_dir_all(&unpack_dir);
              fs::create_dir_all(&unpack_dir)?;
              Self::unpack_extension(&src_file, &unpack_dir)
            });
          match staged {
            Ok(()) => {
              give_portable_id(
                &unpack_dir,
                &profile.id.to_string(),
                ext_id,
                _profile_data_path,
              );
              extension_paths.push(unpack_dir.to_string_lossy().to_string());
            }
            Err(e) => {
              let _ = fs::remove_dir_all(&unpack_dir);
              log::warn!("Extension unpack failed extension={} err=\"{e}\"", ext.id);
            }
          }
        }
      }
    }

    Ok(extension_paths)
  }

  fn unpacked_dir_for_profile(profile_id: &str) -> PathBuf {
    extensions_base_dir().join("unpacked").join(profile_id)
  }

  /// Drop a profile's staged extension copies once its browser has exited.
  /// Nothing reads them after that, and they are plaintext extension code left
  /// on disk.
  pub fn cleanup_unpacked_for_profile(profile_id: &str) {
    let dir = Self::unpacked_dir_for_profile(profile_id);
    if dir.exists() {
      if let Err(e) = fs::remove_dir_all(&dir) {
        log::warn!("Staged extension cleanup failed profile={profile_id} err=\"{e}\"");
      }
    }
  }

  /// Drop every profile's staged copy of one extension, so deleting it does not
  /// leave its code behind until some later launch happens to wipe the folder.
  fn cleanup_staged_copies(&self, ext_id: &str) {
    let cache = unpacked_cache_dir(ext_id);
    if is_plain_path_part(ext_id) && cache.exists() {
      let _ = fs::remove_dir_all(&cache);
    }
    let base = extensions_base_dir().join("unpacked");
    let Ok(entries) = fs::read_dir(&base) else {
      return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
      let staged = entry.path().join(ext_id);
      if staged.exists() {
        let _ = fs::remove_dir_all(&staged);
      }
    }
  }

  /// The unpacked files of `src`, the stored archive of `ext_id`. They are
  /// unpacked again only when the archive changed since the last unpack.
  fn unpacked_tree(ext_id: &str, src: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cache = unpacked_cache_dir(ext_id);
    let tree = cache.join("tree");
    let source_path = cache.join("source");
    let stamp = file_stamp(src);
    if let Some(stamp) = &stamp {
      if tree.is_dir() && fs::read_to_string(&source_path).ok().as_ref() == Some(stamp) {
        return Ok(tree);
      }
    }
    // Staged copies of running browsers keep their own links to the old
    // files, so the old tree can go.
    if cache.exists() {
      fs::remove_dir_all(&cache)?;
    }
    let partial = cache.join("tree.partial");
    fs::create_dir_all(&partial)?;
    if let Err(e) = Self::unpack_extension(src, &partial) {
      let _ = fs::remove_dir_all(&cache);
      return Err(e);
    }
    fs::rename(&partial, &tree)?;
    // Written last, so a tree that was not finished never counts as current.
    if let Some(stamp) = stamp {
      fs::write(&source_path, stamp)?;
    }
    Ok(tree)
  }

  fn unpack_extension(
    src: &std::path::Path,
    dest: &std::path::Path,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let data = fs::read(src)?;
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(data.as_slice())) {
      Ok(a) => a,
      Err(e) => {
        // CRX files have a header before the ZIP data — try skipping the CRX header
        if let Some(zip_start) = Self::find_zip_start(&data) {
          zip::ZipArchive::new(std::io::Cursor::new(&data[zip_start..]))
            .map_err(|e2| format!("Failed to open CRX as zip after header skip: {e2}"))?
        } else {
          return Err(format!("Failed to open as zip: {e}").into());
        }
      }
    };
    for i in 0..archive.len() {
      let mut file = archive.by_index(i)?;
      let out_path = dest.join(file.mangled_name()?);

      if file.is_dir() {
        fs::create_dir_all(&out_path)?;
      } else {
        if let Some(parent) = out_path.parent() {
          fs::create_dir_all(parent)?;
        }
        let mut out_file = fs::File::create(&out_path)?;
        std::io::copy(&mut file, &mut out_file)?;
      }
    }

    Ok(())
  }

  fn find_zip_start(data: &[u8]) -> Option<usize> {
    // ZIP local file header magic: PK\x03\x04
    let magic = [0x50, 0x4B, 0x03, 0x04];
    data.windows(4).position(|window| window == magic)
  }

  /// Backfill icons and manifest metadata for extensions stored before either
  /// existed, and repair records holding an unresolved `__MSG_key__`
  /// placeholder where a name or description should be.
  ///
  /// It runs at every start, so an extension whose archive (or linked
  /// manifest) was already read in full is skipped: its stamp in
  /// `.backfill-stamp` still matches and its record holds no placeholder.
  pub fn ensure_icons_extracted(&self) {
    let extensions = match self.list_extensions() {
      Ok(exts) => exts,
      Err(_) => return,
    };

    for ext in extensions {
      let source = match &ext.linked_path {
        Some(linked) => PathBuf::from(linked).join("manifest.json"),
        None => self.get_file_dir(&ext.id).join(&ext.file_name),
      };
      let stamp = file_stamp(&source).map(|stamp| format!("{BACKFILL_VERSION}:{stamp}"));
      let stamp_path = self.get_extension_dir(&ext.id).join(BACKFILL_STAMP_FILE);
      let holds_placeholder = is_message_placeholder(&ext.name)
        || ext
          .description
          .as_deref()
          .is_some_and(is_message_placeholder);
      if stamp.is_some() && !holds_placeholder && fs::read_to_string(&stamp_path).ok() == stamp {
        continue;
      }
      if self.backfill_extension(&ext) {
        if let Some(stamp) = stamp {
          let _ = fs::write(&stamp_path, stamp);
        }
      }
    }
  }

  /// Read one extension's icon and metadata from its source. Returns whether
  /// everything it found was saved.
  fn backfill_extension(&self, ext: &Extension) -> bool {
    let has_icon = self
      .get_extension_dir(&ext.id)
      .read_dir()
      .map(|entries| {
        entries
          .filter_map(|e| e.ok())
          .any(|e| e.file_name().to_string_lossy().starts_with("icon."))
      })
      .unwrap_or(false);

    // A linked extension has no stored payload; everything comes from the
    // folder it is loaded from, which may since have moved.
    if let Some(linked) = &ext.linked_path {
      let linked_dir = PathBuf::from(linked);
      let Some(manifest) = read_manifest_from_dir(&linked_dir) else {
        return false;
      };
      let mut saved = true;
      if !has_icon {
        if let Some((icon_data, icon_ext)) = extract_icon_from_dir(&linked_dir, &manifest) {
          saved = self.write_icon(&ext.id, &icon_data, &icon_ext);
        }
      }
      let metadata = manifest_metadata(&manifest, &ManifestSource::Dir(&linked_dir));
      return self.backfill_metadata(ext, metadata) && saved;
    }

    let file_path = self.get_file_dir(&ext.id).join(&ext.file_name);
    let Ok(file_data) = fs::read(&file_path) else {
      return false;
    };

    let mut saved = true;
    if !has_icon {
      if let Some((icon_data, icon_ext)) = extract_icon_from_archive(&file_data, &ext.file_type) {
        saved = self.write_icon(&ext.id, &icon_data, &icon_ext);
      }
    }

    let metadata = extract_manifest_metadata(&file_data, &ext.file_type);
    self.backfill_metadata(ext, metadata) && saved
  }

  /// Fill in metadata the stored record is missing, and replace any value that
  /// is still a raw localization placeholder. Values the user can see are
  /// otherwise left alone, so a rename is never undone. Returns whether the
  /// record is saved: false only when a needed write failed.
  fn backfill_metadata(&self, ext: &Extension, metadata: ManifestMetadata) -> bool {
    fn needs(current: &Option<String>) -> bool {
      current.as_deref().is_none_or(is_message_placeholder)
    }

    let (manifest_name, version, description, author, homepage_url) = metadata;
    let mut updated = ext.clone();
    let mut changed = updated.manifest_name != manifest_name;
    updated.manifest_name = manifest_name.clone();

    // The name is user-editable, so it is only touched when what is stored is
    // an unresolved placeholder.
    if let Some(n) = manifest_name {
      if is_message_placeholder(&ext.name) && !n.trim().is_empty() {
        updated.name = n;
        changed = true;
      }
    }
    if let Some(v) = version {
      if needs(&ext.version) {
        updated.version = Some(v);
        changed = true;
      }
    }
    if let Some(d) = description {
      if needs(&ext.description) {
        updated.description = Some(d);
        changed = true;
      }
    }
    if let Some(a) = author {
      if needs(&ext.author) {
        updated.author = Some(a);
        changed = true;
      }
    }
    if let Some(h) = homepage_url {
      if needs(&ext.homepage_url) {
        updated.homepage_url = Some(h);
        changed = true;
      }
    }

    // A stored placeholder with no resolvable message is worse than nothing.
    if updated
      .description
      .as_deref()
      .is_some_and(is_message_placeholder)
    {
      updated.description = None;
      changed = true;
    }

    if !changed {
      return true;
    }
    let metadata_path = self.get_metadata_path(&ext.id);
    serde_json::to_string_pretty(&updated)
      .ok()
      .is_some_and(|json| fs::write(metadata_path, json).is_ok())
  }

  pub fn get_extension_icon(&self, ext_id: &str) -> Option<String> {
    let ext_dir = self.get_extension_dir(ext_id);
    let entries = ext_dir.read_dir().ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
      let name = entry.file_name().to_string_lossy().to_string();
      if name.starts_with("icon.") {
        let icon_path = entry.path();
        let data = fs::read(&icon_path).ok()?;
        let ext = name.rsplit('.').next().unwrap_or("png");
        let mime = match ext {
          "png" => "image/png",
          "jpg" | "jpeg" => "image/jpeg",
          "svg" => "image/svg+xml",
          "gif" => "image/gif",
          "webp" => "image/webp",
          _ => "image/png",
        };
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        return Some(format!("data:{};base64,{}", mime, b64));
      }
    }
    None
  }
}

// Global instance
pub static EXTENSION_MANAGER: std::sync::LazyLock<Mutex<ExtensionManager>> =
  std::sync::LazyLock::new(|| Mutex::new(ExtensionManager::new()));

// Tauri commands

#[tauri::command]
pub async fn list_extensions() -> Result<Vec<Extension>, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .list_extensions()
    .map_err(|e| format!("Failed to list extensions: {e}"))
}

#[tauri::command]
pub fn get_extension_icon(extension_id: String) -> Option<String> {
  let manager = crate::extension_manager::ExtensionManager::new();
  manager.get_extension_icon(&extension_id)
}

#[tauri::command]
pub async fn add_extension(
  name: String,
  file_name: String,
  file_data: Vec<u8>,
) -> Result<Extension, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .add_extension(name, file_name, file_data)
    .map_err(|e| crate::wrap_backend_error(e, "Failed to add extension"))
}

/// Import a folder holding a top-level `manifest.json`. `link` loads it in
/// place instead of copying it into the store.
#[tauri::command]
pub async fn add_unpacked_extension(
  name: String,
  path: String,
  link: Option<bool>,
) -> Result<Extension, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .add_unpacked_extension(name, Path::new(&path), link.unwrap_or(false))
    .map_err(|e| crate::wrap_backend_error(e, "Failed to add unpacked extension"))
}

#[tauri::command]
pub async fn update_extension(
  extension_id: String,
  name: Option<String>,
  file_name: Option<String>,
  file_data: Option<Vec<u8>>,
) -> Result<Extension, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .update_extension(&extension_id, name, file_name, file_data)
    .map_err(|e| crate::wrap_backend_error(e, "Failed to update extension"))
}

/// Replace an extension's payload from a local archive or folder.
#[tauri::command]
pub async fn update_extension_from_path(
  extension_id: String,
  name: Option<String>,
  path: String,
  link: Option<bool>,
) -> Result<Extension, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .update_extension_from_path(&extension_id, name, Path::new(&path), link.unwrap_or(false))
    .map_err(|e| crate::wrap_backend_error(e, "Failed to update extension"))
}

#[tauri::command]
pub async fn delete_extension(
  app_handle: tauri::AppHandle,
  extension_id: String,
) -> Result<(), String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .delete_extension(&app_handle, &extension_id)
    .map_err(|e| format!("Failed to delete extension: {e}"))
}

#[tauri::command]
pub async fn list_extension_groups() -> Result<Vec<ExtensionGroup>, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .list_groups()
    .map_err(|e| format!("Failed to list extension groups: {e}"))
}

#[tauri::command]
pub async fn create_extension_group(name: String) -> Result<ExtensionGroup, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .create_group(name)
    .map_err(|e| crate::wrap_backend_error(e, "Failed to create extension group"))
}

#[tauri::command]
pub async fn update_extension_group(
  group_id: String,
  name: Option<String>,
  extension_ids: Option<Vec<String>>,
) -> Result<ExtensionGroup, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .update_group(&group_id, name, extension_ids)
    .map_err(|e| crate::wrap_backend_error(e, "Failed to update extension group"))
}

#[tauri::command]
pub async fn delete_extension_group(
  app_handle: tauri::AppHandle,
  group_id: String,
) -> Result<(), String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .delete_group(&app_handle, &group_id)
    .map_err(|e| format!("Failed to delete extension group: {e}"))
}

#[tauri::command]
pub async fn add_extension_to_group(
  group_id: String,
  extension_id: String,
) -> Result<ExtensionGroup, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .add_extension_to_group(&group_id, &extension_id)
    .map_err(|e| format!("Failed to add extension to group: {e}"))
}

#[tauri::command]
pub async fn remove_extension_from_group(
  group_id: String,
  extension_id: String,
) -> Result<ExtensionGroup, String> {
  let mgr = EXTENSION_MANAGER.lock().unwrap();
  mgr
    .remove_extension_from_group(&group_id, &extension_id)
    .map_err(|e| format!("Failed to remove extension from group: {e}"))
}

#[tauri::command]
pub async fn assign_extension_group_to_profile(
  profile_id: String,
  extension_group_id: Option<String>,
) -> Result<crate::profile::BrowserProfile, String> {
  // Validate compatibility if assigning a group
  if let Some(ref group_id) = extension_group_id {
    let profile_manager = crate::profile::ProfileManager::instance();
    let profiles = profile_manager
      .list_profiles()
      .map_err(|e| format!("Failed to list profiles: {e}"))?;
    let profile = profiles
      .iter()
      .find(|p| p.id.to_string() == profile_id)
      .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    let mgr = EXTENSION_MANAGER.lock().unwrap();
    mgr
      .validate_group_compatibility(group_id, &profile.browser)
      .map_err(|e| format!("{e}"))?;
  }

  let profile_manager = crate::profile::ProfileManager::instance();
  profile_manager
    .update_profile_extension_group(&profile_id, extension_group_id)
    .map_err(|e| format!("Failed to assign extension group: {e}"))
}

#[tauri::command]
pub async fn get_extension_group_for_profile(
  profile_id: String,
) -> Result<Option<ExtensionGroup>, String> {
  let profile_manager = crate::profile::ProfileManager::instance();
  let profiles = profile_manager
    .list_profiles()
    .map_err(|e| format!("Failed to list profiles: {e}"))?;
  let profile = profiles
    .iter()
    .find(|p| p.id.to_string() == profile_id)
    .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

  match &profile.extension_group_id {
    Some(group_id) => {
      let mgr = EXTENSION_MANAGER.lock().unwrap();
      match mgr.get_group(group_id) {
        Ok(group) => Ok(Some(group)),
        Err(_) => Ok(None),
      }
    }
    None => Ok(None),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn extension_ids_follow_the_browser_derivation() {
    assert_eq!(
      extension_id_for_key(b"test"),
      "jpignaibiiemhngfjkcpokkamffknabf"
    );
    assert_eq!(
      extension_id_for_key(b"_"),
      "ncocknphbhhlhkikpnnlmbcnbgdempcd"
    );
  }

  fn staged_copy(root: &Path, name: &str, manifest: &str) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), manifest).unwrap();
    dir
  }

  fn manifest_key(dir: &Path) -> Option<String> {
    read_manifest_from_dir(dir)?
      .get("key")?
      .as_str()
      .map(str::to_string)
  }

  #[test]
  fn a_staged_copy_gets_one_key_per_profile_on_every_machine() {
    let machine_a = tempfile::tempdir().unwrap();
    let machine_b = tempfile::tempdir().unwrap();
    let manifest = r#"{"name":"x","version":"1","manifest_version":3}"#;
    let on_a = staged_copy(machine_a.path(), "staged", manifest);
    let on_b = staged_copy(machine_b.path(), "elsewhere/staged", manifest);
    let other_profile = staged_copy(machine_a.path(), "other", manifest);
    let data = tempfile::tempdir().unwrap();

    give_portable_id(&on_a, "profile-1", "ext-1", data.path());
    give_portable_id(&on_b, "profile-1", "ext-1", data.path());
    give_portable_id(&other_profile, "profile-2", "ext-1", data.path());

    let key = manifest_key(&on_a).expect("a key is written");
    assert_eq!(Some(key.clone()), manifest_key(&on_b));
    assert_ne!(Some(key), manifest_key(&other_profile));
  }

  #[test]
  fn a_manifest_key_and_recorded_extension_state_are_kept() {
    let root = tempfile::tempdir().unwrap();
    let keyed = staged_copy(
      root.path(),
      "keyed",
      r#"{"name":"x","version":"1","manifest_version":3,"key":"AAAA"}"#,
    );
    let data = tempfile::tempdir().unwrap();
    give_portable_id(&keyed, "profile-1", "ext-1", data.path());
    assert_eq!(manifest_key(&keyed).as_deref(), Some("AAAA"));

    let used = staged_copy(
      root.path(),
      "used",
      r#"{"name":"x","version":"1","manifest_version":3}"#,
    );
    fs::create_dir_all(data.path().join("Default")).unwrap();
    let prefs = serde_json::json!({
      "extensions": {"settings": {"abcdefghijklmnopabcdefghijklmnop": {
        "path": used.to_string_lossy(),
      }}}
    });
    fs::write(
      data.path().join("Default").join("Preferences"),
      prefs.to_string(),
    )
    .unwrap();
    give_portable_id(&used, "profile-1", "ext-2", data.path());
    assert_eq!(manifest_key(&used), None, "the recorded path id stays");
  }

  #[test]
  fn test_get_file_type() {
    assert_eq!(get_file_type("ext.crx"), Some("crx".to_string()));
    assert_eq!(get_file_type("ext.zip"), Some("zip".to_string()));
    assert_eq!(get_file_type("ublock.xpi"), None);
    assert_eq!(get_file_type("readme.txt"), None);
    assert_eq!(get_file_type("noext"), None);
  }

  #[test]
  fn test_determine_browser_compatibility() {
    assert_eq!(
      determine_browser_compatibility("crx"),
      vec!["chromium".to_string()]
    );
    assert_eq!(
      determine_browser_compatibility("zip"),
      vec!["chromium".to_string()]
    );
    assert_eq!(determine_browser_compatibility("xpi"), Vec::<String>::new());
  }

  #[test]
  fn test_extension_manager_crud() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();

    // List empty
    let exts = mgr.list_extensions().unwrap();
    assert!(exts.is_empty());

    // Add
    let ext = mgr
      .add_extension(
        "Test Ext".to_string(),
        "test.zip".to_string(),
        vec![0, 1, 2, 3],
      )
      .unwrap();
    assert_eq!(ext.name, "Test Ext");
    assert_eq!(ext.file_type, "zip");
    assert_eq!(ext.browser_compatibility, vec!["chromium".to_string()]);

    // Get
    let fetched = mgr.get_extension(&ext.id).unwrap();
    assert_eq!(fetched.name, "Test Ext");

    // List
    let exts = mgr.list_extensions().unwrap();
    assert_eq!(exts.len(), 1);

    // Update name
    let updated = mgr
      .update_extension(&ext.id, Some("Updated".to_string()), None, None)
      .unwrap();
    assert_eq!(updated.name, "Updated");

    // Delete
    mgr.delete_extension_internal(&ext.id).unwrap();
    let exts = mgr.list_extensions().unwrap();
    assert!(exts.is_empty());
  }

  #[test]
  fn test_extension_group_crud() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();

    // Create group
    let group = mgr.create_group("My Group".to_string()).unwrap();
    assert_eq!(group.name, "My Group");
    assert!(group.extension_ids.is_empty());

    // List groups
    let groups = mgr.list_groups().unwrap();
    assert_eq!(groups.len(), 1);

    // Add extension
    let ext = mgr
      .add_extension(
        "Test Ext".to_string(),
        "test.zip".to_string(),
        vec![0, 1, 2, 3],
      )
      .unwrap();

    // Add to group
    let updated = mgr.add_extension_to_group(&group.id, &ext.id).unwrap();
    assert_eq!(updated.extension_ids.len(), 1);

    // Remove from group
    let updated = mgr.remove_extension_from_group(&group.id, &ext.id).unwrap();
    assert!(updated.extension_ids.is_empty());

    // Duplicate name check
    let err = mgr.create_group("My Group".to_string());
    assert!(err.is_err());
  }

  #[test]
  fn test_validate_group_compatibility() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();

    let chrome_ext = mgr
      .add_extension(
        "Chromium Ext".to_string(),
        "test.crx".to_string(),
        vec![0, 1, 2, 3],
      )
      .unwrap();
    let chrome_group = mgr.create_group("Chromium Group".to_string()).unwrap();
    mgr
      .add_extension_to_group(&chrome_group.id, &chrome_ext.id)
      .unwrap();

    assert!(mgr
      .validate_group_compatibility(&chrome_group.id, "wayfern")
      .is_ok());
  }

  #[test]
  fn test_find_zip_start() {
    let data = vec![0x00, 0x00, 0x50, 0x4B, 0x03, 0x04, 0xFF];
    assert_eq!(ExtensionManager::find_zip_start(&data), Some(2));

    let data = vec![0x50, 0x4B, 0x03, 0x04, 0xFF];
    assert_eq!(ExtensionManager::find_zip_start(&data), Some(0));

    let data = vec![0x00, 0x00, 0x00];
    assert_eq!(ExtensionManager::find_zip_start(&data), None);
  }

  /// Write a loadable unpacked extension and return its directory.
  fn write_unpacked_fixture(dir: &Path, name: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    fs::write(
      dir.join("manifest.json"),
      serde_json::json!({
        "manifest_version": 3,
        "name": name,
        "version": "1.0.0",
        "background": { "service_worker": "background.js" }
      })
      .to_string(),
    )
    .unwrap();
    fs::write(dir.join("background.js"), "globalThis.__staged = true;\n").unwrap();
    dir.to_path_buf()
  }

  fn profile_with_group(name: &str, group_id: &str) -> crate::profile::BrowserProfile {
    crate::profile::BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: name.to_string(),
      browser: "wayfern".to_string(),
      version: "150.0.7871.100".to_string(),
      extension_group_id: Some(group_id.to_string()),
      ..Default::default()
    }
  }

  /// Staging is per profile. Chromium records the absolute staged path and
  /// reads those files lazily for the life of the process, so a directory
  /// shared between profiles meant launching one profile pulled the extension
  /// out from under every browser already running.
  #[test]
  fn test_install_extensions_stages_per_profile() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let source = write_unpacked_fixture(&tmp.path().join("source-extension"), "Staged Fixture");
    let ext = mgr
      .add_unpacked_extension("Ignored".to_string(), &source, false)
      .unwrap();
    assert_eq!(ext.name, "Staged Fixture");
    assert_eq!(ext.source_kind, SOURCE_KIND_UNPACKED);
    assert!(ext.linked_path.is_none());

    let group = mgr.create_group("Staged Group".to_string()).unwrap();
    mgr.add_extension_to_group(&group.id, &ext.id).unwrap();

    let first = profile_with_group("First", &group.id);
    let second = profile_with_group("Second", &group.id);
    let first_paths = mgr
      .install_extensions_for_profile(&first, Path::new(""))
      .unwrap();
    let second_paths = mgr
      .install_extensions_for_profile(&second, Path::new(""))
      .unwrap();
    assert_eq!(first_paths.len(), 1);
    assert_eq!(second_paths.len(), 1);
    assert_ne!(first_paths[0], second_paths[0]);

    for staged in [&first_paths[0], &second_paths[0]] {
      assert!(Path::new(staged).join("manifest.json").exists());
      assert!(Path::new(staged).join("background.js").exists());
    }

    // Relaunching one profile rebuilds only its own copy.
    let relaunched = mgr
      .install_extensions_for_profile(&first, Path::new(""))
      .unwrap();
    assert_eq!(relaunched, first_paths);
    assert!(Path::new(&second_paths[0]).join("manifest.json").exists());

    ExtensionManager::cleanup_unpacked_for_profile(&second.id.to_string());
    assert!(!Path::new(&second_paths[0]).exists());
    assert!(Path::new(&first_paths[0]).join("manifest.json").exists());
  }

  #[test]
  fn a_launch_unpacks_an_archive_once_per_version() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let source = write_unpacked_fixture(&tmp.path().join("source-extension"), "Cached");
    let ext = mgr
      .add_unpacked_extension("Ignored".to_string(), &source, false)
      .unwrap();
    let group = mgr.create_group("Cached Group".to_string()).unwrap();
    mgr.add_extension_to_group(&group.id, &ext.id).unwrap();
    let profile = profile_with_group("Cached", &group.id);

    let staged = mgr
      .install_extensions_for_profile(&profile, Path::new(""))
      .unwrap();
    let tree = unpacked_cache_dir(&ext.id).join("tree");
    assert!(tree.join("background.js").is_file());

    // The launch rewrites its own manifest, never the cached one.
    assert!(manifest_key(Path::new(&staged[0])).is_some());
    assert!(manifest_key(&tree).is_none());

    // A second launch takes the cached files instead of unpacking again.
    fs::write(tree.join("marker.txt"), "cached").unwrap();
    let again = mgr
      .install_extensions_for_profile(&profile, Path::new(""))
      .unwrap();
    assert_eq!(again, staged);
    assert_eq!(
      fs::read_to_string(Path::new(&again[0]).join("marker.txt")).unwrap(),
      "cached"
    );

    // A new archive is unpacked again.
    fs::write(source.join("content.js"), "globalThis.__v2 = true;\n").unwrap();
    mgr
      .update_extension_from_path(&ext.id, None, &source, false)
      .unwrap();
    let updated = mgr
      .install_extensions_for_profile(&profile, Path::new(""))
      .unwrap();
    assert!(!Path::new(&updated[0]).join("marker.txt").exists());
    assert!(Path::new(&updated[0]).join("content.js").is_file());

    // Deleting the extension drops its cached files.
    mgr.delete_extension_internal(&ext.id).unwrap();
    assert!(!unpacked_cache_dir(&ext.id).exists());
  }

  #[test]
  fn test_linked_extension_is_loaded_in_place() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let source = write_unpacked_fixture(&tmp.path().join("linked-extension"), "Linked Fixture");
    let canonical = dunce::canonicalize(&source)
      .unwrap()
      .to_string_lossy()
      .to_string();
    assert!(!canonical.starts_with(r"\\?\"), "{canonical}");
    let ext = mgr
      .add_unpacked_extension("Ignored".to_string(), &source, true)
      .unwrap();
    assert_eq!(ext.linked_path.as_deref(), Some(canonical.as_str()));
    assert!(!ext.sync_enabled);
    assert!(!mgr.get_file_dir_public(&ext.id).exists());

    let group = mgr.create_group("Linked Group".to_string()).unwrap();
    mgr.add_extension_to_group(&group.id, &ext.id).unwrap();
    let profile = profile_with_group("Linked", &group.id);
    assert_eq!(
      mgr
        .install_extensions_for_profile(&profile, Path::new(""))
        .unwrap(),
      vec![canonical.clone()]
    );
    assert!(
      !extensions_base_dir()
        .join("unpacked")
        .join(profile.id.to_string())
        .join(&ext.id)
        .exists(),
      "a linked extension has nothing to stage"
    );

    // Re-importing the same folder as a copy ends the link and restores the
    // stored payload.
    let copied = mgr
      .update_extension_from_path(&ext.id, None, &source, false)
      .unwrap();
    assert!(copied.linked_path.is_none());
    assert_eq!(copied.source_kind, SOURCE_KIND_UNPACKED);
    assert!(mgr
      .get_file_dir_public(&ext.id)
      .join(&copied.file_name)
      .exists());
  }

  #[test]
  fn test_unpacked_import_rejects_a_folder_without_a_manifest() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let empty = tmp.path().join("not-an-extension");
    fs::create_dir_all(&empty).unwrap();
    assert!(mgr
      .add_unpacked_extension("Nope".to_string(), &empty, false)
      .unwrap_err()
      .to_string()
      .contains("EXTENSION_MANIFEST_MISSING"));
    assert!(mgr
      .add_unpacked_extension("Nope".to_string(), &tmp.path().join("absent"), false)
      .unwrap_err()
      .to_string()
      .contains("EXTENSION_DIR_NOT_FOUND"));
    assert!(mgr.list_extensions().unwrap().is_empty());
  }

  #[test]
  fn test_delete_extension_removes_from_groups() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();

    let ext = mgr
      .add_extension("Test".to_string(), "test.zip".to_string(), vec![0, 1, 2, 3])
      .unwrap();

    let group = mgr.create_group("G1".to_string()).unwrap();
    mgr.add_extension_to_group(&group.id, &ext.id).unwrap();

    // Delete extension should remove from group
    mgr.delete_extension_internal(&ext.id).unwrap();

    let updated_group = mgr.get_group(&group.id).unwrap();
    assert!(updated_group.extension_ids.is_empty());
  }

  /// Build a zip whose manifest localizes its name and description, the shape
  /// uBlock Origin Lite and most Chrome Web Store extensions ship.
  fn localized_extension_zip() -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
      let mut writer = zip::ZipWriter::new(&mut buffer);
      let options: zip::write::SimpleFileOptions = zip::write::FileOptions::default();
      let manifest = serde_json::json!({
        "manifest_version": 3,
        "name": "__MSG_extName__",
        "description": "__MSG_extShortDesc__",
        "version": "1.2.3",
        "default_locale": "en"
      });
      writer.start_file("manifest.json", options).unwrap();
      std::io::Write::write_all(&mut writer, manifest.to_string().as_bytes()).unwrap();

      let messages = serde_json::json!({
        "extName": { "message": "uBlock Origin Lite" },
        "extShortDesc": { "message": "An efficient content blocker." }
      });
      writer
        .start_file("_locales/en/messages.json", options)
        .unwrap();
      std::io::Write::write_all(&mut writer, messages.to_string().as_bytes()).unwrap();
      writer.finish().unwrap();
    }
    buffer.into_inner()
  }

  #[test]
  fn a_localized_manifest_shows_its_real_name_not_the_placeholder() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let ext = mgr
      .add_extension(
        "fallback".to_string(),
        "ublock.zip".to_string(),
        localized_extension_zip(),
      )
      .unwrap();

    assert_eq!(ext.name, "uBlock Origin Lite");
    assert_eq!(ext.manifest_name.as_deref(), Some("uBlock Origin Lite"));
    assert_eq!(
      ext.description.as_deref(),
      Some("An efficient content blocker.")
    );
    assert_eq!(ext.version.as_deref(), Some("1.2.3"));
  }

  #[test]
  fn manifest_identity_backfill_preserves_an_explicit_name_and_edit_time() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());
    let mgr = ExtensionManager::new();
    let mut ext = mgr
      .add_extension(
        "fallback".to_string(),
        "ublock.zip".to_string(),
        localized_extension_zip(),
      )
      .unwrap();
    ext.name = "My blocker".to_string();
    ext.manifest_name = None;
    mgr.update_extension_internal(&ext).unwrap();
    mgr.ensure_icons_extracted();
    let restored = mgr.get_extension(&ext.id).unwrap();
    assert_eq!(restored.name, "My blocker");
    assert_eq!(
      restored.manifest_name.as_deref(),
      Some("uBlock Origin Lite")
    );
    assert_eq!(restored.updated_at, ext.updated_at);
  }

  #[test]
  fn ids_and_file_names_from_sync_or_rest_cannot_leave_the_extension_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());
    let mgr = ExtensionManager::new();
    let ext = mgr
      .add_extension(
        "fallback".to_string(),
        "ublock.zip".to_string(),
        localized_extension_zip(),
      )
      .unwrap();
    let canary = tmp.path().join("canary.txt");
    std::fs::write(&canary, "still here").unwrap();

    // What a crafted sync object would upsert.
    for (id, file_name) in [
      ("..", "ublock.zip"),
      ("../..", "ublock.zip"),
      (ext.id.as_str(), "../../../escaped.zip"),
      (ext.id.as_str(), "/tmp/escaped.zip"),
      (ext.id.as_str(), ".."),
    ] {
      let mut crafted = ext.clone();
      crafted.id = id.to_string();
      crafted.file_name = file_name.to_string();
      assert!(
        mgr.update_extension_internal(&crafted).is_err(),
        "{id} / {file_name}"
      );
    }

    // A remote tombstone for `..` must not reach the parent directory.
    assert!(mgr.get_extension("..").is_err());
    assert!(mgr.delete_extension_internal("..").is_err());
    assert!(canary.exists());

    // The REST and UI add paths refuse a file name with path parts too.
    for file_name in ["../escaped.zip", "nested/ublock.zip"] {
      assert!(mgr
        .add_extension(
          "x".to_string(),
          file_name.to_string(),
          localized_extension_zip()
        )
        .is_err());
    }
    assert!(!tmp.path().join("escaped.zip").exists());
  }

  #[test]
  fn a_stored_placeholder_is_repaired_rather_than_shown_to_the_user() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let ext = mgr
      .add_extension(
        "fallback".to_string(),
        "ublock.zip".to_string(),
        localized_extension_zip(),
      )
      .unwrap();

    // Rewind to what older builds persisted: the raw placeholders.
    let mut stale = ext.clone();
    stale.name = "__MSG_extName__".to_string();
    stale.description = Some("__MSG_extShortDesc__".to_string());
    mgr.update_extension_internal(&stale).unwrap();

    mgr.ensure_icons_extracted();

    let repaired = mgr.get_extension(&ext.id).unwrap();
    assert_eq!(repaired.name, "uBlock Origin Lite");
    assert_eq!(
      repaired.description.as_deref(),
      Some("An efficient content blocker.")
    );
  }

  #[test]
  fn a_user_chosen_name_survives_the_backfill() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let ext = mgr
      .add_extension(
        "fallback".to_string(),
        "ublock.zip".to_string(),
        localized_extension_zip(),
      )
      .unwrap();

    let renamed = mgr
      .update_extension(&ext.id, Some("My Blocker".to_string()), None, None)
      .unwrap();
    assert_eq!(renamed.name, "My Blocker");

    mgr.ensure_icons_extracted();

    assert_eq!(mgr.get_extension(&ext.id).unwrap().name, "My Blocker");
  }

  #[test]
  fn the_start_up_backfill_reads_each_archive_once() {
    let tmp = tempfile::tempdir().unwrap();
    let _guard = crate::app_dirs::set_test_data_dir(tmp.path().to_path_buf());

    let mgr = ExtensionManager::new();
    let ext = mgr
      .add_extension(
        "fallback".to_string(),
        "ublock.zip".to_string(),
        localized_extension_zip(),
      )
      .unwrap();
    mgr.ensure_icons_extracted();
    let stamp = mgr.get_extension_dir(&ext.id).join(BACKFILL_STAMP_FILE);
    assert!(stamp.is_file());

    // The archive was read: a later start leaves the record alone.
    let mut edited = mgr.get_extension(&ext.id).unwrap();
    edited.version = None;
    mgr.update_extension_internal(&edited).unwrap();
    mgr.ensure_icons_extracted();
    assert_eq!(mgr.get_extension(&ext.id).unwrap().version, None);

    // A placeholder is still repaired.
    edited.name = "__MSG_extName__".to_string();
    mgr.update_extension_internal(&edited).unwrap();
    mgr.ensure_icons_extracted();
    assert_eq!(
      mgr.get_extension(&ext.id).unwrap().name,
      "uBlock Origin Lite"
    );

    // Without a stamp (a record from an older build) it reads it again.
    let mut edited = mgr.get_extension(&ext.id).unwrap();
    edited.version = None;
    mgr.update_extension_internal(&edited).unwrap();
    fs::remove_file(&stamp).unwrap();
    mgr.ensure_icons_extracted();
    assert_eq!(
      mgr.get_extension(&ext.id).unwrap().version.as_deref(),
      Some("1.2.3")
    );
  }
}
