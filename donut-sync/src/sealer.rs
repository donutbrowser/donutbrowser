//! Seals what older apps upload in plaintext. Older apps PUT to the direct
//! storage URL that presign-upload has always returned, because one request
//! through a proxy such as Cloudflare cannot carry a large file. The server
//! notes each key it hands such a URL for (`note_direct_uploads`), in the
//! bucket so a restart keeps the list, and seals those objects in place with
//! the migration's rewrite once the URL is dead, so no upload through it can
//! land on top of the rewrite. An hourly pass over everything written since
//! the last one catches what a lost record missed, retries what failed, and
//! cleans up: temporary objects of an interrupted rewrite, and storage
//! uploads in parts that were never finished.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::at_rest::Keyring;
use crate::log;
use crate::migrate::{Migration, Outcome, Settle, TMP_PREFIX, honors_if_match, purge};
use crate::sealed_store::SealedStore;
use crate::store::{ListInput, Store, StoreError};
use crate::time;

/// This server's own objects. No client prefix matches it.
pub const INTERNAL_ROOT: &str = ".donut-sync-at-rest/";
const PENDING: &str = ".donut-sync-at-rest/pending/";
pub const STATE: &str = ".donut-sync-at-rest/state.json";
const CONTEXT: &str = "Sealer";
const PASS_EVERY: Duration = Duration::from_secs(120);
const BACKSTOP_EVERY: Duration = Duration::from_secs(3600);
/// Overlap between backstop passes, for clock skew between server and storage.
const BACKSTOP_OVERLAP_MS: i64 = 10 * 60 * 1000;
/// A first backstop pass looks back this far; the migration covers the rest.
const FIRST_BACKSTOP_MS: i64 = 2 * 3600 * 1000;
/// A record waits this long after its URLs expire, for uploads in flight.
const RECORD_GRACE_MS: i64 = 5 * 60 * 1000;
/// Temporary objects older than this belong to a rewrite that stopped.
const TMP_STALE_MS: i64 = 3600 * 1000;
/// Unfinished part uploads older than this are aborted: past any upload
/// token (`transfer_parts`).
const ABANDONED_MS: i64 = 4 * 3600 * 1000;
/// Failed keys kept in the state, newest first.
const MAX_FAILED: usize = 1000;
/// Objects checked at a time. Most are HEADs, which B2 does not charge.
const CONCURRENCY: usize = 16;

/// How often the keys handed direct URLs are written as one record. A crash
/// loses at most this window; the hourly backstop pass covers it.
const FLUSH_EVERY: Duration = Duration::from_secs(10);

/// Keys handed direct storage URLs, gathered in memory until the next flush,
/// so a presign costs no storage write.
#[derive(Default)]
pub struct DirectUploads {
  pending: std::sync::Mutex<(Vec<String>, i64)>,
}

impl DirectUploads {
  pub fn note(&self, keys: &[String], expires_ms: i64) {
    let mut pending = self.pending.lock().unwrap();
    pending.0.extend_from_slice(keys);
    pending.1 = pending.1.max(expires_ms);
  }

  /// Writes what was noted as one record; `store` is the sealed store.
  pub async fn flush(&self, store: &dyn Store) -> Result<(), StoreError> {
    let (keys, expires_ms) = std::mem::take(&mut *self.pending.lock().unwrap());
    if keys.is_empty() {
      return Ok(());
    }
    let outcome = note_direct_uploads(store, &keys, expires_ms).await;
    if outcome.is_err() {
      self.note(&keys, expires_ms);
    }
    outcome
  }
}

/// Flushes `uploads` every `FLUSH_EVERY` for as long as the server runs.
pub fn spawn_flusher(store: Arc<dyn Store>, uploads: Arc<DirectUploads>) {
  tokio::spawn(async move {
    let mut failing = false;
    loop {
      tokio::time::sleep(FLUSH_EVERY).await;
      match uploads.flush(store.as_ref()).await {
        Ok(()) if failing => {
          failing = false;
          log::log(CONTEXT, "Direct uploads noted again");
        }
        Ok(()) => {}
        Err(e) if !failing => {
          failing = true;
          // The keys stay in memory for the next flush.
          log::warn(CONTEXT, &format!("Direct uploads not noted err=\"{e}\""));
        }
        Err(_) => {}
      }
    }
  });
}

