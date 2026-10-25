//! S3 over HTTP: the store this server runs on, and the presigned URLs it
//! hands to clients.

use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use md5::{Digest, Md5};
use reqwest::Method;

use crate::jsval::js_number;
use crate::sigv4::{self, Credentials};
use crate::store::{HeadOutput, ListInput, ListObject, ListOutput, Store, StoreError};
use crate::time;

const MAX_ATTEMPTS: u32 = 3;
const RETRY_BASE: Duration = Duration::from_millis(100);
const RETRY_CAP: Duration = Duration::from_secs(20);

/// Where a bucket lives: its endpoint and how keys are addressed.
#[derive(Clone, Debug)]
pub struct Location {
  scheme: String,
  /// Host with the port when it is not the scheme's default.
  host: String,
  /// The endpoint's own path, without a trailing slash.
  base_path: String,
  bucket: String,
  virtual_host: bool,
}

/// A bucket name usable as a DNS label in front of the endpoint's host.
fn dns_compatible(bucket: &str, scheme: &str) -> bool {
  let ok_len = (3..=63).contains(&bucket.len());
  let ok_chars = bucket
    .bytes()
    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.');
  let ok_edges = bucket
    .bytes()
    .next()
    .zip(bucket.bytes().last())
    .is_some_and(|(a, z)| a.is_ascii_alphanumeric() && z.is_ascii_alphanumeric());
  let dotted = bucket.contains('.');
  let ip_like =
    bucket.split('.').count() == 4 && bucket.split('.').all(|part| part.parse::<u8>().is_ok());
  ok_len
    && ok_chars
    && ok_edges
    && !bucket.contains("..")
    && !ip_like
    // Over TLS, a dotted name breaks the certificate's wildcard.
    && !(dotted && scheme == "https")
}

impl Location {
  pub fn parse(endpoint: &str, bucket: &str, force_path_style: bool) -> Result<Self, String> {
    let url =
      url::Url::parse(endpoint).map_err(|e| format!("Invalid S3 endpoint {endpoint}: {e}"))?;
    let host_name = url
      .host_str()
      .ok_or_else(|| format!("Invalid S3 endpoint {endpoint}: no host"))?;
    let host = match url.port() {
      Some(port) => format!("{host_name}:{port}"),
      None => host_name.to_string(),
    };
    let scheme = url.scheme().to_string();
    let base_path = url.path().trim_end_matches('/').to_string();
    Ok(Self {
      virtual_host: !force_path_style && dns_compatible(bucket, &scheme),
      scheme,
      host,
      base_path,
      bucket: bucket.to_string(),
    })
  }

  fn request_host(&self) -> String {
    if self.virtual_host {
      format!("{}.{}", self.bucket, self.host)
    } else {
      self.host.clone()
    }
  }

  fn bucket_path(&self) -> String {
    if self.virtual_host {
      format!("{}/", self.base_path)
    } else {
      format!("{}/{}", self.base_path, sigv4::uri_encode(&self.bucket))
    }
  }

  fn object_path(&self, key: &str) -> String {
    if self.virtual_host {
      format!("{}/{}", self.base_path, sigv4::encode_key(key))
    } else {
      format!(
        "{}/{}/{}",
        self.base_path,
        sigv4::uri_encode(&self.bucket),
        sigv4::encode_key(key)
      )
    }
  }

  fn url(&self, path: &str, query: &str) -> String {
    let mut url = format!("{}://{}{}", self.scheme, self.request_host(), path);
    if !query.is_empty() {
      url.push('?');
      url.push_str(query);
    }
    url
  }
}

/// Signs the URLs clients transfer files with.
#[derive(Clone, Debug)]
pub struct Presigner {
  location: Location,
  credentials: Credentials,
  region: String,
}

impl Presigner {
  pub fn new(location: Location, credentials: Credentials, region: String) -> Self {
    Self {
      location,
      credentials,
      region,
    }
  }

