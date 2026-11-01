//! A bucket in memory, for unit tests. Hooks stand in for HEAD and LIST where
//! a test needs answers the bucket itself would not give, and let a test act
//! as a device in the middle of a copy. With `versioned`, it keeps every
//! version and delete marker, as B2 does.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use async_trait::async_trait;
use md5::{Digest, Md5};

use crate::store::{
  ByteStream, Copied, CopySpec, Download, HeadOutput, ListInput, ListObject, ListOutput,
  ObjectVersion, PendingUpload, Store, StoreError, Upload, VersionMarker, VersionsPage, collect,
  once,
};

pub type HeadHook = Box<dyn Fn(&str) -> Result<HeadOutput, StoreError> + Send + Sync>;
pub type ListHook = Box<dyn Fn(&ListInput) -> ListOutput + Send + Sync>;
/// Runs before a copy to `to`, as a device writing at that moment would.
pub type CopyHook = Box<dyn Fn(&MemoryStore, &str) + Send + Sync>;

/// S3's smallest part, except the last.
pub const MIN_PART: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Object {
  pub body: Vec<u8>,
  pub metadata: Vec<(String, String)>,
  pub content_type: Option<String>,
  pub modified_ms: i64,
}

/// One version of a key: an object, or a delete marker (`None`).
#[derive(Clone, Debug)]
pub(crate) struct Entry {
  version_id: String,
  object: Option<Object>,
  modified_ms: i64,
}

pub struct Multipart {
  key: String,
  content_type: Option<String>,
  metadata: Vec<(String, String)>,
  parts: BTreeMap<u32, Vec<u8>>,
  initiated_ms: i64,
}

#[derive(Default)]
pub struct MemoryStore {
  /// Oldest version first.
  pub(crate) objects: Mutex<BTreeMap<String, Vec<Entry>>>,
  pub calls: AtomicUsize,
  /// Each write is one second after the one before.
  pub clock: AtomicI64,
  pub head_hook: Option<HeadHook>,
  pub list_hook: Option<ListHook>,
  pub copy_hook: Mutex<Option<CopyHook>>,
  pub versioned: bool,
  /// Like B2: a PUT with If-Match is refused (501), never conditional.
  pub ignores_if_match: bool,
  /// Versions per listed page; 0 is 1000.
  pub version_page: usize,
  pub uploads: Mutex<BTreeMap<String, Multipart>>,
}

fn etag(body: &[u8]) -> String {
  format!("\"{}\"", hex::encode(Md5::digest(body)))
}

fn precondition_failed() -> StoreError {
  StoreError::Service {
    status: 412,
    code: "PreconditionFailed".to_string(),
    message: String::new(),
  }
}

impl MemoryStore {
  pub fn versioned() -> Self {
    Self {
      versioned: true,
      ..Self::default()
    }
  }

  fn call(&self) {
    self.calls.fetch_add(1, Ordering::SeqCst);
  }

  fn tick(&self) -> i64 {
    self.clock.fetch_add(1000, Ordering::SeqCst) + 1000
  }

  fn push(&self, key: &str, mut object: Option<Object>) -> String {
    let modified_ms = self.tick();
    if let Some(object) = &mut object {
      object.modified_ms = modified_ms;
    }
    let version_id = format!("v{modified_ms}");
    let entry = Entry {
      version_id: version_id.clone(),
      object,
      modified_ms,
    };
    let mut objects = self.objects.lock().unwrap();
    match objects.get_mut(key) {
      Some(history) if self.versioned => history.push(entry),
      _ if entry.object.is_none() && !self.versioned => {
        objects.remove(key);
      }
      _ => {
        objects.insert(key.to_string(), vec![entry]);
      }
    }
    version_id
  }

  pub fn set(&self, key: &str, body: &str) {
    self.insert(key, body.as_bytes().to_vec(), Vec::new(), None);
  }

