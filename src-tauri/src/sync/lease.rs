//! Sync leases: one device at a time runs a synced profile.
//!
//! A browser rotates its session cookies while it runs. When two devices run
//! the same profile, or one starts from an older copy, the site revokes the
//! session on both. Before a synced profile launches, this device takes the
//! profile's lease on the sync server (`/v1/locks/*`), renews it while the
//! browser runs, and releases it after the browser exits and the upload that
//! follows is done. A server without the routes, or one that cannot be
//! reached, never blocks a launch.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{SyncClient, SyncEngine};
use crate::log_streak::{KeyedStreak, Streak};
use crate::profile::BrowserProfile;

/// What the lease is asked for; the server bounds it to 90-300 s.
const TTL_SECS: u64 = 120;
const HEARTBEAT: Duration = Duration::from_secs(TTL_SECS / 3);
/// A stopped profile whose upload never reports back still frees its lease.
const STOPPED_LIMIT: Duration = Duration::from_secs(3600);
/// Written into the profile when another device took the lease over: the
/// changes of this session must not win over that device's.
const LOST_MARK: &str = "lease-lost";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static HELD: LazyLock<Mutex<HashMap<String, Held>>> = LazyLock::new(Default::default);
static HEARTBEAT_STARTED: OnceLock<()> = OnceLock::new();

static UNSUPPORTED: Streak = Streak::new(module_path!(), "Sync lease routes missing on server");
static UNREACHABLE: Streak = Streak::new(module_path!(), "Sync lease server unreachable");
static RENEW: KeyedStreak = KeyedStreak::new(module_path!(), "Sync lease renew");

struct Held {
  token: String,
  root: String,
  client: SyncClient,
  acquired: Instant,
  /// Set once the browser stopped: the lease waits for the upload.
  stopped: Option<Instant>,
}

/// Called once at startup: the sync client needs the app handle.
/// How long after startup the leases of browsers still running from an
/// earlier session are taken again: sign-in and sync settings load first.
const RESUME_AFTER: Duration = Duration::from_secs(15);

/// Called once at startup: the sync client needs the app handle.
pub fn init(app: &tauri::AppHandle) {
  let _ = APP.set(app.clone());
  tauri::async_runtime::spawn(async {
    tokio::time::sleep(RESUME_AFTER).await;
    resume_running().await;
  });
}

/// Takes the lease again for each synced profile whose browser outlived the
/// last session, and renews it from now on. Another device holding it now
/// is a lost lease.
async fn resume_running() {
  let Ok(profiles) = crate::profile::ProfileManager::instance().list_profiles() else {
    return;
  };
  for profile in profiles {
    let profile_id = profile.id.to_string();
    if !profile.is_sync_enabled() || !crate::browser_runner::browser_is_running_for(&profile_id) {
      continue;
    }
    if let Err(refusal) = take(&profile, false).await {
      let Ok(body) = serde_json::from_str::<Value>(&refusal) else {
        continue;
      };
      let holder = json!({
        "holder": { "deviceId": "", "deviceName": body["params"]["device"] },
      });
      notify_lost(&profile_id, &holder);
    }
  }
}

fn held() -> std::sync::MutexGuard<'static, HashMap<String, Held>> {
  HELD
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// This install's id: random, kept beside the app's data.
fn device_id() -> String {
  static ID: OnceLock<String> = OnceLock::new();
  ID.get_or_init(|| {
    let path = crate::app_dirs::data_dir().join("device-id");
    if let Some(id) = std::fs::read_to_string(&path)
      .ok()
      .map(|s| s.trim().to_string())
      .filter(|s| {
        !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
      })
    {
      return id;
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
      let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, &id) {
      log::warn!("Device id not saved err=\"{e}\"");
    }
    id
  })
  .clone()
}

fn device_name() -> String {
  sysinfo::System::host_name()
    .ok()
    .map(|h| h.trim().to_string())
    .filter(|h| !h.is_empty())
    .unwrap_or_else(|| "Donut Browser".to_string())
}

