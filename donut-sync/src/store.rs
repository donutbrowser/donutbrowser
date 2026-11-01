//! The object storage operations the server uses.

use std::pin::Pin;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, StoreError>> + Send>>;

#[derive(Debug, Clone, Default)]
pub struct HeadOutput {
  pub last_modified_ms: Option<i64>,
  pub content_length: Option<u64>,
  /// User metadata: lowercase names without `x-amz-meta-`, in response order.
  pub metadata: Vec<(String, String)>,
  pub etag: Option<String>,
  pub content_type: Option<String>,
}

impl HeadOutput {
  pub fn metadata_value(&self, name: &str) -> Option<&str> {
    self
      .metadata
      .iter()
      .find(|(k, _)| k == name)
      .map(|(_, v)| v.as_str())
  }
}

#[derive(Debug, Clone, Default)]
pub struct ListInput {
  pub prefix: Option<String>,
  pub max_keys: Option<String>,
  pub continuation_token: Option<String>,
  pub delimiter: Option<String>,
  pub start_after: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ListObject {
  pub key: String,
  pub last_modified_ms: Option<i64>,
  pub size: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct ListOutput {
  pub contents: Vec<ListObject>,
  pub common_prefixes: Vec<String>,
  pub is_truncated: bool,
  pub next_continuation_token: Option<String>,
}

#[derive(Debug, Clone)]
pub enum StoreError {
  /// HTTP 404: no such object (or bucket).
  NotFound,
  /// Any other answer the store refused with.
  Service {
    status: u16,
    code: String,
    message: String,
  },
  /// The store could not be reached, or answered with something unreadable.
  Transport(String),
  /// A sealed object that does not open: forged, cut off, or under an unknown key.
  Corrupt(String),
}

impl StoreError {
  pub fn code(&self) -> Option<&str> {
    match self {
      StoreError::Service { code, .. } => Some(code),
      _ => None,
    }
  }
}

impl std::fmt::Display for StoreError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      StoreError::NotFound => write!(f, "NotFound"),
      StoreError::Service {
        status,
        code,
        message,
      } => {
        if message.is_empty() {
          write!(f, "{code} (HTTP {status})")
        } else {
          write!(f, "{code}: {message} (HTTP {status})")
        }
      }
      StoreError::Transport(message) => write!(f, "{message}"),
      StoreError::Corrupt(message) => write!(f, "{message}"),
    }
  }
}

impl std::error::Error for StoreError {}

#[async_trait]
pub trait Store: Send + Sync {
  async fn head_bucket(&self) -> Result<(), StoreError>;
  async fn create_bucket(&self) -> Result<(), StoreError>;
  async fn head_object(&self, key: &str) -> Result<HeadOutput, StoreError>;
  async fn get_object_text(&self, key: &str) -> Result<String, StoreError>;
  async fn put_object(
    &self,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
    metadata: &[(String, String)],
  ) -> Result<(), StoreError>;
  async fn delete_object(&self, key: &str) -> Result<(), StoreError>;
  /// Deletes up to 1000 keys in one request; per-key failures are ignored.
  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError>;
  /// Server-side copy, metadata included.
  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError>;
  /// Server-side copy that stores `content_type` and `metadata` in place of
  /// the source's (`x-amz-metadata-directive: REPLACE`).
  async fn copy_object_replacing(
    &self,
    from: &str,
    to: &str,
    content_type: Option<&str>,
    metadata: &[(String, String)],
  ) -> Result<(), StoreError>;
  async fn list_objects_v2(&self, input: &ListInput) -> Result<ListOutput, StoreError>;
  /// The object's body as it arrives, with what a HEAD would say.
  async fn get_object(&self, key: &str) -> Result<Download, StoreError>;
  /// Writes `upload.length` bytes from `body`. With `if_match`, the store
  /// refuses (412) when the object's ETag differs, where it supports that.
  async fn put_object_stream(
    &self,
    key: &str,
    body: ByteStream,
    upload: Upload<'_>,
  ) -> Result<(), StoreError>;
  /// Starts a multipart upload; the object gets `content_type` and `metadata`.
  async fn create_multipart(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: &[(String, String)],
  ) -> Result<String, StoreError>;
  /// One part, `length` bytes from `body`. Returns its ETag.
  async fn upload_part(
    &self,
    key: &str,
    upload_id: &str,
    part: u32,
    body: ByteStream,
    length: u64,
  ) -> Result<String, StoreError>;
  /// Joins the parts, in order, by their ETags.
  async fn complete_multipart(
    &self,
    key: &str,
    upload_id: &str,
    etags: &[String],
  ) -> Result<(), StoreError>;
  async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), StoreError>;
  /// Unfinished uploads under `prefix`.
  async fn list_multipart(&self, prefix: &str) -> Result<Vec<PendingUpload>, StoreError>;
}

/// An unfinished multipart upload.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingUpload {
  pub key: String,
  pub upload_id: String,
  pub initiated_ms: Option<i64>,
}

pub struct Download {
  pub head: HeadOutput,
  pub body: ByteStream,
}

#[derive(Clone, Copy)]
pub struct Upload<'a> {
  pub length: u64,
  pub content_type: Option<&'a str>,
  /// Names without `x-amz-meta-`.
  pub metadata: &'a [(String, String)],
  pub if_match: Option<&'a str>,
}

/// All of a stream, in memory.
pub async fn collect(mut body: ByteStream) -> Result<Vec<u8>, StoreError> {
  use futures_util::StreamExt;
  let mut out = Vec::new();
  while let Some(chunk) = body.next().await {
    out.extend_from_slice(&chunk?);
  }
  Ok(out)
}

pub fn once(bytes: Vec<u8>) -> ByteStream {
  Box::pin(futures_util::stream::once(
    async move { Ok(Bytes::from(bytes)) },
  ))
}
