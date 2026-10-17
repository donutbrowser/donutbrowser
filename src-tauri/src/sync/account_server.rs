//! Where a device syncs: Donut cloud, a signed-in paid account's own
//! donut-sync server, or a server opened by a shared `SYNC_TOKEN`.
//!
//! The app signs in to an account's own server with a short token the Donut
//! API issues for its one address, and the server asks the API whose the token
//! is. The team's namespace, roles and group access thus apply there as on
//! Donut cloud, and every person who syncs needs their own seat. A shared
//! `SYNC_TOKEN` opens the whole bucket to anyone who has it, so it is set up
//! signed out; signed in, a device uses it only when the person picks it.

use serde::{Deserialize, Serialize};

use crate::settings_manager::{AppSettings, SettingsManager};

/// A source a signed-in device can pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncSourceKind {
  Cloud,
  Account,
  SelfHosted,
}

/// Where this device syncs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncSource {
  Cloud,
  /// The signed-in account's own server.
  Account(String),
  /// A server opened by a shared token.
  SelfHosted(String),
}

impl SyncSource {
  pub fn kind(&self) -> SyncSourceKind {
    match self {
      Self::Cloud => SyncSourceKind::Cloud,
      Self::Account(_) => SyncSourceKind::Account,
      Self::SelfHosted(_) => SyncSourceKind::SelfHosted,
    }
  }
}

/// The sources this device can pick from, and the one in use.
#[derive(Debug, Clone, Serialize)]
pub struct SyncSourceState {
  pub active: Option<SyncSourceKind>,
  pub account_server: Option<String>,
  pub self_hosted_server: Option<String>,
}

/// The address in the one form the Donut API and donut-sync also write: scheme,
/// host and port as the URL parser writes them, then the path without trailing
/// slashes. A token is bound to this exact string.
pub fn normalize_server_url(raw: &str) -> Option<String> {
  let raw = raw.trim();
  if raw.is_empty() || raw.len() > 2048 {
    return None;
  }
  let url = url::Url::parse(raw).ok()?;
  if !matches!(url.scheme(), "http" | "https") {
    return None;
  }
  let host = url.host_str().filter(|host| !host.is_empty())?;
  if !url.username().is_empty() || url.password().is_some() {
    return None;
  }
  if url.query().is_some_and(|q| !q.is_empty()) || url.fragment().is_some_and(|f| !f.is_empty()) {
    return None;
  }
  let port = url
    .port()
    .map(|port| format!(":{port}"))
    .unwrap_or_default();
  Some(format!(
    "{}://{host}{port}{}",
    url.scheme(),
    url.path().trim_end_matches('/')
  ))
}

/// The source the settings name. Signed out, the shared-token server. Signed
/// in, the picked one while its server is still set; with no pick, an own
/// server set before the choice existed, else Donut cloud. A team seat never
/// syncs with a shared-token server, which is outside the team's rules.
pub(crate) fn resolve(
  settings: &AppSettings,
  signed_in: bool,
  team_seat: bool,
) -> Option<SyncSource> {
  if !signed_in {
    return settings.sync_server_url.clone().map(SyncSource::SelfHosted);
  }
  let account = settings
    .account_sync_server_url
    .clone()
    .map(SyncSource::Account);
  let picked = match settings.sync_source {
    Some(SyncSourceKind::Cloud) => Some(SyncSource::Cloud),
    Some(SyncSourceKind::Account) => account.clone(),
    Some(SyncSourceKind::SelfHosted) if team_seat => Some(SyncSource::Cloud),
    Some(SyncSourceKind::SelfHosted) => token_server(settings).map(SyncSource::SelfHosted),
    None => None,
  };
  Some(picked.or(account).unwrap_or(SyncSource::Cloud))
}

/// Whether `url` is Donut cloud's address, in any scheme or spelling.
fn is_cloud_address(url: &str) -> bool {
  let without_scheme = |url: &str| {
    normalize_server_url(url)
      .and_then(|url| url.split_once("://").map(|(_, rest)| rest.to_string()))
  };
  without_scheme(url)
    .is_some_and(|rest| Some(rest) == without_scheme(crate::cloud_auth::CLOUD_SYNC_URL))
}

/// The stored shared-token server a signed-in device may pick. Older versions
/// stored Donut cloud's address there with a cloud-issued token; that is not
/// one.
fn token_server(settings: &AppSettings) -> Option<String> {
  settings
    .sync_server_url
    .clone()
    .filter(|url| !is_cloud_address(url))
}

/// Turn a team seat's shared-token pick into Donut cloud. Whether it did.
fn settle_team_pick(settings: &mut AppSettings, team_seat: bool) -> bool {
  let reset = team_seat && settings.sync_source == Some(SyncSourceKind::SelfHosted);
  if reset {
    settings.sync_source = Some(SyncSourceKind::Cloud);
  }
  reset
}

