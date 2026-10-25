use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use serde_json::json;

use super::*;
use crate::store::{ListObject, ListOutput};

const OWNER_PREFIX: &str = "users/99999999-8888-7777-6666-555555555555/";

type HeadHook = Box<dyn Fn(&str) -> Result<HeadOutput, StoreError> + Send + Sync>;
type ListHook = Box<dyn Fn(&ListInput) -> ListOutput + Send + Sync>;

#[derive(Clone)]
struct Object {
  body: Vec<u8>,
  metadata: Vec<(String, String)>,
}

/// A bucket in memory. Hooks stand in for HEAD and LIST where a test needs
/// answers the bucket itself would not give.
#[derive(Default)]
struct MemoryStore {
  objects: Mutex<BTreeMap<String, Object>>,
  calls: AtomicUsize,
  head_hook: Option<HeadHook>,
  list_hook: Option<ListHook>,
}

impl MemoryStore {
  fn call(&self) {
    self.calls.fetch_add(1, Ordering::SeqCst);
  }

  fn set(&self, key: &str, body: &str) {
    self.objects.lock().unwrap().insert(
      key.to_string(),
      Object {
        body: body.as_bytes().to_vec(),
        metadata: Vec::new(),
      },
    );
  }

  fn get(&self, key: &str) -> Option<String> {
    self
      .objects
      .lock()
      .unwrap()
      .get(key)
      .map(|o| String::from_utf8_lossy(&o.body).into_owned())
  }

  fn keys(&self) -> Vec<String> {
    self.objects.lock().unwrap().keys().cloned().collect()
  }
}

#[async_trait]
impl Store for MemoryStore {
  async fn head_bucket(&self) -> Result<(), StoreError> {
    self.call();
    Ok(())
  }

  async fn create_bucket(&self) -> Result<(), StoreError> {
    self.call();
    Ok(())
  }

  async fn head_object(&self, key: &str) -> Result<HeadOutput, StoreError> {
    self.call();
    if let Some(hook) = &self.head_hook {
      return hook(key);
    }
    let objects = self.objects.lock().unwrap();
    let object = objects.get(key).ok_or(StoreError::NotFound)?;
    Ok(HeadOutput {
      last_modified_ms: Some(0),
      content_length: Some(object.body.len() as u64),
      metadata: object.metadata.clone(),
      etag: Some(format!("\"{}\"", object.body.len())),
    })
  }

  async fn get_object_text(&self, key: &str) -> Result<String, StoreError> {
    self.call();
    self.get(key).ok_or(StoreError::NotFound)
  }

  async fn put_object(
    &self,
    key: &str,
    body: Vec<u8>,
    _content_type: &str,
  ) -> Result<(), StoreError> {
    self.call();
    self.objects.lock().unwrap().insert(
      key.to_string(),
      Object {
        body,
        metadata: Vec::new(),
      },
    );
    Ok(())
  }

  async fn delete_object(&self, key: &str) -> Result<(), StoreError> {
    self.call();
    self.objects.lock().unwrap().remove(key);
    Ok(())
  }

  async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
    self.call();
    let mut objects = self.objects.lock().unwrap();
    for key in keys {
      objects.remove(key);
    }
    Ok(())
  }

  async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError> {
    self.call();
    let mut objects = self.objects.lock().unwrap();
    let object = objects.get(from).cloned().ok_or(StoreError::NotFound)?;
    objects.insert(to.to_string(), object);
    Ok(())
  }

  async fn list_objects_v2(&self, input: &ListInput) -> Result<ListOutput, StoreError> {
    self.call();
    if let Some(hook) = &self.list_hook {
      return Ok(hook(input));
    }
    let prefix = input.prefix.clone().unwrap_or_default();
    let objects = self.objects.lock().unwrap();
    let mut out = ListOutput::default();
    for (key, object) in objects.range(prefix.clone()..) {
      if !key.starts_with(&prefix) {
        break;
      }
      if let Some(delimiter) = &input.delimiter
        && let Some(at) = key[prefix.len()..].find(delimiter.as_str())
      {
        let common = key[..prefix.len() + at + delimiter.len()].to_string();
        if !out.common_prefixes.contains(&common) {
          out.common_prefixes.push(common);
        }
        continue;
      }
      out.contents.push(ListObject {
        key: key.clone(),
        last_modified_ms: Some(0),
        size: Some(object.body.len() as u64),
      });
    }
    Ok(out)
  }
}

