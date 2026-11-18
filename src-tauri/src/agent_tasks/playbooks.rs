//! Playbooks: written know-how for a site ("sign in with the saved account,
//! orders are under Account > Orders"), personal or shared with the team. The
//! cloud keeps them; a task's prompt gets the ones its routine picked and the
//! ones written for its site.

use crate::cloud_errors::FailureCodes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PLAYBOOK_CODES: FailureCodes = FailureCodes {
  bad_request: "AGENT_PLAYBOOK_INVALID",
  forbidden: "AGENT_PLAYBOOK_READ_ONLY",
  not_found: "AGENT_PLAYBOOK_NOT_FOUND",
  conflict: "AGENT_PLAYBOOK_INVALID",
};

const MAX_NAME_CHARS: usize = 120;
const MAX_INSTRUCTIONS_CHARS: usize = 8_000;
const MAX_SITES: usize = 20;
/// Playbooks a routine picks at most.
pub const MAX_PICKED: usize = 10;
/// A list this fresh serves a prompt.
const FRESH_FOR: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playbook {
  pub id: String,
  #[serde(default)]
  pub name: String,
  #[serde(default)]
  pub instructions: String,
  #[serde(default)]
  pub sites: Vec<String>,
  #[serde(default)]
  pub shared: bool,
  #[serde(default)]
  pub updated_at: Option<String>,
  /// The caller wrote it, or owns the team: it may change it.
  #[serde(default = "editable_by_default")]
  pub editable: bool,
}

fn editable_by_default() -> bool {
  true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookDraft {
  pub name: String,
  pub instructions: String,
  #[serde(default)]
  pub sites: Vec<String>,
  #[serde(default)]
  pub shared: bool,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Listed {
  Wrapped { playbooks: Vec<Playbook> },
  Bare(Vec<Playbook>),
}

/// A site as a bare host: `https://www.shop.example/x` and `shop.example`
/// are both `shop.example`.
fn site(text: &str) -> Option<String> {
  let text = text.trim().trim_end_matches('/');
  if text.is_empty() {
    return None;
  }
  let url = if text.contains("://") {
    text.to_string()
  } else {
    format!("https://{text}")
  };
  super::logins::host_of(&url).filter(|host| host.contains('.'))
}

pub fn checked(draft: PlaybookDraft) -> Result<PlaybookDraft, String> {
  let name = draft.name.trim().to_string();
  if name.is_empty() {
    return Err(crate::backend_error("NAME_CANNOT_BE_EMPTY"));
  }
  if name.chars().count() > MAX_NAME_CHARS {
    return Err(crate::backend_error("AGENT_PLAYBOOK_INVALID"));
  }
  let instructions = draft.instructions.trim().to_string();
  if instructions.is_empty() {
    return Err(crate::backend_error("AGENT_PROMPT_EMPTY"));
  }
  if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
    return Err(
      serde_json::json!({ "code": "AGENT_TEXT_TOO_LONG", "params": { "max": MAX_INSTRUCTIONS_CHARS.to_string() } })
        .to_string(),
    );
  }
  let mut sites: Vec<String> = Vec::new();
  for text in &draft.sites {
    let host = site(text).ok_or_else(|| crate::backend_error("AGENT_PLAYBOOK_SITE_INVALID"))?;
    if !sites.contains(&host) {
      sites.push(host);
    }
  }
  if sites.len() > MAX_SITES {
    return Err(crate::backend_error("AGENT_PLAYBOOK_INVALID"));
  }
  Ok(PlaybookDraft {
    name,
    instructions,
    sites,
    shared: draft.shared,
  })
}

/// The playbooks a task gets: the ones picked, in their order, then the ones
/// written for its site.
pub fn for_task<'a>(
  all: &'a [Playbook],
  picked: &[String],
  task_site: Option<&str>,
) -> Vec<&'a Playbook> {
  let mut chosen: Vec<&Playbook> = picked
    .iter()
    .filter_map(|id| all.iter().find(|playbook| &playbook.id == id))
    .collect();
  if let Some(task_site) = task_site {
    for playbook in all {
      let fits = playbook
        .sites
        .iter()
        .filter_map(|text| site(text))
        .any(|host| super::logins::same_site(&host, task_site));
      if fits && !chosen.iter().any(|known| known.id == playbook.id) {
        chosen.push(playbook);
      }
    }
  }
  chosen
}

static KNOWN: Mutex<Option<(Instant, Vec<Playbook>)>> = Mutex::new(None);
static READS: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent playbooks read");

fn forget() {
  if let Ok(mut known) = KNOWN.lock() {
    *known = None;
  }
}

async fn fetch() -> Result<Vec<Playbook>, String> {
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::playbooks());
  }
  let url = format!("{}/playbooks", super::cloud::base());
  let listed: Listed =
    super::cloud::call_with("playbooks", reqwest::Method::GET, url, None, PLAYBOOK_CODES).await?;
  Ok(match listed {
    Listed::Wrapped { playbooks } => playbooks,
    Listed::Bare(playbooks) => playbooks,
  })
}

