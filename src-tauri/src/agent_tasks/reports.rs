//! What the cloud hears about routine runs. The cloud changes a run only from
//! the status it read, so the reports of one run go one at a time, in the
//! order they were made, and nothing goes after the final one. A final
//! report is sent again after a network error or a 5xx.

use super::cloud;
use crate::cloud_errors::BackendFailure;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

const FINAL_ATTEMPTS: u32 = 4;
const FIRST_RETRY_AFTER: Duration = Duration::from_secs(2);
/// Runs remembered as ended, so a late report of one is dropped.
const KEPT_ENDED: usize = 2_000;

#[derive(Default)]
struct Lanes {
  open: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
  ended: HashSet<String>,
  ended_order: VecDeque<String>,
}

impl Lanes {
  /// The lane of a run, or `None` once its final report is on its way. A
  /// final report closes the lane for every report after it.
  fn take_turn(&mut self, run_id: &str, last: bool) -> Option<Arc<tokio::sync::Mutex<()>>> {
    if self.ended.contains(run_id) {
      return None;
    }
    if last {
      self.ended.insert(run_id.to_string());
      self.ended_order.push_back(run_id.to_string());
      while self.ended_order.len() > KEPT_ENDED {
        if let Some(old) = self.ended_order.pop_front() {
          self.ended.remove(&old);
        }
      }
    }
    Some(self.open.entry(run_id.to_string()).or_default().clone())
  }
}

static LANES: LazyLock<Mutex<Lanes>> = LazyLock::new(Default::default);

fn lanes() -> MutexGuard<'static, Lanes> {
  LANES.lock().unwrap_or_else(|p| p.into_inner())
}

/// The run started.
pub async fn running(run_id: &str, credits_used: u64) {
  send(
    run_id,
    cloud::run_patch("running", None, credits_used, None),
    false,
  )
  .await;
}

/// How the run ended: `patch` from `cloud::run_patch` with a final status.
pub async fn finished(run_id: &str, patch: Value) {
  send(run_id, patch, true).await;
}

/// Runs the cloud holds for a batch that did not start end as failed, with
/// the reason.
pub async fn fail_runs(run_ids: impl IntoIterator<Item = String>, error: &str) {
  let patch = cloud::run_patch("failed", None, 0, Some(error));
  let reports: Vec<_> = run_ids
    .into_iter()
    .map(|run_id| {
      let patch = patch.clone();
      async move { finished(&run_id, patch).await }
    })
    .collect();
  futures_util::future::join_all(reports).await;
}

async fn send(run_id: &str, patch: Value, last: bool) {
  let Some(lane) = lanes().take_turn(run_id, last) else {
    return;
  };
  let turn = lane.lock().await;
  let attempts = if last { FINAL_ATTEMPTS } else { 1 };
  if let Err(failure) = with_retries(attempts, FIRST_RETRY_AFTER, || {
    cloud::report_run(run_id, patch.clone())
  })
  .await
  {
    log::warn!(
      "Agent run report failed run={run_id} code={} status={} final={last}",
      failure.code,
      failure.status
    );
  }
  drop(turn);
  if last {
    lanes().open.remove(run_id);
  }
}

/// A failure that another try can get past: no answer, or the cloud's own.
fn worth_retrying(failure: &BackendFailure) -> bool {
  (failure.status == 0 && failure.code == crate::cloud_errors::UNREACHABLE) || failure.status >= 500
}

/// Sends until it goes through, a failure is not worth another try, or the
/// attempts run out. Gives the last failure.
async fn with_retries<F, Fut>(
  attempts: u32,
  first_wait: Duration,
  mut send: F,
) -> Result<(), BackendFailure>
where
  F: FnMut() -> Fut,
  Fut: Future<Output = Result<(), BackendFailure>>,
{
  let mut wait = first_wait;
  let mut attempt = 1;
  loop {
    match send().await {
      Err(failure) if attempt < attempts && worth_retrying(&failure) => {
        tokio::time::sleep(wait).await;
        wait *= 2;
        attempt += 1;
      }
      outcome => return outcome,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::BTreeMap;
  use std::sync::atomic::{AtomicU32, Ordering};

  fn failure(status: u16, code: &str) -> BackendFailure {
    BackendFailure {
      status,
      code: code.to_string(),
      params: BTreeMap::new(),
    }
  }

  #[test]
  fn nothing_goes_after_the_final_report() {
    let mut lanes = Lanes::default();
    assert!(lanes.take_turn("r1", false).is_some());
    assert!(lanes.take_turn("r1", true).is_some());
    assert!(lanes.take_turn("r1", false).is_none(), "no running after");
    assert!(lanes.take_turn("r1", true).is_none(), "no second end");
    assert!(lanes.take_turn("r2", false).is_some());
  }

  #[tokio::test]
  async fn the_reports_of_one_run_go_in_order() {
    let lane = lanes().take_turn("order-run", false).unwrap();
    let held = lane.lock().await;
    let log = Arc::new(Mutex::new(Vec::new()));
    let first = {
      let log = log.clone();
      let lane = lane.clone();
      tokio::spawn(async move {
        let _turn = lane.lock().await;
        log.lock().unwrap().push("running");
      })
    };
    tokio::task::yield_now().await;
    let second = {
      let log = log.clone();
      let lane = lane.clone();
      tokio::spawn(async move {
        let _turn = lane.lock().await;
        log.lock().unwrap().push("done");
      })
    };
    tokio::task::yield_now().await;
    drop(held);
    first.await.unwrap();
    second.await.unwrap();
    assert_eq!(*log.lock().unwrap(), vec!["running", "done"]);
  }

  #[tokio::test]
  async fn a_final_report_is_retried_only_when_another_try_can_help() {
    for (first, tries) in [
      (failure(0, crate::cloud_errors::UNREACHABLE), 3),
      (failure(502, "CLOUD_REQUEST_FAILED"), 3),
      (failure(409, "AGENT_TASK_NOT_FOUND"), 1),
      (failure(0, crate::cloud_errors::NOT_SIGNED_IN), 1),
    ] {
      let calls = AtomicU32::new(0);
      let outcome = with_retries(3, Duration::ZERO, || {
        calls.fetch_add(1, Ordering::SeqCst);
        let failure = first.clone();
        async move { Err(failure) }
      })
      .await;
      assert_eq!(outcome.unwrap_err().code, first.code);
      assert_eq!(calls.load(Ordering::SeqCst), tries, "{}", first.code);
    }
    let calls = AtomicU32::new(0);
    assert!(with_retries(3, Duration::ZERO, || {
      calls.fetch_add(1, Ordering::SeqCst);
      async { Ok(()) }
    })
    .await
    .is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
  }
}
