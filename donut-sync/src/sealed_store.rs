//! The store as the routes see it when `SYNC_AT_REST_KEY` is set: writes are
//! sealed, reads opened, and plaintext objects from before still read as they
//! are. HEAD answers with the plaintext size and without the marker.
//!
//! In the unsealing state (`Keyring::unsealing`) sealed objects still read,
//! but writes stay plaintext, so `migrate-at-rest --unseal` can empty the
//! bucket of sealed objects before the key is removed.

use std::sync::Arc;

use async_trait::async_trait;

use crate::at_rest::{self, Keyring, MARKER};
use crate::store::{
  ByteStream, Copied, CopySpec, Download, HeadOutput, ListInput, ListOutput, PendingUpload, Store,
  StoreError, Upload, VersionMarker, VersionsPage,
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

  fn sealing(&self) -> bool {
    !self.keyring.unsealing()
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
    if !self.sealing() {
      return self
        .inner
        .put_object(key, body, content_type, metadata)
        .await;
    }
    let sealed = at_rest::seal(&self.keyring, &body);
    self
      .inner
      .put_object(key, sealed, content_type, &self.with_marker(metadata))
      .await
  }

  async fn delete_object(&self, key: &str) -> Result<Option<String>, StoreError> {
    self.inner.delete_object(key).await
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    self.inner.delete_objects(keys).await
  }

  /// Sealed objects copy as they are: the frames do not name their key. A
  /// copy is new, so it does not take the source's original time.
  /// A REPLACE copy takes the user's metadata; a sealed source keeps its
  /// marker, which the copied frames need, from the same version.
  async fn copy_object_with(
    &self,
    from: &str,
    to: &str,
    spec: CopySpec<'_>,
  ) -> Result<Copied, StoreError> {
    let Some((content_type, metadata)) = spec.replace else {
      return self.inner.copy_object_with(from, to, spec).await;
    };
    let source = self.inner.head_object(from).await?;
    if spec
      .if_match
      .is_some_and(|etag| source.etag.as_deref() != Some(etag))
    {
      return Err(StoreError::Service {
        status: 412,
        code: "PreconditionFailed".to_string(),
        message: String::new(),
      });
    }
    let mut metadata = metadata.to_vec();
    if let Some(marker) = source.metadata_value(MARKER) {
      metadata.push((MARKER.to_string(), marker.to_string()));
    }
    self
      .inner
      .copy_object_with(
        from,
        to,
        CopySpec {
          if_match: spec.if_match.or(source.etag.as_deref()),
          replace: Some((content_type, &metadata)),
          ..spec
        },
      )
      .await
  }

  async fn list_versions(
    &self,
    prefix: &str,
    after: Option<&VersionMarker>,
  ) -> Result<Option<VersionsPage>, StoreError> {
    self.inner.list_versions(prefix, after).await
  }

  async fn delete_version(&self, key: &str, version_id: &str) -> Result<(), StoreError> {
    self.inner.delete_version(key, version_id).await
  }

  async fn get_range(&self, key: &str, length: u64) -> Result<Vec<u8>, StoreError> {
    self.inner.get_range(key, length).await
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
    if !self.sealing() {
      return self.inner.put_object_stream(key, body, upload).await;
    }
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

  // Multipart parts pass through as they come: the caller (transfer_parts.rs)
  // seals each part as whole frames of one object, when sealing.

  async fn create_multipart(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: &[(String, String)],
  ) -> Result<String, StoreError> {
    let metadata = match self.sealing() {
      true => self.with_marker(metadata),
      false => metadata.to_vec(),
    };
    self
      .inner
      .create_multipart(key, content_type, &metadata)
      .await
  }

  async fn upload_part(
    &self,
    key: &str,
    upload_id: &str,
    part: u32,
    body: ByteStream,
    length: u64,
  ) -> Result<String, StoreError> {
    self
      .inner
      .upload_part(key, upload_id, part, body, length)
      .await
  }

  async fn complete_multipart(
    &self,
    key: &str,
    upload_id: &str,
    etags: &[String],
  ) -> Result<(), StoreError> {
    self.inner.complete_multipart(key, upload_id, etags).await
  }

  async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), StoreError> {
    self.inner.abort_multipart(key, upload_id).await
  }

  async fn list_multipart(&self, prefix: &str) -> Result<Vec<PendingUpload>, StoreError> {
    self.inner.list_multipart(prefix).await
  }
}
