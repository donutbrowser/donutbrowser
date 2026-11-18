//! One agent task as Donut sees it: the status, the steps the engine reports,
//! an open approval, the result and the credits. The engine decides what
//! happens; this only records what it says.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

/// Steps kept per task. The oldest go first.
pub const MAX_STEPS: usize = 300;
/// The longest step, question or result text kept.
pub const MAX_TEXT_CHARS: usize = 4_000;
/// The longest answer read from the engine, before the blocks Donut takes
/// out of its end and the cut to `MAX_TEXT_CHARS`.
const MAX_ANSWER_CHARS: usize = 64_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
  Queued,
  Launching,
  Running,
  Paused,
  NeedsApproval,
  Done,
  Failed,
  Stopped,
  NoCredits,
  Budget,
}

impl TaskStatus {
  pub fn is_final(self) -> bool {
    matches!(
      self,
      Self::Done | Self::Failed | Self::Stopped | Self::NoCredits | Self::Budget
    )
  }

  /// Holds a browser and a concurrency slot.
  pub fn is_active(self) -> bool {
    matches!(
      self,
      Self::Launching | Self::Running | Self::Paused | Self::NeedsApproval
    )
  }

  fn from_finished(status: &str) -> Self {
    match status {
      "done" => Self::Done,
      "stopped" => Self::Stopped,
      "no_credits" => Self::NoCredits,
      "budget" => Self::Budget,
      _ => Self::Failed,
    }
  }

  /// The status the cloud's run record takes.
  pub fn run_status(self) -> &'static str {
    match self {
      Self::Queued => "queued",
      Self::Launching | Self::Running | Self::Paused | Self::NeedsApproval => "running",
      Self::Done => "done",
      Self::Failed => "failed",
      Self::Stopped => "stopped",
      Self::NoCredits => "no_credits",
      Self::Budget => "budget",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
  /// The engine's number for the step; one it sent without a number gets
  /// the next when the task takes it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub index: Option<u64>,
  pub kind: String,
  pub text: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tool: Option<String>,
  pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
  pub approval_id: String,
  pub question: String,
}

/// What the engine reported, decoded from a `Wayfern.agent*` event.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
  Step(Step),
  Approval(Approval),
  Finished {
    status: TaskStatus,
    /// The whole answer, until the task takes it.
    result: Option<String>,
    error: Option<String>,
    credits_used: u64,
    /// What the answer found, by the columns the task asked for.
    data: Option<Value>,
  },
  Credits(u64),
}

fn text_up_to(params: &Value, key: &str, max: usize) -> Option<String> {
  params
    .get(key)
    .and_then(Value::as_str)
    .map(|value| value.chars().take(max).collect())
}

fn text(params: &Value, key: &str) -> Option<String> {
  text_up_to(params, key, MAX_TEXT_CHARS)
}

/// An engine error that is a bare code (`AGENT_ENGINE_RESTARTED`) becomes the
/// app's JSON error, so the interface translates it; prose stays as it is.
fn coded_error(error: String) -> String {
  // The gateway's daily cap, as the app names it.
  if error == "ACTION_CAP" {
    return crate::backend_error("AGENT_ACTION_CAP");
  }
  let is_code = !error.is_empty()
    && error
      .chars()
      .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
  if is_code {
    crate::backend_error(&error)
  } else {
    error
  }
}

fn credits(params: &Value) -> u64 {
  params
    .get("creditsUsed")
    .and_then(|value| {
      value
        .as_u64()
        .or_else(|| value.as_f64().map(|f| f.max(0.0).round() as u64))
    })
    .unwrap_or(0)
}

impl EngineEvent {
  /// Decode one CDP event. Returns the task it belongs to with the event, or
  /// `None` for anything that is not an agent event.
  pub fn parse(method: &str, params: &Value, now_ms: u64) -> Option<(String, Self)> {
    let task_id = params.get("taskId")?.as_str()?.to_string();
    let event = match method {
      "Wayfern.agentStep" => Self::Step(Step {
        index: params.get("index").and_then(Value::as_u64),
        kind: match params.get("kind").and_then(Value::as_str) {
          Some(kind @ ("think" | "act" | "observe")) => kind.to_string(),
          _ => "observe".to_string(),
        },
        text: text(params, "text").unwrap_or_default(),
        url: text(params, "url"),
        tool: text(params, "tool"),
        at: now_ms,
      }),
      "Wayfern.agentApproval" => Self::Approval(Approval {
        approval_id: params.get("approvalId")?.as_str()?.to_string(),
        question: text(params, "question").unwrap_or_default(),
      }),
      "Wayfern.agentFinished" => Self::Finished {
        status: TaskStatus::from_finished(params.get("status").and_then(Value::as_str)?),
        result: text_up_to(params, "result", MAX_ANSWER_CHARS),
        error: text(params, "error").map(coded_error),
        credits_used: credits(params),
        data: None,
      },
      "Wayfern.agentCredits" => Self::Credits(credits(params)),
      _ => return None,
    };
    Some((task_id, event))
  }
}