  pub fn insert(
    &self,
    key: &str,
    body: Vec<u8>,
    metadata: Vec<(String, String)>,
    content_type: Option<String>,
  ) -> String {
    self.push(
      key,
      Some(Object {
        body,
        metadata,
        content_type,
        modified_ms: 0,
      }),
    )
  }

  /// A device's delete: a delete marker where versions are kept.
  pub fn remove(&self, key: &str) -> Option<String> {
    self.raw(key)?;
    let id = self.push(key, None);
    self.versioned.then_some(id)
  }

  pub fn get(&self, key: &str) -> Option<String> {
    self
      .raw(key)
      .map(|o| String::from_utf8_lossy(&o.body).into_owned())
  }

  /// The current object.
  pub fn raw(&self, key: &str) -> Option<Object> {
    self.current(key).map(|(_, object)| object)
  }

  fn current(&self, key: &str) -> Option<(String, Object)> {
    let objects = self.objects.lock().unwrap();
    let entry = objects.get(key)?.last()?;
    Some((entry.version_id.clone(), entry.object.clone()?))
  }

  /// Every key with a current object.
  pub fn keys(&self) -> Vec<String> {
    self
      .objects
      .lock()
      .unwrap()
      .iter()
      .filter(|(_, history)| history.last().is_some_and(|e| e.object.is_some()))
      .map(|(key, _)| key.clone())
      .collect()
  }

  /// How many versions and delete markers `key` has.
  pub fn version_count(&self, key: &str) -> usize {
    self.objects.lock().unwrap().get(key).map_or(0, Vec::len)
  }

  fn head(&self, key: &str) -> Result<HeadOutput, StoreError> {
    let (version_id, object) = self.current(key).ok_or(StoreError::NotFound)?;
    let mut metadata = object.metadata.clone();
    metadata.sort();
    Ok(HeadOutput {
      last_modified_ms: Some(object.modified_ms),
      content_length: Some(object.body.len() as u64),
      metadata,
      etag: Some(etag(&object.body)),
      content_type: object.content_type,
      version_id: self.versioned.then_some(version_id),
    })
  }
}

#[async_trait]
impl Store for MemoryStore {
  async fn head_bucket(&self) -> Result<(), StoreError> {
    self.call();
    Ok(())
  }

  async fn create_bucket(&self) -> Result<(), StoreError> {
    self.call();
    Ok(())
  }

  async fn head_object(&self, key: &str) -> Result<HeadOutput, StoreError> {
    self.call();
    if let Some(hook) = &self.head_hook {
      return hook(key);
    }
    self.head(key)
  }

  async fn get_object_text(&self, key: &str) -> Result<String, StoreError> {
    self.call();
    self.get(key).ok_or(StoreError::NotFound)
  }

  async fn put_object(
    &self,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
    metadata: &[(String, String)],
  ) -> Result<(), StoreError> {
    self.call();
    self.insert(key, body, metadata.to_vec(), Some(content_type.to_string()));
    Ok(())
  }

  async fn delete_object(&self, key: &str) -> Result<Option<String>, StoreError> {
    self.call();
    Ok(self.remove(key))
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    self.call();
    for key in keys {
      self.remove(key);
    }
    Ok(())
  }

  async fn copy_object_with(
    &self,
    from: &str,
    to: &str,
    spec: CopySpec<'_>,
  ) -> Result<Copied, StoreError> {
    self.call();
    if let Some(hook) = self.copy_hook.lock().unwrap().as_ref() {
      hook(self, to);
    }
    let source = match spec.source_version {
      Some(version) => self
        .objects
        .lock()
        .unwrap()
        .get(from)
        .and_then(|history| history.iter().find(|e| e.version_id == version).cloned())
        .and_then(|e| e.object),
      None => self.raw(from),
    }
    .ok_or(StoreError::NotFound)?;
    if spec
      .if_match
      .is_some_and(|expected| etag(&source.body) != expected)
    {
      return Err(precondition_failed());
    }
    let (content_type, metadata) = match spec.replace {
      Some((content_type, metadata)) => (content_type.map(str::to_string), metadata.to_vec()),
      None => (source.content_type, source.metadata),
    };
    let version_id = self.insert(to, source.body, metadata, content_type);
    Ok(Copied {
      version_id: self.versioned.then_some(version_id),
    })
  }

