//! Agent chats: a conversation with the engine in one profile's browser. The
//! first message starts a task; a later one goes to the same task with
//! `Wayfern.agentMessage`, so the engine keeps what it learnt. A message sent
//! while a turn runs steers it. An engine without `agentMessage`, or one that
//! no longer knows the task, gets a new task in the same chat.
//!
//! Chats stay on this device (`agent_chats/<id>.json` in the data directory,
//! never synced). Their words never reach the log.

use super::engine::{EngineError, EngineLink};
use super::model::{EngineEvent, Task, TaskStatus};
use super::{attach, ensure_entitled, error_code, load_profile, now_ms};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

/// Steps kept per turn, in memory and on disk. The oldest go first.
pub const MAX_TURN_STEPS: usize = 120;
/// Turns kept per chat. The oldest go first.
const MAX_TURNS: usize = 200;
/// Steers kept per turn.
const MAX_STEERS: usize = 50;
const MAX_TITLE_CHARS: usize = 80;
/// A step is saved with the next change at most this often.
const STEP_SAVE_EVERY_MS: u64 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnKind {
  /// The chat's first task.
  Start,
  /// A message to the task that is already there.
  FollowUp,
  /// A follow-up that had to start a new task: the engine forgot the old one.
  Fresh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Steer {
  pub text: String,
  pub at: u64,
}

/// One message and what the engine did with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
  pub id: String,
  pub text: String,
  pub kind: TurnKind,
  #[serde(default)]
  pub steers: Vec<Steer>,
  /// What the engine had counted for this task before the turn.
  #[serde(default)]
  pub credits_base: u64,
  #[serde(flatten)]
  pub task: Task,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
  pub id: String,
  pub title: String,
  pub profile_id: String,
  pub created_at: u64,
  pub updated_at: u64,
  /// Credits the engine counts for the current task, all turns together.
  #[serde(default)]
  pub task_credits: u64,
  pub turns: Vec<Turn>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
  id: String,
  title: String,
  profile_id: String,
  created_at: u64,
  updated_at: u64,
  status: Option<TaskStatus>,
  turns: usize,
}

fn title_of(text: &str) -> String {
  let line = text.trim().lines().next().unwrap_or_default().trim();
  if line.chars().count() <= MAX_TITLE_CHARS {
    return line.to_string();
  }
  let cut: String = line.chars().take(MAX_TITLE_CHARS - 1).collect();
  format!("{}…", cut.trim_end())
}

/// The engine's credits for the task, as this turn's own. An engine that
/// counts per task reports more than the base; one that counts per message
/// reports less.
fn turn_credits(reported: u64, base: u64) -> u64 {
  if reported >= base {
    reported - base
  } else {
    reported
  }
}

impl Turn {
  fn new(profile_id: &str, text: String, kind: TurnKind, credits_base: u64, now: u64) -> Self {
    let mut task = Task::queued(profile_id.to_string());
    task.status = TaskStatus::Launching;
    task.started_at = Some(now);
    Self {
      id: uuid::Uuid::new_v4().to_string(),
      text,
      kind,
      steers: Vec::new(),
      credits_base,
      task,
    }
  }
}

impl Chat {
  pub fn new(profile_id: &str, text: String, now: u64) -> Self {
    Self {
      id: uuid::Uuid::new_v4().to_string(),
      title: title_of(&text),
      profile_id: profile_id.to_string(),
      created_at: now,
      updated_at: now,
      task_credits: 0,
      turns: vec![Turn::new(profile_id, text, TurnKind::Start, 0, now)],
    }
  }

  fn summary(&self) -> ChatSummary {
    ChatSummary {
      id: self.id.clone(),
      title: self.title.clone(),
      profile_id: self.profile_id.clone(),
      created_at: self.created_at,
      updated_at: self.updated_at,
      status: self.turns.last().map(|turn| turn.task.status),
      turns: self.turns.len(),
    }
  }

  fn current(&self) -> Option<&Turn> {
    self.turns.last()
  }

