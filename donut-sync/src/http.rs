//! Requests in, answers out, in the order the original server handled them:
//! body parsing first (for every request), then CORS, then the route.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::http::request::Parts;
use hyper::{Method, Request, Response, StatusCode, header};
use serde_json::{Map, Value, json};

use crate::auth::{AuthError, Guard, UserContext, safe_equal};
use crate::error::{ApiError, message_body};
use crate::jsval::Body;
use crate::log;
use crate::sync::SyncService;

pub type ResBody = BoxBody<Bytes, Infallible>;

/// The JSON body limit (`50mb` in body-parser terms).
pub const BODY_LIMIT: usize = 50 * 1024 * 1024;

pub struct AppState {
  pub guard: Guard,
  pub sync: Arc<SyncService>,
  pub internal_key: Option<String>,
  /// The normalized `SYNC_PUBLIC_URL`, for `/readyz`.
  pub account_url: Option<String>,
}

fn full(bytes: impl Into<Bytes>) -> ResBody {
  Full::new(bytes.into())
    .map_err(|never| match never {})
    .boxed()
}

fn json_response(status: u16, body: &Value) -> Response<ResBody> {
  let text = body.to_string();
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
    .header(header::CONTENT_LENGTH, text.len())
    .body(full(text))
    .expect("static response parts are valid")
}

fn error_response(error: ApiError) -> Response<ResBody> {
  if let ApiError::Internal(message) = &error {
    log::error("ExceptionsHandler", message);
  }
  json_response(error.status(), &error.body())
}

/// body-parser's own refusals: `{"statusCode", "message"}`.
fn parser_error(status: u16, message: &str) -> Response<ResBody> {
  json_response(status, &json!({ "statusCode": status, "message": message }))
}

fn latin1(bytes: &[u8]) -> String {
  bytes.iter().map(|&b| b as char).collect()
}

fn header_value(parts: &Parts, name: impl header::AsHeaderName) -> Option<String> {
  parts.headers.get(name).map(|v| latin1(v.as_bytes()))
}

/// Reads and discards what is left of a refused body, as Node did, so the
/// client finishes sending and reads the answer instead of a reset
/// connection. Bounded, so a client cannot keep the server reading.
async fn drain(mut body: Incoming) {
  const MAX: usize = 128 * 1024 * 1024;
  let mut read = 0usize;
  let _ = tokio::time::timeout(Duration::from_secs(30), async {
    while let Some(Ok(frame)) = body.frame().await {
      read += frame.data_ref().map_or(0, |data| data.len());
      if read > MAX {
        break;
      }
    }
  })
  .await;
}

/// The JSON body, read the way Express's JSON parser read it: only for
/// `application/json`, at most 50 MiB, an object or an array at the top.
/// `Err` is the parser's own answer (sent without CORS headers, as before).
async fn read_json_body(parts: &Parts, body: Incoming) -> Result<Body, Box<Response<ResBody>>> {
  let has_body = parts.headers.contains_key(header::TRANSFER_ENCODING)
    || header_value(parts, header::CONTENT_LENGTH).is_some_and(|v| v.trim().parse::<u64>().is_ok());
  let content_type = header_value(parts, header::CONTENT_TYPE).unwrap_or_default();
  let mut params = content_type.split(';');
  let media_type = params.next().unwrap_or("").trim().to_ascii_lowercase();
  if media_type != "application/json" || !has_body {
    // Not JSON: the routes see no body, as before.
    drain(body).await;
    return Ok(Body(None));
  }
  let charset = params.find_map(|param| {
    let (name, value) = param.split_once('=')?;
    (name.trim().eq_ignore_ascii_case("charset"))
      .then(|| value.trim().trim_matches('"').to_ascii_lowercase())
  });
  if let Some(charset) = charset.filter(|c| !c.starts_with("utf-")) {
    return Err(Box::new(parser_error(
      415,
      &format!("unsupported charset \"{}\"", charset.to_ascii_uppercase()),
    )));
  }
  if let Some(encoding) = header_value(parts, header::CONTENT_ENCODING)
    .map(|e| e.trim().to_ascii_lowercase())
    .filter(|e| e != "identity")
  {
    return Err(Box::new(parser_error(
      415,
      &format!("unsupported content encoding \"{encoding}\""),
    )));
  }
  let declared =
    header_value(parts, header::CONTENT_LENGTH).and_then(|v| v.trim().parse::<u64>().ok());
  if declared.is_some_and(|length| length > BODY_LIMIT as u64) {
    drain(body).await;
    return Err(Box::new(parser_error(413, "request entity too large")));
  }
  let mut body = body;
  let mut bytes = Vec::new();
  while let Some(frame) = body.frame().await {
    let Ok(frame) = frame else {
      return Err(Box::new(parser_error(400, "request aborted")));
    };
    if let Ok(data) = frame.into_data() {
      bytes.extend_from_slice(&data);
      if bytes.len() > BODY_LIMIT {
        drain(body).await;
        return Err(Box::new(parser_error(413, "request entity too large")));
      }
    }
  }
  if bytes.is_empty() {
    return Ok(Body(Some(Value::Object(Map::new()))));
  }
  let text = String::from_utf8_lossy(&bytes);
  let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
  let first = text
    .trim_start_matches([' ', '\t', '\n', '\r'])
    .chars()
    .next();
  if !matches!(first, Some('{' | '[')) {
    let token = first.map(String::from).unwrap_or_default();
    let snippet: String = text.chars().take(32).collect();
    let snippet = if text.chars().nth(32).is_some() {
      format!("{snippet}...")
    } else {
      snippet
    };
    return Err(Box::new(json_response(
      400,
      &message_body(
        400,
        &format!("Unexpected token '{token}', \"{snippet}\" is not valid JSON"),
      ),
    )));
  }
  serde_json::from_str::<Value>(text)
    .map(|value| Body(Some(value)))
    .map_err(|e| Box::new(json_response(400, &message_body(400, &e.to_string()))))
}

