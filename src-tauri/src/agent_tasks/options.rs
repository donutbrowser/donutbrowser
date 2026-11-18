//! How a task runs beyond its words: the effort (which model the gateway
//! picks), the pace (a human's pauses between steps) and the daily action
//! caps. The engine sends none of this; Donut tells the cloud before every
//! `Wayfern.agentStart`, by task, and the gateway reads it by the task id.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
  Fast,
  #[default]
  Standard,
  Thorough,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Pace {
  #[default]
  Human,
  Fast,
}

/// The most actions a day: in a profile, and in a profile on one site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub actions_per_day: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub actions_per_site_per_day: Option<u32>,
}

/// The largest cap the app sends.
const MAX_CAP: u32 = 100_000;

impl Caps {
  pub fn is_empty(&self) -> bool {
    self.actions_per_day.is_none() && self.actions_per_site_per_day.is_none()
  }

  /// Zero is no cap, and each is bounded.
  pub fn checked(self) -> Option<Self> {
    let bound = |n: Option<u32>| n.filter(|n| *n > 0).map(|n| n.min(MAX_CAP));
    let caps = Self {
      actions_per_day: bound(self.actions_per_day),
      actions_per_site_per_day: bound(self.actions_per_site_per_day),
    };
    (!caps.is_empty()).then_some(caps)
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
  #[serde(default)]
  pub effort: Effort,
  #[serde(default)]
  pub pace: Pace,
  #[serde(default)]
  pub caps: Option<Caps>,
}

impl RunOptions {
  pub fn checked(self) -> Self {
    Self {
      caps: self.caps.and_then(Caps::checked),
      ..self
    }
  }
}

/// The body of `PUT /api/agent/tasks/{taskId}`.
pub fn task_settings(profile_id: &str, options: &RunOptions) -> Value {
  let mut body = json!({
    "profileId": profile_id,
    "effort": options.effort,
    "pace": options.pace,
  });
  if let Some(caps) = options.caps.filter(|caps| !caps.is_empty()) {
    body["caps"] = serde_json::to_value(caps).unwrap_or(Value::Null);
  }
  body
}

static SETTINGS: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Agent task settings");

/// Tell the cloud how task `task_id` runs, before the engine has it. When
/// this fails the gateway runs it at its defaults (standard effort, a
/// human's pace, no caps), so a task with caps does not start without them.
pub async fn send(task_id: &str, profile_id: &str, options: &RunOptions) -> Result<(), String> {
  let body = task_settings(profile_id, options);
  let id = super::cloud::segment(task_id, "AGENT_TASK_NOT_FOUND")?;
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    super::mock::task_settings(&id, body);
    return Ok(());
  }
  let url = format!("{}/tasks/{id}", super::cloud::base());
  let outcome =
    super::cloud::call::<Option<Value>>("task_settings", reqwest::Method::PUT, url, Some(body))
      .await;
  match outcome {
    Ok(_) => {
      SETTINGS.succeeded();
      Ok(())
    }
    Err(e) => {
      SETTINGS.failed(super::error_code(&e));
      if options.caps.is_some_and(|caps| !caps.is_empty()) {
        Err(crate::backend_error("AGENT_SETTINGS_NOT_SAVED"))
      } else {
        Ok(())
      }
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SiteActions {
  pub host: String,
  #[serde(default)]
  pub actions: u64,
}

/// A profile's actions today (UTC), in all and per site.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ActionUsage {
  #[serde(default)]
  pub day: String,
  #[serde(default)]
  pub actions: u64,
  #[serde(default)]
  pub sites: Vec<SiteActions>,
}

#[tauri::command]
pub async fn get_agent_action_usage(profile_id: String) -> Result<ActionUsage, String> {
  super::ensure_entitled().await?;
  let profile_id = profile_id.trim().to_string();
  if profile_id.is_empty() {
    return Err(crate::backend_error("PROFILE_NOT_FOUND"));
  }
  #[cfg(feature = "e2e")]
  if super::mock::active() {
    return Ok(super::mock::usage(&profile_id));
  }
  let url = format!(
    "{}/usage/actions?profileId={}",
    super::cloud::base(),
    urlencoding::encode(&profile_id)
  );
  super::cloud::call("usage", reqwest::Method::GET, url, None).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn defaults_are_standard_effort_at_a_human_pace_without_caps() {
    let options: RunOptions = serde_json::from_str("{}").unwrap();
    assert_eq!(options, RunOptions::default());
    assert_eq!(
      task_settings("p1", &options),
      json!({ "profileId": "p1", "effort": "standard", "pace": "human" })
    );
  }

  #[test]
  fn caps_reach_the_cloud_as_the_contract_names_them() {
    let options = RunOptions {
      effort: Effort::Thorough,
      pace: Pace::Fast,
      caps: Some(Caps {
        actions_per_day: Some(300),
        actions_per_site_per_day: Some(0),
      }),
    }
    .checked();
    assert_eq!(
      task_settings("p1", &options),
      json!({ "profileId": "p1", "effort": "thorough", "pace": "fast", "caps": { "actionsPerDay": 300 } })
    );
    let none = RunOptions {
      caps: Some(Caps::default()),
      ..RunOptions::default()
    }
    .checked();
    assert_eq!(none.caps, None, "zero caps are no caps");
    let huge = Caps {
      actions_per_day: Some(u32::MAX),
      actions_per_site_per_day: None,
    }
    .checked()
    .unwrap();
    assert_eq!(huge.actions_per_day, Some(MAX_CAP));
  }

  #[test]
  fn usage_reads_from_the_cloud_shape() {
    let usage: ActionUsage = serde_json::from_str(
      r#"{"day":"2026-11-18","actions":42,"sites":[{"host":"shop.example","actions":30}]}"#,
    )
    .unwrap();
    assert_eq!(usage.sites[0].actions, 30);
  }
}