/// Notes `keys`, which devices may write in plaintext through direct storage
/// URLs until `expires_ms`. `store` is the sealed store: the record is sealed.
pub async fn note_direct_uploads(
  store: &dyn Store,
  keys: &[String],
  expires_ms: i64,
) -> Result<(), StoreError> {
  let record = format!(
    "{PENDING}{expires_ms:013}-{}",
    uuid::Uuid::new_v4().simple()
  );
  store
    .put_object(
      &record,
      json!({ "keys": keys }).to_string().into_bytes(),
      "application/json",
      &[],
    )
    .await
}

fn record_expiry(record: &str) -> Option<i64> {
  record
    .strip_prefix(PENDING)?
    .split('-')
    .next()?
    .parse()
    .ok()
}

/// A key the sealer could not seal, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failed {
  pub key: String,
  pub reason: String,
  /// When it first failed.
  pub at: i64,
  /// Set when the rewrite is in place but a device's version may lie under
  /// it: a later pass settles it with these ids, and does not rewrite again.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub settle: Option<Settle>,
}

/// A key that failed in a pass.
pub struct Failure {
  pub key: String,
  pub reason: String,
  pub settle: Option<Settle>,
}

/// What the sealer keeps between passes, sealed in `STATE`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
  pub backstop_since: Option<i64>,
  #[serde(default)]
  pub failed: Vec<Failed>,
  /// The backstop pass under way, saved after each page, so a restart
  /// resumes it instead of walking the bucket again.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub backstop_pass: Option<BackstopPass>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackstopPass {
  /// When the pass began: the next pass looks at what was written since.
  pub started_ms: i64,
  /// The last key the pass finished.
  pub after: Option<String>,
}

impl State {
  /// `failures` from a pass that retried `retried`: retried keys that
  /// worked leave the list, keys that failed join it (keeping when they
  /// first failed).
  pub fn note(&mut self, retried: &[String], failures: Vec<Failure>, now_ms: i64) {
    let first: Vec<(String, i64)> = self.failed.iter().map(|f| (f.key.clone(), f.at)).collect();
    self.failed.retain(|f| !retried.contains(&f.key));
    for failure in failures {
      let at = first
        .iter()
        .find(|(k, _)| *k == failure.key)
        .map_or(now_ms, |(_, at)| *at);
      self.failed.retain(|f| f.key != failure.key);
      self.failed.insert(
        0,
        Failed {
          key: failure.key,
          reason: failure.reason,
          at,
          settle: failure.settle,
        },
      );
    }
    self.failed.truncate(MAX_FAILED);
  }
}

/// The sealer's state; `store` is the sealed store.
pub async fn read_state(store: &dyn Store) -> Result<State, StoreError> {
  match store.get_object_text(STATE).await {
    Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
    Err(StoreError::NotFound) => Ok(State::default()),
    Err(e) => Err(e),
  }
}

pub async fn save_state(store: &dyn Store, state: &State) -> Result<(), StoreError> {
  store
    .put_object(
      STATE,
      serde_json::to_vec(state).expect("the state serializes"),
      "application/json",
      &[],
    )
    .await
}

/// Tries the failed keys again: a settle where the rewrite is in place, a
/// whole rewrite otherwise. Returns the ones that still fail.
pub(crate) async fn retry_failed(migration: &Migration, failed: &[Failed]) -> Vec<Failure> {
  let mut still = Vec::new();
  for failed in failed {
    match &failed.settle {
      Some(settle) => {
        if let Err(reason) = migration.settle(&failed.key, settle).await {
          still.push(Failure {
            key: failed.key.clone(),
            reason,
            settle: Some(settle.clone()),
          });
        }
      }
      None => {
        if let Some(failure) = failure_of(
          failed.key.clone(),
          migration.object(&failed.key, None).await,
        ) {
          still.push(failure);
        }
      }
    }
  }
  still
}

