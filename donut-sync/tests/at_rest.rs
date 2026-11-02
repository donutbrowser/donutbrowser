//! Encryption at rest end to end: the binary with `SYNC_AT_REST_KEY` against
//! the compose S3 server, devices that speak only the S3 presigned protocol,
//! plaintext objects from before, and the migration command.

mod common;

use common::{
  SYNC_TOKEN, Server, StorageRequest, fresh_bucket, http, post, raw_store, run_command, storage_env,
};
use donut_sync::store::{Store, collect};
use serde_json::{Value, json};

const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const K2: &str = "k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

fn sample(len: usize) -> Vec<u8> {
  (0..len).map(|i| (i * 131 + 17) as u8).collect()
}

async fn sealed_server(name: &str, keys: &str) -> (Server, String) {
  let bucket = fresh_bucket(name).await;
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

/// What a newer app does with a small file: presign, then PUT to the
/// transfer URL with the echoed metadata.
async fn upload(server: &Server, key: &str, body: Vec<u8>, updated_at: Option<&str>) -> String {
  let mut request = json!({ "key": key, "contentType": "application/octet-stream" });
  if let Some(updated_at) = updated_at {
    request["metadata"] = json!({ "updated-at": updated_at });
  }
  let (status, presign) = call(server, "presign-upload", request).await;
  assert_eq!(status, 200, "{presign}");
  // Older apps keep the direct storage URL.
  assert!(
    presign["url"]
      .as_str()
      .unwrap()
      .starts_with(&common::storage().endpoint)
  );
  assert_eq!(presign["transfer"]["partSize"], json!(8 * 1024 * 1024));
  let url = presign["transfer"]["url"].as_str().unwrap().to_string();
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
  let response = put.send_to_storage().await;
  assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
  url
}

async fn download(server: &Server, key: &str) -> (u16, Vec<u8>) {
  let (status, presign) = call(server, "presign-download", json!({ "key": key })).await;
  assert_eq!(status, 200, "{presign}");
  let response = http()
    .get(presign["url"].as_str().unwrap())
    .send_to_storage()
    .await;
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
      .send_to_storage()
      .await
      .json::<Value>()
      .await
      .unwrap(),
  );
  // Older apps still upload to storage directly, so its address is named.
  assert_eq!(
    readyz,
    json!({ "status": "ready", "s3": true, "storageEndpoint": &common::storage().endpoint })
  );
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
    // "a" as a newer app sends it, "b" as an older one.
    let url = match key {
      "a" => item["transfer"]["url"].as_str().unwrap(),
      _ => item["url"].as_str().unwrap(),
    };
    let response = http()
      .put(url)
      .header("Content-Length", key.len().to_string())
      .body(key.to_string())
      .send_to_storage()
      .await;
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
      .send_to_storage()
      .await;
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
  let url = presign["transfer"]["url"].as_str().unwrap();
  let put = |url: String| client.put(url).header("Content-Length", "1").body("x");

  // The signed metadata must be sent, exactly.
  let response = put(url.to_string()).send_to_storage().await;
  assert_eq!(response.status(), 403);
  let response = put(url.to_string())
    .header("x-amz-meta-updated-at", "6")
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 403);
  let response = put(url.to_string())
    .header("x-amz-meta-updated-at", "5")
    .header("x-amz-meta-group-id", "g")
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 403);
  // A changed URL, or the wrong method.
  let response = put(url.replace("updated-at=5", "updated-at=6"))
    .header("x-amz-meta-updated-at", "6")
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 403);
  assert!(
    response
      .text()
      .await
      .unwrap()
      .contains("SignatureDoesNotMatch")
  );
  let response = client.get(url).send_to_storage().await;
  assert_eq!(response.status(), 403);
  // No length, as S3 answers a chunked PUT.
  let chunked = reqwest::Body::wrap_stream(futures_util::stream::iter([Ok::<_, std::io::Error>(
    bytes::Bytes::from_static(b"x"),
  )]));
  let response = client
    .put(url)
    .header("x-amz-meta-updated-at", "5")
    .body(chunked)
    .send_to_storage()
    .await;
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
    .send_to_storage()
    .await;
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
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn without_the_key_nothing_changes() {
  let server = Server::start(&fresh_bucket("plain").await, &[]).await;
  let (_, presign) = call(&server, "presign-upload", json!({ "key": "k" })).await;
  assert!(
    presign["url"]
      .as_str()
      .unwrap()
      .starts_with(&format!("{}/", common::storage().endpoint))
  );
  let response = http()
    .get(format!("{}/v1/transfer?key=k", server.url))
    .send_to_storage()
    .await;
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
    // The buffered PUT, which retries as S3 clients do.
    raw
      .put_object(
        key,
        body.clone(),
        "application/json",
        &[("updated-at".to_string(), "9".to_string())],
      )
      .await
      .unwrap();
  }
}

