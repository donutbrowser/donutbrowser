//! Objects that `migrate-at-rest` rewrote in place get a new LastModified.
//! It keeps the old one in `ORIGINAL_MTIME`, and this layer reports that time
//! (stat, downloads, profile age) until a device writes the object again,
//! with the key set and after it is removed. An object without the field
//! passes through unchanged.

use std::sync::Arc;

use async_trait::async_trait;

use crate::store::{
  ByteStream, Copied, CopySpec, Download, HeadOutput, ListInput, ListOutput, PendingUpload, Store,
  StoreError, Upload, VersionMarker, VersionsPage,
};

/// User metadata (`x-amz-meta-donut-orig-mtime`): the object's LastModified
/// before the migration rewrote it, in milliseconds.
pub const ORIGINAL_MTIME: &str = "donut-orig-mtime";
/// `ORIGINAL_MTIME` on a copy: the copy's own time counts.
const COPIED: &str = "-";
/// Tries of a copy whose source keeps changing.
const COPY_ATTEMPTS: usize = 3;

/// The time a migrated object had before its rewrite.
pub fn original_mtime(head: &HeadOutput) -> Option<i64> {
  head
    .metadata_value(ORIGINAL_MTIME)
    .and_then(|v| v.parse().ok())
}

fn reveal(mut head: HeadOutput) -> HeadOutput {
  if let Some(ms) = original_mtime(&head) {
    head.last_modified_ms = Some(ms);
  }
  head.metadata.retain(|(name, _)| name != ORIGINAL_MTIME);
  head
}

pub struct OriginalTimes {
  inner: Arc<dyn Store>,
}

impl OriginalTimes {
  pub fn new(inner: Arc<dyn Store>) -> Self {
    Self { inner }
  }
}

#[async_trait]
impl Store for OriginalTimes {
  async fn head_bucket(&self) -> Result<(), StoreError> {
    self.inner.head_bucket().await
  }

  async fn create_bucket(&self) -> Result<(), StoreError> {
    self.inner.create_bucket().await
  }

  async fn head_object(&self, key: &str) -> Result<HeadOutput, StoreError> {
    Ok(reveal(self.inner.head_object(key).await?))
  }

  async fn get_object_text(&self, key: &str) -> Result<String, StoreError> {
    self.inner.get_object_text(key).await
  }

  async fn put_object(
    &self,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
    metadata: &[(String, String)],
  ) -> Result<(), StoreError> {
    self
      .inner
      .put_object(key, body, content_type, metadata)
      .await
  }

  async fn delete_object(&self, key: &str) -> Result<Option<String>, StoreError> {
    self.inner.delete_object(key).await
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    self.inner.delete_objects(keys).await
  }

  /// A copy is new, so it does not take the source's original time. Some
  /// stores merge on REPLACE instead of replacing, so the field is overwritten
  /// with a value reads ignore rather than left out. The metadata comes from
  /// a HEAD, so the copy must be of the version that HEAD saw: it is
  /// conditional on its ETag, and checked after where a store ignores that.
  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError> {
    for _ in 0..COPY_ATTEMPTS {
      let head = self.inner.head_object(from).await?;
      if head
        .metadata_value(ORIGINAL_MTIME)
        .is_none_or(|value| value == COPIED)
      {
        return self.inner.copy_object(from, to).await;
      }
      let metadata: Vec<(String, String)> = head
        .metadata
        .iter()
        .map(|(name, value)| match name == ORIGINAL_MTIME {
          true => (name.clone(), COPIED.to_string()),
          false => (name.clone(), value.clone()),
        })
        .collect();
      let spec = CopySpec {
        if_match: head.etag.as_deref(),
        replace: Some((head.content_type.as_deref(), &metadata)),
        ..CopySpec::default()
      };
      match self.inner.copy_object_with(from, to, spec).await {
        Err(StoreError::Service { status: 412, .. }) => continue,
        Err(e) => return Err(e),
        Ok(_) => {}
      }
      if self.inner.head_object(from).await?.etag == head.etag {
        return Ok(());
      }
    }
    Err(StoreError::Service {
      status: 409,
      code: "SourceChanged".to_string(),
      message: format!("{from} kept changing while it was copied"),
    })
  }

  async fn copy_object_with(
    &self,
    from: &str,
    to: &str,
    spec: CopySpec<'_>,
  ) -> Result<Copied, StoreError> {
    self.inner.copy_object_with(from, to, spec).await
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
    Ok(Download {
      head: reveal(download.head),
      body: download.body,
    })
  }

  async fn put_object_stream(
    &self,
    key: &str,
    body: ByteStream,
    upload: Upload<'_>,
  ) -> Result<(), StoreError> {
    self.inner.put_object_stream(key, body, upload).await
  }

  async fn create_multipart(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: &[(String, String)],
  ) -> Result<String, StoreError> {
    self
      .inner
      .create_multipart(key, content_type, metadata)
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::memory_store::MemoryStore;

  fn stores() -> (Arc<MemoryStore>, OriginalTimes) {
    let raw = Arc::new(MemoryStore::default());
    (raw.clone(), OriginalTimes::new(raw))
  }

  #[tokio::test]
  async fn objects_without_the_field_pass_through() {
    let (raw, store) = stores();
    raw.insert(
      "a",
      b"x".to_vec(),
      vec![("updated-at".into(), "1".into())],
      None,
    );
    assert_eq!(
      store.head_object("a").await.unwrap(),
      raw.head_object("a").await.unwrap()
    );
    store.copy_object("a", "b").await.unwrap();
    assert_eq!(
      raw.raw("b").unwrap().metadata,
      raw.raw("a").unwrap().metadata
    );
  }

  #[tokio::test]
  async fn reads_report_the_original_time_and_copies_their_own() {
    let (raw, store) = stores();
    raw.insert(
      "a",
      b"x".to_vec(),
      vec![
        (ORIGINAL_MTIME.into(), "1234".into()),
        ("updated-at".into(), "5".into()),
      ],
      Some("text/plain".into()),
    );
    let head = store.head_object("a").await.unwrap();
    assert_eq!(head.last_modified_ms, Some(1234));
    assert_eq!(
      head.metadata,
      vec![("updated-at".to_string(), "5".to_string())]
    );
    assert_eq!(
      store.get_object("a").await.unwrap().head.last_modified_ms,
      Some(1234)
    );

    store.copy_object("a", "b").await.unwrap();
    let copy = raw.raw("b").unwrap();
    assert!(
      copy
        .metadata
        .contains(&(ORIGINAL_MTIME.to_string(), "-".to_string()))
    );
    assert_eq!(copy.content_type.as_deref(), Some("text/plain"));
    let head = store.head_object("b").await.unwrap();
    assert_eq!(head.last_modified_ms, Some(copy.modified_ms));
    assert_eq!(
      head.metadata,
      vec![("updated-at".to_string(), "5".to_string())]
    );
  }
}
