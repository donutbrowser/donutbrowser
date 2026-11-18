//! Routines and the outside world, behind the `agentIntegrations` flag: a
//! webhook that fires a routine with its body as the input, and subscriptions
//! that send results to Slack or any webhook. The cloud keeps and delivers
//! them; the desktop reports the one event only it sees, a run that waits for
//! the person.

use crate::cloud_errors::FailureCodes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CODES: FailureCodes = FailureCodes {
  bad_request: "AGENT_SUBSCRIPTION_INVALID",
  forbidden: "AGENT_INTEGRATIONS_NOT_ENTITLED",
  not_found: "AGENT_SUBSCRIPTION_NOT_FOUND",
  conflict: "AGENT_SUBSCRIPTION_LIMIT",
};

const EVENTS: [&str; 3] = ["run.finished", "batch.finished", "run.needs_you"];
const MAX_URL_CHARS: usize = 2_000;
const MAX_QUESTION_CHARS: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Hook {
  pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
  pub id: String,
  #[serde(default)]
  pub event: String,
  #[serde(default)]
  pub url: String,
  #[serde(default)]
  pub routine_id: Option<String>,
  #[serde(default)]
  pub created_at: Option<String>,
  #[serde(default)]
  pub last_error: Option<String>,
  #[serde(default)]
  pub last_delivered_at: Option<String>,
  /// The signing secret, in the answer to a create only.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDraft {
  pub event: String,
  pub url: String,
  #[serde(default)]
  pub routine_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Listed {
  Wrapped { subscriptions: Vec<Subscription> },
  Bare(Vec<Subscription>),
}

pub async fn entitled() -> bool {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return super::mock::integrations();
  }
  crate::cloud_auth::CLOUD_AUTH
    .entitlements()
    .await
    .is_some_and(|e| e.agent && e.agent_integrations)
}

async fn ensure_entitled() -> Result<(), String> {
  super::ensure_entitled().await?;
  if entitled().await {
    Ok(())
  } else {
    Err(crate::backend_error("AGENT_INTEGRATIONS_NOT_ENTITLED"))
  }
}

pub fn checked(draft: SubscriptionDraft) -> Result<SubscriptionDraft, String> {
  let event = draft.event.trim().to_string();
  if !EVENTS.contains(&event.as_str()) {
    return Err(crate::backend_error("AGENT_SUBSCRIPTION_INVALID"));
  }
  let url = draft.url.trim().to_string();
  let https = url::Url::parse(&url)
    .is_ok_and(|parsed| parsed.scheme() == "https" && parsed.host_str().is_some());
  if !https || url.chars().count() > MAX_URL_CHARS {
    return Err(crate::backend_error("AGENT_SUBSCRIPTION_URL_INVALID"));
  }
  let routine_id = match draft.routine_id.as_deref().map(str::trim) {
    None | Some("") => None,
    Some(id) => Some(super::cloud::segment(id, "AGENT_ROUTINE_NOT_FOUND").map(|_| id.to_string())?),
  };
  Ok(SubscriptionDraft {
    event,
    url,
    routine_id,
  })
}

/// Make the routine's webhook, or a new one in place of it: the old address
/// stops working.
#[tauri::command]
pub async fn set_agent_routine_hook(id: String) -> Result<Hook, String> {
  ensure_entitled().await?;
  let id = super::cloud::segment(&id, "AGENT_ROUTINE_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    let hook = super::mock::set_hook(&id)?;
    super::schedule::changed();
    return Ok(hook);
  }
  let url = format!("{}/routines/{id}/hook", super::cloud::base());
  let hook: Hook = super::cloud::call("hook", reqwest::Method::POST, url, Some(json!({}))).await?;
  log::info!("Agent routine hook set routine={id}");
  super::schedule::changed();
  Ok(hook)
}

#[tauri::command]
pub async fn delete_agent_routine_hook(id: String) -> Result<(), String> {
  ensure_entitled().await?;
  let id = super::cloud::segment(&id, "AGENT_ROUTINE_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    super::mock::delete_hook(&id)?;
    super::schedule::changed();
    return Ok(());
  }
  let url = format!("{}/routines/{id}/hook", super::cloud::base());
  super::cloud::call::<Option<Value>>("hook_delete", reqwest::Method::DELETE, url, None).await?;
  log::info!("Agent routine hook deleted routine={id}");
  super::schedule::changed();
  Ok(())
}

#[tauri::command]
pub async fn list_agent_subscriptions() -> Result<Vec<Subscription>, String> {
  ensure_entitled().await?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::subscriptions());
  }
  let url = format!("{}/subscriptions", super::cloud::base());
  let listed: Listed =
    super::cloud::call_with("subscriptions", reqwest::Method::GET, url, None, CODES).await?;
  Ok(match listed {
    Listed::Wrapped { subscriptions } => subscriptions,
    Listed::Bare(list) => list,
  })
}