fn with_cors(mut response: Response<ResBody>) -> Response<ResBody> {
  response.headers_mut().insert(
    header::ACCESS_CONTROL_ALLOW_ORIGIN,
    header::HeaderValue::from_static("*"),
  );
  response
}

fn preflight() -> Response<ResBody> {
  Response::builder()
    .status(StatusCode::NO_CONTENT)
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(
      header::ACCESS_CONTROL_ALLOW_METHODS,
      "GET,POST,PUT,DELETE,OPTIONS",
    )
    .header(
      header::ACCESS_CONTROL_ALLOW_HEADERS,
      "Content-Type,Authorization",
    )
    .header(header::CONTENT_LENGTH, "0")
    .body(full(Bytes::new()))
    .expect("static response parts are valid")
}

pub async fn handle(
  state: Arc<AppState>,
  request: Request<Incoming>,
) -> Result<Response<ResBody>, Infallible> {
  let (parts, body) = request.into_parts();
  let body = match read_json_body(&parts, body).await {
    Ok(body) => body,
    Err(response) => return Ok(*response),
  };
  if parts.method == Method::OPTIONS {
    return Ok(preflight());
  }
  Ok(with_cors(route(&state, &parts, body).await))
}

/// Routes match without regard to case and with an optional trailing slash.
fn route_path(path: &str) -> String {
  let trimmed = if path.len() > 1 {
    path.strip_suffix('/').unwrap_or(path)
  } else {
    path
  };
  trimmed.to_ascii_lowercase()
}

async fn route(state: &Arc<AppState>, parts: &Parts, body: Body) -> Response<ResBody> {
  let method = if parts.method == Method::HEAD {
    Method::GET
  } else {
    parts.method.clone()
  };
  let path = route_path(parts.uri.path());
  match (&method, path.as_str()) {
    (&Method::GET, "/") => Response::builder()
      .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
      .header(header::CONTENT_LENGTH, "18")
      .body(full("Donut Sync Service"))
      .expect("static response parts are valid"),
    (&Method::GET, "/health") => json_response(200, &json!({ "status": "ok" })),
    (&Method::GET, "/readyz") => readiness(state).await,
    (&Method::GET, "/v1/objects/subscribe") => match authenticate(state, parts).await {
      Ok(ctx) => subscribe(state, ctx),
      Err(response) => *response,
    },
    (&Method::POST, "/v1/internal/cleanup-excess-profiles") => {
      match cleanup_excess_profiles(state, parts, &body).await {
        Ok(value) => json_response(200, &value),
        Err(error) => error_response(error),
      }
    }
    (&Method::POST, object_route) if object_route.starts_with("/v1/objects/") => {
      let name = &object_route["/v1/objects/".len()..];
      if !OBJECT_ROUTES.contains(&name) {
        return not_found(parts);
      }
      let ctx = match authenticate(state, parts).await {
        Ok(ctx) => ctx,
        Err(response) => return *response,
      };
      match object_route_call(&state.sync, name, &body, &ctx).await {
        Ok(value) => json_response(200, &value),
        Err(error) => error_response(error),
      }
    }
    _ => not_found(parts),
  }
}

const OBJECT_ROUTES: [&str; 12] = [
  "stat",
  "presign-upload",
  "presign-download",
  "delete",
  "list",
  "presign-upload-batch",
  "presign-download-batch",
  "delete-prefix",
  "snapshots/list",
  "snapshots/create",
  "snapshots/delete",
  "snapshots/restore-files",
];

