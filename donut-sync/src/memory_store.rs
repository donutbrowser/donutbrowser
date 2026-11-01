//! A bucket in memory, for unit tests. Hooks stand in for HEAD and LIST where
//! a test needs answers the bucket itself would not give.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use async_trait::async_trait;
use md5::{Digest, Md5};

use crate::store::{
  ByteStream, Download, HeadOutput, ListInput, ListObject, ListOutput, Store, StoreError, Upload,
  collect, once,
};

pub type HeadHook = Box<dyn Fn(&str) -> Result<HeadOutput, StoreError> + Send + Sync>;
pub type ListHook = Box<dyn Fn(&ListInput) -> ListOutput + Send + Sync>;

#[derive(Clone)]
pub struct Object {
  pub body: Vec<u8>,
  pub metadata: Vec<(String, String)>,
  pub content_type: Option<String>,
  pub modified_ms: i64,
}

#[derive(Default)]
pub struct MemoryStore {
  pub objects: Mutex<BTreeMap<String, Object>>,
  pub calls: AtomicUsize,
  /// Each write is one second after the one before.
  pub clock: AtomicI64,
  pub head_hook: Option<HeadHook>,
  pub list_hook: Option<ListHook>,
}

fn etag(body: &[u8]) -> String {
  format!("\"{}\"", hex::encode(Md5::digest(body)))
}

impl MemoryStore {
  fn call(&self) {
    self.calls.fetch_add(1, Ordering::SeqCst);
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
  ) {
    let modified_ms = self.tick();
    self.objects.lock().unwrap().insert(
      key.to_string(),
      Object {
        body,
        metadata,
        content_type,
        modified_ms,
      },
    );
  }

  fn tick(&self) -> i64 {
    self.clock.fetch_add(1000, Ordering::SeqCst) + 1000
  }

  pub fn get(&self, key: &str) -> Option<String> {
    self
      .raw(key)
      .map(|o| String::from_utf8_lossy(&o.body).into_owned())
  }

  pub fn raw(&self, key: &str) -> Option<Object> {
    self.objects.lock().unwrap().get(key).cloned()
  }

  pub fn keys(&self) -> Vec<String> {
    self.objects.lock().unwrap().keys().cloned().collect()
  }

  fn head(&self, key: &str) -> Result<HeadOutput, StoreError> {
    let object = self.raw(key).ok_or(StoreError::NotFound)?;
    let mut metadata = object.metadata.clone();
    metadata.sort();
    Ok(HeadOutput {
      last_modified_ms: Some(object.modified_ms),
      content_length: Some(object.body.len() as u64),
      metadata,
      etag: Some(etag(&object.body)),
      content_type: object.content_type,
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

  async fn delete_object(&self, key: &str) -> Result<(), StoreError> {
    self.call();
    self.objects.lock().unwrap().remove(key);
    Ok(())
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    self.call();
    let mut objects = self.objects.lock().unwrap();
    for key in keys {
      objects.remove(key);
    }
    Ok(())
  }

  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError> {
    self.call();
    let modified_ms = self.tick();
    let mut objects = self.objects.lock().unwrap();
    let object = objects.get(from).cloned().ok_or(StoreError::NotFound)?;
    objects.insert(
      to.to_string(),
      Object {
        modified_ms,
        ..object
      },
    );
    Ok(())
  }

  async fn copy_object_replacing(
    &self,
    from: &str,
    to: &str,
    content_type: Option<&str>,
    metadata: &[(String, String)],
  ) -> Result<(), StoreError> {
    self.call();
    let body = self.raw(from).ok_or(StoreError::NotFound)?.body;
    self.insert(
      to,
      body,
      metadata.to_vec(),
      content_type.map(str::to_string),
    );
    Ok(())
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
    for (key, object) in objects.range(prefix.clone()..) {
      if !key.starts_with(&prefix) {
        break;
      }
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
    if let Some(expected) = upload.if_match
      && self.raw(key).map(|o| etag(&o.body)).as_deref() != Some(expected)
    {
      return Err(StoreError::Service {
        status: 412,
        code: "PreconditionFailed".to_string(),
        message: String::new(),
      });
    }
    self.insert(
      key,
      body,
      upload.metadata.to_vec(),
      upload.content_type.map(str::to_string),
    );
    Ok(())
  }
}
