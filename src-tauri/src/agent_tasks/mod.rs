//! Agent tasks: natural-language tasks and routines that Wayfern's engine runs
//! in a profile's browser. Donut is the interface only. It mints the agent
//! token, launches the profiles, starts, steers and stops tasks over CDP,
//! records what the engine reports, and tells the cloud how each routine run
//! ended. No model is called here, and nothing is added to a prompt except a
//! chat's earlier turns when its engine task was lost.
//!
//! Everything is behind the `agent` entitlement, a rollout flag the cloud sets
//! per account on any plan. Signed out, or without it, every command refuses
//! with `AGENT_NOT_ENTITLED` and nothing reaches the cloud agent routes.

mod batch;
pub mod chat;
pub mod chat_sync;
mod cloud;
mod engine;
pub mod host;
#[cfg(feature = "e2e")]
mod mock;
mod model;
mod reports;
mod schedule;
mod token;

use batch::{Autonomy, Batch, Order, Tally};
use engine::{EngineError, EngineLink};
use model::{Approval, EngineEvent, Step, Task, TaskStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

pub use cloud::{Credits, Routine, RoutineDraft, RoutineRun};

/// Finished batches kept for the run view.
const MAX_KEPT_BATCHES: usize = 30;
/// How long a launched browser may take to open its debugging socket.
const CONNECT_PATIENCE: Duration = Duration::from_secs(20);
const TOKEN_CHECK_EVERY: Duration = Duration::from_secs(30);
const MAX_STEER_CHARS: usize = 2_000;
/// A task the engine says nothing about for this long has stalled.
const SILENCE_LIMIT_MS: u64 = 15 * 60 * 1_000;
/// How long the app waits at exit for the engines, the cloud and the browsers.
const EXIT_PATIENCE: Duration = Duration::from_secs(5);

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static TOKEN_REFRESH: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent token refresh");

/// Called once at startup: launches need the app handle.
pub fn init(app: &tauri::AppHandle) {
  let _ = APP.set(app.clone());
  chat_sync::start(app);
  schedule::start();
}

#[derive(Default)]
struct Store {
  batches: Vec<Batch>,
  links: HashMap<String, EngineLink>,
  wakers: HashMap<String, Arc<Notify>>,
  driving: HashSet<String>,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));

fn store() -> MutexGuard<'static, Store> {
  STORE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

impl Store {
  fn batch_mut(&mut self, batch_id: &str) -> Option<&mut Batch> {
    self.batches.iter_mut().find(|b| b.id == batch_id)
  }

  /// Whether a profile has an active task other than `except`.
  fn busy(&self, profile_id: &str, except: Option<(&str, usize)>) -> bool {
    self.batches.iter().any(|batch| {
      batch.tasks.iter().enumerate().any(|(index, task)| {
        task.profile_id == profile_id
          && task.status.is_active()
          && except != Some((batch.id.as_str(), index))
      })
    })
  }

  fn waker(&mut self, batch_id: &str) -> Arc<Notify> {
    self
      .wakers
      .entry(batch_id.to_string())
      .or_insert_with(|| Arc::new(Notify::new()))
      .clone()
  }

  /// Drop the oldest finished batches past the limit.
  fn trim(&mut self) {
    while self.batches.len() > MAX_KEPT_BATCHES {
      let Some(index) = self.batches.iter().position(Batch::is_finished) else {
        break;
      };
      let gone = self.batches.remove(index);
      self.wakers.remove(&gone.id);
    }
  }
}

// ---- What the window sees ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
  profile_id: String,
  task_id: Option<String>,
  run_id: Option<String>,
  status: TaskStatus,
  last_step: Option<Step>,
  step_count: usize,
  approval: Option<Approval>,
  result: Option<String>,
  error: Option<String>,
  credits_used: u64,
  started_at: Option<u64>,
  finished_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchView {
  id: String,
  routine_id: Option<String>,
  prompt: String,
  start_url: Option<String>,
  autonomy: Autonomy,
  max_credits: Option<u64>,
  headless: bool,
  concurrency: usize,
  created_at: u64,
  stopping: bool,
  finished: bool,
  tasks: Vec<TaskView>,
  tally: Tally,
}

impl From<&Task> for TaskView {
  fn from(task: &Task) -> Self {
    Self {
      profile_id: task.profile_id.clone(),
      task_id: task.task_id.clone(),
      run_id: task.run_id.clone(),
      status: task.status,
      last_step: task.steps.back().cloned(),
      step_count: task.steps.len(),
      approval: task.approval.clone(),
      result: task.result.clone(),
      error: task.error.clone(),
      credits_used: task.total_credits(),
      started_at: task.started_at,
      finished_at: task.finished_at,
    }
  }
}

impl From<&Batch> for BatchView {
  fn from(batch: &Batch) -> Self {
    Self {
      id: batch.id.clone(),
      routine_id: batch.routine_id.clone(),
      prompt: batch.order.prompt.clone(),
      start_url: batch.order.start_url.clone(),
      autonomy: batch.order.autonomy,
      max_credits: batch.order.max_credits,
      headless: batch.order.headless,
      concurrency: batch.concurrency,
      created_at: batch.created_at,
      stopping: batch.stopping,
      finished: batch.is_finished(),
      tasks: batch.tasks.iter().map(TaskView::from).collect(),
      tally: batch.tally(),
    }
  }
}

fn publish(batch: &Batch) {
  let _ = crate::events::emit("agent-batch", BatchView::from(batch));
}

// ---- Entitlement and engine support ----

async fn ensure_entitled() -> Result<(), String> {
  #[cfg(feature = "e2e")]
  if mock::active() {
    return Ok(());
  }
  match crate::cloud_auth::CLOUD_AUTH.entitlements().await {
    Some(entitlements) if entitlements.agent => Ok(()),
    _ => {
      token::clear();
      Err(crate::backend_error("AGENT_NOT_ENTITLED"))
    }
  }
}