  fn current_mut(&mut self) -> Option<&mut Turn> {
    self.turns.last_mut()
  }

  /// The engine task a follow-up goes to.
  fn task_id(&self) -> Option<String> {
    self
      .turns
      .iter()
      .rev()
      .find_map(|turn| turn.task.task_id.clone())
  }

  fn is_active(&self) -> bool {
    self
      .current()
      .is_some_and(|turn| turn.task.status.is_active())
  }

  /// Open the next turn. The caller has checked that none is running.
  fn push_turn(&mut self, text: String, now: u64) -> &Turn {
    let kind = if self.task_id().is_some() {
      TurnKind::FollowUp
    } else {
      TurnKind::Start
    };
    let turn = Turn::new(&self.profile_id, text, kind, self.task_credits, now);
    self.turns.push(turn);
    if self.turns.len() > MAX_TURNS {
      self.turns.remove(0);
    }
    self.updated_at = now;
    &self.turns[self.turns.len() - 1]
  }

  /// Apply an engine event of `task_id` to the current turn. Returns whether
  /// anything changed.
  pub fn apply(&mut self, task_id: &str, event: EngineEvent, now: u64) -> bool {
    let base = match self.current() {
      Some(turn) if turn.task.task_id.as_deref() == Some(task_id) => turn.credits_base,
      _ => return false,
    };
    let event = match event {
      EngineEvent::Credits(used) => EngineEvent::Credits(turn_credits(used, base)),
      EngineEvent::Finished {
        status,
        result,
        error,
        credits_used,
      } => EngineEvent::Finished {
        status,
        result,
        error,
        credits_used: turn_credits(credits_used, base),
      },
      other => other,
    };
    let Some(turn) = self.current_mut() else {
      return false;
    };
    if !turn.task.apply(event, now) {
      return false;
    }
    while turn.task.steps.len() > MAX_TURN_STEPS {
      turn.task.steps.pop_front();
    }
    let spent = turn.credits_base + turn.task.credits_used;
    self.task_credits = self.task_credits.max(spent);
    self.updated_at = now;
    true
  }

  /// A chat read back from disk: a turn that was running when the app quit
  /// has stopped as far as this app knows.
  fn settle(&mut self, now: u64) {
    for turn in &mut self.turns {
      if !turn.task.status.is_final() {
        turn.task.status = TaskStatus::Stopped;
        turn.task.approval = None;
        turn.task.finished_at.get_or_insert(now);
      }
      while turn.task.steps.len() > MAX_TURN_STEPS {
        turn.task.steps.pop_front();
      }
    }
  }
}

/// What a follow-up does after the engine answered `agentMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FollowUp {
  /// The task took the message.
  Continued,
  /// Start a new task in the same chat.
  StartFresh,
  Failed(String),
}

pub fn follow_up_plan(outcome: &Result<Value, EngineError>) -> FollowUp {
  match outcome {
    Ok(_) => FollowUp::Continued,
    // An older Wayfern has no agentMessage.
    Err(EngineError::Unsupported) => FollowUp::StartFresh,
    // Another task replaced this one, or the engine let it go.
    Err(EngineError::Coded(code))
      if matches!(
        code.as_str(),
        "AGENT_TASK_UNKNOWN" | "AGENT_TASK_ENDED" | "AGENT_TASK_NOT_FOUND"
      ) =>
    {
      FollowUp::StartFresh
    }
    Err(e) => FollowUp::Failed(e.code()),
  }
}

// ---- Storage ----

fn chats_dir() -> PathBuf {
  crate::app_dirs::data_dir().join("agent_chats")
}

fn chat_path(dir: &Path, id: &str) -> Option<PathBuf> {
  crate::app_dirs::is_plain_path_part(id).then(|| dir.join(format!("{id}.json")))
}

fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
  let parent = path
    .parent()
    .ok_or_else(|| std::io::Error::other("chat path has no parent"))?;
  std::fs::create_dir_all(parent)?;
  let mut temporary = tempfile::Builder::new()
    .prefix(".chat-")
    .tempfile_in(parent)?;
  crate::app_dirs::restrict_to_owner(temporary.path());
  temporary.write_all(content)?;
  temporary.as_file().sync_all()?;
  temporary.persist(path).map_err(|e| e.error)?;
  Ok(())
}

