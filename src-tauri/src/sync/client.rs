use super::types::*;
use reqwest::Client;
use std::time::Duration;

/// How long to wait for a storage host to accept a connection.
///
/// This client had no timeouts at all. A host that neither accepts nor refuses,
/// which is what a dropping firewall or a black-holed address looks like, held
/// every attempt for the operating system's own connect backoff: measured at
/// 21 s on Windows and 134 s on Linux. With `MAX_FILE_RETRIES` and its backoff
/// that is minutes for one file, and a profile of two hundred files reports
/// nothing for most of an hour.
///
/// Matches the pre-flight probe, so a host that fails the check fails a
/// transfer the same way and in the same time.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// How long a transfer may make no progress at all.
///
/// Deliberately an inactivity timeout and not a deadline on the whole request.
/// Profile files run to tens of megabytes and a slow link is not a broken one,
/// so a total timeout would start failing syncs that were working. This fires
/// only when nothing arrives for a full minute.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Transfers through a sync server's own URLs (a server that encrypts at
/// rest) at a time, across every profile this app syncs: such a server
/// serves a limited number per account, and more only wait there.
const SERVER_TRANSFERS: usize = 6;
static SERVER_TRANSFER_SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
  std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(SERVER_TRANSFERS)));
/// The path of a sync server's own transfer URLs.
const SERVER_TRANSFER_PATH: &str = "/v1/transfer?";

/// How long a busy answer (503, 429) is tried again before the transfer
/// fails, and the longest single wait.
const BUSY_BUDGET: Duration = Duration::from_secs(300);
const BUSY_WAIT_MAX: Duration = Duration::from_secs(30);

/// What a busy answer asks to wait, in seconds.
fn retry_after(response: &reqwest::Response) -> Option<Duration> {
  response
    .headers()
    .get(reqwest::header::RETRY_AFTER)?
    .to_str()
    .ok()?
    .trim()
    .parse()
    .ok()
    .map(Duration::from_secs)
}

/// Tries per part of an upload in parts. The file's own retries come on top.
const PART_ATTEMPTS: u32 = 3;
const PART_RETRY_DELAY: Duration = Duration::from_secs(1);
/// The size of a file uploaded in parts, which the server checks every part against.
const UPLOAD_LENGTH_HEADER: &str = "x-donut-upload-length";

/// The server's answer to the start of an upload in parts.
#[derive(serde::Deserialize)]
struct PartsStarted {
  upload: String,
  #[serde(rename = "partSize")]
  part_size: u64,
  parts: u64,
}

/// `url` with `pairs` added to its query.
fn with_query(url: &str, pairs: &[(&str, &str)]) -> SyncResult<String> {
  let mut url = reqwest::Url::parse(url)
    .map_err(|e| SyncError::NetworkError(format!("Invalid transfer URL: {e}")))?;
  url.query_pairs_mut().extend_pairs(pairs);
  Ok(url.into())
}

#[derive(Clone)]
pub struct SyncClient {
  client: Client,
  base_url: String,
  token: String,
}

impl SyncClient {
  pub fn new(base_url: String, token: String) -> Self {
    Self {
      client: crate::app_proxy::client_builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        // A builder failure here means the TLS backend did not start. The
        // default client cannot transfer either, so fall back and let the first
        // real request report it, rather than making this constructor fallible
        // for a condition no caller can act on.
        .unwrap_or_default(),
      base_url: base_url.trim_end_matches('/').to_string(),
      token,
    }
  }

  fn url(&self, path: &str) -> String {
    format!("{}/v1/objects/{}", self.base_url, path)
  }

