//! The store as the routes see it when `SYNC_AT_REST_KEY` is set: writes are
//! sealed, reads opened, and plaintext objects from before still read as they
//! are. HEAD answers with the plaintext size and without the marker.

use std::sync::Arc;

use async_trait::async_trait;

use crate::at_rest::{self, Keyring, MARKER};
use crate::store::{
  ByteStream, Download, HeadOutput, ListInput, ListOutput, Store, StoreError, Upload,
};

pub struct SealedStore {
  inner: Arc<dyn Store>,
  keyring: Arc<Keyring>,
}

/// The key id a stored object is sealed under; `None` for plaintext.
pub fn sealed_by(head: &HeadOutput) -> Option<&str> {
  head.metadata_value(MARKER).and_then(at_rest::marker_key_id)
}

/// `head` as the plaintext object would have it.
fn reveal(mut head: HeadOutput) -> Result<HeadOutput, StoreError> {
  if let Some(id) = sealed_by(&head) {
    let id = id.to_string();
    head.content_length = match head.content_length {
      Some(sealed) => Some(at_rest::plain_len(&id, sealed).ok_or_else(|| {
        StoreError::Corrupt(format!("sealed object has an invalid size {sealed}"))
      })?),
      None => None,
    };
    head.metadata.retain(|(name, _)| name != MARKER);
  }
  Ok(head)
}

impl SealedStore {
  pub fn new(inner: Arc<dyn Store>, keyring: Arc<Keyring>) -> Self {
    Self { inner, keyring }
  }

  fn with_marker(&self, metadata: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = metadata.to_vec();
    out.push((MARKER.to_string(), self.keyring.marker()));
    out
  }
}

#[async_trait]
impl Store for SealedStore {
  async fn head_bucket(&self) -> Result<(), StoreError> {
    self.inner.head_bucket().await
  }

  async fn create_bucket(&self) -> Result<(), StoreError> {
    self.inner.create_bucket().await
  }

  async fn head_object(&self, key: &str) -> Result<HeadOutput, StoreError> {
    reveal(self.inner.head_object(key).await?)
  }

  async fn get_object_text(&self, key: &str) -> Result<String, StoreError> {
    let body = crate::store::collect(self.get_object(key).await?.body).await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
  }

  async fn put_object(
    &self,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
    metadata: &[(String, String)],
  ) -> Result<(), StoreError> {
    let sealed = at_rest::seal(&self.keyring, &body);
    self
      .inner
      .put_object(key, sealed, content_type, &self.with_marker(metadata))
      .await
  }

  async fn delete_object(&self, key: &str) -> Result<(), StoreError> {
    self.inner.delete_object(key).await
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    self.inner.delete_objects(keys).await
  }

  /// Sealed objects copy as they are: the frames do not name their key.
  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError> {
    self.inner.copy_object(from, to).await
  }

  async fn list_objects_v2(&self, input: &ListInput) -> Result<ListOutput, StoreError> {
    self.inner.list_objects_v2(input).await
  }

  async fn get_object(&self, key: &str) -> Result<Download, StoreError> {
    let download = self.inner.get_object(key).await?;
    let sealed = sealed_by(&download.head).is_some();
    let head = reveal(download.head)?;
    let body = if sealed {
      at_rest::open_stream(self.keyring.clone(), download.body)
    } else {
      download.body
    };
    Ok(Download { head, body })
  }

  async fn put_object_stream(
    &self,
    key: &str,
    body: ByteStream,
    upload: Upload<'_>,
  ) -> Result<(), StoreError> {
    let metadata = self.with_marker(upload.metadata);
    self
      .inner
      .put_object_stream(
        key,
        at_rest::seal_stream(&self.keyring, body),
        Upload {
          length: at_rest::sealed_len(self.keyring.current().id(), upload.length),
          metadata: &metadata,
          ..upload
        },
      )
      .await
  }
}
