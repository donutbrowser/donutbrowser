//! One account's chat sync on this device: what it keeps (the device id and
//! the chat key, sealed; the cursor and the rev of each synced chat; the
//! deletes not yet sent) and one round of keys, deletes, listing and uploads.

use super::crypto::{ChatKey, DeviceKey};
use super::remote::Remote;
use crate::agent_tasks::chat::Chat;
use crate::cloud_errors::BackendFailure;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const SECRETS_MAGIC: &[u8; 6] = b"DBCHK\x01";

/// What sync reads of a chat on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
  pub id: String,
  pub updated_at: u64,
  /// A turn is running, here or on another device.
  pub active: bool,
}

/// What became of a chat from another device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Merge {
  /// It replaced this device's copy.
  Take,
  /// This device's copy stays and goes up.
  Keep,
  /// Both are the same change.
  Same,
}

/// The chats on this device, as sync sees them.
#[async_trait]
pub trait Local: Send + Sync {
  fn stamps(&self) -> Vec<Stamp>;
  fn get(&self, id: &str) -> Option<Chat>;
  /// A chat from another device, which replaces this copy unless this copy
  /// wins (`records::merge`).
  fn offer(&self, chat: Chat) -> Merge;
  /// Delete a chat another device deleted, and stop its turn.
  async fn remove(&self, id: &str);
  fn profile_names(&self) -> HashMap<String, String>;
  /// Chats came or went.
  fn listed(&self);
}

/// The server's rev of a chat and the `updatedAt` it holds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
  pub rev: i64,
  pub updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
  /// Set when a listing finished; a pass in progress is never kept.
  pub cursor: Option<String>,
  /// The chats on the server as this device last saw them.
  pub chats: BTreeMap<String, Synced>,
}

/// What never leaves this device in the clear.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Secrets {
  account: String,
  device_id: String,
  #[serde(default)]
  key_id: Option<String>,
  #[serde(default)]
  key: Option<String>,
}

/// Where one install keeps its sync files.
pub struct Files {
  pub dir: PathBuf,
}

impl Files {
  fn key_file(&self) -> PathBuf {
    self.dir.join("key.dat")
  }

  fn state(&self) -> PathBuf {
    self.dir.join("state.json")
  }

  pub fn deletes(&self) -> PathBuf {
    self.dir.join("deletes.json")
  }

  fn load_secrets(&self) -> Option<Secrets> {
    match crate::vault::open(&self.key_file(), SECRETS_MAGIC) {
      Ok(Some(text)) => serde_json::from_str(&text).ok(),
      Ok(None) => None,
      Err(e) => {
        log::warn!("Agent chat sync key unreadable err=\"{e}\"");
        None
      }
    }
  }

  fn save_secrets(&self, secrets: &Secrets) {
    let Ok(text) = serde_json::to_string(secrets) else {
      return;
    };
    if let Err(e) = crate::vault::seal(&self.key_file(), SECRETS_MAGIC, &text) {
      log::warn!("Agent chat sync key save failed err=\"{e}\"");
    }
  }

  fn load_state(&self) -> State {
    std::fs::read(self.state())
      .ok()
      .and_then(|bytes| serde_json::from_slice(&bytes).ok())
      .unwrap_or_default()
  }

  fn save_state(&self, state: &State) {
    let Ok(bytes) = serde_json::to_vec(state) else {
      return;
    };
    if let Err(e) = crate::profile::encryption::atomic_write(&self.state(), &bytes) {
      log::warn!("Agent chat sync state save failed err=\"{e}\"");
    }
  }
}

/// Chats deleted here whose delete the server has not taken yet. Kept on
/// disk at once, so a delete made just before the app quits still goes out.
pub struct Deletes {
  ids: Mutex<BTreeSet<String>>,
  file: Option<PathBuf>,
}

impl Deletes {
  #[cfg(test)]
  pub fn in_memory() -> Self {
    Self {
      ids: Mutex::new(BTreeSet::new()),
      file: None,
    }
  }

  pub fn in_file(file: PathBuf) -> Self {
    let ids = std::fs::read(&file)
      .ok()
      .and_then(|bytes| serde_json::from_slice(&bytes).ok())
      .unwrap_or_default();
    Self {
      ids: Mutex::new(ids),
      file: Some(file),
    }
  }

  fn change(&self, change: impl FnOnce(&mut BTreeSet<String>) -> bool) {
    let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
    if !change(&mut ids) {
      return;
    }
    if let (Some(file), Ok(bytes)) = (&self.file, serde_json::to_vec(&*ids)) {
      if let Err(e) = crate::profile::encryption::atomic_write(file, &bytes) {
        log::warn!("Agent chat sync deletes save failed err=\"{e}\"");
      }
    }
  }

  pub fn add(&self, id: &str) {
    self.change(|ids| ids.insert(id.to_string()));
  }

  pub fn done(&self, id: &str) {
    self.change(|ids| ids.remove(id));
  }

