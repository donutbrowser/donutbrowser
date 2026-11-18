//! A run of one prompt on one or more profiles, at most `concurrency` at once.
//! Pure state: the driver in `mod.rs` asks it what to start next and tells it
//! what happened.

use super::model::{Task, TaskStatus};
use serde::{Deserialize, Serialize};

pub const MAX_CONCURRENCY: usize = 20;
pub const MAX_PROFILES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Autonomy {
  #[default]
  Ask,
  Auto,
}

impl Autonomy {
  pub fn wire(self) -> &'static str {
    match self {
      Self::Ask => "ask",
      Self::Auto => "auto",
    }
  }
}

/// What every task of a batch is asked to do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
  pub prompt: String,
  pub start_url: Option<String>,
  pub autonomy: Autonomy,
  pub max_credits: Option<u64>,
  pub headless: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
  pub id: String,
  pub routine_id: Option<String>,
  /// The cloud's batch, for a routine.
  pub cloud_batch_id: Option<String>,
  #[serde(flatten)]
  pub order: Order,
  pub concurrency: usize,
  pub tasks: Vec<Task>,
  pub created_at: u64,
  pub stopping: bool,
}

/// The totals the run view shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
  pub queued: usize,
  pub active: usize,
  pub done: usize,
  pub failed: usize,
  pub stopped: usize,
  pub credits_used: u64,
}

pub fn clamp_concurrency(requested: Option<usize>, fallback: usize) -> usize {
  requested.unwrap_or(fallback).clamp(1, MAX_CONCURRENCY)
}

impl Batch {
  pub fn new(
    id: String,
    order: Order,
    profile_ids: Vec<String>,
    concurrency: usize,
    created_at: u64,
  ) -> Self {
    let mut seen = std::collections::HashSet::new();
    let tasks = profile_ids
      .into_iter()
      .filter(|id| seen.insert(id.clone()))
      .map(Task::queued)
      .collect();
    Self {
      id,
      routine_id: None,
      cloud_batch_id: None,
      order,
      concurrency: concurrency.clamp(1, MAX_CONCURRENCY),
      tasks,
      created_at,
      stopping: false,
    }
  }

  pub fn active(&self) -> usize {
    self.tasks.iter().filter(|t| t.status.is_active()).count()
  }

  /// The next queued task to start, and marks it launching. `None` while the
  /// batch is full, stopping, or has nothing queued.
  pub fn take_next(&mut self) -> Option<usize> {
    if self.stopping || self.active() >= self.concurrency {
      return None;
    }
    let index = self
      .tasks
      .iter()
      .position(|t| t.status == TaskStatus::Queued)?;
    self.tasks[index].status = TaskStatus::Launching;
    Some(index)
  }

  pub fn is_finished(&self) -> bool {
    self.tasks.iter().all(|t| t.status.is_final())
  }

  /// Stop everything. Returns the engine tasks to tell to stop, which
  /// report their own end, and the queued tasks that ended here.
  pub fn stop_all(&mut self, now_ms: u64) -> (Vec<(String, String)>, Vec<usize>) {
    self.stopping = true;
    let mut running = Vec::new();
    let mut ended = Vec::new();
    for (index, task) in self.tasks.iter_mut().enumerate() {
      match task.status {
        TaskStatus::Queued => {
          task.status = TaskStatus::Stopped;
          task.finished_at = Some(now_ms);
          ended.push(index);
        }
        status if status.is_active() => {
          if let Some(task_id) = &task.task_id {
            running.push((task.profile_id.clone(), task_id.clone()));
          }
        }
        _ => {}
      }
    }
    (running, ended)
  }

  /// End every task that has not ended, without waiting for the engine.
  /// Returns them.
  pub fn end_all(&mut self, now_ms: u64) -> Vec<usize> {
    self.stopping = true;
    let mut ended = Vec::new();
    for (index, task) in self.tasks.iter_mut().enumerate() {
      if !task.status.is_final() {
        task.status = TaskStatus::Stopped;
        task.approval = None;
        task.finished_at = Some(now_ms);
        ended.push(index);
      }
    }
    ended
  }