/// A short stand-in for a device id in the log.
pub(crate) fn short(id: &str) -> String {
  use sha2::Digest;
  sha2::Sha256::digest(id.as_bytes())[..4]
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect()
}

fn lost_mark(profile_id: &str) -> PathBuf {
  crate::app_dirs::profiles_dir()
    .join(profile_id)
    .join(".donut-sync")
    .join(LOST_MARK)
}

/// Whether another device took this profile's lease over while it ran here.
pub(crate) fn was_taken_over(profile_id: &str) -> bool {
  lost_mark(profile_id).exists()
}

pub(crate) fn clear_taken_over(profile_id: &str) {
  let _ = std::fs::remove_file(lost_mark(profile_id));
}

fn note_taken_over(profile_id: &str) {
  let path = lost_mark(profile_id);
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let _ = std::fs::write(path, crate::proxy_manager::now_secs().to_string());
}

/// The refusal the launch shows, in the app's error-code shape.
fn held_error(profile_id: &str, body: &Value) -> String {
  json!({
    "code": "PROFILE_LEASE_HELD",
    "params": {
      "profileId": profile_id,
      "device": body["holder"]["deviceName"].as_str().unwrap_or(""),
      "expiresAt": body["expiresAt"].as_str().unwrap_or(""),
      "canTakeOver": body["sameAccount"].as_bool().unwrap_or(false).to_string(),
    }
  })
  .to_string()
}

/// The client and the profile's root on the server, when the profile syncs
/// to a server this device is set up for.
async fn target(profile: &BrowserProfile) -> Option<(SyncClient, String)> {
  if !profile.is_sync_enabled() || !super::is_sync_configured() {
    return None;
  }
  let app = APP.get()?;
  if SyncEngine::is_self_hosted_sync().await && profile.created_by_id.is_some() {
    return None;
  }
  let engine = SyncEngine::create_from_settings(app).await.ok()?;
  let prefix = SyncEngine::get_team_key_prefix(profile).await;
  Some((engine.client, format!("{prefix}profiles/{}/", profile.id)))
}

/// Takes the profile's lease before its browser starts. `Ok(true)` when a
/// lease was taken; `Ok(false)` when none applies or the server cannot give
/// one; `Err` with `PROFILE_LEASE_HELD` when another device holds it.
/// `force` takes it from another device of the same account.
pub(crate) async fn acquire(profile: &BrowserProfile, force: bool) -> Result<bool, String> {
  let taken = take(profile, force).await?;
  // Another device may have run the profile since this one last synced it:
  // its newest copy comes down before the browser starts. A forced take is
  // followed by a launch, which pulls then.
  if taken && !force {
    if let Some(app) = APP.get() {
      if let Err(refusal) = super::engine::pull_before_launch(app, profile).await {
        // No browser starts, so the lease is not needed.
        release(&profile.id.to_string(), "pull_unfinished").await;
        return Err(refusal);
      }
    }
  }
  Ok(taken)
}