/// Store `server` as the account's own server and pick it, or drop it.
fn apply_account_server(settings: &mut AppSettings, server: Option<String>) {
  if server.is_some() {
    settings.sync_source = Some(SyncSourceKind::Account);
  } else if settings.sync_source == Some(SyncSourceKind::Account) {
    settings.sync_source = None;
  }
  settings.account_sync_server_url = server;
}

fn load() -> Option<AppSettings> {
  SettingsManager::instance().load_settings().ok()
}

fn load_for_write() -> Result<AppSettings, String> {
  SettingsManager::instance()
    .load_settings()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))
}

fn save(settings: &AppSettings) -> Result<(), String> {
  SettingsManager::instance()
    .save_settings(settings)
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?;
  let _ = crate::events::emit_empty("sync-source-changed");
  Ok(())
}

/// The settings the source comes from, whether someone is signed in, and
/// whether they hold a team seat. A shared-token pick stored before the seat
/// is stored as Donut cloud here, once.
async fn snapshot() -> Result<(AppSettings, bool, bool), String> {
  let seat = crate::cloud_auth::CLOUD_AUTH
    .get_user()
    .await
    .map(|auth| auth.user.team_id.is_some());
  let team_seat = seat == Some(true);
  let mut settings = load_for_write()?;
  if settle_team_pick(&mut settings, team_seat) && save(&settings).is_ok() {
    log::info!("Sync source reset to cloud reason=team_seat");
  }
  Ok((settings, seat.is_some(), team_seat))
}

/// Where this device syncs now, or `None` when it has nowhere to sync.
pub async fn current() -> Option<SyncSource> {
  let (settings, signed_in, team_seat) = snapshot().await.ok()?;
  resolve(&settings, signed_in, team_seat)
}

/// The own server this signed-in account syncs with, or `None`.
pub async fn configured() -> Option<String> {
  match current().await {
    Some(SyncSource::Account(server)) => Some(server),
    _ => None,
  }
}

/// Whether a signed-in device syncs with the shared-token server its person
/// picked.
pub async fn self_hosted_picked() -> bool {
  snapshot()
    .await
    .ok()
    .and_then(|(settings, _, team_seat)| resolve(&settings, true, team_seat))
    .is_some_and(|source| matches!(source, SyncSource::SelfHosted(_)))
}

/// The refusal for work that runs a profile on Donut's hosts. They take the
/// profile from Donut cloud and cannot reach any other server. A team seat's
/// shared-token pick is already Donut cloud on disk once sync has started.
pub fn cloud_run_refusal() -> Option<String> {
  let source = resolve(&load()?, true, false)?;
  (source != SyncSource::Cloud).then(|| crate::backend_error("REMOTE_NEEDS_DONUT_SYNC"))
}

/// Forget the own server and the pick at sign-out; the next account starts on
/// Donut cloud.
pub(crate) fn clear() {
  let manager = SettingsManager::instance();
  if let Ok(mut settings) = manager.load_settings() {
    let had_account = settings.account_sync_server_url.take().is_some();
    if had_account || settings.sync_source.take().is_some() {
      let _ = manager.save_settings(&settings);
    }
  }
}

async fn state(
  app_handle: &tauri::AppHandle,
  settings: &AppSettings,
  signed_in: bool,
  team_seat: bool,
) -> SyncSourceState {
  let has_token = SettingsManager::instance()
    .get_sync_token(app_handle)
    .await
    .ok()
    .flatten()
    .is_some();
  SyncSourceState {
    active: resolve(settings, signed_in, team_seat).map(|source| source.kind()),
    account_server: settings.account_sync_server_url.clone(),
    self_hosted_server: token_server(settings).filter(|_| has_token && !team_seat),
  }
}

/// Check that `raw` is a server this account can sync with, and return its
/// address.
async fn check(raw: &str) -> Result<String, String> {
  let auth = &crate::cloud_auth::CLOUD_AUTH;
  if !auth.is_logged_in().await {
    return Err(crate::backend_error("ACCOUNT_SYNC_SIGN_IN_REQUIRED"));
  }
  if !auth.can_use_cloud_backup().await {
    return Err(crate::backend_error("ACCOUNT_SYNC_PLAN_REQUIRED"));
  }
  let server =
    normalize_server_url(raw).ok_or_else(|| crate::backend_error("SYNC_SERVER_URL_INVALID"))?;

  let probe = super::preflight::check_sync_server(&server).await;
  if !probe.server_reachable || probe.storage_ready == Some(false) {
    return Err(crate::backend_error("SYNC_SERVER_UNREACHABLE"));
  }
  if probe.storage_reachable == Some(false) {
    return Err(
      serde_json::json!({
        "code": "SYNC_SERVER_STORAGE_UNREACHABLE",
        "params": { "endpoint": probe.storage_endpoint.unwrap_or_default() },
      })
      .to_string(),
    );
  }
  match probe.account_url.as_deref().and_then(normalize_server_url) {
    None => return Err(crate::backend_error("SYNC_SERVER_NO_ACCOUNTS")),
    Some(address) if address != server => {
      return Err(
        serde_json::json!({
          "code": "SYNC_SERVER_ADDRESS_MISMATCH",
          "params": { "address": address },
        })
        .to_string(),
      );
    }
    Some(_) => {}
  }

  // The API decides who may sync. Asking now names a refusal here, not at the
  // first sync.
  auth.server_sync_token(&server).await?;
  Ok(server)
}

