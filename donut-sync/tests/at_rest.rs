//! Encryption at rest end to end: the binary with `SYNC_AT_REST_KEY` against
//! the compose S3 server, devices that speak only the S3 presigned protocol,
//! plaintext objects from before, and the migration command.

mod common;

use common::{SYNC_TOKEN, Server, bucket, http, post, raw_store, run_command, storage_env};
use donut_sync::store::{Store, Upload, collect, once};
use serde_json::{Value, json};

const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const K2: &str = "k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

fn sample(len: usize) -> Vec<u8> {
  (0..len).map(|i| (i * 131 + 17) as u8).collect()
}

async fn sealed_server(name: &str, keys: &str) -> (Server, String) {
  let bucket = bucket(name);
  (
    Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(keys))]).await,
    bucket,
  )
}

async fn call(server: &Server, route: &str, body: Value) -> (u16, Value) {
  post(
    &http(),
    &format!("{}/v1/objects/{route}", server.url),
    Some(SYNC_TOKEN),
    body,
  )
  .await
}

/// What the app does: presign, then PUT with the echoed metadata.
async fn upload(server: &Server, key: &str, body: Vec<u8>, updated_at: Option<&str>) -> String {
  let mut request = json!({ "key": key, "contentType": "application/octet-stream" });
  if let Some(updated_at) = updated_at {
    request["metadata"] = json!({ "updated-at": updated_at });
  }
  let (status, presign) = call(server, "presign-upload", request).await;
  assert_eq!(status, 200, "{presign}");
  let url = presign["url"].as_str().unwrap().to_string();
  let mut put = http()
    .put(&url)
    .header("Content-Length", body.len().to_string())
    .header("Content-Type", "application/octet-stream")
    .body(body);
  if let Some(metadata) = presign["metadata"].as_object() {
    for (name, value) in metadata {
      put = put.header(format!("x-amz-meta-{name}"), value.as_str().unwrap());
    }
  }
  let response = put.send().await.unwrap();
  assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
  url
}

async fn download(server: &Server, key: &str) -> (u16, Vec<u8>) {
  let (status, presign) = call(server, "presign-download", json!({ "key": key })).await;
  assert_eq!(status, 200, "{presign}");
  let response = http()
    .get(presign["url"].as_str().unwrap())
    .send()
    .await
    .unwrap();
  let status = response.status().as_u16();
  (status, response.bytes().await.unwrap().to_vec())
}

#[tokio::test]
async fn transfers_go_through_the_server_and_are_sealed_in_storage() {
  let (server, bucket) = sealed_server("seal", K1).await;
  let raw = raw_store(&bucket);
  for (key, size) in [
    ("profiles/p/files/big", 3 * 65_536 + 77),
    ("profiles/p/files/frame", 65_536),
    ("profiles/p/files/empty", 0),
  ] {
    let plain = sample(size);
    let url = upload(&server, key, plain.clone(), Some("1700000000")).await;
    assert!(
      url.starts_with(&format!("{}/v1/transfer?", server.url)),
      "{url}"
    );

    let stored = collect(raw.get_object(key).await.unwrap().body)
      .await
      .unwrap();
    assert_eq!(&stored[..4], b"DSAR");
    assert_ne!(stored, plain);
    let head = raw.head_object(key).await.unwrap();
    assert_eq!(head.metadata_value("donut-at-rest"), Some("1:k1"));

    let (status, stat) = call(&server, "stat", json!({ "key": key })).await;
    assert_eq!(status, 200);
    assert_eq!(stat["size"], json!(size));
    assert_eq!(stat["metadata"], json!({ "updated-at": "1700000000" }));

    assert_eq!(download(&server, key).await, (200, plain));
  }
  let (_, readyz) = (
    0,
    http()
      .get(format!("{}/readyz", server.url))
      .send()
      .await
      .unwrap()
      .json::<Value>()
      .await
      .unwrap(),
  );
  assert_eq!(readyz, json!({ "status": "ready", "s3": true }));
  assert!(
    server
      .logs()
      .contains("Encryption at rest on key=k1 keys=1")
  );
}

#[tokio::test]
async fn batches_and_downloads_keep_the_s3_shapes() {
  let (server, _) = sealed_server("batch", K1).await;
  let (status, batch) = call(
    &server,
    "presign-upload-batch",
    json!({ "items": [{ "key": "a" }, { "key": "b" }] }),
  )
  .await;
  assert_eq!(status, 200);
  for item in batch["items"].as_array().unwrap() {
    let key = item["key"].as_str().unwrap();
    assert!(item["expiresAt"].is_string());
    let response = http()
      .put(item["url"].as_str().unwrap())
      .header("Content-Length", key.len().to_string())
      .body(key.to_string())
      .send()
      .await
      .unwrap();
    assert_eq!(response.status(), 200);
  }
  let (_, batch) = call(
    &server,
    "presign-download-batch",
    json!({ "keys": ["a", "b"] }),
  )
  .await;
  for item in batch["items"].as_array().unwrap() {
    let response = http()
      .get(item["url"].as_str().unwrap())
      .send()
      .await
      .unwrap();
    assert_eq!(
      response.text().await.unwrap(),
      item["key"].as_str().unwrap()
    );
  }
  let (_, list) = call(&server, "list", json!({ "prefix": "" })).await;
  let keys: Vec<&str> = list["objects"]
    .as_array()
    .unwrap()
    .iter()
    .map(|o| o["key"].as_str().unwrap())
    .collect();
  assert_eq!(keys, ["a", "b"]);
}