fn save_to(dir: &Path, chat: &Chat) -> std::io::Result<()> {
  let path = chat_path(dir, &chat.id).ok_or_else(|| std::io::Error::other("bad chat id"))?;
  write_atomic(&path, &serde_json::to_vec(chat)?)
}

fn load_from(dir: &Path, now: u64) -> HashMap<String, Chat> {
  let mut chats = HashMap::new();
  let Ok(entries) = std::fs::read_dir(dir) else {
    return chats;
  };
  let mut unreadable = 0usize;
  for entry in entries.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      continue;
    }
    match std::fs::read(&path)
      .ok()
      .and_then(|bytes| serde_json::from_slice::<Chat>(&bytes).ok())
    {
      Some(mut chat) if chat_path(dir, &chat.id).as_deref() == Some(path.as_path()) => {
        chat.settle(now);
        chats.insert(chat.id.clone(), chat);
      }
      _ => unreadable += 1,
    }
  }
  if unreadable > 0 {
    log::warn!("Agent chats skipped unreadable={unreadable}");
  }
  chats
}

#[derive(Default)]
struct Chats {
  loaded: bool,
  chats: HashMap<String, Chat>,
  saved_at: HashMap<String, u64>,
}

static CHATS: LazyLock<Mutex<Chats>> = LazyLock::new(|| Mutex::new(Chats::default()));

fn chats() -> MutexGuard<'static, Chats> {
  let mut guard = CHATS.lock().unwrap_or_else(|p| p.into_inner());
  if !guard.loaded {
    guard.chats = load_from(&chats_dir(), now_ms());
    guard.loaded = true;
  }
  guard
}

impl Chats {
  fn get(&self, id: &str) -> Result<&Chat, String> {
    self
      .chats
      .get(id)
      .ok_or_else(|| crate::backend_error("AGENT_CHAT_NOT_FOUND"))
  }

  fn get_mut(&mut self, id: &str) -> Result<&mut Chat, String> {
    self
      .chats
      .get_mut(id)
      .ok_or_else(|| crate::backend_error("AGENT_CHAT_NOT_FOUND"))
  }

  /// Write a chat and show its current turn. A step alone waits for the next
  /// change, at most `STEP_SAVE_EVERY_MS`.
  fn changed(&mut self, id: &str, step_only: bool) {
    let Some(chat) = self.chats.get(id) else {
      return;
    };
    publish(chat);
    let now = now_ms();
    let last = self.saved_at.get(id).copied().unwrap_or(0);
    if step_only && now.saturating_sub(last) < STEP_SAVE_EVERY_MS {
      return;
    }
    if let Err(e) = save_to(&chats_dir(), chat) {
      log::warn!("Agent chat save failed chat={id} err=\"{e}\"");
    }
    self.saved_at.insert(id.to_string(), now);
  }
}

fn publish(chat: &Chat) {
  let Some(turn) = chat.current() else {
    return;
  };
  let _ = crate::events::emit(
    "agent-chat-turn",
    json!({
      "chatId": chat.id,
      "index": chat.turns.len() - 1,
      "updatedAt": chat.updated_at,
      "turn": turn,
    }),
  );
}

/// Whether a chat other than `except` has a running turn on the profile.
pub(super) fn busy(profile_id: &str, except: Option<&str>) -> bool {
  chats().chats.values().any(|chat| {
    chat.profile_id == profile_id && chat.is_active() && Some(chat.id.as_str()) != except
  })
}

