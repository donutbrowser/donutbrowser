//! Donut's own deployment: RS256 sync tokens, team scope from the backend,
//! the plan's profile limit, and the backend's cleanup.

mod common;

use base64::Engine;
use common::{Mock, Server, bucket, http, post};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::{Value, json};

const PRIVATE_KEY: &str = include_str!("fixtures/test-jwt-private.pem");
const PUBLIC_KEY: &str = include_str!("fixtures/test-jwt-public.pem");
const INTERNAL_KEY: &str = "test-internal-key";

fn now() -> i64 {
  donut_sync::time::now_ms() / 1000
}

fn sign(claims: Value) -> String {
  let b64 = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
  let input = format!(
    "{}.{}",
    b64(json!({ "alg": "RS256", "typ": "JWT" })),
    b64(claims)
  );
  let der = donut_sync::jwt::pem_decode(PRIVATE_KEY).unwrap().1;
  let pair = RsaKeyPair::from_pkcs8(&der).unwrap();
  let mut signature = vec![0; pair.public().modulus_len()];
  pair
    .sign(
      &RSA_PKCS1_SHA256,
      &SystemRandom::new(),
      input.as_bytes(),
      &mut signature,
    )
    .unwrap();
  format!(
    "{input}.{}",
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature)
  )
}

fn sync_token(sub: &str, limit: u32) -> String {
  sign(json!({
    "sub": sub, "prefix": format!("users/{sub}/"), "profileLimit": limit,
    "scope": "sync", "exp": now() + 300,
  }))
}

async fn start(run: &str) -> (Server, Mock) {
  let owner = format!("owner-{run}");
  let backend = Mock::start(move |path, body| match path {
    "/api/auth/internal/team-scope" => match body["userId"].as_str() {
      Some(user) if user.starts_with("launcher") => (
        200,
        json!({ "ownerId": owner, "teamId": "t1", "teamProfileLimit": 0, "role": "launcher" }).to_string(),
      ),
      Some(user) if user.starts_with("limited") => (
        200,
        json!({ "ownerId": owner, "teamId": "t1", "teamProfileLimit": 0, "role": "member", "groupIds": ["g1"] })
          .to_string(),
      ),
      Some(user) if user.starts_with("broken") => (500, "boom".to_string()),
      _ => (200, String::new()),
    },
    _ => (200, "{}".to_string()),
  })
  .await;
  // The key with escaped newlines, as a deployment's env var holds it.
  let escaped = PUBLIC_KEY.replace('\n', "\\n");
  let server = Server::start(
    &bucket("cloud"),
    &[
      ("SYNC_TOKEN", None),
      ("SYNC_JWT_PUBLIC_KEY", Some(&escaped)),
      ("BACKEND_INTERNAL_URL", Some(&backend.url)),
      ("BACKEND_INTERNAL_KEY", Some("backend-key")),
      ("INTERNAL_KEY", Some(INTERNAL_KEY)),
    ],
  )
  .await;
  (server, backend)
}

async fn put(
  client: &reqwest::Client,
  server: &Server,
  token: &str,
  key: &str,
  metadata: Value,
) -> (u16, Value) {
  let (status, out) = post(
    client,
    &format!("{}/v1/objects/presign-upload", server.url),
    Some(token),
    json!({ "key": key, "contentType": "application/json", "metadata": metadata }),
  )
  .await;
  if status == 200 {
    let mut request = client
      .put(out["url"].as_str().unwrap())
      .header("content-type", "application/json")
      .body("{}");
    for (name, value) in out["metadata"].as_object().into_iter().flatten() {
      request = request.header(format!("x-amz-meta-{name}"), value.as_str().unwrap());
    }
    let stored = request.send().await.unwrap();
    let status = stored.status();
    assert!(
      status.is_success(),
      "PUT {key}: {status} {}",
      stored.text().await.unwrap()
    );
  }
  (status, out)
}