fn failure_of(key: String, outcome: Outcome) -> Option<Failure> {
  match outcome {
    Outcome::Failed(reason) => Some(Failure {
      key,
      reason,
      settle: None,
    }),
    Outcome::Unsettled { settle, reason } => Some(Failure {
      key,
      reason,
      settle: Some(settle),
    }),
    _ => None,
  }
}

#[derive(Default, Debug, PartialEq)]
pub struct PassReport {
  pub records: u64,
  pub records_done: u64,
  pub checked: u64,
  pub sealed: u64,
  pub failed: u64,
}

pub struct Sealer {
  raw: Arc<dyn Store>,
  sealed: SealedStore,
  migration: Migration,
}

impl Sealer {
  pub async fn new(raw: Arc<dyn Store>, keyring: Arc<Keyring>) -> Result<Self, StoreError> {
    let conditional = honors_if_match(raw.as_ref()).await?;
    Ok(Self {
      sealed: SealedStore::new(raw.clone(), keyring.clone()),
      migration: Migration::sealing(raw.clone(), keyring, conditional),
      raw,
    })
  }

  /// Seals `keys`; returns the ones that failed.
  async fn seal_all(
    &self,
    keys: Vec<(String, Option<i64>)>,
    report: &mut PassReport,
  ) -> Vec<Failure> {
    let outcomes: Vec<(String, Outcome)> = futures_util::stream::iter(keys)
      .map(|(key, listed)| async move {
        let outcome = self.migration.object(&key, listed).await;
        (key, outcome)
      })
      .buffer_unordered(CONCURRENCY)
      .collect()
      .await;
    let mut failures = Vec::new();
    for (key, outcome) in outcomes {
      report.checked += 1;
      if matches!(outcome, Outcome::Sealed(_) | Outcome::Rotated(_)) {
        report.sealed += 1;
      }
      if let Some(failure) = failure_of(key, outcome) {
        log::warn(
          CONTEXT,
          &format!(
            "Object not sealed key={} err=\"{}\"",
            failure.key, failure.reason
          ),
        );
        report.failed += 1;
        failures.push(failure);
      }
    }
    failures
  }

  /// One page of the whole bucket after `after`, and whether more follow.
  async fn page_after(
    &self,
    after: Option<String>,
  ) -> Result<(Vec<(String, Option<i64>)>, bool), StoreError> {
    let page = self
      .raw
      .list_objects_v2(&ListInput {
        max_keys: Some("1000".to_string()),
        start_after: after,
        ..ListInput::default()
      })
      .await?;
    Ok((
      page
        .contents
        .into_iter()
        .map(|object| (object.key, object.last_modified_ms))
        .collect(),
      page.is_truncated,
    ))
  }

  /// One page of the listing under `prefix`.
  async fn page(
    &self,
    prefix: Option<&str>,
    token: Option<String>,
  ) -> Result<(Vec<(String, Option<i64>)>, Option<String>), StoreError> {
    let page = self
      .raw
      .list_objects_v2(&ListInput {
        prefix: prefix.map(str::to_string),
        max_keys: Some("1000".to_string()),
        continuation_token: token,
        ..ListInput::default()
      })
      .await?;
    let next = page.next_continuation_token.filter(|_| page.is_truncated);
    Ok((
      page
        .contents
        .into_iter()
        .map(|object| (object.key, object.last_modified_ms))
        .collect(),
      next,
    ))
  }

