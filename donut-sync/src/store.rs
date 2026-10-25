//! The object storage operations the server uses.

use async_trait::async_trait;

#[derive(Debug, Clone, Default)]
pub struct HeadOutput {
  pub last_modified_ms: Option<i64>,
  pub content_length: Option<u64>,
  /// User metadata: lowercase names without `x-amz-meta-`, in response order.
  pub metadata: Vec<(String, String)>,
  pub etag: Option<String>,
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
  ) -> Result<(), StoreError>;
  async fn delete_object(&self, key: &str) -> Result<(), StoreError>;
  /// Deletes up to 1000 keys in one request; per-key failures are ignored.
  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError>;
  /// Server-side copy, metadata included.
  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError>;
  async fn list_objects_v2(&self, input: &ListInput) -> Result<ListOutput, StoreError>;
}