async fn take(profile: &BrowserProfile, force: bool) -> Result<bool, String> {
  let Some((client, root)) = target(profile).await else {
    return Ok(false);
  };
  let profile_id = profile.id.to_string();
  let device = device_id();
  let started = Instant::now();
  let body = json!({
    "profileRoot": root,
    "deviceId": device,
    "deviceName": device_name(),
    "ttlSeconds": TTL_SECS,
    "force": force,
  });
  let (status, reply) = match client.lease("acquire", &body).await {
    Ok(answer) => {
      UNREACHABLE.succeeded();
      answer
    }
    Err(e) => {
      UNREACHABLE.failed(format_args!("profile={profile_id} err=\"{e}\""));
      return Ok(false);
    }
  };
  match status {
    200 => {
      UNSUPPORTED.succeeded();
      let Some(token) = reply["token"].as_str() else {
        log::warn!("Sync lease answer has no token profile={profile_id}");
        return Ok(false);
      };
      held().insert(
        profile_id.clone(),
        Held {
          token: token.to_string(),
          root,
          client,
          acquired: Instant::now(),
          stopped: None,
        },
      );
      clear_taken_over(&profile_id);
      start_heartbeat();
      log::info!(
        "Sync lease acquired profile={profile_id} device={} force={force} elapsed_ms={}",
        short(&device),
        started.elapsed().as_millis()
      );
      Ok(true)
    }
    409 => {
      log::info!(
        "Sync lease refused profile={profile_id} holder={} expires_at={} elapsed_ms={}",
        short(reply["holder"]["deviceId"].as_str().unwrap_or("")),
        reply["expiresAt"].as_str().unwrap_or("-"),
        started.elapsed().as_millis()
      );
      Err(held_error(&profile_id, &reply))
    }
    404 => {
      UNSUPPORTED.failed(format_args!("profile={profile_id} status=404"));
      Ok(false)
    }
    _ => {
      UNREACHABLE.failed(format_args!("profile={profile_id} status={status}"));
      Ok(false)
    }
  }
}

/// Takes a profile's lease from another device of this account, after the
/// person confirmed it. The launch that follows takes it again as usual.
#[tauri::command]
pub async fn take_over_profile_lease(profile_id: String) -> Result<(), String> {
  let profile = crate::profile::ProfileManager::instance()
    .list_profiles()
    .map_err(|e| crate::wrap_backend_error(e, "Failed to list profiles"))?
    .into_iter()
    .find(|p| p.id.to_string() == profile_id)
    .ok_or_else(|| crate::backend_error("PROFILE_NOT_FOUND"))?;
  acquire(&profile, true).await?;
  if let Some(lease) = held().get_mut(&profile_id) {
    // Nothing runs yet: a launch that never comes frees it again.
    lease.stopped = Some(Instant::now());
  }
  Ok(())
}

async fn sync_pending(profile_id: &str) -> bool {
  match super::get_global_scheduler() {
    Some(scheduler) => scheduler.is_profile_sync_in_progress(profile_id).await,
    None => false,
  }
}

/// The browser stopped. The lease stays until the upload that follows is
/// done, or goes now when no upload is coming.
pub(crate) async fn browser_stopped(profile_id: &str) {
  {
    let mut leases = held();
    let Some(lease) = leases.get_mut(profile_id) else {
      return;
    };
    if lease.stopped.is_none() {
      lease.stopped = Some(Instant::now());
    }
  }
  if !sync_pending(profile_id).await {
    release(profile_id, "no_upload").await;
  }
}

/// A sync of the profile ended. After the browser stopped, that sync was
/// its upload: a success frees the lease; a failure leaves it to expire, so
/// another device does not start from a copy that lacks this session.
pub(crate) async fn sync_finished(profile_id: &str, uploaded: bool) {
  let stopped = held()
    .get(profile_id)
    .is_some_and(|lease| lease.stopped.is_some());
  if !stopped || crate::browser_runner::browser_is_running_for(profile_id) {
    return;
  }
  if uploaded {
    release(profile_id, "uploaded").await;
  } else if held().remove(profile_id).is_some() {
    log::warn!("Sync lease left to expire, upload failed profile={profile_id}");
  }
}

async fn release(profile_id: &str, reason: &str) {
  let Some(lease) = held().remove(profile_id) else {
    return;
  };
  let started = Instant::now();
  let body = json!({ "profileRoot": lease.root, "token": lease.token });
  match lease.client.lease("release", &body).await {
    Ok((200, _)) => log::info!(
      "Sync lease released profile={profile_id} reason={reason} held_ms={} elapsed_ms={}",
      lease.acquired.elapsed().as_millis(),
      started.elapsed().as_millis()
    ),
    Ok((status, _)) => {
      log::warn!("Sync lease release refused profile={profile_id} status={status}")
    }
    Err(e) => log::warn!("Sync lease release failed, it expires profile={profile_id} err=\"{e}\""),
  }
}

