//! A stand-in for Wayfern's agent engine and the cloud agent routes, for the
//! native E2E suites only. On when the e2e build runs under automation with
//! `DONUT_E2E_AGENT_ENGINE=mock`. It grants the entitlement, answers the CDP
//! surface of the contract with a scripted task, and keeps routines and runs
//! in memory.
//!
//! The script follows markers in the prompt: `[approval]` asks before the
//! form step, `[fail]` fails on the third step, `[slow]` paces steps slowly
//! enough to watch, `[mixed]` gives each task of a run its own pace and
//! ending: some fail, one in nine asks, the rest finish, and `[markdown]`
//! answers with a formatted result.
//!
//! `Wayfern.agentMessage` continues the last task with a shorter script whose
//! steps and credits go on from where the task was. A message with `[old]`
//! answers as a Wayfern without the method, one with `[replaced]` as an
//! engine that no longer knows the task.

use super::cloud::{Credits, Routine, RoutineDraft, RoutineRun, StartedBatch, StartedRun};
use super::engine::{EngineError, EngineLink, Request};
use super::token::AgentToken;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;

pub fn active() -> bool {
  crate::e2e_automation_enabled()
    && std::env::var("DONUT_E2E_AGENT_ENGINE").is_ok_and(|value| value == "mock")
}

pub fn token() -> AgentToken {
  AgentToken {
    token: "e2e-agent-token".to_string(),
    expires_at: crate::proxy_manager::now_secs() + 900,
  }
}

static ROUTINES: Mutex<Vec<Routine>> = Mutex::new(Vec::new());
static RUNS: Mutex<Vec<(String, RoutineRun)>> = Mutex::new(Vec::new());
/// How many `[mixed]` tasks started, so each one gets its own script.
static MIXED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const ALLOWANCE: i64 = 10_000;
const ALREADY_USED: i64 = 1_250;

pub fn credits() -> Credits {
  let spent: i64 = RUNS
    .lock()
    .map(|runs| {
      runs
        .iter()
        .filter_map(|(_, run)| run.credits_used)
        .map(|n| n as i64)
        .sum()
    })
    .unwrap_or(0);
  let used = ALREADY_USED + spent;
  Credits {
    allowance: ALLOWANCE,
    used,
    extra: 0,
    balance: ALLOWANCE - used,
    period_end: Some("2026-12-01T00:00:00Z".to_string()),
    plan: Some("free".to_string()),
    unlimited: false,
  }
}

pub fn routines() -> Vec<Routine> {
  ROUTINES.lock().map(|list| list.clone()).unwrap_or_default()
}

pub fn routine(id: &str) -> Result<Routine, String> {
  routines()
    .into_iter()
    .find(|routine| routine.id == id)
    .ok_or_else(|| crate::backend_error("AGENT_ROUTINE_NOT_FOUND"))
}

pub fn save_routine(id: Option<String>, draft: RoutineDraft) -> Routine {
  let now = chrono::Utc::now().to_rfc3339();
  let mut list = ROUTINES.lock().unwrap_or_else(|p| p.into_inner());
  let existing = id
    .as_deref()
    .and_then(|id| list.iter().position(|r| r.id == id));
  let routine = Routine {
    id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    name: draft.name,
    prompt: draft.prompt,
    start_url: draft.start_url,
    profile_ids: draft.profile_ids,
    schedule: draft.schedule,
    max_credits_per_run: draft.max_credits_per_run,
    concurrency: draft.concurrency,
    enabled: draft.enabled,
    created_at: existing
      .and_then(|index| list[index].created_at.clone())
      .or_else(|| Some(now.clone())),
    updated_at: Some(now),
  };
  match existing {
    Some(index) => list[index] = routine.clone(),
    None => list.push(routine.clone()),
  }
  routine
}

pub fn delete_routine(id: &str) -> Result<(), String> {
  let mut list = ROUTINES.lock().unwrap_or_else(|p| p.into_inner());
  let before = list.len();
  list.retain(|routine| routine.id != id);
  if list.len() == before {
    return Err(crate::backend_error("AGENT_ROUTINE_NOT_FOUND"));
  }
  Ok(())
}

pub fn runs(routine_id: &str) -> Vec<RoutineRun> {
  RUNS
    .lock()
    .map(|runs| {
      runs
        .iter()
        .rev()
        .filter(|(owner, _)| owner == routine_id)
        .map(|(_, run)| run.clone())
        .collect()
    })
    .unwrap_or_default()
}