  fn presign(
    &self,
    method: &str,
    operation: &str,
    key: &str,
    expires_in: f64,
    metadata: &[(String, String)],
    now_ms: i64,
  ) -> String {
    let path = self.location.object_path(key);
    let mut headers = vec![("host".to_string(), self.location.request_host())];
    for (name, value) in metadata {
      headers.push((format!("x-amz-meta-{name}"), value.clone()));
    }
    let amz_date = time::compact_stamp(now_ms);
    let signer = sigv4::Signer {
      credentials: &self.credentials,
      region: &self.region,
      amz_date: &amz_date,
    };
    let query = sigv4::presigned_query(
      &signer,
      &js_number(expires_in),
      method,
      &path,
      &[("x-id".to_string(), operation.to_string())],
      &headers,
    );
    self.location.url(&path, &query)
  }

  /// A PUT URL. The client must send `metadata` as `x-amz-meta-*` headers.
  pub fn put_url(
    &self,
    key: &str,
    expires_in: f64,
    metadata: &[(String, String)],
    now_ms: i64,
  ) -> String {
    self.presign("PUT", "PutObject", key, expires_in, metadata, now_ms)
  }

  pub fn get_url(&self, key: &str, expires_in: f64, now_ms: i64) -> String {
    self.presign("GET", "GetObject", key, expires_in, &[], now_ms)
  }
}

pub struct S3Store {
  location: Location,
  credentials: Credentials,
  region: String,
  http: reqwest::Client,
}

struct Reply {
  status: u16,
  headers: reqwest::header::HeaderMap,
  body: Vec<u8>,
}

fn latin1(bytes: &[u8]) -> String {
  bytes.iter().map(|&b| b as char).collect()
}

fn xml_escape(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for c in s.chars() {
    match c {
      '&' => out.push_str("&amp;"),
      '<' => out.push_str("&lt;"),
      '>' => out.push_str("&gt;"),
      '"' => out.push_str("&quot;"),
      '\'' => out.push_str("&apos;"),
      '\r' => out.push_str("&#xD;"),
      '\n' => out.push_str("&#xA;"),
      '\t' => out.push_str("&#x9;"),
      c => out.push(c),
    }
  }
  out
}

fn child_text<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
  node
    .children()
    .find(|child| child.is_element() && child.tag_name().name() == name)
    .map(|child| child.text().unwrap_or(""))
}

/// The `<Code>` and `<Message>` of an S3 error document.
fn error_document(body: &[u8]) -> Option<(String, String)> {
  let text = std::str::from_utf8(body).ok()?;
  let doc = roxmltree::Document::parse(text).ok()?;
  let root = doc.root_element();
  if root.tag_name().name() != "Error" {
    return None;
  }
  Some((
    child_text(root, "Code").unwrap_or("").to_string(),
    child_text(root, "Message").unwrap_or("").to_string(),
  ))
}

fn status_name(status: u16) -> String {
  match status {
    301 => "MovedPermanently".to_string(),
    400 => "BadRequest".to_string(),
    403 => "Forbidden".to_string(),
    404 => "NotFound".to_string(),
    409 => "Conflict".to_string(),
    other => other.to_string(),
  }
}

fn error_of(reply: &Reply) -> StoreError {
  if reply.status == 404 {
    return StoreError::NotFound;
  }
  let (code, message) =
    error_document(&reply.body).unwrap_or_else(|| (status_name(reply.status), String::new()));
  StoreError::Service {
    status: reply.status,
    code,
    message,
  }
}

fn retryable_status(status: u16, body: &[u8]) -> bool {
  if matches!(status, 429 | 500 | 502 | 503 | 504) {
    return true;
  }
  matches!(
    error_document(body).map(|(code, _)| code).as_deref(),
    Some(
      "SlowDown"
        | "Throttling"
        | "ThrottlingException"
        | "RequestTimeout"
        | "RequestTimeoutException"
        | "RequestThrottled"
        | "TooManyRequestsException"
    )
  )
}

