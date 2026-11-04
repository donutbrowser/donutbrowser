//! Host calls: during a chat the engine asks Donut to act in the app. Reads
//! (profiles, routines, credits) are answered at once. A change (save, run or
//! delete a routine, run a task in other profiles) waits in the chat as a card
//! the person can edit; only their OK does it, and the engine gets what was
//! saved. Only chat tasks are offered these calls (`host` in
//! `Wayfern.agentStart`), never routine or batch runs. An engine that does not
//! know `host` never calls, and nothing here runs.

use super::batch::{Autonomy, Order};
use super::chat::{self, Turn};
use super::cloud::{self, Credits, Routine, RoutineDraft, RoutineSchedule};
use super::model::TaskStatus;
use super::{ensure_entitled, error_code, now_ms, BatchSpec, BatchView};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

/// What Donut answers, sent in `Wayfern.agentStart` for chat tasks.
pub const METHODS: [&str; 7] = [
  "profiles.list",
  "routines.list",
  "routines.save",
  "routines.run",
  "routines.delete",
  "tasks.run",
  "credits.get",
];

/// Calls kept per turn, answered or not. The oldest answered go first.
const MAX_CALLS: usize = 20;
const MAX_CALL_ID_CHARS: usize = 128;
/// Routines whose runs are read at once for `lastRunAt`.
const RUN_READS_AT_ONCE: usize = 6;

/// Why a call has no result, as the engine reads it.
type Refusal = &'static str;
const INVALID: Refusal = "INVALID_PARAMS";
const NOT_FOUND: Refusal = "NOT_FOUND";
const FAILED: Refusal = "FAILED";
const DECLINED: Refusal = "DECLINED";
const PLAN_REQUIRED: Refusal = "PLAN_REQUIRED";

/// A change the engine asks for, completed from the routine it names. The
/// person may edit it before it is done.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method")]
pub enum HostRequest {
  #[serde(rename = "routines.save")]
  SaveRoutine {
    id: Option<String>,
    routine: RoutineDraft,
  },
  #[serde(rename = "routines.run", rename_all = "camelCase")]
  RunRoutine {
    id: String,
    name: String,
    profile_ids: Vec<String>,
  },
  #[serde(rename = "routines.delete")]
  DeleteRoutine { id: String, name: String },
  #[serde(rename = "tasks.run", rename_all = "camelCase")]
  RunTask {
    prompt: String,
    start_url: Option<String>,
    profile_ids: Vec<String>,
  },
}

impl HostRequest {
  fn method(&self) -> &'static str {
    match self {
      Self::SaveRoutine { .. } => "routines.save",
      Self::RunRoutine { .. } => "routines.run",
      Self::DeleteRoutine { .. } => "routines.delete",
      Self::RunTask { .. } => "tasks.run",
    }
  }

  /// An edit may change the details, never what the call acts on.
  fn same_target(&self, other: &Self) -> bool {
    match (self, other) {
      (Self::SaveRoutine { id: a, .. }, Self::SaveRoutine { id: b, .. }) => a == b,
      (Self::RunRoutine { id: a, .. }, Self::RunRoutine { id: b, .. }) => a == b,
      (Self::DeleteRoutine { id: a, .. }, Self::DeleteRoutine { id: b, .. }) => a == b,
      (Self::RunTask { .. }, Self::RunTask { .. }) => true,
      _ => false,
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallState {
  Pending,
  Done,
  Declined,
}

/// What an answered call saved or started.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
  #[serde(default)]
  pub routine_id: Option<String>,
  #[serde(default)]
  pub batch_id: Option<String>,
  #[serde(default)]
  pub profiles: Option<usize>,
}

/// A change in a chat turn: waiting for the person, or how they answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCall {
  pub call_id: String,
  pub request: HostRequest,
  pub state: CallState,
  #[serde(default)]
  pub outcome: Option<Outcome>,
  pub at: u64,
}

// ---- The turn while calls wait ----

fn waiting(turn: &Turn) -> bool {
  turn
    .host_calls
    .iter()
    .any(|call| call.state == CallState::Pending)
}