fn service_with(store: Arc<MemoryStore>) -> SyncService {
  let location = crate::s3::Location::parse("http://s3.invalid:9000", "test-bucket", true).unwrap();
  let presigner = Presigner::new(
    location,
    crate::sigv4::Credentials {
      access_key_id: "test-access".to_string(),
      secret_access_key: "test-secret".to_string(),
    },
    "us-east-1".to_string(),
  );
  SyncService::new(
    store,
    SyncOptions {
      presigner,
      public_endpoint: "http://s3.invalid:9000".to_string(),
      public_endpoint_configured: false,
      cloud: true,
      backend: None,
    },
  )
}

fn body(value: Value) -> Body {
  Body(Some(value))
}

fn team_context(role: TeamRole) -> UserContext {
  UserContext {
    mode: Mode::Cloud,
    prefix: OWNER_PREFIX.to_string(),
    profile_limit: 0.0,
    sub: None,
    team_role: Some(role),
    group_ids: None,
  }
}

fn refusal_code(result: Result<Value, ApiError>) -> String {
  let error = result.expect_err("the request was not refused");
  assert_eq!(error.status(), 403, "{}", error.describe());
  error.code().unwrap_or_default()
}

// --- team roles --------------------------------------------------------------

#[tokio::test]
async fn a_launcher_syncs_what_a_session_changed() {
  let service = service_with(Arc::new(MemoryStore::default()));
  let launcher = team_context(TeamRole::Launcher);
  for key in [
    "profiles/p1/files/Default/Cookies",
    "profiles/p1/manifest.json",
    "teams/t1/profiles/p1/files/Default/Cookies",
    "teams/t1/profiles/p1/manifest.json",
  ] {
    let out = service
      .presign_upload(&body(json!({ "key": key })), &launcher)
      .await
      .unwrap();
    assert!(out["url"].is_string());
  }
  let out = service
    .presign_upload_batch(
      &body(json!({ "items": [{ "key": "profiles/p1/files/Default/Preferences" }] })),
      &launcher,
    )
    .await
    .unwrap();
  assert!(out["items"].is_array());
  let out = service
    .delete(
      &body(json!({ "key": "profiles/p1/files/Default/old.log" })),
      &launcher,
    )
    .await
    .unwrap();
  assert_eq!(out["deleted"], json!(true));
}