/// Private-use stand-ins for the control characters S3 writes as character
/// references (`&#x1;`), which XML 1.0 does not allow.
const CONTROL_STAND_IN: u32 = 0xF0000;

fn control_reference(reference: &str) -> Option<u32> {
  let number = match reference
    .strip_prefix('x')
    .or_else(|| reference.strip_prefix('X'))
  {
    Some(hex) => u32::from_str_radix(hex, 16).ok()?,
    None => reference.parse().ok()?,
  };
  (number < 0x20 && !matches!(number, 0x9 | 0xA | 0xD)).then_some(number)
}

fn hide_control_references(text: &str) -> std::borrow::Cow<'_, str> {
  if !text.contains("&#") {
    return std::borrow::Cow::Borrowed(text);
  }
  let mut out = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(at) = rest.find("&#") {
    out.push_str(&rest[..at]);
    let after = &rest[at + 2..];
    match after
      .find(';')
      .and_then(|end| control_reference(&after[..end]).map(|n| (end, n)))
    {
      Some((end, number)) => {
        out.push(char::from_u32(CONTROL_STAND_IN + number).expect("a valid private-use char"));
        rest = &after[end + 1..];
      }
      None => {
        out.push_str("&#");
        rest = after;
      }
    }
  }
  out.push_str(rest);
  std::borrow::Cow::Owned(out)
}

fn restore_controls(text: &str) -> String {
  text
    .chars()
    .map(|c| match (c as u32).checked_sub(CONTROL_STAND_IN) {
      Some(n) if n < 0x20 => char::from_u32(n).unwrap_or(c),
      _ => c,
    })
    .collect()
}

fn parse_list(body: &[u8]) -> Result<ListOutput, StoreError> {
  let text = std::str::from_utf8(body)
    .map_err(|e| StoreError::Transport(format!("ListObjectsV2 reply is not UTF-8: {e}")))?;
  let text = hide_control_references(text);
  let doc = roxmltree::Document::parse(&text)
    .map_err(|e| StoreError::Transport(format!("ListObjectsV2 reply is not XML: {e}")))?;
  let root = doc.root_element();
  let mut out = ListOutput::default();
  for node in root.children().filter(|n| n.is_element()) {
    match node.tag_name().name() {
      "Contents" => {
        let key = restore_controls(child_text(node, "Key").unwrap_or(""));
        let last_modified_ms = match child_text(node, "LastModified") {
          Some(value) => Some(time::parse_rfc3339_ms(value).ok_or_else(|| {
            StoreError::Transport(format!("Invalid LastModified in listing: {value}"))
          })?),
          None => None,
        };
        let size = child_text(node, "Size").and_then(|s| s.trim().parse().ok());
        out.contents.push(ListObject {
          key,
          last_modified_ms,
          size,
        });
      }
      "CommonPrefixes" => {
        if let Some(prefix) = child_text(node, "Prefix") {
          out.common_prefixes.push(restore_controls(prefix));
        }
      }
      "IsTruncated" => out.is_truncated = node.text().unwrap_or("").trim() == "true",
      "NextContinuationToken" => {
        out.next_continuation_token = Some(node.text().unwrap_or("").to_string());
      }
      _ => {}
    }
  }
  Ok(out)
}

impl S3Store {
  pub fn new(location: Location, credentials: Credentials, region: String) -> Self {
    Self {
      location,
      credentials,
      region,
      http: crate::net::client(Duration::from_secs(120)),
    }
  }