async fn can_schedule() -> bool {
  #[cfg(feature = "e2e")]
  if mock::active() {
    return true;
  }
  crate::cloud_auth::CLOUD_AUTH
    .entitlements()
    .await
    .is_some_and(|e| e.scheduled_automation)
}

fn locale() -> String {
  crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .ok()
    .and_then(|settings| settings.language)
    .unwrap_or_else(|| "en".to_string())
}

fn configure_params(token: &token::AgentToken) -> Value {
  json!({
    "apiBase": crate::cloud_auth::CLOUD_API_URL,
    "token": token.token,
    "locale": locale(),
  })
}

fn open_links() -> Vec<EngineLink> {
  let mut store = store();
  store.links.retain(|_, link| link.is_open());
  store.links.values().cloned().collect()
}

/// The agent token. Whoever asked, a newly minted one goes to every open
/// engine link, so no browser keeps the old one.
async fn agent_token() -> Result<token::AgentToken, String> {
  let (token, minted) = token::current().await?;
  if minted {
    hand_out(configure_params(&token));
  }
  Ok(token)
}

fn hand_out(params: Value) {
  for link in open_links() {
    let params = params.clone();
    tokio::spawn(async move {
      let _ = link.call("Wayfern.agentConfigure", params).await;
    });
  }
}

/// Hand the current agent token to the engine.
async fn configure(link: &EngineLink) -> Result<(), String> {
  let token = agent_token().await?;
  let outcome = link
    .call("Wayfern.agentConfigure", configure_params(&token))
    .await;
  outcome.map(|_| ()).map_err(|e| e.code())
}

/// Keeps every open link on a valid token while any link is open.
fn ensure_token_refresher() {
  static STARTED: AtomicBool = AtomicBool::new(false);
  if STARTED.swap(true, Ordering::SeqCst) {
    return;
  }
  tokio::spawn(async {
    loop {
      tokio::time::sleep(TOKEN_CHECK_EVERY).await;
      if open_links().is_empty() {
        continue;
      }
      match agent_token().await {
        Ok(_) => TOKEN_REFRESH.succeeded(),
        Err(e) => TOKEN_REFRESH.failed(e),
      }
    }
  });
}

/// Tell an engine to drop a task Donut no longer follows.
async fn stop_engine_task(link: EngineLink, task_id: String) {
  let params = json!({ "taskId": task_id, "action": "stop" });
  let _ = link.call("Wayfern.agentControl", params).await;
}

// ---- Engine events ----

/// Whether a task of the agent works in this profile now: a chat turn or a
/// run. Only an entitled account starts one.
pub(crate) fn working_in(profile_id: &str) -> bool {
  store().busy(profile_id, None) || chat::busy(profile_id, None)
}

pub(crate) fn on_engine_event(profile_id: &str, method: &str, params: &Value) {
  if method == "Wayfern.agentHostCall" {
    host::on_call(profile_id, params);
    return;
  }
  let Some((task_id, event)) = EngineEvent::parse(method, params, now_ms()) else {
    return;
  };
  let step = match &event {
    EngineEvent::Step(step) => Some(step.clone()),
    _ => None,
  };
  let finished = {
    let mut store = store();
    let Some(batch) = store
      .batches
      .iter_mut()
      .find(|batch| batch.task_index(&task_id).is_some())
    else {
      drop(store);
      chat::on_engine_event(profile_id, &task_id, event);
      return;
    };
    let Some(index) = batch.task_index(&task_id) else {
      return;
    };
    let task = &mut batch.tasks[index];
    if task.profile_id != profile_id || !task.apply(event, now_ms()) {
      return;
    }
    let done = task.status.is_final();
    publish(batch);
    if let Some(step) = step {
      let _ = crate::events::emit(
        "agent-step",
        json!({ "batchId": batch.id, "profileId": profile_id, "taskId": task_id, "step": step }),
      );
    }
    done.then(|| (batch.id.clone(), index))
  };
  if let Some((batch_id, index)) = finished {
    finalize(&batch_id, index);
  }
}

/// The browser hung up: whatever ran there has ended.
pub(crate) fn on_link_closed(profile_id: &str) {
  let ended: Vec<(String, usize)> = {
    let mut store = store();
    store
      .links
      .retain(|id, link| id != profile_id || link.is_open());
    let now = now_ms();
    let mut ended = Vec::new();
    for batch in &mut store.batches {
      let mut changed = false;
      for (index, task) in batch.tasks.iter_mut().enumerate() {
        if task.profile_id == profile_id && task.status.is_active() && task.task_id.is_some() {
          task.fail(crate::backend_error("AGENT_BROWSER_CLOSED"), now);
          ended.push((batch.id.clone(), index));
          changed = true;
        }
      }
      if changed {
        publish(batch);
      }
    }
    ended
  };
  for (batch_id, index) in ended {
    finalize(&batch_id, index);
  }
  chat::on_link_closed(profile_id);
}

/// A task ended: log it, let the batch start the next one, tell the cloud
/// and close a browser opened for it. Called once, by whatever ended it.
fn finalize(batch_id: &str, index: usize) {
  if let Some(after) = end_task(batch_id, index) {
    tokio::spawn(after);
  }
}