#[tokio::test]
async fn every_other_launcher_write_is_refused_before_it_reaches_s3() {
  let store = Arc::new(MemoryStore::default());
  let service = service_with(store.clone());
  let launcher = team_context(TeamRole::Launcher);
  for key in [
    "profiles/p1/metadata.json",
    "proxies/x.json",
    "groups/g.json",
    "teams/t1/profiles/p1/metadata.json",
    "teams/t1/tombstones/profiles/p1.json",
    "teams/t1/x/profiles/p1/manifest.json",
    "profiles/p1/files",
    "profiles/p1/files/",
  ] {
    assert_eq!(
      refusal_code(
        service
          .presign_upload(&body(json!({ "key": key })), &launcher)
          .await
      ),
      "TEAM_ROLE_READ_ONLY",
      "{key}"
    );
  }
  assert_eq!(
    refusal_code(
      service
        .presign_upload_batch(
          &body(json!({ "items": [
            { "key": "profiles/p1/manifest.json" },
            { "key": "profiles/p1/metadata.json" },
          ] })),
          &launcher,
        )
        .await
    ),
    "TEAM_ROLE_READ_ONLY"
  );
  assert_eq!(
    refusal_code(
      service
        .delete(
          &body(json!({
            "key": "profiles/p1/files/Default/Cookies",
            "tombstoneKey": "tombstones/profiles/p1.json",
          })),
          &launcher,
        )
        .await
    ),
    "TEAM_ROLE_READ_ONLY"
  );
  assert_eq!(
    refusal_code(
      service
        .delete_prefix(&body(json!({ "prefix": "profiles/p1/" })), &launcher)
        .await
    ),
    "TEAM_ROLE_READ_ONLY"
  );
  assert_eq!(store.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_member_changes_profile_settings_and_deletes_profiles() {
  let service = service_with(Arc::new(MemoryStore::default()));
  let member = team_context(TeamRole::Member);
  let out = service
    .presign_upload(
      &body(json!({ "key": "profiles/p1/metadata.json" })),
      &member,
    )
    .await
    .unwrap();
  assert!(out["url"].is_string());
  let out = service
    .delete_prefix(
      &body(json!({
        "prefix": "profiles/p1/",
        "tombstoneKey": "tombstones/profiles/p1.json",
      })),
      &member,
    )
    .await
    .unwrap();
  assert_eq!(out["deletedCount"], json!(0));
}

// --- access by group ---------------------------------------------------------

fn limited_store() -> Arc<MemoryStore> {
  let groups: BTreeMap<&str, Option<&str>> =
    [("p1", Some("g1")), ("p2", Some("g2")), ("p3", None)].into();
  Arc::new(MemoryStore {
    head_hook: Some(Box::new(move |key| {
      let id = key
        .strip_suffix("/metadata.json")
        .and_then(|rest| rest.rsplit('/').next())
        .filter(|_| key.contains("profiles/"));
      match id.and_then(|id| groups.get(id)) {
        None => Err(StoreError::NotFound),
        Some(group) => Ok(HeadOutput {
          metadata: group
            .map(|g| vec![("group-id".to_string(), g.to_string())])
            .unwrap_or_default(),
          ..Default::default()
        }),
      }
    })),
    list_hook: Some(Box::new(|_| ListOutput {
      contents: [
        "profiles/p1/manifest.json",
        "profiles/p2/manifest.json",
        "teams/t1/profiles/p1/files/Default/Cookies",
        "groups/g1.json",
        "groups/g2.json",
        "proxies/x.json",
      ]
      .iter()
      .map(|relative| ListObject {
        key: format!("{OWNER_PREFIX}{relative}"),
        last_modified_ms: None,
        size: None,
      })
      .collect(),
      ..Default::default()
    })),
    ..Default::default()
  })
}

fn limited() -> UserContext {
  UserContext {
    mode: Mode::Cloud,
    prefix: OWNER_PREFIX.to_string(),
    profile_limit: 0.0,
    sub: None,
    team_role: Some(TeamRole::Member),
    group_ids: Some(vec!["g1".to_string()]),
  }
}

#[tokio::test]
async fn a_limited_member_sees_only_the_profiles_and_groups_it_may_reach() {
  let service = service_with(limited_store());
  let ctx = limited();
  service
    .stat(&body(json!({ "key": "profiles/p1/manifest.json" })), &ctx)
    .await
    .unwrap();
  for key in [
    "profiles/p2/manifest.json",
    "profiles/p3/manifest.json",
    "groups/g2.json",
  ] {
    assert_eq!(
      refusal_code(service.stat(&body(json!({ "key": key })), &ctx).await),
      "TEAM_GROUP_ACCESS_DENIED",
      "{key}"
    );
  }
  let out = service
    .presign_download(&body(json!({ "key": "proxies/x.json" })), &ctx)
    .await
    .unwrap();
  assert!(out["url"].is_string());

  let listed = service
    .list(&body(json!({ "prefix": "" })), &ctx)
    .await
    .unwrap();
  let keys: Vec<&str> = listed["objects"]
    .as_array()
    .unwrap()
    .iter()
    .map(|o| o["key"].as_str().unwrap())
    .collect();
  assert_eq!(
    keys,
    vec![
      "profiles/p1/manifest.json",
      "teams/t1/profiles/p1/files/Default/Cookies",
      "groups/g1.json",
      "proxies/x.json",
    ]
  );
}

#[tokio::test]
async fn a_limited_member_changes_profiles_only_inside_its_groups() {
  let service = service_with(limited_store());
  let ctx = limited();
  service
    .presign_upload(
      &body(json!({ "key": "profiles/new/metadata.json", "metadata": { "group-id": "g1" } })),
      &ctx,
    )
    .await
    .unwrap();
  service
    .presign_upload(
      &body(json!({ "key": "profiles/p1/files/Default/Cookies" })),
      &ctx,
    )
    .await
    .unwrap();
  for request in [
    json!({ "key": "profiles/new/metadata.json", "metadata": { "group-id": "g2" } }),
    json!({ "key": "profiles/new/metadata.json" }),
    json!({ "key": "profiles/new/files/Default/Cookies" }),
    json!({ "key": "profiles/p1/metadata.json", "metadata": { "group-id": "g2" } }),
    json!({ "key": "profiles/p2/files/Default/Cookies" }),
    json!({ "key": "groups/g2.json" }),
  ] {
    assert_eq!(
      refusal_code(service.presign_upload(&body(request.clone()), &ctx).await),
      "TEAM_GROUP_ACCESS_DENIED",
      "{request}"
    );
  }
  assert_eq!(
    refusal_code(
      service
        .delete_prefix(&body(json!({ "prefix": "profiles/p2/" })), &ctx)
        .await
    ),
    "TEAM_GROUP_ACCESS_DENIED"
  );
}

#[tokio::test]
async fn a_member_without_a_limit_reaches_every_group() {
  let service = service_with(limited_store());
  let every_group = UserContext {
    group_ids: None,
    ..limited()
  };
  service
    .stat(
      &body(json!({ "key": "profiles/p2/manifest.json" })),
      &every_group,
    )
    .await
    .unwrap();
  let listed = service
    .list(&body(json!({ "prefix": "" })), &every_group)
    .await
    .unwrap();
  assert_eq!(listed["objects"].as_array().unwrap().len(), 6);
}

// --- restore points ----------------------------------------------------------

fn owner() -> UserContext {
  team_context(TeamRole::Owner)
}

fn live(relative: &str) -> String {
  format!("{OWNER_PREFIX}profiles/p1/{relative}")
}

#[tokio::test]
async fn a_restore_point_keeps_files_and_manifest_and_puts_them_back() {
  let store = Arc::new(MemoryStore::default());
  let service = service_with(store.clone());
  store.set(&live("manifest.json"), "manifest-1");
  store.set(&live("files/Default/Cookies"), "cookies-1");
  store.set(&live("metadata.json"), "settings");

  let point = service
    .create_snapshot(
      &body(json!({ "profileRoot": "profiles/p1/", "kind": "manual" })),
      &owner(),
    )
    .await
    .unwrap();
  assert_eq!(point["kind"], json!("manual"));
  assert_eq!(point["files"], json!(1));
  assert_eq!(
    store
      .keys()
      .iter()
      .filter(|key| key.contains("/snapshots/"))
      .count(),
    3
  );

  store.set(&live("files/Default/Cookies"), "cookies-2");
  store.set(&live("files/Default/New"), "new");
  let restored = service
    .restore_snapshot_files(
      &body(json!({ "profileRoot": "profiles/p1/", "id": point["id"] })),
      &owner(),
    )
    .await
    .unwrap();
  assert_eq!(restored, json!({ "restored": 1, "removed": 1 }));
  assert_eq!(
    store.get(&live("files/Default/Cookies")).as_deref(),
    Some("cookies-1")
  );
  assert_eq!(store.get(&live("files/Default/New")), None);
  assert_eq!(
    store.get(&live("metadata.json")).as_deref(),
    Some("settings")
  );

  let listed = service
    .list_snapshots(&body(json!({ "profileRoot": "profiles/p1/" })), &owner())
    .await
    .unwrap();
  let ids: Vec<&Value> = listed["snapshots"]
    .as_array()
    .unwrap()
    .iter()
    .map(|s| &s["id"])
    .collect();
  assert_eq!(ids, vec![&point["id"]]);
}

#[tokio::test]
async fn the_newest_few_of_each_kind_are_kept() {
  let store = Arc::new(MemoryStore::default());
  let service = service_with(store.clone());
  store.set(&live("manifest.json"), "m");
  for _ in 0..SNAPSHOTS_PER_KIND + 2 {
    service
      .create_snapshot(
        &body(json!({ "profileRoot": "profiles/p1/", "kind": "auto" })),
        &owner(),
      )
      .await
      .unwrap();
  }
  service
    .create_snapshot(
      &body(json!({ "profileRoot": "profiles/p1/", "kind": "manual" })),
      &owner(),
    )
    .await
    .unwrap();
  let listed = service
    .list_snapshots(&body(json!({ "profileRoot": "profiles/p1/" })), &owner())
    .await
    .unwrap();
  let kinds: Vec<&str> = listed["snapshots"]
    .as_array()
    .unwrap()
    .iter()
    .map(|s| s["kind"].as_str().unwrap())
    .collect();
  assert_eq!(
    kinds.iter().filter(|k| **k == "auto").count(),
    SNAPSHOTS_PER_KIND
  );
  assert_eq!(kinds.iter().filter(|k| **k == "manual").count(), 1);
}

#[tokio::test]
async fn a_launcher_and_a_root_that_is_not_one_profile_are_refused() {
  let store = Arc::new(MemoryStore::default());
  let service = service_with(store.clone());
  store.set(&live("manifest.json"), "m");
  assert_eq!(
    refusal_code(
      service
        .create_snapshot(
          &body(json!({ "profileRoot": "profiles/p1/" })),
          &team_context(TeamRole::Launcher),
        )
        .await
    ),
    "TEAM_ROLE_READ_ONLY"
  );
  for root in ["profiles/", "proxies/x/", "profiles/p1"] {
    let error = service
      .create_snapshot(&body(json!({ "profileRoot": root })), &owner())
      .await
      .expect_err(root);
    assert_eq!(error.code().as_deref(), Some("SNAPSHOT_INVALID"));
  }
}

// --- the profile limit -------------------------------------------------------

fn cloud_with_limit() -> UserContext {
  UserContext {
    mode: Mode::Cloud,
    prefix: OWNER_PREFIX.to_string(),
    profile_limit: 2.0,
    sub: Some("u1".to_string()),
    team_role: None,
    group_ids: None,
  }
}

fn with_stored_profiles(ids: &[&str]) -> SyncService {
  let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
  service_with(Arc::new(MemoryStore {
    list_hook: Some(Box::new(move |input| {
      if input.prefix.as_deref() == Some(&format!("{OWNER_PREFIX}profiles/")) {
        ListOutput {
          common_prefixes: ids
            .iter()
            .map(|id| format!("{OWNER_PREFIX}profiles/{id}/"))
            .collect(),
          ..Default::default()
        }
      } else {
        ListOutput::default()
      }
    })),
    ..Default::default()
  }))
}

#[tokio::test]
async fn a_full_plan_keeps_syncing_its_profiles_and_settings_but_adds_none() {
  let service = with_stored_profiles(&["p1", "p2"]);
  let ctx = cloud_with_limit();
  for key in [
    "profiles/p1/files/Default/Cookies",
    "profiles/p2/metadata.json",
    "proxies/x.json",
    "groups/g.json",
  ] {
    service
      .presign_upload(&body(json!({ "key": key })), &ctx)
      .await
      .unwrap();
  }
  let error = service
    .presign_upload(&body(json!({ "key": "profiles/p3/metadata.json" })), &ctx)
    .await
    .unwrap_err();
  assert_eq!(error.status(), 403);
  assert_eq!(
    error.body()["message"],
    json!("Profile limit reached (2). Upgrade your plan for more profiles.")
  );
  let error = service
    .presign_upload_batch(
      &body(
        json!({ "items": [{ "key": "profiles/p1/files/a" }, { "key": "profiles/p3/files/a" }] }),
      ),
      &ctx,
    )
    .await
    .unwrap_err();
  assert_eq!(error.status(), 403);
}

#[tokio::test]
async fn a_batch_counts_its_new_profiles_together() {
  let service = with_stored_profiles(&["p1"]);
  let ctx = cloud_with_limit();
  service
    .presign_upload_batch(
      &body(
        json!({ "items": [{ "key": "profiles/p2/files/a" }, { "key": "profiles/p2/files/b" }] }),
      ),
      &ctx,
    )
    .await
    .unwrap();
  let error = service
    .presign_upload_batch(
      &body(
        json!({ "items": [{ "key": "profiles/p2/files/a" }, { "key": "profiles/p3/files/a" }] }),
      ),
      &ctx,
    )
    .await
    .unwrap_err();
  assert_eq!(error.status(), 403);
}

#[tokio::test]
async fn the_profile_limit_applies_in_the_cloud_only() {
  let service = with_stored_profiles(&["p1", "p2", "p3"]);
  let ctx = cloud_with_limit();
  assert_eq!(
    service
      .presign_upload(&body(json!({ "key": "profiles/p1/files/a" })), &ctx)
      .await
      .unwrap_err()
      .status(),
    403
  );
  service
    .presign_upload(&body(json!({ "key": "proxies/x.json" })), &ctx)
    .await
    .unwrap();
  service
    .presign_upload(
      &body(json!({ "key": "profiles/p9/files/a" })),
      &UserContext::self_hosted(),
    )
    .await
    .unwrap();
  service
    .presign_upload(
      &body(json!({ "key": "profiles/p9/files/a" })),
      &UserContext {
        mode: Mode::Account,
        ..ctx
      },
    )
    .await
    .unwrap();
}

// --- request bodies the original read loosely ------------------------------

#[tokio::test]
async fn missing_fields_fail_as_they_did() {
  let store = Arc::new(MemoryStore::default());
  let service = service_with(store.clone());
  let self_hosted = UserContext::self_hosted();
  // No JSON body at all: a field read threw.
  assert_eq!(
    service
      .stat(&Body(None), &self_hosted)
      .await
      .unwrap_err()
      .status(),
    500
  );
  // A missing key is undefined: the SDK refused it.
  assert_eq!(
    service
      .stat(&body(json!({})), &self_hosted)
      .await
      .unwrap_err()
      .status(),
    500
  );
  // A delete of an undefined key just reports nothing deleted.
  assert_eq!(
    service
      .delete(&body(json!({})), &self_hosted)
      .await
      .unwrap(),
    json!({ "deleted": false, "tombstoneCreated": false })
  );
  // In a namespace, an undefined key is the text "undefined".
  let cloud = UserContext {
    mode: Mode::Account,
    ..team_context(TeamRole::Owner)
  };
  assert_eq!(
    service.stat(&body(json!({})), &cloud).await.unwrap(),
    json!({ "exists": false })
  );
}

#[tokio::test]
async fn presigned_uploads_echo_only_the_metadata_sync_uses() {
  let service = service_with(Arc::new(MemoryStore::default()));
  let out = service
    .presign_upload(
      &body(json!({
        "key": "vpns/m.json",
        "metadata": { "updated-at": "1700000000", "group-id": "bad/id", "other": "x" },
        "expiresIn": 999999,
      })),
      &UserContext::self_hosted(),
    )
    .await
    .unwrap();
  assert_eq!(out["metadata"], json!({ "updated-at": "1700000000" }));
  let url = out["url"].as_str().unwrap();
  assert!(url.starts_with("http://s3.invalid:9000/test-bucket/vpns/m.json?"));
  assert!(url.contains("X-Amz-Expires=3600&"));
  assert!(url.contains("X-Amz-SignedHeaders=host%3Bx-amz-meta-updated-at&"));
  assert!(url.ends_with("&x-id=PutObject"));
  assert!(!url.contains("checksum"));
}