  async fn attempt(
    &self,
    method: &Method,
    path: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    body: &[u8],
  ) -> Result<Reply, StoreError> {
    let amz_date = time::compact_stamp(time::now_ms());
    let payload_hash = sigv4::sha256_hex(body);
    let mut signed = vec![
      ("host".to_string(), self.location.request_host()),
      ("x-amz-content-sha256".to_string(), payload_hash.clone()),
      ("x-amz-date".to_string(), amz_date.clone()),
    ];
    signed.extend(headers.iter().cloned());
    let signer = sigv4::Signer {
      credentials: &self.credentials,
      region: &self.region,
      amz_date: &amz_date,
    };
    let authorization = sigv4::authorization(
      &signer,
      method.as_str(),
      path,
      query,
      &signed,
      &payload_hash,
    );
    let url = self.location.url(path, &sigv4::canonical_query(query));
    let mut request = self
      .http
      .request(method.clone(), url)
      .header("authorization", authorization);
    for (name, value) in signed.iter().filter(|(name, _)| name != "host") {
      request = request.header(name.as_str(), value.as_str());
    }
    if !body.is_empty() || *method == Method::PUT || *method == Method::POST {
      request = request.body(body.to_vec());
    }
    let response = request
      .send()
      .await
      .map_err(|e| StoreError::Transport(transport_message(&e)))?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = if *method == Method::HEAD {
      Vec::new()
    } else {
      response
        .bytes()
        .await
        .map_err(|e| StoreError::Transport(transport_message(&e)))?
        .to_vec()
    };
    Ok(Reply {
      status,
      headers,
      body,
    })
  }

  /// One S3 call, retried on throttling, server errors and dropped
  /// connections, with jittered exponential backoff.
  async fn send(
    &self,
    method: Method,
    path: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    body: &[u8],
  ) -> Result<Reply, StoreError> {
    let mut attempt = 0;
    loop {
      attempt += 1;
      let outcome = self.attempt(&method, path, query, headers, body).await;
      let retry = match &outcome {
        Err(StoreError::Transport(_)) => true,
        Ok(reply) => retryable_status(reply.status, &reply.body),
        Err(_) => false,
      };
      if !retry || attempt >= MAX_ATTEMPTS {
        return outcome;
      }
      let ceiling = RETRY_BASE
        .saturating_mul(1 << attempt)
        .min(RETRY_CAP)
        .as_millis() as u64;
      let delay = rand::random_range(0..=ceiling);
      tokio::time::sleep(Duration::from_millis(delay)).await;
    }
  }

  async fn expect_success(
    &self,
    method: Method,
    path: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    body: &[u8],
  ) -> Result<Reply, StoreError> {
    let reply = self.send(method, path, query, headers, body).await?;
    if (200..300).contains(&reply.status) {
      Ok(reply)
    } else {
      Err(error_of(&reply))
    }
  }
}

fn transport_message(error: &reqwest::Error) -> String {
  let mut message = error.to_string();
  let mut source = std::error::Error::source(error);
  while let Some(cause) = source {
    message.push_str(": ");
    message.push_str(&cause.to_string());
    source = cause.source();
  }
  message
}

#[async_trait]
impl Store for S3Store {
  async fn head_bucket(&self) -> Result<(), StoreError> {
    let path = self.location.bucket_path();
    self
      .expect_success(Method::HEAD, &path, &[], &[], &[])
      .await
      .map(|_| ())
  }

  async fn create_bucket(&self) -> Result<(), StoreError> {
    let path = self.location.bucket_path();
    self
      .expect_success(Method::PUT, &path, &[], &[], &[])
      .await
      .map(|_| ())
  }

  async fn head_object(&self, key: &str) -> Result<HeadOutput, StoreError> {
    let path = self.location.object_path(key);
    let reply = self
      .expect_success(Method::HEAD, &path, &[], &[], &[])
      .await?;
    let header = |name: &str| reply.headers.get(name).map(|v| latin1(v.as_bytes()));
    let mut metadata: Vec<(String, String)> = reply
      .headers
      .iter()
      .filter_map(|(name, value)| {
        name
          .as_str()
          .strip_prefix("x-amz-meta-")
          .map(|n| (n.to_string(), latin1(value.as_bytes())))
      })
      .collect();
    metadata.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(HeadOutput {
      last_modified_ms: header("last-modified").and_then(|v| time::parse_http_date_ms(&v)),
      content_length: header("content-length").and_then(|v| v.trim().parse().ok()),
      metadata,
      etag: header("etag"),
    })
  }