  async fn list_versions(
    &self,
    prefix: &str,
    after: Option<&VersionMarker>,
  ) -> Result<Option<VersionsPage>, StoreError> {
    self.call();
    if !self.versioned {
      return Ok(None);
    }
    let page = if self.version_page == 0 {
      1000
    } else {
      self.version_page
    };
    let objects = self.objects.lock().unwrap();
    let mut out = Vec::new();
    for (key, history) in objects.range(prefix.to_string()..) {
      if !key.starts_with(prefix) {
        break;
      }
      for (i, entry) in history.iter().enumerate().rev() {
        out.push(ObjectVersion {
          key: key.clone(),
          version_id: entry.version_id.clone(),
          is_latest: i + 1 == history.len(),
          delete_marker: entry.object.is_none(),
          size: entry.object.as_ref().map_or(0, |o| o.body.len() as u64),
          last_modified_ms: Some(entry.modified_ms),
        });
      }
    }
    let start = match after {
      Some((key, id)) => out
        .iter()
        .position(|v| v.key == *key && v.version_id == *id)
        .map_or(out.len(), |at| at + 1),
      None => 0,
    };
    let versions: Vec<ObjectVersion> = out.into_iter().skip(start).collect();
    let next = (versions.len() > page).then(|| {
      (
        versions[page - 1].key.clone(),
        versions[page - 1].version_id.clone(),
      )
    });
    Ok(Some(VersionsPage {
      versions: versions.into_iter().take(page).collect(),
      next,
    }))
  }

  async fn delete_version(&self, key: &str, version_id: &str) -> Result<(), StoreError> {
    self.call();
    let mut objects = self.objects.lock().unwrap();
    if let Some(history) = objects.get_mut(key) {
      history.retain(|e| e.version_id != version_id);
      if history.is_empty() {
        objects.remove(key);
      }
    }
    Ok(())
  }

  async fn get_range(&self, key: &str, length: u64) -> Result<Vec<u8>, StoreError> {
    self.call();
    let mut body = self.raw(key).ok_or(StoreError::NotFound)?.body;
    body.truncate(length as usize);
    Ok(body)
  }

  async fn list_objects_v2(&self, input: &ListInput) -> Result<ListOutput, StoreError> {
    self.call();
    if let Some(hook) = &self.list_hook {
      return Ok(hook(input));
    }
    let prefix = input.prefix.clone().unwrap_or_default();
    let max_keys: usize = input
      .max_keys
      .as_deref()
      .and_then(|m| m.parse().ok())
      .unwrap_or(1000);
    let after = input
      .continuation_token
      .clone()
      .or_else(|| input.start_after.clone());
    let objects = self.objects.lock().unwrap();
    let mut out = ListOutput::default();
    for (key, history) in objects.range(prefix.clone()..) {
      if !key.starts_with(&prefix) {
        break;
      }
      let Some(object) = history.last().and_then(|e| e.object.as_ref()) else {
        continue;
      };
      if after.as_ref().is_some_and(|after| key <= after) {
        continue;
      }
      if let Some(delimiter) = &input.delimiter
        && let Some(at) = key[prefix.len()..].find(delimiter.as_str())
      {
        let common = key[..prefix.len() + at + delimiter.len()].to_string();
        if !out.common_prefixes.contains(&common) {
          out.common_prefixes.push(common);
        }
        continue;
      }
      if out.contents.len() == max_keys {
        out.is_truncated = true;
        out.next_continuation_token = out.contents.last().map(|o| o.key.clone());
        break;
      }
      out.contents.push(ListObject {
        key: key.clone(),
        last_modified_ms: Some(object.modified_ms),
        size: Some(object.body.len() as u64),
      });
    }
    Ok(out)
  }

