//! What a task gets as it starts, beyond its words: a prompt with what Donut
//! knows (playbooks, the profile's notes and recent sites, the input, how to
//! end the answer), the profile's logins for its site, and the settings the
//! cloud's gateway reads (effort, pace, caps), sent before the engine has it.

use super::history::Site;
use super::logins::{self, Login};
use super::options::RunOptions;
use super::output::Column;
use super::{memory, playbooks, prompt};
use crate::profile::BrowserProfile;
use serde::Serialize;

/// Beyond the words, what every task of a run or a chat starts with.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
  pub options: RunOptions,
  /// The webhook's body or the event's words that fired a routine.
  pub input: Option<String>,
  /// The keys of the object each answer ends with.
  pub columns: Vec<Column>,
  /// Playbooks the routine picked.
  pub playbook_ids: Vec<String>,
}

/// What `Wayfern.agentStart` carries besides the task id.
pub struct Start {
  pub prompt: String,
  pub logins: Vec<Login>,
}

/// The profile's notes, and its recent sites while it allows them.
fn known(profile: &BrowserProfile) -> (Vec<String>, Vec<Site>) {
  let memory = memory::read(&profile.id.to_string()).unwrap_or_default();
  let sites = if memory.use_history {
    super::history::recent_sites(profile)
  } else {
    Vec::new()
  };
  (
    memory.notes.into_iter().map(|note| note.text).collect(),
    sites,
  )
}

/// Ready a task: tell the cloud how it runs, then build its prompt and find
/// its logins. `site_url` names the task's site: its start page, or the
/// first address in its words.
pub async fn prepare(
  task_id: &str,
  profile: &BrowserProfile,
  words: &str,
  site_url: Option<&str>,
  brief: &Brief,
) -> Result<Start, String> {
  let profile_id = profile.id.to_string();
  super::options::send(task_id, &profile_id, &brief.options).await?;
  let site_url = site_url
    .map(str::to_string)
    .or_else(|| prompt::first_url(words));
  let site = site_url.as_deref().and_then(logins::host_of);
  let all = playbooks::known().await;
  let chosen: Vec<(String, String)> =
    playbooks::for_task(&all, &brief.playbook_ids, site.as_deref())
      .into_iter()
      .map(|playbook| (playbook.name.clone(), playbook.instructions.clone()))
      .collect();
  let owned = profile.clone();
  let url = site_url.clone();
  let (notes, sites, logins) = tokio::task::spawn_blocking(move || {
    let (notes, sites) = known(&owned);
    let logins = logins::for_task(&owned, url.as_deref());
    (notes, sites, logins)
  })
  .await
  .unwrap_or_default();
  let context = prompt::Context {
    playbooks: chosen,
    notes,
    sites,
    columns: brief.columns.clone(),
  };
  log::debug!(
    "Agent task briefed profile={profile_id} task={task_id} playbooks={} notes={} sites={} logins={}",
    context.playbooks.len(),
    context.notes.len(),
    context.sites.len(),
    logins.len()
  );
  Ok(Start {
    prompt: prompt::build(&context, words, brief.input.as_deref()),
    logins,
  })
}