#[tauri::command]
pub async fn get_sync_source(app_handle: tauri::AppHandle) -> Result<SyncSourceState, String> {
  let (settings, signed_in, team_seat) = snapshot().await?;
  Ok(state(&app_handle, &settings, signed_in, team_seat).await)
}

/// Pick where this signed-in device syncs. The caller restarts sync.
#[tauri::command]
pub async fn set_sync_source(
  app_handle: tauri::AppHandle,
  source: SyncSourceKind,
) -> Result<SyncSourceState, String> {
  let (mut settings, signed_in, team_seat) = snapshot().await?;
  if !signed_in {
    return Err(crate::backend_error("ACCOUNT_SYNC_SIGN_IN_REQUIRED"));
  }
  match source {
    SyncSourceKind::Cloud => {}
    SyncSourceKind::Account => {
      if settings.account_sync_server_url.is_none() {
        return Err(crate::backend_error("SYNC_NOT_CONFIGURED"));
      }
      if !crate::cloud_auth::CLOUD_AUTH.can_use_cloud_backup().await {
        return Err(crate::backend_error("ACCOUNT_SYNC_PLAN_REQUIRED"));
      }
    }
    SyncSourceKind::SelfHosted => {
      if team_seat {
        return Err(crate::backend_error("SELF_HOSTED_TEAM_SEAT"));
      }
      let offered = state(&app_handle, &settings, signed_in, team_seat).await;
      if offered.self_hosted_server.is_none() {
        return Err(crate::backend_error("SYNC_NOT_CONFIGURED"));
      }
    }
  }
  settings.sync_source = Some(source);
  save(&settings)?;
  log::info!("Sync source set source={source:?}");
  Ok(state(&app_handle, &settings, signed_in, team_seat).await)
}

/// Store this signed-in account's own server and sync with it, or forget it
/// when `server_url` is empty.
#[tauri::command]
pub async fn set_account_sync_server(
  app_handle: tauri::AppHandle,
  server_url: Option<String>,
) -> Result<SyncSourceState, String> {
  let server = match server_url.as_deref().map(str::trim) {
    Some(raw) if !raw.is_empty() => Some(check(raw).await?),
    _ => None,
  };
  let (mut settings, signed_in, team_seat) = snapshot().await?;
  let own_server = server.is_some();
  apply_account_server(&mut settings, server);
  save(&settings)?;
  log::info!("Account sync server set own_server={own_server}");
  Ok(state(&app_handle, &settings, signed_in, team_seat).await)
}

#[cfg(test)]
mod tests {
  use super::*;

  const OWN: &str = "https://own.example.com";
  const SHARED: &str = "https://shared.example.com";

  fn settings(
    account: Option<&str>,
    self_hosted: Option<&str>,
    picked: Option<SyncSourceKind>,
  ) -> AppSettings {
    AppSettings {
      account_sync_server_url: account.map(str::to_string),
      sync_server_url: self_hosted.map(str::to_string),
      sync_source: picked,
      ..AppSettings::default()
    }
  }

  #[test]
  fn signed_out_syncs_with_the_shared_token_server_only() {
    assert_eq!(resolve(&settings(None, None, None), false, false), None);
    assert_eq!(
      resolve(
        &settings(Some(OWN), Some(SHARED), Some(SyncSourceKind::Account)),
        false,
        false
      ),
      Some(SyncSource::SelfHosted(SHARED.into()))
    );
    assert_eq!(
      resolve(&settings(Some(OWN), None, None), false, false),
      None,
      "an own server needs a signed-in account"
    );
  }

  #[test]
  fn signing_in_starts_on_donut_cloud() {
    assert_eq!(
      resolve(&settings(None, None, None), true, false),
      Some(SyncSource::Cloud)
    );
    assert_eq!(
      resolve(&settings(None, Some(SHARED), None), true, false),
      Some(SyncSource::Cloud)
    );
  }

  #[test]
  fn an_own_server_set_before_the_choice_stays_in_use() {
    assert_eq!(
      resolve(&settings(Some(OWN), Some(SHARED), None), true, false),
      Some(SyncSource::Account(OWN.into()))
    );
  }