#[tokio::test]
async fn plaintext_and_sealed_objects_read_side_by_side() {
  let bucket = fresh_bucket("mixed").await;
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
  let bucket = fresh_bucket("migrate").await;
  let objects: Vec<(String, Vec<u8>)> = (0..25)
    .map(|i| (format!("profiles/p/files/{i:02}"), sample(i * 9_000)))
    .collect();
  let refs: Vec<(&str, Vec<u8>)> = objects
    .iter()
    .map(|(k, v)| (k.as_str(), v.clone()))
    .collect();
  seed_plaintext(&bucket, &refs).await;
  let before = raw_store(&bucket)
    .list_objects_v2(&donut_sync::store::ListInput::default())
    .await
    .unwrap();
  let original_ms = before.contents[3].last_modified_ms.unwrap();
  // The rewrite must land in a later second than the seed.
  tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
  let storage = storage_env(&bucket);
  let mut env: Vec<(&str, &str)> = storage.iter().map(|(k, v)| (*k, v.as_str())).collect();
  env.push(("SYNC_AT_REST_KEY", K1));
  let total: usize = objects.iter().map(|(_, v)| v.len()).sum();

  let (code, out) = run_command(&["verify-at-rest"], &env);
  assert_eq!(code, 1, "{out}");
  assert!(out.contains("complete=false"), "{out}");
  assert!(
    out.contains(&format!(
      "plaintext=25 plaintext_bytes={}",
      objects.iter().map(|(_, v)| v.len()).sum::<usize>()
    )),
    "{out}"
  );

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
  let (code, out) = run_command(&["verify-at-rest", "--sample", "10"], &env);
  assert_eq!(code, 0, "{out}");
  assert!(out.contains("complete=true objects=25"), "{out}");
  assert!(
    out.contains("plaintext=0 plaintext_bytes=0 sealed[k1]=25"),
    "{out}"
  );
  assert!(out.contains("sampled=10 sample_failed=0"), "{out}");

  // The server reads what the migration wrote. Self-hosted keys are bare.
  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(K1))]).await;
  for (key, body) in &objects {
    assert_eq!(download(&server, key).await, (200, body.clone()));
  }
  // Reads report the time from before the migration, as storage did.
  let key = &objects[3].0;
  let rewritten = raw
    .head_object(key)
    .await
    .unwrap()
    .last_modified_ms
    .unwrap();
  assert!(rewritten / 1000 > original_ms / 1000);
  let (_, stat) = call(&server, "stat", json!({ "key": key })).await;
  assert_eq!(
    stat["lastModified"],
    json!(donut_sync::time::iso_from_ms(original_ms))
  );
  // rclone adds its own `mtime` to a server-side copy; ours must not show.
  assert_eq!(stat["metadata"]["updated-at"], "9");
  assert!(
    stat["metadata"]
      .as_object()
      .unwrap()
      .keys()
      .all(|k| !k.starts_with("donut-"))
  );
  let (_, presign) = call(&server, "presign-download", json!({ "key": key })).await;
  let response = http()
    .get(presign["url"].as_str().unwrap())
    .send_to_storage()
    .await;
  assert_eq!(
    response.headers()["last-modified"],
    donut_sync::time::http_date(original_ms).as_str()
  );
  assert!(
    response
      .headers()
      .get("x-amz-meta-donut-orig-mtime")
      .is_none()
  );
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
  // A restore point is a new copy: it takes its own time.
  upload(&server, "profiles/p/manifest.json", b"{}".to_vec(), None).await;
  let (status, snapshot) = call(
    &server,
    "snapshots/create",
    json!({ "profileRoot": "profiles/p/" }),
  )
  .await;
  assert_eq!(status, 200, "{snapshot}");
  let copy = format!(
    "snapshots/profiles/p/{}/files/03",
    snapshot["id"].as_str().unwrap()
  );
  let (_, stat) = call(&server, "stat", json!({ "key": copy })).await;
  assert_ne!(
    stat["lastModified"],
    json!(donut_sync::time::iso_from_ms(original_ms))
  );
  // rclone adds its own `mtime` to a server-side copy; ours must not show.
  assert_eq!(stat["metadata"]["updated-at"], "9");
  assert!(
    stat["metadata"]
      .as_object()
      .unwrap()
      .keys()
      .all(|k| !k.starts_with("donut-"))
  );
  assert_eq!(download(&server, &copy).await, (200, objects[3].1.clone()));
}