/// A change waits for the person: the turn needs them until every call is
/// answered.
pub fn wait(turn: &mut Turn, call: HostCall) -> bool {
  if !turn.task.status.is_active()
    || turn
      .host_calls
      .iter()
      .any(|known| known.call_id == call.call_id)
  {
    return false;
  }
  turn.host_calls.push(call);
  while turn.host_calls.len() > MAX_CALLS {
    let Some(index) = turn
      .host_calls
      .iter()
      .position(|call| call.state != CallState::Pending)
    else {
      break;
    };
    turn.host_calls.remove(index);
  }
  turn.task.status = TaskStatus::NeedsApproval;
  true
}

/// Record the person's answer. The turn runs again once nothing waits.
fn settle(
  turn: &mut Turn,
  call_id: &str,
  state: CallState,
  request: HostRequest,
  outcome: Option<Outcome>,
) -> bool {
  let Some(call) = turn
    .host_calls
    .iter_mut()
    .find(|call| call.call_id == call_id && call.state == CallState::Pending)
  else {
    return false;
  };
  call.state = state;
  call.request = request;
  call.outcome = outcome;
  if turn.task.status == TaskStatus::NeedsApproval && turn.task.approval.is_none() && !waiting(turn)
  {
    turn.task.status = TaskStatus::Running;
  }
  true
}

/// A turn that ended answers nothing more: its open cards go.
pub fn drop_waiting(turn: &mut Turn) {
  turn
    .host_calls
    .retain(|call| call.state != CallState::Pending);
}

// ---- Calls from the engine ----

struct Incoming {
  task_id: String,
  call_id: String,
  method: String,
  params: Value,
}

fn incoming(params: &Value) -> Option<Incoming> {
  let text = |key: &str| {
    params
      .get(key)
      .and_then(Value::as_str)
      .filter(|value| !value.is_empty())
      .map(str::to_string)
  };
  let call_id = text("callId").filter(|id| id.chars().count() <= MAX_CALL_ID_CHARS)?;
  Some(Incoming {
    task_id: text("taskId")?,
    call_id,
    method: text("method")?,
    params: params.get("params").cloned().unwrap_or_else(|| json!({})),
  })
}

/// `Wayfern.agentHostCall`: answer a read, or show a change in the chat.
pub(super) fn on_call(profile_id: &str, params: &Value) {
  let Some(call) = incoming(params) else {
    return;
  };
  tokio::spawn(arrive(profile_id.to_string(), call));
}

fn reply_params(task_id: &str, call_id: &str, outcome: Result<Value, Refusal>) -> Value {
  match outcome {
    Ok(result) => json!({ "taskId": task_id, "callId": call_id, "result": result }),
    Err(code) => json!({ "taskId": task_id, "callId": call_id, "error": { "code": code } }),
  }
}

async fn reply(profile_id: &str, task_id: &str, call_id: &str, outcome: Result<Value, Refusal>) {
  let Some(link) = super::open_link(profile_id) else {
    return;
  };
  // An engine that let the call go answers AGENT_CALL_UNKNOWN; nothing waits.
  if let Err(e) = link
    .call(
      "Wayfern.agentHostReply",
      reply_params(task_id, call_id, outcome),
    )
    .await
  {
    log::debug!(
      "Agent host reply not taken profile={profile_id} err={}",
      error_code(&e.code())
    );
  }
}

async fn arrive(profile_id: String, call: Incoming) {
  let method = METHODS
    .iter()
    .find(|known| **known == call.method)
    .copied()
    .unwrap_or("other");
  let Some(chat_id) = chat::chat_of_task(&profile_id, &call.task_id) else {
    reply(&profile_id, &call.task_id, &call.call_id, Err(FAILED)).await;
    return;
  };
  match prepare(&call.method, &call.params).await {
    Ok(Prepared::Answer(result)) => {
      log::debug!("Agent host call answered chat={chat_id} method={method}");
      reply(&profile_id, &call.task_id, &call.call_id, Ok(result)).await;
    }
    Ok(Prepared::Ask(request)) => {
      let card = HostCall {
        call_id: call.call_id.clone(),
        request,
        state: CallState::Pending,
        outcome: None,
        at: now_ms(),
      };
      if chat::update_turn(&chat_id, &call.task_id, |turn| wait(turn, card)).unwrap_or(false) {
        log::info!("Agent host call waits for the person chat={chat_id} method={method}");
      } else {
        reply(&profile_id, &call.task_id, &call.call_id, Err(FAILED)).await;
      }
    }
    Err(code) => {
      log::debug!("Agent host call refused chat={chat_id} method={method} code={code}");
      reply(&profile_id, &call.task_id, &call.call_id, Err(code)).await;
    }
  }
}

