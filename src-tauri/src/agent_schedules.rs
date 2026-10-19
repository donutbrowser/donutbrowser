//! Scheduled automation: recipes Donut cloud runs on a calendar, on this
//! desktop or on the remote fleet. Solo, Pro, Team and Enterprise.
//!
//! The cloud stores the schedules, decides when they fire, and checks the
//! plan on every save and again at every fire, so a schedule can never run
//! on a plan that does not include it, whatever this side does. This client
//! only passes the requests on and turns failures into codes the app
//! translates.

use crate::cloud_errors::{BackendFailure, FailureCodes};
use serde_json::Value;

const SCHEDULE_CODES: FailureCodes = FailureCodes {
  bad_request: "AGENT_SCHEDULE_INVALID",
  forbidden: "SCHEDULED_AUTOMATION_NOT_ENTITLED",
  not_found: "AGENT_SCHEDULE_NOT_FOUND",
  conflict: "AGENT_SCHEDULE_INVALID",
};

fn base() -> String {
  format!("{}/api/agent/schedules", crate::cloud_auth::CLOUD_API_URL)
}

fn url_for(id: &str, tail: &str) -> Result<String, String> {
  let id = id.trim();
  if id.is_empty() || id.len() > 128 {
    return Err(crate::backend_error("AGENT_SCHEDULE_NOT_FOUND"));
  }
  Ok(format!("{}/{}{tail}", base(), urlencoding::encode(id)))
}

fn failure(action: &str, mut err: BackendFailure) -> String {
  log::warn!(
    "Schedule request failed action={action} code={} status={}",
    err.code,
    err.status
  );
  // The cloud names a schedule a job; the app has one word for it.
  if err.code == "AGENT_JOB_NOT_FOUND" {
    err.code = "AGENT_SCHEDULE_NOT_FOUND".to_string();
  }
  err.to_error_json()
}

/// A schedule as the app sends it: an object, never anything else.
fn checked_body(body: Value) -> Result<Value, String> {
  if body.is_object() {
    Ok(body)
  } else {
    Err(crate::backend_error("AGENT_SCHEDULE_INVALID"))
  }
}

async fn call(
  action: &str,
  method: reqwest::Method,
  url: String,
  body: Option<Value>,
) -> Result<Value, String> {
  crate::cloud_api::call::<Option<Value>>(method, url, body, SCHEDULE_CODES)
    .await
    .map(|value| value.unwrap_or(Value::Null))
    .map_err(|e| failure(action, e))
}

/// The cloud's own cap on a schedule name.
const MAX_SCHEDULE_NAME_CHARS: usize = 80;

/// The body of a switched-off schedule that runs `recipe_id` once on the fleet.
/// Its date lies a week ahead because the cloud refuses a past one, and it is
/// switched off so it never fires on its own.
fn one_off_fleet_body(name: &str, recipe_id: &str, profile_id: &str, platform: &str) -> Value {
  let name: String = name.trim().chars().take(MAX_SCHEDULE_NAME_CHARS).collect();
  let run_once_at = (chrono::Utc::now() + chrono::Duration::days(7))
    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
  serde_json::json!({
    "name": if name.is_empty() { recipe_id.to_string() } else { name },
    "recipeId": recipe_id,
    "target": "fleet",
    "platform": platform,
    "profileIds": [profile_id],
    "cadence": "once",
    "runOnceAt": run_once_at,
    "enabled": false,
  })
}

/// Run a recipe once on the fleet through a schedule made for that run.
///
/// A plan with scheduled automation and no on-demand runs (Solo) has no other
/// way to start one. The schedule is removed after the run starts: a run keeps
/// going without its schedule, and the cloud skips the failure notice of a
/// schedule that no longer exists.
pub(crate) async fn run_once_on_fleet(
  name: &str,
  recipe_id: &str,
  profile_id: &str,
  platform: &str,
) -> Result<Value, String> {
  let created = call(
    "create",
    reqwest::Method::POST,
    base(),
    Some(one_off_fleet_body(name, recipe_id, profile_id, platform)),
  )
  .await?;
  let Some(id) = created
    .get("id")
    .and_then(Value::as_str)
    .map(str::to_string)
  else {
    return Err(crate::backend_error("AGENT_SCHEDULE_INVALID"));
  };
  let started = call(
    "run_now",
    reqwest::Method::POST,
    url_for(&id, "/run-now")?,
    Some(serde_json::json!({})),
  )
  .await;
  if let Err(e) = call("delete", reqwest::Method::DELETE, url_for(&id, "")?, None).await {
    log::warn!("Removing the one-off schedule failed schedule={id} err={e}");
  }
  let started = started?;
  log::info!("Recipe run started recipe={recipe_id} target=fleet via=schedule schedule={id}");
  Ok(started)
}