#[tokio::test]
async fn transfer_urls_refuse_what_s3_would_refuse() {
  let (server, _) = sealed_server("refuse", K1).await;
  let client = http();
  let (_, presign) = call(
    &server,
    "presign-upload",
    json!({ "key": "k", "metadata": { "updated-at": "5" } }),
  )
  .await;
  let url = presign["url"].as_str().unwrap();
  let put = |url: String| client.put(url).header("Content-Length", "1").body("x");

  // The signed metadata must be sent, exactly.
  let response = put(url.to_string()).send().await.unwrap();
  assert_eq!(response.status(), 403);
  let response = put(url.to_string())
    .header("x-amz-meta-updated-at", "6")
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 403);
  let response = put(url.to_string())
    .header("x-amz-meta-updated-at", "5")
    .header("x-amz-meta-group-id", "g")
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 403);
  // A changed URL, or the wrong method.
  let response = put(url.replace("updated-at=5", "updated-at=6"))
    .header("x-amz-meta-updated-at", "6")
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 403);
  assert!(
    response
      .text()
      .await
      .unwrap()
      .contains("SignatureDoesNotMatch")
  );
  let response = client.get(url).send().await.unwrap();
  assert_eq!(response.status(), 403);
  // No length, as S3 answers a chunked PUT.
  let chunked = reqwest::Body::wrap_stream(futures_util::stream::iter([Ok::<_, std::io::Error>(
    bytes::Bytes::from_static(b"x"),
  )]));
  let response = client
    .put(url)
    .header("x-amz-meta-updated-at", "5")
    .body(chunked)
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 411);
  // Expired.
  let (_, short) = call(
    &server,
    "presign-download",
    json!({ "key": "k", "expiresIn": 0.001 }),
  )
  .await;
  tokio::time::sleep(std::time::Duration::from_millis(20)).await;
  let response = client
    .get(short["url"].as_str().unwrap())
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 403);
  assert!(
    response
      .text()
      .await
      .unwrap()
      .contains("Request has expired")
  );
  // Missing object.
  assert_eq!(download(&server, "missing").await.0, 404);
  // The right request still works.
  let response = put(url.to_string())
    .header("x-amz-meta-updated-at", "5")
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn without_the_key_nothing_changes() {
  let server = Server::start(&bucket("plain"), &[]).await;
  let (_, presign) = call(&server, "presign-upload", json!({ "key": "k" })).await;
  assert!(
    presign["url"]
      .as_str()
      .unwrap()
      .starts_with("http://127.0.0.1:8987/")
  );
  let response = http()
    .get(format!("{}/v1/transfer?key=k", server.url))
    .send()
    .await
    .unwrap();
  assert_eq!(response.status(), 404);
  assert_eq!(
    response.json::<Value>().await.unwrap()["message"],
    "Cannot GET /v1/transfer?key=k"
  );
  assert!(!server.logs().contains("Encryption at rest"));
}

/// Writes `objects` straight to storage, as an older server left them.
async fn seed_plaintext(bucket: &str, objects: &[(&str, Vec<u8>)]) {
  let raw = raw_store(bucket);
  raw.create_bucket().await.ok();
  for (key, body) in objects {
    raw
      .put_object_stream(
        key,
        once(body.clone()),
        Upload {
          length: body.len() as u64,
          content_type: Some("application/json"),
          metadata: &[("updated-at".to_string(), "9".to_string())],
          if_match: None,
        },
      )
      .await
      .unwrap();
  }
}