/// What `finalize` does at once, and the work it leaves for after.
fn end_task(batch_id: &str, index: usize) -> Option<impl std::future::Future<Output = ()> + Send> {
  let (task, headless, waker) = {
    let mut store = store();
    let waker = store.waker(batch_id);
    let batch = store.batch_mut(batch_id)?;
    let task = batch.tasks.get(index).cloned()?;
    (task, batch.order.headless, waker)
  };
  if let Some(task_id) = &task.task_id {
    let elapsed = task
      .started_at
      .zip(task.finished_at)
      .map(|(start, end)| end.saturating_sub(start))
      .unwrap_or(0);
    log::info!(
      "Agent task finished profile={} task={task_id} batch={batch_id} status={} credits={} err={} elapsed_ms={elapsed}",
      task.profile_id,
      task.status.run_status(),
      task.total_credits(),
      task.error.as_deref().map_or_else(|| "-".to_string(), error_code)
    );
  }
  waker.notify_one();
  let report = task
    .run_id
    .clone()
    .map(|run_id| (run_id, final_report(&task)));
  let close = (task.launched_here && headless).then(|| task.profile_id.clone());
  Some(async move {
    let report = async {
      if let Some((run_id, patch)) = report {
        reports::finished(&run_id, patch).await;
      }
    };
    let close = async {
      if let Some(profile_id) = close {
        stop_browser(&profile_id).await;
      }
    };
    tokio::join!(report, close);
  })
}

/// What the cloud records when a task ends. A retry has a run of its own,
/// so the credits are this attempt's.
fn final_report(task: &Task) -> Value {
  cloud::run_patch(
    task.status.run_status(),
    task.result.as_deref(),
    task.credits_used,
    task.error.as_deref(),
  )
}

fn open_link(profile_id: &str) -> Option<EngineLink> {
  store()
    .links
    .get(profile_id)
    .filter(|link| link.is_open())
    .cloned()
}

fn load_profile(profile_id: &str) -> Result<crate::profile::BrowserProfile, String> {
  crate::profile::ProfileManager::instance()
    .list_profiles()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
    .into_iter()
    .find(|profile| profile.id.to_string() == profile_id)
    .ok_or_else(|| crate::backend_error("PROFILE_NOT_FOUND"))
}

async fn stop_browser(profile_id: &str) {
  let (Some(app), Ok(profile)) = (APP.get(), load_profile(profile_id)) else {
    return;
  };
  store().links.remove(profile_id);
  if let Err(e) = crate::browser_runner::kill_browser_profile(app.clone(), profile).await {
    log::warn!("Agent browser stop failed profile={profile_id} err=\"{e}\"");
  }
}

// ---- Starting tasks ----

/// The link to a profile's engine, launching the browser when it is not
/// running. Returns whether this call launched it.
async fn attach(
  profile: &crate::profile::BrowserProfile,
  headless: bool,
) -> Result<(EngineLink, bool), String> {
  let profile_id = profile.id.to_string();
  if let Some(link) = store()
    .links
    .get(&profile_id)
    .filter(|link| link.is_open())
    .cloned()
  {
    return Ok((link, false));
  }
  #[cfg(feature = "e2e")]
  if mock::active() {
    let link = mock::link(&profile_id);
    store().links.insert(profile_id, link.clone());
    return Ok((link, false));
  }
  let running = profile
    .process_id
    .is_some_and(crate::proxy_storage::is_process_running);
  if !running {
    let app = APP
      .get()
      .cloned()
      .ok_or_else(|| crate::backend_error("AGENT_BROWSER_UNREACHABLE"))?;
    crate::browser_runner::launch_browser_profile_impl(
      app,
      profile.clone(),
      None,
      crate::browser_runner::LaunchOptions::automation(None, headless),
    )
    .await?;
  }
  let fresh = load_profile(&profile_id)?;
  let link = match engine::connect(&fresh, CONNECT_PATIENCE).await {
    Ok(link) => link,
    Err(e) => {
      if !running && headless {
        stop_browser(&profile_id).await;
      }
      return Err(e.code());
    }
  };
  if let Err(code) = configure(&link).await {
    if !running && headless {
      stop_browser(&profile_id).await;
    }
    return Err(code);
  }
  store().links.insert(profile_id.clone(), link.clone());
  ensure_token_refresher();
  chat::stop_orphans(&profile_id, &link).await;
  Ok((link, !running))
}

fn start_params(task_id: &str, order: &Order) -> Value {
  let mut params = json!({
    "taskId": task_id,
    "prompt": order.prompt,
    "autonomy": order.autonomy.wire(),
  });
  if let Some(url) = &order.start_url {
    params["startUrl"] = Value::from(url.as_str());
  }
  if let Some(max) = order.max_credits {
    params["maxCredits"] = Value::from(max);
  }
  params
}