/// One profile's part of a run, or one turn of a chat.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
  pub profile_id: String,
  /// Set when the engine is asked to start; a new one on every retry.
  pub task_id: Option<String>,
  /// The cloud's record of this run, for a routine.
  pub run_id: Option<String>,
  pub status: TaskStatus,
  pub steps: VecDeque<Step>,
  pub approval: Option<Approval>,
  pub result: Option<String>,
  /// A backend error code, or the engine's own words when it failed.
  pub error: Option<String>,
  /// What the answer found, by the routine's columns.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub data: Option<Value>,
  /// Credits of this attempt, as the engine reports them.
  pub credits_used: u64,
  /// Credits of the earlier attempts: a retry spends them again, never back.
  #[serde(default)]
  pub credits_before: u64,
  pub started_at: Option<u64>,
  pub finished_at: Option<u64>,
  /// Donut started this browser for the task, so it stops it after.
  #[serde(skip)]
  pub launched_here: bool,
  /// When the engine or a person last moved the task on.
  #[serde(skip)]
  pub heard_at: Option<u64>,
}

impl Task {
  pub fn queued(profile_id: String) -> Self {
    Self {
      profile_id,
      task_id: None,
      run_id: None,
      status: TaskStatus::Queued,
      steps: VecDeque::new(),
      approval: None,
      result: None,
      error: None,
      data: None,
      credits_used: 0,
      credits_before: 0,
      started_at: None,
      finished_at: None,
      launched_here: false,
      heard_at: None,
    }
  }

  /// Back to the queue for another attempt. The credits spent so far stay;
  /// the run record does not, because the cloud has it as ended.
  pub fn requeue(&mut self) {
    let spent = self.total_credits();
    *self = Self::queued(std::mem::take(&mut self.profile_id));
    self.credits_before = spent;
  }

  /// Since when a task the engine works on has been silent. `None` while it
  /// has not started, or waits for a person (paused, a question).
  pub fn silent_since(&self) -> Option<u64> {
    if !matches!(self.status, TaskStatus::Launching | TaskStatus::Running) {
      return None;
    }
    self.task_id.as_ref()?;
    self.heard_at.or(self.started_at)
  }

  /// Credits of every attempt.
  pub fn total_credits(&self) -> u64 {
    self.credits_before + self.credits_used
  }

  pub fn fail(&mut self, code: String, now_ms: u64) {
    self.status = TaskStatus::Failed;
    self.error = Some(code);
    self.approval = None;
    self.finished_at = Some(now_ms);
  }

  /// Apply an engine event. Returns whether anything changed. A finished task
  /// takes nothing more, so a late step cannot reopen it.
  pub fn apply(&mut self, event: EngineEvent, now_ms: u64) -> bool {
    if self.status.is_final() {
      return false;
    }
    self.heard_at = Some(now_ms);
    match event {
      EngineEvent::Step(mut step) => {
        match step.index {
          Some(index) if self.steps.iter().any(|known| known.index == Some(index)) => {
            return false;
          }
          Some(_) => {}
          None => {
            step.index = Some(
              self
                .steps
                .iter()
                .filter_map(|known| known.index)
                .max()
                .map_or(0, |last| last + 1),
            )
          }
        }
        if self.steps.len() >= MAX_STEPS {
          self.steps.pop_front();
        }
        self.steps.push_back(step);
        if self.status == TaskStatus::Launching {
          self.status = TaskStatus::Running;
        }
      }
      EngineEvent::Approval(approval) => {
        self.approval = Some(approval);
        self.status = TaskStatus::NeedsApproval;
      }
      EngineEvent::Finished {
        status,
        result,
        error,
        credits_used,
        data,
      } => {
        self.status = status;
        self.result = result.map(|text| text.chars().take(MAX_TEXT_CHARS).collect());
        self.error = error;
        self.data = data;
        self.credits_used = self.credits_used.max(credits_used);
        self.approval = None;
        self.finished_at = Some(now_ms);
      }
      EngineEvent::Credits(used) => {
        if used <= self.credits_used {
          return false;
        }
        self.credits_used = used;
      }
    }
    true
  }

