//! Donut accounts on a server the customer runs: the Donut API (a stand-in
//! here) says whose a token is, and this server applies the namespace and the
//! team scope against real storage.

mod common;

use base64::Engine;
use common::{Mock, SYNC_TOKEN, Server, bucket, http, post};
use serde_json::{Value, json};

const PUBLIC_URL: &str = "https://sync.example.test";

/// Shaped like the Donut API's tokens for this server. The stand-in API
/// vouches for them by name; this server never sees a signing key.
fn token_for(name: &str) -> String {
  let b64 = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
  let exp = donut_sync::time::now_ms() / 1000 + 300;
  format!(
    "{}.{}.c2lnbmF0dXJl",
    b64(json!({ "alg": "HS256", "typ": "JWT" })),
    b64(json!({ "sub": name, "scope": "server-sync", "aud": PUBLIC_URL, "exp": exp }))
  )
}

fn name_of(token: &str) -> String {
  let payload = token.split('.').nth(1).unwrap();
  let claims: Value = serde_json::from_slice(
    &base64::engine::general_purpose::URL_SAFE_NO_PAD
      .decode(payload)
      .unwrap(),
  )
  .unwrap();
  claims["sub"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn accounts_get_their_own_space_and_teams_their_owners() {
  let run = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
  let owner = format!("owner-{run}");
  let other = format!("other-{run}");
  let member = format!("member-{run}");
  let (owner_id, other_id, member_id) = (owner.clone(), other.clone(), member.clone());
  let api = Mock::start(move |_, question| {
    let name = name_of(question["token"].as_str().unwrap_or("a.e30.c"));
    let answer = match name.as_str() {
      "owner" => json!({ "active": true, "sub": owner_id, "profileLimit": 1, "team": null }),
      "other" => json!({ "active": true, "sub": other_id, "profileLimit": 5, "team": null }),
      "member" => json!({
        "active": true, "sub": member_id, "profileLimit": 0,
        "team": { "ownerId": owner_id, "teamId": "team-1", "teamProfileLimit": 1, "role": "member", "groupIds": null }
      }),
      "down" => return (502, "down".to_string()),
      _ => json!({ "active": false }),
    };
    (200, answer.to_string())
  })
  .await;
  let server = Server::start(
    &bucket("accounts"),
    &[
      ("SYNC_PUBLIC_URL", Some(&format!("{PUBLIC_URL}/"))),
      ("DONUT_API_URL", Some(&api.url)),
    ],
  )
  .await;
  let client = http();

  let ready: Value = client
    .get(format!("{}/readyz", server.url))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
  assert_eq!(ready["accountUrl"], PUBLIC_URL);

  let upload = |token: String, key: &'static str| {
    let client = client.clone();
    let url = format!("{}/v1/objects/presign-upload", server.url);
    async move {
      post(
        &client,
        &url,
        Some(&token),
        json!({ "key": key, "contentType": "application/json" }),
      )
      .await
    }
  };
  let listed = |token: String| {
    let client = client.clone();
    let url = format!("{}/v1/objects/list", server.url);
    async move {
      let (_, body) = post(
        &client,
        &url,
        Some(&token),
        json!({ "prefix": "profiles/" }),
      )
      .await;
      body["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["key"].as_str().unwrap().to_string())
        .collect::<Vec<_>>()
    }
  };

  let owner_token = token_for("owner");
  let (status, out) = upload(owner_token.clone(), "profiles/p1/metadata.json").await;
  assert_eq!(status, 200);
  assert!(
    out["url"]
      .as_str()
      .unwrap()
      .contains(&format!("/users/{owner}/profiles/p1/metadata.json"))
  );
  let stored = client
    .put(out["url"].as_str().unwrap())
    .header("content-type", "application/json")
    .body("{}")
    .send()
    .await
    .unwrap();
  assert!(stored.status().is_success());

  assert!(
    listed(owner_token.clone())
      .await
      .contains(&"profiles/p1/metadata.json".to_string())
  );
  assert!(
    !listed(token_for("other"))
      .await
      .contains(&"profiles/p1/metadata.json".to_string())
  );
  // The shared token sees the bucket root, where account spaces are not.
  assert!(
    !listed(SYNC_TOKEN.to_string())
      .await
      .contains(&"profiles/p1/metadata.json".to_string())
  );
  // A team member works in the owner's space.
  assert!(
    listed(token_for("member"))
      .await
      .contains(&"profiles/p1/metadata.json".to_string())
  );
  // Account mode does not apply the profile limit on this server.
  assert_eq!(
    upload(owner_token.clone(), "profiles/p2/metadata.json")
      .await
      .0,
    200
  );

  assert_eq!(
    upload(token_for("stranger"), "profiles/p1/metadata.json")
      .await
      .0,
    401
  );
  let (status, body) = upload(token_for("down"), "profiles/p1/metadata.json").await;
  assert_eq!(status, 503);
  assert_eq!(
    body["message"],
    "The Donut account service could not be reached"
  );

  let asked = api.calls_to("/api/auth/server-sync/introspect");
  assert!(asked.iter().all(|q| q["server"] == PUBLIC_URL));
  // Answers are cached: the owner's token was asked about once.
  let owner_questions = asked.iter().filter(|q| q["token"] == owner_token).count();
  assert_eq!(owner_questions, 1);
}