async fn start_task(batch_id: String, index: usize, profile_id: String, order: Order) {
  // The engine's task, or none when the task ended before the engine had it.
  let outcome: Result<Option<String>, String> = async {
    let profile = load_profile(&profile_id)?;
    if profile.browser != "wayfern" {
      return Err(crate::backend_error("AGENT_UNSUPPORTED"));
    }
    let in_a_run = store().busy(&profile_id, Some((&batch_id, index)));
    if in_a_run || chat::busy(&profile_id, None) {
      return Err(crate::backend_error("AGENT_BUSY"));
    }
    let (link, launched) = attach(&profile, order.headless).await?;
    let task_id = uuid::Uuid::new_v4().to_string();
    {
      let mut store = store();
      let Some(batch) = store.batch_mut(&batch_id) else {
        return Err(crate::backend_error("AGENT_BATCH_NOT_FOUND"));
      };
      let stopping = batch.stopping;
      let task = &mut batch.tasks[index];
      task.launched_here = launched;
      if stopping || task.status.is_final() {
        return Ok(None);
      }
      task.task_id = Some(task_id.clone());
      task.started_at = Some(now_ms());
    }
    match link
      .call("Wayfern.agentStart", start_params(&task_id, &order))
      .await
    {
      Ok(_) => Ok(Some(task_id)),
      Err(e) => {
        // No answer is not a no: the engine may have the task.
        if matches!(e, EngineError::Gone(_)) {
          tokio::spawn(stop_engine_task(link.clone(), task_id));
        }
        Err(e.code())
      }
    }
  }
  .await;

  enum Next {
    Nothing,
    Finalize,
    Report(String, u64),
    CloseBrowser,
  }
  let next = {
    let mut store = store();
    let Some(batch) = store.batch_mut(&batch_id) else {
      return;
    };
    let headless = batch.order.headless;
    let task = &mut batch.tasks[index];
    if task.status.is_final() {
      // It ended meanwhile and was finalized then; a browser launched for it
      // after that is still open.
      if matches!(outcome, Ok(None)) && task.launched_here && headless {
        Next::CloseBrowser
      } else {
        Next::Nothing
      }
    } else {
      let next = match &outcome {
        Ok(None) => {
          task.status = TaskStatus::Stopped;
          task.finished_at = Some(now_ms());
          Next::Finalize
        }
        Ok(Some(task_id)) => {
          if task.status == TaskStatus::Launching {
            task.status = TaskStatus::Running;
          }
          log::info!("Agent task started profile={profile_id} task={task_id} batch={batch_id}");
          match &task.run_id {
            Some(run_id) => Next::Report(run_id.clone(), task.credits_used),
            None => Next::Nothing,
          }
        }
        Err(code) => {
          log::warn!(
            "Agent task did not start profile={profile_id} batch={batch_id} err={}",
            error_code(code)
          );
          task.fail(code.clone(), now_ms());
          Next::Finalize
        }
      };
      publish(batch);
      next
    }
  };
  match next {
    Next::Nothing => {}
    Next::Finalize => finalize(&batch_id, index),
    Next::Report(run_id, spent) => reports::running(&run_id, spent).await,
    Next::CloseBrowser => stop_browser(&profile_id).await,
  }
}

/// The bare code out of a `{"code": ...}` string, for a log line.
fn error_code(error: &str) -> String {
  serde_json::from_str::<Value>(error)
    .ok()
    .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
    .unwrap_or_else(|| "UNKNOWN".to_string())
}