pub(super) fn on_engine_event(profile_id: &str, task_id: &str, event: EngineEvent) {
  let mut store = chats();
  let now = now_ms();
  let step_only = matches!(event, EngineEvent::Step(_) | EngineEvent::Credits(_));
  let Some(chat) = store
    .chats
    .values_mut()
    .find(|chat| chat.profile_id == profile_id && chat.task_id().as_deref() == Some(task_id))
  else {
    return;
  };
  if !chat.apply(task_id, event, now) {
    return;
  }
  let id = chat.id.clone();
  let ended = chat
    .current()
    .filter(|turn| turn.task.status.is_final())
    .map(|turn| turn.task.clone());
  store.changed(&id, step_only && ended.is_none());
  drop(store);
  if let Some(task) = ended {
    log_end(&id, &task);
  }
}

pub(super) fn on_link_closed(profile_id: &str) {
  let mut store = chats();
  let now = now_ms();
  let ended: Vec<(String, Task)> = store
    .chats
    .values_mut()
    .filter(|chat| chat.profile_id == profile_id)
    .filter_map(|chat| {
      let turn = chat.current_mut()?;
      if !turn.task.status.is_active() || turn.task.task_id.is_none() {
        return None;
      }
      turn
        .task
        .fail(crate::backend_error("AGENT_BROWSER_CLOSED"), now);
      let task = turn.task.clone();
      chat.updated_at = now;
      Some((chat.id.clone(), task))
    })
    .collect();
  for (id, task) in &ended {
    store.changed(id, false);
    log_end(id, task);
  }
}

fn log_end(chat_id: &str, task: &Task) {
  let elapsed = task
    .started_at
    .zip(task.finished_at)
    .map(|(start, end)| end.saturating_sub(start))
    .unwrap_or(0);
  log::info!(
    "Agent chat turn finished chat={chat_id} profile={} task={} status={} credits={} elapsed_ms={elapsed}",
    task.profile_id,
    task.task_id.as_deref().unwrap_or("-"),
    task.status.run_status(),
    task.credits_used
  );
}

/// End the current turn of a chat that did not start.
fn fail_turn(chat_id: &str, turn_id: &str, code: String) {
  let mut store = chats();
  let Ok(chat) = store.get_mut(chat_id) else {
    return;
  };
  let Some(turn) = chat.current_mut().filter(|turn| turn.id == turn_id) else {
    return;
  };
  if turn.task.status.is_final() {
    return;
  }
  turn.task.fail(code, now_ms());
  let task = turn.task.clone();
  store.changed(chat_id, false);
  drop(store);
  log_end(chat_id, &task);
}

/// Set the current turn's engine task before the engine is asked, so an
/// event that comes before the reply finds it.
fn bind_task(chat_id: &str, turn_id: &str, task_id: &str, kind: TurnKind) -> Result<(), String> {
  let mut store = chats();
  let chat = store.get_mut(chat_id)?;
  let fresh = kind != TurnKind::FollowUp;
  if fresh {
    chat.task_credits = 0;
  }
  let turn = chat
    .current_mut()
    .filter(|turn| turn.id == turn_id && !turn.task.status.is_final())
    .ok_or_else(|| crate::backend_error("AGENT_TASK_NOT_FOUND"))?;
  turn.task.task_id = Some(task_id.to_string());
  turn.kind = kind;
  if fresh {
    turn.credits_base = 0;
  }
  store.changed(chat_id, false);
  Ok(())
}

/// The engine took the turn: it is running unless an event moved it on.
fn mark_running(chat_id: &str, turn_id: &str) {
  let mut store = chats();
  let Ok(chat) = store.get_mut(chat_id) else {
    return;
  };
  let Some(turn) = chat.current_mut().filter(|turn| turn.id == turn_id) else {
    return;
  };
  if turn.task.status == TaskStatus::Launching {
    turn.task.status = TaskStatus::Running;
    store.changed(chat_id, false);
  }
}

async fn link_for(profile_id: &str, chat_id: &str) -> Result<EngineLink, String> {
  let profile = load_profile(profile_id)?;
  if profile.browser != "wayfern" {
    return Err(crate::backend_error("AGENT_UNSUPPORTED"));
  }
  let in_a_run = super::store().busy(profile_id, None);
  if in_a_run || busy(profile_id, Some(chat_id)) {
    return Err(crate::backend_error("AGENT_BUSY"));
  }
  let (link, _) = attach(&profile, false).await?;
  Ok(link)
}