#[tokio::test]
async fn plaintext_and_sealed_objects_read_side_by_side() {
  let bucket = bucket("mixed");
  let old = sample(100_000);
  seed_plaintext(&bucket, &[("proxies/old.json", old.clone())]).await;
  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(K1))]).await;
  upload(&server, "proxies/new.json", b"new".to_vec(), Some("10")).await;

  assert_eq!(download(&server, "proxies/old.json").await, (200, old));
  assert_eq!(
    download(&server, "proxies/new.json").await,
    (200, b"new".to_vec())
  );
  let (_, stat) = call(&server, "stat", json!({ "key": "proxies/old.json" })).await;
  assert_eq!(stat["size"], json!(100_000));
  assert_eq!(stat["metadata"], json!({ "updated-at": "9" }));

  // Restore points copy sealed objects and read their sealed records.
  upload(&server, "profiles/p/manifest.json", b"{}".to_vec(), None).await;
  upload(&server, "profiles/p/files/a", b"A".to_vec(), None).await;
  let (status, snapshot) = call(
    &server,
    "snapshots/create",
    json!({ "profileRoot": "profiles/p/" }),
  )
  .await;
  assert_eq!(status, 200, "{snapshot}");
  let (_, listed) = call(
    &server,
    "snapshots/list",
    json!({ "profileRoot": "profiles/p/" }),
  )
  .await;
  assert_eq!(listed["snapshots"][0]["id"], snapshot["id"]);
  upload(&server, "profiles/p/files/a", b"changed".to_vec(), None).await;
  let (status, _) = call(
    &server,
    "snapshots/restore-files",
    json!({ "profileRoot": "profiles/p/", "id": snapshot["id"] }),
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(
    download(&server, "profiles/p/files/a").await,
    (200, b"A".to_vec())
  );
}

#[tokio::test]
async fn migration_seals_everything_in_place_and_a_rerun_does_nothing() {
  let bucket = bucket("migrate");
  let objects: Vec<(String, Vec<u8>)> = (0..25)
    .map(|i| {
      (
        format!("users/u/profiles/p/files/{i:02}"),
        sample(i * 9_000),
      )
    })
    .collect();
  let refs: Vec<(&str, Vec<u8>)> = objects
    .iter()
    .map(|(k, v)| (k.as_str(), v.clone()))
    .collect();
  seed_plaintext(&bucket, &refs).await;
  let storage = storage_env(&bucket);
  let mut env: Vec<(&str, &str)> = storage.iter().map(|(k, v)| (*k, v.as_str())).collect();
  env.push(("SYNC_AT_REST_KEY", K1));
  let total: usize = objects.iter().map(|(_, v)| v.len()).sum();

  let (code, out) = run_command(&["migrate-at-rest", "--dry-run"], &env);
  assert_eq!(code, 0, "{out}");
  assert!(
    out.contains(&format!(
      "scanned=25 current=0 sealed=25 sealed_bytes={total} "
    )),
    "{out}"
  );
  let raw = raw_store(&bucket);
  let first = collect(raw.get_object(&objects[3].0).await.unwrap().body)
    .await
    .unwrap();
  assert_eq!(first, objects[3].1);

  let (code, out) = run_command(
    &[
      "migrate-at-rest",
      "--concurrency",
      "3",
      "--max-mib-per-sec",
      "64",
    ],
    &env,
  );
  assert_eq!(code, 0, "{out}");
  assert!(out.contains("conditional_put=false"), "{out}");
  assert!(out.contains("sealed=25"), "{out}");
  for (key, _) in &objects {
    let head = raw.head_object(key).await.unwrap();
    assert_eq!(head.metadata_value("donut-at-rest"), Some("1:k1"), "{key}");
    assert_eq!(head.metadata_value("updated-at"), Some("9"), "{key}");
    assert_eq!(head.content_type.as_deref(), Some("application/json"));
  }
  let listed = raw
    .list_objects_v2(&donut_sync::store::ListInput::default())
    .await
    .unwrap();
  assert_eq!(listed.contents.len(), 25, "no temporary copy is left");

  let (code, out) = run_command(&["migrate-at-rest"], &env);
  assert_eq!(code, 0, "{out}");
  assert!(out.contains("current=25 sealed=0"), "{out}");

  // The server reads what the migration wrote. Self-hosted keys are bare.
  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(K1))]).await;
  for (key, body) in &objects {
    assert_eq!(download(&server, key).await, (200, body.clone()));
  }
  drop(server);

  // Rotation: k2 writes, k1 still reads, and the migration moves k1's objects.
  let rotated = format!("{K2},{K1}");
  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(&rotated))]).await;
  assert_eq!(
    download(&server, &objects[5].0).await,
    (200, objects[5].1.clone())
  );
  drop(server);
  env.retain(|(k, _)| *k != "SYNC_AT_REST_KEY");
  env.push(("SYNC_AT_REST_KEY", &rotated));
  let (code, out) = run_command(&["migrate-at-rest"], &env);
  assert_eq!(code, 0, "{out}");
  assert!(out.contains("rotated=25"), "{out}");
  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(K2))]).await;
  assert_eq!(
    download(&server, &objects[7].0).await,
    (200, objects[7].1.clone())
  );
}

#[tokio::test]
async fn a_bad_key_stops_the_server_at_start() {
  let storage = storage_env(&bucket("badkey"));
  let mut env: Vec<(&str, &str)> = storage.iter().map(|(k, v)| (*k, v.as_str())).collect();
  env.push(("SYNC_TOKEN", SYNC_TOKEN));
  env.push(("SYNC_AT_REST_KEY", "k1:AAAA"));
  let (code, out) = common::run_to_exit(&env);
  assert_eq!(code, 1);
  assert!(out.contains("must be 32 bytes"), "{out}");
}
