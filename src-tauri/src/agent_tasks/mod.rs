//! Agent tasks: natural-language tasks and routines that Wayfern's engine runs
//! in a profile's browser. Donut is the interface only. It mints the agent
//! token, launches the profiles, starts, steers and stops tasks over CDP,
//! records what the engine reports, and tells the cloud how each routine run
//! ended. No prompt is written, and no model is called, here.
//!
//! Everything is behind the `agent` entitlement, a rollout flag the cloud sets
//! per account on any plan. Signed out, or without it, every command refuses
//! with `AGENT_NOT_ENTITLED` and nothing reaches the cloud agent routes.

mod batch;
pub mod chat;
mod cloud;
mod engine;
pub mod host;
#[cfg(feature = "e2e")]
mod mock;
mod model;
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

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static TOKEN_REFRESH: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent token refresh");

/// Called once at startup: launches need the app handle.
pub fn init(app: &tauri::AppHandle) {
  let _ = APP.set(app.clone());
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
  supported: bool,
  /// False when support could not be learnt yet; ask again later.
  checked: bool,
}

fn locale() -> String {
  crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .ok()
    .and_then(|settings| settings.language)
    .unwrap_or_else(|| "en".to_string())
}

/// Hand the current agent token to the engine. Teaches the support cache too.
async fn configure(link: &EngineLink, version: &str) -> Result<(), String> {
  let (token, _) = token::current().await?;
  let outcome = link
    .call(
      "Wayfern.agentConfigure",
      json!({
        "apiBase": crate::cloud_auth::CLOUD_API_URL,
        "token": token.token,
        "locale": locale(),
      }),
    )
    .await;
  if let Some(supported) = engine::support_from_probe(&outcome) {
    engine::remember_support(version, supported);
    if !supported {
      let _ = crate::events::emit_empty("agent-engine-changed");
    }
  }
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
      let links: Vec<EngineLink> = {
        let mut store = store();
        store.links.retain(|_, link| link.is_open());
        store.links.values().cloned().collect()
      };
      if links.is_empty() {
        continue;
      }
      match token::current().await {
        Ok((token, true)) => {
          let params = json!({
            "apiBase": crate::cloud_auth::CLOUD_API_URL,
            "token": token.token,
            "locale": locale(),
          });
          for link in links {
            let _ = link.call("Wayfern.agentConfigure", params.clone()).await;
          }
          TOKEN_REFRESH.succeeded();
        }
        Ok(_) => TOKEN_REFRESH.succeeded(),
        Err(e) => TOKEN_REFRESH.failed(e),
      }
    }
  });
}

// ---- Engine events ----

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
          task.fail("AGENT_BROWSER_CLOSED".to_string(), now);
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

/// A task ended: log it, tell the cloud, close a browser opened for it, and
/// let the batch start the next one.
fn finalize(batch_id: &str, index: usize) {
  let (task, headless, waker) = {
    let mut store = store();
    let waker = store.waker(batch_id);
    let Some(batch) = store.batch_mut(batch_id) else {
      return;
    };
    let Some(task) = batch.tasks.get(index).cloned() else {
      return;
    };
    (task, batch.order.headless, waker)
  };
  let elapsed = task
    .started_at
    .zip(task.finished_at)
    .map(|(start, end)| end.saturating_sub(start))
    .unwrap_or(0);
  log::info!(
    "Agent task finished profile={} task={} batch={batch_id} status={} credits={} elapsed_ms={elapsed}",
    task.profile_id,
    task.task_id.as_deref().unwrap_or("-"),
    task.status.run_status(),
    task.total_credits()
  );
  if let Some(run_id) = task.run_id.clone() {
    let patch = final_report(&task);
    tokio::spawn(async move { cloud::report_run(&run_id, patch).await });
  }
  if task.launched_here && headless {
    let profile_id = task.profile_id.clone();
    tokio::spawn(async move { stop_browser(&profile_id).await });
  }
  waker.notify_one();
}

