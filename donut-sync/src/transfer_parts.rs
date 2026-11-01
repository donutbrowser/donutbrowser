//! Uploads in parts through this server, for a store sealed at rest. A proxy
//! in front of the server (Cloudflare) limits each request's size and time,
//! so a large file goes up in `PART_SIZE` pieces on the signed PUT URL that
//! presign-upload hands out as `transfer.url`:
//!
//! ```text
//! POST   url                     x-donut-upload-length: N, the signed x-amz-meta-*, Content-Type
//!        -> 200 {"upload": T, "partSize": P, "parts": n}
//! PUT    url&upload=T&part=i     i in 1..=n, exactly P bytes (the last part: the rest)
//!        -> 200, ETag
//! POST   url&upload=T&op=complete  {"parts": [ETag of part 1, ...]}  -> 200
//! DELETE url&upload=T            -> 204
//! ```
//!
//! The token T is signed and names the object, the storage upload and the
//! sealing salt, so the server keeps no state between requests. A part may be
//! sent again. Each part is sealed as whole frames of one object, numbered
//! where the part starts, so the joined object reads like any sealed object.

use base64::Engine;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::http::request::Parts;
use hyper::{Method, Response, StatusCode, header};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::at_rest::{self, FRAME, Salt, Sealer};
use crate::http::{ResBody, drain, full, json_response};
use crate::store::Store;
use crate::time;
use crate::transfer::{
  Grant, Signed, TransferSigner, bad_signature, body_stream, content_length, header_text,
  missing_length, s3_error, signed_metadata, store_refusal,
};

/// Plaintext bytes per part: far under a proxy's request limit, and sent
/// within its timeout on a slow uplink. A whole number of frames, and above
/// S3's 5 MB minimum part.
pub const PART_SIZE: u64 = 8 * 1024 * 1024;
/// How long an upload may take once started.
const UPLOAD_TTL_MS: i64 = 24 * 3600 * 1000;
pub const LENGTH_HEADER: &str = "x-donut-upload-length";
/// S3's most parts in one upload.
const MAX_PARTS: u64 = 10_000;
const MAX_COMPLETE_BODY: usize = 1024 * 1024;
const TOKEN_CONTEXT: &[u8] = b"donut-sync upload token v1\n";

const _: () = assert!(PART_SIZE.is_multiple_of(FRAME as u64) && PART_SIZE >= 5 * 1024 * 1024);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Token {
  key: String,
  upload_id: String,
  key_id: String,
  salt: String,
  length: u64,
  part_size: u64,
  expires_ms: i64,
}

impl Token {
  fn parts(&self) -> u64 {
    self.length.div_ceil(self.part_size).max(1)
  }

  fn part_len(&self, part: u64) -> u64 {
    if part < self.parts() {
      self.part_size
    } else {
      self.length - (self.parts() - 1) * self.part_size
    }
  }

  fn salt(&self) -> Option<Salt> {
    hex::decode(&self.salt).ok()?.try_into().ok()
  }

  fn seal(&self, signer: &TransferSigner) -> String {
    let json = serde_json::to_vec(self).expect("a token serializes");
    let tag = signer.tag(&[TOKEN_CONTEXT, &json].concat());
    format!(
      "{}.{}",
      base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&json),
      hex::encode(tag)
    )
  }

  /// The token, when it is ours, for `key`, and not expired.
  fn open(signer: &TransferSigner, text: &str, key: &str, now_ms: i64) -> Option<Self> {
    let (body, tag) = text.split_once('.')?;
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
      .decode(body)
      .ok()?;
    if !signer.tag_holds(&[TOKEN_CONTEXT, &json].concat(), &hex::decode(tag).ok()?) {
      return None;
    }
    let token: Self = serde_json::from_slice(&json).ok()?;
    (token.key == key && now_ms <= token.expires_ms).then_some(token)
  }
}