#[tokio::test]
async fn sync_tokens_scope_requests_and_apply_the_plan() {
  let run = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
  let (server, backend) = start(&run).await;
  let client = http();
  let user = format!("solo-{run}");
  let token = sync_token(&user, 2);

  let ready: Value = client
    .get(format!("{}/readyz", server.url))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
  assert_eq!(ready, json!({ "status": "ready", "s3": true }));

  // Refused tokens: wrong scope, expired, not yet valid, over-broad prefix.
  for refused in [
    sign(json!({ "sub": user, "scope": "agent", "exp": now() + 300 })),
    sign(json!({ "sub": user, "scope": "sync", "exp": now() - 10 })),
    sign(json!({ "sub": user, "scope": "sync", "nbf": now() + 100 })),
    sign(json!({ "sub": user, "scope": "sync", "prefix": "users/" })),
  ] {
    let (status, body) = post(
      &client,
      &format!("{}/v1/objects/stat", server.url),
      Some(&refused),
      json!({ "key": "k" }),
    )
    .await;
    assert_eq!(status, 401, "{body}");
  }

  assert_eq!(
    put(
      &client,
      &server,
      &token,
      "profiles/p1/metadata.json",
      json!(null)
    )
    .await
    .0,
    200
  );
  assert_eq!(
    put(
      &client,
      &server,
      &token,
      "profiles/p2/metadata.json",
      json!(null)
    )
    .await
    .0,
    200
  );
  let (status, body) = put(
    &client,
    &server,
    &token,
    "profiles/p3/metadata.json",
    json!(null),
  )
  .await;
  assert_eq!(status, 403);
  assert_eq!(
    body,
    json!({
      "message": "Profile limit reached (2). Upgrade your plan for more profiles.",
      "error": "Forbidden",
      "statusCode": 403,
    })
  );
  // Stored profiles and settings keep syncing at the limit.
  assert_eq!(
    put(
      &client,
      &server,
      &token,
      "profiles/p1/files/Default/Cookies",
      json!(null)
    )
    .await
    .0,
    200
  );
  assert_eq!(
    put(&client, &server, &token, "proxies/x.json", json!(null))
      .await
      .0,
    200
  );

  let (_, list) = post(
    &client,
    &format!("{}/v1/objects/list", server.url),
    Some(&token),
    json!({ "prefix": "profiles/" }),
  )
  .await;
  assert_eq!(list["objects"].as_array().unwrap().len(), 3);
  assert!(
    list["objects"][0]["key"]
      .as_str()
      .unwrap()
      .starts_with("profiles/")
  );

  // A team-scope failure falls back to the user's own namespace.
  let broken = sync_token(&format!("broken-{run}"), 0);
  let (status, _) = post(
    &client,
    &format!("{}/v1/objects/list", server.url),
    Some(&broken),
    json!({ "prefix": "" }),
  )
  .await;
  assert_eq!(status, 200);

  tokio::time::sleep(std::time::Duration::from_millis(500)).await;
  let reports = backend.calls_to("/api/auth/internal/profile-usage");
  assert!(!reports.is_empty());
  assert!(reports.iter().all(|r| r["userId"] == user));
}

