//! Transfers through this server, for a store sealed at rest. Devices cannot
//! go to storage directly, so the presign routes hand out URLs to `PATH` here,
//! signed and expiring like S3's, and the body streams through the sealed
//! store. A device sends and reads exactly what it did with S3: the same
//! method, `Content-Length`, `Content-Type` and the signed `x-amz-meta-*`.
//!
//! A request body through a proxy such as Cloudflare has a size and time
//! limit, so newer apps upload large files in parts (`transfer_parts`).

use std::sync::Arc;

use bytes::Bytes;
use futures_util::StreamExt;
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::http::request::Parts;
use hyper::{Method, Response, header};
use sha2::Sha256;

use crate::at_rest::Keyring;
use crate::http::{BoxError, ResBody, drain, full};
use crate::slots::{SLOT_WAIT, Slot, Slots};
use crate::store::{Store, StoreError, Upload};
use crate::time;
use crate::transfer_parts;

pub const PATH: &str = "/v1/transfer";
/// A request body that sends nothing for this long is dropped.
const BODY_IDLE: std::time::Duration = std::time::Duration::from_secs(60);
const RETRY_AFTER_SECS: u64 = 5;
const META_PARAM: &str = "meta-";
/// Query parameters a part request adds to a signed URL. The upload token
/// authenticates them, so they are not part of the URL's signature.
const UPLOAD_PARAM: &str = "upload";
const PART_PARAM: &str = "part";
const OP_PARAM: &str = "op";

pub struct TransferSigner {
  /// The current key's first; any of them verifies.
  keys: Vec<[u8; 32]>,
  pub(crate) keyring: Arc<Keyring>,
  pub(crate) slots: Slots,
  pub(crate) parts: transfer_parts::Ledger,
}

/// What a valid URL lets its holder do.
#[derive(Debug, PartialEq)]
pub struct Grant {
  pub key: String,
  pub metadata: Vec<(String, String)>,
}

/// A URL whose signature holds, with what a part request added to it.
#[derive(Debug, PartialEq)]
pub struct Signed {
  pub grant: Grant,
  pub expires_ms: i64,
  pub upload: Option<String>,
  pub part: Option<String>,
  pub op: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Refusal {
  Expired,
  BadSignature,
}

fn field(mac: &mut Hmac<Sha256>, value: &str) {
  mac.update(&(value.len() as u64).to_be_bytes());
  mac.update(value.as_bytes());
}

impl TransferSigner {
  pub fn new(keyring: &Arc<Keyring>) -> Self {
    Self {
      keys: keyring.url_keys(),
      keyring: keyring.clone(),
      slots: Slots::default(),
      parts: transfer_parts::Ledger::default(),
    }
  }

  fn mac(
    key: &[u8; 32],
    method: &str,
    object_key: &str,
    expires_ms: &str,
    metadata: &[(String, String)],
  ) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    for value in ["v1", method, object_key, expires_ms] {
      field(&mut mac, value);
    }
    let mut sorted = metadata.to_vec();
    sorted.sort();
    for (name, value) in &sorted {
      field(&mut mac, name);
      field(&mut mac, value);
    }
    mac
  }

  /// `origin` is how devices reach this server, e.g. `https://sync.example.com`.
  pub fn url(
    &self,
    origin: &str,
    method: &str,
    object_key: &str,
    expires_ms: i64,
    metadata: &[(String, String)],
  ) -> String {
    let expires = expires_ms.to_string();
    let signature = Self::mac(&self.keys[0], method, object_key, &expires, metadata)
      .finalize()
      .into_bytes();
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("key", object_key);
    query.append_pair("expires", &expires);
    for (name, value) in metadata {
      query.append_pair(&format!("{META_PARAM}{name}"), value);
    }
    query.append_pair("sig", &hex::encode(signature));
    format!("{origin}{PATH}?{}", query.finish())
  }

  pub fn verify(&self, method: &str, query: &str, now_ms: i64) -> Result<Grant, Refusal> {
    let signed = self.check(method, query)?;
    if now_ms > signed.expires_ms {
      return Err(Refusal::Expired);
    }
    Ok(signed.grant)
  }

