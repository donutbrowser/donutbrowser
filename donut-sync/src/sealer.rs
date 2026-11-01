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

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::at_rest::Keyring;
use crate::log;
use crate::migrate::{Migration, Outcome, TMP_PREFIX, honors_if_match, purge};
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
const CONCURRENCY: usize = 4;

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
}

/// What the sealer keeps between passes, sealed in `STATE`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
  pub backstop_since: Option<i64>,
  #[serde(default)]
  pub failed: Vec<Failed>,
}

impl State {
  /// `failures` from a pass over `checked`: keys that sealed leave the list,
  /// keys that failed join it (keeping when they first failed).
  fn note(&mut self, checked: &[String], failures: Vec<(String, String)>, now_ms: i64) {
    let first: Vec<(String, i64)> = self.failed.iter().map(|f| (f.key.clone(), f.at)).collect();
    self.failed.retain(|f| !checked.contains(&f.key));
    for (key, reason) in failures {
      let at = first
        .iter()
        .find(|(k, _)| *k == key)
        .map_or(now_ms, |(_, at)| *at);
      self.failed.retain(|f| f.key != key);
      self.failed.insert(0, Failed { key, reason, at });
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

  /// Seals `keys`; returns the ones that failed, with why.
  async fn seal_all(
    &self,
    keys: Vec<(String, Option<i64>)>,
    report: &mut PassReport,
  ) -> Vec<(String, String)> {
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
      match outcome {
        Outcome::Sealed(_) | Outcome::Rotated(_) => report.sealed += 1,
        Outcome::Failed(err) => {
          log::warn(
            CONTEXT,
            &format!("Object not sealed key={key} err=\"{err}\""),
          );
          report.failed += 1;
          failures.push((key, err));
        }
        Outcome::Current | Outcome::Changed | Outcome::Unsealed(_) => {}
      }
    }
    failures
  }

  async fn list(&self, prefix: Option<&str>) -> Result<Vec<(String, Option<i64>)>, StoreError> {
    let mut out = Vec::new();
    let mut token = None;
    loop {
      let page = self
        .raw
        .list_objects_v2(&ListInput {
          prefix: prefix.map(str::to_string),
          max_keys: Some("1000".to_string()),
          continuation_token: token.clone(),
          ..ListInput::default()
        })
        .await?;
      out.extend(
        page
          .contents
          .into_iter()
          .map(|object| (object.key, object.last_modified_ms)),
      );
      token = page.next_continuation_token.filter(|_| page.is_truncated);
      if token.is_none() {
        return Ok(out);
      }
    }
  }

  async fn save_state(&self, state: &State) -> Result<(), StoreError> {
    self
      .sealed
      .put_object(
        STATE,
        serde_json::to_vec(state).expect("the state serializes"),
        "application/json",
        &[],
      )
      .await
  }

  /// Seals the keys of each record whose URLs are dead, then drops the
  /// record. Keys that fail are kept in the state for the backstop.
  pub async fn pending_pass(&self, now_ms: i64) -> Result<PassReport, StoreError> {
    let mut report = PassReport::default();
    let mut checked = Vec::new();
    let mut failures = Vec::new();
    for (record, _) in self.list(Some(PENDING)).await? {
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
          .seal_all(
            keys.iter().map(|k| (k.clone(), None)).collect(),
            &mut report,
          )
          .await,
      );
      checked.extend(keys);
      purge(self.raw.as_ref(), &record).await?;
      report.records_done += 1;
    }
    if !failures.is_empty() {
      let mut state = read_state(&self.sealed).await?;
      state.note(&checked, failures, now_ms);
      self.save_state(&state).await?;
    }
    Ok(report)
  }

  /// Seals everything written since the last pass and retries what failed,
  /// then cleans up after interrupted rewrites and uploads.
  pub async fn backstop(&self, now_ms: i64) -> Result<PassReport, StoreError> {
    let mut state = read_state(&self.sealed).await?;
    let since = state.backstop_since.unwrap_or(now_ms - FIRST_BACKSTOP_MS);
    let listed = self.list(None).await?;
    let mut candidates: Vec<(String, Option<i64>)> = listed
      .iter()
      .filter(|(key, modified)| {
        !key.starts_with(INTERNAL_ROOT)
          && modified.is_none_or(|ms| ms >= since - BACKSTOP_OVERLAP_MS)
      })
      .cloned()
      .collect();
    for failed in &state.failed {
      if !candidates.iter().any(|(key, _)| *key == failed.key) {
        candidates.push((failed.key.clone(), None));
      }
    }
    let checked: Vec<String> = candidates.iter().map(|(key, _)| key.clone()).collect();
    let mut report = PassReport::default();
    let failures = self.seal_all(candidates, &mut report).await;
    // The pass moves on even when some keys fail: they stay in the list.
    state.note(&checked, failures, now_ms);
    state.backstop_since = Some(now_ms);
    self.save_state(&state).await?;

    for (key, modified) in &listed {
      if key.starts_with(TMP_PREFIX) && modified.is_some_and(|ms| now_ms - ms > TMP_STALE_MS) {
        match purge(self.raw.as_ref(), key).await {
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

  #[test]
  fn records_name_their_expiry() {
    assert_eq!(
      record_expiry(&format!("{PENDING}0000000012345-abc")),
      Some(12345)
    );
    assert_eq!(record_expiry("other"), None);
  }
}