  #[test]
  fn the_pick_wins_while_its_server_is_set() {
    let both = |picked| {
      resolve(
        &settings(Some(OWN), Some(SHARED), Some(picked)),
        true,
        false,
      )
    };
    assert_eq!(both(SyncSourceKind::Cloud), Some(SyncSource::Cloud));
    assert_eq!(
      both(SyncSourceKind::Account),
      Some(SyncSource::Account(OWN.into()))
    );
    assert_eq!(
      both(SyncSourceKind::SelfHosted),
      Some(SyncSource::SelfHosted(SHARED.into()))
    );

    assert_eq!(
      resolve(
        &settings(None, None, Some(SyncSourceKind::SelfHosted)),
        true,
        false
      ),
      Some(SyncSource::Cloud),
      "a pick whose server is gone falls back"
    );
    assert_eq!(
      resolve(
        &settings(Some(OWN), None, Some(SyncSourceKind::SelfHosted)),
        true,
        false
      ),
      Some(SyncSource::Account(OWN.into()))
    );
  }

  #[test]
  fn saving_an_own_server_picks_it_and_removing_it_returns_to_cloud() {
    let mut saved = settings(None, Some(SHARED), Some(SyncSourceKind::Cloud));
    apply_account_server(&mut saved, Some(OWN.into()));
    assert_eq!(
      resolve(&saved, true, false),
      Some(SyncSource::Account(OWN.into()))
    );
    apply_account_server(&mut saved, None);
    assert_eq!(saved.sync_source, None);
    assert_eq!(resolve(&saved, true, false), Some(SyncSource::Cloud));

    let mut shared = settings(Some(OWN), Some(SHARED), Some(SyncSourceKind::SelfHosted));
    apply_account_server(&mut shared, None);
    assert_eq!(
      resolve(&shared, true, false),
      Some(SyncSource::SelfHosted(SHARED.into())),
      "removing the own server keeps another pick"
    );
  }

  #[test]
  fn donut_clouds_address_is_never_a_token_server() {
    for stored in [
      "https://sync.donutbrowser.com",
      "https://Sync.DonutBrowser.com/",
      "http://sync.donutbrowser.com:80",
    ] {
      let legacy = settings(None, Some(stored), Some(SyncSourceKind::SelfHosted));
      assert_eq!(token_server(&legacy), None, "{stored}");
      assert_eq!(
        resolve(&legacy, true, false),
        Some(SyncSource::Cloud),
        "{stored}"
      );
    }
    assert_eq!(
      token_server(&settings(None, Some(SHARED), None)).as_deref(),
      Some(SHARED)
    );
  }

  #[test]
  fn a_team_seat_never_syncs_with_a_shared_token_server() {
    let picked = settings(Some(OWN), Some(SHARED), Some(SyncSourceKind::SelfHosted));
    assert_eq!(resolve(&picked, true, true), Some(SyncSource::Cloud));
    assert_eq!(
      resolve(&settings(Some(OWN), Some(SHARED), None), true, true),
      Some(SyncSource::Account(OWN.into()))
    );

    let mut stored = picked.clone();
    assert!(!settle_team_pick(&mut stored, false));
    assert_eq!(stored.sync_source, Some(SyncSourceKind::SelfHosted));
    assert!(settle_team_pick(&mut stored, true));
    assert_eq!(stored.sync_source, Some(SyncSourceKind::Cloud));
    assert!(!settle_team_pick(&mut stored, true), "reset once");
    assert_eq!(resolve(&stored, true, false), Some(SyncSource::Cloud));
  }

  #[test]
  fn writes_one_form_for_every_way_to_type_the_same_address() {
    // The same cases as the API and donut-sync: a token only matches when all
    // three write the address alike.
    for typed in [
      "https://Sync.Example.com",
      "https://sync.example.com/",
      " https://sync.example.com:443// ",
      "https://sync.example.com/?",
    ] {
      assert_eq!(
        normalize_server_url(typed).as_deref(),
        Some("https://sync.example.com"),
        "{typed}"
      );
    }
    assert_eq!(
      normalize_server_url("http://192.168.1.5:3929/donut/").as_deref(),
      Some("http://192.168.1.5:3929/donut")
    );
    assert_eq!(
      normalize_server_url("http://[::1]:3929").as_deref(),
      Some("http://[::1]:3929")
    );
  }

  #[test]
  fn refuses_what_cannot_be_a_server_address() {
    let long = format!("https://{}.com", "a".repeat(2100));
    for bad in [
      "",
      "sync.example.com",
      "ftp://sync.example.com",
      "https://user:pass@sync.example.com",
      "https://sync.example.com/?a=1",
      "https://sync.example.com/#x",
      long.as_str(),
    ] {
      assert_eq!(normalize_server_url(bad), None, "{bad}");
    }
  }
}