  /// The signature only; the caller decides whether the URL's time counts.
  pub fn check(&self, method: &str, query: &str) -> Result<Signed, Refusal> {
    let mut key = None;
    let mut expires = None;
    let mut signature = None;
    let mut metadata = Vec::new();
    let (mut upload, mut part, mut op) = (None, None, None);
    for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
      match name.as_ref() {
        "key" if key.is_none() => key = Some(value.into_owned()),
        "expires" if expires.is_none() => expires = Some(value.into_owned()),
        "sig" if signature.is_none() => signature = Some(value.into_owned()),
        UPLOAD_PARAM if upload.is_none() => upload = Some(value.into_owned()),
        PART_PARAM if part.is_none() => part = Some(value.into_owned()),
        OP_PARAM if op.is_none() => op = Some(value.into_owned()),
        other => match other.strip_prefix(META_PARAM) {
          Some(meta) => metadata.push((meta.to_string(), value.into_owned())),
          None => return Err(Refusal::BadSignature),
        },
      }
    }
    let (Some(key), Some(expires), Some(signature)) = (key, expires, signature) else {
      return Err(Refusal::BadSignature);
    };
    let signature = hex::decode(signature).map_err(|_| Refusal::BadSignature)?;
    let signed = self.keys.iter().any(|k| {
      Self::mac(k, method, &key, &expires, &metadata)
        .verify_slice(&signature)
        .is_ok()
    });
    if !signed {
      return Err(Refusal::BadSignature);
    }
    let expires_ms: i64 = expires.parse().map_err(|_| Refusal::BadSignature)?;
    Ok(Signed {
      grant: Grant { key, metadata },
      expires_ms,
      upload,
      part,
      op,
    })
  }

  /// HMAC of `data` under the current key, for upload tokens.
  pub(crate) fn tag(&self, data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(&self.keys[0]).expect("HMAC takes any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
  }

  /// Whether `tag` is `data`'s under any key.
  pub(crate) fn tag_holds(&self, data: &[u8], tag: &[u8]) -> bool {
    self.keys.iter().any(|key| {
      let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
      mac.update(data);
      mac.verify_slice(tag).is_ok()
    })
  }
}

/// An S3-style error document, so a device logs what S3 would have said.
pub(crate) fn s3_error(status: u16, code: &str, message: &str) -> Response<ResBody> {
  let body = format!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{code}</Code><Message>{message}</Message></Error>"
  );
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, "application/xml")
    .header(header::CONTENT_LENGTH, body.len())
    .body(full(body))
    .expect("static response parts are valid")
}

pub(crate) fn store_refusal(error: StoreError) -> Response<ResBody> {
  match error {
    StoreError::NotFound => s3_error(404, "NoSuchKey", "The specified key does not exist."),
    StoreError::Service { status, code, .. } if (400..500).contains(&status) => {
      s3_error(status, &code, "")
    }
    other => {
      crate::log::error(PATH, &format!("Transfer failed err=\"{other}\""));
      s3_error(
        500,
        "InternalError",
        "We encountered an internal error. Please try again.",
      )
    }
  }
}

pub(crate) fn header_text(parts: &Parts, name: impl header::AsHeaderName) -> Option<String> {
  parts
    .headers
    .get(name)
    .map(|v| v.as_bytes().iter().map(|&b| b as char).collect())
}