#[tokio::test]
async fn a_bad_key_stops_the_server_at_start() {
  let storage = storage_env(&fresh_bucket("badkey").await);
  let mut env: Vec<(&str, &str)> = storage.iter().map(|(k, v)| (*k, v.as_str())).collect();
  env.push(("SYNC_TOKEN", SYNC_TOKEN));
  env.push(("SYNC_AT_REST_KEY", "k1:AAAA"));
  let (code, out) = common::run_to_exit(&env);
  assert_eq!(code, 1);
  assert!(out.contains("must be 32 bytes"), "{out}");
}

const PART: usize = 8 * 1024 * 1024;

/// Presign as a newer app does, and return (transfer URL, signed metadata).
async fn presign_transfer(server: &Server, key: &str) -> (String, Value) {
  let (status, presign) = call(
    server,
    "presign-upload",
    json!({ "key": key, "contentType": "application/octet-stream", "metadata": { "updated-at": "77" } }),
  )
  .await;
  assert_eq!(status, 200, "{presign}");
  (
    presign["transfer"]["url"].as_str().unwrap().to_string(),
    presign["metadata"].clone(),
  )
}

async fn start_parts(url: &str, length: usize) -> reqwest::Response {
  http()
    .post(url)
    .header("x-donut-upload-length", length.to_string())
    .header("Content-Type", "application/octet-stream")
    .header("x-amz-meta-updated-at", "77")
    .send_to_storage()
    .await
}

fn part_url(url: &str, upload: &str, part: usize) -> String {
  format!("{url}&upload={upload}&part={part}")
}

#[tokio::test]
async fn large_files_upload_in_parts_into_one_sealed_object() {
  let (server, bucket) = sealed_server("parts", K1).await;
  let key = "profiles/p/files/large";
  let plain = sample(2 * PART + 12_345);
  let (url, _) = presign_transfer(&server, key).await;

  let started = start_parts(&url, plain.len()).await;
  assert_eq!(started.status(), 200);
  let started: Value = started.json().await.unwrap();
  assert_eq!(
    (started["partSize"].as_u64(), started["parts"].as_u64()),
    (Some(PART as u64), Some(3))
  );
  let upload = started["upload"].as_str().unwrap();

  let mut etags = Vec::new();
  for (i, chunk) in plain.chunks(PART).enumerate() {
    let response = http()
      .put(part_url(&url, upload, i + 1))
      .header("Content-Length", chunk.len().to_string())
      .body(chunk.to_vec())
      .send_to_storage()
      .await;
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    etags.push(response.headers()["etag"].to_str().unwrap().to_string());
  }
  // A part sent again replaces itself.
  let again = http()
    .put(part_url(&url, upload, 2))
    .header("Content-Length", PART.to_string())
    .body(plain[PART..2 * PART].to_vec())
    .send_to_storage()
    .await;
  etags[1] = again.headers()["etag"].to_str().unwrap().to_string();
  let done = http()
    .post(format!("{url}&upload={upload}&op=complete"))
    .json(&json!({ "parts": etags }))
    .send_to_storage()
    .await;
  assert_eq!(done.status(), 200, "{}", done.text().await.unwrap());

  let raw = raw_store(&bucket);
  let head = raw.head_object(key).await.unwrap();
  assert_eq!(head.metadata_value("donut-at-rest"), Some("1:k1"));
  let (_, stat) = call(&server, "stat", json!({ "key": key })).await;
  assert_eq!(stat["size"], json!(plain.len()));
  assert_eq!(stat["metadata"]["updated-at"], "77");
  assert_eq!(download(&server, key).await, (200, plain));
}