  pub async fn stat(&self, key: &str) -> SyncResult<StatResponse> {
    let response = self
      .client
      .post(self.url("stat"))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(&StatRequest {
        key: key.to_string(),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn presign_upload(
    &self,
    key: &str,
    content_type: Option<&str>,
  ) -> SyncResult<PresignUploadResponse> {
    self
      .presign_upload_with_metadata(key, content_type, None)
      .await
  }

  /// Presign an upload, asking the server to sign `metadata` into the object as
  /// `x-amz-meta-*`. The response echoes the metadata the server actually signed
  /// (empty/None on older servers); the caller must send exactly that back on
  /// the PUT via `upload_bytes_with_metadata`.
  pub async fn presign_upload_with_metadata(
    &self,
    key: &str,
    content_type: Option<&str>,
    metadata: Option<std::collections::HashMap<String, String>>,
  ) -> SyncResult<PresignUploadResponse> {
    let response = self
      .client
      .post(self.url("presign-upload"))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(&PresignUploadRequest {
        key: key.to_string(),
        content_type: content_type.map(|s| s.to_string()),
        expires_in: Some(3600),
        metadata,
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn presign_download(&self, key: &str) -> SyncResult<PresignDownloadResponse> {
    let response = self
      .client
      .post(self.url("presign-download"))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(&PresignDownloadRequest {
        key: key.to_string(),
        expires_in: Some(3600),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn delete(&self, key: &str, tombstone_key: Option<&str>) -> SyncResult<DeleteResponse> {
    let response = self
      .client
      .post(self.url("delete"))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(&DeleteRequest {
        key: key.to_string(),
        tombstone_key: tombstone_key.map(|s| s.to_string()),
        deleted_at: Some(chrono::Utc::now().to_rfc3339()),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn list(&self, prefix: &str) -> SyncResult<ListResponse> {
    self.list_page(prefix, None).await
  }

  async fn list_page(
    &self,
    prefix: &str,
    continuation_token: Option<String>,
  ) -> SyncResult<ListResponse> {
    let response = self
      .client
      .post(self.url("list"))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(&ListRequest {
        prefix: prefix.to_string(),
        max_keys: Some(1000),
        continuation_token,
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  /// List all objects under a prefix, paginating through all results
  pub async fn list_all(&self, prefix: &str) -> SyncResult<Vec<ListObject>> {
    let mut all_objects = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
      let response = self.list_page(prefix, continuation_token).await?;
      all_objects.extend(response.objects);

      if !response.is_truncated {
        break;
      }
      continuation_token = response.next_continuation_token;
      if continuation_token.is_none() {
        break;
      }
    }

    Ok(all_objects)
  }

  /// Uploads to a presign answer: through `transfer` when the server offers
  /// it, else to `presigned_url`.
  pub async fn upload_bytes(
    &self,
    presigned_url: &str,
    transfer: Option<&SealedTransfer>,
    data: &[u8],
    content_type: Option<&str>,
  ) -> SyncResult<()> {
    self
      .upload_bytes_with_metadata(presigned_url, transfer, data, content_type, None)
      .await
  }

  /// `upload_bytes`, sending `metadata` as `x-amz-meta-*` headers. These MUST
  /// be exactly the metadata the presign signed (from
  /// `PresignUploadResponse::metadata`) or the upload is refused.
  pub async fn upload_bytes_with_metadata(
    &self,
    presigned_url: &str,
    transfer: Option<&SealedTransfer>,
    data: &[u8],
    content_type: Option<&str>,
    metadata: Option<&std::collections::HashMap<String, String>>,
  ) -> SyncResult<()> {
    let _slot = match transfer {
      Some(_) => Some(
        SERVER_TRANSFER_SLOTS
          .clone()
          .acquire_owned()
          .await
          .expect("the semaphore is never closed"),
      ),
      None => None,
    };
    match transfer {
      Some(transfer) if data.len() as u64 > transfer.part_size => {
        self
          .upload_in_parts(transfer, data, content_type, metadata)
          .await
      }
      Some(transfer) => {
        self
          .put_once(&transfer.url, data, content_type, metadata)
          .await
      }
      None => {
        self
          .put_once(presigned_url, data, content_type, metadata)
          .await
      }
    }
  }

  fn with_upload_headers(
    mut req: reqwest::RequestBuilder,
    content_type: Option<&str>,
    metadata: Option<&std::collections::HashMap<String, String>>,
  ) -> reqwest::RequestBuilder {
    if let Some(ct) = content_type {
      req = req.header("Content-Type", ct);
    }
    for (k, v) in metadata.into_iter().flatten() {
      req = req.header(format!("x-amz-meta-{k}"), v);
    }
    req
  }

  /// Sends `build()`. For a sync server's own transfer URL, again while the
  /// answer is busy (503, 429), waiting what Retry-After asks or a growing
  /// backoff, for at most `BUSY_BUDGET`: that server limits transfers per
  /// account. Storage's own answers go back at once, to the file's retries.
  async fn send_patiently(
    &self,
    url: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
  ) -> SyncResult<reqwest::Response> {
    let patient = url.contains(SERVER_TRANSFER_PATH);
    let started = std::time::Instant::now();
    let mut backoff = Duration::from_secs(1);
    loop {
      // The storage host here may come from a presigned URL, so on a
      // self-hosted server it is whatever the server signed against,
      // frequently an address only the server can resolve. `reqwest`'s own
      // Display collapses that to "error sending request"; report the
      // innermost cause and the host it names.
      let response = build()
        .send()
        .await
        .map_err(|e| SyncError::NetworkError(super::preflight::transport_reason_for(url, &e)))?;
      let busy = matches!(response.status().as_u16(), 429 | 503);
      let wait = retry_after(&response).unwrap_or(backoff).min(BUSY_WAIT_MAX);
      if !patient || !busy || started.elapsed() + wait > BUSY_BUDGET {
        return Ok(response);
      }
      log::debug!("Transfer busy, waiting wait_ms={}", wait.as_millis());
      tokio::time::sleep(wait).await;
      backoff = (backoff * 2).min(BUSY_WAIT_MAX);
    }
  }

  /// Sends a request of an upload in parts; any answer but a success is an
  /// error carrying the server's own words.
  async fn send_part_request(
    &self,
    url: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
  ) -> SyncResult<reqwest::Response> {
    let response = self.send_patiently(url, build).await?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Upload failed with status {status}: {body}"
      )));
    }
    Ok(response)
  }

  /// The server's protocol for files larger than one request may carry:
  /// start with the size, send each part (retried on its own), then join
  /// them. A failure aborts the upload, so storage keeps nothing half done.
  async fn upload_in_parts(
    &self,
    transfer: &SealedTransfer,
    data: &[u8],
    content_type: Option<&str>,
    metadata: Option<&std::collections::HashMap<String, String>>,
  ) -> SyncResult<()> {
    let start = || {
      Self::with_upload_headers(
        self
          .client
          .post(&transfer.url)
          .header(UPLOAD_LENGTH_HEADER, data.len().to_string())
          .header("Content-Length", "0"),
        content_type,
        metadata,
      )
    };
    let started: PartsStarted = self
      .send_part_request(&transfer.url, start)
      .await?
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))?;
    let outcome = self.send_parts(transfer, &started, data).await;
    if outcome.is_err() {
      let abort = with_query(&transfer.url, &[("upload", &started.upload)])?;
      if let Err(e) = self.client.delete(&abort).send().await {
        log::debug!("Upload abort failed err=\"{e}\"");
      }
    }
    outcome
  }

  async fn send_parts(
    &self,
    transfer: &SealedTransfer,
    started: &PartsStarted,
    data: &[u8],
  ) -> SyncResult<()> {
    let part_size = usize::try_from(started.part_size)
      .ok()
      .filter(|size| *size > 0)
      .ok_or_else(|| SyncError::InvalidData("The server gave no part size".to_string()))?;
    let chunks: Vec<&[u8]> = data.chunks(part_size).collect();
    if chunks.len() as u64 != started.parts {
      return Err(SyncError::InvalidData(format!(
        "The server expects {} parts, the file has {}",
        started.parts,
        chunks.len()
      )));
    }
    let mut etags = Vec::with_capacity(chunks.len());
    for (index, chunk) in chunks.iter().enumerate() {
      let number = (index + 1).to_string();
      let url = with_query(
        &transfer.url,
        &[("upload", &started.upload), ("part", &number)],
      )?;
      let mut attempt = 0;
      let etag = loop {
        attempt += 1;
        let req = || {
          self
            .client
            .put(&url)
            .header("Content-Length", chunk.len().to_string())
            .body(chunk.to_vec())
        };
        match self.send_part_request(&url, req).await {
          Ok(response) => {
            break response
              .headers()
              .get("etag")
              .and_then(|v| v.to_str().ok())
              .map(str::to_string)
              .ok_or_else(|| {
                SyncError::InvalidData(format!("Part {number} came back without an ETag"))
              })?;
          }
          Err(e) if attempt >= PART_ATTEMPTS => return Err(e),
          Err(e) => {
            log::debug!("Part retry part={number} attempt={attempt} err=\"{e}\"");
            tokio::time::sleep(PART_RETRY_DELAY * attempt).await;
          }
        }
      };
      etags.push(etag);
    }
    let complete = with_query(
      &transfer.url,
      &[("upload", &started.upload), ("op", "complete")],
    )?;
    let req = || {
      self
        .client
        .post(&complete)
        .json(&serde_json::json!({ "parts": etags }))
    };
    self.send_part_request(&complete, req).await.map(|_| ())
  }

  /// One PUT, as S3 takes it.
  async fn put_once(
    &self,
    presigned_url: &str,
    data: &[u8],
    content_type: Option<&str>,
    metadata: Option<&std::collections::HashMap<String, String>>,
  ) -> SyncResult<()> {
    let req = || {
      Self::with_upload_headers(
        self
          .client
          .put(presigned_url)
          .header("Content-Length", data.len().to_string())
          .body(data.to_vec()),
        content_type,
        metadata,
      )
    };
    let response = self.send_patiently(presigned_url, req).await?;

    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::NetworkError(format!(
        "Upload failed with status {status}: {body}"
      )));
    }

    Ok(())
  }

  pub async fn download_bytes(&self, presigned_url: &str) -> SyncResult<Vec<u8>> {
    let _slot = match presigned_url.contains(SERVER_TRANSFER_PATH) {
      true => Some(
        SERVER_TRANSFER_SLOTS
          .clone()
          .acquire_owned()
          .await
          .expect("the semaphore is never closed"),
      ),
      false => None,
    };
    let response = self
      .send_patiently(presigned_url, || self.client.get(presigned_url))
      .await?;

    if !response.status().is_success() {
      return Err(SyncError::NetworkError(format!(
        "Download failed with status: {}",
        response.status()
      )));
    }

    response
      .bytes()
      .await
      .map(|b| b.to_vec())
      .map_err(|e| SyncError::NetworkError(e.to_string()))
  }

  pub async fn presign_upload_batch(
    &self,
    items: Vec<(String, Option<String>)>,
  ) -> SyncResult<PresignUploadBatchResponse> {
    let chunk_size = 500;
    let mut all_items = Vec::new();

    for chunk in items.chunks(chunk_size) {
      let request = PresignUploadBatchRequest {
        items: chunk
          .iter()
          .map(|(key, content_type)| PresignUploadBatchItem {
            key: key.clone(),
            content_type: content_type.clone(),
          })
          .collect(),
        expires_in: Some(3600),
      };

      let response = self
        .client
        .post(self.url("presign-upload-batch"))
        .header("Authorization", format!("Bearer {}", self.token))
        .json(&request)
        .send()
        .await
        .map_err(|e| SyncError::NetworkError(e.to_string()))?;

      if response.status().is_client_error() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(SyncError::AuthError(format!("({status}) {body}")));
      }

      let batch_response: PresignUploadBatchResponse = response
        .json()
        .await
        .map_err(|e| SyncError::SerializationError(e.to_string()))?;

      all_items.extend(batch_response.items);
    }

    Ok(PresignUploadBatchResponse { items: all_items })
  }

  pub async fn presign_download_batch(
    &self,
    keys: Vec<String>,
  ) -> SyncResult<PresignDownloadBatchResponse> {
    let chunk_size = 500;
    let mut all_items = Vec::new();

    for chunk in keys.chunks(chunk_size) {
      let request = PresignDownloadBatchRequest {
        keys: chunk.to_vec(),
        expires_in: Some(3600),
      };

      let response = self
        .client
        .post(self.url("presign-download-batch"))
        .header("Authorization", format!("Bearer {}", self.token))
        .json(&request)
        .send()
        .await
        .map_err(|e| SyncError::NetworkError(e.to_string()))?;

      if response.status().is_client_error() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(SyncError::AuthError(format!("({status}) {body}")));
      }

      let batch_response: PresignDownloadBatchResponse = response
        .json()
        .await
        .map_err(|e| SyncError::SerializationError(e.to_string()))?;

      all_items.extend(batch_response.items);
    }

    Ok(PresignDownloadBatchResponse { items: all_items })
  }

  pub async fn delete_prefix(
    &self,
    prefix: &str,
    tombstone_key: Option<&str>,
  ) -> SyncResult<DeletePrefixResponse> {
    let response = self
      .client
      .post(self.url("delete-prefix"))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(&DeletePrefixRequest {
        prefix: prefix.to_string(),
        tombstone_key: tombstone_key.map(|s| s.to_string()),
        deleted_at: Some(chrono::Utc::now().to_rfc3339()),
      })
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;

    if response.status().is_client_error() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }

    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  async fn post_json<B: serde::Serialize, T: serde::de::DeserializeOwned>(
    &self,
    path: &str,
    body: &B,
  ) -> SyncResult<T> {
    let response = self
      .client
      .post(self.url(path))
      .header("Authorization", format!("Bearer {}", self.token))
      .json(body)
      .send()
      .await
      .map_err(|e| SyncError::NetworkError(e.to_string()))?;
    let status = response.status();
    if status.is_client_error() || status.is_server_error() {
      let body = response.text().await.unwrap_or_default();
      return Err(SyncError::AuthError(format!("({status}) {body}")));
    }
    response
      .json()
      .await
      .map_err(|e| SyncError::SerializationError(e.to_string()))
  }

  pub async fn snapshots_list(
    &self,
    profile_root: &str,
  ) -> SyncResult<Vec<super::restore_points::RestorePoint>> {
    #[derive(serde::Deserialize)]
    struct Listed {
      snapshots: Vec<super::restore_points::RestorePoint>,
    }
    let listed: Listed = self
      .post_json(
        "snapshots/list",
        &serde_json::json!({ "profileRoot": profile_root }),
      )
      .await?;
    Ok(listed.snapshots)
  }

  pub async fn snapshots_create(
    &self,
    profile_root: &str,
    kind: &str,
  ) -> SyncResult<super::restore_points::RestorePoint> {
    self
      .post_json(
        "snapshots/create",
        &serde_json::json!({ "profileRoot": profile_root, "kind": kind }),
      )
      .await
  }

  pub async fn snapshots_delete(&self, profile_root: &str, id: &str) -> SyncResult<()> {
    let _: serde_json::Value = self
      .post_json(
        "snapshots/delete",
        &serde_json::json!({ "profileRoot": profile_root, "id": id }),
      )
      .await?;
    Ok(())
  }

  pub async fn snapshots_restore_files(&self, profile_root: &str, id: &str) -> SyncResult<()> {
    let _: serde_json::Value = self
      .post_json(
        "snapshots/restore-files",
        &serde_json::json!({ "profileRoot": profile_root, "id": id }),
      )
      .await?;
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  use wiremock::matchers::{body_bytes, body_json, header, method, path, query_param};
  use wiremock::{Mock, MockServer, ResponseTemplate};

  fn client() -> SyncClient {
    SyncClient::new("http://127.0.0.1:1".to_string(), "unused".to_string())
  }

  fn transfer(server: &MockServer, part_size: u64) -> SealedTransfer {
    SealedTransfer {
      url: format!("{}/v1/transfer?key=k&expires=1&sig=s", server.uri()),
      part_size,
    }
  }

  fn meta() -> HashMap<String, String> {
    HashMap::from([("updated-at".to_string(), "7".to_string())])
  }

  #[tokio::test]
  async fn without_a_transfer_the_presigned_url_takes_the_file() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
      .and(path("/bucket/k"))
      .and(body_bytes(b"data".to_vec()))
      .respond_with(ResponseTemplate::new(200))
      .expect(1)
      .mount(&server)
      .await;
    client()
      .upload_bytes(&format!("{}/bucket/k", server.uri()), None, b"data", None)
      .await
      .unwrap();
  }

  #[tokio::test]
  async fn a_file_within_one_part_goes_through_the_server_in_one_request() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
      .and(path("/v1/transfer"))
      .and(header("x-amz-meta-updated-at", "7"))
      .and(header("content-type", "application/json"))
      .and(body_bytes(b"data".to_vec()))
      .respond_with(ResponseTemplate::new(200))
      .expect(1)
      .mount(&server)
      .await;
    client()
      .upload_bytes_with_metadata(
        "http://storage.invalid/never",
        Some(&transfer(&server, 4)),
        b"data",
        Some("application/json"),
        Some(&meta()),
      )
      .await
      .unwrap();
  }

  #[tokio::test]
  async fn a_larger_file_goes_up_in_parts_and_a_failed_part_is_sent_again() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
      .and(path("/v1/transfer"))
      .and(header("x-donut-upload-length", "10"))
      .and(header("x-amz-meta-updated-at", "7"))
      .respond_with(
        ResponseTemplate::new(200)
          .set_body_json(serde_json::json!({ "upload": "T.1", "partSize": 4, "parts": 3 })),
      )
      .expect(1)
      .mount(&server)
      .await;
    for (part, body) in [("1", &b"0123"[..]), ("2", b"4567"), ("3", b"89")] {
      if part == "2" {
        Mock::given(method("PUT"))
          .and(query_param("part", part))
          .respond_with(ResponseTemplate::new(503))
          .up_to_n_times(1)
          .with_priority(1)
          .mount(&server)
          .await;
      }
      Mock::given(method("PUT"))
        .and(query_param("upload", "T.1"))
        .and(query_param("part", part))
        .and(query_param("key", "k"))
        .and(body_bytes(body.to_vec()))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", format!("\"e{part}\"")))
        .expect(1)
        .mount(&server)
        .await;
    }
    Mock::given(method("POST"))
      .and(query_param("op", "complete"))
      .and(query_param("upload", "T.1"))
      .and(body_json(
        serde_json::json!({ "parts": ["\"e1\"", "\"e2\"", "\"e3\""] }),
      ))
      .respond_with(ResponseTemplate::new(200))
      .expect(1)
      .mount(&server)
      .await;
    client()
      .upload_bytes_with_metadata(
        "http://storage.invalid/never",
        Some(&transfer(&server, 4)),
        b"0123456789",
        None,
        Some(&meta()),
      )
      .await
      .unwrap();
  }

  #[tokio::test]
  async fn a_part_that_keeps_failing_aborts_the_upload() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
      .and(path("/v1/transfer"))
      .respond_with(
        ResponseTemplate::new(200)
          .set_body_json(serde_json::json!({ "upload": "T.2", "partSize": 4, "parts": 2 })),
      )
      .mount(&server)
      .await;
    Mock::given(method("PUT"))
      .respond_with(ResponseTemplate::new(500).set_body_string("no"))
      .expect(u64::from(PART_ATTEMPTS))
      .mount(&server)
      .await;
    Mock::given(method("DELETE"))
      .and(query_param("upload", "T.2"))
      .respond_with(ResponseTemplate::new(204))
      .expect(1)
      .mount(&server)
      .await;
    let error = client()
      .upload_bytes(
        "http://storage.invalid/never",
        Some(&transfer(&server, 4)),
        b"01234567",
        None,
      )
      .await
      .unwrap_err();
    assert!(error.to_string().contains("500"), "{error}");
  }

  #[tokio::test]
  async fn a_part_count_that_disagrees_with_the_file_is_refused_before_sending() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
      .respond_with(
        ResponseTemplate::new(200)
          .set_body_json(serde_json::json!({ "upload": "T.3", "partSize": 4, "parts": 5 })),
      )
      .mount(&server)
      .await;
    Mock::given(method("DELETE"))
      .respond_with(ResponseTemplate::new(204))
      .expect(1)
      .mount(&server)
      .await;
    assert!(client()
      .upload_bytes(
        "http://x.invalid",
        Some(&transfer(&server, 4)),
        b"0123456",
        None
      )
      .await
      .is_err());
  }

  #[tokio::test]
  async fn a_busy_server_is_waited_for_as_it_asks() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
      .respond_with(ResponseTemplate::new(503).insert_header("retry-after", "1"))
      .up_to_n_times(2)
      .with_priority(1)
      .mount(&server)
      .await;
    Mock::given(method("GET"))
      .respond_with(ResponseTemplate::new(200).set_body_bytes(b"done".to_vec()))
      .expect(1)
      .mount(&server)
      .await;
    let started = std::time::Instant::now();
    let url = format!("{}/v1/transfer?key=k&expires=1&sig=s", server.uri());
    assert_eq!(client().download_bytes(&url).await.unwrap(), b"done");
    assert!(
      started.elapsed() >= Duration::from_secs(2),
      "waited Retry-After twice"
    );
  }

  #[tokio::test]
  async fn a_busy_storage_url_fails_at_once_for_the_file_retries() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
      .respond_with(ResponseTemplate::new(503).insert_header("retry-after", "30"))
      .expect(1)
      .mount(&server)
      .await;
    let url = format!("{}/bucket/k?X-Amz-Signature=s", server.uri());
    assert!(client().download_bytes(&url).await.is_err());
  }

  #[test]
  fn answers_from_servers_that_do_not_seal_have_no_transfer() {
    let old: PresignUploadResponse =
      serde_json::from_str(r#"{"url":"u","expiresAt":"t"}"#).unwrap();
    assert_eq!(old.transfer, None);
    let new: PresignUploadBatchItemResponse = serde_json::from_str(
      r#"{"key":"k","url":"u","expiresAt":"t","transfer":{"url":"v","partSize":8388608}}"#,
    )
    .unwrap();
    assert_eq!(
      new.transfer,
      Some(SealedTransfer {
        url: "v".to_string(),
        part_size: 8_388_608
      })
    );
  }
}
