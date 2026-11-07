//! The dialog and typing tools on a real cloud session, reached through the
//! cloud's CDP relay the way a profile run in the cloud is.
//!
//! `DONUT_FLEET_TEST_KEY` is a `dsk_` key of a Donut service account. The test
//! makes a Linux profile named `fleet-dialogs` the first time, starts one
//! session on it and stops that session whatever happens. A session costs
//! fleet time, so the test is ignored unless asked for:
//! `cargo test --lib fleet_ -- --ignored --nocapture`.

use super::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const PROFILE_NAME: &str = "fleet-dialogs";
/// The longest the session may live if the test cannot stop it.
const SESSION_CAP_SECONDS: u64 = 900;
const LIVE_WAIT: Duration = Duration::from_secs(600);

struct Fleet {
  client: reqwest::Client,
  key: String,
}

impl Fleet {
  fn from_env() -> Self {
    let key = std::env::var("DONUT_FLEET_TEST_KEY")
      .expect("DONUT_FLEET_TEST_KEY (a dsk_ key of a Donut service account) is required");
    Self {
      client: reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap(),
      key,
    }
  }

  async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = self
      .client
      .request(
        method,
        format!("{}{path}", crate::cloud_auth::CLOUD_API_URL),
      )
      .bearer_auth(&self.key);
    if let Some(body) = body {
      request = request.json(&body);
    }
    let response = request.send().await.expect("the cloud API answers");
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    (
      status,
      serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
  }

  /// The test profile, made the first time.
  async fn profile_id(&self) -> String {
    let (status, listed) = self
      .call(
        reqwest::Method::GET,
        "/api/service/profiles?limit=100",
        None,
      )
      .await;
    assert_eq!(status, 200, "{listed}");
    if let Some(id) = listed["profiles"]
      .as_array()
      .into_iter()
      .flatten()
      .find(|p| p["name"] == PROFILE_NAME)
      .and_then(|p| p["id"].as_str())
    {
      return id.to_string();
    }
    let (status, created) = self
      .call(
        reqwest::Method::POST,
        "/api/service/profiles",
        Some(json!({ "name": PROFILE_NAME, "platform": "linux" })),
      )
      .await;
    assert_eq!(status, 201, "{created}");
    created["id"].as_str().unwrap().to_string()
  }

  async fn start(&self, profile_id: &str) -> String {
    let started = Instant::now();
    let (status, session) = self
      .call(
        reqwest::Method::POST,
        "/api/remote-sessions",
        Some(json!({
          "profile_id": profile_id,
          "platform": "linux",
          "idempotency_key": uuid::Uuid::new_v4().to_string(),
          "max_duration_seconds": SESSION_CAP_SECONDS,
        })),
      )
      .await;
    assert_eq!(status, 201, "{session}");
    let id = session["session_id"].as_str().unwrap().to_string();
    eprintln!("fleet: session {id} started");
    while started.elapsed() < LIVE_WAIT {
      let (status, view) = self
        .call(
          reqwest::Method::GET,
          &format!("/api/remote-sessions/{id}"),
          None,
        )
        .await;
      if status == 200 && view["state"] == "live" && view["cdp_ready"] == true {
        eprintln!("fleet: live after {} s", started.elapsed().as_secs());
        return id;
      }
      if status != 200 || view["state"] == "closed" || view["state"] == "error" {
        self.stop(&id).await;
        panic!("the session did not come up: {status} {view}");
      }
      tokio::time::sleep(Duration::from_secs(3)).await;
    }
    self.stop(&id).await;
    panic!("the session was not live within {LIVE_WAIT:?}");
  }

  async fn target(&self, session_id: &str) -> CdpTarget {
    let (status, endpoint) = self
      .call(
        reqwest::Method::GET,
        &format!("/api/remote-sessions/{session_id}/cdp"),
        None,
      )
      .await;
    assert_eq!(status, 200, "{endpoint}");
    CdpTarget::Remote {
      ws_url: endpoint["ws_url"].as_str().unwrap().to_string(),
      bearer: self.key.clone(),
      session_id: session_id.to_string(),
    }
  }

  async fn stop(&self, session_id: &str) {
    let (status, stopped) = self
      .call(
        reqwest::Method::DELETE,
        &format!("/api/remote-sessions/{session_id}"),
        None,
      )
      .await;
    eprintln!(
      "fleet: session {session_id} stopped: {status} billed_seconds={}",
      stopped["billed_seconds"]
    );
  }
}

/// A button that asks to confirm, and a text field.
const FIXTURE: &str = r#"(() => {
  document.title = 'Fleet dialogs';
  document.body.innerHTML = '<button id="delete" style="margin:40px;padding:20px" onclick="document.body.dataset.deleted = confirm(\'Delete it?\')">Delete</button><label>Later <input id="later"></label>';
  return document.visibilityState;
})()"#;