#[tokio::test]
async fn part_requests_refuse_what_does_not_fit_the_upload() {
  let (server, _) = sealed_server("partrefuse", K1).await;
  let (url, _) = presign_transfer(&server, "k").await;
  // Unsigned metadata, and no length.
  let response = http()
    .post(&url)
    .header("x-donut-upload-length", "10")
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 403);
  let response = http()
    .post(&url)
    .header("x-amz-meta-updated-at", "77")
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 400);

  let started: Value = start_parts(&url, PART + 1).await.json().await.unwrap();
  let upload = started["upload"].as_str().unwrap().to_string();
  let put = |part: usize, len: usize| {
    http()
      .put(part_url(&url, &upload, part))
      .header("Content-Length", len.to_string())
      .body(vec![0u8; len])
      .send_to_storage()
  };
  assert_eq!(put(1, PART - 1).await.status(), 400, "a short part");
  assert_eq!(put(3, 1).await.status(), 400, "no part 3");
  assert_eq!(put(0, 1).await.status(), 400, "no part 0");
  // A forged token, or this token on another key's URL.
  let forged = upload.replacen('.', ".0", 1);
  let response = http()
    .put(part_url(&url, &forged, 2))
    .header("Content-Length", "1")
    .body(vec![0u8])
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 403);
  let (other, _) = presign_transfer(&server, "other").await;
  let response = http()
    .put(part_url(&other, &upload, 2))
    .header("Content-Length", "1")
    .body(vec![0u8])
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 403);
  // A part sent again must carry the same bytes.
  assert_eq!(put(1, PART).await.status(), 200);
  assert_eq!(put(1, PART).await.status(), 200, "the same bytes again");
  let changed = http()
    .put(part_url(&url, &upload, 1))
    .header("Content-Length", PART.to_string())
    .body(vec![1u8; PART])
    .send_to_storage()
    .await;
  assert_eq!(changed.status(), 409);
  // The wrong number of parts on completion.
  let one = put(2, 1).await;
  let etag = one.headers()["etag"].to_str().unwrap().to_string();
  let done = http()
    .post(format!("{url}&upload={upload}&op=complete"))
    .json(&json!({ "parts": [etag] }))
    .send_to_storage()
    .await;
  assert_eq!(done.status(), 400);
  // Aborted, the upload takes no more parts.
  let aborted = http()
    .delete(format!("{url}&upload={upload}"))
    .send_to_storage()
    .await;
  assert_eq!(aborted.status(), 204);
  assert_eq!(download(&server, "k").await.0, 404);
}