#[tauri::command]
pub async fn create_agent_subscription(
  subscription: SubscriptionDraft,
) -> Result<Subscription, String> {
  ensure_entitled().await?;
  let draft = checked(subscription)?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return super::mock::add_subscription(draft);
  }
  let url = format!("{}/subscriptions", super::cloud::base());
  let body = serde_json::to_value(&draft).unwrap_or(Value::Null);
  let saved: Subscription = super::cloud::call_with(
    "subscription_create",
    reqwest::Method::POST,
    url,
    Some(body),
    CODES,
  )
  .await?;
  log::info!(
    "Agent subscription added id={} event={}",
    saved.id,
    saved.event
  );
  Ok(saved)
}

#[tauri::command]
pub async fn delete_agent_subscription(id: String) -> Result<(), String> {
  ensure_entitled().await?;
  let id = super::cloud::segment(&id, "AGENT_SUBSCRIPTION_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return super::mock::delete_subscription(&id);
  }
  let url = format!("{}/subscriptions/{id}", super::cloud::base());
  super::cloud::call_with::<Option<Value>>(
    "subscription_delete",
    reqwest::Method::DELETE,
    url,
    None,
    CODES,
  )
  .await?;
  log::info!("Agent subscription deleted id={id}");
  Ok(())
}

/// Send the subscription one sample delivery; the answer carries how it went.
#[tauri::command]
pub async fn test_agent_subscription(id: String) -> Result<Subscription, String> {
  ensure_entitled().await?;
  let id = super::cloud::segment(&id, "AGENT_SUBSCRIPTION_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return super::mock::test_subscription(&id);
  }
  let url = format!("{}/subscriptions/{id}/test", super::cloud::base());
  super::cloud::call_with(
    "subscription_test",
    reqwest::Method::POST,
    url,
    Some(json!({})),
    CODES,
  )
  .await
}

static EVENTS_SENT: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent event report");

pub fn needs_you_event(routine_id: &str, run_id: &str, profile_id: &str, question: &str) -> Value {
  json!({
    "event": "run.needs_you",
    "routineId": routine_id,
    "runId": run_id,
    "profileId": profile_id,
    "question": question.chars().take(MAX_QUESTION_CHARS).collect::<String>(),
  })
}

/// A routine's run waits for the person: the cloud tells its subscribers.
pub fn report_needs_you(routine_id: String, run_id: String, profile_id: String, question: String) {
  tokio::spawn(async move {
    if !entitled().await {
      return;
    }
    let body = needs_you_event(&routine_id, &run_id, &profile_id, &question);
    #[cfg(feature = "e2e")]
    if super::mock::active() {
      super::mock::event(body);
      return;
    }
    let url = format!("{}/events", super::cloud::base());
    match super::cloud::call::<Option<Value>>("event", reqwest::Method::POST, url, Some(body)).await
    {
      Ok(_) => EVENTS_SENT.succeeded(),
      Err(e) => EVENTS_SENT.failed(super::error_code(&e)),
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_subscription_takes_known_events_and_https_only() {
    let draft = SubscriptionDraft {
      event: "run.finished".into(),
      url: " https://hooks.slack.com/services/T/B/x ".into(),
      routine_id: Some(" ".into()),
    };
    let ok = checked(draft.clone()).unwrap();
    assert_eq!(ok.url, "https://hooks.slack.com/services/T/B/x");
    assert_eq!(ok.routine_id, None);
    assert!(checked(SubscriptionDraft {
      url: "http://example.com/hook".into(),
      ..draft.clone()
    })
    .unwrap_err()
    .contains("AGENT_SUBSCRIPTION_URL_INVALID"));
    assert!(checked(SubscriptionDraft {
      event: "run.started".into(),
      ..draft
    })
    .unwrap_err()
    .contains("AGENT_SUBSCRIPTION_INVALID"));
  }

  #[test]
  fn a_wait_reaches_the_cloud_as_the_contract_names_it() {
    let body = needs_you_event("r", "run", "p", &"q".repeat(5_000));
    assert_eq!(body["event"], "run.needs_you");
    assert_eq!(body["routineId"], "r");
    assert_eq!(body["runId"], "run");
    assert_eq!(body["profileId"], "p");
    assert_eq!(body["question"].as_str().unwrap().len(), MAX_QUESTION_CHARS);
    let created: Subscription = serde_json::from_str(
      r#"{"id":"s","event":"run.finished","url":"https://x.example","routineId":null,"createdAt":"2026-11-18T00:00:00Z","secret":"whsec"}"#,
    )
    .unwrap();
    assert_eq!(created.secret.as_deref(), Some("whsec"));
  }
}