#[tokio::test]
async fn team_roles_and_groups_guard_the_owner_namespace() {
  let run = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
  let (server, _backend) = start(&run).await;
  let client = http();
  let owner = sync_token(&format!("owner-{run}"), 0);
  put(
    &client,
    &server,
    &owner,
    "profiles/p1/metadata.json",
    json!({ "group-id": "g1" }),
  )
  .await;
  put(
    &client,
    &server,
    &owner,
    "profiles/p1/manifest.json",
    json!(null),
  )
  .await;
  put(
    &client,
    &server,
    &owner,
    "profiles/p2/metadata.json",
    json!({ "group-id": "g2" }),
  )
  .await;
  put(
    &client,
    &server,
    &owner,
    "profiles/p2/manifest.json",
    json!(null),
  )
  .await;
  put(&client, &server, &owner, "groups/g2.json", json!(null)).await;

  let launcher = sync_token(&format!("launcher-{run}"), 0);
  assert_eq!(
    put(
      &client,
      &server,
      &launcher,
      "profiles/p1/files/Default/Cookies",
      json!(null)
    )
    .await
    .0,
    200
  );
  let (status, body) = put(
    &client,
    &server,
    &launcher,
    "profiles/p1/metadata.json",
    json!(null),
  )
  .await;
  assert_eq!(status, 403);
  assert_eq!(
    body,
    json!({ "code": "TEAM_ROLE_READ_ONLY", "message": "This team role can run profiles but not change them" })
  );

  let limited = sync_token(&format!("limited-{run}"), 0);
  let (_, list) = post(
    &client,
    &format!("{}/v1/objects/list", server.url),
    Some(&limited),
    json!({ "prefix": "" }),
  )
  .await;
  let keys: Vec<&str> = list["objects"]
    .as_array()
    .unwrap()
    .iter()
    .map(|o| o["key"].as_str().unwrap())
    .collect();
  assert!(keys.contains(&"profiles/p1/manifest.json"));
  assert!(!keys.iter().any(|k| k.starts_with("profiles/p2/")));
  assert!(!keys.contains(&"groups/g2.json"));
  let (status, body) = post(
    &client,
    &format!("{}/v1/objects/stat", server.url),
    Some(&limited),
    json!({ "key": "profiles/p2/manifest.json" }),
  )
  .await;
  assert_eq!(status, 403);
  assert_eq!(body["code"], "TEAM_GROUP_ACCESS_DENIED");
}

#[tokio::test]
async fn the_backend_trims_an_account_to_its_plan() {
  let run = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
  let (server, backend) = start(&run).await;
  let client = http();
  let user = format!("trim-{run}");
  let token = sync_token(&user, 0);
  for id in ["p1", "p2", "p3"] {
    put(
      &client,
      &server,
      &token,
      &format!("profiles/{id}/metadata.json"),
      json!(null),
    )
    .await;
  }
  let cleanup = format!("{}/v1/internal/cleanup-excess-profiles", server.url);
  let refused = client
    .post(&cleanup)
    .json(&json!({ "userId": user, "maxProfiles": 1 }))
    .send()
    .await
    .unwrap();
  assert_eq!(refused.status(), 401);
  for (body, message) in [
    (
      json!({ "userId": "a/b", "maxProfiles": 1 }),
      "Invalid userId",
    ),
    (
      json!({ "userId": user, "maxProfiles": 1.5 }),
      "Invalid maxProfiles",
    ),
  ] {
    let response = client
      .post(&cleanup)
      .header("x-internal-key", INTERNAL_KEY)
      .json(&body)
      .send()
      .await
      .unwrap();
    assert_eq!(response.status(), 400);
    assert_eq!(response.json::<Value>().await.unwrap()["message"], message);
  }
  let trimmed: Value = client
    .post(&cleanup)
    .header("x-internal-key", INTERNAL_KEY)
    .json(&json!({ "userId": user, "maxProfiles": 1 }))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
  assert_eq!(trimmed["remaining"], 1);
  assert_eq!(trimmed["deletedProfiles"].as_array().unwrap().len(), 2);
  let (_, list) = post(
    &client,
    &format!("{}/v1/objects/list", server.url),
    Some(&token),
    json!({ "prefix": "" }),
  )
  .await;
  let tombstones = list["objects"]
    .as_array()
    .unwrap()
    .iter()
    .filter(|o| {
      o["key"]
        .as_str()
        .unwrap()
        .starts_with("tombstones/profiles/")
    })
    .count();
  assert_eq!(tombstones, 2);
  let report = backend.calls_to("/api/auth/internal/profile-usage");
  assert!(report.contains(&json!({ "userId": user, "count": 1 })));
}
