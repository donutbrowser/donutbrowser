//! The chat sync server in memory, as the real one answers: for the unit
//! tests, and for the native E2E suites under the agent mock, where it lives
//! in a file the suite can seed and read.

use super::remote::{Item, KeyState, Page, Remote, Waiting, WaitingDevice};
use crate::cloud_errors::BackendFailure;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const MAX_CHAT_BYTES: usize = 4 * 1024 * 1024;
const MAX_LIVE_CHATS: usize = 2000;
const PAGE_CHATS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
  pub public_key: String,
  #[serde(default)]
  pub key_id: Option<String>,
  #[serde(default)]
  pub wrapped_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Row {
  pub rev: i64,
  pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Server {
  pub key_id: Option<String>,
  pub epoch: i64,
  pub rev: i64,
  pub purged_rev: i64,
  pub devices: BTreeMap<String, Device>,
  pub chats: BTreeMap<String, Row>,
  /// Chats per page and the largest chat, smaller in tests.
  pub page: usize,
  pub max_bytes: usize,
  /// Requests that failed as if the network were down, for tests.
  #[serde(skip)]
  pub offline: bool,
  #[serde(skip)]
  pub requests: Vec<String>,
}

impl Default for Server {
  fn default() -> Self {
    Self {
      key_id: None,
      epoch: 1,
      rev: 0,
      purged_rev: 0,
      devices: BTreeMap::new(),
      chats: BTreeMap::new(),
      page: PAGE_CHATS,
      max_bytes: MAX_CHAT_BYTES,
      offline: false,
      requests: Vec::new(),
    }
  }
}

fn refusal(status: u16, code: &str) -> BackendFailure {
  crate::cloud_errors::classify(
    status,
    &json!({ "code": code }).to_string(),
    super::remote::CODES,
  )
}

fn key_changed() -> BackendFailure {
  refusal(409, "CHAT_KEY_CHANGED")
}

/// `epoch.rev`, or `epoch.rev.floor` in a reset pass.
#[derive(Clone, Copy)]
struct Cursor {
  epoch: i64,
  rev: i64,
  floor: i64,
}

impl Cursor {
  fn parse(value: &str) -> Option<Self> {
    let parts: Vec<i64> = value
      .split('.')
      .map(|part| part.parse::<i64>().ok().filter(|n| *n >= 0))
      .collect::<Option<_>>()?;
    match parts.as_slice() {
      [epoch, rev] => Some(Self {
        epoch: *epoch,
        rev: *rev,
        floor: *rev,
      }),
      [epoch, rev, floor] if floor > rev => Some(Self {
        epoch: *epoch,
        rev: *rev,
        floor: *floor,
      }),
      _ => None,
    }
  }

  fn encode(&self) -> String {
    if self.floor > self.rev {
      format!("{}.{}.{}", self.epoch, self.rev, self.floor)
    } else {
      format!("{}.{}", self.epoch, self.rev)
    }
  }
}

fn sealed_key_id(data: &str) -> Option<&str> {
  let mut parts = data.split('.');
  match (parts.next(), parts.next()) {
    (Some("v1"), Some(key_id)) => Some(key_id),
    _ => None,
  }
}

impl Server {
  pub fn live(&self) -> usize {
    self.chats.values().filter(|row| row.data.is_some()).count()
  }

  fn next_rev(&mut self) -> i64 {
    self.rev += 1;
    self.rev
  }

  fn list(&self, after: Option<&str>) -> Page {
    let usable = after
      .and_then(Cursor::parse)
      .filter(|c| c.epoch == self.epoch && c.floor <= self.rev && c.floor >= self.purged_rev);
    let reset = usable.is_none();
    let from = usable.unwrap_or(Cursor {
      epoch: self.epoch,
      rev: 0,
      floor: self.rev,
    });
    let mut rows: Vec<(&String, &Row)> = self
      .chats
      .iter()
      .filter(|(_, row)| row.rev > from.rev && (row.data.is_some() || row.rev > from.floor))
      .collect();
    rows.sort_by_key(|(_, row)| row.rev);
    let more = rows.len() > self.page;
    rows.truncate(self.page);
    let next = match rows.last() {
      Some((_, last)) if more => Cursor {
        epoch: self.epoch,
        rev: last.rev,
        floor: from.floor.max(last.rev),
      },
      _ => Cursor {
        epoch: self.epoch,
        rev: self.rev,
        floor: self.rev,
      },
    };
    Page {
      chats: rows
        .into_iter()
        .map(|(id, row)| Item {
          id: id.clone(),
          rev: row.rev,
          data: row.data.clone(),
        })
        .collect(),
      cursor: next.encode(),
      more,
      reset,
    }
  }

  fn put_chat(&mut self, id: &str, data: &str, base: Option<i64>) -> Result<i64, BackendFailure> {
    if data.len() > self.max_bytes {
      return Err(refusal(413, "CHAT_TOO_LARGE"));
    }
    if self.key_id.is_none() || sealed_key_id(data) != self.key_id.as_deref() {
      return Err(key_changed());
    }
    match self.chats.get(id) {
      Some(Row { data: None, .. }) => return Err(refusal(410, "CHAT_DELETED")),
      Some(Row {
        rev,
        data: Some(current),
      }) if base != Some(*rev) => {
        let body = json!({ "code": "CHAT_CHANGED", "rev": rev, "data": current });
        return Err(crate::cloud_errors::classify(
          409,
          &body.to_string(),
          super::remote::CODES,
        ));
      }
      None if base.is_some() => {
        let body = json!({ "code": "CHAT_CHANGED", "rev": Value::Null, "data": Value::Null });
        return Err(crate::cloud_errors::classify(
          409,
          &body.to_string(),
          super::remote::CODES,
        ));
      }
      None if self.live() >= MAX_LIVE_CHATS => return Err(refusal(409, "CHAT_LIMIT")),
      _ => {}
    }
    let rev = self.next_rev();
    self.chats.insert(
      id.to_string(),
      Row {
        rev,
        data: Some(data.to_string()),
      },
    );
    Ok(rev)
  }
}

/// One device's view of a shared in-memory server.
#[derive(Clone)]
pub struct Memory {
  pub server: Arc<Mutex<Server>>,
  file: Option<PathBuf>,
}

impl Memory {
  #[cfg(test)]
  pub fn new(server: Arc<Mutex<Server>>) -> Self {
    Self { server, file: None }
  }

  /// A server kept in `file`, as an E2E suite seeds and reads it.
  #[cfg(feature = "e2e")]
  pub fn in_file(file: PathBuf) -> Self {
    let server = std::fs::read(&file)
      .ok()
      .and_then(|bytes| serde_json::from_slice::<Server>(&bytes).ok())
      .unwrap_or_default();
    Self {
      server: Arc::new(Mutex::new(server)),
      file: Some(file),
    }
  }

  fn with<R>(
    &self,
    request: &str,
    change: impl FnOnce(&mut Server) -> Result<R, BackendFailure>,
  ) -> Result<R, BackendFailure> {
    let mut server = self.server.lock().unwrap_or_else(|p| p.into_inner());
    server.requests.push(request.to_string());
    if server.offline {
      return Err(crate::cloud_errors::transport_failure("offline"));
    }
    let out = change(&mut server)?;
    if let Some(file) = &self.file {
      if let Ok(bytes) = serde_json::to_vec_pretty(&*server) {
        let _ = crate::profile::encryption::atomic_write(file, &bytes);
      }
    }
    Ok(out)
  }
}

#[async_trait]
impl Remote for Memory {
  async fn key(&self, device_id: &str) -> Result<KeyState, BackendFailure> {
    self.with("key", |s| {
      let wrapped_key = s
        .devices
        .get(device_id)
        .filter(|d| d.key_id.is_some() && d.key_id == s.key_id)
        .and_then(|d| d.wrapped_key.clone());
      Ok(KeyState {
        key_id: s.key_id.clone(),
        wrapped_key,
      })
    })
  }

  async fn register(&self, device_id: &str, public_key: &str) -> Result<(), BackendFailure> {
    self.with("register", |s| {
      let device = s
        .devices
        .entry(device_id.to_string())
        .or_insert_with(|| Device {
          public_key: public_key.to_string(),
          key_id: None,
          wrapped_key: None,
        });
      if device.public_key != public_key {
        *device = Device {
          public_key: public_key.to_string(),
          key_id: None,
          wrapped_key: None,
        };
      }
      Ok(())
    })
  }

  async fn create_key(&self, key_id: &str, device_id: &str) -> Result<(), BackendFailure> {
    self.with("create_key", |s| {
      if s.key_id.is_some() {
        return Err(refusal(409, "CHAT_KEY_EXISTS"));
      }
      s.key_id = Some(key_id.to_string());
      if let Some(device) = s.devices.get_mut(device_id) {
        device.key_id = Some(key_id.to_string());
        device.wrapped_key = None;
      }
      Ok(())
    })
  }

  async fn waiting(&self) -> Result<Waiting, BackendFailure> {
    self.with("waiting", |s| {
      let devices = match &s.key_id {
        Some(key_id) => s
          .devices
          .iter()
          .filter(|(_, d)| d.key_id.as_ref() != Some(key_id))
          .map(|(id, d)| WaitingDevice {
            device_id: id.clone(),
            public_key: d.public_key.clone(),
          })
          .collect(),
        None => Vec::new(),
      };
      Ok(Waiting {
        key_id: s.key_id.clone(),
        devices,
      })
    })
  }

  async fn put_wrap(
    &self,
    device_id: &str,
    key_id: &str,
    public_key: &str,
    wrapped_key: &str,
  ) -> Result<(), BackendFailure> {
    self.with("put_wrap", |s| {
      if s.key_id.as_deref() != Some(key_id) {
        return Err(key_changed());
      }
      let device = s
        .devices
        .get_mut(device_id)
        .filter(|d| d.public_key == public_key)
        .ok_or_else(key_changed)?;
      device.key_id = Some(key_id.to_string());
      device.wrapped_key = Some(wrapped_key.to_string());
      Ok(())
    })
  }

  async fn erase(&self) -> Result<(), BackendFailure> {
    self.with("erase", |s| {
      s.key_id = None;
      s.epoch += 1;
      s.purged_rev = s.rev;
      s.chats.clear();
      s.devices.clear();
      Ok(())
    })
  }

  async fn list(&self, after: Option<&str>) -> Result<Page, BackendFailure> {
    self.with("list", |s| Ok(s.list(after)))
  }

  async fn put_chat(
    &self,
    chat_id: &str,
    data: &str,
    base_rev: Option<i64>,
  ) -> Result<i64, BackendFailure> {
    self.with("put_chat", |s| s.put_chat(chat_id, data, base_rev))
  }

  async fn delete_chat(&self, chat_id: &str) -> Result<(), BackendFailure> {
    self.with("delete_chat", |s| {
      let rev = s.next_rev();
      s.chats.insert(chat_id.to_string(), Row { rev, data: None });
      Ok(())
    })
  }
}

/// The ids a test sees live on the server.
#[cfg(test)]
pub fn live_ids(server: &Server) -> std::collections::BTreeSet<String> {
  server
    .chats
    .iter()
    .filter(|(_, row)| row.data.is_some())
    .map(|(id, _)| id.clone())
    .collect()
}
