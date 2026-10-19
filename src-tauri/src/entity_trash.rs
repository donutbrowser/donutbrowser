//! Recoverable delete for what profiles point at: proxies, VPNs, groups,
//! extensions, extension groups and profile templates.
//!
//! The model is the profile trash's (`profile::trash`). A delete moves the
//! entity to `<data root>/trash/entities/<kind>/<id>/`; it can be restored
//! until the `trash_retention_days` setting runs out, and the same expiry
//! sweep, "Delete forever" and "Empty trash" erase it. Each entry holds:
//!
//! - `entry.json`: the entity as it was stored, when it was deleted, whether
//!   it synced, and what the Trash page shows for it.
//! - `files/`: what lives beside the entity: an extension's folder (payload,
//!   icon, metadata) or a proxy's check history.
//!
//! A VPN stays sealed with the VPN key while it sits here.
//!
//! Sync: from the cloud's point of view a trashed entity is deleted. The cloud
//! delete and its tombstone are written by the same engine call a permanent
//! delete uses. A restore waits for that call, puts the entity back under its
//! id with sync off, removes the tombstone, and only then turns sync back on.
//! When the tombstone cannot be removed (offline, signed out) sync stays off
//! and the restore says so. Other devices drop their copy on the tombstone,
//! as for a permanent delete, and get it back once sync is on again.
//!
//! References are kept, so a restore needs no repair:
//! - a profile in a trashed group keeps the group; it is listed under All,
//!   with no group, until the group comes back (a profile restored from the
//!   trash meanwhile keeps it too);
//! - a profile with a trashed extension group keeps it and launches without
//!   its extensions;
//! - an extension leaves its groups and rejoins those that still exist;
//! - a proxy or VPN that a profile uses cannot be trashed (`ENTITY_IN_USE`):
//!   a launch through a proxy that is not there would go out direct.
//!
//! "Delete at once" (a retention of 0 days) turns the trash off: the entity is
//! erased at once and the delete reports `trashed: false`.

use crate::events;
use crate::extension_manager::{Extension, ExtensionGroup, EXTENSION_MANAGER};
use crate::group_manager::{ProfileGroup, GROUP_MANAGER};
use crate::profile::trash::{dir_size, normalized_name, unique_restored_name};
use crate::profile_templates::ProfileTemplate;
use crate::proxy_manager::{StoredProxy, PROXY_MANAGER};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

const ENTRY_FILE: &str = "entry.json";
const FILES_DIR: &str = "files";
const PROXY_HISTORY_FILE: &str = "history.json";
const SECS_PER_DAY: u64 = 24 * 60 * 60;

/// Serialises every entity trash mutation, so a restore cannot interleave
/// with a purge of the same entry.
static MUTATION: Mutex<()> = Mutex::new(());

/// The cloud deletes started in this session, so a restore can wait for the
/// one it would otherwise race: a tombstone that lands after the restore
/// erases the restored entity on the next sync.
static CLOUD_DELETES: LazyLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> =
  LazyLock::new(Default::default);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
  Proxy,
  Vpn,
  Group,
  Extension,
  ExtensionGroup,
  Template,
}

impl EntityKind {
  pub const ALL: [EntityKind; 6] = [
    EntityKind::Proxy,
    EntityKind::Vpn,
    EntityKind::Group,
    EntityKind::Extension,
    EntityKind::ExtensionGroup,
    EntityKind::Template,
  ];