async fn object_route_call(
  sync: &SyncService,
  name: &str,
  body: &Body,
  ctx: &UserContext,
) -> Result<Value, ApiError> {
  match name {
    "stat" => sync.stat(body, ctx).await,
    "presign-upload" => sync.presign_upload(body, ctx).await,
    "presign-download" => sync.presign_download(body, ctx).await,
    "delete" => sync.delete(body, ctx).await,
    "list" => sync.list(body, ctx).await,
    "presign-upload-batch" => sync.presign_upload_batch(body, ctx).await,
    "presign-download-batch" => sync.presign_download_batch(body, ctx).await,
    "delete-prefix" => sync.delete_prefix(body, ctx).await,
    "snapshots/list" => sync.list_snapshots(body, ctx).await,
    "snapshots/create" => sync.create_snapshot(body, ctx).await,
    "snapshots/delete" => sync.delete_snapshot(body, ctx).await,
    "snapshots/restore-files" => sync.restore_snapshot_files(body, ctx).await,
    _ => unreachable!("routes are checked against OBJECT_ROUTES"),
  }
}

fn not_found(parts: &Parts) -> Response<ResBody> {
  let url = parts.uri.path_and_query().map_or_else(
    || parts.uri.path().to_string(),
    |pq| pq.as_str().to_string(),
  );
  json_response(
    404,
    &message_body(404, &format!("Cannot {} {url}", parts.method)),
  )
}

async fn authenticate(
  state: &AppState,
  parts: &Parts,
) -> Result<UserContext, Box<Response<ResBody>>> {
  let authorization = header_value(parts, header::AUTHORIZATION);
  state
    .guard
    .authenticate(authorization.as_deref())
    .await
    .map_err(|error| {
      Box::new(match error {
        AuthError::Unauthorized(message) => error_response(ApiError::unauthorized(message)),
        AuthError::Unavailable(message) => error_response(ApiError::with_message(503, message)),
      })
    })
}

async fn readiness(state: &AppState) -> Response<ResBody> {
  let ready = state.sync.check_s3_connectivity().await;
  let mut body = Map::new();
  body.insert(
    "status".to_string(),
    Value::String(if ready { "ready" } else { "not ready" }.to_string()),
  );
  body.insert("s3".to_string(), Value::Bool(ready));
  // The host clients are handed in presigned URLs, to compare against a
  // failing client's network (self-hosted only), and the address Donut
  // accounts sign in with.
  if let Some(endpoint) = state.sync.diagnostic_storage_endpoint() {
    body.insert(
      "storageEndpoint".to_string(),
      Value::String(endpoint.to_string()),
    );
  }
  if let Some(url) = &state.account_url {
    body.insert("accountUrl".to_string(), Value::String(url.clone()));
  }
  json_response(if ready { 200 } else { 503 }, &Value::Object(body))
}

fn subscribe(state: &AppState, ctx: UserContext) -> Response<ResBody> {
  let rx = crate::subscribe::spawn(state.sync.clone(), ctx);
  let stream = futures_util::stream::unfold(rx, |mut rx| async move {
    rx.recv()
      .await
      .map(|bytes| (Ok::<_, Infallible>(Frame::data(bytes)), rx))
  });
  Response::builder()
    .header(header::CONTENT_TYPE, "text/event-stream")
    .header(header::CONNECTION, "keep-alive")
    .header(
      header::CACHE_CONTROL,
      "private, no-cache, no-store, must-revalidate, max-age=0, no-transform",
    )
    .header(header::PRAGMA, "no-cache")
    .header(header::EXPIRES, "0")
    .header("x-accel-buffering", "no")
    .body(StreamBody::new(stream).boxed())
    .expect("static response parts are valid")
}

/// The backend's trim of an account's profiles to its plan, after a
/// downgrade. Guarded by `INTERNAL_KEY`.
async fn cleanup_excess_profiles(
  state: &AppState,
  parts: &Parts,
  body: &Body,
) -> Result<Value, ApiError> {
  let key = header_value(parts, "x-internal-key").unwrap_or_default();
  let authorized = state
    .internal_key
    .as_deref()
    .is_some_and(|expected| !key.is_empty() && safe_equal(&key, expected));
  if !authorized {
    return Err(ApiError::unauthorized("Invalid internal key"));
  }
  // The id becomes part of a destructive delete prefix, so it must be a
  // plain id: no empty value, no slashes or dots.
  let user_id = body
    .optional_field("userId")
    .as_str()
    .filter(|id| crate::auth::group_id_valid(id))
    .ok_or_else(|| ApiError::bad_request("Invalid userId"))?
    .to_string();
  let max_profiles = body
    .optional_field("maxProfiles")
    .as_number()
    .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
    .ok_or_else(|| ApiError::bad_request("Invalid maxProfiles"))?;
  state
    .sync
    .cleanup_excess_profiles(&user_id, max_profiles as usize)
    .await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn route_paths_ignore_case_and_one_trailing_slash() {
    assert_eq!(route_path("/HEALTH/"), "/health");
    assert_eq!(route_path("/"), "/");
    assert_eq!(route_path("/v1/Objects/Stat"), "/v1/objects/stat");
    assert_eq!(route_path("/health//"), "/health/");
  }
}
