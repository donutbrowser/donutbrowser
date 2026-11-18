//! Everything that waits for the person, across profiles: a run's task or a
//! chat's turn with an open question (an approval, a captcha), and a change a
//! chat asked to make in the app. The window lists them in one place and
//! posts one notification per wait.

use super::host::{CallState, HostRequest};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitKind {
  /// The engine asks a question.
  Question,
  /// A chat asks to change something in the app.
  Change,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wait {
  /// The same for as long as this wait lasts, and new for the next.
  pub key: String,
  pub kind: WaitKind,
  pub profile_id: String,
  /// The run or chat it belongs to.
  pub batch_id: Option<String>,
  pub chat_id: Option<String>,
  pub routine_id: Option<String>,
  /// The chat's title, or the run's first words.
  pub title: String,
  /// The question, or for a change its method (`routines.save`, ...).
  pub text: String,
  /// For a change: the routine's name or the task's first words.
  pub subject: Option<String>,
  pub at: u64,
}

fn subject(request: &HostRequest) -> String {
  match request {
    HostRequest::SaveRoutine { routine, .. } => routine.name.clone(),
    HostRequest::RunRoutine { name, .. } | HostRequest::DeleteRoutine { name, .. } => name.clone(),
    HostRequest::RunTask { prompt, .. } => prompt.lines().next().unwrap_or_default().to_string(),
  }
}

/// Every wait now, oldest first.
pub fn list() -> Vec<Wait> {
  let mut waits = Vec::new();
  {
    let store = super::store();
    for batch in &store.batches {
      for task in &batch.tasks {
        let Some(approval) = &task.approval else {
          continue;
        };
        waits.push(Wait {
          key: format!("{}:{}", batch.id, approval.approval_id),
          kind: WaitKind::Question,
          profile_id: task.profile_id.clone(),
          batch_id: Some(batch.id.clone()),
          chat_id: None,
          routine_id: batch.routine_id.clone(),
          title: batch
            .order
            .prompt
            .lines()
            .next()
            .unwrap_or_default()
            .to_string(),
          text: approval.question.clone(),
          subject: None,
          at: task
            .heard_at
            .or(task.started_at)
            .unwrap_or(batch.created_at),
        });
      }
    }
  }
  for (chat_id, title, profile_id, turn) in super::chat::waiting() {
    let at = turn.task.heard_at.or(turn.task.started_at).unwrap_or(0);
    if let Some(approval) = &turn.task.approval {
      waits.push(Wait {
        key: format!("{chat_id}:{}", approval.approval_id),
        kind: WaitKind::Question,
        profile_id: profile_id.clone(),
        batch_id: None,
        chat_id: Some(chat_id.clone()),
        routine_id: None,
        title: title.clone(),
        text: approval.question.clone(),
        subject: None,
        at,
      });
    }
    for call in turn
      .host_calls
      .iter()
      .filter(|call| call.state == CallState::Pending)
    {
      waits.push(Wait {
        key: format!("{chat_id}:{}", call.call_id),
        kind: WaitKind::Change,
        profile_id: profile_id.clone(),
        batch_id: None,
        chat_id: Some(chat_id.clone()),
        routine_id: None,
        title: title.clone(),
        text: call.request.method().to_string(),
        subject: Some(subject(&call.request)),
        at: call.at,
      });
    }
  }
  waits.sort_by_key(|wait| wait.at);
  waits
}

#[tauri::command]
pub async fn list_agent_inbox() -> Result<Vec<Wait>, String> {
  super::ensure_entitled().await?;
  Ok(list())
}
