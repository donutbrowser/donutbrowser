//! Encrypted storage for VPN configurations.

use super::config::{VpnConfig, VpnError, VpnType};
use aes_gcm::{
  aead::{Aead, KeyInit},
  Aes256Gcm, Nonce,
};
use chrono::Utc;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// Storage format version for migration support
const STORAGE_VERSION: u32 = 1;

/// Stored VPN configs container
#[derive(Debug, Serialize, Deserialize)]
struct VpnStorageData {
  version: u32,
  configs: Vec<StoredVpnConfig>,
}

/// Encrypted VPN config as stored on disk
#[derive(Debug, Serialize, Deserialize)]
struct StoredVpnConfig {
  id: String,
  name: String,
  vpn_type: VpnType,
  encrypted_data: String, // Base64 encoded encrypted config
  nonce: String,          // Base64 encoded nonce
  created_at: i64,
  last_used: Option<i64>,
  #[serde(default)]
  sync_enabled: bool,
  #[serde(default)]
  last_sync: Option<u64>,
  #[serde(default)]
  updated_at: Option<u64>,
}

const KEY_FILE: &str = ".vpn_key";
const KEY_BACKUP_FILE: &str = ".vpn_key.bak";

/// VPN storage manager with encryption
pub struct VpnStorage {
  storage_path: PathBuf,
  key_dir: PathBuf,
  /// Read on first use and kept. A key that cannot be read is not cached, so
  /// a passing read error does not last until the app restarts.
  encryption_key: Mutex<Option<[u8; 32]>>,
}

impl Default for VpnStorage {
  fn default() -> Self {
    Self::new()
  }
}

/// Read a key file. `None` when it is missing, unreadable or the wrong size.
fn read_key_file(path: &Path) -> Option<[u8; 32]> {
  fs::read(path)
    .ok()
    .and_then(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).ok())
}

/// Write a key owner-only to a temporary file, flush it, then rename it into
/// place, so a crash never leaves a half-written key behind.
fn write_key_file(path: &Path, key: &[u8; 32]) -> std::io::Result<()> {
  use std::io::Write;
  let file_name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default();
  let tmp = path.with_file_name(format!("{file_name}.tmp"));
  let mut file = crate::app_dirs::create_owner_only(&tmp)?;
  file.write_all(key)?;
  file.sync_all()?;
  drop(file);
  fs::rename(&tmp, path)
}

/// The key that seals every stored config, from `dir`.
///
/// A key is made only when neither the key file nor its backup exists. A key
/// file that exists but cannot be read, or has the wrong size, is never
/// replaced: every stored config is sealed with it, and a new key would make
/// all of them unreadable for good. The backup stands in for it when it is
/// valid.
fn load_or_create_key(dir: &Path) -> Result<[u8; 32], VpnError> {
  let key_path = dir.join(KEY_FILE);
  let backup_path = dir.join(KEY_BACKUP_FILE);
  let fault = match fs::read(&key_path) {
    Ok(bytes) => match <[u8; 32]>::try_from(bytes.as_slice()) {
      Ok(key) => {
        if !backup_path.exists() {
          if let Err(e) = write_key_file(&backup_path, &key) {
            log::warn!("VPN key backup not written err=\"{e}\"");
          }
        }
        return Ok(key);
      }
      Err(_) => format!("size={}", bytes.len()),
    },
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      if let Some(key) = read_key_file(&backup_path) {
        write_key_file(&key_path, &key).map_err(VpnError::Io)?;
        log::warn!("VPN key missing, restored from backup");
        return Ok(key);
      }
      let key: [u8; 32] = rand::rng().random();
      fs::create_dir_all(dir).map_err(VpnError::Io)?;
      write_key_file(&key_path, &key).map_err(VpnError::Io)?;
      if let Err(e) = write_key_file(&backup_path, &key) {
        log::warn!("VPN key backup not written err=\"{e}\"");
      }
      log::info!("VPN key created");
      return Ok(key);
    }
    Err(e) => format!("err=\"{e}\""),
  };
  if let Some(key) = read_key_file(&backup_path) {
    log::warn!("VPN key unreadable, using its backup {fault}");
    return Ok(key);
  }
  log::error!("VPN key unreadable and kept as is; stored VPN configs cannot be opened {fault}");
  Err(VpnError::KeyUnreadable)
}