#[tokio::test]
async fn older_apps_upload_directly_and_the_sealer_seals_it() {
  let (server, bucket) = sealed_server("direct", K1).await;
  let key = "profiles/p/files/old-app";
  let (status, presign) = call(
    &server,
    "presign-upload",
    json!({ "key": key, "metadata": { "updated-at": "5" } }),
  )
  .await;
  assert_eq!(status, 200);
  let plain = sample(300_000);
  let response = http()
    .put(presign["url"].as_str().unwrap())
    .header("Content-Length", plain.len().to_string())
    .header("x-amz-meta-updated-at", "5")
    .body(plain.clone())
    .send_to_storage()
    .await;
  assert_eq!(response.status(), 200);
  let raw: std::sync::Arc<dyn Store> = std::sync::Arc::new(raw_store(&bucket));
  assert!(
    raw
      .head_object(key)
      .await
      .unwrap()
      .metadata_value("donut-at-rest")
      .is_none()
  );
  // Readable before it is sealed.
  assert_eq!(download(&server, key).await, (200, plain.clone()));

  // The server notes presigned keys in memory and writes them every 10 s.
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
  loop {
    let pending = raw
      .list_objects_v2(&donut_sync::store::ListInput {
        prefix: Some(".donut-sync-at-rest/pending/".to_string()),
        ..Default::default()
      })
      .await
      .unwrap();
    if !pending.contents.is_empty() {
      break;
    }
    assert!(
      std::time::Instant::now() < deadline,
      "no pending record written"
    );
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
  }
  let keyring = std::sync::Arc::new(donut_sync::at_rest::Keyring::parse(K1).unwrap());
  let sealer = donut_sync::sealer::Sealer::new(raw.clone(), keyring)
    .await
    .unwrap();
  // Nothing is rewritten while the URL can still write.
  let report = sealer
    .pending_pass(donut_sync::time::now_ms())
    .await
    .unwrap();
  assert_eq!((report.records, report.checked), (1, 0));
  let (_, list) = call(&server, "list", json!({ "prefix": "" })).await;
  assert_eq!(list["objects"].as_array().unwrap().len(), 1, "{list}");
  // Once it is dead, the object is sealed and the record goes.
  let report = sealer
    .pending_pass(donut_sync::time::now_ms() + 2 * 3600 * 1000)
    .await
    .unwrap();
  assert_eq!(
    (report.sealed, report.failed, report.records_done),
    (1, 0, 1)
  );
  let head = raw.head_object(key).await.unwrap();
  assert_eq!(head.metadata_value("donut-at-rest"), Some("1:k1"));
  assert_eq!(head.metadata_value("updated-at"), Some("5"));
  assert_eq!(download(&server, key).await, (200, plain));
}

#[tokio::test]
async fn a_rollback_unseals_everything_and_the_key_can_go() {
  let bucket = fresh_bucket("unseal").await;
  let key_sealed = "profiles/p/files/sealed";
  let key_parts = "profiles/p/files/parts";
  let small = sample(70_000);
  let large = sample(PART + 99);

  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(K1))]).await;
  upload(&server, key_sealed, small.clone(), Some("3")).await;
  let (url, _) = presign_transfer(&server, key_parts).await;
  let started: Value = start_parts(&url, large.len()).await.json().await.unwrap();
  let upload_token = started["upload"].as_str().unwrap().to_string();
  let mut etags = Vec::new();
  for (i, chunk) in large.chunks(PART).enumerate() {
    let response = http()
      .put(part_url(&url, &upload_token, i + 1))
      .header("Content-Length", chunk.len().to_string())
      .body(chunk.to_vec())
      .send_to_storage()
      .await;
    etags.push(response.headers()["etag"].to_str().unwrap().to_string());
  }
  let done = http()
    .post(format!("{url}&upload={upload_token}&op=complete"))
    .json(&json!({ "parts": etags }))
    .send_to_storage()
    .await;
  assert_eq!(done.status(), 200);
  let (_, before) = call(&server, "stat", json!({ "key": key_sealed })).await;
  drop(server);

  // Unsealing state: sealed objects read, new writes stay plaintext.
  let unsealing = format!("unseal,{K1}");
  let server = Server::start(&bucket, &[("SYNC_AT_REST_KEY", Some(&unsealing))]).await;
  assert!(
    server.logs().contains("Encryption at rest unsealing"),
    "{}",
    server.logs()
  );
  assert_eq!(download(&server, key_parts).await, (200, large.clone()));
  upload(&server, "profiles/p/files/new", b"new".to_vec(), None).await;
  let raw = raw_store(&bucket);
  let new_head = raw.head_object("profiles/p/files/new").await.unwrap();
  assert_eq!(new_head.metadata_value("donut-at-rest"), None);
  assert_eq!(
    collect(raw.get_object("profiles/p/files/new").await.unwrap().body)
      .await
      .unwrap(),
    b"new"
  );

  let storage = storage_env(&bucket);
  let mut env: Vec<(&str, &str)> = storage.iter().map(|(k, v)| (*k, v.as_str())).collect();
  env.push(("SYNC_AT_REST_KEY", K1));
  let (code, out) = run_command(&["migrate-at-rest", "--unseal"], &env);
  assert_eq!(code, 1, "--unseal refuses a sealing keyring: {out}");
  env.retain(|(k, _)| *k != "SYNC_AT_REST_KEY");
  env.push(("SYNC_AT_REST_KEY", &unsealing));
  let (code, out) = run_command(&["verify-at-rest"], &env);
  assert_eq!(code, 1, "{out}");
  let (code, out) = run_command(&["migrate-at-rest", "--unseal", "--concurrency", "3"], &env);
  assert_eq!(code, 0, "{out}");
  assert!(out.contains("unsealed=2"), "{out}");
  let (code, out) = run_command(&["verify-at-rest"], &env);
  assert_eq!(code, 0, "{out}");
  assert!(out.contains("complete=true"), "{out}");
  drop(server);

  // The key is gone: plaintext everywhere, the times from before.
  let server = Server::start(&bucket, &[]).await;
  for (key, body) in [(key_sealed, small), (key_parts, large)] {
    let (status, presign) = call(&server, "presign-download", json!({ "key": key })).await;
    assert_eq!(status, 200);
    let got = http()
      .get(presign["url"].as_str().unwrap())
      .send_to_storage()
      .await
      .bytes()
      .await
      .unwrap();
    assert_eq!(got.to_vec(), body, "{key}");
  }
  let (_, after) = call(&server, "stat", json!({ "key": key_sealed })).await;
  // To the second: a HEAD has seconds, the listing the migration kept has
  // milliseconds.
  let second = |v: &Value| v["lastModified"].as_str().unwrap()[..19].to_string();
  assert_eq!(second(&after), second(&before));
  assert_eq!(after["metadata"]["updated-at"], "3");
  assert!(after["metadata"].get("donut-at-rest").is_none());
}