  /// The folder of this kind in the trash, and its name in log lines.
  pub fn key(self) -> &'static str {
    match self {
      EntityKind::Proxy => "proxy",
      EntityKind::Vpn => "vpn",
      EntityKind::Group => "group",
      EntityKind::Extension => "extension",
      EntityKind::ExtensionGroup => "extension_group",
      EntityKind::Template => "template",
    }
  }

  fn not_found(self) -> String {
    crate::backend_error(match self {
      EntityKind::Proxy => "PROXY_NOT_FOUND",
      EntityKind::Vpn => "VPN_NOT_FOUND",
      EntityKind::Group => "GROUP_NOT_FOUND",
      EntityKind::Extension => "EXTENSION_NOT_FOUND",
      EntityKind::ExtensionGroup => "EXTENSION_GROUP_NOT_FOUND",
      EntityKind::Template => "TEMPLATE_NOT_FOUND",
    })
  }

  /// The event the page listing this kind reloads on.
  fn changed_event(self) -> &'static str {
    match self {
      EntityKind::Proxy => "stored-proxies-changed",
      EntityKind::Vpn => "vpn-configs-changed",
      EntityKind::Group => "groups-changed",
      EntityKind::Extension | EntityKind::ExtensionGroup => "extensions-changed",
      EntityKind::Template => crate::sync::config_entities::ConfigKind::Template.changed_event(),
    }
  }

  /// Where the cloud keeps this kind, and its tombstones.
  fn cloud_folder(self) -> &'static str {
    match self {
      EntityKind::Proxy => "proxies",
      EntityKind::Vpn => "vpns",
      EntityKind::Group => "groups",
      EntityKind::Extension => "extensions",
      EntityKind::ExtensionGroup => "extension_groups",
      EntityKind::Template => crate::sync::config_entities::ConfigKind::Template.folder(),
    }
  }

  /// The team activity a delete reports, the same as a permanent delete's.
  fn delete_action(self) -> &'static str {
    match self {
      EntityKind::Proxy => "proxy.delete",
      EntityKind::Vpn => "vpn.delete",
      EntityKind::Group => "group.delete",
      EntityKind::Extension => "extension.delete",
      EntityKind::ExtensionGroup => "extension.group_delete",
      EntityKind::Template => "template.delete",
    }
  }

  /// To the rest of the team, a restored entity is created again.
  fn restore_action(self) -> &'static str {
    match self {
      EntityKind::Proxy => "proxy.create",
      EntityKind::Vpn => "vpn.create",
      EntityKind::Group => "group.create",
      EntityKind::Extension => "extension.add",
      EntityKind::ExtensionGroup => "extension.group_create",
      EntityKind::Template => "template.create",
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashEntry {
  kind: EntityKind,
  id: String,
  name: String,
  deleted_at: u64,
  /// Whether it synced when it was deleted: the restore turns sync back on.
  sync_enabled: bool,
  #[serde(default)]
  detail: Option<String>,
  /// The extension groups an extension was in.
  #[serde(default)]
  groups: Vec<String>,
  /// The entity as it was stored. A VPN's config stays sealed.
  entity: serde_json::Value,
}

/// What the Trash page shows for one entry.
#[derive(Debug, Clone, Serialize)]
pub struct TrashedEntitySummary {
  pub kind: EntityKind,
  pub id: String,
  pub name: String,
  pub deleted_at: u64,
  pub expires_at: u64,
  pub size_bytes: u64,
  pub sync_enabled: bool,
  /// A short technical fact: a proxy's protocol, a VPN's type, an
  /// extension's version.
  pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrashOutcome {
  /// `false` when the trash is off and the entity was erased at once.
  pub trashed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoredEntity {
  pub kind: EntityKind,
  pub id: String,
  pub name: String,
  /// It synced before, but its tombstone could not be removed, so sync stays
  /// off and it is on this device only.
  pub sync_stayed_off: bool,
}

fn err_internal(e: impl std::fmt::Display) -> String {
  crate::backend_error_with_detail("INTERNAL_ERROR", e)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn expiry(deleted_at: u64, retention_days: u32) -> u64 {
  deleted_at.saturating_add(u64::from(retention_days) * SECS_PER_DAY)
}

/// The entity trash inside the trash folder `trash_root`.
pub fn entities_root(trash_root: &Path) -> PathBuf {
  trash_root.join(crate::profile::trash::ENTITIES_DIR)
}

fn root() -> PathBuf {
  entities_root(&crate::profile::trash::trash_dir())
}

/// The entry folder for `id`. An id that is not one plain name never names
/// one, so a caller can never point an erase outside the trash.
fn entry_dir(root: &Path, kind: EntityKind, id: &str) -> Result<PathBuf, String> {
  if !crate::app_dirs::is_plain_path_part(id) || id.starts_with('.') {
    return Err(crate::backend_error("TRASH_ENTRY_NOT_FOUND"));
  }
  Ok(root.join(kind.key()).join(id))
}

/// Whether the trash under `root` holds this entity.
pub fn holds(root: &Path, kind: EntityKind, id: &str) -> bool {
  entry_dir(root, kind, id).is_ok_and(|dir| dir.join(ENTRY_FILE).is_file())
}

fn write_entry(dir: &Path, entry: &TrashEntry) -> Result<(), String> {
  fs::create_dir_all(dir).map_err(err_internal)?;
  let json = serde_json::to_string_pretty(entry).map_err(err_internal)?;
  let path = dir.join(ENTRY_FILE);
  let tmp = dir.join(format!("{ENTRY_FILE}.tmp"));
  // A proxy entry holds its credentials, as the live proxy file does.
  crate::app_dirs::write_owner_only(&tmp, json.as_bytes()).map_err(err_internal)?;
  fs::rename(&tmp, &path).map_err(err_internal)
}

fn read_entry(root: &Path, kind: EntityKind, id: &str) -> Result<TrashEntry, String> {
  let path = entry_dir(root, kind, id)?.join(ENTRY_FILE);
  if !path.is_file() {
    return Err(crate::backend_error("TRASH_ENTRY_NOT_FOUND"));
  }
  let content = fs::read_to_string(&path).map_err(err_internal)?;
  let entry: TrashEntry = serde_json::from_str(&content).map_err(err_internal)?;
  if entry.kind != kind || entry.id != id {
    return Err(crate::backend_error("TRASH_ENTRY_NOT_FOUND"));
  }
  Ok(entry)
}

fn erase_dir(dir: &Path) -> Result<(), String> {
  crate::fs_secure::secure_remove_dir_all(dir, true)
    .map(|_| ())
    .map_err(err_internal)
}

/// Every readable entry, newest deletion first. An unreadable one is skipped
/// with a warning rather than hiding the whole trash.
fn list_entries(root: &Path) -> Vec<(TrashEntry, u64)> {
  let mut listed = Vec::new();
  for kind in EntityKind::ALL {
    let Ok(dirs) = fs::read_dir(root.join(kind.key())) else {
      continue;
    };
    for dir in dirs.flatten().filter(|dir| dir.path().is_dir()) {
      let id = dir.file_name().to_string_lossy().into_owned();
      match read_entry(root, kind, &id) {
        Ok(entry) => listed.push((entry, dir_size(&dir.path()))),
        Err(e) => log::warn!(
          "Trash entry unreadable, skipped kind={} entry={id} err=\"{e}\"",
          kind.key()
        ),
      }
    }
  }
  listed.sort_by_key(|(entry, _)| std::cmp::Reverse(entry.deleted_at));
  listed
}

fn summaries(root: &Path, retention_days: u32) -> Vec<TrashedEntitySummary> {
  list_entries(root)
    .into_iter()
    .map(|(entry, size_bytes)| TrashedEntitySummary {
      kind: entry.kind,
      expires_at: expiry(entry.deleted_at, retention_days),
      id: entry.id,
      name: entry.name,
      deleted_at: entry.deleted_at,
      size_bytes,
      sync_enabled: entry.sync_enabled,
      detail: entry.detail,
    })
    .collect()
}

fn purge_entry(root: &Path, kind: EntityKind, id: &str) -> Result<(), String> {
  let dir = entry_dir(root, kind, id)?;
  if !dir.is_dir() {
    return Err(crate::backend_error("TRASH_ENTRY_NOT_FOUND"));
  }
  erase_dir(&dir)
}

fn purge_all_in(root: &Path) -> Result<usize, String> {
  let entries = list_entries(root);
  for (entry, _) in &entries {
    purge_entry(root, entry.kind, &entry.id)?;
  }
  Ok(entries.len())
}

fn purge_expired_in(root: &Path, now: u64, retention_days: u32) -> usize {
  list_entries(root)
    .into_iter()
    .filter(|(entry, _)| expiry(entry.deleted_at, retention_days) <= now)
    .filter(
      |(entry, _)| match purge_entry(root, entry.kind, &entry.id) {
        Ok(()) => true,
        Err(e) => {
          log::warn!(
            "Expired trash purge failed kind={} entry={} err=\"{e}\"",
            entry.kind.key(),
            entry.id
          );
          false
        }
      },
    )
    .count()
}

/// Move a file, copying when a rename across volumes is impossible.
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
  if let Some(parent) = to.parent() {
    fs::create_dir_all(parent)?;
  }
  if fs::rename(from, to).is_ok() {
    return Ok(());
  }
  fs::copy(from, to)?;
  fs::remove_file(from)
}

fn proxy_history_path(id: &str) -> PathBuf {
  crate::app_dirs::proxies_dir()
    .join("history")
    .join(format!("{id}.json"))
}

fn profiles() -> Result<Vec<crate::profile::BrowserProfile>, String> {
  crate::profile::ProfileManager::instance()
    .list_profiles()
    .map_err(|e| crate::wrap_backend_error(e, "Failed to list profiles"))
}

/// A proxy or VPN that a profile uses stays: a launch through a proxy that is
/// not there goes out direct.
fn refuse_in_use(kind: EntityKind, id: &str) -> Result<(), String> {
  let count = match kind {
    EntityKind::Proxy => profiles()?
      .iter()
      .filter(|p| p.proxy_id.as_deref() == Some(id))
      .count(),
    EntityKind::Vpn => profiles()?
      .iter()
      .filter(|p| p.vpn_id.as_deref() == Some(id))
      .count(),
    _ => 0,
  };
  if count > 0 {
    return Err(
      serde_json::json!({ "code": "ENTITY_IN_USE", "params": { "count": count.to_string() } })
        .to_string(),
    );
  }
  Ok(())
}

fn stored_proxy(id: &str) -> Option<StoredProxy> {
  PROXY_MANAGER
    .get_stored_proxies()
    .into_iter()
    .find(|p| p.id == id)
}

fn profile_group(id: &str) -> Result<Option<ProfileGroup>, String> {
  let groups = lock(&GROUP_MANAGER)
    .get_all_groups()
    .map_err(|e| crate::wrap_backend_error(e, "Failed to read groups"))?;
  Ok(groups.into_iter().find(|g| g.id == id))
}

fn to_value<T: Serialize>(value: &T) -> Result<serde_json::Value, String> {
  serde_json::to_value(value).map_err(err_internal)
}

fn from_value<T: for<'de> Deserialize<'de>>(value: &serde_json::Value) -> Result<T, String> {
  serde_json::from_value(value.clone()).map_err(err_internal)
}

/// Move the live entity into the entry folder `dir`, writing `entry.json`
/// last, and return the entry. Nothing changes when it fails.
fn trash_into(dir: &Path, kind: EntityKind, id: &str, now: u64) -> Result<TrashEntry, String> {
  refuse_in_use(kind, id)?;
  let files = dir.join(FILES_DIR);
  let entry = |name: String, sync_enabled: bool, detail: Option<String>, entity| TrashEntry {
    kind,
    id: id.to_string(),
    name,
    deleted_at: now,
    sync_enabled,
    detail,
    groups: Vec::new(),
    entity,
  };
  match kind {
    EntityKind::Proxy => {
      let proxy = stored_proxy(id).ok_or_else(|| kind.not_found())?;
      if proxy.is_cloud_managed || proxy.is_cloud_derived {
        return Err(crate::backend_error("CANNOT_MODIFY_CLOUD_MANAGED_PROXY"));
      }
      let trashed = entry(
        proxy.name.clone(),
        proxy.sync_enabled,
        Some(proxy.proxy_settings.proxy_type.clone()),
        to_value(&proxy)?,
      );
      write_entry(dir, &trashed)?;
      let history = proxy_history_path(id);
      let kept_history = files.join(PROXY_HISTORY_FILE);
      if history.is_file() {
        move_file(&history, &kept_history).map_err(err_internal)?;
      }
      let file = PROXY_MANAGER.get_proxy_file_path(id);
      if let Err(e) = fs::remove_file(&file) {
        if e.kind() != std::io::ErrorKind::NotFound {
          if kept_history.is_file() {
            let _ = move_file(&kept_history, &history);
          }
          return Err(err_internal(e));
        }
      }
      PROXY_MANAGER.remove_from_memory(id);
      Ok(trashed)
    }
    EntityKind::Vpn => {
      let storage = lock(&crate::vpn::VPN_STORAGE);
      let vpn = storage
        .list_configs()
        .map_err(err_internal)?
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| kind.not_found())?;
      let sealed = storage.take_sealed(id).map_err(err_internal)?;
      let trashed = entry(
        vpn.name.clone(),
        vpn.sync_enabled,
        Some(vpn.vpn_type.to_string()),
        sealed.clone(),
      );
      if let Err(e) = write_entry(dir, &trashed) {
        if let Err(back) = storage.put_sealed(
          sealed,
          &vpn.name,
          vpn.sync_enabled,
          vpn.updated_at.unwrap_or_default(),
        ) {
          log::error!("VPN not put back after a failed trash vpn={id} err=\"{back}\"");
        }
        return Err(e);
      }
      Ok(trashed)
    }
    EntityKind::Group => {
      let group = profile_group(id)?.ok_or_else(|| kind.not_found())?;
      let trashed = entry(
        group.name.clone(),
        group.sync_enabled,
        None,
        to_value(&group)?,
      );
      write_entry(dir, &trashed)?;
      lock(&GROUP_MANAGER)
        .delete_group_internal(id)
        .map_err(|e| crate::wrap_backend_error(e, "Failed to delete group"))?;
      Ok(trashed)
    }
    EntityKind::Extension => {
      let manager = lock(&EXTENSION_MANAGER);
      let (ext, groups) = manager
        .take_for_trash(id, &files)
        .map_err(|e| crate::wrap_backend_error(e, "Failed to move extension"))?;
      let mut trashed = entry(
        ext.name.clone(),
        ext.sync_enabled,
        ext.version.clone(),
        to_value(&ext)?,
      );
      trashed.groups = groups;
      if let Err(e) = write_entry(dir, &trashed) {
        if let Err(back) = manager.restore_from_trash(&ext, &files, &trashed.groups, ext.updated_at)
        {
          log::error!("Extension not put back after a failed trash extension={id} err=\"{back}\"");
        }
        return Err(e);
      }
      Ok(trashed)
    }
    EntityKind::ExtensionGroup => {
      let manager = lock(&EXTENSION_MANAGER);
      let group = manager.get_group(id).map_err(|_| kind.not_found())?;
      let trashed = entry(
        group.name.clone(),
        group.sync_enabled,
        None,
        to_value(&group)?,
      );
      write_entry(dir, &trashed)?;
      manager
        .delete_group_internal(id)
        .map_err(|e| crate::wrap_backend_error(e, "Failed to delete extension group"))?;
      Ok(trashed)
    }
    EntityKind::Template => {
      let template = crate::profile_templates::take_for_trash(id)?;
      let trashed = entry(
        template.name.clone(),
        crate::sync::is_sync_configured(),
        None,
        to_value(&template)?,
      );
      if let Err(e) = write_entry(dir, &trashed) {
        if let Err(back) = crate::profile_templates::restore_from_trash(template) {
          log::error!("Template not put back after a failed trash template={id} err=\"{back}\"");
        }
        return Err(e);
      }
      Ok(trashed)
    }
  }
}

/// Move an entity to the trash under `root`, or erase it at once when the
/// retention is 0 days. Returns the entry it made.
fn trash_now(
  root: &Path,
  kind: EntityKind,
  id: &str,
  now: u64,
  retention_days: u32,
) -> Result<TrashEntry, String> {
  let dir = entry_dir(root, kind, id)?;
  // Ids survive a restore, so an older entry under the same id is the older
  // copy of what is being trashed now.
  if dir.exists() {
    erase_dir(&dir)?;
  }
  let entry = trash_into(&dir, kind, id, now).inspect_err(|_| {
    // The entity is still live. Drop the half-made entry, unless files a
    // failed rollback left in it are the only copy.
    let files = dir.join(FILES_DIR);
    let holds_files = fs::read_dir(&files).is_ok_and(|mut entries| entries.next().is_some());
    if dir.exists() && !holds_files {
      let _ = fs::remove_dir_all(&dir);
    }
  })?;
  if retention_days == 0 {
    erase_dir(&dir)?;
  }
  Ok(entry)
}

fn exists_live(kind: EntityKind, id: &str) -> Result<bool, String> {
  Ok(match kind {
    EntityKind::Proxy => stored_proxy(id).is_some(),
    EntityKind::Vpn => lock(&crate::vpn::VPN_STORAGE)
      .list_configs()
      .map_err(err_internal)?
      .iter()
      .any(|v| v.id == id),
    EntityKind::Group => profile_group(id)?.is_some(),
    EntityKind::Extension => lock(&EXTENSION_MANAGER).get_extension(id).is_ok(),
    EntityKind::ExtensionGroup => lock(&EXTENSION_MANAGER).get_group(id).is_ok(),
    EntityKind::Template => crate::profile_templates::get(id).is_ok(),
  })
}

fn live_names(kind: EntityKind) -> Result<HashSet<String>, String> {
  let names: Vec<String> = match kind {
    EntityKind::Proxy => PROXY_MANAGER
      .get_stored_proxies()
      .into_iter()
      .map(|p| p.name)
      .collect(),
    EntityKind::Vpn => lock(&crate::vpn::VPN_STORAGE)
      .list_configs()
      .map_err(err_internal)?
      .into_iter()
      .map(|v| v.name)
      .collect(),
    EntityKind::Group => lock(&GROUP_MANAGER)
      .get_all_groups()
      .map_err(|e| crate::wrap_backend_error(e, "Failed to read groups"))?
      .into_iter()
      .map(|g| g.name)
      .collect(),
    EntityKind::Extension => lock(&EXTENSION_MANAGER)
      .list_extensions()
      .map_err(|e| crate::wrap_backend_error(e, "Failed to list extensions"))?
      .into_iter()
      .map(|e| e.name)
      .collect(),
    EntityKind::ExtensionGroup => lock(&EXTENSION_MANAGER)
      .list_groups()
      .map_err(|e| crate::wrap_backend_error(e, "Failed to list extension groups"))?
      .into_iter()
      .map(|g| g.name)
      .collect(),
    EntityKind::Template => crate::profile_templates::list()
      .into_iter()
      .map(|t| t.name)
      .collect(),
  };
  Ok(names.iter().map(|name| normalized_name(name)).collect())
}

/// Put an entry back under its own id with `name`, sync off and `now` as its
/// edit time. Returns the extension groups an extension rejoined.
fn put_back(
  kind: EntityKind,
  entry: &TrashEntry,
  name: &str,
  files: &Path,
  now: u64,
) -> Result<Vec<ExtensionGroup>, String> {
  match kind {
    EntityKind::Proxy => {
      let mut proxy: StoredProxy = from_value(&entry.entity)?;
      proxy.name = name.to_string();
      proxy.sync_enabled = false;
      proxy.last_sync = None;
      proxy.updated_at = Some(now);
      let file = PROXY_MANAGER.get_proxy_file_path(&proxy.id);
      if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(err_internal)?;
      }
      let json = serde_json::to_string_pretty(&proxy).map_err(err_internal)?;
      crate::app_dirs::write_owner_only(&file, json.as_bytes()).map_err(err_internal)?;
      PROXY_MANAGER.upsert_stored_proxy(proxy);
      let kept_history = files.join(PROXY_HISTORY_FILE);
      if kept_history.is_file() {
        if let Err(e) = move_file(&kept_history, &proxy_history_path(&entry.id)) {
          log::warn!(
            "Proxy check history not restored proxy={} err=\"{e}\"",
            entry.id
          );
        }
      }
      Ok(Vec::new())
    }
    EntityKind::Vpn => {
      let restored = lock(&crate::vpn::VPN_STORAGE)
        .put_sealed(entry.entity.clone(), name, false, now)
        .map_err(err_internal)?;
      if !restored {
        return Err(crate::backend_error("TRASH_RESTORE_CONFLICT"));
      }
      Ok(Vec::new())
    }
    EntityKind::Group => {
      let mut group: ProfileGroup = from_value(&entry.entity)?;
      group.name = name.to_string();
      group.sync_enabled = false;
      group.last_sync = None;
      group.updated_at = Some(now);
      lock(&GROUP_MANAGER)
        .upsert_group_internal(&group)
        .map_err(|e| crate::wrap_backend_error(e, "Failed to save group"))?;
      Ok(Vec::new())
    }
    EntityKind::Extension => {
      let mut ext: Extension = from_value(&entry.entity)?;
      ext.name = name.to_string();
      ext.sync_enabled = false;
      ext.last_sync = None;
      ext.updated_at = now;
      lock(&EXTENSION_MANAGER)
        .restore_from_trash(&ext, files, &entry.groups, now)
        .map_err(|e| crate::wrap_backend_error(e, "Failed to restore extension"))
    }
    EntityKind::ExtensionGroup => {
      let mut group: ExtensionGroup = from_value(&entry.entity)?;
      let manager = lock(&EXTENSION_MANAGER);
      // An extension deleted meanwhile is not listed again.
      group
        .extension_ids
        .retain(|ext_id| manager.get_extension(ext_id).is_ok());
      group.name = name.to_string();
      group.sync_enabled = false;
      group.last_sync = None;
      group.updated_at = now;
      manager
        .upsert_group_internal(&group)
        .map_err(|e| crate::wrap_backend_error(e, "Failed to save extension group"))?;
      Ok(Vec::new())
    }
    EntityKind::Template => {
      let mut template: ProfileTemplate = from_value(&entry.entity)?;
      template.name = name.to_string();
      template.updated_at = now;
      if !crate::profile_templates::restore_from_trash(template)? {
        return Err(crate::backend_error("TRASH_RESTORE_CONFLICT"));
      }
      Ok(Vec::new())
    }
  }
}

/// Bring an entry under `root` back. Returns the entry, the name it came back
/// under, and the extension groups an extension rejoined.
fn restore_now(
  root: &Path,
  kind: EntityKind,
  id: &str,
  now: u64,
) -> Result<(TrashEntry, String, Vec<ExtensionGroup>), String> {
  let entry = read_entry(root, kind, id)?;
  if exists_live(kind, id)? {
    return Err(crate::backend_error("TRASH_RESTORE_CONFLICT"));
  }
  let name = unique_restored_name(&entry.name, &live_names(kind)?);
  let dir = entry_dir(root, kind, id)?;
  let rejoined = put_back(kind, &entry, &name, &dir.join(FILES_DIR), now)?;
  if let Err(e) = erase_dir(&dir) {
    log::warn!(
      "Restored trash entry not removed kind={} entry={id} err=\"{e}\"",
      kind.key()
    );
  }
  Ok((entry, name, rejoined))
}

/// Turn sync back on for a restored entity whose tombstone is gone, and
/// queue its upload.
async fn resume_sync(kind: EntityKind, id: &str) -> Result<(), String> {
  let scheduler = crate::sync::get_global_scheduler();
  let id = id.to_string();
  match kind {
    EntityKind::Proxy => {
      PROXY_MANAGER.set_stored_proxy_sync_state(&id, true, None)?;
      if let Some(scheduler) = scheduler {
        scheduler.queue_proxy_sync(id).await;
      }
    }
    EntityKind::Vpn => {
      lock(&crate::vpn::VPN_STORAGE)
        .update_sync_fields(&id, true, None)
        .map_err(err_internal)?;
      if let Some(scheduler) = scheduler {
        scheduler.queue_vpn_sync(id).await;
      }
    }
    EntityKind::Group => {
      {
        let manager = lock(&GROUP_MANAGER);
        let mut group = manager
          .get_all_groups()
          .map_err(|e| crate::wrap_backend_error(e, "Failed to read groups"))?
          .into_iter()
          .find(|g| g.id == id)
          .ok_or_else(|| kind.not_found())?;
        group.sync_enabled = true;
        manager
          .update_group_internal(&group)
          .map_err(|e| crate::wrap_backend_error(e, "Failed to save group"))?;
      }
      if let Some(scheduler) = scheduler {
        scheduler.queue_group_sync(id).await;
      }
    }
    EntityKind::Extension => {
      {
        let manager = lock(&EXTENSION_MANAGER);
        let mut ext = manager.get_extension(&id).map_err(|_| kind.not_found())?;
        ext.sync_enabled = true;
        manager
          .update_extension_internal(&ext)
          .map_err(|e| crate::wrap_backend_error(e, "Failed to save extension"))?;
      }
      if let Some(scheduler) = scheduler {
        scheduler.queue_extension_sync(id).await;
      }
    }
    EntityKind::ExtensionGroup => {
      {
        let manager = lock(&EXTENSION_MANAGER);
        let mut group = manager.get_group(&id).map_err(|_| kind.not_found())?;
        group.sync_enabled = true;
        manager
          .update_group_internal(&group)
          .map_err(|e| crate::wrap_backend_error(e, "Failed to save extension group"))?;
      }
      if let Some(scheduler) = scheduler {
        scheduler.queue_extension_group_sync(id).await;
      }
    }
    EntityKind::Template => {
      crate::sync::config_entities::changed_locally::<ProfileTemplate>(&id);
    }
  }
  emit(kind.changed_event());
  Ok(())
}

fn emit(event: &str) {
  if let Err(e) = events::emit_empty(event) {
    log::warn!("Event emit failed event={event} err=\"{e}\"");
  }
}

fn cloud_delete_key(kind: EntityKind, id: &str) -> String {
  format!("{}:{id}", kind.key())
}

/// Delete the cloud copy the way a permanent delete does, keeping the task
/// so a restore can wait for it.
fn spawn_cloud_delete(app_handle: &tauri::AppHandle, kind: EntityKind, id: &str) {
  let app_handle = app_handle.clone();
  let id_owned = id.to_string();
  let task = tauri::async_runtime::spawn(async move {
    let engine = match crate::sync::SyncEngine::create_from_settings(&app_handle).await {
      Ok(engine) => engine,
      Err(e) => {
        log::debug!(
          "Remote delete skipped: sync not configured kind={} id={id_owned} err=\"{e}\"",
          kind.key()
        );
        return;
      }
    };
    let result = match kind {
      EntityKind::Proxy => engine.delete_proxy(&id_owned).await,
      EntityKind::Vpn => engine.delete_vpn(&id_owned).await,
      EntityKind::Group => engine.delete_group(&id_owned).await,
      EntityKind::Extension => engine.delete_extension(&id_owned).await,
      EntityKind::ExtensionGroup => engine.delete_extension_group(&id_owned).await,
      EntityKind::Template => {
        engine
          .delete_config(
            crate::sync::config_entities::ConfigKind::Template,
            &id_owned,
          )
          .await
      }
    };
    if let Err(e) = result {
      log::warn!(
        "Remote delete failed kind={} id={id_owned} err=\"{e}\"",
        kind.key()
      );
    }
  });
  let mut running = lock(&CLOUD_DELETES);
  running.retain(|_, task| !task.inner().is_finished());
  running.insert(cloud_delete_key(kind, id), task);
}

async fn wait_for_cloud_delete(kind: EntityKind, id: &str) {
  let task = lock(&CLOUD_DELETES).remove(&cloud_delete_key(kind, id));
  if let Some(task) = task {
    if let Err(e) = task.await {
      log::warn!(
        "Remote delete task ended abnormally kind={} id={id} err=\"{e}\"",
        kind.key()
      );
    }
  }
}

async fn clear_tombstone(
  app_handle: &tauri::AppHandle,
  kind: EntityKind,
  id: &str,
) -> Result<(), String> {
  let engine = crate::sync::SyncEngine::create_from_settings(app_handle).await?;
  engine
    .delete_config_tombstone(kind.cloud_folder(), id)
    .await
    .map_err(|e| e.to_string())
}

/// Erase every entry. Returns how many were removed.
pub fn purge_all() -> Result<usize, String> {
  let purged = {
    let _guard = lock(&MUTATION);
    purge_all_in(&root())?
  };
  if purged > 0 {
    emit("trash-changed");
  }
  Ok(purged)
}

/// Erase every entry whose retention has run out. Returns how many.
pub fn purge_expired(now: u64, retention_days: u32) -> usize {
  let purged = {
    let _guard = lock(&MUTATION);
    purge_expired_in(&root(), now, retention_days)
  };
  if purged > 0 {
    emit("trash-changed");
  }
  purged
}

async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(work)
    .await
    .map_err(err_internal)?
}