  /// The tasks the engine has been silent about for `limit_ms`.
  pub fn silent(&self, now_ms: u64, limit_ms: u64) -> Vec<usize> {
    self
      .tasks
      .iter()
      .enumerate()
      .filter(|(_, task)| {
        task
          .silent_since()
          .is_some_and(|since| now_ms.saturating_sub(since) >= limit_ms)
      })
      .map(|(index, _)| index)
      .collect()
  }

  /// The profiles of the failed tasks.
  pub fn failed_profiles(&self) -> Vec<String> {
    self
      .tasks
      .iter()
      .filter(|task| task.status == TaskStatus::Failed)
      .map(|task| task.profile_id.clone())
      .collect()
  }

  /// Queue every failed task again. Returns them.
  pub fn retry_failed(&mut self) -> Vec<usize> {
    let mut requeued = Vec::new();
    for (index, task) in self.tasks.iter_mut().enumerate() {
      if task.status == TaskStatus::Failed {
        task.requeue();
        requeued.push(index);
      }
    }
    if !requeued.is_empty() {
      self.stopping = false;
    }
    requeued
  }

  pub fn tally(&self) -> Tally {
    let mut tally = Tally::default();
    for task in &self.tasks {
      tally.credits_used += task.total_credits();
      match task.status {
        TaskStatus::Queued => tally.queued += 1,
        TaskStatus::Done => tally.done += 1,
        TaskStatus::Failed | TaskStatus::NoCredits | TaskStatus::Budget => tally.failed += 1,
        TaskStatus::Stopped => tally.stopped += 1,
        _ => tally.active += 1,
      }
    }
    tally
  }