/// What settling a rewrite relies on, checked against the store the suite
/// runs on: version ids on HEAD, copy and delete, versions listed newest
/// first, copies of a given version, and a copy conditional on the source.
#[tokio::test]
async fn the_store_keeps_what_a_settle_needs() {
  use donut_sync::store::{CopySpec, StoreError, versions_of};
  let bucket = fresh_bucket("capabilities").await;
  let raw = raw_store(&bucket);
  raw.create_bucket().await.ok();
  raw
    .put_object("k", b"one".to_vec(), "text/plain", &[])
    .await
    .unwrap();
  let first = raw.head_object("k").await.unwrap();
  raw
    .put_object("k", b"two".to_vec(), "text/plain", &[])
    .await
    .unwrap();
  let second = raw.head_object("k").await.unwrap();

  // A copy that names a source ETag the source no longer has.
  let stale = raw
    .copy_object_with(
      "k",
      "copy",
      CopySpec {
        if_match: first.etag.as_deref(),
        ..CopySpec::default()
      },
    )
    .await;
  let honored = matches!(stale, Err(StoreError::Service { status: 412, .. }));
  println!("copy_source_if_match_honored={honored}");

  let Some(history) = versions_of(&raw, "k").await.unwrap() else {
    println!("versions=unsupported");
    return;
  };
  println!("versions=supported");
  assert!(
    honored,
    "a store that keeps versions must honor a conditional copy"
  );
  let (Some(v1), Some(v2)) = (first.version_id.clone(), second.version_id.clone()) else {
    panic!("HEAD gave no version id: {first:?} {second:?}");
  };
  let ids: Vec<&str> = history.iter().map(|v| v.version_id.as_str()).collect();
  assert_eq!(ids, [v2.as_str(), v1.as_str()], "newest first");
  assert!(history[0].is_latest && !history[1].is_latest);

  let copied = raw
    .copy_object_with(
      "k",
      "k",
      CopySpec {
        source_version: Some(&v1),
        ..CopySpec::default()
      },
    )
    .await
    .unwrap();
  let restored = copied.version_id.expect("a copy names its new version");
  assert_eq!(
    collect(raw.get_object("k").await.unwrap().body)
      .await
      .unwrap(),
    b"one"
  );
  let marker = raw
    .delete_object("k")
    .await
    .unwrap()
    .expect("a delete names its marker");
  let history = versions_of(&raw, "k").await.unwrap().unwrap();
  assert_eq!(history[0].version_id, marker);
  assert!(history[0].delete_marker);
  assert_eq!(history[1].version_id, restored);
  donut_sync::migrate::purge(&raw, "k").await.unwrap();
  assert!(versions_of(&raw, "k").await.unwrap().unwrap().is_empty());
}