  async fn get_object(&self, key: &str) -> Result<Download, StoreError> {
    self.call();
    let head = self.head(key)?;
    let body = self.raw(key).ok_or(StoreError::NotFound)?.body;
    Ok(Download {
      head,
      body: once(body),
    })
  }

  async fn put_object_stream(
    &self,
    key: &str,
    body: ByteStream,
    upload: Upload<'_>,
  ) -> Result<(), StoreError> {
    self.call();
    let body = collect(body).await?;
    if body.len() as u64 != upload.length {
      return Err(StoreError::Transport("length mismatch".to_string()));
    }
    if upload.if_match.is_some() && self.ignores_if_match {
      return Err(StoreError::Service {
        status: 501,
        code: "NotImplemented".to_string(),
        message: String::new(),
      });
    }
    if let Some(expected) = upload.if_match
      && self.raw(key).map(|o| etag(&o.body)).as_deref() != Some(expected)
    {
      return Err(precondition_failed());
    }
    self.insert(
      key,
      body,
      upload.metadata.to_vec(),
      upload.content_type.map(str::to_string),
    );
    Ok(())
  }

  async fn create_multipart(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: &[(String, String)],
  ) -> Result<String, StoreError> {
    self.call();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let initiated_ms = self.tick();
    self.uploads.lock().unwrap().insert(
      id.clone(),
      Multipart {
        key: key.to_string(),
        content_type: content_type.map(str::to_string),
        metadata: metadata.to_vec(),
        parts: BTreeMap::new(),
        initiated_ms,
      },
    );
    Ok(id)
  }

  async fn upload_part(
    &self,
    key: &str,
    upload_id: &str,
    part: u32,
    body: ByteStream,
    length: u64,
  ) -> Result<String, StoreError> {
    self.call();
    let body = collect(body).await?;
    if body.len() as u64 != length {
      return Err(StoreError::Transport("length mismatch".to_string()));
    }
    let mut uploads = self.uploads.lock().unwrap();
    let upload = uploads
      .get_mut(upload_id)
      .filter(|u| u.key == key)
      .ok_or(StoreError::NotFound)?;
    let tag = etag(&body);
    upload.parts.insert(part, body);
    Ok(tag)
  }

  async fn complete_multipart(
    &self,
    key: &str,
    upload_id: &str,
    etags: &[String],
  ) -> Result<(), StoreError> {
    self.call();
    let upload = self
      .uploads
      .lock()
      .unwrap()
      .remove(upload_id)
      .filter(|u| u.key == key)
      .ok_or(StoreError::NotFound)?;
    let mut body = Vec::new();
    for (i, expected) in etags.iter().enumerate() {
      let part = upload
        .parts
        .get(&(i as u32 + 1))
        .filter(|part| etag(part) == *expected)
        .ok_or_else(|| StoreError::Service {
          status: 400,
          code: "InvalidPart".to_string(),
          message: String::new(),
        })?;
      if i + 1 < etags.len() && part.len() < MIN_PART {
        return Err(StoreError::Service {
          status: 400,
          code: "EntityTooSmall".to_string(),
          message: String::new(),
        });
      }
      body.extend_from_slice(part);
    }
    self.insert(key, body, upload.metadata, upload.content_type);
    Ok(())
  }

  async fn abort_multipart(&self, _key: &str, upload_id: &str) -> Result<(), StoreError> {
    self.call();
    self.uploads.lock().unwrap().remove(upload_id);
    Ok(())
  }

  async fn list_multipart(&self, prefix: &str) -> Result<Vec<PendingUpload>, StoreError> {
    self.call();
    Ok(
      self
        .uploads
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, u)| u.key.starts_with(prefix))
        .map(|(id, u)| PendingUpload {
          key: u.key.clone(),
          upload_id: id.clone(),
          initiated_ms: Some(u.initiated_ms),
        })
        .collect(),
    )
  }
}
