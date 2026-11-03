//! Profile leases end to end: two devices, expiry, renew, release, take over,
//! sealing, and an app that never calls these routes.

mod common;

use common::{SYNC_TOKEN, Server, bucket, http, post, raw_store};
use donut_sync::store::Store;
use serde_json::{Value, json};

const ROOT: &str = "profiles/p1/";
const LEASE_KEY: &str = ".donut-sync-at-rest/locks/profiles/p1/lease.json";

async fn call(server: &Server, route: &str, body: Value) -> (u16, Value) {
  post(
    &http(),
    &format!("{}/v1/locks/{route}", server.url),
    Some(SYNC_TOKEN),
    body,
  )
  .await
}

fn acquire(device: &str, force: bool) -> Value {
  json!({ "profileRoot": ROOT, "deviceId": device, "deviceName": device, "ttlSeconds": 90, "force": force })
}

#[tokio::test]
async fn two_devices_take_turns() {
  let server = Server::start(&bucket("leases"), &[]).await;
  let (status, a) = call(&server, "acquire", acquire("dev-a", false)).await;
  assert_eq!(status, 200, "{a}");

  let (status, refused) = call(&server, "acquire", acquire("dev-b", false)).await;
  assert_eq!(status, 409);
  assert_eq!(refused["code"], "PROFILE_LEASE_HELD");
  assert_eq!(refused["holder"]["deviceName"], "dev-a");
  assert!(refused["expiresAt"].is_string());

  let (status, body) = call(
    &server,
    "renew",
    json!({ "profileRoot": ROOT, "token": "nope" }),
  )
  .await;
  assert_eq!(
    (status, body["code"].clone()),
    (409, json!("PROFILE_LEASE_LOST"))
  );
  let (status, _) = call(
    &server,
    "renew",
    json!({ "profileRoot": ROOT, "token": a["token"] }),
  )
  .await;
  assert_eq!(status, 200);

  let (status, held) = call(&server, "status", json!({ "profileRoot": ROOT })).await;
  assert_eq!((status, held["held"].clone()), (200, json!(true)));

  let (status, body) = call(
    &server,
    "release",
    json!({ "profileRoot": ROOT, "token": a["token"] }),
  )
  .await;
  assert_eq!((status, body), (200, json!({ "released": true })));
  let (status, b) = call(&server, "acquire", acquire("dev-b", false)).await;
  assert_eq!(status, 200, "{b}");

  // One shared token is one account: dev-a may take it over.
  let (status, _) = call(&server, "acquire", acquire("dev-a", true)).await;
  assert_eq!(status, 200);
  let (status, lost) = call(
    &server,
    "renew",
    json!({ "profileRoot": ROOT, "token": b["token"] }),
  )
  .await;
  assert_eq!(status, 409);
  assert_eq!(lost["holder"]["deviceId"], "dev-a");
}

#[tokio::test]
async fn an_expired_lease_frees_the_profile() {
  let name = bucket("lease-expiry");
  let server = Server::start(&name, &[]).await;
  let expired = json!({
    "token": "t", "deviceId": "dev-a", "deviceName": "A", "sub": null,
    "acquiredAtMs": 1, "expiresAtMs": donut_sync::time::now_ms() - 1000,
  });
  raw_store(&name)
    .put_object(
      LEASE_KEY,
      expired.to_string().into_bytes(),
      "application/json",
      &[],
    )
    .await
    .unwrap();
  let (status, held) = call(&server, "status", json!({ "profileRoot": ROOT })).await;
  assert_eq!((status, held), (200, json!({ "held": false })));
  let (status, body) = call(&server, "acquire", acquire("dev-b", false)).await;
  assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn leases_are_sealed_and_hidden_and_old_apps_see_no_change() {
  let name = bucket("lease-sealed");
  let server = Server::start(
    &name,
    &[(
      "SYNC_AT_REST_KEY",
      Some("k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    )],
  )
  .await;
  let (status, _) = call(&server, "acquire", acquire("dev-a", false)).await;
  assert_eq!(status, 200);
  let raw = raw_store(&name).get_object_text(LEASE_KEY).await.unwrap();
  assert!(!raw.contains("dev-a"), "the lease is stored in plaintext");

  // An app that never takes a lease lists and syncs as before.
  let client = http();
  let (status, listed) = post(
    &client,
    &format!("{}/v1/objects/list", server.url),
    Some(SYNC_TOKEN),
    json!({ "prefix": "" }),
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(listed["objects"], json!([]));
  let (status, _) = post(
    &client,
    &format!("{}/v1/objects/presign-upload", server.url),
    Some(SYNC_TOKEN),
    json!({ "key": "profiles/p1/manifest.json" }),
  )
  .await;
  assert_eq!(status, 200);

  let (status, _) = post(
    &client,
    &format!("{}/v1/locks/acquire", server.url),
    None,
    acquire("x", false),
  )
  .await;
  assert_eq!(status, 401);
  let (status, _) = call(&server, "unknown", json!({})).await;
  assert_eq!(status, 404);
}