  async fn get_object_text(&self, key: &str) -> Result<String, StoreError> {
    let path = self.location.object_path(key);
    let reply = self
      .expect_success(Method::GET, &path, &[], &[], &[])
      .await?;
    Ok(String::from_utf8_lossy(&reply.body).into_owned())
  }

  async fn put_object(
    &self,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
  ) -> Result<(), StoreError> {
    let path = self.location.object_path(key);
    let headers = [("content-type".to_string(), content_type.to_string())];
    self
      .expect_success(Method::PUT, &path, &[], &headers, &body)
      .await
      .map(|_| ())
  }

  async fn delete_object(&self, key: &str) -> Result<(), StoreError> {
    let path = self.location.object_path(key);
    self
      .expect_success(Method::DELETE, &path, &[], &[], &[])
      .await
      .map(|_| ())
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    let mut xml = String::from(
      r#"<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
    );
    for key in keys {
      xml.push_str("<Object><Key>");
      xml.push_str(&xml_escape(key));
      xml.push_str("</Key></Object>");
    }
    xml.push_str("<Quiet>true</Quiet></Delete>");
    let body = xml.into_bytes();
    let md5 = base64::engine::general_purpose::STANDARD.encode(Md5::digest(&body));
    let headers = [
      ("content-md5".to_string(), md5),
      ("content-type".to_string(), "application/xml".to_string()),
    ];
    let path = self.location.bucket_path();
    self
      .expect_success(
        Method::POST,
        &path,
        &[("delete".to_string(), String::new())],
        &headers,
        &body,
      )
      .await
      .map(|_| ())
  }

  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError> {
    let source = format!(
      "{}/{}",
      self.location.bucket,
      from
        .split('/')
        .map(sigv4::encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
    );
    let path = self.location.object_path(to);
    let headers = [("x-amz-copy-source".to_string(), source)];
    let reply = self
      .expect_success(Method::PUT, &path, &[], &headers, &[])
      .await?;
    // S3 can answer a copy with 200 and an error document.
    if let Some((code, message)) = error_document(&reply.body) {
      return Err(StoreError::Service {
        status: reply.status,
        code,
        message,
      });
    }
    Ok(())
  }

  async fn list_objects_v2(&self, input: &ListInput) -> Result<ListOutput, StoreError> {
    let mut query = vec![("list-type".to_string(), "2".to_string())];
    if let Some(token) = &input.continuation_token {
      query.push(("continuation-token".to_string(), token.clone()));
    }
    if let Some(delimiter) = &input.delimiter {
      query.push(("delimiter".to_string(), delimiter.clone()));
    }
    if let Some(max_keys) = &input.max_keys {
      query.push(("max-keys".to_string(), max_keys.clone()));
    }
    if let Some(prefix) = &input.prefix {
      query.push(("prefix".to_string(), prefix.clone()));
    }
    let path = self.location.bucket_path();
    let reply = self
      .expect_success(Method::GET, &path, &query, &[], &[])
      .await?;
    parse_list(&reply.body)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn path_style_and_virtual_hosts() {
    let path = Location::parse("http://127.0.0.1:8987", "probe-node", true).unwrap();
    assert_eq!(
      path.url(&path.object_path("probe/a b"), ""),
      "http://127.0.0.1:8987/probe-node/probe/a%20b"
    );
    let aws = Location::parse("https://s3.us-east-1.amazonaws.com", "my-bucket", false).unwrap();
    assert_eq!(
      aws.url(&aws.object_path("k"), ""),
      "https://my-bucket.s3.us-east-1.amazonaws.com/k"
    );
    assert_eq!(
      aws.url(&aws.bucket_path(), ""),
      "https://my-bucket.s3.us-east-1.amazonaws.com/"
    );
    let dotted = Location::parse("https://s3.amazonaws.com", "a.b.c", false).unwrap();
    assert_eq!(
      dotted.url(&dotted.object_path("k"), ""),
      "https://s3.amazonaws.com/a.b.c/k"
    );
    let based = Location::parse("https://example.com/s3/", "b", true).unwrap();
    assert_eq!(
      based.url(&based.object_path("k"), ""),
      "https://example.com/s3/b/k"
    );
    let default_port = Location::parse("https://example.com:443", "bucket", true).unwrap();
    assert_eq!(default_port.request_host(), "example.com");
  }

  /// URLs the AWS SDK for JavaScript signed at a fixed time, with its
  /// checksum parameters off (the server never sent them on purpose).
  #[test]
  fn presigned_urls_match_the_aws_sdk_byte_for_byte() {
    let vectors: Vec<serde_json::Value> =
      serde_json::from_str(include_str!("../tests/fixtures/presign-vectors.json")).unwrap();
    assert!(vectors.len() >= 24);
    let now = time::parse_rfc3339_ms("2026-10-25T09:02:11.000Z").unwrap();
    for vector in vectors {
      let s = |name: &str| vector[name].as_str().unwrap().to_string();
      let presigner = Presigner::new(
        Location::parse(
          &s("endpoint"),
          &s("bucket"),
          vector["forcePathStyle"].as_bool().unwrap(),
        )
        .unwrap(),
        Credentials {
          access_key_id: "AKIDEXAMPLE".to_string(),
          secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
        },
        s("region"),
      );
      let expires = vector["expiresIn"].as_f64().unwrap();
      let metadata: Vec<(String, String)> = vector["metadata"]
        .as_object()
        .map(|m| {
          m.iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect()
        })
        .unwrap_or_default();
      let url = match vector["method"].as_str().unwrap() {
        "PUT" => presigner.put_url(&s("key"), expires, &metadata, now),
        _ => presigner.get_url(&s("key"), expires, now),
      };
      assert_eq!(url, s("url"), "{vector}");
    }
  }

  #[test]
  fn listing_parses_keys_entities_and_paging() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>b</Name><Prefix>p/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <Contents><Key>p/a&amp;b</Key><LastModified>2026-10-25T09:02:11.155Z</LastModified><ETag>"x"</ETag><Size>7</Size></Contents>
  <Contents><Key>p/&#x1;c</Key><LastModified>2026-10-25T09:02:11Z</LastModified><Size>0</Size></Contents>
  <CommonPrefixes><Prefix>p/d/</Prefix></CommonPrefixes>
  <NextContinuationToken>tok==</NextContinuationToken>
</ListBucketResult>"#;
    let list = parse_list(xml.as_bytes()).unwrap();
    assert_eq!(list.contents.len(), 2);
    assert_eq!(list.contents[0].key, "p/a&b");
    assert_eq!(list.contents[0].size, Some(7));
    assert_eq!(list.contents[0].last_modified_ms, Some(1_792_918_931_155));
    assert_eq!(list.contents[1].key, "p/\u{1}c");
    assert_eq!(list.common_prefixes, vec!["p/d/".to_string()]);
    assert!(list.is_truncated);
    assert_eq!(list.next_continuation_token.as_deref(), Some("tok=="));
  }

  #[test]
  fn error_documents_name_their_code() {
    let reply = Reply {
      status: 403,
      headers: Default::default(),
      body: b"<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>no</Message></Error>"
        .to_vec(),
    };
    assert_eq!(error_of(&reply).code(), Some("AccessDenied"));
    let missing = Reply {
      status: 404,
      headers: Default::default(),
      body: Vec::new(),
    };
    assert!(matches!(error_of(&missing), StoreError::NotFound));
  }
}