enum Prepared {
  Answer(Value),
  Ask(HostRequest),
}

async fn prepare(method: &str, params: &Value) -> Result<Prepared, Refusal> {
  if !params.is_object() {
    return Err(INVALID);
  }
  match method {
    "profiles.list" => Ok(Prepared::Answer(profiles_view(
      &wayfern_profiles()?,
      &group_names(),
    ))),
    "routines.list" => {
      let routines = cloud::list_routines().await.map_err(|_| FAILED)?;
      let last = last_runs(&routines).await;
      Ok(Prepared::Answer(json!({
        "routines": routines
          .iter()
          .map(|routine| routine_view(routine, last.get(&routine.id).copied()))
          .collect::<Vec<_>>(),
      })))
    }
    "credits.get" => cloud::credits()
      .await
      .map(|credits| Prepared::Answer(credits_view(&credits)))
      .map_err(|_| FAILED),
    "routines.save" => {
      let current = match optional_text(params, "id")? {
        Some(id) => Some(routine(&id).await?),
        None => None,
      };
      save_request(params, current.as_ref(), &known_profiles()?).map(Prepared::Ask)
    }
    "routines.run" => {
      let found = routine(&optional_text(params, "id")?.ok_or(INVALID)?).await?;
      let profile_ids =
        profile_ids(params, &known_profiles()?)?.unwrap_or_else(|| found.profile_ids.clone());
      if profile_ids.is_empty() {
        return Err(INVALID);
      }
      Ok(Prepared::Ask(HostRequest::RunRoutine {
        id: found.id,
        name: found.name,
        profile_ids,
      }))
    }
    "routines.delete" => {
      let found = routine(&optional_text(params, "id")?.ok_or(INVALID)?).await?;
      Ok(Prepared::Ask(HostRequest::DeleteRoutine {
        id: found.id,
        name: found.name,
      }))
    }
    "tasks.run" => task_request(params, &known_profiles()?).map(Prepared::Ask),
    _ => Err(INVALID),
  }
}

fn wayfern_profiles() -> Result<Vec<crate::profile::BrowserProfile>, Refusal> {
  Ok(
    crate::profile::ProfileManager::instance()
      .list_profiles()
      .map_err(|_| FAILED)?
      .into_iter()
      .filter(|profile| profile.browser == "wayfern")
      .collect(),
  )
}

fn known_profiles() -> Result<HashSet<String>, Refusal> {
  Ok(
    wayfern_profiles()?
      .iter()
      .map(|profile| profile.id.to_string())
      .collect(),
  )
}

fn group_names() -> HashMap<String, String> {
  crate::group_manager::GROUP_MANAGER
    .lock()
    .ok()
    .and_then(|manager| manager.get_all_groups().ok())
    .unwrap_or_default()
    .into_iter()
    .map(|group| (group.id, group.name))
    .collect()
}

async fn routine(id: &str) -> Result<Routine, Refusal> {
  cloud::get_routine(id).await.map_err(|e| {
    if error_code(&e) == "AGENT_ROUTINE_NOT_FOUND" {
      NOT_FOUND
    } else {
      FAILED
    }
  })
}

/// When each routine last ran, from the cloud's run records.
async fn last_runs(routines: &[Routine]) -> HashMap<String, u64> {
  let ids: Vec<String> = routines.iter().map(|routine| routine.id.clone()).collect();
  let lists: Vec<_> = futures_util::stream::iter(ids)
    .map(|id| async move { cloud::list_runs(&id).await })
    .buffered(RUN_READS_AT_ONCE)
    .collect()
    .await;
  routines
    .iter()
    .zip(lists)
    .filter_map(|(routine, runs)| {
      let latest = runs
        .ok()?
        .iter()
        .filter_map(|run| run.created_at.as_deref())
        .filter_map(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.timestamp_millis().max(0) as u64)
        .max()?;
      Some((routine.id.clone(), latest))
    })
    .collect()
}