pub fn start_runs(
  routine_id: &str,
  profile_ids: &[String],
  batch_id: Option<&str>,
) -> StartedBatch {
  let batch_id = batch_id
    .map(str::to_string)
    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
  let now = chrono::Utc::now().to_rfc3339();
  let mut runs = RUNS.lock().unwrap_or_else(|p| p.into_inner());
  let started = profile_ids
    .iter()
    .map(|profile_id| {
      let run_id = uuid::Uuid::new_v4().to_string();
      runs.push((
        routine_id.to_string(),
        RoutineRun {
          run_id: run_id.clone(),
          batch_id: Some(batch_id.clone()),
          profile_id: Some(profile_id.clone()),
          status: "queued".to_string(),
          summary: None,
          credits_used: None,
          error: None,
          created_at: Some(now.clone()),
          finished_at: None,
        },
      ));
      StartedRun {
        run_id,
        profile_id: profile_id.clone(),
      }
    })
    .collect();
  StartedBatch {
    batch_id,
    runs: started,
  }
}

pub fn report_run(run_id: &str, patch: Value) {
  let mut runs = RUNS.lock().unwrap_or_else(|p| p.into_inner());
  if let Some((_, run)) = runs.iter_mut().find(|(_, run)| run.run_id == run_id) {
    if let Some(status) = patch.get("status").and_then(Value::as_str) {
      run.status = status.to_string();
      if status != "running" {
        run.finished_at = Some(chrono::Utc::now().to_rfc3339());
      }
    }
    run.summary = patch
      .get("summary")
      .and_then(Value::as_str)
      .map(str::to_string)
      .or(run.summary.take());
    run.error = patch
      .get("error")
      .and_then(Value::as_str)
      .map(str::to_string)
      .or(run.error.take());
    run.credits_used = patch
      .get("creditsUsed")
      .and_then(Value::as_u64)
      .or(run.credits_used);
  }
}

enum Control {
  Pause,
  Resume,
  Stop,
  Steer(String),
  Answer(bool),
}

/// A link that answers like an engine would.
pub fn link(profile_id: &str) -> EngineLink {
  let (link, rx) = EngineLink::channel();
  tokio::spawn(pump(profile_id.to_string(), rx));
  link
}

async fn pump(profile_id: String, mut rx: mpsc::Receiver<Request>) {
  let mut control: Option<mpsc::UnboundedSender<Control>> = None;
  let mut last_task: Option<String> = None;
  while let Some(request) = rx.recv().await {
    let running = control.as_ref().filter(|tx| !tx.is_closed());
    let param = |key: &str| {
      request
        .params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
    };
    let reply = match request.method.as_str() {
      "Wayfern.agentConfigure" => Ok(json!({})),
      "Wayfern.agentStart" if running.is_some() => Err(EngineError::Coded("AGENT_BUSY".into())),
      "Wayfern.agentStart" => {
        let (tx, rx) = mpsc::unbounded_channel();
        control = Some(tx);
        last_task = Some(param("taskId"));
        tokio::spawn(script(profile_id.clone(), request.params.clone(), rx));
        Ok(json!({ "taskId": request.params.get("taskId").cloned().unwrap_or(Value::Null) }))
      }
      "Wayfern.agentMessage" if param("text").contains("[old]") => Err(EngineError::Unsupported),
      "Wayfern.agentMessage"
        if param("text").contains("[replaced]")
          || last_task.as_deref() != Some(param("taskId").as_str()) =>
      {
        Err(EngineError::Coded("AGENT_TASK_UNKNOWN".into()))
      }
      "Wayfern.agentMessage" if running.is_some() => Err(EngineError::Coded("AGENT_BUSY".into())),
      "Wayfern.agentMessage" => {
        let (tx, rx) = mpsc::unbounded_channel();
        control = Some(tx);
        let mut params = json!({
          "taskId": param("taskId"),
          "prompt": param("text"),
          "followUp": true,
        });
        params["startUrl"] = Value::Null;
        tokio::spawn(script(profile_id.clone(), params, rx));
        Ok(json!({}))
      }
      "Wayfern.agentControl" | "Wayfern.agentAnswer" => match running {
        None => Err(EngineError::Coded("AGENT_TASK_NOT_FOUND".into())),
        Some(tx) => {
          let params = &request.params;
          let message = if request.method == "Wayfern.agentAnswer" {
            Control::Answer(params.get("approve").and_then(Value::as_bool) == Some(true))
          } else {
            match params.get("action").and_then(Value::as_str) {
              Some("pause") => Control::Pause,
              Some("resume") => Control::Resume,
              Some("steer") => Control::Steer(
                params
                  .get("message")
                  .and_then(Value::as_str)
                  .unwrap_or_default()
                  .to_string(),
              ),
              _ => Control::Stop,
            }
          };
          let _ = tx.send(message);
          Ok(json!({}))
        }
      },
      _ => Err(EngineError::Unsupported),
    };
    let _ = request.reply.send(reply);
  }
}

const FOLLOW_UP: [(&str, &str); 3] = [
  ("think", "Reading the follow-up"),
  ("act", "Opening the second result"),
  ("observe", "The details page lists the baggage rules"),
];

const MARKDOWN_RESULT: &str = "**Three fares** match. The cheapest is first:\n\n\
| Flight | Departs | Fare |\n|---|---|---|\n| TP 1235 | 09:40 | €89 |\n| W6 4471 | 13:15 | €104 |\n| FR 8812 | 18:05 | €131 |\n\n\
- Prices include one cabin bag\n- [Fare rules](https://flights.example.test/rules)\n\n\
```\nTIA → LIS · Fri 14 Nov\n```";

