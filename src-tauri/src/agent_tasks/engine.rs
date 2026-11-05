//! The CDP link to the agent engine inside one profile's Wayfern.
//!
//! One browser-level socket per profile. Commands go out through a channel,
//! replies come back to their caller, and `Wayfern.agent*` events go to
//! `super::on_engine_event`. A Wayfern without the engine answers "method not
//! found", which reaches the person as `AGENT_UNSUPPORTED`.

use crate::profile::BrowserProfile;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

const REPLY_TIMEOUT: Duration = Duration::from_secs(30);
const CHANNEL_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
  /// This Wayfern has no agent engine.
  Unsupported,
  /// The engine refused with a code (`AGENT_BUSY`, `AGENT_TOKEN_REQUIRED`, ...).
  Coded(String),
  /// The browser went away or never answered.
  Gone(String),
}

impl EngineError {
  pub fn code(&self) -> String {
    match self {
      Self::Unsupported => crate::backend_error("AGENT_UNSUPPORTED"),
      Self::Coded(code) => crate::backend_error(code),
      Self::Gone(_) => crate::backend_error("AGENT_BROWSER_UNREACHABLE"),
    }
  }
}

/// Read a CDP `error` object. The engine's message is a code, bare or as
/// `{"code": ...}`; anything else is a failure without one.
pub fn classify_cdp_error(error: &Value) -> EngineError {
  let code = error.get("code").and_then(Value::as_i64);
  let message = error
    .get("message")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .trim();
  if code == Some(-32601) || message.contains("wasn't found") {
    return EngineError::Unsupported;
  }
  if let Some(inner) = serde_json::from_str::<Value>(message)
    .ok()
    .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
  {
    return EngineError::Coded(inner);
  }
  let is_code = !message.is_empty()
    && message.len() <= 64
    && message
      .chars()
      .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
  if is_code {
    if message == "AGENT_UNSUPPORTED" {
      return EngineError::Unsupported;
    }
    return EngineError::Coded(message.to_string());
  }
  EngineError::Coded("AGENT_ENGINE_FAILED".to_string())
}

pub(super) struct Request {
  pub method: String,
  pub params: Value,
  pub reply: oneshot::Sender<Result<Value, EngineError>>,
}

/// A live link to one profile's engine.
#[derive(Clone)]
pub struct EngineLink {
  tx: mpsc::Sender<Request>,
}

impl EngineLink {
  pub(super) fn channel() -> (Self, mpsc::Receiver<Request>) {
    let (tx, rx) = mpsc::channel(CHANNEL_DEPTH);
    (Self { tx }, rx)
  }

  pub fn is_open(&self) -> bool {
    !self.tx.is_closed()
  }

  pub async fn call(&self, method: &str, params: Value) -> Result<Value, EngineError> {
    let (reply, answer) = oneshot::channel();
    self
      .tx
      .send(Request {
        method: method.to_string(),
        params,
        reply,
      })
      .await
      .map_err(|_| EngineError::Gone("link closed".into()))?;
    match tokio::time::timeout(REPLY_TIMEOUT, answer).await {
      Ok(Ok(result)) => result,
      Ok(Err(_)) => Err(EngineError::Gone("link closed".into())),
      Err(_) => Err(EngineError::Gone("no answer".into())),
    }
  }
}

async fn browser_socket(port: u16) -> Result<String, EngineError> {
  let version: Value = reqwest::Client::new()
    .get(format!("http://127.0.0.1:{port}/json/version"))
    .timeout(Duration::from_secs(3))
    .send()
    .await
    .map_err(|e| EngineError::Gone(e.to_string()))?
    .json()
    .await
    .map_err(|e| EngineError::Gone(e.to_string()))?;
  version
    .get("webSocketDebuggerUrl")
    .and_then(Value::as_str)
    .map(str::to_string)
    .ok_or_else(|| EngineError::Gone("no browser socket".into()))
}