  /// Seals the keys of each record whose URLs are dead, then drops the
  /// record. Keys that fail are kept in the state for the backstop.
  pub async fn pending_pass(&self, now_ms: i64) -> Result<PassReport, StoreError> {
    let mut report = PassReport::default();
    let mut failures = Vec::new();
    let mut token = None;
    loop {
      let (records, next) = self.page(Some(PENDING), token).await?;
      for (record, _) in records {
        report.records += 1;
        if !record_expiry(&record).is_some_and(|expiry| now_ms > expiry + RECORD_GRACE_MS) {
          continue;
        }
        let keys: Vec<String> = match self.sealed.get_object_text(&record).await {
          Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["keys"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|k| k.as_str().map(str::to_string))
            .collect(),
          Err(StoreError::NotFound) => continue,
          Err(e) => {
            log::warn(
              CONTEXT,
              &format!("Record unreadable key={record} err=\"{e}\""),
            );
            report.failed += 1;
            continue;
          }
        };
        failures.extend(
          self
            .seal_all(keys.into_iter().map(|k| (k, None)).collect(), &mut report)
            .await,
        );
        purge(self.raw.as_ref(), &record).await?;
        report.records_done += 1;
      }
      token = next;
      if token.is_none() {
        break;
      }
    }
    if !failures.is_empty() {
      let mut state = read_state(&self.sealed).await?;
      state.note(&[], failures, now_ms);
      save_state(&self.sealed, &state).await?;
    }
    Ok(report)
  }

  /// Retries what failed, then seals everything written since the last
  /// pass, page by page: after each page the state keeps where the pass is
  /// and what failed, so a restart resumes it. Then cleans up after
  /// interrupted rewrites and uploads.
  pub async fn backstop(&self, now_ms: i64) -> Result<PassReport, StoreError> {
    let mut state = read_state(&self.sealed).await?;
    let since = state.backstop_since.unwrap_or(now_ms - FIRST_BACKSTOP_MS);
    let pass = state
      .backstop_pass
      .get_or_insert(BackstopPass {
        started_ms: now_ms,
        after: None,
      })
      .clone();
    let mut report = PassReport::default();
    let retried: HashSet<String> = state.failed.iter().map(|f| f.key.clone()).collect();
    let failures = retry_failed(&self.migration, &state.failed).await;
    report.checked += retried.len() as u64;
    report.failed += failures.len() as u64;
    // The pass moves on even when some keys fail: they stay in the list.
    state.note(
      &retried.iter().cloned().collect::<Vec<_>>(),
      failures,
      now_ms,
    );
    save_state(&self.sealed, &state).await?;
    let mut after = pass.after.clone();
    loop {
      let (objects, more) = self.page_after(after.clone()).await?;
      let last = objects.last().map(|(key, _)| key.clone());
      let recent: Vec<(String, Option<i64>)> = objects
        .into_iter()
        .filter(|(key, modified)| {
          !key.starts_with(INTERNAL_ROOT)
            && !retried.contains(key)
            && modified.is_none_or(|ms| ms >= since - BACKSTOP_OVERLAP_MS)
        })
        .collect();
      let failures = self.seal_all(recent, &mut report).await;
      state.note(&[], failures, now_ms);
      if last.is_some() {
        after = last;
      }
      state.backstop_pass = Some(BackstopPass {
        started_ms: pass.started_ms,
        after: after.clone(),
      });
      save_state(&self.sealed, &state).await?;
      if !more {
        break;
      }
    }
    state.backstop_since = Some(pass.started_ms);
    state.backstop_pass = None;
    save_state(&self.sealed, &state).await?;

    let mut token = None;
    loop {
      let (temporary, next) = self.page(Some(TMP_PREFIX), token).await?;
      for (key, modified) in temporary {
        if modified.is_some_and(|ms| now_ms - ms > TMP_STALE_MS) {
          match purge(self.raw.as_ref(), &key).await {
            Ok(()) => log::log(
              CONTEXT,
              &format!("Stale temporary object removed key={key}"),
            ),
            Err(e) => log::warn(
              CONTEXT,
              &format!("Stale temporary object not removed key={key} err=\"{e}\""),
            ),
          }
        }
      }
      token = next;
      if token.is_none() {
        break;
      }
    }
    match self.raw.list_multipart("").await {
      Ok(uploads) => {
        for upload in uploads {
          if upload
            .initiated_ms
            .is_some_and(|ms| now_ms - ms > ABANDONED_MS)
          {
            match self
              .raw
              .abort_multipart(&upload.key, &upload.upload_id)
              .await
            {
              Ok(()) => log::log(
                CONTEXT,
                &format!("Abandoned upload aborted key={}", upload.key),
              ),
              Err(e) => log::warn(
                CONTEXT,
                &format!(
                  "Abandoned upload not aborted key={} err=\"{e}\"",
                  upload.key
                ),
              ),
            }
          }
        }
      }
      // Some stores (rclone) cannot list them, and keep none.
      Err(StoreError::NotFound) => {}
      Err(e) => log::warn(
        CONTEXT,
        &format!("Unfinished uploads not listed err=\"{e}\""),
      ),
    }
    Ok(report)
  }
}

