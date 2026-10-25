//! Error answers, in the shapes the API has always used.
//!
//! A refusal with a message is `{"message", "error", "statusCode"}`; a
//! refusal with a code is the bare object (`{"code": ...}`); anything
//! unexpected is `{"statusCode": 500, "message": "Internal server error"}`.

use serde_json::{Map, Value, json};

use crate::jsval::NoBody;

#[derive(Debug)]
pub enum ApiError {
  /// A refusal with this status and body.
  Http { status: u16, body: Value },
  /// A failure: logged, answered with a plain 500.
  Internal(String),
}

pub fn reason(status: u16) -> &'static str {
  match status {
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    413 => "Payload Too Large",
    415 => "Unsupported Media Type",
    500 => "Internal Server Error",
    503 => "Service Unavailable",
    _ => "Error",
  }
}

/// `{"message", "error", "statusCode"}`, in that order.
pub fn message_body(status: u16, message: &str) -> Value {
  let mut body = Map::new();
  body.insert("message".to_string(), Value::String(message.to_string()));
  body.insert(
    "error".to_string(),
    Value::String(reason(status).to_string()),
  );
  body.insert("statusCode".to_string(), json!(status));
  Value::Object(body)
}

impl ApiError {
  pub fn with_message(status: u16, message: &str) -> Self {
    ApiError::Http {
      status,
      body: message_body(status, message),
    }
  }

  pub fn bad_request(message: &str) -> Self {
    Self::with_message(400, message)
  }

  pub fn bad_request_body(body: Value) -> Self {
    ApiError::Http { status: 400, body }
  }

  pub fn unauthorized(message: &str) -> Self {
    Self::with_message(401, message)
  }

  pub fn forbidden(message: &str) -> Self {
    Self::with_message(403, message)
  }

  pub fn forbidden_body(body: Value) -> Self {
    ApiError::Http { status: 403, body }
  }

  pub fn not_found_body(body: Value) -> Self {
    ApiError::Http { status: 404, body }
  }

  pub fn status(&self) -> u16 {
    match self {
      ApiError::Http { status, .. } => *status,
      ApiError::Internal(_) => 500,
    }
  }

  /// The JSON body an `Http` error carries (tests read refusal codes here).
  pub fn body(&self) -> Value {
    match self {
      ApiError::Http { body, .. } => body.clone(),
      ApiError::Internal(_) => json!({ "statusCode": 500, "message": "Internal server error" }),
    }
  }

  /// What went wrong, for the log.
  pub fn describe(&self) -> String {
    match self {
      ApiError::Http { status, body } => format!("{status} {body}"),
      ApiError::Internal(message) => message.clone(),
    }
  }

  pub fn code(&self) -> Option<String> {
    match self {
      ApiError::Http { body, .. } => body.get("code").and_then(Value::as_str).map(str::to_string),
      ApiError::Internal(_) => None,
    }
  }
}

impl From<NoBody> for ApiError {
  fn from(_: NoBody) -> Self {
    ApiError::Internal(
      "Cannot read properties of undefined (the request has no JSON body)".to_string(),
    )
  }
}