/// Open the link to a running profile's browser. Waits up to `patience` for
/// a browser that is still starting.
pub async fn connect(
  profile: &BrowserProfile,
  patience: Duration,
) -> Result<EngineLink, EngineError> {
  let deadline = tokio::time::Instant::now() + patience;
  let manager = crate::wayfern_manager::WayfernManager::instance();
  let ws_url = loop {
    let attempt = match manager.cdp_port_for_profile(profile).await {
      Some(port) => browser_socket(port).await,
      None => Err(EngineError::Gone("no debugging port".into())),
    };
    match attempt {
      Ok(url) => break url,
      Err(e) if tokio::time::Instant::now() >= deadline => return Err(e),
      Err(_) => tokio::time::sleep(Duration::from_millis(500)).await,
    }
  };
  let (socket, _) = tokio_tungstenite::connect_async(ws_url.as_str())
    .await
    .map_err(|e| EngineError::Gone(e.to_string()))?;
  let (link, rx) = EngineLink::channel();
  tokio::spawn(pump(profile.id.to_string(), socket, rx));
  Ok(link)
}

type Socket =
  tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn pump(profile_id: String, socket: Socket, mut rx: mpsc::Receiver<Request>) {
  let (mut sink, mut stream) = socket.split();
  let mut next_id: u64 = 1;
  let mut pending: HashMap<u64, oneshot::Sender<Result<Value, EngineError>>> = HashMap::new();
  let reason = loop {
    tokio::select! {
      request = rx.recv() => {
        let Some(request) = request else { break "released" };
        let id = next_id;
        next_id += 1;
        let frame = crate::cdp_target::cdp_frame(None, id, &request.method, request.params);
        if sink.send(Message::Text(frame.to_string().into())).await.is_err() {
          let _ = request.reply.send(Err(EngineError::Gone("send failed".into())));
          break "send_failed";
        }
        pending.insert(id, request.reply);
      }
      message = stream.next() => {
        let text = match message {
          Some(Ok(Message::Text(text))) => text,
          Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "browser_closed",
          Some(Ok(_)) => continue,
        };
        let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
          if let Some(reply) = pending.remove(&id) {
            let _ = reply.send(match message.get("error") {
              Some(error) => Err(classify_cdp_error(error)),
              None => Ok(message.get("result").cloned().unwrap_or_else(|| json!({}))),
            });
          }
          continue;
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
          if method.starts_with("Wayfern.agent") {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            super::on_engine_event(&profile_id, method, &params);
          }
        }
      }
    }
  };
  for (_, reply) in pending.drain() {
    let _ = reply.send(Err(EngineError::Gone(reason.into())));
  }
  log::debug!("Agent engine link closed profile={profile_id} reason={reason}");
  super::on_link_closed(&profile_id);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_missing_method_means_no_engine() {
    assert_eq!(
      classify_cdp_error(
        &json!({"code": -32601, "message": "'Wayfern.agentConfigure' wasn't found"})
      ),
      EngineError::Unsupported
    );
    assert_eq!(
      classify_cdp_error(&json!({"code": -32000, "message": "AGENT_UNSUPPORTED"})),
      EngineError::Unsupported
    );
  }

  #[test]
  fn engine_refusals_keep_their_code() {
    assert_eq!(
      classify_cdp_error(&json!({"code": -32000, "message": "AGENT_BUSY"})),
      EngineError::Coded("AGENT_BUSY".into())
    );
    assert_eq!(
      classify_cdp_error(
        &json!({"code": -32000, "message": "{\"code\":\"AGENT_TOKEN_REQUIRED\"}"})
      ),
      EngineError::Coded("AGENT_TOKEN_REQUIRED".into())
    );
    assert_eq!(
      classify_cdp_error(&json!({"code": -32602, "message": "Invalid parameters"})),
      EngineError::Coded("AGENT_ENGINE_FAILED".into())
    );
  }

  #[tokio::test]
  async fn a_closed_link_answers_gone() {
    let (link, rx) = EngineLink::channel();
    drop(rx);
    assert!(!link.is_open());
    assert!(matches!(
      link.call("Wayfern.agentStart", json!({})).await,
      Err(EngineError::Gone(_))
    ));
  }
}
