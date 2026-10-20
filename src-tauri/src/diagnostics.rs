//! What a bug report carries: anonymous facts about this install, then the
//! newest app logs and proxy worker logs, redacted. Profiles, proxies, VPNs
//! and groups appear by alias (`profile-3`), the same alias in the facts and
//! in every log line, so one profile's lines can be followed without its name
//! or id. Feedback attaches it, `read_diagnostics` hands it to an agent, and
//! the log export copies it.

use regex_lite::Regex;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// The proxy worker logs take at most this share of the budget.
const WORKER_LOG_SHARE: usize = 4;
/// Profiles listed one per line; the counts cover all of them.
const MAX_LISTED_PROFILES: usize = 40;

static ANY_UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
    .expect("valid UUID regex")
});

/// Account facts, read before the blocking part.
struct Account {
  signed_in: bool,
  plan: Option<String>,
  sync: &'static str,
}

/// The excerpt, at most `max_bytes`. Facts first, then the app logs and the
/// worker logs, each file under a `===== name =====` header.
pub async fn excerpt(log_dir: PathBuf, max_bytes: usize) -> std::io::Result<String> {
  let user = crate::cloud_auth::CLOUD_AUTH.get_user().await;
  let sync = match crate::sync::account_server::current().await {
    None => "off",
    Some(source) => match source.kind() {
      crate::sync::account_server::SyncSourceKind::Cloud => "cloud",
      crate::sync::account_server::SyncSourceKind::Account => "account_server",
      crate::sync::account_server::SyncSourceKind::SelfHosted => "self_hosted",
    },
  };
  let account = Account {
    signed_in: user.is_some(),
    plan: user.map(|state| state.user.plan),
    sync,
  };
  tokio::task::spawn_blocking(move || build(&log_dir, max_bytes, &account))
    .await
    .map_err(std::io::Error::other)?
}

fn build(log_dir: &Path, max_bytes: usize, account: &Account) -> std::io::Result<String> {
  let profiles = crate::profile::ProfileManager::instance()
    .list_profiles()
    .unwrap_or_default();
  let proxies = crate::proxy_manager::PROXY_MANAGER.get_stored_proxies();
  let vpns = crate::vpn::VPN_STORAGE
    .lock()
    .ok()
    .and_then(|storage| storage.list_configs().ok())
    .unwrap_or_default();
  let groups = crate::group_manager::GROUP_MANAGER
    .lock()
    .ok()
    .and_then(|manager| manager.get_all_groups().ok())
    .unwrap_or_default();

  let mut aliases = Aliases::default();
  let mut profile_ids: Vec<String> = profiles.iter().map(|p| p.id.to_string()).collect();
  profile_ids.sort();
  aliases.add_all("profile", profile_ids);
  aliases.add_all("proxy", sorted(proxies.iter().map(|p| p.id.clone())));
  aliases.add_all("vpn", sorted(vpns.iter().map(|v| v.id.clone())));
  aliases.add_all("group", sorted(groups.iter().map(|g| g.id.clone())));

  let proxy_types: HashMap<&str, &str> = proxies
    .iter()
    .map(|p| (p.id.as_str(), p.proxy_settings.proxy_type.as_str()))
    .collect();
  let facts = facts(
    &profiles,
    &proxy_types,
    vpns.len(),
    groups.len(),
    account,
    &aliases,
  );

  let prepare = |raw: &str| crate::log_redaction::text(&aliases.apply(raw));
  let mut out = format!("===== facts =====\n{facts}");
  let worker_budget = max_bytes.saturating_sub(out.len()) / WORKER_LOG_SHARE;
  let workers = crate::settings_manager::recent_log_files(
    &std::env::temp_dir(),
    worker_budget,
    is_worker_log,
    &prepare,
  )
  .unwrap_or_default();
  let app_budget = max_bytes.saturating_sub(out.len() + workers.len());
  let app = if log_dir.exists() {
    crate::settings_manager::recent_log_files(log_dir, app_budget, is_app_log, &prepare)?
  } else {
    String::new()
  };
  out.push_str(&app);
  out.push_str(&workers);
  Ok(out)
}

fn sorted(ids: impl Iterator<Item = String>) -> Vec<String> {
  let mut ids: Vec<String> = ids.collect();
  ids.sort();
  ids
}

pub(crate) fn is_app_log(name: &str) -> bool {
  name.ends_with(".log") || name.ends_with(".txt")
}

/// `donut-proxy-<id>.log`, one per worker (proxy, VPN and Xray routes alike).
fn is_worker_log(name: &str) -> bool {
  name.starts_with("donut-proxy-") && name.ends_with(".log")
}