pub async fn serve(
  store: &Arc<dyn Store>,
  signer: &TransferSigner,
  parts: &Parts,
  body: Incoming,
) -> Response<ResBody> {
  // A GET URL reads; a PUT URL writes, in one request or in parts.
  let signed_for = if parts.method == Method::GET {
    "GET"
  } else {
    "PUT"
  };
  let signed = match signer.check(signed_for, parts.uri.query().unwrap_or("")) {
    Ok(signed) => signed,
    Err(_) => {
      drain(body).await;
      return bad_signature();
    }
  };
  // Parts carry an upload token, which outlives the URL that started them.
  if signed.upload.is_none() && time::now_ms() > signed.expires_ms {
    drain(body).await;
    return s3_error(403, "AccessDenied", "Request has expired");
  }
  let Some(slot) = signer.slots.acquire(&signed.grant.key, SLOT_WAIT).await else {
    drain(body).await;
    return busy();
  };
  let response = match (&parts.method, signed.upload.is_some()) {
    (&Method::GET, false) => {
      drain(body).await;
      return download(store, &signed.grant.key, slot).await;
    }
    (&Method::PUT, false) => upload(store, signed.grant, parts, body).await,
    (&Method::POST, false) => {
      transfer_parts::start(store, signer, signed.grant, signed.expires_ms, parts, body).await
    }
    (&Method::PUT | &Method::POST | &Method::DELETE, true) => {
      transfer_parts::serve(store, signer, signed, parts, body).await
    }
    _ => {
      drain(body).await;
      bad_signature()
    }
  };
  drop(slot);
  response
}

/// The server is at its limit: S3's answer, which clients retry.
pub(crate) fn busy() -> Response<ResBody> {
  let mut response = s3_error(503, "SlowDown", "Please reduce your request rate.");
  response.headers_mut().insert(
    header::RETRY_AFTER,
    header::HeaderValue::from(RETRY_AFTER_SECS),
  );
  response
}

pub(crate) fn bad_signature() -> Response<ResBody> {
  s3_error(
    403,
    "SignatureDoesNotMatch",
    "The request signature we calculated does not match the signature you provided.",
  )
}

/// The `x-amz-meta-*` a request sent, when they are exactly the signed ones.
pub(crate) fn signed_metadata(
  parts: &Parts,
  grant: Grant,
) -> Result<Vec<(String, String)>, Box<Response<ResBody>>> {
  let mut sent: Vec<(String, String)> = parts
    .headers
    .iter()
    .filter_map(|(name, value)| {
      name.as_str().strip_prefix("x-amz-meta-").map(|n| {
        (
          n.to_string(),
          value.as_bytes().iter().map(|&b| b as char).collect(),
        )
      })
    })
    .collect();
  sent.sort();
  let mut signed = grant.metadata;
  signed.sort();
  if sent != signed {
    return Err(Box::new(s3_error(
      403,
      "AccessDenied",
      "There were headers present in the request which were not signed",
    )));
  }
  Ok(signed)
}

/// A request body as a store stream.
/// A request body as a store stream. A client that sends nothing for
/// `BODY_IDLE` ends it with an error.
pub(crate) fn body_stream(body: Incoming) -> crate::store::ByteStream {
  let chunks = body.into_data_stream();
  Box::pin(futures_util::stream::unfold(
    Some(chunks),
    |chunks| async move {
      let mut chunks = chunks?;
      match tokio::time::timeout(BODY_IDLE, chunks.next()).await {
        Ok(Some(Ok(bytes))) => Some((Ok(bytes), Some(chunks))),
        Ok(Some(Err(e))) => Some((Err(StoreError::Transport(e.to_string())), None)),
        Ok(None) => None,
        Err(_) => Some((
          Err(StoreError::Transport(format!(
            "the client sent nothing for {} s",
            BODY_IDLE.as_secs()
          ))),
          None,
        )),
      }
    },
  ))
}

pub(crate) fn content_length(parts: &Parts) -> Option<u64> {
  header_text(parts, header::CONTENT_LENGTH).and_then(|v| v.trim().parse().ok())
}

pub(crate) fn missing_length() -> Response<ResBody> {
  s3_error(
    411,
    "MissingContentLength",
    "You must provide the Content-Length HTTP header.",
  )
}