/// Move a proxy, VPN, group, extension, extension group or template to the
/// trash. With the trash off ("Delete at once") it is erased instead.
#[tauri::command]
pub async fn trash_entity(
  app_handle: tauri::AppHandle,
  kind: EntityKind,
  id: String,
) -> Result<TrashOutcome, String> {
  let started = std::time::Instant::now();
  if kind == EntityKind::Vpn {
    refuse_in_use(kind, &id)?;
    // A connection test may hold the tunnel open.
    if let Err(e) = crate::vpn_worker_runner::stop_vpn_worker_by_vpn_id(&id).await {
      log::warn!("VPN worker not stopped before trash vpn={id} err=\"{e}\"");
    }
  }
  let retention_days = crate::profile::trash::retention_days();
  let now = crate::proxy_manager::now_secs();
  let entry_id = id.clone();
  let entry = blocking(move || {
    let _guard = lock(&MUTATION);
    trash_now(&root(), kind, &entry_id, now, retention_days)
  })
  .await
  .inspect_err(|e| {
    log::warn!(
      "Entity trash refused kind={} id={id} err=\"{e}\"",
      kind.key()
    );
  })?;

  if entry.sync_enabled {
    crate::team_activity::record(kind.delete_action(), &id, Some(&entry.name), None);
    if let Some(scheduler) = crate::sync::get_global_scheduler() {
      scheduler.drop_pending_config_sync(kind.key(), &id).await;
    }
    spawn_cloud_delete(&app_handle, kind, &id);
  }
  emit(kind.changed_event());
  if retention_days > 0 {
    emit("trash-changed");
  }
  log::info!(
    "Entity deleted kind={} id={id} mode={} sync_delete={} elapsed_ms={}",
    kind.key(),
    if retention_days > 0 {
      "trashed"
    } else {
      "erased"
    },
    if entry.sync_enabled { "queued" } else { "none" },
    started.elapsed().as_millis()
  );
  Ok(TrashOutcome {
    trashed: retention_days > 0,
  })
}