  pub fn clear(&self) {
    self.change(|ids| {
      let had = !ids.is_empty();
      ids.clear();
      had
    });
  }

  pub fn contains(&self, id: &str) -> bool {
    self
      .ids
      .lock()
      .unwrap_or_else(|p| p.into_inner())
      .contains(id)
  }

  pub fn list(&self) -> Vec<String> {
    self
      .ids
      .lock()
      .unwrap_or_else(|p| p.into_inner())
      .iter()
      .cloned()
      .collect()
  }
}

/// A lowercase hyphenated uuid, the only id the server takes.
pub fn is_uuid(id: &str) -> bool {
  uuid::Uuid::try_parse(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id)
}

pub struct Syncer {
  pub(super) remote: Box<dyn Remote>,
  pub(super) local: Arc<dyn Local>,
  pub(super) deletes: Arc<Deletes>,
  files: Option<Files>,
  pub(super) account: String,
  pub(super) device_id: String,
  pub(super) key: Option<ChatKey>,
  pub(super) state: State,
  /// The public key registered this session, and its private half until a
  /// wrap opens with it.
  pub(super) public: Option<String>,
  pub(super) private: Option<DeviceKey>,
  /// The account's key id at the last look, once this session looked.
  pub(super) seen_key: Option<Option<String>>,
  /// The account has a key and this device has none yet.
  pub(super) locked: bool,
  pub(super) last_upload: HashMap<String, Instant>,
  /// Chats the server refused at this `updatedAt` (too many, unreadable copy).
  pub(super) refused: HashMap<String, u64>,
  /// When the next throttled upload is due.
  pub(super) next_due: Option<Instant>,
}

impl Syncer {
  /// The sync of `account`. Files of another account start over: a new
  /// device id, no key, nothing known to be synced.
  pub fn new(
    account: &str,
    remote: Box<dyn Remote>,
    local: Arc<dyn Local>,
    deletes: Arc<Deletes>,
    files: Option<Files>,
  ) -> Self {
    let secrets = files
      .as_ref()
      .and_then(Files::load_secrets)
      .filter(|secrets| secrets.account == account && is_uuid(&secrets.device_id));
    let fresh = secrets.is_none();
    let secrets = secrets.unwrap_or_else(|| Secrets {
      account: account.to_string(),
      device_id: uuid::Uuid::new_v4().to_string(),
      key_id: None,
      key: None,
    });
    let key = match (&secrets.key_id, &secrets.key) {
      (Some(id), Some(key)) => ChatKey::from_parts(id, key),
      _ => None,
    };
    let state = match (&files, fresh) {
      (Some(files), false) => files.load_state(),
      _ => State::default(),
    };
    let syncer = Self {
      remote,
      local,
      deletes,
      files,
      account: account.to_string(),
      device_id: secrets.device_id,
      key,
      state,
      public: None,
      private: None,
      seen_key: None,
      locked: false,
      last_upload: HashMap::new(),
      refused: HashMap::new(),
      next_due: None,
    };
    if fresh {
      syncer.deletes.clear();
      syncer.save_secrets();
      syncer.save_state();
    }
    syncer
  }

  pub(super) fn save_secrets(&self) {
    if let Some(files) = &self.files {
      files.save_secrets(&Secrets {
        account: self.account.clone(),
        device_id: self.device_id.clone(),
        key_id: self.key.as_ref().map(|k| k.id.clone()),
        key: self.key.as_ref().map(ChatKey::key_b64),
      });
    }
  }

  pub(super) fn save_state(&self) {
    if let Some(files) = &self.files {
      files.save_state(&self.state);
    }
  }

  /// Keys, deletes, the listing and the uploads.
  pub async fn cycle(&mut self) -> Result<(), BackendFailure> {
    self.next_due = None;
    self.keys().await?;
    self.send_deletes().await?;
    if self.key.is_some() {
      self.wrap_waiting().await?;
      self.pull().await?;
      self.push().await?;
    }
    Ok(())
  }

  /// Deletes and uploads only, once this session has looked at the keys.
  pub async fn push_only(&mut self) -> Result<(), BackendFailure> {
    self.next_due = None;
    if self.seen_key.is_none() {
      return Ok(());
    }
    self.send_deletes().await?;
    if self.key.is_some() {
      self.push().await?;
    }
    Ok(())
  }

  async fn send_deletes(&mut self) -> Result<(), BackendFailure> {
    for id in self.deletes.list() {
      if !is_uuid(&id) {
        self.deletes.done(&id);
        continue;
      }
      match self.remote.delete_chat(&id).await {
        Ok(()) => {}
        Err(e) if e.status == 400 => {}
        Err(e) => return Err(e),
      }
      self.deletes.done(&id);
      if self.state.chats.remove(&id).is_some() {
        self.save_state();
      }
      self.last_upload.remove(&id);
      log::debug!("Agent chat sync delete sent chat={id}");
    }
    Ok(())
  }
}