impl VpnStorage {
  /// Create a new VPN storage manager
  pub fn new() -> Self {
    let storage_path = Self::get_storage_path();
    Self {
      storage_path,
      key_dir: crate::app_dirs::vpn_dir(),
      encryption_key: Mutex::new(None),
    }
  }

  /// Create a VPN storage manager with a custom storage directory
  pub fn with_dir(dir: &Path) -> Self {
    Self {
      storage_path: dir.join("vpn_configs.json"),
      key_dir: dir.to_path_buf(),
      encryption_key: Mutex::new(None),
    }
  }

  /// Get the storage file path
  fn get_storage_path() -> PathBuf {
    let vpn_dir = crate::app_dirs::vpn_dir();
    if !vpn_dir.exists() {
      let _ = fs::create_dir_all(&vpn_dir);
    }
    Self::migrate_from_old_location(&vpn_dir);
    vpn_dir.join("vpn_configs.json")
  }

  fn key(&self) -> Result<[u8; 32], VpnError> {
    let mut cached = self
      .encryption_key
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(key) = *cached {
      return Ok(key);
    }
    let key = load_or_create_key(&self.key_dir)?;
    *cached = Some(key);
    Ok(key)
  }

  /// Migrate VPN configs from the old ProjectDirs location to the new app_dirs location.
  fn migrate_from_old_location(new_dir: &Path) {
    let old_dir = match directories::ProjectDirs::from("com", "donut", "donutbrowser") {
      Some(dirs) => dirs.data_local_dir().to_path_buf(),
      None => return,
    };

    for filename in &["vpn_configs.json", ".vpn_key"] {
      let old_path = old_dir.join(filename);
      let new_path = new_dir.join(filename);
      if old_path.exists() && !new_path.exists() {
        let _ = fs::copy(&old_path, &new_path);
      }
    }
  }

  /// Load storage data from disk
  fn load_storage(&self) -> Result<VpnStorageData, VpnError> {
    if !self.storage_path.exists() {
      return Ok(VpnStorageData {
        version: STORAGE_VERSION,
        configs: Vec::new(),
      });
    }

    let content = fs::read_to_string(&self.storage_path)
      .map_err(|e| VpnError::Storage(format!("Failed to read storage file: {e}")))?;

    // Drop entries whose vpn_type isn't recognized by the current build (e.g.
    // legacy "OpenVPN" entries after support was removed). Filtering at JSON
    // level keeps the rest of the file deserializable instead of the whole
    // load failing on a single unknown variant.
    let mut value: serde_json::Value = serde_json::from_str(&content)
      .map_err(|e| VpnError::Storage(format!("Failed to parse storage file: {e}")))?;
    if let Some(arr) = value.get_mut("configs").and_then(|v| v.as_array_mut()) {
      arr.retain(|c| c.get("vpn_type").and_then(|t| t.as_str()) == Some("WireGuard"));
    }

    serde_json::from_value(value)
      .map_err(|e| VpnError::Storage(format!("Failed to parse storage file: {e}")))
  }

  /// Save storage data to disk
  fn save_storage(&self, data: &VpnStorageData) -> Result<(), VpnError> {
    let content = serde_json::to_string_pretty(data)
      .map_err(|e| VpnError::Storage(format!("Failed to serialize storage: {e}")))?;

    fs::write(&self.storage_path, content)
      .map_err(|e| VpnError::Storage(format!("Failed to write storage file: {e}")))?;

    Ok(())
  }