const FOLLOW_UP_RESULT: &str =
  "The **TP 1235** fare allows *one* checked bag of 23 kg for €35 more.\n\n1. Cabin bag: included\n2. Checked bag: €35";

/// Credits each mock task has spent so far, so a follow-up goes on counting.
static SPENT: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());
/// Follow-ups so far, so their step indices never meet earlier ones.
static FOLLOW_UPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn spent(task_id: &str) -> u64 {
  SPENT
    .lock()
    .ok()
    .and_then(|list| list.iter().find(|(id, _)| id == task_id).map(|(_, n)| *n))
    .unwrap_or(0)
}

fn remember_spent(task_id: &str, credits: u64) {
  let mut list = SPENT.lock().unwrap_or_else(|p| p.into_inner());
  list.retain(|(id, _)| id != task_id);
  list.push((task_id.to_string(), credits));
}

const SCRIPT: [(&str, &str); 6] = [
  ("think", "Reading the task and planning the steps"),
  ("act", "Opening the start page"),
  ("observe", "The page loaded and shows a sign-in form"),
  ("act", "Filling in the search field"),
  ("observe", "Three results match the request"),
  ("think", "Comparing the results"),
];

async fn script(profile_id: String, params: Value, mut control: mpsc::UnboundedReceiver<Control>) {
  let task_id = params
    .get("taskId")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let prompt = params
    .get("prompt")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let start_url = params.get("startUrl").cloned().unwrap_or(Value::Null);
  let mixed = prompt
    .contains("[mixed]")
    .then(|| MIXED.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
  let pace = match mixed {
    Some(nth) => Duration::from_millis(900 + nth * 389 % 1_800),
    None if prompt.contains("[slow]") => Duration::from_millis(1_500),
    None => Duration::from_millis(200),
  };
  let fails = prompt.contains("[fail]") || mixed.is_some_and(|nth| nth % 7 == 4);
  let asks = prompt.contains("[approval]") || mixed.is_some_and(|nth| nth % 9 == 2);
  let follow_up = params.get("followUp").and_then(Value::as_bool) == Some(true);
  let script: &[(&str, &str)] = if follow_up { &FOLLOW_UP } else { &SCRIPT };
  let answer = if follow_up {
    FOLLOW_UP_RESULT
  } else if prompt.contains("[markdown]") {
    MARKDOWN_RESULT
  } else {
    "Three results found; the cheapest is listed first."
  };
  let emit = |method: &str, mut payload: Value| {
    payload["taskId"] = Value::from(task_id.as_str());
    super::on_engine_event(&profile_id, method, &payload);
  };
  let finish = |status: &str, credits: u64, result: Option<&str>, error: Option<&str>| {
    remember_spent(&task_id, credits);
    let mut payload = json!({ "status": status, "creditsUsed": credits });
    if let Some(result) = result {
      payload["result"] = Value::from(result);
    }
    if let Some(error) = error {
      payload["error"] = Value::from(error);
    }
    emit("Wayfern.agentFinished", payload);
  };
  let mut index = if follow_up {
    1_000 * (1 + FOLLOW_UPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
  } else {
    0
  };
  let mut credits = spent(&task_id);
  let mut paused = false;
  for (position, (kind, text)) in script.iter().enumerate() {
    loop {
      tokio::select! {
        message = control.recv() => match message {
          None | Some(Control::Stop) => return finish("stopped", credits, None, None),
          Some(Control::Pause) => paused = true,
          Some(Control::Resume) => paused = false,
          Some(Control::Steer(message)) => {
            emit("Wayfern.agentStep", json!({ "index": index, "kind": "observe", "text": format!("Noted: {message}") }));
            index += 1;
          }
          Some(Control::Answer(_)) => {}
        },
        _ = tokio::time::sleep(pace), if !paused => break,
      }
    }
    let mut step = json!({ "index": index, "kind": kind, "text": text });
    if position == 1 && !follow_up {
      step["url"] = start_url.clone();
      step["tool"] = Value::from("navigate");
    }
    emit("Wayfern.agentStep", step);
    index += 1;
    credits += 7;
    emit("Wayfern.agentCredits", json!({ "creditsUsed": credits }));
    if position == 2 && fails && !follow_up {
      return finish("failed", credits, None, Some("The page did not load"));
    }
    if position == 3 && asks && !follow_up {
      emit(
        "Wayfern.agentApproval",
        json!({ "approvalId": format!("{task_id}-a1"), "question": "Submit the search form on this page?" }),
      );
      loop {
        match control.recv().await {
          None | Some(Control::Stop) | Some(Control::Answer(false)) => {
            return finish("stopped", credits, None, None)
          }
          Some(Control::Answer(true)) => break,
          Some(_) => {}
        }
      }
    }
  }
  finish("done", credits, Some(answer), None);
}