struct Agent<'a> {
  server: &'a McpServer,
  profile_id: String,
}

impl Agent<'_> {
  fn args(&self, mut arguments: Value) -> Value {
    arguments["profile_id"] = json!(self.profile_id);
    arguments
  }

  async fn evaluate(&self, expression: &str) -> Result<Value, McpError> {
    self
      .server
      .handle_evaluate_javascript(&self.args(json!({ "expression": expression })))
      .await
      .map(|result| json_text(&result)["value"].clone())
  }

  async fn navigate_and_build(&self) -> String {
    self
      .server
      .handle_navigate(&self.args(json!({ "url": "about:blank" })))
      .await
      .expect("navigate");
    self
      .evaluate(FIXTURE)
      .await
      .expect("the fixture is built")
      .as_str()
      .unwrap_or_default()
      .to_string()
  }

  async fn get_dialog(&self) -> Value {
    json_text(
      &self
        .server
        .handle_get_dialog(&self.args(json!({})))
        .await
        .expect("get_dialog"),
    )
  }
}

fn text_of(result: &Value) -> String {
  result["content"][0]["text"]
    .as_str()
    .unwrap_or_default()
    .to_string()
}

fn json_text(result: &Value) -> Value {
  serde_json::from_str(&text_of(result)).unwrap_or(Value::Null)
}

fn code_of(error: &McpError) -> String {
  error
    .data
    .as_ref()
    .and_then(|data| data["code"].as_str())
    .unwrap_or_default()
    .to_string()
}

async fn timed<T>(what: &str, call: impl std::future::Future<Output = T>) -> (T, Duration) {
  let started = Instant::now();
  let value = call.await;
  let elapsed = started.elapsed();
  eprintln!("fleet: {what} took {} ms", elapsed.as_millis());
  (value, elapsed)
}

/// Run `method` on the browser itself, beside the page the tools drive.
async fn on_browser(target: &CdpTarget, method: &str, params: Value) -> Value {
  let mut connection = target.connect().await.expect("a relay socket");
  connection
    .send_to(None, 77, method, params)
    .await
    .expect("sent to the browser");
  let reply = connection
    .await_reply(77, Duration::from_secs(20))
    .await
    .unwrap_or_else(|e| panic!("{method}: {e}"));
  connection.close().await;
  reply
}

async fn browser_version(target: &CdpTarget) -> String {
  let version = on_browser(target, "Browser.getVersion", json!({})).await;
  version["product"]
    .as_str()
    .and_then(|product| product.split('/').nth(1))
    .unwrap_or("156.0.0.0")
    .to_string()
}