#[tauri::command]
pub async fn list_agent_schedules() -> Result<Value, String> {
  call("list", reqwest::Method::GET, base(), None).await
}

#[tauri::command]
pub async fn create_agent_schedule(schedule: Value) -> Result<Value, String> {
  let schedule = checked_body(schedule)?;
  let created = call("create", reqwest::Method::POST, base(), Some(schedule)).await?;
  log::info!(
    "Schedule created schedule={}",
    created.get("id").and_then(Value::as_str).unwrap_or("?")
  );
  Ok(created)
}

#[tauri::command]
pub async fn update_agent_schedule(id: String, patch: Value) -> Result<Value, String> {
  let patch = checked_body(patch)?;
  call(
    "update",
    reqwest::Method::PATCH,
    url_for(&id, "")?,
    Some(patch),
  )
  .await
}

#[tauri::command]
pub async fn delete_agent_schedule(id: String) -> Result<(), String> {
  call("delete", reqwest::Method::DELETE, url_for(&id, "")?, None).await?;
  log::info!("Schedule deleted schedule={id}");
  Ok(())
}

#[tauri::command]
pub async fn run_agent_schedule_now(id: String) -> Result<Value, String> {
  call(
    "run_now",
    reqwest::Method::POST,
    url_for(&id, "/run-now")?,
    Some(serde_json::json!({})),
  )
  .await
}

#[tauri::command]
pub async fn list_agent_schedule_runs(id: String) -> Result<Value, String> {
  call("runs", reqwest::Method::GET, url_for(&id, "/runs")?, None).await
}

/// Send a test email and webhook for the schedule `id`, as a failed run would.
#[tauri::command]
pub async fn test_agent_schedule_notice(id: String) -> Result<Value, String> {
  call(
    "test_notice",
    reqwest::Method::POST,
    url_for(&id, "/test-notice")?,
    Some(serde_json::json!({})),
  )
  .await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_id_is_one_path_segment() {
    let url = url_for("a/../b", "/runs").unwrap();
    assert!(url.ends_with("/api/agent/schedules/a%2F..%2Fb/runs"));
    assert!(url_for("  ", "")
      .unwrap_err()
      .contains("AGENT_SCHEDULE_NOT_FOUND"));
    assert!(url_for(&"x".repeat(129), "").is_err());
  }

  #[test]
  fn only_an_object_is_sent() {
    assert!(checked_body(serde_json::json!({"name": "nightly"})).is_ok());
    assert!(checked_body(serde_json::json!(["x"]))
      .unwrap_err()
      .contains("AGENT_SCHEDULE_INVALID"));
  }

  #[test]
  fn a_one_off_fleet_schedule_is_off_and_dated_ahead() {
    let body = one_off_fleet_body(&"n".repeat(120), "r1", "p1", "linux");
    assert_eq!(body["name"].as_str().unwrap().chars().count(), 80);
    assert_eq!(body["enabled"], false);
    assert_eq!(body["cadence"], "once");
    assert_eq!(body["target"], "fleet");
    assert_eq!(body["platform"], "linux");
    assert_eq!(body["profileIds"], serde_json::json!(["p1"]));
    let at = chrono::DateTime::parse_from_rfc3339(body["runOnceAt"].as_str().unwrap()).unwrap();
    assert!(at > chrono::Utc::now() + chrono::Duration::days(6));
    assert_eq!(one_off_fleet_body("  ", "r1", "p1", "linux")["name"], "r1");
  }

  #[test]
  fn a_plan_without_schedules_is_refused_with_the_server_code() {
    let refusal = crate::cloud_errors::classify(
      402,
      r#"{"code":"SCHEDULED_AUTOMATION_NOT_ENTITLED"}"#,
      SCHEDULE_CODES,
    );
    assert_eq!(refusal.code, "SCHEDULED_AUTOMATION_NOT_ENTITLED");
    let forbidden = crate::cloud_errors::classify(403, "", SCHEDULE_CODES);
    assert_eq!(forbidden.code, "SCHEDULED_AUTOMATION_NOT_ENTITLED");
  }
}