fn invalid(code: &str, message: &str) -> Response<ResBody> {
  s3_error(400, code, message)
}

/// Starts an upload of `x-donut-upload-length` bytes.
pub async fn start(
  store: &Arc<dyn Store>,
  signer: &TransferSigner,
  grant: Grant,
  parts: &Parts,
  body: Incoming,
) -> Response<ResBody> {
  drain(body).await;
  let key = grant.key.clone();
  let metadata = match signed_metadata(parts, grant) {
    Ok(metadata) => metadata,
    Err(refusal) => return *refusal,
  };
  let Some(length) = header_text(parts, LENGTH_HEADER).and_then(|v| v.trim().parse::<u64>().ok())
  else {
    return invalid(
      "MissingUploadLength",
      "Send the file size as x-donut-upload-length.",
    );
  };
  if length.div_ceil(PART_SIZE) > MAX_PARTS {
    return invalid(
      "EntityTooLarge",
      "The file is too large to upload in parts.",
    );
  }
  let content_type = header_text(parts, header::CONTENT_TYPE);
  let upload_id = match store
    .create_multipart(&key, content_type.as_deref(), &metadata)
    .await
  {
    Ok(id) => id,
    Err(e) => return store_refusal(e),
  };
  let token = Token {
    key,
    upload_id,
    key_id: signer.keyring.current().id().to_string(),
    salt: hex::encode(at_rest::new_salt()),
    length,
    part_size: PART_SIZE,
    expires_ms: time::now_ms() + UPLOAD_TTL_MS,
  };
  json_response(
    200,
    &serde_json::json!({
      "upload": token.seal(signer),
      "partSize": token.part_size,
      "parts": token.parts(),
    }),
  )
}

/// A part, the completion or the abort of a started upload.
pub async fn serve(
  store: &Arc<dyn Store>,
  signer: &TransferSigner,
  signed: Signed,
  parts: &Parts,
  body: Incoming,
) -> Response<ResBody> {
  let token = signed
    .upload
    .as_deref()
    .and_then(|text| Token::open(signer, text, &signed.grant.key, time::now_ms()));
  let Some(token) = token else {
    drain(body).await;
    return bad_signature();
  };
  match (&parts.method, signed.op.as_deref()) {
    (&Method::PUT, None) => part(store, signer, &token, signed.part.as_deref(), parts, body).await,
    (&Method::POST, Some("complete")) => complete(store, &token, body).await,
    (&Method::DELETE, None) => {
      drain(body).await;
      match store.abort_multipart(&token.key, &token.upload_id).await {
        Ok(()) => Response::builder()
          .status(StatusCode::NO_CONTENT)
          .body(full(Bytes::new()))
          .expect("static response parts are valid"),
        Err(e) => store_refusal(e),
      }
    }
    _ => {
      drain(body).await;
      bad_signature()
    }
  }
}

async fn part(
  store: &Arc<dyn Store>,
  signer: &TransferSigner,
  token: &Token,
  number: Option<&str>,
  parts: &Parts,
  body: Incoming,
) -> Response<ResBody> {
  let Some(number) = number
    .and_then(|n| n.parse::<u64>().ok())
    .filter(|n| (1..=token.parts()).contains(n))
  else {
    drain(body).await;
    return invalid(
      "InvalidPart",
      "The part number is not one of this upload's.",
    );
  };
  let Some(length) = content_length(parts) else {
    drain(body).await;
    return missing_length();
  };
  let expected = token.part_len(number);
  if length != expected {
    drain(body).await;
    return invalid(
      "InvalidPart",
      &format!("Part {number} must be {expected} bytes, not {length}."),
    );
  }
  let first_frame = (number - 1) * token.part_size / FRAME as u64;
  let sealer = token
    .salt()
    .and_then(|salt| Sealer::for_part(&signer.keyring, &token.key_id, &salt, first_frame));
  let Some(sealer) = sealer else {
    drain(body).await;
    return invalid("InvalidUpload", "This upload's key is no longer held.");
  };
  let last = number == token.parts();
  let sealed_len = at_rest::sealed_part_len(&token.key_id, length, number == 1, last);
  let sealed = at_rest::seal_part_stream(sealer, last, body_stream(body));
  match store
    .upload_part(
      &token.key,
      &token.upload_id,
      number as u32,
      sealed,
      sealed_len,
    )
    .await
  {
    Ok(etag) => Response::builder()
      .status(200)
      .header(header::ETAG, etag)
      .header(header::CONTENT_LENGTH, 0)
      .body(full(Bytes::new()))
      .unwrap_or_else(|_| s3_error(500, "InternalError", "Storage gave an invalid ETag.")),
    Err(e) => store_refusal(e),
  }
}