async fn drive(target: CdpTarget) {
  let version = browser_version(&target).await;
  eprintln!("fleet: browser {version}");
  let profile = BrowserProfile {
    id: uuid::Uuid::new_v4(),
    name: "fleet test".to_string(),
    browser: "wayfern".to_string(),
    version,
    ..Default::default()
  };
  let profile_id = profile.id.to_string();
  pinned_profiles::pin(profile, target.clone());
  let server = McpServer::new();
  let agent = Agent {
    server: &server,
    profile_id: profile_id.clone(),
  };

  // a) A click that opens a confirm, and every page tool after it.
  agent.navigate_and_build().await;
  assert_eq!(agent.get_dialog().await, json!({ "open": false }));
  let (clicked, _) = timed(
    "click opening a confirm",
    server.handle_click_element(&agent.args(json!({ "selector": "#delete" }))),
  )
  .await;
  match &clicked {
    Ok(result) => eprintln!("fleet: click said {:?}", text_of(result)),
    Err(error) => eprintln!(
      "fleet: click refused {} {:?}",
      code_of(error),
      error.message
    ),
  }
  let (refused, took) = timed("evaluate during the dialog", agent.evaluate("1 + 1")).await;
  let refused = refused.expect_err("a page held by a dialog refuses the tool");
  assert_eq!(code_of(&refused), "DIALOG_OPEN", "{refused:?}");
  assert!(took < Duration::from_millis(1_700), "refused in {took:?}");
  eprintln!("fleet: agent saw {:?}", refused.message);
  let (info, took) = timed(
    "get_page_info during the dialog",
    server.handle_get_page_info(&agent.args(json!({}))),
  )
  .await;
  assert_eq!(code_of(&info.expect_err("refused")), "DIALOG_OPEN");
  assert!(took < Duration::from_millis(1_700), "refused in {took:?}");
  let (read, _) = timed("get_dialog", agent.get_dialog()).await;
  assert_eq!(read["open"], true, "{read}");
  assert_eq!(read["dialog"]["type"], "confirm");
  assert_eq!(read["dialog"]["message"], "Delete it?");
  let (answered, _) = timed(
    "handle_dialog",
    server.handle_handle_dialog(&agent.args(json!({ "accept": false }))),
  )
  .await;
  let answered = text_of(&answered.expect("handle_dialog"));
  eprintln!("fleet: handle_dialog said {answered:?}");
  assert!(
    answered.starts_with("Dismissed a confirm dialog that says \"Delete it?\"."),
    "{answered}"
  );
  assert_eq!(
    agent
      .evaluate("document.body.dataset.deleted")
      .await
      .unwrap(),
    "false"
  );
  let none = server
    .handle_handle_dialog(&agent.args(json!({ "accept": true })))
    .await
    .expect_err("nothing to answer");
  assert_eq!(code_of(&none), "NO_DIALOG_OPEN");

  // b) Another tab comes to the front and the agent's tab loads again behind
  // it: the text still reaches the field.
  let front = on_browser(
    &target,
    "Target.createTarget",
    json!({ "url": "about:blank" }),
  )
  .await;
  let front = front["targetId"].as_str().unwrap().to_string();
  let visibility = agent.navigate_and_build().await;
  assert_eq!(
    visibility, "hidden",
    "the agent's tab loaded behind the other"
  );
  let (typed, _) = timed(
    "type_locator in the tab behind",
    server.handle_type_locator(&agent.args(json!({
      "locator": { "role": "textbox", "name": "Later" },
      "text": "typed behind",
    }))),
  )
  .await;
  let typed = json_text(&typed.expect("typed"));
  eprintln!("fleet: typed_with={} {typed}", typed["typed_with"]);
  assert_eq!(typed["verified"], true, "{typed}");
  assert!(
    typed["typed_with"] == "key_events" || typed["typed_with"] == "browser_keyboard",
    "{typed}"
  );
  assert_eq!(
    agent
      .evaluate("document.querySelector('#later').value")
      .await
      .unwrap(),
    "typed behind"
  );
  let (typed, _) = timed(
    "type_text in the tab behind",
    server.handle_type_text(&agent.args(json!({
      "selector": "#later",
      "text": "by selector",
    }))),
  )
  .await;
  eprintln!(
    "fleet: type_text said {:?}",
    text_of(&typed.expect("typed"))
  );
  assert_eq!(
    agent
      .evaluate("document.querySelector('#later').value")
      .await
      .unwrap(),
    "by selector"
  );
  on_browser(&target, "Target.closeTarget", json!({ "targetId": front })).await;

  // c) The agent's tab closes while a dialog holds it: the tab that is left
  // is driven, no dialog is reported on it, and its own dialogs are seen.
  agent
    .evaluate("setTimeout(() => alert('Closing'), 50); 1")
    .await
    .unwrap();
  tokio::time::sleep(Duration::from_millis(800)).await;
  assert_eq!(agent.get_dialog().await["dialog"]["message"], "Closing");
  let agents_tab = crate::page_dialog::remote_page(&target).expect("a pinned tab");
  on_browser(
    &target,
    "Target.createTarget",
    json!({ "url": "about:blank" }),
  )
  .await;
  on_browser(
    &target,
    "Target.closeTarget",
    json!({ "targetId": agents_tab }),
  )
  .await;
  tokio::time::sleep(Duration::from_millis(500)).await;
  let (after, _) = timed("get_dialog after the tab closed", agent.get_dialog()).await;
  assert_eq!(after, json!({ "open": false }), "{after}");
  let (title, _) = timed("evaluate on the tab left", agent.evaluate("1 + 1")).await;
  assert_eq!(title.expect("the tab left is driven"), 2);
  assert_ne!(
    crate::page_dialog::remote_page(&target).as_deref(),
    Some(agents_tab.as_str())
  );
  agent
    .evaluate("setTimeout(() => confirm('Again?'), 50); 1")
    .await
    .unwrap();
  tokio::time::sleep(Duration::from_millis(800)).await;
  let (refused, took) = timed(
    "evaluate during a dialog on the tab left",
    agent.evaluate("1 + 1"),
  )
  .await;
  assert_eq!(
    code_of(&refused.expect_err("refused")),
    "DIALOG_OPEN",
    "the tab left is watched"
  );
  assert!(took < Duration::from_millis(1_700), "refused in {took:?}");
  server
    .handle_handle_dialog(&agent.args(json!({ "accept": true })))
    .await
    .expect("the dialog on the tab left is answered");
  assert_eq!(agent.evaluate("1 + 1").await.expect("works again"), 2);

  pinned_profiles::unpin(&profile_id);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "starts a cloud session: needs DONUT_FLEET_TEST_KEY"]
async fn fleet_dialogs_and_typing_behind_another_tab() {
  let fleet = Fleet::from_env();
  let profile_id = fleet.profile_id().await;
  let session = fleet.start(&profile_id).await;
  let target = fleet.target(&session).await;
  let outcome = tokio::spawn(drive(target)).await;
  fleet.stop(&session).await;
  if let Err(failure) = outcome {
    std::panic::resume_unwind(failure.into_panic());
  }
}