#[tauri::command]
pub fn list_trashed_entities() -> Result<Vec<TrashedEntitySummary>, String> {
  Ok(summaries(&root(), crate::profile::trash::retention_days()))
}

#[tauri::command]
pub async fn restore_trashed_entity(
  app_handle: tauri::AppHandle,
  kind: EntityKind,
  id: String,
) -> Result<RestoredEntity, String> {
  // The cloud delete writes its tombstone last; it has to land before the
  // restore removes it.
  wait_for_cloud_delete(kind, &id).await;
  let now = crate::proxy_manager::now_secs();
  let entry_id = id.clone();
  let (entry, name, rejoined) = blocking(move || {
    let _guard = lock(&MUTATION);
    restore_now(&root(), kind, &entry_id, now)
  })
  .await?;
  emit(kind.changed_event());
  emit("trash-changed");

  let mut sync_stayed_off = false;
  if entry.sync_enabled {
    let resumed = match clear_tombstone(&app_handle, kind, &id).await {
      Ok(()) => resume_sync(kind, &id).await,
      Err(e) => Err(e),
    };
    match resumed {
      Ok(()) => {
        crate::team_activity::record(kind.restore_action(), &id, Some(&name), None);
      }
      Err(e) => {
        sync_stayed_off = true;
        log::warn!(
          "Restored entity keeps sync off kind={} id={id} err=\"{e}\"",
          kind.key()
        );
      }
    }
  }
  if let Some(scheduler) = crate::sync::get_global_scheduler() {
    for group in rejoined.into_iter().filter(|group| group.sync_enabled) {
      scheduler.queue_extension_group_sync(group.id).await;
    }
  }
  log::info!(
    "Entity restored from trash kind={} id={id} sync={}",
    kind.key(),
    match (entry.sync_enabled, sync_stayed_off) {
      (false, _) => "none",
      (true, false) => "resumed",
      (true, true) => "off",
    }
  );
  Ok(RestoredEntity {
    kind,
    id,
    name,
    sync_stayed_off,
  })
}