fn log_pass(name: &str, outcome: Result<PassReport, StoreError>, started: Instant) {
  match outcome {
    Ok(report) if report.sealed > 0 || report.failed > 0 || report.records_done > 0 => {
      let line = format!(
        "{name} records={} records_done={} checked={} sealed={} failed={} elapsed_ms={}",
        report.records,
        report.records_done,
        report.checked,
        report.sealed,
        report.failed,
        started.elapsed().as_millis()
      );
      if report.failed > 0 {
        log::warn(CONTEXT, &line);
      } else {
        log::log(CONTEXT, &line);
      }
    }
    Ok(_) => {}
    Err(e) => log::warn(CONTEXT, &format!("{name} stopped err=\"{e}\"")),
  }
}

/// Runs the passes for as long as the server does.
pub fn spawn(raw: Arc<dyn Store>, keyring: Arc<Keyring>) {
  tokio::spawn(async move {
    // The first pass waits too: starting writes a probe object, which
    // should not race the server's first requests.
    tokio::time::sleep(PASS_EVERY).await;
    let sealer = loop {
      match Sealer::new(raw.clone(), keyring.clone()).await {
        Ok(sealer) => break sealer,
        Err(e) => {
          log::warn(CONTEXT, &format!("Sealer not started err=\"{e}\""));
          tokio::time::sleep(PASS_EVERY).await;
        }
      }
    };
    let mut last_backstop: Option<Instant> = None;
    loop {
      let started = Instant::now();
      log_pass(
        "Pending pass",
        sealer.pending_pass(time::now_ms()).await,
        started,
      );
      if last_backstop.is_none_or(|at| at.elapsed() >= BACKSTOP_EVERY) {
        let started = Instant::now();
        log_pass(
          "Backstop pass",
          sealer.backstop(time::now_ms()).await,
          started,
        );
        last_backstop = Some(Instant::now());
      }
      tokio::time::sleep(PASS_EVERY).await;
    }
  });
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::Ordering::SeqCst;

  use super::*;
  use crate::memory_store::MemoryStore;
  use crate::sealed_store::sealed_by;

  const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  async fn setup(raw: MemoryStore) -> (Arc<MemoryStore>, SealedStore, Sealer) {
    let raw = Arc::new(raw);
    let keyring = Arc::new(Keyring::parse(K1).unwrap());
    let sealed = SealedStore::new(raw.clone(), keyring.clone());
    let sealer = Sealer::new(raw.clone(), keyring).await.unwrap();
    (raw, sealed, sealer)
  }

  async fn is_sealed(raw: &MemoryStore, key: &str) -> bool {
    sealed_by(&raw.head_object(key).await.unwrap()).is_some()
  }

  #[tokio::test]
  async fn records_are_sealed_only_once_their_urls_are_dead() {
    let (raw, sealed, sealer) = setup(MemoryStore::versioned()).await;
    note_direct_uploads(&sealed, &["a".to_string(), "b".to_string()], 10_000)
      .await
      .unwrap();
    let record = raw
      .keys()
      .into_iter()
      .find(|k| k.starts_with(PENDING))
      .unwrap();
    assert!(
      raw.get(&record).unwrap().starts_with("DSAR"),
      "the record is sealed"
    );

    // While the URL can still write, nothing is rewritten.
    raw.set("a", "plain a");
    let report = sealer.pending_pass(5_000).await.unwrap();
    assert_eq!((report.records, report.checked), (1, 0));
    assert!(!is_sealed(&raw, "a").await);

    raw.set("a", "plain a2");
    let report = sealer
      .pending_pass(10_000 + RECORD_GRACE_MS + 1)
      .await
      .unwrap();
    assert_eq!(
      (report.checked, report.sealed, report.records_done),
      (2, 1, 1)
    );
    assert_eq!(sealed.get_object_text("a").await.unwrap(), "plain a2");
    assert_eq!(
      raw.version_count(&record),
      0,
      "the record goes with its versions"
    );
  }

  #[tokio::test]
  async fn the_backstop_seals_recent_plaintext_and_remembers_where_it_stopped() {
    let (raw, sealed, sealer) = setup(MemoryStore::default()).await;
    let start = 10 * 3600 * 1000;
    raw.clock.store(start, SeqCst);
    raw.set("old", "x");
    raw.clock.store(start + 3 * 3600 * 1000, SeqCst);
    raw.set("new", "y");
    let first = raw.clock.load(SeqCst) + 1;
    let report = sealer.backstop(first).await.unwrap();
    assert_eq!(
      report.sealed, 1,
      "a first pass looks back FIRST_BACKSTOP_MS"
    );
    assert!(is_sealed(&raw, "new").await);
    assert!(
      !is_sealed(&raw, "old").await,
      "older objects are the migration's"
    );
    assert_eq!(
      read_state(&sealed).await.unwrap().backstop_since,
      Some(first)
    );

    raw.set("later", "z");
    let report = sealer.backstop(raw.clock.load(SeqCst) + 1).await.unwrap();
    assert_eq!(report.sealed, 1);
    assert!(is_sealed(&raw, "later").await);
    assert!(!is_sealed(&raw, "old").await);
  }

  #[tokio::test]
  async fn a_key_that_keeps_failing_is_listed_and_does_not_hold_the_backstop_back() {
    let (raw, sealed, sealer) = setup(MemoryStore::default()).await;
    // Sealed under a key this server does not hold.
    let other = Keyring::parse("k9:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=").unwrap();
    raw.insert(
      "stuck",
      crate::at_rest::seal(&other, b"x"),
      vec![(crate::at_rest::MARKER.into(), "1:k9".into())],
      None,
    );
    let now = raw.clock.load(SeqCst) + 1;
    let report = sealer.backstop(now).await.unwrap();
    assert_eq!(report.failed, 1);
    let state = read_state(&sealed).await.unwrap();
    assert_eq!(state.backstop_since, Some(now));
    assert_eq!(state.failed.len(), 1);
    assert_eq!(
      (state.failed[0].key.as_str(), state.failed[0].at),
      ("stuck", now)
    );

    // Retried on the next pass, though older than its window; kept with the
    // time it first failed. Once fixed, it leaves the list.
    let report = sealer.backstop(now + 10 * 3600 * 1000).await.unwrap();
    assert_eq!(report.failed, 1);
    assert_eq!(read_state(&sealed).await.unwrap().failed[0].at, now);
    raw.set("stuck", "fixed");
    sealer.backstop(now + 20 * 3600 * 1000).await.unwrap();
    assert!(read_state(&sealed).await.unwrap().failed.is_empty());
  }

  #[tokio::test]
  async fn stale_temporary_objects_and_abandoned_uploads_are_removed() {
    let (raw, _, sealer) = setup(MemoryStore::versioned()).await;
    let tmp = format!("{TMP_PREFIX}leftover");
    raw.set(&tmp, "x");
    raw.set(&tmp, "y");
    raw.create_multipart("k", None, &[]).await.unwrap();
    let now = raw.clock.load(SeqCst);
    sealer.backstop(now + 1).await.unwrap();
    assert_eq!(
      raw.version_count(&tmp),
      2,
      "a fresh one may belong to a running rewrite"
    );
    assert_eq!(raw.list_multipart("").await.unwrap().len(), 1);
    sealer.backstop(now + ABANDONED_MS + 1).await.unwrap();
    assert_eq!(raw.version_count(&tmp), 0);
    assert!(raw.list_multipart("").await.unwrap().is_empty());
  }

  #[tokio::test]
  async fn presigns_are_noted_as_one_record_per_flush() {
    let (raw, sealed, _) = setup(MemoryStore::default()).await;
    let direct = DirectUploads::default();
    direct.flush(&sealed).await.unwrap();
    assert!(raw.keys().is_empty(), "nothing noted, nothing written");
    direct.note(&["a".to_string()], 5_000);
    direct.note(&["b".to_string(), "c".to_string()], 7_000);
    direct.flush(&sealed).await.unwrap();
    let records: Vec<String> = raw
      .keys()
      .into_iter()
      .filter(|k| k.starts_with(PENDING))
      .collect();
    assert_eq!(records.len(), 1);
    assert_eq!(record_expiry(&records[0]), Some(7_000));
    let body = sealed.get_object_text(&records[0]).await.unwrap();
    assert_eq!(body, r#"{"keys":["a","b","c"]}"#);
    direct.flush(&sealed).await.unwrap();
    assert_eq!(raw.keys().len(), 1);
  }

  /// The pass stops after two pages, as a restart would stop it; the next
  /// one picks up after the last page it finished, and only then moves the
  /// window on.
  #[tokio::test]
  async fn a_backstop_pass_resumes_after_a_restart() {
    let (raw, sealed, sealer) = setup(MemoryStore::default()).await;
    for i in 0..2500 {
      raw.set(&format!("k{i:05}"), "x");
    }
    let now = raw.clock.load(SeqCst) + 1;
    *raw.list_budget.lock().unwrap() = Some(2);
    assert!(
      sealer.backstop(now).await.is_err(),
      "stopped on the third page"
    );
    let state = read_state(&sealed).await.unwrap();
    assert_eq!(
      state.backstop_pass,
      Some(BackstopPass {
        started_ms: now,
        // The sealer's own state object sorts first and takes a place.
        after: Some("k01998".to_string()),
      })
    );
    assert_eq!(
      state.backstop_since, None,
      "the window moves only when a pass ends"
    );
    assert!(is_sealed(&raw, "k01998").await);
    assert!(!is_sealed(&raw, "k01999").await);

    // A new process: the same state, the rest of the bucket.
    *raw.list_budget.lock().unwrap() = None;
    let keyring = Arc::new(Keyring::parse(K1).unwrap());
    let restarted = Sealer::new(raw.clone(), keyring).await.unwrap();
    let report = restarted.backstop(now + 60_000).await.unwrap();
    assert_eq!((report.checked, report.sealed), (501, 501));
    let state = read_state(&sealed).await.unwrap();
    assert_eq!(
      (state.backstop_since, state.backstop_pass),
      (Some(now), None)
    );
    assert!(is_sealed(&raw, "k02499").await);
  }

  /// A key that fails is in the saved state before the pass ends.
  #[tokio::test]
  async fn failures_are_saved_with_the_page_they_fail_on() {
    let (raw, sealed, sealer) = setup(MemoryStore::default()).await;
    let other = Keyring::parse("k9:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=").unwrap();
    raw.insert(
      "a-stuck",
      crate::at_rest::seal(&other, b"x"),
      vec![(crate::at_rest::MARKER.into(), "1:k9".into())],
      None,
    );
    for i in 0..1500 {
      raw.set(&format!("k{i:05}"), "x");
    }
    *raw.list_budget.lock().unwrap() = Some(1);
    let now = raw.clock.load(SeqCst) + 1;
    assert!(sealer.backstop(now).await.is_err());
    let failed = read_state(&sealed).await.unwrap().failed;
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].key, "a-stuck");
  }

  #[test]
  fn records_name_their_expiry() {
    assert_eq!(
      record_expiry(&format!("{PENDING}0000000012345-abc")),
      Some(12345)
    );
    assert_eq!(record_expiry("other"), None);
  }
}
