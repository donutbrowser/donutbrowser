//! Client for the cloud agent routes: credits, the agent token, routines and
//! their runs. Storage, schedules and the plan checks live in the cloud; this
//! side checks the shape before sending and turns failures into codes.

use super::token::AgentToken;
use crate::cloud_errors::{BackendFailure, FailureCodes};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const AGENT_CODES: FailureCodes = FailureCodes {
  bad_request: "AGENT_ROUTINE_INVALID",
  forbidden: "AGENT_NOT_ENTITLED",
  not_found: "AGENT_ROUTINE_NOT_FOUND",
  conflict: "AGENT_ROUTINE_INVALID",
};

pub const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_NAME_CHARS: usize = 120;
const MAX_ID_CHARS: usize = 128;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
  #[serde(default)]
  pub allowance: i64,
  #[serde(default)]
  pub used: i64,
  #[serde(default)]
  pub extra: i64,
  #[serde(default)]
  pub balance: i64,
  #[serde(default)]
  pub period_end: Option<String>,
  #[serde(default)]
  pub plan: Option<String>,
  /// Enterprise and service accounts.
  #[serde(default)]
  pub unlimited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutineSchedule {
  pub cron: String,
  pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
  pub id: String,
  #[serde(default)]
  pub name: String,
  #[serde(default)]
  pub prompt: String,
  #[serde(default)]
  pub start_url: Option<String>,
  #[serde(default)]
  pub profile_ids: Vec<String>,
  #[serde(default)]
  pub schedule: Option<RoutineSchedule>,
  #[serde(default)]
  pub max_credits_per_run: Option<u64>,
  #[serde(default)]
  pub concurrency: Option<usize>,
  #[serde(default = "enabled_by_default")]
  pub enabled: bool,
  #[serde(default)]
  pub created_at: Option<String>,
  #[serde(default)]
  pub updated_at: Option<String>,
}

fn enabled_by_default() -> bool {
  true
}

/// A routine as the app sends it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDraft {
  pub name: String,
  pub prompt: String,
  #[serde(default)]
  pub start_url: Option<String>,
  #[serde(default)]
  pub profile_ids: Vec<String>,
  #[serde(default)]
  pub schedule: Option<RoutineSchedule>,
  #[serde(default)]
  pub max_credits_per_run: Option<u64>,
  #[serde(default)]
  pub concurrency: Option<usize>,
  #[serde(default = "enabled_by_default")]
  pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
  #[serde(alias = "id")]
  pub run_id: String,
  #[serde(default)]
  pub batch_id: Option<String>,
  #[serde(default)]
  pub profile_id: Option<String>,
  #[serde(default)]
  pub status: String,
  #[serde(default)]
  pub summary: Option<String>,
  #[serde(default)]
  pub credits_used: Option<u64>,
  #[serde(default)]
  pub error: Option<String>,
  #[serde(default)]
  pub created_at: Option<String>,
  #[serde(default)]
  pub finished_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Listed<T> {
  Routines { routines: Vec<T> },
  Runs { runs: Vec<T> },
  Bare(Vec<T>),
}

impl<T> Listed<T> {
  fn into_vec(self) -> Vec<T> {
    match self {
      Self::Routines { routines } => routines,
      Self::Runs { runs } => runs,
      Self::Bare(items) => items,
    }
  }
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
  pub run_id: String,
  pub profile_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartedBatch {
  pub batch_id: String,
  #[serde(default)]
  pub runs: Vec<StartedRun>,
}

fn base() -> String {
  format!("{}/api/agent", crate::cloud_auth::CLOUD_API_URL)
}

fn segment(id: &str, missing: &str) -> Result<String, String> {
  let id = id.trim();
  if id.is_empty() || id.len() > MAX_ID_CHARS {
    return Err(crate::backend_error(missing));
  }
  Ok(urlencoding::encode(id).into_owned())
}

fn failure(action: &str, err: BackendFailure) -> String {
  log::warn!(
    "Agent cloud request failed action={action} code={} status={}",
    err.code,
    err.status
  );
  err.to_error_json()
}

async fn call<T: DeserializeOwned>(
  action: &str,
  method: reqwest::Method,
  url: String,
  body: Option<Value>,
) -> Result<T, String> {
  crate::cloud_api::call(method, url, body, AGENT_CODES)
    .await
    .map_err(|e| failure(action, e))
}

pub fn is_web_url(url: &str) -> bool {
  url::Url::parse(url)
    .is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some())
}

/// Checks shared by a task and a routine. Returns the trimmed prompt and URL.
pub fn checked_order(
  prompt: &str,
  start_url: Option<&str>,
) -> Result<(String, Option<String>), String> {
  let prompt = prompt.trim();
  if prompt.is_empty() {
    return Err(crate::backend_error("AGENT_PROMPT_EMPTY"));
  }
  if prompt.chars().count() > MAX_PROMPT_CHARS {
    return Err(
      json!({ "code": "AGENT_TEXT_TOO_LONG", "params": { "max": MAX_PROMPT_CHARS.to_string() } })
        .to_string(),
    );
  }
  let start_url = start_url.map(str::trim).filter(|url| !url.is_empty());
  if let Some(url) = start_url {
    if !is_web_url(url) {
      return Err(crate::backend_error("AGENT_START_URL_INVALID"));
    }
  }
  Ok((prompt.to_string(), start_url.map(str::to_string)))
}