/// Start or continue the engine task for the current turn.
async fn run_turn(chat_id: String, turn_id: String) {
  let (profile_id, text, prior) = {
    let store = chats();
    let Ok(chat) = store.get(&chat_id) else {
      return;
    };
    let Some(turn) = chat.current().filter(|turn| turn.id == turn_id) else {
      return;
    };
    let prior = chat
      .turns
      .iter()
      .rev()
      .skip(1)
      .find_map(|turn| turn.task.task_id.clone());
    (chat.profile_id.clone(), turn.text.clone(), prior)
  };
  let outcome: Result<TurnKind, String> = async {
    let link = link_for(&profile_id, &chat_id).await?;
    if let Some(task_id) = &prior {
      bind_task(&chat_id, &turn_id, task_id, TurnKind::FollowUp)?;
      let reply = link
        .call(
          "Wayfern.agentMessage",
          json!({ "taskId": task_id, "text": text }),
        )
        .await;
      match follow_up_plan(&reply) {
        FollowUp::Continued => return Ok(TurnKind::FollowUp),
        FollowUp::Failed(code) => return Err(code),
        FollowUp::StartFresh => {}
      }
    }
    let kind = if prior.is_some() {
      TurnKind::Fresh
    } else {
      TurnKind::Start
    };
    let task_id = uuid::Uuid::new_v4().to_string();
    bind_task(&chat_id, &turn_id, &task_id, kind)?;
    link
      .call(
        "Wayfern.agentStart",
        json!({ "taskId": task_id, "prompt": text, "autonomy": "ask" }),
      )
      .await
      .map_err(|e| e.code())?;
    Ok(kind)
  }
  .await;
  match outcome {
    Ok(kind) => {
      mark_running(&chat_id, &turn_id);
      log::info!(
        "Agent chat turn started chat={chat_id} profile={profile_id} kind={}",
        serde_json::to_value(kind)
          .ok()
          .and_then(|v| v.as_str().map(str::to_string))
          .unwrap_or_default()
      );
    }
    Err(code) => {
      log::warn!(
        "Agent chat turn did not start chat={chat_id} profile={profile_id} err={}",
        error_code(&code)
      );
      fail_turn(&chat_id, &turn_id, code);
    }
  }
}

/// The link and engine task of a chat's running turn.
fn running_turn(chat_id: &str) -> Result<(EngineLink, String), String> {
  let (profile_id, task_id) = {
    let store = chats();
    let chat = store.get(chat_id)?;
    let turn = chat
      .current()
      .filter(|turn| turn.task.status.is_active())
      .ok_or_else(|| crate::backend_error("AGENT_TASK_NOT_FOUND"))?;
    let task_id = turn
      .task
      .task_id
      .clone()
      .ok_or_else(|| crate::backend_error("AGENT_TASK_NOT_FOUND"))?;
    (chat.profile_id.clone(), task_id)
  };
  let link = super::store()
    .links
    .get(&profile_id)
    .filter(|link| link.is_open())
    .cloned()
    .ok_or_else(|| crate::backend_error("AGENT_BROWSER_UNREACHABLE"))?;
  Ok((link, task_id))
}

fn set_turn_status(chat_id: &str, status: TaskStatus) {
  let mut store = chats();
  let Ok(chat) = store.get_mut(chat_id) else {
    return;
  };
  let Some(turn) = chat.current_mut() else {
    return;
  };
  if turn.task.status.is_final() {
    return;
  }
  turn.task.status = status;
  if status.is_final() {
    turn.task.approval = None;
    turn.task.finished_at = Some(now_ms());
  }
  let task = turn.task.clone();
  store.changed(chat_id, false);
  drop(store);
  if status.is_final() {
    log_end(chat_id, &task);
  }
}

fn checked_text(text: &str) -> Result<String, String> {
  super::cloud::checked_order(text, None).map(|(text, _)| text)
}

// ---- Commands ----

