//! Agent chats on every device of the account and in the web account area.
//! Donut cloud stores each chat sealed under one chat key per account, which
//! it never holds: the first app makes the key, and apps that hold it wrap
//! it for each new device (`chat-sync.md` in the infra contract). A delete
//! anywhere deletes everywhere.
//!
//! Only for accounts with the `agent` entitlement. The key and the device id
//! stay on this device, sealed with the vault; nothing of a chat, a key or a
//! wrap reaches the log.

mod crypto;
mod keys;
#[cfg(any(test, feature = "e2e"))]
mod memory;
mod records;
mod remote;
mod syncer;
#[cfg(test)]
mod tests;

use super::chat::{self, Chat};
use super::ensure_entitled;
use crate::cloud_errors::BackendFailure;
use async_trait::async_trait;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use syncer::{Deletes, Files, Local, Merge, Stamp, Syncer};
use tokio::sync::Notify;

const POLL_EVERY: Duration = Duration::from_secs(60);
/// While the chat panel is open.
const POLL_WATCHED: Duration = Duration::from_secs(10);
/// A window that gets the focus again this soon does not poll again.
const FOCUS_GAP: Duration = Duration::from_secs(10);

static WAKE: Notify = Notify::const_new();
static WATCHED: AtomicBool = AtomicBool::new(false);
static POLL_NOW: AtomicBool = AtomicBool::new(false);
static LOCKED: AtomicBool = AtomicBool::new(false);
static LAST_FOCUS: Mutex<Option<Instant>> = Mutex::new(None);
static SYNCER: tokio::sync::Mutex<Option<Syncer>> = tokio::sync::Mutex::const_new(None);
/// Chats whose current turn runs on another device, with that turn's id.
static FOREIGN: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);
static DELETES: LazyLock<Arc<Deletes>> =
  LazyLock::new(|| Arc::new(Deletes::in_file(files().deletes())));
static ROUND: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent chat sync");

fn files() -> Files {
  Files {
    dir: crate::app_dirs::data_dir().join("agent_chat_sync"),
  }
}

fn foreign() -> MutexGuard<'static, HashMap<String, String>> {
  FOREIGN.lock().unwrap_or_else(|p| p.into_inner())
}

// ---- Hooks ----

/// A chat changed on this device.
pub(super) fn changed() {
  WAKE.notify_one();
}

/// A chat was deleted on this device.
pub(super) fn deleted(chat_id: &str) {
  DELETES.add(chat_id);
  WAKE.notify_one();
}

fn focused() {
  let mut last = LAST_FOCUS.lock().unwrap_or_else(|p| p.into_inner());
  let now = Instant::now();
  if last.is_some_and(|at| now.duration_since(at) < FOCUS_GAP) {
    return;
  }
  *last = Some(now);
  POLL_NOW.store(true, Ordering::SeqCst);
  WAKE.notify_one();
}

/// Called once at startup.
pub(super) fn start(app: &tauri::AppHandle) {
  use tauri::Manager;
  static STARTED: AtomicBool = AtomicBool::new(false);
  if STARTED.swap(true, Ordering::SeqCst) {
    return;
  }
  if let Some(window) = app.get_webview_window("main") {
    window.on_window_event(|event| {
      if let tauri::WindowEvent::Focused(true) = event {
        focused();
      }
    });
  }
  tauri::async_runtime::spawn(run());
}

// ---- The chats on this device ----

/// Whether this device runs the chat's current turn.
fn runs_here(chat: &Chat) -> bool {
  chat
    .turns
    .last()
    .is_some_and(|turn| turn.task.status.is_active() && foreign().get(&chat.id) != Some(&turn.id))
}

struct AppChats;

#[async_trait]
impl Local for AppChats {
  fn stamps(&self) -> Vec<Stamp> {
    chat::stamps()
      .into_iter()
      .map(|(id, updated_at, active)| Stamp {
        id,
        updated_at,
        active,
      })
      .collect()
  }

  fn get(&self, id: &str) -> Option<Chat> {
    chat::snapshot(id)
  }

  fn offer(&self, remote: Chat) -> Merge {
    let id = remote.id.clone();
    let running = remote
      .turns
      .last()
      .filter(|turn| turn.task.status.is_active())
      .map(|turn| turn.id.clone());
    let mut merged = Merge::Same;
    chat::put_remote(remote, |local, remote| {
      merged = records::merge(local, remote, local.is_some_and(runs_here));
      merged == Merge::Take
    });
    if merged == Merge::Take {
      match running {
        Some(turn) => foreign().insert(id, turn),
        None => foreign().remove(&id),
      };
    }
    merged
  }

  async fn remove(&self, id: &str) {
    foreign().remove(id);
    if let Err(e) = chat::remove(id).await {
      log::debug!("Agent chat sync remove skipped chat={id} err={e}");
    }
  }

  fn profile_names(&self) -> HashMap<String, String> {
    crate::profile::ProfileManager::instance()
      .list_profiles()
      .map(|profiles| {
        profiles
          .into_iter()
          .map(|profile| (profile.id.to_string(), profile.name))
          .collect()
      })
      .unwrap_or_default()
  }

  fn listed(&self) {
    let _ = crate::events::emit_empty("agent-chats-changed");
  }
}