#[tauri::command]
pub async fn purge_trashed_entity(kind: EntityKind, id: String) -> Result<(), String> {
  let entry_id = id.clone();
  blocking(move || {
    let _guard = lock(&MUTATION);
    purge_entry(&root(), kind, &entry_id)
  })
  .await?;
  emit("trash-changed");
  log::info!("Trash entry erased kind={} id={id}", kind.key());
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  const NOW: u64 = 1_700_000_000;
  const DAYS: u32 = crate::settings_manager::DEFAULT_TRASH_RETENTION_DAYS;

  /// A data root of its own for this test thread.
  fn data_root() -> (TempDir, crate::app_dirs::TestDirGuard, PathBuf) {
    let dir = TempDir::new().unwrap();
    let guard = crate::app_dirs::set_test_data_dir(dir.path().to_path_buf());
    let trash = entities_root(&dir.path().join("trash"));
    (dir, guard, trash)
  }

  fn new_group(name: &str, sync_enabled: bool) -> ProfileGroup {
    let group = ProfileGroup {
      id: uuid::Uuid::new_v4().to_string(),
      name: name.to_string(),
      bookmarks: Vec::new(),
      sync_enabled,
      last_sync: Some(NOW - 50),
      updated_at: Some(NOW - 100),
    };
    lock(&GROUP_MANAGER).upsert_group_internal(&group).unwrap();
    group
  }

  fn new_proxy(name: &str) -> StoredProxy {
    let proxy = StoredProxy::new(
      name.to_string(),
      crate::browser::ProxySettings {
        proxy_type: "socks5".to_string(),
        host: "127.0.0.1".to_string(),
        port: 1080,
        username: Some("user".to_string()),
        password: Some("pass".to_string()),
        vless_uri: None,
      },
    );
    let file = PROXY_MANAGER.get_proxy_file_path(&proxy.id);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, serde_json::to_string(&proxy).unwrap()).unwrap();
    PROXY_MANAGER.upsert_stored_proxy(proxy.clone());
    proxy
  }

  fn new_extension(name: &str) -> Extension {
    let ext = Extension {
      id: uuid::Uuid::new_v4().to_string(),
      name: name.to_string(),
      manifest_name: None,
      file_name: "ext.zip".to_string(),
      file_type: "zip".to_string(),
      browser_compatibility: vec!["chromium".to_string()],
      created_at: NOW - 100,
      updated_at: NOW - 100,
      sync_enabled: true,
      last_sync: None,
      version: Some("1.2.3".to_string()),
      description: None,
      author: None,
      homepage_url: None,
      source_kind: crate::extension_manager::SOURCE_KIND_ARCHIVE.to_string(),
      linked_path: None,
    };
    let manager = lock(&EXTENSION_MANAGER);
    manager.update_extension_internal(&ext).unwrap();
    let file_dir = manager.get_file_dir_public(&ext.id);
    fs::create_dir_all(&file_dir).unwrap();
    fs::write(file_dir.join("ext.zip"), b"payload").unwrap();
    ext
  }

  #[test]
  fn a_group_round_trips_and_keeps_its_id() {
    let (_dir, _guard, trash) = data_root();
    let group = new_group("Shops", true);

    let entry = trash_now(&trash, EntityKind::Group, &group.id, NOW, DAYS).unwrap();
    assert!(entry.sync_enabled);
    assert!(profile_group(&group.id).unwrap().is_none());
    assert!(holds(&trash, EntityKind::Group, &group.id));

    let listed = summaries(&trash, DAYS);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, EntityKind::Group);
    assert_eq!(listed[0].name, "Shops");
    assert_eq!(listed[0].deleted_at, NOW);
    assert_eq!(listed[0].expires_at, NOW + u64::from(DAYS) * SECS_PER_DAY);
    assert!(listed[0].size_bytes > 0);

    let (restored, name, _) = restore_now(&trash, EntityKind::Group, &group.id, NOW + 5).unwrap();
    assert!(restored.sync_enabled, "the restore turns sync back on");
    assert_eq!(name, "Shops");
    let back = profile_group(&group.id).unwrap().unwrap();
    assert!(
      !back.sync_enabled,
      "sync stays off until the tombstone is gone"
    );
    assert_eq!(back.last_sync, None);
    assert_eq!(back.updated_at, Some(NOW + 5));
    assert!(summaries(&trash, DAYS).is_empty());
    assert!(!trash.join("group").join(&group.id).exists());
  }

  #[test]
  fn a_proxy_comes_back_with_its_credentials_and_history() {
    let (_dir, _guard, trash) = data_root();
    let proxy = new_proxy("Residential");
    let history = proxy_history_path(&proxy.id);
    fs::create_dir_all(history.parent().unwrap()).unwrap();
    fs::write(&history, b"[]").unwrap();

    let entry = trash_now(&trash, EntityKind::Proxy, &proxy.id, NOW, DAYS).unwrap();
    assert_eq!(entry.detail.as_deref(), Some("socks5"));
    assert!(stored_proxy(&proxy.id).is_none());
    assert!(!PROXY_MANAGER.get_proxy_file_path(&proxy.id).exists());
    assert!(!history.exists(), "the check history goes with the proxy");

    restore_now(&trash, EntityKind::Proxy, &proxy.id, NOW + 1).unwrap();
    let back = stored_proxy(&proxy.id).unwrap();
    assert_eq!(back.proxy_settings.password.as_deref(), Some("pass"));
    assert_eq!(back.updated_at, Some(NOW + 1));
    assert!(PROXY_MANAGER.get_proxy_file_path(&proxy.id).is_file());
    assert_eq!(fs::read(&history).unwrap(), b"[]");
    PROXY_MANAGER.remove_from_memory(&proxy.id);
  }

  #[test]
  fn an_extension_takes_its_files_and_rejoins_its_groups() {
    let (_dir, _guard, trash) = data_root();
    let ext = new_extension("Blocker");
    let group = lock(&EXTENSION_MANAGER)
      .create_group("Privacy".to_string())
      .unwrap();
    lock(&EXTENSION_MANAGER)
      .add_extension_to_group(&group.id, &ext.id)
      .unwrap();

    let entry = trash_now(&trash, EntityKind::Extension, &ext.id, NOW, DAYS).unwrap();
    assert_eq!(entry.groups, vec![group.id.clone()]);
    assert_eq!(entry.detail.as_deref(), Some("1.2.3"));
    assert!(lock(&EXTENSION_MANAGER).get_extension(&ext.id).is_err());
    assert!(lock(&EXTENSION_MANAGER)
      .get_group(&group.id)
      .unwrap()
      .extension_ids
      .is_empty());
    assert!(summaries(&trash, DAYS)[0].size_bytes > 7);

    let (_, _, rejoined) = restore_now(&trash, EntityKind::Extension, &ext.id, NOW + 9).unwrap();
    assert_eq!(rejoined.len(), 1);
    let manager = lock(&EXTENSION_MANAGER);
    let back = manager.get_extension(&ext.id).unwrap();
    assert!(!back.sync_enabled);
    assert_eq!(back.updated_at, NOW + 9);
    assert_eq!(
      fs::read(manager.get_file_dir_public(&ext.id).join("ext.zip")).unwrap(),
      b"payload"
    );
    let group = manager.get_group(&group.id).unwrap();
    assert_eq!(group.extension_ids, vec![ext.id.clone()]);
    assert_eq!(group.updated_at, NOW + 9);
  }

  #[test]
  fn an_extension_group_and_a_template_round_trip() {
    let (_dir, _guard, trash) = data_root();
    let group = lock(&EXTENSION_MANAGER)
      .create_group("Work".to_string())
      .unwrap();
    trash_now(&trash, EntityKind::ExtensionGroup, &group.id, NOW, DAYS).unwrap();
    assert!(lock(&EXTENSION_MANAGER).get_group(&group.id).is_err());
    restore_now(&trash, EntityKind::ExtensionGroup, &group.id, NOW).unwrap();
    assert_eq!(
      lock(&EXTENSION_MANAGER).get_group(&group.id).unwrap().name,
      "Work"
    );

    let template = ProfileTemplate {
      id: uuid::Uuid::new_v4().to_string(),
      name: "Mail".to_string(),
      settings: Default::default(),
      position: 3,
      updated_at: NOW - 10,
    };
    assert!(crate::profile_templates::restore_from_trash(template.clone()).unwrap());
    trash_now(&trash, EntityKind::Template, &template.id, NOW, DAYS).unwrap();
    assert!(crate::profile_templates::get(&template.id).is_err());
    restore_now(&trash, EntityKind::Template, &template.id, NOW + 2).unwrap();
    let back = crate::profile_templates::get(&template.id).unwrap();
    assert_eq!(back.position, 3);
    assert_eq!(back.updated_at, NOW + 2);
  }

  #[test]
  fn a_restore_takes_a_free_name_and_refuses_a_live_id() {
    let (_dir, _guard, trash) = data_root();
    let group = new_group("Shops", false);
    trash_now(&trash, EntityKind::Group, &group.id, NOW, DAYS).unwrap();
    new_group("shops", false);
    let (_, name, _) = restore_now(&trash, EntityKind::Group, &group.id, NOW).unwrap();
    assert_eq!(name, "Shops (restored)");

    trash_now(&trash, EntityKind::Group, &group.id, NOW, DAYS).unwrap();
    lock(&GROUP_MANAGER).upsert_group_internal(&group).unwrap();
    let err = restore_now(&trash, EntityKind::Group, &group.id, NOW).unwrap_err();
    assert!(err.contains("TRASH_RESTORE_CONFLICT"), "{err}");
    assert!(
      holds(&trash, EntityKind::Group, &group.id),
      "the entry stays"
    );
  }

  #[test]
  fn purge_and_expiry_erase_entries() {
    let (_dir, _guard, trash) = data_root();
    let old = new_group("Old", false);
    let fresh = new_group("Fresh", false);
    trash_now(&trash, EntityKind::Group, &old.id, NOW, DAYS).unwrap();
    trash_now(
      &trash,
      EntityKind::Group,
      &fresh.id,
      NOW + SECS_PER_DAY,
      DAYS,
    )
    .unwrap();
    assert_eq!(summaries(&trash, DAYS)[0].name, "Fresh", "newest first");

    let old_expiry = NOW + u64::from(DAYS) * SECS_PER_DAY;
    assert_eq!(purge_expired_in(&trash, old_expiry - 1, DAYS), 0);
    assert_eq!(purge_expired_in(&trash, old_expiry, DAYS), 1);
    assert!(!holds(&trash, EntityKind::Group, &old.id));
    assert!(holds(&trash, EntityKind::Group, &fresh.id));

    purge_entry(&trash, EntityKind::Group, &fresh.id).unwrap();
    let err = purge_entry(&trash, EntityKind::Group, &fresh.id).unwrap_err();
    assert!(err.contains("TRASH_ENTRY_NOT_FOUND"), "{err}");

    let third = new_group("Third", false);
    trash_now(&trash, EntityKind::Group, &third.id, NOW, DAYS).unwrap();
    assert_eq!(purge_all_in(&trash).unwrap(), 1);
    assert!(summaries(&trash, DAYS).is_empty());
  }

  #[test]
  fn zero_days_erases_at_once() {
    let (_dir, _guard, trash) = data_root();
    let group = new_group("Gone", true);
    let entry = trash_now(&trash, EntityKind::Group, &group.id, NOW, 0).unwrap();
    assert!(entry.sync_enabled, "the cloud delete still runs");
    assert!(profile_group(&group.id).unwrap().is_none());
    assert!(!trash.join("group").join(&group.id).exists());
  }

  #[test]
  fn a_missing_entity_or_entry_reports_its_code() {
    let (dir, _guard, trash) = data_root();
    let err = trash_now(&trash, EntityKind::Group, "missing", NOW, DAYS).unwrap_err();
    assert!(err.contains("GROUP_NOT_FOUND"), "{err}");
    assert!(!trash.join("group").join("missing").exists());
    let err = trash_now(&trash, EntityKind::Proxy, "missing", NOW, DAYS).unwrap_err();
    assert!(err.contains("PROXY_NOT_FOUND"), "{err}");
    let err = restore_now(&trash, EntityKind::Vpn, "missing", NOW).unwrap_err();
    assert!(err.contains("TRASH_ENTRY_NOT_FOUND"), "{err}");

    fs::create_dir_all(dir.path().join("keep")).unwrap();
    let err = purge_entry(&trash, EntityKind::Group, "..").unwrap_err();
    assert!(err.contains("TRASH_ENTRY_NOT_FOUND"), "{err}");
    assert!(dir.path().join("keep").exists());
  }

  #[test]
  fn an_unreadable_entry_is_skipped() {
    let (_dir, _guard, trash) = data_root();
    let group = new_group("Good", false);
    trash_now(&trash, EntityKind::Group, &group.id, NOW, DAYS).unwrap();
    let broken = trash.join("proxy").join("broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join(ENTRY_FILE), b"not json").unwrap();
    let listed = summaries(&trash, DAYS);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Good");
  }

  #[test]
  fn kinds_use_the_cloud_folders_sync_uses() {
    assert_eq!(EntityKind::Template.cloud_folder(), "templates");
    assert_eq!(
      EntityKind::ExtensionGroup.cloud_folder(),
      "extension_groups"
    );
    assert_eq!(
      serde_json::to_string(&EntityKind::ExtensionGroup).unwrap(),
      "\"extension_group\""
    );
    for kind in EntityKind::ALL {
      assert_eq!(
        serde_json::to_value(kind).unwrap().as_str(),
        Some(kind.key())
      );
    }
  }
}
