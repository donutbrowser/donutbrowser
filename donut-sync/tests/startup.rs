//! Startup checks, the boot message about the presign endpoint, and which
//! host presigned URLs name.

mod common;

use common::{S3_ENDPOINT, SYNC_TOKEN, Server, bucket, http, post, run_to_exit};
use serde_json::json;

const PUBLIC_ENDPOINT: &str = "https://storage.example.com";

#[test]
fn refused_configurations_exit_with_a_reason() {
  let (code, out) = run_to_exit(&[("S3_ENDPOINT", S3_ENDPOINT)]);
  assert_eq!(code, 1);
  assert!(
    out.contains("Set SYNC_TOKEN, SYNC_PUBLIC_URL (Donut account sign-in), or both"),
    "{out}"
  );

  for token in ["short", "CHANGE_ME_generate_a_long_random_secret"] {
    let (code, out) = run_to_exit(&[("SYNC_TOKEN", token)]);
    assert_eq!(code, 1);
    assert!(
      out.contains("SYNC_TOKEN is a known default or too short"),
      "{out}"
    );
  }

  let (code, out) = run_to_exit(&[("SYNC_PUBLIC_URL", "ftp://nope")]);
  assert_eq!(code, 1);
  assert!(
    out.contains("SYNC_PUBLIC_URL must be the http(s) address"),
    "{out}"
  );

  let (code, out) = run_to_exit(&[("SYNC_TOKEN", SYNC_TOKEN)]);
  assert_eq!(code, 1);
  assert!(
    out.contains("Required environment variable S3_ENDPOINT is not set"),
    "{out}"
  );

  let (code, out) = run_to_exit(&[
    ("SYNC_TOKEN", SYNC_TOKEN),
    ("S3_ENDPOINT", S3_ENDPOINT),
    ("S3_ACCESS_KEY_ID", "minioadmin"),
    ("S3_SECRET_ACCESS_KEY", "minioadmin"),
  ]);
  assert_eq!(code, 1);
  assert!(
    out.contains("Required environment variable S3_BUCKET is not set"),
    "{out}"
  );
}

#[tokio::test]
async fn presigned_urls_name_the_public_endpoint() {
  let server = Server::start(
    &bucket("public"),
    &[("S3_PUBLIC_ENDPOINT", Some(PUBLIC_ENDPOINT))],
  )
  .await;
  let client = http();
  let (_, single) = post(
    &client,
    &format!("{}/v1/objects/presign-upload", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "endpoint/single.txt" }),
  )
  .await;
  let url = single["url"].as_str().unwrap();
  assert!(url.starts_with(PUBLIC_ENDPOINT), "{url}");
  assert!(!url.contains(S3_ENDPOINT));

  let (_, batch) = post(
    &client,
    &format!("{}/v1/objects/presign-upload-batch", server.url),
    Some(SYNC_TOKEN),
    json!({ "items": [{ "key": "endpoint/a.txt" }, { "key": "endpoint/b.txt" }] }),
  )
  .await;
  for item in batch["items"].as_array().unwrap() {
    assert!(item["url"].as_str().unwrap().starts_with(PUBLIC_ENDPOINT));
  }

  let (_, download) = post(
    &client,
    &format!("{}/v1/objects/presign-download", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "endpoint/single.txt" }),
  )
  .await;
  assert!(
    download["url"]
      .as_str()
      .unwrap()
      .starts_with(PUBLIC_ENDPOINT)
  );

  // The server's own S3 calls keep using the private endpoint.
  let (status, stat) = post(
    &client,
    &format!("{}/v1/objects/stat", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "endpoint/does-not-exist" }),
  )
  .await;
  assert_eq!((status, stat), (200, json!({ "exists": false })));

  let ready: serde_json::Value = client
    .get(format!("{}/readyz", server.url))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
  assert_eq!(
    ready,
    json!({ "status": "ready", "s3": true, "storageEndpoint": PUBLIC_ENDPOINT })
  );
  assert!(!server.logs().contains("S3_PUBLIC_ENDPOINT is not set"));
}

#[tokio::test]
async fn cloud_mode_withholds_the_storage_endpoint() {
  // A key that does not parse still makes cloud mode; JWTs are then refused.
  let server = Server::start(
    &bucket("cloudready"),
    &[
      ("S3_PUBLIC_ENDPOINT", Some(PUBLIC_ENDPOINT)),
      (
        "SYNC_JWT_PUBLIC_KEY",
        Some("-----BEGIN PUBLIC KEY-----\\nnot-a-real-key\\n-----END PUBLIC KEY-----"),
      ),
    ],
  )
  .await;
  let ready = http()
    .get(format!("{}/readyz", server.url))
    .send()
    .await
    .unwrap()
    .text()
    .await
    .unwrap();
  assert_eq!(ready, r#"{"status":"ready","s3":true}"#);
}

#[tokio::test]
async fn without_a_public_endpoint_urls_name_the_storage_endpoint() {
  let server = Server::start(&bucket("fallback"), &[]).await;
  let client = http();
  let (_, out) = post(
    &client,
    &format!("{}/v1/objects/presign-upload", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "endpoint/fallback.txt" }),
  )
  .await;
  assert!(out["url"].as_str().unwrap().starts_with(S3_ENDPOINT));
  let logs = server.logs();
  assert!(logs.contains("S3_PUBLIC_ENDPOINT is not set"), "{logs}");
  assert!(logs.contains(S3_ENDPOINT));
}

#[tokio::test]
async fn a_container_only_host_earns_a_warning() {
  let server = Server::start(
    &bucket("minio"),
    &[("S3_PUBLIC_ENDPOINT", Some("http://minio:9000"))],
  )
  .await;
  let logs = server.logs();
  assert!(
    logs
      .lines()
      .any(|l| l.contains("WARN") && l.contains("'minio'") && l.contains("S3_PUBLIC_ENDPOINT")),
    "{logs}"
  );
}

#[tokio::test]
async fn the_bucket_is_created_on_first_start() {
  let name = bucket("created");
  let first = Server::start(&name, &[]).await;
  drop(first);
  // A second start finds it.
  let second = Server::start(&name, &[]).await;
  let ready = http()
    .get(format!("{}/readyz", second.url))
    .send()
    .await
    .unwrap();
  assert_eq!(ready.status(), 200);
}