  /// Encrypt config data
  fn encrypt(&self, data: &str) -> Result<(String, String), VpnError> {
    let cipher = Aes256Gcm::new_from_slice(&self.key()?)
      .map_err(|e| VpnError::Encryption(format!("Failed to create cipher: {e}")))?;

    let nonce_bytes: [u8; 12] = rand::rng().random();
    let nonce = Nonce::from(nonce_bytes);

    let ciphertext = cipher
      .encrypt(&nonce, data.as_bytes())
      .map_err(|e| VpnError::Encryption(format!("Encryption failed: {e}")))?;

    Ok((
      base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &ciphertext),
      base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce_bytes),
    ))
  }

  /// Decrypt config data
  fn decrypt(&self, encrypted_data: &str, nonce_str: &str) -> Result<String, VpnError> {
    let cipher = Aes256Gcm::new_from_slice(&self.key()?)
      .map_err(|e| VpnError::Encryption(format!("Failed to create cipher: {e}")))?;

    let ciphertext =
      base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encrypted_data)
        .map_err(|e| VpnError::Encryption(format!("Failed to decode ciphertext: {e}")))?;

    let nonce_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, nonce_str)
      .map_err(|e| VpnError::Encryption(format!("Failed to decode nonce: {e}")))?;

    let nonce = Nonce::try_from(nonce_bytes.as_slice())
      .map_err(|_| VpnError::Encryption("Invalid nonce length".to_string()))?;

    let plaintext = cipher
      .decrypt(&nonce, ciphertext.as_ref())
      .map_err(|e| VpnError::Encryption(format!("Decryption failed: {e}")))?;

    String::from_utf8(plaintext)
      .map_err(|e| VpnError::Encryption(format!("Failed to decode plaintext: {e}")))
  }

  /// Save a VPN configuration
  pub fn save_config(&self, config: &VpnConfig) -> Result<(), VpnError> {
    let mut storage = self.load_storage()?;

    // Encrypt the config data
    let (encrypted_data, nonce) = self.encrypt(&config.config_data)?;

    let stored = StoredVpnConfig {
      id: config.id.clone(),
      name: config.name.clone(),
      vpn_type: config.vpn_type,
      encrypted_data,
      nonce,
      created_at: config.created_at,
      last_used: config.last_used,
      sync_enabled: config.sync_enabled,
      last_sync: config.last_sync,
      updated_at: config.updated_at,
    };

    // Update existing or add new
    if let Some(pos) = storage.configs.iter().position(|c| c.id == config.id) {
      storage.configs[pos] = stored;
    } else {
      storage.configs.push(stored);
    }

    self.save_storage(&storage)
  }

  /// Load a VPN configuration by ID
  pub fn load_config(&self, id: &str) -> Result<VpnConfig, VpnError> {
    let storage = self.load_storage()?;

    let stored = storage
      .configs
      .iter()
      .find(|c| c.id == id)
      .ok_or_else(|| VpnError::NotFound(id.to_string()))?;

    let config_data = self.decrypt(&stored.encrypted_data, &stored.nonce)?;

    Ok(VpnConfig {
      id: stored.id.clone(),
      name: stored.name.clone(),
      vpn_type: stored.vpn_type,
      config_data,
      created_at: stored.created_at,
      last_used: stored.last_used,
      sync_enabled: stored.sync_enabled,
      last_sync: stored.last_sync,
      updated_at: stored.updated_at,
    })
  }

  /// List all VPN configurations (without decrypted config data)
  pub fn list_configs(&self) -> Result<Vec<VpnConfig>, VpnError> {
    let storage = self.load_storage()?;

    Ok(
      storage
        .configs
        .iter()
        .map(|stored| VpnConfig {
          id: stored.id.clone(),
          name: stored.name.clone(),
          vpn_type: stored.vpn_type,
          config_data: String::new(), // Don't include config data in list
          created_at: stored.created_at,
          last_used: stored.last_used,
          sync_enabled: stored.sync_enabled,
          last_sync: stored.last_sync,
          updated_at: stored.updated_at,
        })
        .collect(),
    )
  }

  /// Delete a VPN configuration
  pub fn delete_config(&self, id: &str) -> Result<(), VpnError> {
    let mut storage = self.load_storage()?;

    let initial_len = storage.configs.len();
    storage.configs.retain(|c| c.id != id);

    if storage.configs.len() == initial_len {
      return Err(VpnError::NotFound(id.to_string()));
    }

    self.save_storage(&storage)
  }

  /// Remove a config and return it as stored, still sealed with the key, so
  /// the trash never holds a WireGuard private key in the clear.
  pub fn take_sealed(&self, id: &str) -> Result<serde_json::Value, VpnError> {
    let mut storage = self.load_storage()?;
    let position = storage
      .configs
      .iter()
      .position(|c| c.id == id)
      .ok_or_else(|| VpnError::NotFound(id.to_string()))?;
    let stored = storage.configs.remove(position);
    let sealed = serde_json::to_value(&stored)
      .map_err(|e| VpnError::Storage(format!("Failed to serialize config: {e}")))?;
    self.save_storage(&storage)?;
    Ok(sealed)
  }

  /// Put back a config `take_sealed` returned, under its own id, with the
  /// name, sync switch and edit time given. `false`, and nothing written,
  /// when a config with that id already exists.
  pub fn put_sealed(
    &self,
    sealed: serde_json::Value,
    name: &str,
    sync_enabled: bool,
    updated_at: u64,
  ) -> Result<bool, VpnError> {
    let mut stored: StoredVpnConfig = serde_json::from_value(sealed)
      .map_err(|e| VpnError::Storage(format!("Failed to parse config: {e}")))?;
    let mut storage = self.load_storage()?;
    if storage.configs.iter().any(|c| c.id == stored.id) {
      return Ok(false);
    }
    stored.name = name.to_string();
    stored.sync_enabled = sync_enabled;
    stored.last_sync = None;
    stored.updated_at = Some(updated_at);
    storage.configs.push(stored);
    self.save_storage(&storage)?;
    Ok(true)
  }

  /// Update last_used timestamp
  pub fn update_last_used(&self, id: &str) -> Result<(), VpnError> {
    let mut storage = self.load_storage()?;

    if let Some(config) = storage.configs.iter_mut().find(|c| c.id == id) {
      config.last_used = Some(Utc::now().timestamp());
      self.save_storage(&storage)
    } else {
      Err(VpnError::NotFound(id.to_string()))
    }
  }

  /// Refuse a config that declares more peers than a tunnel can carry.
  ///
  /// A stored config is re-parsed at connect time into a single-peer tunnel, so
  /// a file with several `[Peer]` blocks silently routes through whichever peer
  /// is listed last and surfaces only as an opaque handshake timeout. Every way
  /// a config gets in (manual create, file import, sync download) refuses one;
  /// configs already on disk keep connecting exactly as before.
  pub fn ensure_single_peer(vpn_type: VpnType, content: &str) -> Result<(), VpnError> {
    let peers = match vpn_type {
      VpnType::WireGuard => super::config::wireguard_peer_count(content),
    };
    if peers > 1 {
      return Err(VpnError::InvalidWireGuard(format!(
        "Config declares {peers} [Peer] sections; exactly one peer is supported"
      )));
    }
    Ok(())
  }

  /// Create a VPN config manually from validated data
  pub fn create_config_manual(
    &self,
    name: &str,
    vpn_type: VpnType,
    config_data: &str,
  ) -> Result<VpnConfig, VpnError> {
    match vpn_type {
      VpnType::WireGuard => {
        super::parse_wireguard_config(config_data)?;
      }
    }
    Self::ensure_single_peer(vpn_type, config_data)?;

    let id = Uuid::new_v4().to_string();
    let sync_enabled = crate::sync::is_sync_configured();

    let config = VpnConfig {
      id,
      name: name.to_string(),
      vpn_type,
      config_data: config_data.to_string(),
      created_at: Utc::now().timestamp(),
      last_used: None,
      sync_enabled,
      last_sync: None,
      updated_at: Some(crate::proxy_manager::now_secs()),
    };

    self.save_config(&config)?;

    Ok(config)
  }

  /// Update the name of an existing VPN config
  pub fn update_config_name(&self, id: &str, new_name: &str) -> Result<VpnConfig, VpnError> {
    let mut config = self.load_config(id)?;
    config.name = new_name.to_string();
    config.updated_at = Some(crate::proxy_manager::now_secs());
    self.save_config(&config)?;
    Ok(config)
  }

  /// Update sync fields on a VPN config
  pub fn update_sync_fields(
    &self,
    id: &str,
    sync_enabled: bool,
    last_sync: Option<u64>,
  ) -> Result<(), VpnError> {
    let mut storage = self.load_storage()?;

    if let Some(config) = storage.configs.iter_mut().find(|c| c.id == id) {
      config.sync_enabled = sync_enabled;
      config.last_sync = last_sync;
      self.save_storage(&storage)
    } else {
      Err(VpnError::NotFound(id.to_string()))
    }
  }

  /// Import a VPN config from raw content
  pub fn import_config(
    &self,
    content: &str,
    filename: &str,
    name: Option<String>,
  ) -> Result<VpnConfig, VpnError> {
    let vpn_type = super::detect_vpn_type(content, filename)?;

    match vpn_type {
      VpnType::WireGuard => {
        super::parse_wireguard_config(content)?;
      }
    }
    Self::ensure_single_peer(vpn_type, content)?;

    let id = Uuid::new_v4().to_string();
    let display_name = name.unwrap_or_else(|| {
      let base = filename.trim_end_matches(".conf");
      format!("{} ({})", base, vpn_type)
    });
    let sync_enabled = crate::sync::is_sync_configured();

    let config = VpnConfig {
      id,
      name: display_name,
      vpn_type,
      config_data: content.to_string(),
      created_at: Utc::now().timestamp(),
      last_used: None,
      sync_enabled,
      last_sync: None,
      updated_at: Some(crate::proxy_manager::now_secs()),
    };

    self.save_config(&config)?;

    Ok(config)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  fn create_test_storage() -> (VpnStorage, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let storage = VpnStorage::with_dir(temp_dir.path());
    (storage, temp_dir)
  }

  #[test]
  fn test_encrypt_decrypt_roundtrip() {
    let (storage, _temp) = create_test_storage();
    let original = "This is a secret VPN configuration";

    let (encrypted, nonce) = storage.encrypt(original).unwrap();
    let decrypted = storage.decrypt(&encrypted, &nonce).unwrap();

    assert_eq!(original, decrypted);
  }

  #[test]
  fn test_save_and_load_config() {
    let (storage, _temp) = create_test_storage();

    let config = VpnConfig {
      id: "test-id-123".to_string(),
      name: "Test VPN".to_string(),
      vpn_type: VpnType::WireGuard,
      config_data: "[Interface]\nPrivateKey = test\n[Peer]\nPublicKey = peer".to_string(),
      created_at: 1234567890,
      last_used: None,
      sync_enabled: false,
      last_sync: None,
      updated_at: None,
    };

    storage.save_config(&config).unwrap();
    let loaded = storage.load_config("test-id-123").unwrap();

    assert_eq!(loaded.id, config.id);
    assert_eq!(loaded.name, config.name);
    assert_eq!(loaded.vpn_type, config.vpn_type);
    assert_eq!(loaded.config_data, config.config_data);
  }

  #[test]
  fn test_list_configs() {
    let (storage, _temp) = create_test_storage();

    let config1 = VpnConfig {
      id: "id-1".to_string(),
      name: "VPN 1".to_string(),
      vpn_type: VpnType::WireGuard,
      config_data: "secret1".to_string(),
      created_at: 1000,
      last_used: None,
      sync_enabled: false,
      last_sync: None,
      updated_at: None,
    };

    let config2 = VpnConfig {
      id: "id-2".to_string(),
      name: "VPN 2".to_string(),
      vpn_type: VpnType::WireGuard,
      config_data: "secret2".to_string(),
      created_at: 2000,
      last_used: Some(3000),
      sync_enabled: false,
      last_sync: None,
      updated_at: None,
    };

    storage.save_config(&config1).unwrap();
    storage.save_config(&config2).unwrap();

    let configs = storage.list_configs().unwrap();
    assert_eq!(configs.len(), 2);

    // Config data should be empty in listing
    assert!(configs[0].config_data.is_empty());
    assert!(configs[1].config_data.is_empty());
  }

  #[test]
  fn test_delete_config() {
    let (storage, _temp) = create_test_storage();

    let config = VpnConfig {
      id: "delete-me".to_string(),
      name: "To Delete".to_string(),
      vpn_type: VpnType::WireGuard,
      config_data: "data".to_string(),
      created_at: 1000,
      last_used: None,
      sync_enabled: false,
      last_sync: None,
      updated_at: None,
    };

    storage.save_config(&config).unwrap();
    assert!(storage.load_config("delete-me").is_ok());

    storage.delete_config("delete-me").unwrap();
    assert!(storage.load_config("delete-me").is_err());
  }

  fn sample_config(id: &str) -> VpnConfig {
    VpnConfig {
      id: id.to_string(),
      name: "Office".to_string(),
      vpn_type: VpnType::WireGuard,
      config_data: "[Interface]\nPrivateKey = secret\n[Peer]\nPublicKey = peer".to_string(),
      created_at: 1000,
      last_used: None,
      sync_enabled: true,
      last_sync: Some(5),
      updated_at: Some(10),
    }
  }

  #[test]
  fn a_new_key_is_written_once_with_a_backup() {
    let temp = TempDir::new().unwrap();
    let first = VpnStorage::with_dir(temp.path());
    first.save_config(&sample_config("a")).unwrap();
    let key = fs::read(temp.path().join(KEY_FILE)).unwrap();
    assert_eq!(key.len(), 32);
    assert_eq!(fs::read(temp.path().join(KEY_BACKUP_FILE)).unwrap(), key);
    assert!(!temp.path().join(".vpn_key.tmp").exists());

    let second = VpnStorage::with_dir(temp.path());
    assert_eq!(
      second.load_config("a").unwrap().config_data,
      sample_config("a").config_data
    );
    assert_eq!(fs::read(temp.path().join(KEY_FILE)).unwrap(), key);
  }

  #[test]
  fn a_short_key_is_never_replaced() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join(KEY_FILE), b"short").unwrap();
    let storage = VpnStorage::with_dir(temp.path());
    let err = storage.save_config(&sample_config("a")).unwrap_err();
    assert!(matches!(err, VpnError::KeyUnreadable), "{err}");
    assert!(err.to_string().contains("VPN_KEY_UNREADABLE"));
    assert_eq!(fs::read(temp.path().join(KEY_FILE)).unwrap(), b"short");
    assert!(!temp.path().join(KEY_BACKUP_FILE).exists());
  }

  #[test]
  fn an_unreadable_key_file_is_kept() {
    let temp = TempDir::new().unwrap();
    // A directory in the key's place makes every read fail.
    fs::create_dir_all(temp.path().join(KEY_FILE).join("inner")).unwrap();
    let storage = VpnStorage::with_dir(temp.path());
    let err = storage.save_config(&sample_config("a")).unwrap_err();
    assert!(matches!(err, VpnError::KeyUnreadable), "{err}");
    assert!(temp.path().join(KEY_FILE).join("inner").is_dir());
  }

  #[test]
  fn the_backup_opens_configs_when_the_key_is_damaged_or_gone() {
    let temp = TempDir::new().unwrap();
    VpnStorage::with_dir(temp.path())
      .save_config(&sample_config("a"))
      .unwrap();
    let key = fs::read(temp.path().join(KEY_FILE)).unwrap();

    fs::write(temp.path().join(KEY_FILE), b"damaged").unwrap();
    let storage = VpnStorage::with_dir(temp.path());
    assert!(storage.load_config("a").is_ok());
    assert_eq!(fs::read(temp.path().join(KEY_FILE)).unwrap(), b"damaged");

    fs::remove_file(temp.path().join(KEY_FILE)).unwrap();
    let storage = VpnStorage::with_dir(temp.path());
    assert!(storage.load_config("a").is_ok());
    assert_eq!(fs::read(temp.path().join(KEY_FILE)).unwrap(), key);
  }

  #[test]
  fn listing_needs_no_key() {
    let temp = TempDir::new().unwrap();
    VpnStorage::with_dir(temp.path())
      .save_config(&sample_config("a"))
      .unwrap();
    fs::write(temp.path().join(KEY_FILE), b"short").unwrap();
    fs::remove_file(temp.path().join(KEY_BACKUP_FILE)).unwrap();
    let storage = VpnStorage::with_dir(temp.path());
    assert_eq!(storage.list_configs().unwrap().len(), 1);
    assert!(matches!(
      storage.load_config("a").unwrap_err(),
      VpnError::KeyUnreadable
    ));
  }

  #[test]
  fn a_sealed_config_comes_back_intact() {
    let (storage, _temp) = create_test_storage();
    storage.save_config(&sample_config("a")).unwrap();
    let sealed = storage.take_sealed("a").unwrap();
    assert!(storage.load_config("a").is_err());
    assert!(!sealed.to_string().contains("secret"));

    assert!(storage
      .put_sealed(sealed.clone(), "Office (restored)", false, 99)
      .unwrap());
    let back = storage.load_config("a").unwrap();
    assert_eq!(back.name, "Office (restored)");
    assert_eq!(back.config_data, sample_config("a").config_data);
    assert!(!back.sync_enabled);
    assert_eq!(back.last_sync, None);
    assert_eq!(back.updated_at, Some(99));
    assert!(!storage.put_sealed(sealed, "Office", false, 100).unwrap());
    assert!(matches!(
      storage.take_sealed("missing").unwrap_err(),
      VpnError::NotFound(_)
    ));
  }

  #[test]
  fn test_load_nonexistent_config() {
    let (storage, _temp) = create_test_storage();
    let result = storage.load_config("nonexistent");
    assert!(result.is_err());
  }

  #[test]
  fn test_ensure_single_peer() {
    let single = "[Interface]\nPrivateKey = k\n\n[Peer]\nPublicKey = p\n";
    let multi = "[Interface]\nPrivateKey = k\n\n[Peer]\nPublicKey = p\n\n[Peer]\nPublicKey = q\n";

    assert!(VpnStorage::ensure_single_peer(VpnType::WireGuard, single).is_ok());
    // A listing hands out an empty config body; it declares no peer to reject.
    assert!(VpnStorage::ensure_single_peer(VpnType::WireGuard, "").is_ok());

    let err = VpnStorage::ensure_single_peer(VpnType::WireGuard, multi).unwrap_err();
    assert!(err.to_string().contains("[Peer]"));
  }

  #[test]
  fn test_import_config_rejects_multi_peer() {
    let (storage, _temp) = create_test_storage();
    let content = concat!(
      "[Interface]\n",
      "PrivateKey = YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=\n",
      "Address = 10.0.0.2/24\n",
      "\n",
      "[Peer]\n",
      "PublicKey = YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI=\n",
      "Endpoint = a.example.com:51820\n",
      "\n",
      "[Peer]\n",
      "PublicKey = Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2M=\n",
      "Endpoint = b.example.com:51820\n",
    );

    // Every field parses; the file is refused only because a tunnel built from
    // it would silently use the second peer.
    assert!(crate::vpn::parse_wireguard_config(content).is_ok());
    let imported = storage.import_config(content, "two-peers.conf", None);
    assert!(imported.is_err());
  }
}