/// Start queued tasks while the batch has room, at most
/// `bulk_launch_concurrency` launching at once and `bulk_launch_delay_ms`
/// apart, as a bulk launch does.
async fn drive(batch_id: String) {
  let settings = crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .ok();
  let delay = Duration::from_millis(
    settings
      .as_ref()
      .map(|s| u64::from(s.bulk_launch_delay_ms))
      .unwrap_or(u64::from(
        crate::settings_manager::DEFAULT_BULK_LAUNCH_DELAY_MS,
      )),
  );
  let launching = Arc::new(tokio::sync::Semaphore::new(
    settings
      .as_ref()
      .map(|s| s.bulk_launch_concurrency as usize)
      .unwrap_or(crate::settings_manager::DEFAULT_BULK_LAUNCH_CONCURRENCY as usize)
      .max(1),
  ));
  let waker = store().waker(&batch_id);
  loop {
    end_silent(&batch_id);
    let next = {
      let mut store = store();
      let Some(batch) = store.batch_mut(&batch_id) else {
        break;
      };
      if batch.is_finished() {
        let tally = batch.tally();
        log::info!(
          "Agent batch finished batch={batch_id} done={} failed={} stopped={} credits={}",
          tally.done,
          tally.failed,
          tally.stopped,
          tally.credits_used
        );
        break;
      }
      let next = batch.take_next();
      if next.is_some() {
        publish(batch);
      }
      next.map(|index| {
        (
          index,
          batch.tasks[index].profile_id.clone(),
          batch.order.clone(),
        )
      })
    };
    match next {
      Some((index, profile_id, order)) => {
        let Ok(permit) = launching.clone().acquire_owned().await else {
          break;
        };
        let id = batch_id.clone();
        let wake = waker.clone();
        tokio::spawn(async move {
          start_task(id, index, profile_id, order).await;
          drop(permit);
          wake.notify_one();
        });
        tokio::time::sleep(delay).await;
      }
      None => {
        tokio::select! {
          _ = waker.notified() => {}
          _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
      }
    }
  }
  store().driving.remove(&batch_id);
}

/// End the tasks the engine has said nothing about for `SILENCE_LIMIT_MS`,
/// so the batch can finish. Their engines are told to stop them.
fn end_silent(batch_id: &str) {
  let ended: Vec<(usize, Option<(EngineLink, String)>)> = {
    let mut store = store();
    let now = now_ms();
    let Some(batch) = store.batch_mut(batch_id) else {
      return;
    };
    let silent = batch.silent(now, SILENCE_LIMIT_MS);
    if silent.is_empty() {
      return;
    }
    let ended: Vec<(usize, String, Option<String>)> = silent
      .into_iter()
      .map(|index| {
        let task = &mut batch.tasks[index];
        task.fail(crate::backend_error("AGENT_TASK_SILENT"), now);
        (index, task.profile_id.clone(), task.task_id.clone())
      })
      .collect();
    publish(batch);
    ended
      .into_iter()
      .map(|(index, profile_id, task_id)| {
        let link = store.links.get(&profile_id).cloned();
        (index, link.zip(task_id))
      })
      .collect()
  };
  for (index, engine) in ended {
    if let Some((link, task_id)) = engine {
      tokio::spawn(stop_engine_task(link, task_id));
    }
    finalize(batch_id, index);
  }
}

fn ensure_driving(batch_id: &str) {
  if store().driving.insert(batch_id.to_string()) {
    tokio::spawn(drive(batch_id.to_string()));
  }
}

struct BatchSpec {
  order: Order,
  profile_ids: Vec<String>,
  concurrency: Option<usize>,
  routine_id: Option<String>,
  cloud_batch_id: Option<String>,
  runs: HashMap<String, String>,
}

impl BatchSpec {
  /// A run that belongs to no routine.
  fn one_off(order: Order, profile_ids: Vec<String>, concurrency: Option<usize>) -> Self {
    Self {
      order,
      profile_ids,
      concurrency,
      routine_id: None,
      cloud_batch_id: None,
      runs: HashMap::new(),
    }
  }
}

fn default_concurrency() -> usize {
  crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .map(|s| s.bulk_launch_concurrency as usize)
    .unwrap_or(crate::settings_manager::DEFAULT_BULK_LAUNCH_CONCURRENCY as usize)
}

fn checked_profiles(profile_ids: Vec<String>) -> Result<Vec<String>, String> {
  let profile_ids: Vec<String> = profile_ids
    .into_iter()
    .map(|id| id.trim().to_string())
    .filter(|id| !id.is_empty())
    .collect();
  if profile_ids.is_empty() {
    return Err(crate::backend_error("AGENT_NO_PROFILES"));
  }
  if profile_ids.len() > batch::MAX_PROFILES {
    return Err(too_many_profiles(batch::MAX_PROFILES));
  }
  Ok(profile_ids)
}

pub(crate) fn too_many_profiles(max: usize) -> String {
  json!({ "code": "AGENT_TOO_MANY_PROFILES", "params": { "max": max.to_string() } }).to_string()
}

fn start_batch(spec: BatchSpec) -> Result<BatchView, String> {
  let profile_ids = checked_profiles(spec.profile_ids)?;
  let mut store = store();
  if profile_ids.iter().all(|id| store.busy(id, None)) {
    return Err(crate::backend_error("AGENT_BUSY"));
  }
  let concurrency = batch::clamp_concurrency(spec.concurrency, default_concurrency());
  let mut batch = Batch::new(
    uuid::Uuid::new_v4().to_string(),
    spec.order,
    profile_ids,
    concurrency,
    now_ms(),
  );
  batch.routine_id = spec.routine_id;
  batch.cloud_batch_id = spec.cloud_batch_id;
  for task in &mut batch.tasks {
    task.run_id = spec.runs.get(&task.profile_id).cloned();
  }
  log::info!(
    "Agent batch started batch={} profiles={} concurrency={concurrency} headless={} routine={}",
    batch.id,
    batch.tasks.len(),
    batch.order.headless,
    batch.routine_id.as_deref().unwrap_or("-")
  );
  let view = BatchView::from(&batch);
  let id = batch.id.clone();
  store.batches.push(batch);
  store.trim();
  drop(store);
  let _ = crate::events::emit("agent-batch", &view);
  ensure_driving(&id);
  Ok(view)
}

fn run_ids(started: cloud::StartedBatch) -> HashMap<String, String> {
  started
    .runs
    .into_iter()
    .map(|run| (run.profile_id, run.run_id))
    .collect()
}

/// A batch of a routine, with a run in the cloud for each profile. For a
/// scheduled fire the cloud made batch `cloud_batch_id` and its runs; else
/// they are made here, and end as failed when the batch cannot start.
async fn run_routine(
  routine: Routine,
  profile_ids: Option<Vec<String>>,
  cloud_batch_id: Option<&str>,
) -> Result<BatchView, String> {
  let profile_ids = checked_profiles(profile_ids.unwrap_or_else(|| routine.profile_ids.clone()))?;
  let (prompt, start_url) = cloud::checked_order(&routine.prompt, routine.start_url.as_deref())?;
  let started = cloud::start_runs(&routine.id, &profile_ids, cloud_batch_id).await?;
  let batch_id = started.batch_id.clone();
  let runs = run_ids(started);
  let view = start_batch(BatchSpec {
    order: Order {
      prompt,
      start_url,
      autonomy: Autonomy::Auto,
      max_credits: routine.max_credits_per_run,
      headless: true,
    },
    profile_ids,
    concurrency: routine.concurrency,
    routine_id: Some(routine.id),
    cloud_batch_id: Some(batch_id),
    runs: runs.clone(),
  });
  if let (Err(e), None) = (&view, cloud_batch_id) {
    reports::fail_runs(runs.into_values(), e).await;
  }
  view
}

/// One scheduled fire of a routine: the cloud made batch `batch_id` with a
/// run for each profile. A fire that cannot run ends those runs as failed,
/// with the reason.
pub(crate) async fn run_scheduled_fire(routine_id: &str, batch_id: &str) -> Result<Value, String> {
  let outcome = async {
    ensure_entitled().await?;
    let routine = cloud::get_routine(routine_id).await?;
    log::info!("Agent routine fired routine={routine_id} batch={batch_id}");
    run_routine(routine, None, Some(batch_id)).await
  }
  .await;
  match outcome {
    Ok(view) => Ok(json!({ "batchId": view.id, "profiles": view.tasks.len() })),
    Err(e) => {
      log::warn!(
        "Agent routine fire refused routine={routine_id} batch={batch_id} err={}",
        error_code(&e)
      );
      if let Ok(started) = cloud::start_runs(routine_id, &[], Some(batch_id)).await {
        reports::fail_runs(run_ids(started).into_values(), &e).await;
      }
      Err(e)
    }
  }
}

/// A routine the cloud fired on its schedule, over the remote bridge.
pub(crate) async fn run_routine_from_cloud(params: &Value) -> Result<Value, String> {
  let field = |name: &str| params.get(name).and_then(Value::as_str);
  let routine_id =
    field("routineId").ok_or_else(|| crate::backend_error("AGENT_ROUTINE_NOT_FOUND"))?;
  let batch_id = field("batchId").ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
  run_scheduled_fire(routine_id, batch_id).await
}

// ---- Commands ----

#[tauri::command]
pub async fn get_agent_credits() -> Result<Credits, String> {
  ensure_entitled().await?;
  cloud::credits().await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
  profile_ids: Vec<String>,
  prompt: String,
  #[serde(default)]
  start_url: Option<String>,
  #[serde(default)]
  autonomy: Autonomy,
  #[serde(default)]
  max_credits: Option<u64>,
  #[serde(default)]
  concurrency: Option<usize>,
}

#[tauri::command]
pub async fn start_agent_batch(request: TaskRequest) -> Result<BatchView, String> {
  ensure_entitled().await?;
  let (prompt, start_url) = cloud::checked_order(&request.prompt, request.start_url.as_deref())?;
  if request.max_credits == Some(0) {
    return Err(crate::backend_error("AGENT_ROUTINE_INVALID"));
  }
  start_batch(BatchSpec::one_off(
    Order {
      prompt,
      start_url,
      autonomy: request.autonomy,
      max_credits: request.max_credits,
      headless: false,
    },
    request.profile_ids,
    request.concurrency,
  ))
}

#[tauri::command]
pub async fn list_agent_batches() -> Result<Vec<BatchView>, String> {
  ensure_entitled().await?;
  Ok(store().batches.iter().rev().map(BatchView::from).collect())
}

#[tauri::command]
pub async fn get_agent_task_steps(
  batch_id: String,
  profile_id: String,
) -> Result<Vec<Step>, String> {
  ensure_entitled().await?;
  let store = store();
  store
    .batches
    .iter()
    .find(|b| b.id == batch_id)
    .and_then(|b| b.tasks.iter().find(|t| t.profile_id == profile_id))
    .map(|task| task.steps.iter().cloned().collect())
    .ok_or_else(|| crate::backend_error("AGENT_TASK_NOT_FOUND"))
}

/// The link and engine task of a profile's active task in a batch.
fn active_task(batch_id: &str, profile_id: &str) -> Result<(EngineLink, String), String> {
  let store = store();
  let task = store
    .batches
    .iter()
    .find(|b| b.id == batch_id)
    .and_then(|b| b.tasks.iter().find(|t| t.profile_id == profile_id))
    .filter(|t| t.status.is_active())
    .ok_or_else(|| crate::backend_error("AGENT_TASK_NOT_FOUND"))?;
  let task_id = task
    .task_id
    .clone()
    .ok_or_else(|| crate::backend_error("AGENT_TASK_NOT_FOUND"))?;
  let link = store
    .links
    .get(profile_id)
    .filter(|link| link.is_open())
    .cloned()
    .ok_or_else(|| crate::backend_error("AGENT_BROWSER_UNREACHABLE"))?;
  Ok((link, task_id))
}

fn set_status(batch_id: &str, profile_id: &str, status: TaskStatus) {
  let ended = {
    let mut store = store();
    let Some(batch) = store.batch_mut(batch_id) else {
      return;
    };
    let Some(index) = batch.tasks.iter().position(|t| t.profile_id == profile_id) else {
      return;
    };
    let task = &mut batch.tasks[index];
    if task.status.is_final() {
      return;
    }
    let now = now_ms();
    task.status = status;
    task.heard_at = Some(now);
    if status.is_final() {
      task.finished_at = Some(now);
    }
    publish(batch);
    status.is_final().then_some(index)
  };
  if let Some(index) = ended {
    finalize(batch_id, index);
  }
}

fn checked_steer(message: Option<String>) -> Result<String, String> {
  let message = message.unwrap_or_default().trim().to_string();
  if message.is_empty() {
    return Err(crate::backend_error("AGENT_NOTE_EMPTY"));
  }
  if message.chars().count() > MAX_STEER_CHARS {
    return Err(
      json!({ "code": "AGENT_TEXT_TOO_LONG", "params": { "max": MAX_STEER_CHARS.to_string() } })
        .to_string(),
    );
  }
  Ok(message)
}

#[tauri::command]
pub async fn control_agent_task(
  batch_id: String,
  profile_id: String,
  action: String,
  message: Option<String>,
) -> Result<(), String> {
  ensure_entitled().await?;
  let mut params = match action.as_str() {
    "pause" | "resume" | "stop" => json!({}),
    "steer" => json!({ "message": checked_steer(message)? }),
    _ => return Err(crate::backend_error("AGENT_ACTION_INVALID")),
  };
  let (link, task_id) = active_task(&batch_id, &profile_id)?;
  params["taskId"] = Value::from(task_id);
  params["action"] = Value::from(action.as_str());
  match link.call("Wayfern.agentControl", params).await {
    Ok(_) => {
      match action.as_str() {
        "pause" => set_status(&batch_id, &profile_id, TaskStatus::Paused),
        "resume" => set_status(&batch_id, &profile_id, TaskStatus::Running),
        _ => {}
      }
      Ok(())
    }
    // A browser that cannot hear the stop has stopped the task anyway.
    Err(EngineError::Gone(_)) if action == "stop" => {
      set_status(&batch_id, &profile_id, TaskStatus::Stopped);
      Ok(())
    }
    Err(e) => Err(e.code()),
  }
}

#[tauri::command]
pub async fn answer_agent_approval(
  batch_id: String,
  profile_id: String,
  approval_id: String,
  approve: bool,
  text: Option<String>,
) -> Result<(), String> {
  ensure_entitled().await?;
  let (link, task_id) = active_task(&batch_id, &profile_id)?;
  let mut params = json!({ "taskId": task_id, "approvalId": approval_id, "approve": approve });
  if let Some(text) = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
    params["text"] = Value::from(checked_steer(Some(text))?);
  }
  link
    .call("Wayfern.agentAnswer", params)
    .await
    .map_err(|e| e.code())?;
  let mut store = store();
  if let Some(batch) = store.batch_mut(&batch_id) {
    if let Some(task) = batch.tasks.iter_mut().find(|t| t.profile_id == profile_id) {
      if task.answered(&approval_id, now_ms()) {
        publish(batch);
      }
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn stop_agent_batch(batch_id: String) -> Result<(), String> {
  ensure_entitled().await?;
  let (running, queued) = {
    let mut store = store();
    let batch = store
      .batch_mut(&batch_id)
      .ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
    let stopped = batch.stop_all(now_ms());
    publish(batch);
    stopped
  };
  log::info!(
    "Agent batch stopping batch={batch_id} running={} queued={}",
    running.len(),
    queued.len()
  );
  for index in queued {
    finalize(&batch_id, index);
  }
  for (profile_id, _) in running {
    let batch_id = batch_id.clone();
    tokio::spawn(async move {
      let _ = control_agent_task(batch_id, profile_id, "stop".to_string(), None).await;
    });
  }
  if let Some(waker) = store().wakers.get(&batch_id) {
    waker.notify_one();
  }
  Ok(())
}

#[tauri::command]
pub async fn retry_agent_batch(batch_id: String) -> Result<usize, String> {
  ensure_entitled().await?;
  let (routine_id, failed) = {
    let store = store();
    let batch = store
      .batches
      .iter()
      .find(|b| b.id == batch_id)
      .ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
    (batch.routine_id.clone(), batch.failed_profiles())
  };
  // The cloud has a routine's failed runs as ended: each new attempt gets a
  // run of its own.
  let mut runs = match routine_id {
    Some(routine_id) if !failed.is_empty() => {
      run_ids(cloud::start_runs(&routine_id, &failed, None).await?)
    }
    _ => HashMap::new(),
  };
  let count = {
    let mut store = store();
    store.batch_mut(&batch_id).map(|batch| {
      let requeued = batch.retry_failed();
      for &index in &requeued {
        let task = &mut batch.tasks[index];
        task.run_id = runs.remove(&task.profile_id);
      }
      publish(batch);
      requeued.len()
    })
  };
  // Runs no task took: the batch went, or another retry took the task.
  if !runs.is_empty() {
    let error = crate::backend_error("AGENT_TASK_NOT_FOUND");
    reports::fail_runs(runs.into_values(), &error).await;
  }
  let count = count.ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
  if count > 0 {
    log::info!("Agent batch retrying batch={batch_id} tasks={count}");
    ensure_driving(&batch_id);
  }
  Ok(count)
}

#[tauri::command]
pub async fn dismiss_agent_batch(batch_id: String) -> Result<(), String> {
  ensure_entitled().await?;
  let mut store = store();
  let index = store
    .batches
    .iter()
    .position(|b| b.id == batch_id)
    .ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
  if !store.batches[index].is_finished() {
    return Err(crate::backend_error("AGENT_BUSY"));
  }
  store.batches.remove(index);
  store.wakers.remove(&batch_id);
  Ok(())
}

#[tauri::command]
pub async fn list_agent_routines() -> Result<Vec<Routine>, String> {
  ensure_entitled().await?;
  let routines = cloud::list_routines().await?;
  schedule::observe(&routines);
  Ok(routines)
}

/// Create a routine (`id` none) or change one. Schedules need the plan.
async fn save_routine(id: Option<&str>, draft: RoutineDraft) -> Result<Routine, String> {
  if draft.schedule.is_some() && !can_schedule().await {
    return Err(crate::backend_error("SCHEDULED_AUTOMATION_NOT_ENTITLED"));
  }
  let saved = match id {
    Some(id) => cloud::update_routine(id, draft).await?,
    None => cloud::create_routine(draft).await?,
  };
  schedule::changed();
  let _ = crate::events::emit_empty("agent-routines-changed");
  Ok(saved)
}

async fn remove_routine(id: &str) -> Result<(), String> {
  cloud::delete_routine(id).await?;
  schedule::changed();
  let _ = crate::events::emit_empty("agent-routines-changed");
  Ok(())
}

#[tauri::command]
pub async fn create_agent_routine(routine: RoutineDraft) -> Result<Routine, String> {
  ensure_entitled().await?;
  save_routine(None, routine).await
}

#[tauri::command]
pub async fn update_agent_routine(id: String, routine: RoutineDraft) -> Result<Routine, String> {
  ensure_entitled().await?;
  save_routine(Some(&id), routine).await
}

#[tauri::command]
pub async fn delete_agent_routine(id: String) -> Result<(), String> {
  ensure_entitled().await?;
  remove_routine(&id).await
}

#[tauri::command]
pub async fn list_agent_routine_runs(id: String) -> Result<Vec<RoutineRun>, String> {
  ensure_entitled().await?;
  cloud::list_runs(&id).await
}

#[tauri::command]
pub async fn run_agent_routine(
  id: String,
  profile_ids: Option<Vec<String>>,
) -> Result<BatchView, String> {
  ensure_entitled().await?;
  let routine = cloud::get_routine(&id).await?;
  run_routine(routine, profile_ids, None).await
}

/// The app quits: every task ends as stopped, its engine is told to stop
/// it, the cloud hears how each routine run ended, and the browsers opened
/// for routines close. Waits at most `EXIT_PATIENCE`.
pub async fn shutdown() {
  let (engines, stopped) = {
    let mut store = store();
    let now = now_ms();
    let mut engines = Vec::new();
    let mut stopped = Vec::new();
    for batch in &mut store.batches {
      for index in batch.end_all(now) {
        if let Some(task_id) = &batch.tasks[index].task_id {
          engines.push((batch.tasks[index].profile_id.clone(), task_id.clone()));
        }
        stopped.push((batch.id.clone(), index));
      }
    }
    let engines: Vec<(EngineLink, String)> = engines
      .into_iter()
      .filter_map(|(profile_id, task_id)| {
        let link = store.links.get(&profile_id).filter(|l| l.is_open())?;
        Some((link.clone(), task_id))
      })
      .collect();
    (engines, stopped)
  };
  let chats = chat::stop_running();
  if stopped.is_empty() && chats.is_empty() {
    return;
  }
  log::info!(
    "Agent tasks stopping at exit tasks={} chats={}",
    stopped.len(),
    chats.len()
  );
  let mut work: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> = Vec::new();
  for (link, task_id) in engines.into_iter().chain(chats) {
    work.push(Box::pin(stop_engine_task(link, task_id)));
  }
  for (batch_id, index) in stopped {
    if let Some(after) = end_task(&batch_id, index) {
      work.push(Box::pin(after));
    }
  }
  if tokio::time::timeout(EXIT_PATIENCE, futures_util::future::join_all(work))
    .await
    .is_err()
  {
    log::warn!(
      "Agent tasks stop at exit cut short elapsed_ms={}",
      EXIT_PATIENCE.as_millis()
    );
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_retry_reports_its_own_credits_on_its_own_run() {
    let mut task = Task::queued("p1".into());
    task.run_id = Some("r1".into());
    task.credits_used = 12;
    task.fail("AGENT_BUSY".into(), 1);
    task.requeue();
    assert!(task.run_id.is_none());
    task.run_id = Some("r2".into());
    task.credits_used = 30;
    task.status = TaskStatus::Done;
    task.result = Some("Found it".into());
    assert_eq!(
      final_report(&task),
      json!({ "status": "done", "creditsUsed": 30, "summary": "Found it" })
    );
    assert_eq!(TaskView::from(&task).credits_used, 42);
  }

  #[test]
  fn a_run_report_fits_what_the_cloud_takes() {
    let mut task = Task::queued("p1".into());
    task.fail("é".repeat(4_000), 1);
    task.result = Some("ü".repeat(12_000));
    let patch = final_report(&task);
    assert_eq!(patch["error"].as_str().unwrap().chars().count(), 2_000);
    assert_eq!(patch["summary"].as_str().unwrap().chars().count(), 10_000);
  }

  #[tokio::test]
  async fn a_new_token_reaches_every_open_link() {
    let (first, mut first_rx) = EngineLink::channel();
    let (second, mut second_rx) = EngineLink::channel();
    store().links.insert("token-a".into(), first);
    store().links.insert("token-b".into(), second);
    hand_out(json!({ "token": "t2" }));
    for rx in [&mut first_rx, &mut second_rx] {
      let request = rx.recv().await.unwrap();
      assert_eq!(request.method, "Wayfern.agentConfigure");
      assert_eq!(request.params["token"], "t2");
    }
    store().links.retain(|id, _| !id.starts_with("token-"));
  }

  #[test]
  fn a_start_carries_only_what_was_asked() {
    let order = Order {
      prompt: "Find the cheapest flight".into(),
      start_url: Some("https://example.com".into()),
      autonomy: Autonomy::Auto,
      max_credits: Some(300),
      headless: true,
    };
    assert_eq!(
      start_params("t1", &order),
      json!({
        "taskId": "t1",
        "prompt": "Find the cheapest flight",
        "autonomy": "auto",
        "startUrl": "https://example.com",
        "maxCredits": 300,
      })
    );
    let bare = Order {
      start_url: None,
      max_credits: None,
      autonomy: Autonomy::Ask,
      ..order
    };
    let params = start_params("t2", &bare);
    assert!(params.get("startUrl").is_none() && params.get("maxCredits").is_none());
    assert_eq!(params["autonomy"], "ask");
  }

  #[test]
  fn a_steer_needs_words_and_a_bound() {
    assert!(checked_steer(None)
      .unwrap_err()
      .contains("AGENT_NOTE_EMPTY"));
    assert!(checked_steer(Some("   ".into()))
      .unwrap_err()
      .contains("AGENT_NOTE_EMPTY"));
    assert!(checked_steer(Some("x".repeat(MAX_STEER_CHARS + 1)))
      .unwrap_err()
      .contains("AGENT_TEXT_TOO_LONG"));
    assert_eq!(
      checked_steer(Some(" Use the second card ".into())).unwrap(),
      "Use the second card"
    );
  }

  #[test]
  fn a_batch_needs_profiles() {
    assert!(checked_profiles(vec![" ".into()])
      .unwrap_err()
      .contains("AGENT_NO_PROFILES"));
    assert!(
      checked_profiles((0..=batch::MAX_PROFILES).map(|i| i.to_string()).collect())
        .unwrap_err()
        .contains("AGENT_TOO_MANY_PROFILES")
    );
    assert_eq!(
      checked_profiles(vec![" a ".into()]).unwrap(),
      vec!["a".to_string()]
    );
  }

  #[test]
  fn the_window_sees_the_last_step_and_the_totals() {
    let mut batch = Batch::new(
      "b".into(),
      Order {
        prompt: "p".into(),
        start_url: None,
        autonomy: Autonomy::Ask,
        max_credits: None,
        headless: false,
      },
      vec!["p1".into(), "p2".into()],
      2,
      0,
    );
    batch.tasks[0].task_id = Some("t1".into());
    batch.tasks[0].status = TaskStatus::Running;
    for index in 0..3 {
      batch.tasks[0].apply(
        EngineEvent::Step(Step {
          index: Some(index),
          kind: "act".into(),
          text: format!("step {index}"),
          url: None,
          tool: None,
          at: 0,
        }),
        0,
      );
    }
    let view = BatchView::from(&batch);
    assert_eq!(view.tasks[0].step_count, 3);
    assert_eq!(view.tasks[0].last_step.as_ref().unwrap().text, "step 2");
    assert_eq!(view.tally.active, 1);
    assert_eq!(view.tally.queued, 1);
    let wire = serde_json::to_value(&view).unwrap();
    assert_eq!(wire["tasks"][0]["status"], "running");
    assert!(
      wire["tasks"][0].get("steps").is_none(),
      "steps travel on their own"
    );
  }

  #[test]
  fn an_error_code_is_read_back_for_the_log() {
    assert_eq!(error_code(r#"{"code":"AGENT_BUSY"}"#), "AGENT_BUSY");
    assert_eq!(error_code("plain words"), "UNKNOWN");
  }
}