#[derive(Deserialize)]
struct Completion {
  parts: Vec<String>,
}

async fn complete(store: &Arc<dyn Store>, token: &Token, body: Incoming) -> Response<ResBody> {
  let bytes = match http_body_util::Limited::new(body, MAX_COMPLETE_BODY)
    .collect()
    .await
  {
    Ok(collected) => collected.to_bytes(),
    Err(_) => return invalid("MalformedXML", "The completion body is too large."),
  };
  let Ok(completion) = serde_json::from_slice::<Completion>(&bytes) else {
    return invalid("MalformedXML", "Send {\"parts\": [ETag, ...]}.");
  };
  if completion.parts.len() as u64 != token.parts() {
    return invalid(
      "InvalidPart",
      &format!("This upload has {} parts.", token.parts()),
    );
  }
  match store
    .complete_multipart(&token.key, &token.upload_id, &completion.parts)
    .await
  {
    Ok(()) => Response::builder()
      .status(200)
      .header(header::CONTENT_LENGTH, 0)
      .body(full(Bytes::new()))
      .expect("static response parts are valid"),
    Err(e) => store_refusal(e),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::at_rest::Keyring;

  fn signer(keys: &str) -> TransferSigner {
    TransferSigner::new(&Arc::new(Keyring::parse(keys).unwrap()))
  }

  const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  fn token(length: u64) -> Token {
    Token {
      key: "users/u/a".to_string(),
      upload_id: "id".to_string(),
      key_id: "k1".to_string(),
      salt: hex::encode([7u8; 32]),
      length,
      part_size: PART_SIZE,
      expires_ms: 1000,
    }
  }

  #[test]
  fn tokens_are_bound_to_their_key_signer_and_time() {
    let signer = signer(K1);
    let text = token(5).seal(&signer);
    assert_eq!(
      Token::open(&signer, &text, "users/u/a", 1000),
      Some(token(5))
    );
    assert_eq!(Token::open(&signer, &text, "users/u/b", 0), None);
    assert_eq!(Token::open(&signer, &text, "users/u/a", 1001), None);
    let other = signer_other();
    assert_eq!(Token::open(&other, &text, "users/u/a", 0), None);
    let (body, tag) = text.split_once('.').unwrap();
    let mut json = base64::engine::general_purpose::URL_SAFE_NO_PAD
      .decode(body)
      .unwrap();
    let at = json.iter().position(|&b| b == b'5').unwrap();
    json[at] = b'6';
    let forged = format!(
      "{}.{tag}",
      base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    );
    assert_eq!(Token::open(&signer, &forged, "users/u/a", 0), None);
  }

  fn signer_other() -> TransferSigner {
    signer("k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
  }

  #[test]
  fn parts_split_the_length() {
    assert_eq!((token(0).parts(), token(0).part_len(1)), (1, 0));
    assert_eq!(token(PART_SIZE).parts(), 1);
    let t = token(2 * PART_SIZE + 3);
    assert_eq!(t.parts(), 3);
    assert_eq!(
      (t.part_len(1), t.part_len(2), t.part_len(3)),
      (PART_SIZE, PART_SIZE, 3)
    );
  }
}