/// What the cloud records when a task ends: every attempt's credits count.
fn final_report(task: &Task) -> Value {
  cloud::run_patch(
    task.status.run_status(),
    task.result.as_deref(),
    task.total_credits(),
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
  if let Err(code) = configure(&link, &fresh.version).await {
    if !running && headless {
      stop_browser(&profile_id).await;
    }
    return Err(code);
  }
  store().links.insert(profile_id, link.clone());
  ensure_token_refresher();
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
  let outcome: Result<String, String> = async {
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
      if stopping {
        task.status = TaskStatus::Stopped;
        task.finished_at = Some(now_ms());
        return Ok(String::new());
      }
      task.task_id = Some(task_id.clone());
      task.started_at = Some(now_ms());
    }
    link
      .call("Wayfern.agentStart", start_params(&task_id, &order))
      .await
      .map_err(|e| e.code())?;
    Ok(task_id)
  }
  .await;

  let finished = {
    let mut store = store();
    let Some(batch) = store.batch_mut(&batch_id) else {
      return;
    };
    let task = &mut batch.tasks[index];
    let finished = match &outcome {
      Ok(task_id) if task_id.is_empty() => true,
      Ok(task_id) => {
        if task.status == TaskStatus::Launching {
          task.status = TaskStatus::Running;
        }
        log::info!("Agent task started profile={profile_id} task={task_id} batch={batch_id}");
        // An end that came before this reply was finalized when it came.
        false
      }
      Err(code) => {
        log::warn!(
          "Agent task did not start profile={profile_id} batch={batch_id} err={}",
          error_code(code)
        );
        task.fail(code.clone(), now_ms());
        true
      }
    };
    let run = task
      .run_id
      .clone()
      .filter(|_| !finished && !task.status.is_final())
      .map(|run_id| (run_id, task.total_credits()));
    publish(batch);
    (finished, run)
  };
  match finished {
    (true, _) => finalize(&batch_id, index),
    (false, Some((run_id, spent))) => {
      cloud::report_run(&run_id, cloud::run_patch("running", None, spent, None)).await;
    }
    _ => {}
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
    return Err(crate::backend_error("AGENT_TOO_MANY_PROFILES"));
  }
  Ok(profile_ids)
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

async fn run_routine(
  routine: Routine,
  profile_ids: Option<Vec<String>>,
  cloud_batch_id: Option<String>,
) -> Result<BatchView, String> {
  let profile_ids = checked_profiles(profile_ids.unwrap_or_else(|| routine.profile_ids.clone()))?;
  let (prompt, start_url) = cloud::checked_order(&routine.prompt, routine.start_url.as_deref())?;
  let started = cloud::start_runs(&routine.id, &profile_ids, cloud_batch_id.as_deref()).await?;
  start_batch(BatchSpec {
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
    cloud_batch_id: Some(started.batch_id),
    runs: started
      .runs
      .into_iter()
      .map(|run| (run.profile_id, run.run_id))
      .collect(),
  })
}

/// A routine the cloud fired on its schedule, over the remote bridge.
pub(crate) async fn run_routine_from_cloud(params: &Value) -> Result<Value, String> {
  ensure_entitled().await?;
  let routine_id = params
    .get("routineId")
    .and_then(Value::as_str)
    .ok_or_else(|| crate::backend_error("AGENT_ROUTINE_NOT_FOUND"))?;
  let cloud_batch_id = params
    .get("batchId")
    .and_then(Value::as_str)
    .map(str::to_string);
  let routine = cloud::get_routine(routine_id).await?;
  log::info!("Agent routine fired by the cloud routine={routine_id}");
  let view = run_routine(routine, None, cloud_batch_id).await?;
  Ok(json!({ "batchId": view.id, "profiles": view.tasks.len() }))
}

// ---- Commands ----

#[tauri::command]
pub async fn get_agent_engine_status() -> EngineStatus {
  if ensure_entitled().await.is_err() {
    return EngineStatus {
      supported: false,
      checked: true,
    };
  }
  #[cfg(feature = "e2e")]
  if mock::active() {
    return EngineStatus {
      supported: true,
      checked: true,
    };
  }
  let Some(version) =
    crate::auto_updater::AutoUpdater::instance().get_latest_installed_version("wayfern")
  else {
    return EngineStatus {
      supported: false,
      checked: true,
    };
  };
  if let Some(supported) = engine::known_support(&version) {
    return EngineStatus {
      supported,
      checked: true,
    };
  }
  match engine::probe(&version).await {
    Some(supported) => EngineStatus {
      supported,
      checked: true,
    },
    None => EngineStatus {
      supported: false,
      checked: false,
    },
  }
}

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
    task.status = status;
    if status.is_final() {
      task.finished_at = Some(now_ms());
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
      if task.answered(&approval_id) {
        publish(batch);
      }
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn stop_agent_batch(batch_id: String) -> Result<(), String> {
  ensure_entitled().await?;
  let running = {
    let mut store = store();
    let batch = store
      .batch_mut(&batch_id)
      .ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
    let running = batch.stop_all(now_ms());
    publish(batch);
    running
  };
  log::info!(
    "Agent batch stopping batch={batch_id} running={}",
    running.len()
  );
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
  let count = {
    let mut store = store();
    let batch = store
      .batch_mut(&batch_id)
      .ok_or_else(|| crate::backend_error("AGENT_BATCH_NOT_FOUND"))?;
    let count = batch.retry_failed();
    publish(batch);
    count
  };
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
  cloud::list_routines().await
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
  let _ = crate::events::emit_empty("agent-routines-changed");
  Ok(saved)
}

async fn remove_routine(id: &str) -> Result<(), String> {
  cloud::delete_routine(id).await?;
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_final_report_counts_the_credits_of_every_attempt() {
    let mut task = Task::queued("p1".into());
    task.run_id = Some("r1".into());
    task.credits_used = 12;
    task.fail("AGENT_BUSY".into(), 1);
    task.requeue();
    assert_eq!(task.run_id.as_deref(), Some("r1"));
    task.credits_used = 30;
    task.status = TaskStatus::Done;
    task.result = Some("Found it".into());
    assert_eq!(
      final_report(&task),
      json!({ "status": "done", "creditsUsed": 42, "summary": "Found it" })
    );
    assert_eq!(TaskView::from(&task).credits_used, 42);
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
          index,
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
