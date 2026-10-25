//! The object API end to end, with the shared token.

mod common;

use std::time::Duration;

use common::{SYNC_TOKEN, Server, bucket, http, post};
use serde_json::{Value, json};

async fn put(client: &reqwest::Client, server: &Server, key: &str, content: &str) {
  let (status, body) = post(
    client,
    &format!("{}/v1/objects/presign-upload", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": key, "contentType": "text/plain" }),
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let stored = client
    .put(body["url"].as_str().unwrap())
    .header("content-type", "text/plain")
    .body(content.to_string())
    .send()
    .await
    .unwrap();
  assert!(
    stored.status().is_success(),
    "{}",
    stored.text().await.unwrap()
  );
}

#[tokio::test]
async fn root_and_health() {
  let server = Server::start(&bucket("root"), &[]).await;
  let client = http();
  let root = client.get(&server.url).send().await.unwrap();
  assert_eq!(root.status(), 200);
  assert_eq!(root.headers()["content-type"], "text/html; charset=utf-8");
  assert_eq!(root.text().await.unwrap(), "Donut Sync Service");
  let health = client
    .get(format!("{}/health", server.url))
    .send()
    .await
    .unwrap();
  assert_eq!(
    health.json::<Value>().await.unwrap(),
    json!({ "status": "ok" })
  );
  // Routes ignore case and one trailing slash, as Express did.
  let loose = client
    .get(format!("{}/HEALTH/", server.url))
    .send()
    .await
    .unwrap();
  assert_eq!(loose.status(), 200);
}

#[tokio::test]
async fn authentication() {
  let server = Server::start(&bucket("auth"), &[]).await;
  let client = http();
  let stat = format!("{}/v1/objects/stat", server.url);
  let (status, body) = post(&client, &stat, None, json!({ "key": "test-key" })).await;
  assert_eq!(status, 401);
  assert_eq!(
    body,
    json!({ "message": "Missing or invalid authorization header", "error": "Unauthorized", "statusCode": 401 })
  );
  let (status, body) = post(&client, &stat, Some("invalid-token"), json!({ "key": "k" })).await;
  assert_eq!(status, 401);
  assert_eq!(body["message"], "Invalid sync token or JWT");
  let (status, body) = post(
    &client,
    &stat,
    Some(SYNC_TOKEN),
    json!({ "key": "nonexistent-key" }),
  )
  .await;
  assert_eq!((status, body), (200, json!({ "exists": false })));
  let sse = client
    .get(format!("{}/v1/objects/subscribe", server.url))
    .send()
    .await
    .unwrap();
  assert_eq!(sse.status(), 401);
}

#[tokio::test]
async fn presigned_metadata_is_signed_and_persisted() {
  let server = Server::start(&bucket("meta"), &[]).await;
  let client = http();
  let (status, body) = post(
    &client,
    &format!("{}/v1/objects/presign-upload", server.url),
    Some(SYNC_TOKEN),
    json!({
      "key": "vpns/metadata.json",
      "contentType": "application/json",
      "metadata": { "updated-at": "1700000000", "ignored": "not-allowed" },
    }),
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(body["metadata"], json!({ "updated-at": "1700000000" }));
  let url = reqwest::Url::parse(body["url"].as_str().unwrap()).unwrap();
  let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
  let signed = query
    .iter()
    .find(|(k, _)| k == "X-Amz-SignedHeaders")
    .map(|(_, v)| v.clone())
    .unwrap();
  assert!(signed.split(';').any(|h| h == "x-amz-meta-updated-at"));
  assert!(!query.iter().any(|(k, _)| k == "x-amz-meta-updated-at"));

  let stored = client
    .put(url)
    .header("content-type", "application/json")
    .header("x-amz-meta-updated-at", "1700000000")
    .body("{}")
    .send()
    .await
    .unwrap();
  assert!(
    stored.status().is_success(),
    "{}",
    stored.text().await.unwrap()
  );

  let (_, stat) = post(
    &client,
    &format!("{}/v1/objects/stat", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "vpns/metadata.json" }),
  )
  .await;
  assert_eq!(stat["exists"], true);
  assert_eq!(stat["size"], 2);
  assert_eq!(stat["metadata"], json!({ "updated-at": "1700000000" }));
  assert!(stat["lastModified"].as_str().unwrap().ends_with(".000Z"));
}

#[tokio::test]
async fn a_full_upload_download_cycle() {
  let server = Server::start(&bucket("cycle"), &[]).await;
  let client = http();
  let key = "test/e2e-cycle.txt";
  put(&client, &server, key, "Hello from e2e test!").await;
  let (_, stat) = post(
    &client,
    &format!("{}/v1/objects/stat", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": key }),
  )
  .await;
  assert_eq!(stat["exists"], true);

  let (_, download) = post(
    &client,
    &format!("{}/v1/objects/presign-download", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": key }),
  )
  .await;
  assert!(
    download["url"]
      .as_str()
      .unwrap()
      .contains("test/e2e-cycle.txt")
  );
  let content = client
    .get(download["url"].as_str().unwrap())
    .send()
    .await
    .unwrap()
    .text()
    .await
    .unwrap();
  assert_eq!(content, "Hello from e2e test!");

  let (_, deleted) = post(
    &client,
    &format!("{}/v1/objects/delete", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": key, "tombstoneKey": "tombstones/test/e2e-cycle.json" }),
  )
  .await;
  assert_eq!(
    deleted,
    json!({ "deleted": true, "tombstoneCreated": true })
  );
  let (_, stat) = post(
    &client,
    &format!("{}/v1/objects/stat", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": key }),
  )
  .await;
  assert_eq!(stat, json!({ "exists": false }));
}

#[tokio::test]
async fn listing_pages_and_hides_the_manifest() {
  let server = Server::start(&bucket("list"), &[]).await;
  let client = http();
  for key in ["profiles/p1/a", "profiles/p1/b", "profiles/p2/a"] {
    put(&client, &server, key, "x").await;
  }
  tokio::time::sleep(Duration::from_millis(300)).await;
  let list = format!("{}/v1/objects/list", server.url);
  let (_, all) = post(&client, &list, Some(SYNC_TOKEN), json!({ "prefix": "" })).await;
  let keys: Vec<&str> = all["objects"]
    .as_array()
    .unwrap()
    .iter()
    .map(|o| o["key"].as_str().unwrap())
    .collect();
  assert_eq!(
    keys,
    vec!["profiles/p1/a", "profiles/p1/b", "profiles/p2/a"]
  );
  let (_, page) = post(
    &client,
    &list,
    Some(SYNC_TOKEN),
    json!({ "prefix": "profiles/", "maxKeys": 2 }),
  )
  .await;
  assert_eq!(page["isTruncated"], true);
  let (_, rest) = post(
    &client,
    &list,
    Some(SYNC_TOKEN),
    json!({ "prefix": "profiles/", "maxKeys": 2, "continuationToken": page["nextContinuationToken"] }),
  )
  .await;
  assert_eq!(rest["objects"][0]["key"], "profiles/p2/a");
  assert_eq!(rest["isTruncated"], false);
  assert!(rest.get("nextContinuationToken").is_none());
}

/// Reads the event stream until `needle` arrives.
async fn wait_for(response: &mut reqwest::Response, needle: &str, text: &mut String) {
  let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
  while !text.contains(needle) {
    let chunk = tokio::time::timeout_at(deadline, response.chunk())
      .await
      .expect("event did not arrive")
      .unwrap()
      .unwrap();
    text.push_str(&String::from_utf8_lossy(&chunk));
  }
}

#[tokio::test]
async fn subscriptions_report_changes_and_deletes() {
  let server = Server::start(&bucket("sse"), &[]).await;
  let client = http();
  put(&client, &server, "profiles/a/metadata.json", "1").await;
  put(&client, &server, "other/ignored", "1").await;
  let mut response = client
    .get(format!("{}/v1/objects/subscribe", server.url))
    .bearer_auth(SYNC_TOKEN)
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 200);
  assert_eq!(response.headers()["content-type"], "text/event-stream");
  assert_eq!(response.headers()["x-accel-buffering"], "no");
  let mut text = String::new();
  wait_for(&mut response, "profiles/a/metadata.json", &mut text).await;
  assert!(
    text.starts_with("\nid: 1\ndata: {\"type\":\"change\",\"key\":\"profiles/a/metadata.json\"")
  );
  assert!(!text.contains("other/ignored"));

  put(&client, &server, "proxies/p.json", "{}").await;
  post(
    &client,
    &format!("{}/v1/objects/delete", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "profiles/a/metadata.json" }),
  )
  .await;
  wait_for(&mut response, "\"type\":\"delete\"", &mut text).await;
  assert!(text.contains("id: 2\ndata: {\"type\":\"change\",\"key\":\"proxies/p.json\""));
  assert!(
    text.contains("id: 3\ndata: {\"type\":\"delete\",\"key\":\"profiles/a/metadata.json\"}\n\n")
  );
}

#[tokio::test]
async fn cors_routing_and_parser_errors_keep_their_shapes() {
  let server = Server::start(&bucket("shapes"), &[]).await;
  let client = http();
  let preflight = client
    .request(
      reqwest::Method::OPTIONS,
      format!("{}/v1/objects/stat", server.url),
    )
    .header("origin", "https://example.com")
    .header("access-control-request-method", "POST")
    .send()
    .await
    .unwrap();
  assert_eq!(preflight.status(), 204);
  assert_eq!(preflight.headers()["access-control-allow-origin"], "*");
  assert_eq!(
    preflight.headers()["access-control-allow-methods"],
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  assert_eq!(
    preflight.headers()["access-control-allow-headers"],
    "Content-Type,Authorization"
  );

  let missing = client
    .get(format!("{}/nope?x=1", server.url))
    .send()
    .await
    .unwrap();
  assert_eq!(missing.status(), 404);
  assert_eq!(missing.headers()["access-control-allow-origin"], "*");
  assert_eq!(
    missing.json::<Value>().await.unwrap(),
    json!({ "message": "Cannot GET /nope?x=1", "error": "Not Found", "statusCode": 404 })
  );

  // The JSON parser answers before auth and before CORS, as before.
  let bad = client
    .post(format!("{}/v1/objects/stat", server.url))
    .header("content-type", "application/json")
    .body("{bad")
    .send()
    .await
    .unwrap();
  assert_eq!(bad.status(), 400);
  assert!(bad.headers().get("access-control-allow-origin").is_none());
  let bad: Value = bad.json().await.unwrap();
  assert_eq!(bad["error"], "Bad Request");
  assert_eq!(bad["statusCode"], 400);

  let latin1 = client
    .post(format!("{}/v1/objects/stat", server.url))
    .header("content-type", "application/json; charset=latin1")
    .body("{}")
    .send()
    .await
    .unwrap();
  assert_eq!(latin1.status(), 415);
  assert_eq!(
    latin1.json::<Value>().await.unwrap(),
    json!({ "statusCode": 415, "message": "unsupported charset \"LATIN1\"" })
  );

  let large = client
    .post(format!("{}/v1/objects/stat", server.url))
    .header("content-type", "application/json")
    .body(format!("{{\"key\":\"{}\"}}", "x".repeat(51 * 1024 * 1024)))
    .send()
    .await
    .unwrap();
  assert_eq!(large.status(), 413);
  assert_eq!(
    large.json::<Value>().await.unwrap(),
    json!({ "statusCode": 413, "message": "request entity too large" })
  );

  // A body the server cannot use is still a plain 500.
  let (status, body) = post(
    &client,
    &format!("{}/v1/objects/stat", server.url),
    Some(SYNC_TOKEN),
    json!({}),
  )
  .await;
  assert_eq!(
    (status, body),
    (
      500,
      json!({ "statusCode": 500, "message": "Internal server error" })
    )
  );
}

#[tokio::test]
async fn batches_and_their_limits() {
  let server = Server::start(&bucket("batch"), &[]).await;
  let client = http();
  let url = format!("{}/v1/objects/presign-upload-batch", server.url);
  let (status, body) = post(&client, &url, Some(SYNC_TOKEN), json!({ "items": "x" })).await;
  assert_eq!(status, 400);
  assert_eq!(
    body["message"],
    "items must be an array of at most 1000 entries"
  );
  let too_many: Vec<Value> = (0..1001)
    .map(|i| json!({ "key": format!("k{i}") }))
    .collect();
  let (status, _) = post(
    &client,
    &url,
    Some(SYNC_TOKEN),
    json!({ "items": too_many }),
  )
  .await;
  assert_eq!(status, 400);
  let (status, body) = post(
    &client,
    &url,
    Some(SYNC_TOKEN),
    json!({ "items": [{ "key": "a" }, { "key": "b" }], "expiresIn": 120 }),
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(body["items"][1]["key"], "b");
  assert!(
    body["items"][1]["url"]
      .as_str()
      .unwrap()
      .contains("X-Amz-Expires=120&")
  );
  let (status, body) = post(
    &client,
    &format!("{}/v1/objects/presign-download-batch", server.url),
    Some(SYNC_TOKEN),
    json!({ "keys": ["a", "b"] }),
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(body["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn restore_points_copy_and_restore_inside_storage() {
  let server = Server::start(&bucket("snap"), &[]).await;
  let client = http();
  put(&client, &server, "profiles/p1/manifest.json", "m1").await;
  put(&client, &server, "profiles/p1/files/Default/Cookies", "c1").await;
  let api = |route: &str| format!("{}/v1/objects/snapshots/{route}", server.url);
  let (status, body) = post(
    &client,
    &api("create"),
    Some(SYNC_TOKEN),
    json!({ "profileRoot": "profiles/p9/" }),
  )
  .await;
  assert_eq!(
    (status, body),
    (400, json!({ "code": "SNAPSHOT_NOTHING_TO_KEEP" }))
  );
  let (status, point) = post(
    &client,
    &api("create"),
    Some(SYNC_TOKEN),
    json!({ "profileRoot": "profiles/p1/", "kind": "manual" }),
  )
  .await;
  assert_eq!(status, 200, "{point}");
  assert_eq!(point["files"], 1);
  assert_eq!(point["bytes"], 4);

  put(&client, &server, "profiles/p1/files/Default/Cookies", "c2").await;
  put(&client, &server, "profiles/p1/files/Default/New", "n").await;
  let (_, restored) = post(
    &client,
    &api("restore-files"),
    Some(SYNC_TOKEN),
    json!({ "profileRoot": "profiles/p1/", "id": point["id"] }),
  )
  .await;
  assert_eq!(restored, json!({ "restored": 1, "removed": 1 }));
  let (_, download) = post(
    &client,
    &format!("{}/v1/objects/presign-download", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "profiles/p1/files/Default/Cookies" }),
  )
  .await;
  let content = client
    .get(download["url"].as_str().unwrap())
    .send()
    .await
    .unwrap()
    .text()
    .await
    .unwrap();
  assert_eq!(content, "c1");

  let (status, body) = post(
    &client,
    &api("restore-files"),
    Some(SYNC_TOKEN),
    json!({ "profileRoot": "profiles/p1/", "id": "20000101T000000Z-abcd" }),
  )
  .await;
  assert_eq!(
    (status, body),
    (404, json!({ "code": "SNAPSHOT_NOT_FOUND" }))
  );
  let (_, listed) = post(
    &client,
    &api("list"),
    Some(SYNC_TOKEN),
    json!({ "profileRoot": "profiles/p1/" }),
  )
  .await;
  assert_eq!(listed["snapshots"][0]["id"], point["id"]);
  let (_, deleted) = post(
    &client,
    &api("delete"),
    Some(SYNC_TOKEN),
    json!({ "profileRoot": "profiles/p1/", "id": point["id"] }),
  )
  .await;
  assert_eq!(deleted, json!({ "deleted": true }));
}

#[tokio::test]
async fn delete_prefix_removes_everything_under_it() {
  let server = Server::start(&bucket("delp"), &[]).await;
  let client = http();
  for key in ["profiles/p1/a", "profiles/p1/b", "profiles/p2/a"] {
    put(&client, &server, key, "x").await;
  }
  let (_, out) = post(
    &client,
    &format!("{}/v1/objects/delete-prefix", server.url),
    Some(SYNC_TOKEN),
    json!({ "prefix": "profiles/p1/", "tombstoneKey": "tombstones/profiles/p1" }),
  )
  .await;
  assert_eq!(out, json!({ "deletedCount": 2, "tombstoneCreated": true }));
  let (_, list) = post(
    &client,
    &format!("{}/v1/objects/list", server.url),
    Some(SYNC_TOKEN),
    json!({ "prefix": "" }),
  )
  .await;
  let keys: Vec<&str> = list["objects"]
    .as_array()
    .unwrap()
    .iter()
    .map(|o| o["key"].as_str().unwrap())
    .collect();
  assert_eq!(keys, vec!["profiles/p2/a", "tombstones/profiles/p1"]);
}
