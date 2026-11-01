//! Seals what older apps upload in plaintext. Older apps PUT to the direct
//! storage URL that presign-upload has always returned, because one request
//! through a proxy such as Cloudflare cannot carry a large file. The server
//! notes each key it hands such a URL for (`note_direct_uploads`), in the
//! bucket so a restart keeps the list, and seals those objects in place with
//! the migration's ETag-checked rewrite: on the first pass after the URL is
//! handed out (`PASS_EVERY`), and once more after the URL is dead. An hourly pass over everything written
//! since the last one catches what a lost record missed, and storage uploads
//! in parts that were never finished are aborted.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::at_rest::Keyring;
use crate::log;
use crate::migrate::{Migration, Outcome, honors_if_match};
use crate::sealed_store::SealedStore;
use crate::store::{ListInput, Store, StoreError};
use crate::time;

/// This server's own objects. No client prefix matches it.
pub const INTERNAL_ROOT: &str = ".donut-sync-at-rest/";
const PENDING: &str = ".donut-sync-at-rest/pending/";
const STATE: &str = ".donut-sync-at-rest/state.json";
const CONTEXT: &str = "Sealer";
const PASS_EVERY: Duration = Duration::from_secs(120);
const BACKSTOP_EVERY: Duration = Duration::from_secs(3600);
/// Overlap between backstop passes, for clock skew between server and storage.
const BACKSTOP_OVERLAP_MS: i64 = 10 * 60 * 1000;
/// A first backstop pass looks back this far; the migration covers the rest.
const FIRST_BACKSTOP_MS: i64 = 2 * 3600 * 1000;
/// A record is kept this long after its URLs expire, for uploads in flight.
const RECORD_GRACE_MS: i64 = 5 * 60 * 1000;
/// Unfinished part uploads older than this are aborted: past any upload token.
const ABANDONED_MS: i64 = 26 * 3600 * 1000;
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

#[derive(Default, Debug, PartialEq)]
pub struct PassReport {
  pub records: u64,
  pub records_done: u64,
  pub checked: u64,
  pub sealed: u64,
  pub failed: u64,
}

impl PassReport {
  fn add(&mut self, outcome: &Outcome) {
    self.checked += 1;
    match outcome {
      Outcome::Sealed(_) | Outcome::Rotated(_) => self.sealed += 1,
      Outcome::Failed(_) => self.failed += 1,
      Outcome::Current | Outcome::Changed => {}
    }
  }
}

pub struct Sealer {
  raw: Arc<dyn Store>,
  sealed: SealedStore,
  migration: Migration,
  /// Records sealed once while their URLs live. A restart forgets them, and
  /// they are sealed once more: harmless.
  first_round: Mutex<HashSet<String>>,
}

impl Sealer {
  pub async fn new(raw: Arc<dyn Store>, keyring: Arc<Keyring>) -> Result<Self, StoreError> {
    let conditional = honors_if_match(raw.as_ref()).await?;
    Ok(Self {
      sealed: SealedStore::new(raw.clone(), keyring.clone()),
      migration: Migration::sealing(raw.clone(), keyring, conditional),
      raw,
      first_round: Mutex::new(HashSet::new()),
    })
  }