// ---- The loop ----

/// The signed-in account, when it has the `agent` entitlement.
async fn account() -> Option<String> {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Some("e2e".to_string());
  }
  let auth = crate::cloud_auth::CLOUD_AUTH.get_user().await?;
  auth.user.entitlements().agent.then(|| auth.user.id.clone())
}

fn remote() -> Box<dyn remote::Remote> {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Box::new(memory::Memory::in_file(files().dir.join("e2e-cloud.json")));
  }
  Box::new(remote::Http::cloud())
}

/// The sync of `account`, loaded when the slot holds another one or none.
fn ensure<'a>(slot: &'a mut Option<Syncer>, account: &str) -> (&'a mut Syncer, bool) {
  let fresh = slot.as_ref().map(|s| s.account.as_str()) != Some(account);
  if fresh {
    *slot = Some(Syncer::new(
      account,
      remote(),
      Arc::new(AppChats),
      DELETES.clone(),
      Some(files()),
    ));
  }
  match slot {
    Some(syncer) => (syncer, fresh),
    None => unreachable!("the slot was just filled"),
  }
}

fn set_locked(locked: bool) {
  if LOCKED.swap(locked, Ordering::SeqCst) != locked {
    log::info!("Agent chat sync locked={locked}");
    let _ = crate::events::emit("agent-chat-sync", ChatSyncView { locked });
  }
}

fn report(result: &Result<(), BackendFailure>) {
  match result {
    Ok(()) => ROUND.succeeded(),
    Err(e) => ROUND.failed(format!("code={} status={}", e.code, e.status)),
  }
}

/// One round: everything when `poll`, else only what changed here.
/// `None` when there is no account to sync.
async fn round(poll: bool) -> Option<Result<(), BackendFailure>> {
  let Some(account) = account().await else {
    *SYNCER.lock().await = None;
    set_locked(false);
    return None;
  };
  let mut slot = SYNCER.lock().await;
  let (syncer, fresh) = ensure(&mut slot, &account);
  let result = if poll || fresh {
    syncer.cycle().await
  } else {
    syncer.push_only().await
  };
  set_locked(syncer.locked);
  report(&result);
  Some(result)
}

async fn run() {
  let mut next_poll = Instant::now();
  let mut hold_until: Option<Instant> = None;
  loop {
    let due = SYNCER.lock().await.as_ref().and_then(|s| s.next_due);
    let mut wake_at = due.map_or(next_poll, |due| due.min(next_poll));
    if let Some(until) = hold_until {
      wake_at = wake_at.max(until);
    }
    tokio::select! {
      _ = tokio::time::sleep_until(wake_at.into()) => {}
      _ = WAKE.notified() => {}
    }
    let now = Instant::now();
    let asked = POLL_NOW.swap(false, Ordering::SeqCst);
    if !asked && hold_until.is_some_and(|until| now < until) {
      continue;
    }
    let poll = asked || now >= next_poll;
    let outcome = round(poll).await;
    let interval = if WATCHED.load(Ordering::SeqCst) {
      POLL_WATCHED
    } else {
      POLL_EVERY
    };
    match outcome {
      Some(Err(_)) => {
        hold_until = Some(now + POLL_EVERY);
        next_poll = now + POLL_EVERY;
      }
      Some(Ok(())) if poll => {
        hold_until = None;
        next_poll = now + interval;
      }
      Some(Ok(())) => hold_until = None,
      None if poll => next_poll = now + POLL_EVERY,
      None => {}
    }
  }
}

// ---- Commands ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncView {
  /// The account has a chat key and this device has none yet.
  locked: bool,
}

#[tauri::command]
pub async fn get_agent_chat_sync() -> Result<ChatSyncView, String> {
  ensure_entitled().await?;
  Ok(ChatSyncView {
    locked: LOCKED.load(Ordering::SeqCst),
  })
}

/// The chat panel opened or closed. While it is open the server is read
/// every `POLL_WATCHED`.
#[tauri::command]
pub async fn watch_agent_chats(open: bool) -> Result<(), String> {
  ensure_entitled().await?;
  WATCHED.store(open, Ordering::SeqCst);
  if open {
    POLL_NOW.store(true, Ordering::SeqCst);
    WAKE.notify_one();
  }
  Ok(())
}

/// Erase the synced chats of every device and the account's chat key, for
/// a device that cannot unlock them. This device's chats stay and sync
/// again under a new key.
#[tauri::command]
pub async fn erase_synced_agent_chats() -> Result<(), String> {
  ensure_entitled().await?;
  let account = account()
    .await
    .ok_or_else(|| crate::backend_error("AGENT_NOT_ENTITLED"))?;
  let mut slot = SYNCER.lock().await;
  let (syncer, _) = ensure(&mut slot, &account);
  if let Err(e) = syncer.erase().await {
    log::warn!(
      "Agent chat sync erase failed code={} status={}",
      e.code,
      e.status
    );
    if e.status == 403 {
      return Err(crate::backend_error("AGENT_NOT_ENTITLED"));
    }
    return Err(e.to_error_json());
  }
  let result = syncer.cycle().await;
  set_locked(syncer.locked);
  report(&result);
  drop(slot);
  let _ = crate::events::emit_empty("agent-chats-changed");
  Ok(())
}