  /// The person answered the open approval.
  pub fn answered(&mut self, approval_id: &str, now_ms: u64) -> bool {
    if self
      .approval
      .as_ref()
      .is_some_and(|open| open.approval_id == approval_id)
    {
      self.approval = None;
      self.status = TaskStatus::Running;
      self.heard_at = Some(now_ms);
      return true;
    }
    false
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn running() -> Task {
    let mut task = Task::queued("p1".into());
    task.task_id = Some("t1".into());
    task.status = TaskStatus::Running;
    task
  }

  #[test]
  fn a_bare_engine_code_becomes_a_translatable_error() {
    let EngineEvent::Finished { error, .. } = event(
      "Wayfern.agentFinished",
      json!({"taskId": "t1", "status": "failed", "error": "AGENT_ENGINE_RESTARTED", "creditsUsed": 3}),
    ) else {
      panic!("a finished event");
    };
    assert_eq!(
      error.as_deref(),
      Some(crate::backend_error("AGENT_ENGINE_RESTARTED").as_str())
    );
    let EngineEvent::Finished { error, .. } = event(
      "Wayfern.agentFinished",
      json!({"taskId": "t1", "status": "failed", "error": "The page did not load.", "creditsUsed": 3}),
    ) else {
      panic!("a finished event");
    };
    assert_eq!(error.as_deref(), Some("The page did not load."));
  }

  fn event(method: &str, params: Value) -> EngineEvent {
    EngineEvent::parse(method, &params, 1)
      .expect("an agent event")
      .1
  }

  #[test]
  fn events_decode_to_the_task_they_name() {
    let (task, step) = EngineEvent::parse(
      "Wayfern.agentStep",
      &json!({"taskId": "t1", "index": 2, "kind": "act", "text": "Click Buy", "tool": "click"}),
      5,
    )
    .unwrap();
    assert_eq!(task, "t1");
    assert!(
      matches!(step, EngineEvent::Step(Step { index: Some(2), ref kind, .. }) if kind == "act")
    );
    assert!(EngineEvent::parse("Wayfern.agentStep", &json!({"index": 1}), 0).is_none());
    assert!(EngineEvent::parse("Page.loadEventFired", &json!({"taskId": "t1"}), 0).is_none());
    let unknown = event(
      "Wayfern.agentStep",
      json!({"taskId": "t1", "kind": "dance"}),
    );
    assert!(matches!(unknown, EngineEvent::Step(Step { ref kind, .. }) if kind == "observe"));
  }

  #[test]
  fn a_task_moves_through_approval_to_its_end() {
    let mut task = running();
    assert!(task.apply(
      event(
        "Wayfern.agentStep",
        json!({"taskId": "t1", "index": 0, "kind": "think", "text": "Plan"})
      ),
      1
    ));
    assert!(
      !task.apply(
        event(
          "Wayfern.agentStep",
          json!({"taskId": "t1", "index": 0, "kind": "think", "text": "Plan"})
        ),
        1
      ),
      "a repeated step is ignored"
    );
    task.apply(
      event(
        "Wayfern.agentApproval",
        json!({"taskId": "t1", "approvalId": "a1", "question": "Pay?"}),
      ),
      2,
    );
    assert_eq!(task.status, TaskStatus::NeedsApproval);
    assert!(!task.answered("other", 2));
    assert!(task.answered("a1", 2));
    assert_eq!(task.status, TaskStatus::Running);
    task.apply(
      event(
        "Wayfern.agentCredits",
        json!({"taskId": "t1", "creditsUsed": 40}),
      ),
      3,
    );
    assert!(!task.apply(
      event(
        "Wayfern.agentCredits",
        json!({"taskId": "t1", "creditsUsed": 10})
      ),
      3
    ));
    assert_eq!(task.credits_used, 40);
    task.apply(
      event(
        "Wayfern.agentFinished",
        json!({"taskId": "t1", "status": "done", "result": "Ordered", "creditsUsed": 55}),
      ),
      4,
    );
    assert_eq!(task.status, TaskStatus::Done);
    assert_eq!(task.credits_used, 55);
    assert_eq!(task.finished_at, Some(4));
    assert!(
      !task.apply(
        event(
          "Wayfern.agentStep",
          json!({"taskId": "t1", "index": 9, "text": "late"})
        ),
        5
      ),
      "a finished task takes no more steps"
    );
  }

  #[test]
  fn every_engine_end_maps_to_a_status() {
    for (wire, status) in [
      ("done", TaskStatus::Done),
      ("failed", TaskStatus::Failed),
      ("stopped", TaskStatus::Stopped),
      ("no_credits", TaskStatus::NoCredits),
      ("budget", TaskStatus::Budget),
      ("mystery", TaskStatus::Failed),
    ] {
      let mut task = running();
      task.apply(
        event(
          "Wayfern.agentFinished",
          json!({"taskId": "t1", "status": wire}),
        ),
        1,
      );
      assert_eq!(task.status, status, "{wire}");
      assert!(task.status.is_final());
    }
  }

  #[test]
  fn steps_are_capped_and_text_is_cut() {
    let mut task = running();
    for index in 0..(MAX_STEPS as u64 + 5) {
      task.apply(
        event(
          "Wayfern.agentStep",
          json!({"taskId": "t1", "index": index, "text": "x".repeat(MAX_TEXT_CHARS + 10)}),
        ),
        1,
      );
    }
    assert_eq!(task.steps.len(), MAX_STEPS);
    assert_eq!(task.steps.front().unwrap().index, Some(5));
    assert_eq!(
      task.steps.back().unwrap().text.chars().count(),
      MAX_TEXT_CHARS
    );
  }

  #[test]
  fn a_long_answer_reaches_its_owner_whole_and_is_cut_when_kept() {
    let long = format!("{}```memory\nfact\n```", "x".repeat(MAX_TEXT_CHARS * 2));
    let finished = event(
      "Wayfern.agentFinished",
      json!({"taskId": "t1", "status": "done", "result": long}),
    );
    let EngineEvent::Finished { result, .. } = &finished else {
      panic!("finished");
    };
    assert!(
      result.as_deref().unwrap().ends_with("```"),
      "the end is read"
    );
    let mut task = running();
    task.apply(finished, 2);
    assert_eq!(
      task.result.as_deref().unwrap().chars().count(),
      MAX_TEXT_CHARS
    );
  }

  #[test]
  fn a_retry_keeps_only_the_profile_and_the_credits() {
    let mut task = running();
    task.run_id = Some("r1".into());
    task.credits_used = 7;
    task.fail("AGENT_BUSY".into(), 3);
    task.requeue();
    assert_eq!(task.status, TaskStatus::Queued);
    assert!(task.run_id.is_none(), "the cloud has that run as ended");
    assert!(task.task_id.is_none() && task.error.is_none());
    assert_eq!(task.profile_id, "p1");
    assert_eq!(task.total_credits(), 7);
  }

  #[test]
  fn a_step_without_a_number_takes_the_next() {
    let mut task = running();
    for params in [
      json!({"taskId": "t1", "index": 4, "text": "a"}),
      json!({"taskId": "t1", "text": "b"}),
      json!({"taskId": "t1", "text": "c"}),
    ] {
      assert!(task.apply(event("Wayfern.agentStep", params), 1));
    }
    let numbers: Vec<_> = task.steps.iter().map(|step| step.index).collect();
    assert_eq!(numbers, vec![Some(4), Some(5), Some(6)]);
    let mut fresh = running();
    assert!(fresh.apply(
      event("Wayfern.agentStep", json!({"taskId": "t1", "text": "x"})),
      1
    ));
    assert_eq!(fresh.steps[0].index, Some(0));
  }

  #[test]
  fn only_a_task_the_engine_works_on_can_fall_silent() {
    let mut task = Task::queued("p1".into());
    assert_eq!(task.silent_since(), None);
    task.status = TaskStatus::Launching;
    task.started_at = Some(10);
    assert_eq!(task.silent_since(), None, "the engine has no task yet");
    task.task_id = Some("t1".into());
    assert_eq!(task.silent_since(), Some(10));
    task.apply(EngineEvent::Credits(1), 20);
    assert_eq!(task.silent_since(), Some(20));
    task.status = TaskStatus::NeedsApproval;
    assert_eq!(task.silent_since(), None, "a person holds it");
    task.status = TaskStatus::Done;
    assert_eq!(task.silent_since(), None);
  }
}
