//! The chat sync routes of Donut cloud. Every value that travels is sealed or
//! a public key; the server answers refusals with `{"code": ...}`.

use crate::cloud_errors::{BackendFailure, FailureCodes};
use async_trait::async_trait;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

pub const CODES: FailureCodes = FailureCodes {
  bad_request: "CLOUD_REQUEST_FAILED",
  forbidden: "AGENT_NOT_ENTITLED",
  not_found: "CLOUD_REQUEST_FAILED",
  conflict: "CLOUD_REQUEST_FAILED",
};

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyState {
  pub key_id: Option<String>,
  pub wrapped_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WaitingDevice {
  pub device_id: String,
  pub public_key: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
  pub key_id: Option<String>,
  #[serde(default)]
  pub devices: Vec<WaitingDevice>,
}

/// One chat in a listing; `data: None` is a delete.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Item {
  pub id: String,
  pub rev: i64,
  pub data: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Page {
  #[serde(default)]
  pub chats: Vec<Item>,
  pub cursor: String,
  #[serde(default)]
  pub more: bool,
  #[serde(default)]
  pub reset: bool,
}

#[async_trait]
pub trait Remote: Send + Sync {
  async fn key(&self, device_id: &str) -> Result<KeyState, BackendFailure>;
  async fn register(&self, device_id: &str, public_key: &str) -> Result<(), BackendFailure>;
  async fn create_key(&self, key_id: &str, device_id: &str) -> Result<(), BackendFailure>;
  async fn waiting(&self) -> Result<Waiting, BackendFailure>;
  async fn put_wrap(
    &self,
    device_id: &str,
    key_id: &str,
    public_key: &str,
    wrapped_key: &str,
  ) -> Result<(), BackendFailure>;
  async fn erase(&self) -> Result<(), BackendFailure>;
  async fn list(&self, after: Option<&str>) -> Result<Page, BackendFailure>;
  async fn put_chat(
    &self,
    chat_id: &str,
    data: &str,
    base_rev: Option<i64>,
  ) -> Result<i64, BackendFailure>;
  async fn delete_chat(&self, chat_id: &str) -> Result<(), BackendFailure>;
}

/// How a request reaches the server: the signed-in account in the app.
#[async_trait]
pub trait Transport: Send + Sync {
  async fn send(
    &self,
    method: Method,
    url: String,
    body: Option<Value>,
  ) -> Result<Option<Value>, BackendFailure>;
}

pub struct Cloud;

#[async_trait]
impl Transport for Cloud {
  async fn send(
    &self,
    method: Method,
    url: String,
    body: Option<Value>,
  ) -> Result<Option<Value>, BackendFailure> {
    crate::cloud_api::call(method, url, body, CODES).await
  }
}

pub struct Http<T> {
  base: String,
  transport: T,
}

impl Http<Cloud> {
  pub fn cloud() -> Self {
    Self::new(crate::cloud_auth::CLOUD_API_URL, Cloud)
  }
}

impl<T: Transport> Http<T> {
  pub fn new(api: &str, transport: T) -> Self {
    Self {
      base: format!("{}/api/agent", api.trim_end_matches('/')),
      transport,
    }
  }

  async fn send(
    &self,
    method: Method,
    path: &str,
    body: Option<Value>,
  ) -> Result<Option<Value>, BackendFailure> {
    self
      .transport
      .send(method, format!("{}{path}", self.base), body)
      .await
  }

  async fn read<R: DeserializeOwned>(
    &self,
    method: Method,
    path: &str,
    body: Option<Value>,
  ) -> Result<R, BackendFailure> {
    let value = self.send(method, path, body).await?.unwrap_or(Value::Null);
    serde_json::from_value(value)
      .map_err(|e| crate::cloud_errors::classify_message(&format!("decode response: {e}"), CODES))
  }
}

fn path_part(id: &str) -> String {
  urlencoding::encode(id).into_owned()
}

#[async_trait]
impl<T: Transport> Remote for Http<T> {
  async fn key(&self, device_id: &str) -> Result<KeyState, BackendFailure> {
    self
      .read(
        Method::GET,
        &format!("/chat-key?deviceId={}", path_part(device_id)),
        None,
      )
      .await
  }

  async fn register(&self, device_id: &str, public_key: &str) -> Result<(), BackendFailure> {
    self
      .send(
        Method::PUT,
        &format!("/chat-key/devices/{}", path_part(device_id)),
        Some(json!({ "publicKey": public_key, "kind": "app" })),
      )
      .await
      .map(|_| ())
  }

  async fn create_key(&self, key_id: &str, device_id: &str) -> Result<(), BackendFailure> {
    self
      .send(
        Method::POST,
        "/chat-key",
        Some(json!({ "keyId": key_id, "deviceId": device_id })),
      )
      .await
      .map(|_| ())
  }

  async fn waiting(&self) -> Result<Waiting, BackendFailure> {
    self.read(Method::GET, "/chat-key/waiting", None).await
  }

  async fn put_wrap(
    &self,
    device_id: &str,
    key_id: &str,
    public_key: &str,
    wrapped_key: &str,
  ) -> Result<(), BackendFailure> {
    self
      .send(
        Method::PUT,
        &format!("/chat-key/devices/{}/wrap", path_part(device_id)),
        Some(json!({ "keyId": key_id, "publicKey": public_key, "wrappedKey": wrapped_key })),
      )
      .await
      .map(|_| ())
  }

  async fn erase(&self) -> Result<(), BackendFailure> {
    self
      .send(Method::DELETE, "/chat-key", None)
      .await
      .map(|_| ())
  }

  async fn list(&self, after: Option<&str>) -> Result<Page, BackendFailure> {
    let path = match after {
      Some(cursor) => format!("/chats?after={}", path_part(cursor)),
      None => "/chats".to_string(),
    };
    self.read(Method::GET, &path, None).await
  }

  async fn put_chat(
    &self,
    chat_id: &str,
    data: &str,
    base_rev: Option<i64>,
  ) -> Result<i64, BackendFailure> {
    #[derive(Deserialize)]
    struct Saved {
      rev: i64,
    }
    let saved: Saved = self
      .read(
        Method::PUT,
        &format!("/chats/{}", path_part(chat_id)),
        Some(json!({ "data": data, "baseRev": base_rev })),
      )
      .await?;
    Ok(saved.rev)
  }

  async fn delete_chat(&self, chat_id: &str) -> Result<(), BackendFailure> {
    self
      .send(
        Method::DELETE,
        &format!("/chats/{}", path_part(chat_id)),
        None,
      )
      .await
      .map(|_| ())
  }
}