#[tauri::command]
pub async fn list_agent_chats() -> Result<Vec<ChatSummary>, String> {
  ensure_entitled().await?;
  let store = chats();
  let mut list: Vec<ChatSummary> = store.chats.values().map(Chat::summary).collect();
  list.sort_by_key(|chat| std::cmp::Reverse(chat.updated_at));
  Ok(list)
}

#[tauri::command]
pub async fn get_agent_chat(chat_id: String) -> Result<Chat, String> {
  ensure_entitled().await?;
  chats().get(&chat_id).cloned()
}

/// A new chat on a profile, with its first message. The browser launches
/// when it is not running.
#[tauri::command]
pub async fn create_agent_chat(profile_id: String, text: String) -> Result<Chat, String> {
  ensure_entitled().await?;
  let text = checked_text(&text)?;
  load_profile(&profile_id)?;
  let chat = Chat::new(&profile_id, text, now_ms());
  let turn_id = chat.turns[0].id.clone();
  let id = chat.id.clone();
  {
    let mut store = chats();
    store.chats.insert(id.clone(), chat.clone());
    store.changed(&id, false);
  }
  log::info!("Agent chat created chat={id} profile={profile_id}");
  let _ = crate::events::emit_empty("agent-chats-changed");
  tokio::spawn(run_turn(id, turn_id));
  Ok(chat)
}

/// A message in a chat: a steer while a turn runs, else the next turn.
#[tauri::command]
pub async fn send_agent_chat_message(chat_id: String, text: String) -> Result<Chat, String> {
  ensure_entitled().await?;
  let running = chats().get(&chat_id)?.is_active();
  if running {
    let message = super::checked_steer(Some(text))?;
    let (link, task_id) = running_turn(&chat_id)?;
    link
      .call(
        "Wayfern.agentControl",
        json!({ "taskId": task_id, "action": "steer", "message": message }),
      )
      .await
      .map_err(|e| e.code())?;
    let mut store = chats();
    let chat = store.get_mut(&chat_id)?;
    let now = now_ms();
    if let Some(turn) = chat.current_mut() {
      turn.steers.push(Steer {
        text: message,
        at: now,
      });
      if turn.steers.len() > MAX_STEERS {
        turn.steers.remove(0);
      }
    }
    chat.updated_at = now;
    let view = chat.clone();
    store.changed(&chat_id, false);
    return Ok(view);
  }
  let text = checked_text(&text)?;
  let (view, turn_id) = {
    let mut store = chats();
    let chat = store.get_mut(&chat_id)?;
    let turn_id = chat.push_turn(text, now_ms()).id.clone();
    let view = chat.clone();
    store.changed(&chat_id, false);
    (view, turn_id)
  };
  tokio::spawn(run_turn(chat_id, turn_id));
  Ok(view)
}

#[tauri::command]
pub async fn control_agent_chat(chat_id: String, action: String) -> Result<(), String> {
  ensure_entitled().await?;
  if !matches!(action.as_str(), "pause" | "resume" | "stop") {
    return Err(crate::backend_error("AGENT_ACTION_INVALID"));
  }
  let (link, task_id) = match running_turn(&chat_id) {
    Ok(found) => found,
    // Nothing reaches a browser that is gone; the turn is over.
    Err(_) if action == "stop" => {
      set_turn_status(&chat_id, TaskStatus::Stopped);
      return Ok(());
    }
    Err(e) => return Err(e),
  };
  match link
    .call(
      "Wayfern.agentControl",
      json!({ "taskId": task_id, "action": action }),
    )
    .await
  {
    Ok(_) => {
      match action.as_str() {
        "pause" => set_turn_status(&chat_id, TaskStatus::Paused),
        "resume" => set_turn_status(&chat_id, TaskStatus::Running),
        _ => {}
      }
      Ok(())
    }
    Err(EngineError::Gone(_)) if action == "stop" => {
      set_turn_status(&chat_id, TaskStatus::Stopped);
      Ok(())
    }
    Err(e) => Err(e.code()),
  }
}

