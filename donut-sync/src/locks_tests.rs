use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::auth::{Mode, TeamRole};
use crate::memory_store::MemoryStore;
use crate::s3::Presigner;
use crate::sync::SyncOptions;

const ROOT: &str = "profiles/p1/";
const T0: i64 = 1_800_000_000_000;

fn service(store: Arc<MemoryStore>) -> SyncService {
  let location = crate::s3::Location::parse("http://s3.invalid:9000", "b", true).unwrap();
  let presigner = Presigner::new(
    location,
    crate::sigv4::Credentials {
      access_key_id: "a".to_string(),
      secret_access_key: "s".to_string(),
    },
    "us-east-1".to_string(),
  );
  SyncService::new(
    store,
    SyncOptions {
      presigner,
      transfer: None,
      public_endpoint: "http://s3.invalid:9000".to_string(),
      public_endpoint_configured: false,
      cloud: true,
      backend: None,
    },
  )
}

fn user(sub: &str) -> UserContext {
  UserContext {
    mode: Mode::Cloud,
    prefix: "users/owner/".to_string(),
    profile_limit: 0.0,
    sub: Some(sub.to_string()),
    team_role: None,
    group_ids: None,
  }
}

fn acquire(device: &str, force: bool) -> Body {
  Body(Some(json!({
    "profileRoot": ROOT, "deviceId": device, "deviceName": format!("Laptop {device}"),
    "ttlSeconds": 120, "force": force,
  })))
}

fn with_token(token: &Value) -> Body {
  Body(Some(json!({ "profileRoot": ROOT, "token": token })))
}

fn status_of(result: Result<Value, ApiError>) -> (u16, Value) {
  match result {
    Ok(value) => (200, value),
    Err(e) => (e.status(), e.body()),
  }
}

#[tokio::test]
async fn one_device_at_a_time_and_the_same_device_again() {
  let store = Arc::new(MemoryStore::default());
  let sync = service(store.clone());
  let me = user("u1");
  let first = sync
    .acquire_lease_at(&acquire("dev-a", false), &me, T0)
    .await
    .unwrap();
  assert!(first["token"].is_string());
  assert!(
    store
      .get(&format!("{LEASE_ROOT}users/owner/{ROOT}lease.json"))
      .is_some()
  );

  let (status, body) = status_of(
    sync
      .acquire_lease_at(&acquire("dev-b", false), &me, T0 + 1000)
      .await,
  );
  assert_eq!(status, 409);
  assert_eq!(body["code"], "PROFILE_LEASE_HELD");
  assert_eq!(body["holder"]["deviceId"], "dev-a");
  assert_eq!(body["holder"]["deviceName"], "Laptop dev-a");
  assert_eq!(body["sameAccount"], true);

  // A crash and a restart on the same device: it gets the lease again.
  let again = sync
    .acquire_lease_at(&acquire("dev-a", false), &me, T0 + 2000)
    .await
    .unwrap();
  assert_ne!(again["token"], first["token"]);
}

#[tokio::test]
async fn an_expired_lease_is_free() {
  let sync = service(Arc::new(MemoryStore::default()));
  let me = user("u1");
  sync
    .acquire_lease_at(&acquire("dev-a", false), &me, T0)
    .await
    .unwrap();
  let later = T0 + 121_000;
  assert!(
    sync
      .acquire_lease_at(&acquire("dev-b", false), &me, later)
      .await
      .is_ok()
  );
}

#[tokio::test]
async fn renew_extends_only_for_the_holder() {
  let sync = service(Arc::new(MemoryStore::default()));
  let me = user("u1");
  let a = sync
    .acquire_lease_at(&acquire("dev-a", false), &me, T0)
    .await
    .unwrap();
  let renewed = sync
    .renew_lease_at(&with_token(&a["token"]), &me, T0 + 100_000)
    .await
    .unwrap();
  assert_eq!(renewed["token"], a["token"]);
  // Renewed at +100 s for 120 s: still held at +200 s.
  let (status, _) = status_of(
    sync
      .acquire_lease_at(&acquire("dev-b", false), &me, T0 + 200_000)
      .await,
  );
  assert_eq!(status, 409);

  let (status, body) = status_of(
    sync
      .renew_lease_at(&with_token(&json!("not-the-token")), &me, T0 + 200_000)
      .await,
  );
  assert_eq!(status, 409);
  assert_eq!(body["code"], "PROFILE_LEASE_LOST");
  assert_eq!(body["holder"]["deviceId"], "dev-a");

  // Ran out, nobody took it: the holder renews it.
  assert!(
    sync
      .renew_lease_at(&with_token(&a["token"]), &me, T0 + 400_000)
      .await
      .is_ok()
  );
}