fn profiles_view(
  profiles: &[crate::profile::BrowserProfile],
  groups: &HashMap<String, String>,
) -> Value {
  json!({
    "profiles": profiles
      .iter()
      .map(|profile| json!({
        "id": profile.id.to_string(),
        "name": profile.name,
        "group": profile.group_id.as_ref().and_then(|id| groups.get(id)),
        "tags": profile.tags,
        "running": profile.process_id.is_some_and(crate::proxy_storage::is_process_running),
      }))
      .collect::<Vec<_>>(),
  })
}

fn routine_view(routine: &Routine, last_run_at: Option<u64>) -> Value {
  json!({
    "id": routine.id,
    "name": routine.name,
    "prompt": routine.prompt,
    "startUrl": routine.start_url,
    "profileIds": routine.profile_ids,
    "schedule": routine.schedule,
    "enabled": routine.enabled,
    "lastRunAt": last_run_at,
  })
}

fn credits_view(credits: &Credits) -> Value {
  json!({
    "balance": credits.balance,
    "allowance": credits.allowance,
    "used": credits.used,
    "periodEnd": credits.period_end,
    "unlimited": credits.unlimited,
  })
}

fn optional_text(params: &Value, key: &str) -> Result<Option<String>, Refusal> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(text)) => Ok(Some(text.clone())),
    Some(_) => Err(INVALID),
  }
}

/// The profiles a call names: Wayfern profiles of this device, each once.
fn profile_ids(params: &Value, known: &HashSet<String>) -> Result<Option<Vec<String>>, Refusal> {
  let items = match params.get("profileIds") {
    None | Some(Value::Null) => return Ok(None),
    Some(Value::Array(items)) => items,
    Some(_) => return Err(INVALID),
  };
  if items.len() > super::batch::MAX_PROFILES {
    return Err(INVALID);
  }
  let mut seen = HashSet::new();
  let mut ids = Vec::new();
  for item in items {
    let id = item.as_str().map(str::trim).ok_or(INVALID)?;
    if !known.contains(id) {
      return Err(NOT_FOUND);
    }
    if seen.insert(id) {
      ids.push(id.to_string());
    }
  }
  Ok(Some(ids))
}

fn schedule(value: &Value) -> Result<RoutineSchedule, Refusal> {
  let fields: Vec<&str> = value
    .get("cron")
    .and_then(Value::as_str)
    .ok_or(INVALID)?
    .split_whitespace()
    .collect();
  if fields.len() != 5 {
    return Err(INVALID);
  }
  // Empty is the device's zone, filled in where the person sees the card.
  let timezone = optional_text(value, "timezone")?
    .map(|zone| zone.trim().to_string())
    .unwrap_or_default();
  Ok(RoutineSchedule {
    cron: fields.join(" "),
    timezone,
  })
}

/// A routine the engine proposes. With an `id`, what it leaves out stays as
/// the routine has it.
fn save_request(
  params: &Value,
  current: Option<&Routine>,
  known: &HashSet<String>,
) -> Result<HostRequest, Refusal> {
  let name = optional_text(params, "name")?
    .or_else(|| current.map(|routine| routine.name.clone()))
    .ok_or(INVALID)?;
  let prompt = optional_text(params, "prompt")?
    .or_else(|| current.map(|routine| routine.prompt.clone()))
    .ok_or(INVALID)?;
  let start_url = match params.get("startUrl") {
    None => current.and_then(|routine| routine.start_url.clone()),
    Some(_) => optional_text(params, "startUrl")?,
  };
  let profile_ids = match profile_ids(params, known)? {
    Some(ids) => ids,
    None => current
      .map(|routine| routine.profile_ids.clone())
      .ok_or(INVALID)?,
  };
  if profile_ids.is_empty() {
    return Err(INVALID);
  }
  let schedule = match params.get("schedule") {
    None => current.and_then(|routine| routine.schedule.clone()),
    Some(Value::Null) => None,
    Some(value) => Some(schedule(value)?),
  };
  let enabled = match params.get("enabled") {
    None => current.is_none_or(|routine| routine.enabled),
    Some(Value::Bool(on)) => *on,
    Some(_) => return Err(INVALID),
  };
  // The cloud's checks; the schedule was checked above, its zone may wait.
  let checked = cloud::checked_draft(RoutineDraft {
    name,
    prompt,
    start_url,
    profile_ids,
    schedule: None,
    max_credits_per_run: current.and_then(|routine| routine.max_credits_per_run),
    concurrency: current.and_then(|routine| routine.concurrency),
    enabled,
  })
  .map_err(|_| INVALID)?;
  Ok(HostRequest::SaveRoutine {
    id: current.map(|routine| routine.id.clone()),
    routine: RoutineDraft {
      schedule,
      ..checked
    },
  })
}