pub fn checked_draft(draft: RoutineDraft) -> Result<RoutineDraft, String> {
  let name = draft.name.trim().to_string();
  if name.is_empty() {
    return Err(crate::backend_error("NAME_CANNOT_BE_EMPTY"));
  }
  if name.chars().count() > MAX_NAME_CHARS {
    return Err(crate::backend_error("AGENT_ROUTINE_INVALID"));
  }
  let (prompt, start_url) = checked_order(&draft.prompt, draft.start_url.as_deref())?;
  if draft.profile_ids.len() > super::batch::MAX_PROFILES
    || draft
      .profile_ids
      .iter()
      .any(|id| id.trim().is_empty() || id.len() > MAX_ID_CHARS)
  {
    return Err(crate::backend_error("AGENT_ROUTINE_INVALID"));
  }
  if let Some(schedule) = &draft.schedule {
    let fields = schedule.cron.split_whitespace().count();
    if !(5..=6).contains(&fields) || schedule.timezone.trim().is_empty() {
      return Err(crate::backend_error("AGENT_SCHEDULE_INVALID"));
    }
  }
  if draft.max_credits_per_run == Some(0) {
    return Err(crate::backend_error("AGENT_ROUTINE_INVALID"));
  }
  Ok(RoutineDraft {
    name,
    prompt,
    start_url,
    concurrency: draft
      .concurrency
      .map(|n| n.clamp(1, super::batch::MAX_CONCURRENCY)),
    ..draft
  })
}

pub async fn credits() -> Result<Credits, String> {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::credits());
  }
  call(
    "credits",
    reqwest::Method::GET,
    format!("{}/credits", base()),
    None,
  )
  .await
}

pub async fn mint_token() -> Result<AgentToken, String> {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::token());
  }
  let body: Value = call(
    "token",
    reqwest::Method::POST,
    format!("{}/token", base()),
    Some(json!({})),
  )
  .await?;
  super::token::decode(&body).ok_or_else(|| crate::backend_error("CLOUD_REQUEST_FAILED"))
}

pub async fn list_routines() -> Result<Vec<Routine>, String> {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::routines());
  }
  let listed: Listed<Routine> = call(
    "list",
    reqwest::Method::GET,
    format!("{}/routines", base()),
    None,
  )
  .await?;
  Ok(listed.into_vec())
}

pub async fn get_routine(id: &str) -> Result<Routine, String> {
  let id = segment(id, "AGENT_ROUTINE_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return super::mock::routine(&id);
  }
  call(
    "get",
    reqwest::Method::GET,
    format!("{}/routines/{id}", base()),
    None,
  )
  .await
}

pub async fn create_routine(draft: RoutineDraft) -> Result<Routine, String> {
  let draft = checked_draft(draft)?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::save_routine(None, draft));
  }
  call(
    "create",
    reqwest::Method::POST,
    format!("{}/routines", base()),
    Some(serde_json::to_value(draft).unwrap_or(Value::Null)),
  )
  .await
}

pub async fn update_routine(id: &str, draft: RoutineDraft) -> Result<Routine, String> {
  let id = segment(id, "AGENT_ROUTINE_NOT_FOUND")?;
  let draft = checked_draft(draft)?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    super::mock::routine(&id)?;
    return Ok(super::mock::save_routine(Some(id), draft));
  }
  call(
    "update",
    reqwest::Method::PATCH,
    format!("{}/routines/{id}", base()),
    Some(serde_json::to_value(draft).unwrap_or(Value::Null)),
  )
  .await
}

pub async fn delete_routine(id: &str) -> Result<(), String> {
  let id = segment(id, "AGENT_ROUTINE_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return super::mock::delete_routine(&id);
  }
  call::<Option<Value>>(
    "delete",
    reqwest::Method::DELETE,
    format!("{}/routines/{id}", base()),
    None,
  )
  .await
  .map(|_| ())
}

pub async fn list_runs(routine_id: &str) -> Result<Vec<RoutineRun>, String> {
  let id = segment(routine_id, "AGENT_ROUTINE_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::runs(&id));
  }
  let listed: Listed<RoutineRun> = call(
    "runs",
    reqwest::Method::GET,
    format!("{}/routines/{id}/runs", base()),
    None,
  )
  .await?;
  Ok(listed.into_vec())
}

/// Tell the cloud a batch of a routine starts. A scheduled fire already has
/// its batch id; it is sent back so the runs join it.
pub async fn start_runs(
  routine_id: &str,
  profile_ids: &[String],
  batch_id: Option<&str>,
) -> Result<StartedBatch, String> {
  let id = segment(routine_id, "AGENT_ROUTINE_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::start_runs(&id, profile_ids, batch_id));
  }
  let mut body = json!({ "profileIds": profile_ids });
  if let Some(batch_id) = batch_id {
    body["batchId"] = Value::from(batch_id);
  }
  call(
    "start_runs",
    reqwest::Method::POST,
    format!("{}/routines/{id}/runs", base()),
    Some(body),
  )
  .await
}