async fn download(store: &Arc<dyn Store>, key: &str, slot: Slot) -> Response<ResBody> {
  let object = match store.get_object(key).await {
    Ok(object) => object,
    Err(e) => return store_refusal(e),
  };
  let mut response = Response::builder().status(200);
  if let Some(length) = object.head.content_length {
    response = response.header(header::CONTENT_LENGTH, length);
  }
  if let Some(content_type) = &object.head.content_type {
    response = response.header(header::CONTENT_TYPE, content_type.as_str());
  }
  if let Some(ms) = object.head.last_modified_ms {
    response = response.header(header::LAST_MODIFIED, time::http_date(ms));
  }
  for (name, value) in &object.head.metadata {
    response = response.header(format!("x-amz-meta-{name}"), value.as_str());
  }
  let key = key.to_string();
  // The slot is held until the body is sent.
  let body = object.body.map(move |chunk| {
    let _slot = &slot;
    chunk.map(Frame::data).map_err(|e| {
      crate::log::error(PATH, &format!("Download cut off key={key} err=\"{e}\""));
      BoxError::from(e)
    })
  });
  response
    .body(StreamBody::new(body).boxed_unsync())
    .unwrap_or_else(|_| {
      s3_error(
        500,
        "InternalError",
        "Stored metadata is not a header value.",
      )
    })
}

async fn upload(
  store: &Arc<dyn Store>,
  grant: Grant,
  parts: &Parts,
  body: Incoming,
) -> Response<ResBody> {
  let key = grant.key.clone();
  let signed = match signed_metadata(parts, grant) {
    Ok(signed) => signed,
    Err(refusal) => {
      drain(body).await;
      return *refusal;
    }
  };
  let Some(length) = content_length(parts) else {
    drain(body).await;
    return missing_length();
  };
  let content_type = header_text(parts, header::CONTENT_TYPE);
  match store
    .put_object_stream(
      &key,
      body_stream(body),
      Upload {
        length,
        content_type: content_type.as_deref(),
        metadata: &signed,
        if_match: None,
      },
    )
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

  fn signer() -> TransferSigner {
    TransferSigner::new(&Arc::new(
      Keyring::parse("k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").unwrap(),
    ))
  }

  fn query(url: &str) -> &str {
    url.split_once('?').unwrap().1
  }

  #[test]
  fn urls_verify_for_their_method_key_metadata_and_lifetime() {
    let signer = signer();
    let metadata = vec![
      ("updated-at".to_string(), "17".to_string()),
      ("group-id".to_string(), "g 1&x".to_string()),
    ];
    let url = signer.url(
      "https://sync.example.com",
      "PUT",
      "users/u/a b+c",
      1000,
      &metadata,
    );
    assert!(url.starts_with("https://sync.example.com/v1/transfer?key=users%2Fu%2Fa+b%2Bc&"));
    let grant = signer.verify("PUT", query(&url), 1000).unwrap();
    assert_eq!(grant.key, "users/u/a b+c");
    assert_eq!(grant.metadata.len(), 2);
    assert_eq!(
      signer.verify("PUT", query(&url), 1001),
      Err(Refusal::Expired)
    );
    assert_eq!(
      signer.verify("GET", query(&url), 0),
      Err(Refusal::BadSignature)
    );
    let tampered = query(&url).replace("updated-at=17", "updated-at=18");
    assert_eq!(
      signer.verify("PUT", &tampered, 0),
      Err(Refusal::BadSignature)
    );
    let moved = query(&url).replace("key=users%2Fu", "key=users%2Fv");
    assert_eq!(signer.verify("PUT", &moved, 0), Err(Refusal::BadSignature));
    let added = format!("{}&meta-x=1", query(&url));
    assert_eq!(signer.verify("PUT", &added, 0), Err(Refusal::BadSignature));
    let extended = query(&url).replace("expires=1000", "expires=9999");
    assert_eq!(
      signer.verify("PUT", &extended, 0),
      Err(Refusal::BadSignature)
    );
  }

  #[test]
  fn an_old_key_still_verifies_after_rotation() {
    let old = signer();
    let url = old.url("http://h", "GET", "k", 50, &[]);
    let rotated = TransferSigner::new(&Arc::new(
      Keyring::parse(
        "k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=,k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      )
      .unwrap(),
    ));
    assert!(rotated.verify("GET", query(&url), 0).is_ok());
    let removed = TransferSigner::new(&Arc::new(
      Keyring::parse("k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=").unwrap(),
    ));
    assert_eq!(
      removed.verify("GET", query(&url), 0),
      Err(Refusal::BadSignature)
    );
  }
}