fn facts(
  profiles: &[crate::profile::BrowserProfile],
  proxy_types: &HashMap<&str, &str>,
  vpn_count: usize,
  group_count: usize,
  account: &Account,
  aliases: &Aliases,
) -> String {
  let info = crate::settings_manager::get_system_info();
  let auto_updates_disabled = crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .map(|s| s.disable_auto_updates)
    .unwrap_or(false);
  let wayfern = crate::downloaded_browsers_registry::DownloadedBrowsersRegistry::instance()
    .get_downloaded_versions("wayfern");

  let running = |p: &crate::profile::BrowserProfile| {
    p.process_id
      .is_some_and(crate::proxy_storage::is_process_running)
  };
  let mut out = String::new();
  let _ = writeln!(
    out,
    "app={} os={} arch={} install={} auto_updates={}",
    info.app_version,
    info.os,
    info.arch,
    crate::app_auto_updater::AppAutoUpdater::install_kind(),
    if auto_updates_disabled { "off" } else { "on" },
  );
  let _ = writeln!(
    out,
    "account={} plan={} sync={}",
    if account.signed_in {
      "signed_in"
    } else {
      "signed_out"
    },
    account.plan.as_deref().unwrap_or("-"),
    account.sync,
  );
  let _ = writeln!(out, "wayfern_installed=[{}]", wayfern.join(" "));
  let _ = writeln!(
    out,
    "profiles={} running={} ephemeral={} with_proxy={} with_vpn={} proxies={} vpns={} groups={}",
    profiles.len(),
    profiles.iter().filter(|p| running(p)).count(),
    profiles.iter().filter(|p| p.ephemeral).count(),
    profiles.iter().filter(|p| p.proxy_id.is_some()).count(),
    profiles.iter().filter(|p| p.vpn_id.is_some()).count(),
    proxy_types.len(),
    vpn_count,
    group_count,
  );
  let _ = writeln!(out, "{}", aliases.apply(&crate::process_report::summary()));

  let mut listed: Vec<&crate::profile::BrowserProfile> = profiles.iter().collect();
  listed.sort_by_key(|p| p.id.to_string());
  for profile in listed.iter().take(MAX_LISTED_PROFILES) {
    let proxy = profile
      .proxy_id
      .as_deref()
      .map(|id| {
        format!(
          "{}:{}",
          aliases.apply(id),
          proxy_types.get(id).copied().unwrap_or("missing")
        )
      })
      .unwrap_or_else(|| "-".to_string());
    let sync = serde_json::to_value(profile.sync_mode)
      .ok()
      .and_then(|value| value.as_str().map(str::to_string))
      .unwrap_or_else(|| "-".to_string());
    let _ = writeln!(
      out,
      "{} browser={} version={} running={} ephemeral={} proxy={} vpn={} group={} sync={} extensions={}",
      aliases.apply(&profile.id.to_string()),
      profile.browser,
      profile.version,
      running(profile),
      profile.ephemeral,
      proxy,
      profile.vpn_id.as_deref().map_or("-".to_string(), |id| aliases.apply(id)),
      profile.group_id.as_deref().map_or("-".to_string(), |id| aliases.apply(id)),
      sync,
      profile.extension_group_id.is_some(),
    );
  }
  if profiles.len() > MAX_LISTED_PROFILES {
    let _ = writeln!(
      out,
      "… {} more profiles",
      profiles.len() - MAX_LISTED_PROFILES
    );
  }
  out
}

/// Ids by alias. An id the table does not know is left for the redaction.
#[derive(Default)]
struct Aliases(HashMap<String, String>);

impl Aliases {
  fn add_all(&mut self, kind: &str, ids: Vec<String>) {
    for (index, id) in ids.into_iter().enumerate() {
      self
        .0
        .insert(id.to_ascii_lowercase(), format!("{kind}-{}", index + 1));
    }
  }

  fn apply(&self, text: &str) -> String {
    ANY_UUID_RE
      .replace_all(text, |caps: &regex_lite::Captures<'_>| {
        let id = &caps[0];
        self
          .0
          .get(&id.to_ascii_lowercase())
          .cloned()
          .unwrap_or_else(|| id.to_string())
      })
      .into_owned()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_id_gets_the_same_alias_everywhere_and_unknown_ids_stay_for_redaction() {
    let mut aliases = Aliases::default();
    aliases.add_all(
      "profile",
      vec![
        "11111111-1111-4111-8111-111111111111".to_string(),
        "22222222-2222-4222-8222-222222222222".to_string(),
      ],
    );
    let line = "Browser launched profile=22222222-2222-4222-8222-222222222222 \
                proxy=33333333-3333-4333-8333-333333333333 \
                again=22222222-2222-4222-8222-222222222222";
    let aliased = aliases.apply(line);
    assert_eq!(
      aliased,
      "Browser launched profile=profile-2 proxy=33333333-3333-4333-8333-333333333333 again=profile-2"
    );
    assert_eq!(
      crate::log_redaction::text(&aliased),
      "Browser launched profile=profile-2 proxy=<redacted-identifier> again=profile-2"
    );
  }

  #[test]
  fn an_uppercase_id_matches_its_alias() {
    let mut aliases = Aliases::default();
    aliases.add_all(
      "vpn",
      vec!["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_string()],
    );
    assert_eq!(
      aliases.apply("vpn=AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"),
      "vpn=vpn-1"
    );
  }

  #[test]
  fn only_donut_proxy_worker_logs_are_worker_logs() {
    assert!(is_worker_log("donut-proxy-0a1b.log"));
    assert!(!is_worker_log("donut-proxy-0a1b.txt"));
    assert!(!is_worker_log("other.log"));
    assert!(is_app_log("DonutBrowser.log"));
    assert!(!is_app_log("settings.json"));
  }
}