#[tauri::command]
pub async fn answer_agent_chat_approval(
  chat_id: String,
  approval_id: String,
  approve: bool,
  text: Option<String>,
) -> Result<(), String> {
  ensure_entitled().await?;
  let (link, task_id) = running_turn(&chat_id)?;
  let mut params = json!({ "taskId": task_id, "approvalId": approval_id, "approve": approve });
  if let Some(text) = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
    params["text"] = Value::from(super::checked_steer(Some(text))?);
  }
  link
    .call("Wayfern.agentAnswer", params)
    .await
    .map_err(|e| e.code())?;
  let mut store = chats();
  let chat = store.get_mut(&chat_id)?;
  if chat
    .current_mut()
    .is_some_and(|turn| turn.task.answered(&approval_id))
  {
    store.changed(&chat_id, false);
  }
  Ok(())
}

#[tauri::command]
pub async fn delete_agent_chat(chat_id: String) -> Result<(), String> {
  ensure_entitled().await?;
  if chats().get(&chat_id)?.is_active() {
    let _ = control_agent_chat(chat_id.clone(), "stop".to_string()).await;
  }
  let mut store = chats();
  store.get(&chat_id)?;
  store.chats.remove(&chat_id);
  store.saved_at.remove(&chat_id);
  if let Some(path) = chat_path(&chats_dir(), &chat_id) {
    if let Err(e) = std::fs::remove_file(&path) {
      if e.kind() != std::io::ErrorKind::NotFound {
        log::warn!("Agent chat delete failed chat={chat_id} err=\"{e}\"");
      }
    }
  }
  drop(store);
  log::info!("Agent chat deleted chat={chat_id}");
  let _ = crate::events::emit_empty("agent-chats-changed");
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::agent_tasks::model::Step;

  fn step(index: u64) -> EngineEvent {
    EngineEvent::Step(Step {
      index,
      kind: "act".into(),
      text: format!("step {index}"),
      url: None,
      tool: None,
      at: 0,
    })
  }

  fn finished(credits_used: u64) -> EngineEvent {
    EngineEvent::Finished {
      status: TaskStatus::Done,
      result: Some("**Done**".into()),
      error: None,
      credits_used,
    }
  }

  fn started(text: &str) -> Chat {
    let mut chat = Chat::new("p1", text.into(), 1);
    let turn = chat.current_mut().unwrap();
    turn.task.task_id = Some("t1".into());
    turn.task.status = TaskStatus::Running;
    chat
  }

  #[test]
  fn the_title_is_the_first_line_cut_short() {
    assert_eq!(title_of("  Find flights\nto Lisbon"), "Find flights");
    let long = title_of(&"word ".repeat(40));
    assert_eq!(long.chars().count(), MAX_TITLE_CHARS);
    assert!(long.ends_with('…'));
  }

  #[test]
  fn events_reach_only_the_current_task_and_steps_are_capped() {
    let mut chat = started("Find flights");
    assert!(!chat.apply("other", step(0), 2));
    for index in 0..(MAX_TURN_STEPS as u64 + 10) {
      assert!(chat.apply("t1", step(index), 2));
    }
    let turn = chat.current().unwrap();
    assert_eq!(turn.task.steps.len(), MAX_TURN_STEPS);
    assert_eq!(turn.task.steps.front().unwrap().index, 10);
    assert!(chat.apply("t1", finished(40), 3));
    assert_eq!(chat.current().unwrap().task.status, TaskStatus::Done);
    assert_eq!(chat.task_credits, 40);
    assert!(
      !chat.apply("t1", step(999), 4),
      "a finished turn takes no more"
    );
  }

  #[test]
  fn a_follow_up_counts_its_own_credits_whichever_way_the_engine_counts() {
    let mut chat = started("Find flights");
    chat.apply("t1", finished(40), 2);
    let turn = chat.push_turn("And the return?".into(), 3).clone();
    assert_eq!(turn.kind, TurnKind::FollowUp);
    assert_eq!(turn.credits_base, 40);
    chat.current_mut().unwrap().task.task_id = Some("t1".into());
    // Counted per task: 40 before, 61 now.
    chat.apply("t1", EngineEvent::Credits(61), 4);
    assert_eq!(chat.current().unwrap().task.credits_used, 21);
    assert_eq!(chat.task_credits, 61);
    chat.apply("t1", finished(70), 5);
    assert_eq!(chat.current().unwrap().task.credits_used, 30);

    // Counted per message.
    let mut chat = started("Find flights");
    chat.apply("t1", finished(40), 2);
    chat.push_turn("And the return?".into(), 3);
    chat.current_mut().unwrap().task.task_id = Some("t1".into());
    chat.apply("t1", finished(12), 4);
    assert_eq!(chat.current().unwrap().task.credits_used, 12);
    assert_eq!(chat.task_credits, 52);
  }

  #[test]
  fn a_follow_up_falls_back_to_a_new_task_only_when_the_old_one_is_gone() {
    assert_eq!(follow_up_plan(&Ok(json!({}))), FollowUp::Continued);
    assert_eq!(
      follow_up_plan(&Err(EngineError::Unsupported)),
      FollowUp::StartFresh
    );
    assert_eq!(
      follow_up_plan(&Err(EngineError::Coded("AGENT_TASK_UNKNOWN".into()))),
      FollowUp::StartFresh
    );
    assert_eq!(
      follow_up_plan(&Err(EngineError::Coded("NO_CREDITS".into()))),
      FollowUp::Failed(crate::backend_error("NO_CREDITS"))
    );
    assert_eq!(
      follow_up_plan(&Err(EngineError::Gone("closed".into()))),
      FollowUp::Failed(crate::backend_error("AGENT_BROWSER_UNREACHABLE"))
    );
  }

  #[test]
  fn chats_survive_a_restart_and_a_running_turn_reads_back_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let mut chat = started("Find flights");
    chat.apply("t1", step(0), 2);
    chat.current_mut().unwrap().steers.push(Steer {
      text: "Only direct".into(),
      at: 2,
    });
    save_to(dir.path(), &chat).unwrap();
    let mut done = started("Check the weather");
    done.apply("t1", finished(9), 3);
    save_to(dir.path(), &done).unwrap();
    std::fs::write(dir.path().join("broken.json"), b"{").unwrap();
    std::fs::write(dir.path().join("note.txt"), b"x").unwrap();

    let loaded = load_from(dir.path(), 50);
    assert_eq!(loaded.len(), 2);
    let back = &loaded[&chat.id];
    let turn = back.current().unwrap();
    assert_eq!(turn.task.status, TaskStatus::Stopped);
    assert_eq!(turn.task.finished_at, Some(50));
    assert_eq!(turn.task.steps.len(), 1);
    assert_eq!(turn.steers[0].text, "Only direct");
    assert_eq!(back.title, "Find flights");
    assert_eq!(
      loaded[&done.id].current().unwrap().task.status,
      TaskStatus::Done
    );
    assert_eq!(
      loaded[&done.id].current().unwrap().task.result.as_deref(),
      Some("**Done**")
    );
  }

  #[test]
  fn a_chat_file_holds_only_its_own_id() {
    let dir = tempfile::tempdir().unwrap();
    assert!(chat_path(dir.path(), "../x").is_none());
    let chat = started("Find flights");
    save_to(dir.path(), &chat).unwrap();
    std::fs::rename(
      dir.path().join(format!("{}.json", chat.id)),
      dir.path().join("other.json"),
    )
    .unwrap();
    assert!(load_from(dir.path(), 1).is_empty());
  }

  #[test]
  fn the_list_shows_the_last_turn() {
    let mut chat = started("Find flights");
    chat.apply("t1", finished(5), 2);
    chat.push_turn("Then book it".into(), 3);
    let summary = chat.summary();
    assert_eq!(summary.turns, 2);
    assert_eq!(summary.status, Some(TaskStatus::Launching));
    assert_eq!(summary.updated_at, 3);
  }
}