#[tokio::test]
async fn release_frees_it_and_a_stale_token_changes_nothing() {
  let sync = service(Arc::new(MemoryStore::default()));
  let me = user("u1");
  let a = sync
    .acquire_lease_at(&acquire("dev-a", false), &me, T0)
    .await
    .unwrap();
  let out = sync
    .release_lease(&with_token(&json!("other")), &me)
    .await
    .unwrap();
  assert_eq!(out["released"], false);
  let out = sync
    .release_lease(&with_token(&a["token"]), &me)
    .await
    .unwrap();
  assert_eq!(out["released"], true);
  assert!(
    sync
      .acquire_lease_at(&acquire("dev-b", false), &me, T0 + 1000)
      .await
      .is_ok()
  );
  let (status, body) = status_of(
    sync
      .renew_lease_at(&with_token(&a["token"]), &me, T0 + 2000)
      .await,
  );
  assert_eq!(
    (status, body["code"].clone()),
    (409, json!("PROFILE_LEASE_LOST"))
  );
}

#[tokio::test]
async fn force_takes_over_only_within_the_same_account() {
  let sync = service(Arc::new(MemoryStore::default()));
  let a = sync
    .acquire_lease_at(&acquire("dev-a", false), &user("u1"), T0)
    .await
    .unwrap();

  // A teammate in the same namespace cannot take it.
  let (status, body) = status_of(
    sync
      .acquire_lease_at(&acquire("dev-b", true), &user("u2"), T0)
      .await,
  );
  assert_eq!(status, 409);
  assert_eq!(body["sameAccount"], false);

  let b = sync
    .acquire_lease_at(&acquire("dev-b", true), &user("u1"), T0)
    .await
    .unwrap();
  let (status, body) = status_of(
    sync
      .renew_lease_at(&with_token(&a["token"]), &user("u1"), T0)
      .await,
  );
  assert_eq!(status, 409);
  assert_eq!(body["holder"]["deviceId"], "dev-b");
  assert!(
    sync
      .renew_lease_at(&with_token(&b["token"]), &user("u1"), T0)
      .await
      .is_ok()
  );
}

#[tokio::test]
async fn a_launcher_locks_and_a_member_outside_the_group_does_not() {
  let store = Arc::new(MemoryStore::default());
  let sync = service(store.clone());
  let mut launcher = user("l1");
  launcher.team_role = Some(TeamRole::Launcher);
  assert!(
    sync
      .acquire_lease_at(&acquire("dev-l", false), &launcher, T0)
      .await
      .is_ok()
  );

  let mut limited = user("m1");
  limited.team_role = Some(TeamRole::Member);
  limited.group_ids = Some(vec!["g1".to_string()]);
  let (status, body) = status_of(
    sync
      .acquire_lease_at(&acquire("dev-m", false), &limited, T0)
      .await,
  );
  assert_eq!(status, 403);
  assert_eq!(body["code"], "TEAM_GROUP_ACCESS_DENIED");
}

#[tokio::test]
async fn bad_input_is_refused_and_leases_stay_out_of_listings() {
  let store = Arc::new(MemoryStore::default());
  let sync = service(store.clone());
  let me = UserContext::self_hosted();
  for bad in [
    json!({ "profileRoot": "profiles/p1", "deviceId": "d" }),
    json!({ "profileRoot": "../x/", "deviceId": "d" }),
    json!({ "profileRoot": ROOT }),
    json!({ "profileRoot": ROOT, "deviceId": "a/b" }),
    json!({ "profileRoot": ROOT, "deviceId": "d", "ttlSeconds": -1 }),
  ] {
    let (status, body) = status_of(sync.acquire_lease_at(&Body(Some(bad)), &me, T0).await);
    assert_eq!((status, body), (400, json!({ "code": "LEASE_INVALID" })));
  }
  sync
    .acquire_lease_at(&acquire("dev-a", false), &me, T0)
    .await
    .unwrap();
  let listed = sync
    .list(&Body(Some(json!({ "prefix": "" }))), &me)
    .await
    .unwrap();
  assert_eq!(listed["objects"], json!([]));
  let status = sync
    .lease_status(&Body(Some(json!({ "profileRoot": ROOT }))), &me)
    .await
    .unwrap();
  assert_eq!(status["held"], true);
}

#[test]
fn ttl_is_bounded() {
  let ttl = |v: Value| ttl_ms(&Body(Some(json!({ "ttlSeconds": v })))).unwrap();
  assert_eq!(ttl(json!(5)), 90_000);
  assert_eq!(ttl(json!(100_000)), 300_000);
  assert_eq!(ttl(Value::Null), 120_000);
  assert_eq!(ttl_ms(&Body(Some(json!({})))).unwrap(), 120_000);
}