/// The playbooks for a prompt, from a list at most a minute old. A list the
/// cloud cannot give is no playbooks: the task runs without them.
pub async fn known() -> Vec<Playbook> {
  let fresh = KNOWN
    .lock()
    .ok()
    .and_then(|known| known.clone())
    .filter(|(at, _)| at.elapsed() < FRESH_FOR);
  if let Some((_, list)) = fresh {
    return list;
  }
  match fetch().await {
    Ok(list) => {
      READS.succeeded();
      if let Ok(mut known) = KNOWN.lock() {
        *known = Some((Instant::now(), list.clone()));
      }
      list
    }
    Err(e) => {
      READS.failed(super::error_code(&e));
      Vec::new()
    }
  }
}

fn changed() {
  forget();
  let _ = crate::events::emit_empty("agent-playbooks-changed");
}

#[tauri::command]
pub async fn list_agent_playbooks() -> Result<Vec<Playbook>, String> {
  super::ensure_entitled().await?;
  let list = fetch().await?;
  if let Ok(mut known) = KNOWN.lock() {
    *known = Some((Instant::now(), list.clone()));
  }
  Ok(list)
}

#[tauri::command]
pub async fn create_agent_playbook(playbook: PlaybookDraft) -> Result<Playbook, String> {
  super::ensure_entitled().await?;
  let draft = checked(playbook)?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    let saved = super::mock::save_playbook(None, draft)?;
    changed();
    return Ok(saved);
  }
  let url = format!("{}/playbooks", super::cloud::base());
  let body = serde_json::to_value(draft).unwrap_or(Value::Null);
  let saved = super::cloud::call_with(
    "playbook_create",
    reqwest::Method::POST,
    url,
    Some(body),
    PLAYBOOK_CODES,
  )
  .await?;
  changed();
  Ok(saved)
}

#[tauri::command]
pub async fn update_agent_playbook(
  id: String,
  playbook: PlaybookDraft,
) -> Result<Playbook, String> {
  super::ensure_entitled().await?;
  let id = super::cloud::segment(&id, "AGENT_PLAYBOOK_NOT_FOUND")?;
  let draft = checked(playbook)?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    let saved = super::mock::save_playbook(Some(id), draft)?;
    changed();
    return Ok(saved);
  }
  let url = format!("{}/playbooks/{id}", super::cloud::base());
  let body = serde_json::to_value(draft).unwrap_or(Value::Null);
  let saved = super::cloud::call_with(
    "playbook_update",
    reqwest::Method::PATCH,
    url,
    Some(body),
    PLAYBOOK_CODES,
  )
  .await?;
  changed();
  Ok(saved)
}

#[tauri::command]
pub async fn delete_agent_playbook(id: String) -> Result<(), String> {
  super::ensure_entitled().await?;
  let id = super::cloud::segment(&id, "AGENT_PLAYBOOK_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    super::mock::delete_playbook(&id)?;
    changed();
    return Ok(());
  }
  let url = format!("{}/playbooks/{id}", super::cloud::base());
  super::cloud::call_with::<Option<Value>>(
    "playbook_delete",
    reqwest::Method::DELETE,
    url,
    None,
    PLAYBOOK_CODES,
  )
  .await?;
  changed();
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn playbook(id: &str, sites: &[&str]) -> Playbook {
    Playbook {
      id: id.into(),
      name: id.into(),
      instructions: "x".into(),
      sites: sites.iter().map(|s| s.to_string()).collect(),
      shared: false,
      updated_at: None,
      editable: true,
    }
  }

  #[test]
  fn a_task_gets_the_picked_playbooks_then_its_site_s() {
    let all = vec![
      playbook("mail", &["mail.example"]),
      playbook("shop", &["shop.example"]),
      playbook("store", &["https://www.example.com/store"]),
      playbook("picked", &[]),
    ];
    let ids = |list: Vec<&Playbook>| list.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    assert_eq!(
      ids(for_task(
        &all,
        &["picked".into(), "gone".into()],
        Some("shop.example")
      )),
      vec!["picked", "shop"]
    );
    assert_eq!(
      ids(for_task(&all, &["shop".into()], Some("shop.example"))),
      vec!["shop"],
      "once each"
    );
    assert_eq!(
      ids(for_task(&all, &[], Some("accounts.example.com"))),
      vec!["store"]
    );
    assert!(for_task(&all, &[], None).is_empty());
  }

  #[test]
  fn a_playbook_is_checked_before_it_is_sent() {
    let draft = PlaybookDraft {
      name: " Shop ".into(),
      instructions: " Sign in first ".into(),
      sites: vec![
        "https://www.Shop.example/orders".into(),
        "shop.example".into(),
      ],
      shared: true,
    };
    let checked_draft = checked(draft.clone()).unwrap();
    assert_eq!(checked_draft.name, "Shop");
    assert_eq!(checked_draft.sites, vec!["shop.example".to_string()]);
    assert!(checked(PlaybookDraft {
      sites: vec!["not a site".into()],
      ..draft.clone()
    })
    .unwrap_err()
    .contains("AGENT_PLAYBOOK_SITE_INVALID"));
    assert!(checked(PlaybookDraft {
      name: " ".into(),
      ..draft.clone()
    })
    .unwrap_err()
    .contains("NAME_CANNOT_BE_EMPTY"));
    assert!(checked(PlaybookDraft {
      instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1),
      ..draft
    })
    .unwrap_err()
    .contains("AGENT_TEXT_TOO_LONG"));
  }
}