fn start_heartbeat() {
  if HEARTBEAT_STARTED.set(()).is_err() {
    return;
  }
  tauri::async_runtime::spawn(async {
    loop {
      tokio::time::sleep(HEARTBEAT).await;
      heartbeat().await;
    }
  });
}

async fn heartbeat() {
  let leases: Vec<(String, String, String, SyncClient, Option<Instant>)> = held()
    .iter()
    .map(|(id, l)| {
      (
        id.clone(),
        l.root.clone(),
        l.token.clone(),
        l.client.clone(),
        l.stopped,
      )
    })
    .collect();
  for (profile_id, root, token, client, stopped) in leases {
    if let Some(at) = stopped {
      if at.elapsed() > STOPPED_LIMIT || !sync_pending(&profile_id).await {
        release(
          &profile_id,
          if at.elapsed() > STOPPED_LIMIT {
            "stopped_limit"
          } else {
            "no_upload"
          },
        )
        .await;
        continue;
      }
    }
    let body = json!({ "profileRoot": root, "token": token, "ttlSeconds": TTL_SECS });
    match client.lease("renew", &body).await {
      Ok((200, _)) => RENEW.succeeded(&format!("profile={profile_id}")),
      Ok((409, reply)) => lost(&profile_id, &token, &reply),
      Ok((404, _)) => {
        // The server lost the routes (a downgrade): nothing left to renew.
        held().remove(&profile_id);
        UNSUPPORTED.failed(format_args!("profile={profile_id} status=404"));
      }
      Ok((status, _)) => RENEW.failed(
        &format!("profile={profile_id}"),
        format_args!("status={status}"),
      ),
      Err(e) => RENEW.failed(
        &format!("profile={profile_id}"),
        format_args!("err=\"{e}\""),
      ),
    }
  }
}

/// Another device took the lease over. This session's changes must not
/// replace that device's: the next sync of the profile takes the remote copy.
fn lost(profile_id: &str, token: &str, reply: &Value) {
  {
    let mut leases = held();
    if leases.get(profile_id).is_none_or(|l| l.token != token) {
      return;
    }
    leases.remove(profile_id);
  }
  notify_lost(profile_id, reply);
}

fn notify_lost(profile_id: &str, reply: &Value) {
  note_taken_over(profile_id);
  log::warn!(
    "Sync lease lost profile={profile_id} holder={}",
    short(reply["holder"]["deviceId"].as_str().unwrap_or(""))
  );
  let _ = crate::events::emit(
    "profile-sync-lease-lost",
    json!({
      "profile_id": profile_id,
      "profile_name": crate::profile::ProfileManager::instance()
        .list_profiles()
        .ok()
        .and_then(|all| all.into_iter().find(|p| p.id.to_string() == profile_id))
        .map(|p| p.name)
        .unwrap_or_default(),
      "device": reply["holder"]["deviceName"].as_str().unwrap_or(""),
    }),
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_refusal_names_the_device_and_whether_it_can_be_taken_over() {
    let err = held_error(
      "p1",
      &json!({
        "code": "PROFILE_LEASE_HELD",
        "holder": { "deviceId": "d", "deviceName": "Work Mac" },
        "expiresAt": "2026-11-03T10:00:00.000Z",
        "sameAccount": true,
      }),
    );
    let parsed: Value = serde_json::from_str(&err).unwrap();
    assert_eq!(parsed["code"], "PROFILE_LEASE_HELD");
    assert_eq!(parsed["params"]["device"], "Work Mac");
    assert_eq!(parsed["params"]["canTakeOver"], "true");
    assert_eq!(parsed["params"]["expiresAt"], "2026-11-03T10:00:00.000Z");
  }

  #[test]
  fn device_ids_are_shortened_in_the_log() {
    assert_eq!(short("abc").len(), 8);
    assert_ne!(short("abc"), short("abe"));
  }
}