fn task_request(params: &Value, known: &HashSet<String>) -> Result<HostRequest, Refusal> {
  let prompt = optional_text(params, "prompt")?.ok_or(INVALID)?;
  let start_url = optional_text(params, "startUrl")?;
  let (prompt, start_url) =
    cloud::checked_order(&prompt, start_url.as_deref()).map_err(|_| INVALID)?;
  let profile_ids = profile_ids(params, known)?
    .filter(|ids| !ids.is_empty())
    .ok_or(INVALID)?;
  Ok(HostRequest::RunTask {
    prompt,
    start_url,
    profile_ids,
  })
}

// ---- The person's answer ----

fn started(view: &BatchView) -> (Value, Outcome) {
  (
    json!({ "batchId": view.id, "profiles": view.tasks.len() }),
    Outcome {
      batch_id: Some(view.id.clone()),
      profiles: Some(view.tasks.len()),
      ..Outcome::default()
    },
  )
}

/// Do what the person approved. Errors are for the person; the card stays.
async fn execute(request: &HostRequest) -> Result<(Value, Outcome), String> {
  match request {
    HostRequest::SaveRoutine { id, routine } => {
      let saved = super::save_routine(id.as_deref(), routine.clone()).await?;
      Ok((
        json!({ "routine": routine_view(&saved, None) }),
        Outcome {
          routine_id: Some(saved.id),
          ..Outcome::default()
        },
      ))
    }
    HostRequest::RunRoutine {
      id, profile_ids, ..
    } => {
      let routine = cloud::get_routine(id).await?;
      let view = super::run_routine(routine, Some(profile_ids.clone()), None).await?;
      Ok(started(&view))
    }
    HostRequest::DeleteRoutine { id, .. } => {
      super::remove_routine(id).await?;
      Ok((
        json!({}),
        Outcome {
          routine_id: Some(id.clone()),
          ..Outcome::default()
        },
      ))
    }
    HostRequest::RunTask {
      prompt,
      start_url,
      profile_ids,
    } => {
      let (prompt, start_url) = cloud::checked_order(prompt, start_url.as_deref())?;
      let order = Order {
        prompt,
        start_url,
        autonomy: Autonomy::Ask,
        max_credits: None,
        headless: false,
      };
      let view = super::start_batch(BatchSpec::one_off(order, profile_ids.clone(), None))?;
      Ok(started(&view))
    }
  }
}

/// Calls being answered, so a second click does not do the change twice.
static ANSWERING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

struct Answering(String);

impl Answering {
  fn claim(call_id: &str) -> Result<Self, String> {
    let mut answering = ANSWERING.lock().unwrap_or_else(|p| p.into_inner());
    if !answering.insert(call_id.to_string()) {
      return Err(crate::backend_error("AGENT_BUSY"));
    }
    Ok(Self(call_id.to_string()))
  }
}

impl Drop for Answering {
  fn drop(&mut self) {
    ANSWERING
      .lock()
      .unwrap_or_else(|p| p.into_inner())
      .remove(&self.0);
  }
}

/// Record the answer in the chat and tell the engine.
async fn conclude(
  chat_id: &str,
  task_id: &str,
  call_id: &str,
  state: CallState,
  request: HostRequest,
  outcome: Option<Outcome>,
  reply_with: Result<Value, Refusal>,
) {
  let method = request.method();
  let settled = chat::update_turn(chat_id, task_id, |turn| {
    settle(turn, call_id, state, request, outcome)
  })
  .unwrap_or(false);
  if !settled {
    // The turn ended meanwhile; the engine let the call go.
    return;
  }
  log::info!(
    "Agent host call answered chat={chat_id} method={method} answer={}",
    match &reply_with {
      Ok(_) => "done",
      Err(code) => code,
    }
  );
  if let Ok((link, _)) = chat::running_turn(chat_id) {
    if let Err(e) = link
      .call(
        "Wayfern.agentHostReply",
        reply_params(task_id, call_id, reply_with),
      )
      .await
    {
      log::debug!(
        "Agent host reply not taken chat={chat_id} err={}",
        error_code(&e.code())
      );
    }
  }
}