  async fn seal_all(&self, keys: Vec<(String, Option<i64>)>, report: &mut PassReport) {
    let outcomes: Vec<(String, Outcome)> = futures_util::stream::iter(keys)
      .map(|(key, listed)| async move {
        let outcome = self.migration.object(&key, listed).await;
        (key, outcome)
      })
      .buffer_unordered(CONCURRENCY)
      .collect()
      .await;
    for (key, outcome) in outcomes {
      if let Outcome::Failed(err) = &outcome {
        log::warn(
          CONTEXT,
          &format!("Object not sealed key={key} err=\"{err}\""),
        );
      }
      report.add(&outcome);
    }
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

  /// Seals the keys of each new record, and of each record whose URLs are
  /// dead, which it then drops.
  pub async fn pending_pass(&self, now_ms: i64) -> Result<PassReport, StoreError> {
    let mut report = PassReport::default();
    for (record, _) in self.list(Some(PENDING)).await? {
      report.records += 1;
      let dead = record_expiry(&record).is_some_and(|expiry| now_ms > expiry + RECORD_GRACE_MS);
      if !dead && !self.first_round.lock().unwrap().insert(record.clone()) {
        continue;
      }
      let keys: Vec<(String, Option<i64>)> = match self.sealed.get_object_text(&record).await {
        Ok(text) => serde_json::from_str::<Value>(&text)
          .ok()
          .and_then(|v| v["keys"].as_array().cloned())
          .unwrap_or_default()
          .iter()
          .filter_map(|k| k.as_str().map(|k| (k.to_string(), None)))
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
      let failed_before = report.failed;
      self.seal_all(keys, &mut report).await;
      if dead && report.failed == failed_before {
        self.raw.delete_object(&record).await?;
        self.first_round.lock().unwrap().remove(&record);
        report.records_done += 1;
      }
    }
    Ok(report)
  }

  /// Seals everything written since the last pass, and aborts abandoned
  /// uploads in parts.
  pub async fn backstop(&self, now_ms: i64) -> Result<PassReport, StoreError> {
    let since = match self.sealed.get_object_text(STATE).await {
      Ok(text) => serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["backstopSince"].as_i64()),
      Err(StoreError::NotFound) => None,
      Err(e) => return Err(e),
    }
    .unwrap_or(now_ms - FIRST_BACKSTOP_MS);
    let recent: Vec<(String, Option<i64>)> = self
      .list(None)
      .await?
      .into_iter()
      .filter(|(key, modified)| {
        !key.starts_with(INTERNAL_ROOT)
          && modified.is_none_or(|ms| ms >= since - BACKSTOP_OVERLAP_MS)
      })
      .collect();
    let mut report = PassReport::default();
    self.seal_all(recent, &mut report).await;
    if report.failed == 0 {
      self
        .sealed
        .put_object(
          STATE,
          json!({ "backstopSince": now_ms }).to_string().into_bytes(),
          "application/json",
          &[],
        )
        .await?;
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
  use super::*;
  use crate::memory_store::MemoryStore;
  use crate::sealed_store::sealed_by;

  const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  async fn setup() -> (Arc<MemoryStore>, SealedStore, Sealer) {
    let raw = Arc::new(MemoryStore::default());
    let keyring = Arc::new(Keyring::parse(K1).unwrap());
    let sealed = SealedStore::new(raw.clone(), keyring.clone());
    let sealer = Sealer::new(raw.clone(), keyring).await.unwrap();
    (raw, sealed, sealer)
  }

  async fn is_sealed(raw: &MemoryStore, key: &str) -> bool {
    sealed_by(&raw.head_object(key).await.unwrap()).is_some()
  }

  #[tokio::test]
  async fn records_seal_direct_uploads_until_their_urls_are_dead() {
    let (raw, sealed, sealer) = setup().await;
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

    // "a" is uploaded, "b" not yet.
    raw.set("a", "plain a");
    let report = sealer.pending_pass(5_000).await.unwrap();
    assert_eq!(
      (report.records, report.sealed, report.records_done),
      (1, 1, 0)
    );
    assert!(is_sealed(&raw, "a").await);
    assert_eq!(sealed.get_object_text("a").await.unwrap(), "plain a");

    // A live record is not sealed again.
    raw.set("b", "plain b");
    let report = sealer.pending_pass(6_000).await.unwrap();
    assert_eq!((report.records, report.checked), (1, 0));

    // The URL writes again before it expires; the pass after it is dead
    // seals that too.
    raw.set("a", "plain a2");
    let report = sealer
      .pending_pass(10_000 + RECORD_GRACE_MS + 1)
      .await
      .unwrap();
    assert_eq!((report.sealed, report.records_done), (2, 1));
    assert_eq!(sealed.get_object_text("a").await.unwrap(), "plain a2");
    assert!(raw.keys().iter().all(|k| !k.starts_with(PENDING)));
  }

  #[tokio::test]
  async fn the_backstop_seals_recent_plaintext_and_remembers_where_it_stopped() {
    use std::sync::atomic::Ordering::SeqCst;
    let (raw, sealed, sealer) = setup().await;
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
    assert!(
      sealed
        .get_object_text(STATE)
        .await
        .unwrap()
        .contains(&first.to_string())
    );

    raw.set("later", "z");
    let report = sealer.backstop(raw.clock.load(SeqCst) + 1).await.unwrap();
    assert_eq!(report.sealed, 1);
    assert!(is_sealed(&raw, "later").await);
    assert!(!is_sealed(&raw, "old").await);
  }

  #[tokio::test]
  async fn abandoned_uploads_in_parts_are_aborted() {
    let (raw, _, sealer) = setup().await;
    raw.create_multipart("k", None, &[]).await.unwrap();
    sealer.backstop(1).await.unwrap();
    assert_eq!(raw.list_multipart("").await.unwrap().len(), 1);
    sealer.backstop(ABANDONED_MS + 1_000_000).await.unwrap();
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