  pub fn task_index(&self, task_id: &str) -> Option<usize> {
    self
      .tasks
      .iter()
      .position(|t| t.task_id.as_deref() == Some(task_id))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn batch(profiles: usize, concurrency: usize) -> Batch {
    Batch::new(
      "b1".into(),
      Order {
        prompt: "Check the inbox".into(),
        start_url: None,
        autonomy: Autonomy::Ask,
        max_credits: None,
        headless: true,
      },
      (0..profiles).map(|i| format!("p{i}")).collect(),
      concurrency,
      0,
    )
  }

  #[test]
  fn never_more_than_the_concurrency_run_at_once() {
    let mut batch = batch(5, 2);
    assert_eq!(batch.take_next(), Some(0));
    assert_eq!(batch.take_next(), Some(1));
    assert_eq!(batch.take_next(), None, "two are running");
    batch.tasks[0].status = TaskStatus::Done;
    assert_eq!(batch.take_next(), Some(2));
    batch.tasks[1].status = TaskStatus::NeedsApproval;
    assert_eq!(
      batch.take_next(),
      None,
      "waiting for a person still holds a slot"
    );
    assert!(!batch.is_finished());
  }

  #[test]
  fn a_profile_is_taken_once_and_concurrency_is_bounded() {
    let order = batch(0, 1).order;
    let twice = Batch::new(
      "b".into(),
      order,
      vec!["a".into(), "a".into(), "b".into()],
      99,
      0,
    );
    assert_eq!(twice.tasks.len(), 2);
    assert_eq!(twice.concurrency, MAX_CONCURRENCY);
    assert_eq!(clamp_concurrency(Some(0), 3), 1);
    assert_eq!(clamp_concurrency(None, 3), 3);
    assert_eq!(clamp_concurrency(Some(50), 3), MAX_CONCURRENCY);
  }

  #[test]
  fn stop_all_ends_the_queue_and_names_the_running_tasks() {
    let mut batch = batch(4, 2);
    for index in [0, 1] {
      batch.take_next();
      batch.tasks[index].task_id = Some(format!("t{index}"));
      batch.tasks[index].status = TaskStatus::Running;
    }
    let (running, ended) = batch.stop_all(9);
    assert_eq!(
      running,
      vec![("p0".into(), "t0".into()), ("p1".into(), "t1".into())]
    );
    assert_eq!(ended, vec![2, 3], "each queued task ends and is reported");
    assert_eq!(batch.tasks[2].status, TaskStatus::Stopped);
    assert_eq!(batch.take_next(), None, "a stopping batch starts nothing");
    batch.tasks[0].status = TaskStatus::Stopped;
    batch.tasks[1].status = TaskStatus::Stopped;
    assert!(batch.is_finished());
  }

  #[test]
  fn retry_requeues_only_failures_and_the_tally_adds_up() {
    let mut batch = batch(4, 4);
    batch.tasks[0].status = TaskStatus::Done;
    batch.tasks[0].credits_used = 10;
    batch.tasks[1].fail("AGENT_BUSY".into(), 1);
    batch.tasks[1].credits_used = 5;
    batch.tasks[2].status = TaskStatus::NoCredits;
    batch.tasks[3].status = TaskStatus::Running;
    assert_eq!(
      batch.tally(),
      Tally {
        queued: 0,
        active: 1,
        done: 1,
        failed: 2,
        stopped: 0,
        credits_used: 15
      }
    );
    batch.stopping = true;
    assert_eq!(batch.failed_profiles(), vec!["p1".to_string()]);
    assert_eq!(
      batch.retry_failed(),
      vec![1],
      "no credits is not retried blindly"
    );
    assert!(!batch.stopping);
    assert_eq!(batch.tasks[1].status, TaskStatus::Queued);
    assert_eq!(batch.take_next(), Some(1));
  }

  #[test]
  fn a_retry_keeps_the_credits_of_every_attempt() {
    let mut batch = batch(2, 2);
    batch.tasks[0].status = TaskStatus::Done;
    batch.tasks[0].credits_used = 10;
    batch.tasks[1].fail("AGENT_BUSY".into(), 1);
    batch.tasks[1].credits_used = 7;
    assert_eq!(batch.retry_failed().len(), 1);
    assert_eq!(
      batch.tasks[1].credits_used, 0,
      "the new attempt starts at zero"
    );
    assert_eq!(batch.tasks[1].total_credits(), 7);
    assert_eq!(batch.tally().credits_used, 17);
    batch.tasks[1].credits_used = 4;
    batch.tasks[1].fail("AGENT_BUSY".into(), 2);
    batch.retry_failed();
    batch.tasks[1].credits_used = 3;
    assert_eq!(batch.tasks[1].total_credits(), 14);
    assert_eq!(batch.tally().credits_used, 24);
  }

  #[test]
  fn a_silent_task_is_named_once_the_limit_passes() {
    let mut batch = batch(3, 3);
    for index in 0..3 {
      batch.take_next();
      batch.tasks[index].task_id = Some(format!("t{index}"));
      batch.tasks[index].started_at = Some(0);
      batch.tasks[index].status = TaskStatus::Running;
    }
    batch.tasks[1].heard_at = Some(500);
    batch.tasks[2].status = TaskStatus::Paused;
    assert_eq!(batch.silent(999, 1_000), Vec::<usize>::new());
    assert_eq!(batch.silent(1_000, 1_000), vec![0]);
    assert_eq!(batch.silent(1_500, 1_000), vec![0, 1]);
  }

  #[test]
  fn ending_all_leaves_nothing_open() {
    let mut batch = batch(3, 1);
    batch.take_next();
    batch.tasks[1].status = TaskStatus::Done;
    assert_eq!(batch.end_all(5), vec![0, 2]);
    assert!(batch.is_finished() && batch.stopping);
    assert_eq!(batch.tasks[1].status, TaskStatus::Done);
    assert_eq!(batch.end_all(6), Vec::<usize>::new());
  }
}