/// The person's answer to a change in a chat: the request to do, as they
/// left it, or `None` to decline.
#[tauri::command]
pub async fn answer_agent_chat_host_call(
  chat_id: String,
  call_id: String,
  request: Option<HostRequest>,
) -> Result<(), String> {
  ensure_entitled().await?;
  let turn = chat::current_turn(&chat_id)?;
  let missing = || crate::backend_error("AGENT_TASK_NOT_FOUND");
  let task_id = turn.task.task_id.clone().ok_or_else(missing)?;
  let pending = turn
    .host_calls
    .iter()
    .find(|call| call.call_id == call_id && call.state == CallState::Pending)
    .ok_or_else(missing)?
    .request
    .clone();
  let _answering = Answering::claim(&call_id)?;
  let Some(request) = request else {
    conclude(
      &chat_id,
      &task_id,
      &call_id,
      CallState::Declined,
      pending,
      None,
      Err(DECLINED),
    )
    .await;
    return Ok(());
  };
  if !request.same_target(&pending) {
    return Err(crate::backend_error("AGENT_ACTION_INVALID"));
  }
  match execute(&request).await {
    Ok((result, outcome)) => {
      conclude(
        &chat_id,
        &task_id,
        &call_id,
        CallState::Done,
        request,
        Some(outcome),
        Ok(result),
      )
      .await;
      Ok(())
    }
    // The plan changed while the card waited.
    Err(e) if error_code(&e) == "SCHEDULED_AUTOMATION_NOT_ENTITLED" => {
      conclude(
        &chat_id,
        &task_id,
        &call_id,
        CallState::Declined,
        pending,
        None,
        Err(PLAN_REQUIRED),
      )
      .await;
      Err(e)
    }
    Err(e) => Err(e),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent_tasks::chat::Chat;

  fn known() -> HashSet<String> {
    ["p1", "p2", "p3"].iter().map(|id| id.to_string()).collect()
  }

  fn existing() -> Routine {
    serde_json::from_value(json!({
      "id": "r1",
      "name": "Fare watch",
      "prompt": "Check the fare",
      "startUrl": "https://flights.example.test",
      "profileIds": ["p1", "gone"],
      "schedule": { "cron": "0 9 * * 1-5", "timezone": "Europe/Tirane" },
      "maxCreditsPerRun": 300,
      "concurrency": 2,
      "enabled": true,
    }))
    .unwrap()
  }

  fn running_turn() -> Turn {
    let mut chat = Chat::new("p1", "Save a routine".into(), 1);
    let mut turn = chat.turns.remove(0);
    turn.task.task_id = Some("t1".into());
    turn.task.status = TaskStatus::Running;
    turn
  }

  fn card(call_id: &str) -> HostCall {
    HostCall {
      call_id: call_id.into(),
      request: HostRequest::DeleteRoutine {
        id: "r1".into(),
        name: "Fare watch".into(),
      },
      state: CallState::Pending,
      outcome: None,
      at: 1,
    }
  }

  #[test]
  fn a_new_routine_needs_its_words_and_known_profiles() {
    let request = save_request(
      &json!({
        "name": " Inbox check ",
        "prompt": "Read the inbox",
        "profileIds": ["p2", "p2", "p3"],
        "schedule": { "cron": " 0  9 * * 1-5 " },
      }),
      None,
      &known(),
    )
    .unwrap();
    let HostRequest::SaveRoutine { id, routine } = request else {
      panic!("a save");
    };
    assert_eq!(id, None);
    assert_eq!(routine.name, "Inbox check");
    assert_eq!(routine.profile_ids, vec!["p2", "p3"]);
    let schedule = routine.schedule.unwrap();
    assert_eq!(schedule.cron, "0 9 * * 1-5");
    assert_eq!(schedule.timezone, "", "the device's zone, filled in later");
    assert!(routine.enabled);

    let refused = |params: Value| save_request(&params, None, &known()).unwrap_err();
    assert_eq!(
      refused(json!({ "prompt": "x", "profileIds": ["p1"] })),
      INVALID
    );
    assert_eq!(
      refused(json!({ "name": "A", "prompt": "x", "profileIds": [] })),
      INVALID
    );
    assert_eq!(
      refused(json!({ "name": "A", "prompt": "x", "profileIds": ["p9"] })),
      NOT_FOUND
    );
    assert_eq!(
      refused(
        json!({ "name": "A", "prompt": "x", "profileIds": ["p1"], "schedule": { "cron": "daily" } })
      ),
      INVALID
    );
    assert_eq!(
      refused(json!({ "name": "A", "prompt": "x", "profileIds": ["p1"], "startUrl": "file:///x" })),
      INVALID
    );
    assert_eq!(
      refused(json!({ "name": "A", "prompt": "x", "profileIds": ["p1"], "enabled": "no" })),
      INVALID
    );
  }

  #[test]
  fn a_change_keeps_what_the_engine_left_out() {
    let current = existing();
    let HostRequest::SaveRoutine { id, routine } =
      save_request(&json!({ "enabled": false }), Some(&current), &known()).unwrap()
    else {
      panic!("a save");
    };
    assert_eq!(id.as_deref(), Some("r1"));
    assert!(!routine.enabled);
    assert_eq!(routine.name, "Fare watch");
    assert_eq!(routine.profile_ids, vec!["p1", "gone"]);
    assert_eq!(routine.schedule, current.schedule);
    assert_eq!(routine.max_credits_per_run, Some(300));
    assert_eq!(routine.concurrency, Some(2));
    assert_eq!(
      routine.start_url.as_deref(),
      Some("https://flights.example.test")
    );

    let HostRequest::SaveRoutine { routine, .. } = save_request(
      &json!({ "schedule": null, "startUrl": null, "profileIds": ["p3"] }),
      Some(&current),
      &known(),
    )
    .unwrap() else {
      panic!("a save");
    };
    assert_eq!(routine.schedule, None);
    assert_eq!(routine.start_url, None);
    assert_eq!(routine.profile_ids, vec!["p3"]);
  }

  #[test]
  fn a_task_for_other_profiles_is_checked_at_the_door() {
    assert_eq!(
      task_request(
        &json!({ "prompt": " Count the orders ", "profileIds": ["p1", "p3"] }),
        &known()
      )
      .unwrap(),
      HostRequest::RunTask {
        prompt: "Count the orders".into(),
        start_url: None,
        profile_ids: vec!["p1".into(), "p3".into()],
      }
    );
    assert_eq!(
      task_request(&json!({ "prompt": "x" }), &known()).unwrap_err(),
      INVALID
    );
    assert_eq!(
      task_request(&json!({ "prompt": "x", "profileIds": "p1" }), &known()).unwrap_err(),
      INVALID
    );
    assert_eq!(
      task_request(&json!({ "prompt": " ", "profileIds": ["p1"] }), &known()).unwrap_err(),
      INVALID
    );
  }

  #[test]
  fn a_waiting_change_holds_the_turn_until_it_is_answered() {
    let mut turn = running_turn();
    assert!(wait(&mut turn, card("c1")));
    assert!(!wait(&mut turn, card("c1")), "a call arrives once");
    assert!(wait(&mut turn, card("c2")));
    assert_eq!(turn.task.status, TaskStatus::NeedsApproval);
    let saved = HostRequest::DeleteRoutine {
      id: "r1".into(),
      name: "Fare watch".into(),
    };
    assert!(settle(
      &mut turn,
      "c1",
      CallState::Done,
      saved.clone(),
      Some(Outcome::default())
    ));
    assert_eq!(
      turn.task.status,
      TaskStatus::NeedsApproval,
      "another still waits"
    );
    assert!(!settle(
      &mut turn,
      "c1",
      CallState::Declined,
      saved.clone(),
      None
    ));
    assert!(settle(&mut turn, "c2", CallState::Declined, saved, None));
    assert_eq!(turn.task.status, TaskStatus::Running);
    assert_eq!(turn.host_calls[0].state, CallState::Done);
    assert_eq!(turn.host_calls[1].state, CallState::Declined);
  }

  #[test]
  fn an_ended_turn_drops_its_open_cards_and_takes_no_new_ones() {
    let mut turn = running_turn();
    wait(&mut turn, card("c1"));
    wait(&mut turn, card("c2"));
    settle(&mut turn, "c1", CallState::Done, card("c1").request, None);
    turn.task.status = TaskStatus::Stopped;
    drop_waiting(&mut turn);
    assert_eq!(turn.host_calls.len(), 1);
    assert_eq!(turn.host_calls[0].call_id, "c1");
    assert!(!wait(&mut turn, card("c3")));
  }

  #[test]
  fn old_answers_go_first_and_open_cards_stay() {
    let mut turn = running_turn();
    for index in 0..MAX_CALLS {
      let id = format!("c{index}");
      wait(&mut turn, card(&id));
      settle(&mut turn, &id, CallState::Done, card(&id).request, None);
    }
    wait(&mut turn, card("open"));
    assert_eq!(turn.host_calls.len(), MAX_CALLS);
    assert_eq!(turn.host_calls[0].call_id, "c1");
    assert_eq!(turn.host_calls.last().unwrap().call_id, "open");
  }

  #[test]
  fn an_edit_cannot_change_what_the_call_acts_on() {
    let delete = HostRequest::DeleteRoutine {
      id: "r1".into(),
      name: "A".into(),
    };
    let other = HostRequest::DeleteRoutine {
      id: "r2".into(),
      name: "A".into(),
    };
    let run = HostRequest::RunRoutine {
      id: "r1".into(),
      name: "A".into(),
      profile_ids: vec![],
    };
    assert!(delete.same_target(&delete));
    assert!(!delete.same_target(&other));
    assert!(!delete.same_target(&run));
  }

  #[test]
  fn calls_and_answers_have_the_contract_shapes() {
    let call = incoming(&json!({
      "taskId": "t1", "callId": "c1", "method": "routines.save", "params": { "name": "A" },
    }))
    .unwrap();
    assert_eq!(call.method, "routines.save");
    assert_eq!(call.params["name"], "A");
    assert!(incoming(&json!({ "taskId": "t1", "method": "profiles.list" })).is_none());
    assert!(
      incoming(&json!({ "taskId": "t1", "callId": "x".repeat(200), "method": "a" })).is_none()
    );

    assert_eq!(
      reply_params("t1", "c1", Ok(json!({ "routine": {} }))),
      json!({ "taskId": "t1", "callId": "c1", "result": { "routine": {} } })
    );
    assert_eq!(
      reply_params("t1", "c1", Err(DECLINED)),
      json!({ "taskId": "t1", "callId": "c1", "error": { "code": "DECLINED" } })
    );

    let wire = serde_json::to_value(HostCall {
      call_id: "c1".into(),
      request: HostRequest::RunTask {
        prompt: "p".into(),
        start_url: None,
        profile_ids: vec!["p1".into()],
      },
      state: CallState::Pending,
      outcome: None,
      at: 3,
    })
    .unwrap();
    assert_eq!(
      wire,
      json!({
        "callId": "c1",
        "request": { "method": "tasks.run", "prompt": "p", "startUrl": null, "profileIds": ["p1"] },
        "state": "pending",
        "outcome": null,
        "at": 3,
      })
    );
    let back: HostCall = serde_json::from_value(wire).unwrap();
    assert_eq!(back.call_id, "c1");

    let view = routine_view(&existing(), Some(42));
    assert_eq!(view["lastRunAt"], 42);
    assert_eq!(view["schedule"]["cron"], "0 9 * * 1-5");
    assert!(view.get("maxCreditsPerRun").is_none());
    let credits = credits_view(&Credits {
      allowance: 10,
      used: 4,
      extra: 0,
      balance: 6,
      period_end: None,
      plan: None,
      unlimited: false,
    });
    assert_eq!(credits["balance"], 6);
    assert_eq!(credits["periodEnd"], Value::Null);
  }

  #[test]
  fn profiles_are_listed_with_their_group_name() {
    let profile = crate::profile::BrowserProfile {
      name: "Shop".into(),
      browser: "wayfern".into(),
      group_id: Some("g1".into()),
      tags: vec!["eu".into()],
      ..Default::default()
    };
    let groups = HashMap::from([("g1".to_string(), "Stores".to_string())]);
    let view = profiles_view(&[profile], &groups);
    assert_eq!(view["profiles"][0]["group"], "Stores");
    assert_eq!(view["profiles"][0]["tags"], json!(["eu"]));
    assert_eq!(view["profiles"][0]["running"], false);
  }
}