pub fn run_patch(
  status: &str,
  summary: Option<&str>,
  credits_used: u64,
  error: Option<&str>,
) -> Value {
  let mut body = json!({ "status": status, "creditsUsed": credits_used });
  if let Some(summary) = summary {
    body["summary"] = Value::from(summary);
  }
  if let Some(error) = error {
    body["error"] = Value::from(error);
  }
  body
}

pub async fn report_run(run_id: &str, patch: Value) {
  let Ok(id) = segment(run_id, "AGENT_RUN_NOT_FOUND") else {
    return;
  };
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    super::mock::report_run(&id, patch);
    return;
  }
  let _ = call::<Option<Value>>(
    "report_run",
    reqwest::Method::PATCH,
    format!("{}/runs/{id}", base()),
    Some(patch),
  )
  .await;
}

#[cfg(test)]
mod tests {
  use super::*;

  fn draft() -> RoutineDraft {
    RoutineDraft {
      name: "  Morning check ".into(),
      prompt: " Read the inbox ".into(),
      start_url: Some(" https://mail.example.com ".into()),
      profile_ids: vec!["p1".into()],
      schedule: None,
      max_credits_per_run: Some(500),
      concurrency: Some(80),
      enabled: true,
    }
  }

  #[test]
  fn a_routine_is_trimmed_and_bounded_before_it_is_sent() {
    let checked = checked_draft(draft()).unwrap();
    assert_eq!(checked.name, "Morning check");
    assert_eq!(checked.prompt, "Read the inbox");
    assert_eq!(
      checked.start_url.as_deref(),
      Some("https://mail.example.com")
    );
    assert_eq!(
      checked.concurrency,
      Some(super::super::batch::MAX_CONCURRENCY)
    );
  }

  #[test]
  fn a_routine_the_cloud_would_refuse_is_refused_here() {
    let cases: [(RoutineDraft, &str); 6] = [
      (
        RoutineDraft {
          name: " ".into(),
          ..draft()
        },
        "NAME_CANNOT_BE_EMPTY",
      ),
      (
        RoutineDraft {
          prompt: "".into(),
          ..draft()
        },
        "AGENT_PROMPT_EMPTY",
      ),
      (
        RoutineDraft {
          prompt: "x".repeat(MAX_PROMPT_CHARS + 1),
          ..draft()
        },
        "AGENT_TEXT_TOO_LONG",
      ),
      (
        RoutineDraft {
          start_url: Some("file:///etc/passwd".into()),
          ..draft()
        },
        "AGENT_START_URL_INVALID",
      ),
      (
        RoutineDraft {
          schedule: Some(RoutineSchedule {
            cron: "daily".into(),
            timezone: "UTC".into(),
          }),
          ..draft()
        },
        "AGENT_SCHEDULE_INVALID",
      ),
      (
        RoutineDraft {
          max_credits_per_run: Some(0),
          ..draft()
        },
        "AGENT_ROUTINE_INVALID",
      ),
    ];
    for (draft, code) in cases {
      assert!(checked_draft(draft).unwrap_err().contains(code), "{code}");
    }
    let scheduled = RoutineDraft {
      schedule: Some(RoutineSchedule {
        cron: "0 9 * * 1-5".into(),
        timezone: "Europe/Tirane".into(),
      }),
      ..draft()
    };
    assert!(checked_draft(scheduled).is_ok());
  }

  #[test]
  fn lists_and_runs_decode_from_the_cloud_shapes() {
    let bare: Listed<Routine> =
      serde_json::from_str(r#"[{"id":"r1","name":"A","prompt":"p","profileIds":["x"]}]"#).unwrap();
    let routines = bare.into_vec();
    assert!(
      routines[0].enabled,
      "a routine is on unless the cloud says otherwise"
    );
    let runs: Listed<RoutineRun> = serde_json::from_str(
      r#"{"runs":[{"id":"run1","profileId":"p","status":"done","creditsUsed":12}]}"#,
    )
    .unwrap();
    assert_eq!(runs.into_vec()[0].run_id, "run1");
    let started: StartedBatch =
      serde_json::from_str(r#"{"batchId":"b","runs":[{"runId":"r","profileId":"p"}]}"#).unwrap();
    assert_eq!(started.runs[0].run_id, "r");
    let credits: Credits = serde_json::from_str(r#"{"allowance":10000,"used":2500,"extra":0,"balance":7500,"periodEnd":"2026-12-01T00:00:00Z","plan":"free"}"#).unwrap();
    assert_eq!(credits.balance, 7500);
    assert!(!credits.unlimited);
  }

  #[test]
  fn a_run_report_carries_only_what_is_known() {
    let patch = run_patch("done", Some("Ordered"), 40, None);
    assert_eq!(
      patch,
      json!({"status": "done", "summary": "Ordered", "creditsUsed": 40})
    );
    assert!(run_patch("failed", None, 0, Some("AGENT_BUSY"))
      .get("summary")
      .is_none());
  }
}
