//! `donut-sync migrate-at-rest`: seals the plaintext objects already in the
//! bucket, and re-seals objects under an older key, while the server runs.
//!
//! Run it after the server runs with `SYNC_AT_REST_KEY` and the S3 URLs it
//! handed out before have expired (one hour), so no device writes plaintext
//! behind it. A rerun skips what is sealed under the current key.
//!
//! A device can write an object while it is re-sealed. Where the store honors
//! `If-Match` on PUT, the write is conditional on the ETag read. Elsewhere the
//! object is sealed into a temporary key outside every namespace, its ETag is
//! checked again, and a server-side copy puts it in place, so the window is
//! one HEAD and one copy, whatever the object's size.
//!
//! A rewrite gives the object a new LastModified, so the old one is kept in
//! `ORIGINAL_MTIME` and the server reports it (profile age, stat, downloads).
//!
//! The copy can still land on top of a device's write or delete made in that
//! window. Where the bucket keeps versions (B2), the key's versions are read
//! after the copy, and a version made between the read and the copy is put
//! back as the current one.
//!
//! `--unseal` goes the other way, for a rollback: run it while the server is
//! in the unsealing state (`SYNC_AT_REST_KEY=unseal,<keys>`), then remove the
//! key once `verify-at-rest` finds nothing sealed.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;

use crate::at_rest::{self, Keyring, MARKER};
use crate::config::Config;
use crate::log;
use crate::original_times::{ORIGINAL_MTIME, original_mtime};
use crate::sealed_store::sealed_by;
use crate::sealer::{Failed, Failure, read_state, retry_failed, save_state};
use crate::store::{
  ByteStream, CopySpec, HeadOutput, ListInput, Store, StoreError, Upload, versions_of,
};
use crate::time;
use serde::{Deserialize, Serialize};

pub const COMMAND: &str = "migrate-at-rest";
const CONTEXT: &str = "Migrate";
/// Temporary sealed copies. No client prefix matches it.
pub const TMP_PREFIX: &str = ".donut-sync-at-rest/tmp/";
const PROGRESS_EVERY: Duration = Duration::from_secs(10);
/// Tries per object when storage fails for a while (B2 answers 500 "internal
/// incident" and 503, and asks for exponential backoff): 1, 2, 4, 8 and 16 s
/// apart, about half a minute, on top of each request's own quick retries.
const ATTEMPTS: u32 = 6;
/// Put-backs in a row before a settle gives up on a history that keeps moving.
const SETTLE_ROUNDS: usize = 3;

const USAGE: &str = "Usage: donut-sync migrate-at-rest [--unseal] [--dry-run] [--prefix P] [--concurrency N] [--max-mib-per-sec N] [--checkpoint FILE]

Seals every plaintext object in S3_BUCKET with the first key of SYNC_AT_REST_KEY,
and re-seals objects under its other keys. Safe to stop and run again.

  --unseal             Turn every sealed object back into plaintext. Needs
                       SYNC_AT_REST_KEY=unseal,<keys>, as the server has it.
  --dry-run            Count what would change; write nothing.
  --prefix P           Only keys under P.
  --concurrency N      Objects at a time (default 4).
  --max-mib-per-sec N  Read at most N MiB/s (default unlimited).
  --checkpoint FILE    Resume after the key in FILE, and keep it current.";

#[derive(Debug, Default, Clone)]
pub struct Options {
  pub unseal: bool,
  pub dry_run: bool,
  pub prefix: Option<String>,
  pub concurrency: usize,
  pub bytes_per_sec: Option<u64>,
  pub checkpoint: Option<PathBuf>,
}

fn parse(args: &[String]) -> Result<Options, String> {
  let mut options = Options {
    concurrency: 4,
    ..Options::default()
  };
  let mut args = args.iter();
  while let Some(arg) = args.next() {
    let mut value = |name: &str| {
      args
        .next()
        .cloned()
        .ok_or_else(|| format!("{name} needs a value"))
    };
    match arg.as_str() {
      "--dry-run" => options.dry_run = true,
      "--unseal" => options.unseal = true,
      "--prefix" => options.prefix = Some(value(arg)?),
      "--concurrency" => {
        options.concurrency = value(arg)?
          .parse()
          .ok()
          .filter(|n| (1..=64).contains(n))
          .ok_or("--concurrency must be 1-64")?;
      }
      "--max-mib-per-sec" => {
        let mib: u64 = value(arg)?
          .parse()
          .ok()
          .filter(|n| *n > 0)
          .ok_or("--max-mib-per-sec must be a positive whole number")?;
        options.bytes_per_sec = Some(mib * 1024 * 1024);
      }
      "--checkpoint" => options.checkpoint = Some(PathBuf::from(value(arg)?)),
      _ => return Err(format!("Unknown argument {arg}")),
    }
  }
  Ok(options)
}

pub async fn run(config: &Config, args: &[String]) -> i32 {
  if args.iter().any(|a| a == "--help" || a == "-h") {
    println!("{USAGE}");
    return 0;
  }
  let options = match parse(args) {
    Ok(options) => options,
    Err(message) => {
      eprintln!("{message}\n\n{USAGE}");
      return 2;
    }
  };
  let Some(keys) = config.at_rest_key.as_deref() else {
    eprintln!("SYNC_AT_REST_KEY is not set");
    return 1;
  };
  let keyring = match Keyring::parse(keys) {
    Ok(keyring) => Arc::new(keyring),
    Err(message) => {
      eprintln!("{message}");
      return 1;
    }
  };
  let store: Arc<dyn Store> = match crate::raw_store(config) {
    Ok(store) => Arc::new(store),
    Err(message) => {
      eprintln!("{message}");
      return 1;
    }
  };
  match migrate(store, keyring, &options).await {
    Ok(report) if report.failed == 0 => 0,
    Ok(_) => 1,
    Err(message) => {
      log::error(CONTEXT, &format!("Migration stopped err=\"{message}\""));
      1
    }
  }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Report {
  pub scanned: u64,
  /// Already under the current key.
  pub current: u64,
  /// Plaintext objects sealed (or, in a dry run, to seal).
  pub sealed: u64,
  pub sealed_bytes: u64,
  /// Objects under an older key re-sealed (or to re-seal).
  pub rotated: u64,
  pub rotated_bytes: u64,
  /// Sealed objects turned back into plaintext (or to turn back).
  pub unsealed: u64,
  pub unsealed_bytes: u64,
  /// Written or deleted by someone else meanwhile; left as they are.
  pub changed: u64,
  pub failed: u64,
}

pub(crate) enum Outcome {
  /// Already as this run wants it.
  Current,
  Sealed(u64),
  Rotated(u64),
  Unsealed(u64),
  Changed,
  /// Rewritten, but a device's version may lie under the rewrite: settle it
  /// later with these ids.
  Unsettled {
    settle: Settle,
    reason: String,
  },
  Failed(String),
}

/// Reads at most `per_sec` bytes a second, across every worker.
struct RateLimit {
  per_sec: u64,
  state: Mutex<(Instant, u64)>,
}

impl RateLimit {
  async fn take(&self, bytes: u64) {
    let wait = {
      let mut state = self.state.lock().unwrap();
      state.1 += bytes;
      let due = Duration::from_secs_f64(state.1 as f64 / self.per_sec as f64);
      due.saturating_sub(state.0.elapsed())
    };
    if !wait.is_zero() {
      tokio::time::sleep(wait).await;
    }
  }
}

fn throttled(body: ByteStream, limit: Option<Arc<RateLimit>>) -> ByteStream {
  match limit {
    None => body,
    Some(limit) => Box::pin(body.then(move |chunk| {
      let limit = limit.clone();
      async move {
        if let Ok(bytes) = &chunk {
          limit.take(bytes.len() as u64).await;
        }
        chunk
      }
    })),
  }
}

/// Which way objects are rewritten.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Direction {
  Seal,
  Unseal,
}

pub(crate) struct Migration {
  store: Arc<dyn Store>,
  keyring: Arc<Keyring>,
  direction: Direction,
  dry_run: bool,
  conditional: bool,
  limit: Option<Arc<RateLimit>>,
}

impl Migration {
  /// Seals in place, as the migration does, without a rate limit.
  pub(crate) fn sealing(store: Arc<dyn Store>, keyring: Arc<Keyring>, conditional: bool) -> Self {
    Self {
      store,
      keyring,
      direction: Direction::Seal,
      dry_run: false,
      conditional,
      limit: None,
    }
  }
}

/// A failure that may pass: a dropped connection, a 5xx or a 429. A
/// refusal (403, 400) or a sealed object that does not open stays as it is.
fn transient(error: &StoreError) -> bool {
  match error {
    StoreError::Transport(_) => true,
    StoreError::Service { status, .. } => *status >= 500 || *status == 429,
    StoreError::NotFound | StoreError::Corrupt(_) => false,
  }
}

/// The wait after try `attempt` (1-based): 1 s, then doubling.
fn backoff(attempt: u32) -> Duration {
  Duration::from_secs(1 << (attempt - 1).min(5))
}

fn precondition_failed(error: &StoreError) -> bool {
  matches!(error, StoreError::Service { status: 412, .. })
}

/// Deletes `key` with every version it has, where the bucket keeps versions,
/// so a temporary object leaves nothing behind.
pub async fn purge(store: &dyn Store, key: &str) -> Result<(), StoreError> {
  match versions_of(store, key).await? {
    Some(versions) => {
      for version in versions {
        store.delete_version(key, &version.version_id).await?;
      }
      Ok(())
    }
    None => store.delete_object(key).await.map(|_| ()),
  }
}

/// Whether the store refuses a PUT whose `If-Match` names another ETag.
pub async fn honors_if_match(store: &dyn Store) -> Result<bool, StoreError> {
  let probe = format!("{TMP_PREFIX}probe-{}", uuid::Uuid::new_v4().simple());
  store
    .put_object(&probe, b"a".to_vec(), "text/plain", &[])
    .await?;
  let outcome = store
    .put_object_stream(
      &probe,
      crate::store::once(b"b".to_vec()),
      Upload {
        length: 1,
        content_type: Some("text/plain"),
        metadata: &[],
        if_match: Some("\"00000000000000000000000000000000\""),
      },
    )
    .await;
  let _ = purge(store, &probe).await;
  match outcome {
    Ok(()) => Ok(false),
    Err(e) if precondition_failed(&e) => Ok(true),
    // Some stores (Backblaze B2) refuse the header instead of honoring it.
    Err(StoreError::Service { .. }) => Ok(false),
    Err(e) => Err(e),
  }
}

/// The key id an object is sealed under, or `None` for plaintext. The marker
/// alone is not trusted, since a device could set it on a direct upload:
/// the stored bytes must start with the header it names, at a sealed size.
pub(crate) async fn sealed_kid(
  store: &dyn Store,
  key: &str,
  head: &HeadOutput,
) -> Result<Option<String>, StoreError> {
  let Some(id) = sealed_by(head) else {
    return Ok(None);
  };
  let start = store.get_range(key, at_rest::header_len(id)).await?;
  if !at_rest::header_names(&start, id) {
    return Ok(None);
  }
  let stored = head.content_length.unwrap_or(0);
  if at_rest::plain_len(id, stored).is_none() {
    return Err(StoreError::Corrupt(format!(
      "sealed object has an invalid size {stored}"
    )));
  }
  Ok(Some(id.to_string()))
}

impl Migration {
  /// `listed_ms` is the LastModified the listing gave: it has milliseconds,
  /// where a HEAD has seconds.
  pub(crate) async fn object(&self, key: &str, listed_ms: Option<i64>) -> Outcome {
    let mut attempt = 0;
    loop {
      attempt += 1;
      match self.try_object(key, listed_ms).await {
        Ok(outcome) => return outcome,
        Err(StoreError::NotFound) => return Outcome::Changed,
        Err(e) if precondition_failed(&e) => return Outcome::Changed,
        Err(e) if !transient(&e) || attempt >= ATTEMPTS => return Outcome::Failed(e.to_string()),
        Err(_) => tokio::time::sleep(backoff(attempt)).await,
      }
    }
  }

  async fn try_object(&self, key: &str, listed_ms: Option<i64>) -> Result<Outcome, StoreError> {
    let head = self.store.head_object(key).await?;
    let kid = sealed_kid(self.store.as_ref(), key, &head).await?;
    let current = self.keyring.current().id();
    let stored = head.content_length.unwrap_or(0);
    let plain = match &kid {
      Some(id) => at_rest::plain_len(id, stored).unwrap_or(0),
      None => stored,
    };
    let (seal, done) = match (self.direction, kid.as_deref()) {
      (Direction::Seal, Some(id)) if id == current => return Ok(Outcome::Current),
      (Direction::Seal, Some(_)) => (true, Outcome::Rotated(plain)),
      (Direction::Seal, None) => (true, Outcome::Sealed(plain)),
      (Direction::Unseal, None) => return Ok(Outcome::Current),
      (Direction::Unseal, Some(_)) => (false, Outcome::Unsealed(plain)),
    };
    if self.dry_run {
      return Ok(done);
    }
    let etag = head
      .etag
      .clone()
      .ok_or_else(|| StoreError::Transport("the store gave no ETag".to_string()))?;
    let download = self.store.get_object(key).await?;
    if download.head.etag.as_deref() != Some(etag.as_str()) {
      return Ok(Outcome::Changed);
    }
    let mut body = throttled(download.body, self.limit.clone());
    if kid.is_some() {
      body = at_rest::open_stream(self.keyring.clone(), body);
    }
    let mut metadata: Vec<(String, String)> = head
      .metadata
      .iter()
      .filter(|(name, _)| name != MARKER && name != ORIGINAL_MTIME)
      .cloned()
      .collect();
    let length = if seal {
      body = at_rest::seal_stream(&self.keyring, body);
      metadata.push((MARKER.to_string(), self.keyring.marker()));
      at_rest::sealed_len(current, plain)
    } else {
      plain
    };
    if let Some(ms) = original_mtime(&head)
      .or(listed_ms)
      .or(head.last_modified_ms)
    {
      metadata.push((ORIGINAL_MTIME.to_string(), ms.to_string()));
    }
    let upload = Upload {
      length,
      content_type: head.content_type.as_deref(),
      metadata: &metadata,
      if_match: None,
    };
    if self.conditional {
      self
        .store
        .put_object_stream(
          key,
          body,
          Upload {
            if_match: Some(&etag),
            ..upload
          },
        )
        .await?;
      return Ok(done);
    }
    let tmp = format!("{TMP_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let placed = async {
      self.store.put_object_stream(&tmp, body, upload).await?;
      if self.store.head_object(key).await?.etag.as_deref() != Some(etag.as_str()) {
        return Ok(None);
      }
      let copied = self
        .store
        .copy_object_with(&tmp, key, CopySpec::default())
        .await?;
      Ok::<_, StoreError>(Some(copied.version_id))
    }
    .await;
    let _ = purge(self.store.as_ref(), &tmp).await;
    let Some(ours) = placed? else {
      return Ok(Outcome::Changed);
    };
    // From here the copy is in place: an error must not send the object
    // back to the HEAD above, which would take our copy for current and
    // leave a device's version under it.
    let settle = Settle {
      read: head.version_id.clone(),
      ours,
    };
    Ok(match self.settle(key, &settle).await {
      Ok(true) => Outcome::Changed,
      Ok(false) => done,
      Err(reason) => Outcome::Unsettled { settle, reason },
    })
  }

  /// `settle_once`, tried again on a transient failure.
  pub(crate) async fn settle(&self, key: &str, settle: &Settle) -> Result<bool, String> {
    let mut attempt = 0;
    loop {
      attempt += 1;
      match self.settle_once(key, settle).await {
        Ok(restored) => return Ok(restored),
        Err(SettleError::Store(e)) if transient(&e) && attempt < ATTEMPTS => {
          tokio::time::sleep(backoff(attempt)).await;
        }
        Err(e) => return Err(e.to_string()),
      }
    }
  }

  /// After the copy: a version made between the read and the copy (a
  /// device's write or delete) is put back as the current one, and again for
  /// a version made while that was put back, until the history holds still.
  /// `true` when one was. A bucket without versions has nothing to settle.
  async fn settle_once(&self, key: &str, settle: &Settle) -> Result<bool, SettleError> {
    let (mut read, mut ours) = (settle.read.clone(), settle.ours.clone());
    let mut restored = false;
    for _ in 0..SETTLE_ROUNDS {
      let Some(history) = versions_of(self.store.as_ref(), key).await? else {
        return Ok(restored);
      };
      let (Some(read_id), Some(ours_id)) = (read.as_deref(), ours.as_deref()) else {
        return Err(SettleError::Unknown(
          "the bucket keeps versions but gave no version id",
        ));
      };
      let Some(at_ours) = history.iter().position(|v| v.version_id == ours_id) else {
        return Err(SettleError::Unknown("our version is not listed"));
      };
      let at_read = history
        .iter()
        .position(|v| v.version_id == read_id)
        .unwrap_or(history.len());
      // Newest first: anything before ours came after it and stays current.
      if at_ours != 0 || at_read <= at_ours + 1 {
        return Ok(restored);
      }
      let lost = &history[at_ours + 1];
      let put_back = if lost.delete_marker {
        let marker = self.store.delete_object(key).await?;
        log::warn(
          CONTEXT,
          &format!("Delete made during the rewrite put back key={key}"),
        );
        marker
      } else {
        let copied = self
          .store
          .copy_object_with(
            key,
            key,
            CopySpec {
              source_version: Some(&lost.version_id),
              ..CopySpec::default()
            },
          )
          .await?;
        log::warn(
          CONTEXT,
          &format!("Write made during the rewrite put back key={key}"),
        );
        copied.version_id
      };
      restored = true;
      // Next round: a version between this put-back and ours came while it
      // was being put back.
      read = ours;
      ours = put_back;
    }
    Err(SettleError::Unknown("the versions kept changing"))
  }
}

/// The versions a rewrite read and wrote, to settle it later if it could
/// not be settled at once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settle {
  pub read: Option<String>,
  pub ours: Option<String>,
}

enum SettleError {
  /// Storage failed; trying again may help.
  Store(StoreError),
  /// Needs a person or a later pass.
  Unknown(&'static str),
}

impl From<StoreError> for SettleError {
  fn from(e: StoreError) -> Self {
    SettleError::Store(e)
  }
}

impl std::fmt::Display for SettleError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      SettleError::Store(e) => write!(f, "{e}"),
      SettleError::Unknown(why) => write!(f, "{why}"),
    }
  }
}

fn read_checkpoint(path: &PathBuf) -> Result<Option<String>, String> {
  match std::fs::read_to_string(path) {
    Ok(text) => Ok(Some(text.trim_end_matches('\n').to_string()).filter(|k| !k.is_empty())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Cannot read checkpoint {}: {e}", path.display())),
  }
}

fn write_checkpoint(path: &PathBuf, key: &str) -> Result<(), String> {
  let tmp = path.with_extension("tmp");
  std::fs::write(&tmp, format!("{key}\n"))
    .and_then(|()| std::fs::rename(&tmp, path))
    .map_err(|e| format!("Cannot write checkpoint {}: {e}", path.display()))
}

/// Every key under `prefix`.
pub(crate) async fn list_keys(store: &dyn Store, prefix: &str) -> Result<Vec<String>, String> {
  let mut out = Vec::new();
  let mut token = None;
  loop {
    let page = store
      .list_objects_v2(&ListInput {
        prefix: Some(prefix.to_string()),
        max_keys: Some("1000".to_string()),
        continuation_token: token.clone(),
        ..ListInput::default()
      })
      .await
      .map_err(|e| format!("Listing failed: {e}"))?;
    out.extend(page.contents.into_iter().map(|object| object.key));
    token = page.next_continuation_token.filter(|_| page.is_truncated);
    if token.is_none() {
      return Ok(out);
    }
  }
}

fn summary(report: &Report, elapsed: Duration) -> String {
  format!(
    "scanned={} current={} sealed={} sealed_bytes={} rotated={} rotated_bytes={} unsealed={} unsealed_bytes={} changed={} failed={} elapsed_ms={}",
    report.scanned,
    report.current,
    report.sealed,
    report.sealed_bytes,
    report.rotated,
    report.rotated_bytes,
    report.unsealed,
    report.unsealed_bytes,
    report.changed,
    report.failed,
    elapsed.as_millis()
  )
}

/// Walks the bucket in key order. `Err` stops the walk: a listing or the
/// checkpoint failed. Objects that fail are counted, and keep the checkpoint
/// from moving past them.
pub async fn migrate(
  store: Arc<dyn Store>,
  keyring: Arc<Keyring>,
  options: &Options,
) -> Result<Report, String> {
  let started = Instant::now();
  let direction = if options.unseal {
    Direction::Unseal
  } else {
    Direction::Seal
  };
  match (direction, keyring.unsealing()) {
    (Direction::Unseal, false) => {
      return Err(
        "--unseal needs SYNC_AT_REST_KEY=unseal,<keys>, and the server running with it, so it stops sealing new writes"
          .to_string(),
      );
    }
    (Direction::Seal, true) => {
      return Err("SYNC_AT_REST_KEY has `unseal`: sealing is off. Use --unseal.".to_string());
    }
    _ => {}
  }
  let conditional = if options.dry_run {
    false
  } else {
    honors_if_match(store.as_ref())
      .await
      .map_err(|e| format!("Cannot write to the bucket: {e}"))?
  };
  let start_after = match &options.checkpoint {
    Some(path) => read_checkpoint(path)?,
    None => None,
  };
  log::log(
    CONTEXT,
    &format!(
      "Migration started direction={} key={} dry_run={} conditional_put={conditional} concurrency={} max_bytes_per_sec={} resume_after={}",
      if options.unseal { "unseal" } else { "seal" },
      keyring.current().id(),
      options.dry_run,
      options.concurrency,
      options.bytes_per_sec.unwrap_or(0),
      start_after.as_deref().unwrap_or("-"),
    ),
  );
  let state_store = crate::sealed_store::SealedStore::new(store.clone(), keyring.clone());
  let migration = Migration {
    store: store.clone(),
    keyring,
    direction,
    dry_run: options.dry_run,
    conditional,
    limit: options.bytes_per_sec.map(|per_sec| {
      Arc::new(RateLimit {
        per_sec,
        state: Mutex::new((Instant::now(), 0)),
      })
    }),
  };
  let mut report = Report::default();
  // Rewrites an earlier run or the sealer left unsettled are settled first.
  let (retried, mut unsettled) = if options.dry_run {
    (Vec::new(), Vec::new())
  } else {
    let state = read_state(&state_store)
      .await
      .map_err(|e| format!("Sealer state unreadable: {e}"))?;
    let open: Vec<Failed> = state
      .failed
      .into_iter()
      .filter(|f| f.settle.is_some())
      .collect();
    let retried: Vec<String> = open.iter().map(|f| f.key.clone()).collect();
    (retried, retry_failed(&migration, &open).await)
  };
  report.failed += unsettled.len() as u64;
  let mut token: Option<String> = None;
  let mut last_progress = Instant::now();
  let mut checkpoint_held = false;
  loop {
    let page = store
      .list_objects_v2(&ListInput {
        prefix: options.prefix.clone(),
        max_keys: Some("1000".to_string()),
        continuation_token: token.clone(),
        delimiter: None,
        start_after: if token.is_none() {
          start_after.clone()
        } else {
          None
        },
      })
      .await
      .map_err(|e| format!("Listing failed: {e}"))?;
    let objects: Vec<(String, Option<i64>)> = page
      .contents
      .into_iter()
      .map(|object| (object.key, object.last_modified_ms))
      .filter(|(key, _)| !key.starts_with(crate::sealer::INTERNAL_ROOT))
      .collect();
    let keys: Vec<&String> = objects.iter().map(|(key, _)| key).collect();
    let outcomes: Vec<(String, Outcome)> = futures_util::stream::iter(objects.iter())
      .map(|(key, listed)| async { (key.clone(), migration.object(key, *listed).await) })
      .buffer_unordered(options.concurrency)
      .collect()
      .await;
    for (key, outcome) in outcomes {
      report.scanned += 1;
      match outcome {
        Outcome::Current => report.current += 1,
        Outcome::Sealed(bytes) => {
          report.sealed += 1;
          report.sealed_bytes += bytes;
        }
        Outcome::Rotated(bytes) => {
          report.rotated += 1;
          report.rotated_bytes += bytes;
        }
        Outcome::Unsealed(bytes) => {
          report.unsealed += 1;
          report.unsealed_bytes += bytes;
        }
        Outcome::Changed => report.changed += 1,
        Outcome::Unsettled { settle, reason } => {
          report.failed += 1;
          checkpoint_held = true;
          log::warn(
            CONTEXT,
            &format!("Rewrite not settled key={key} err=\"{reason}\""),
          );
          unsettled.push(Failure {
            key,
            reason,
            settle: Some(settle),
          });
        }
        Outcome::Failed(err) => {
          report.failed += 1;
          checkpoint_held = true;
          log::warn(
            CONTEXT,
            &format!("Object not migrated key={key} err=\"{err}\""),
          );
        }
      }
    }
    if let (Some(path), Some(last), false, false) = (
      &options.checkpoint,
      keys.last(),
      checkpoint_held,
      options.dry_run,
    ) {
      write_checkpoint(path, last)?;
    }
    token = page.next_continuation_token.filter(|_| page.is_truncated);
    if token.is_none() {
      break;
    }
    if last_progress.elapsed() >= PROGRESS_EVERY {
      last_progress = Instant::now();
      log::log(
        CONTEXT,
        &format!(
          "Migration progress {} last_key={}",
          summary(&report, started.elapsed()),
          keys.last().map_or("-", |k| k.as_str())
        ),
      );
    }
  }
  if !retried.is_empty() || !unsettled.is_empty() {
    let mut state = read_state(&state_store)
      .await
      .map_err(|e| format!("Sealer state unreadable: {e}"))?;
    state.note(&retried, unsettled, time::now_ms());
    save_state(&state_store, &state)
      .await
      .map_err(|e| format!("Sealer state not saved: {e}"))?;
  }
  // A whole bucket unsealed: this server's own objects (sealed records and
  // state) go too, so nothing sealed is left when the key is removed.
  if options.unseal && !options.dry_run && options.prefix.is_none() && report.failed == 0 {
    let internal = list_keys(store.as_ref(), crate::sealer::INTERNAL_ROOT).await?;
    for key in &internal {
      purge(store.as_ref(), key)
        .await
        .map_err(|e| format!("Internal object not removed key={key} err={e}"))?;
    }
    log::log(
      CONTEXT,
      &format!("Internal objects removed count={}", internal.len()),
    );
  }
  let line = format!(
    "{} {}",
    if options.dry_run {
      "Migration dry run done"
    } else {
      "Migration done"
    },
    summary(&report, started.elapsed())
  );
  if report.failed > 0 {
    log::warn(CONTEXT, &line);
  } else {
    log::log(CONTEXT, &line);
  }
  Ok(report)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::memory_store::MemoryStore;
  use crate::sealed_store::SealedStore;

  const K1: &str = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const K2: &str = "k2:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

  fn options() -> Options {
    Options {
      concurrency: 3,
      ..Options::default()
    }
  }

  fn meta(value: &str) -> Vec<(String, String)> {
    vec![("updated-at".to_string(), value.to_string())]
  }

  #[tokio::test]
  async fn seals_plaintext_keeps_metadata_and_is_idempotent() {
    let raw = Arc::new(MemoryStore::default());
    let big: Vec<u8> = (0..at_rest::FRAME * 2 + 9).map(|i| i as u8).collect();
    raw.insert(
      "users/u/profiles/p/files/a",
      big.clone(),
      meta("5"),
      Some("image/png".into()),
    );
    raw.insert("users/u/proxies/x.json", b"{}".to_vec(), Vec::new(), None);
    raw.insert("users/u/empty", Vec::new(), Vec::new(), None);
    let keyring = Arc::new(Keyring::parse(K1).unwrap());

    let dry = migrate(
      raw.clone(),
      keyring.clone(),
      &Options {
        dry_run: true,
        ..options()
      },
    )
    .await
    .unwrap();
    assert_eq!(
      (dry.scanned, dry.sealed, dry.sealed_bytes),
      (3, 3, big.len() as u64 + 2)
    );
    assert_eq!(raw.raw("users/u/proxies/x.json").unwrap().body, b"{}");

    let report = migrate(raw.clone(), keyring.clone(), &options())
      .await
      .unwrap();
    assert_eq!((report.sealed, report.failed, report.changed), (3, 0, 0));
    let sealed = crate::served_store(raw.clone(), Some(&keyring));
    let head = sealed
      .head_object("users/u/profiles/p/files/a")
      .await
      .unwrap();
    assert_eq!(head.metadata, meta("5"));
    assert_eq!(head.content_type.as_deref(), Some("image/png"));
    assert_eq!(head.content_length, Some(big.len() as u64));
    let body = sealed
      .get_object("users/u/profiles/p/files/a")
      .await
      .unwrap()
      .body;
    assert_eq!(crate::store::collect(body).await.unwrap(), big);
    assert_eq!(sealed.get_object_text("users/u/empty").await.unwrap(), "");
    assert!(raw.keys().iter().all(|k| !k.starts_with(TMP_PREFIX)));

    let again = migrate(raw.clone(), keyring, &options()).await.unwrap();
    assert_eq!((again.current, again.sealed), (3, 0));
  }

  #[tokio::test]
  async fn rotates_objects_under_an_older_key() {
    let raw = Arc::new(MemoryStore::default());
    let old = Arc::new(Keyring::parse(K1).unwrap());
    SealedStore::new(raw.clone(), old)
      .put_object("a", b"hello".to_vec(), "text/plain", &meta("1"))
      .await
      .unwrap();
    let rotated = Arc::new(Keyring::parse(&format!("{K2},{K1}")).unwrap());
    let report = migrate(raw.clone(), rotated.clone(), &options())
      .await
      .unwrap();
    assert_eq!((report.rotated, report.rotated_bytes), (1, 5));
    let only_new = Arc::new(Keyring::parse(K2).unwrap());
    let store = crate::served_store(raw.clone(), Some(&only_new));
    assert_eq!(store.get_object_text("a").await.unwrap(), "hello");
    assert_eq!(store.head_object("a").await.unwrap().metadata, meta("1"));
  }

  #[tokio::test]
  async fn resumes_after_the_checkpoint() {
    let raw = Arc::new(MemoryStore::default());
    for i in 0..2500 {
      raw.insert(&format!("k{i:05}"), b"x".to_vec(), Vec::new(), None);
    }
    let keyring = Arc::new(Keyring::parse(K1).unwrap());
    let dir = std::env::temp_dir().join(format!("donut-migrate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("checkpoint");
    std::fs::write(&path, "k01999\n").unwrap();
    let report = migrate(
      raw.clone(),
      keyring,
      &Options {
        checkpoint: Some(path.clone()),
        ..options()
      },
    )
    .await
    .unwrap();
    assert_eq!(report.sealed, 500);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "k02499\n");
    assert_eq!(raw.raw("k00000").unwrap().body, b"x");
    std::fs::remove_dir_all(dir).unwrap();
  }

  #[tokio::test]
  async fn the_probe_sees_whether_if_match_is_honored() {
    // MemoryStore refuses a PUT whose If-Match names another ETag.
    let raw = Arc::new(MemoryStore::default());
    assert!(honors_if_match(raw.as_ref()).await.unwrap());
    assert!(raw.keys().is_empty(), "the probe cleans up");
  }

  fn keyring(value: &str) -> Arc<Keyring> {
    Arc::new(Keyring::parse(value).unwrap())
  }

  fn unsealing() -> Options {
    Options {
      unseal: true,
      ..options()
    }
  }

  /// No temporary object, and none of its versions, is left.
  fn no_temporary_left(raw: &MemoryStore) {
    let objects = raw.objects.lock().unwrap();
    assert!(
      objects.keys().all(|k| !k.starts_with(TMP_PREFIX)),
      "{:?}",
      objects.keys()
    );
  }

  #[tokio::test]
  async fn seal_then_unseal_gives_back_the_plaintext_metadata_and_times() {
    let raw = Arc::new(MemoryStore::versioned());
    let big: Vec<u8> = (0..at_rest::FRAME * 2 + 9).map(|i| i as u8).collect();
    raw.insert("a", big.clone(), meta("5"), Some("image/png".into()));
    raw.insert("b", Vec::new(), Vec::new(), None);
    let listed = raw.raw("a").unwrap().modified_ms;

    let report = migrate(raw.clone(), keyring(K1), &options()).await.unwrap();
    assert_eq!(report.sealed, 2);
    raw.insert(
      ".donut-sync-at-rest/state.json",
      b"x".to_vec(),
      Vec::new(),
      None,
    );

    // Unsealing needs the server's unsealing state, and sealing refuses it.
    assert!(
      migrate(raw.clone(), keyring(K1), &unsealing())
        .await
        .is_err()
    );
    let unseal_keys = keyring(&format!("unseal,{K1}"));
    assert!(
      migrate(raw.clone(), unseal_keys.clone(), &options())
        .await
        .is_err()
    );

    let dry = migrate(
      raw.clone(),
      unseal_keys.clone(),
      &Options {
        dry_run: true,
        ..unsealing()
      },
    )
    .await
    .unwrap();
    assert_eq!((dry.unsealed, dry.unsealed_bytes), (2, big.len() as u64));
    let report = migrate(raw.clone(), unseal_keys.clone(), &unsealing())
      .await
      .unwrap();
    assert_eq!((report.unsealed, report.failed), (2, 0));
    let a = raw.raw("a").unwrap();
    assert_eq!(a.body, big);
    assert_eq!(a.content_type.as_deref(), Some("image/png"));
    assert!(a.metadata.iter().all(|(name, _)| name != MARKER));
    assert!(
      a.metadata
        .contains(&("updated-at".to_string(), "5".to_string()))
    );
    assert!(
      a.metadata
        .contains(&(ORIGINAL_MTIME.to_string(), listed.to_string()))
    );
    assert_eq!(raw.raw("b").unwrap().body, b"");
    assert!(
      raw
        .keys()
        .iter()
        .all(|k| !k.starts_with(crate::sealer::INTERNAL_ROOT))
    );
    no_temporary_left(&raw);

    // With the key gone, reads see plaintext at the time from before.
    let plain = crate::served_store(raw.clone(), None);
    assert_eq!(
      plain.head_object("a").await.unwrap().last_modified_ms,
      Some(listed)
    );
    let again = migrate(raw.clone(), unseal_keys, &unsealing())
      .await
      .unwrap();
    assert_eq!((again.current, again.unsealed), (2, 0));
  }

  #[tokio::test]
  async fn a_forged_marker_on_plaintext_is_not_taken_for_sealed() {
    let raw = Arc::new(MemoryStore::default());
    raw.insert(
      "a",
      b"plain".to_vec(),
      vec![(MARKER.into(), "1:k1".into())],
      None,
    );
    let report = migrate(raw.clone(), keyring(K1), &options()).await.unwrap();
    assert_eq!(report.sealed, 1);
    let store = crate::served_store(raw.clone(), Some(&keyring(K1)));
    assert_eq!(store.get_object_text("a").await.unwrap(), "plain");
  }

  /// A device writes or deletes `key` right before the rewrite's copy.
  fn race(raw: &MemoryStore, device: impl Fn(&MemoryStore) + Send + Sync + 'static) {
    let fired = std::sync::atomic::AtomicBool::new(false);
    *raw.copy_hook.lock().unwrap() = Some(Box::new(move |store, to| {
      if to == "k" && !fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
        device(store);
      }
    }));
  }

  async fn rewrite(raw: &Arc<MemoryStore>, keys: Arc<Keyring>, direction: Direction) -> Outcome {
    let mut migration = Migration::sealing(raw.clone(), keys, false);
    migration.direction = direction;
    migration.object("k", None).await
  }

  #[tokio::test]
  async fn a_write_or_delete_inside_the_copy_window_is_put_back() {
    for direction in [Direction::Seal, Direction::Unseal] {
      let (keys, setup) = match direction {
        Direction::Seal => (keyring(K1), None),
        Direction::Unseal => (keyring(&format!("unseal,{K1}")), Some(keyring(K1))),
      };
      let prepare = |raw: &Arc<MemoryStore>| {
        raw.insert("k", b"old".to_vec(), meta("1"), None);
        let raw = raw.clone();
        let setup = setup.clone();
        async move {
          if let Some(setup) = setup {
            migrate(raw, setup, &options()).await.unwrap();
          }
        }
      };

      let raw = Arc::new(MemoryStore::versioned());
      prepare(&raw).await;
      race(&raw, |store| {
        store.insert("k", b"device".to_vec(), meta("2"), None);
      });
      assert!(matches!(
        rewrite(&raw, keys.clone(), direction).await,
        Outcome::Changed
      ));
      let current = raw.raw("k").unwrap();
      assert_eq!(current.body, b"device", "{direction:?}");
      assert!(
        current
          .metadata
          .contains(&("updated-at".to_string(), "2".to_string()))
      );
      no_temporary_left(&raw);

      let raw = Arc::new(MemoryStore::versioned());
      prepare(&raw).await;
      race(&raw, |store| {
        store.remove("k");
      });
      assert!(matches!(
        rewrite(&raw, keys.clone(), direction).await,
        Outcome::Changed
      ));
      assert!(raw.raw("k").is_none(), "the delete stands ({direction:?})");
      no_temporary_left(&raw);
    }
  }

  #[tokio::test]
  async fn a_write_after_the_copy_stays_current() {
    let raw = Arc::new(MemoryStore::versioned());
    let read = raw.insert("k", b"old".to_vec(), Vec::new(), None);
    let migration = Migration::sealing(raw.clone(), keyring(K1), false);
    assert!(matches!(
      migration.object("k", None).await,
      Outcome::Sealed(3)
    ));
    let ours = raw.head_object("k").await.unwrap().version_id;
    raw.insert("k", b"later".to_vec(), Vec::new(), None);
    let settle = Settle {
      read: Some(read),
      ours,
    };
    assert!(!migration.settle("k", &settle).await.unwrap());
    assert_eq!(raw.raw("k").unwrap().body, b"later");
  }

  /// A store that keeps versions but names none, as no S3 store should.
  #[tokio::test]
  async fn missing_version_ids_are_recorded_not_ignored() {
    let raw = Arc::new(MemoryStore::versioned());
    raw.insert("k", b"old".to_vec(), Vec::new(), None);
    let migration = Migration::sealing(raw.clone(), keyring(K1), false);
    let settle = Settle {
      read: None,
      ours: None,
    };
    let reason = migration.settle("k", &settle).await.unwrap_err();
    assert!(reason.contains("no version id"), "{reason}");
  }

  /// Settle keeps putting back until the history holds still: here a third
  /// write lands while the first put-back is made.
  #[tokio::test]
  async fn a_write_during_the_put_back_is_put_back_too() {
    let raw = Arc::new(MemoryStore::versioned());
    raw.insert("k", b"old".to_vec(), Vec::new(), None);
    // The device writes inside the rewrite's copy, and again inside the
    // put-back's copy.
    let copies = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = copies.clone();
    *raw.copy_hook.lock().unwrap() = Some(Box::new(move |store, to| {
      if to != "k" {
        return;
      }
      match seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
        0 => {
          store.insert("k", b"first".to_vec(), Vec::new(), None);
        }
        1 => {
          store.insert("k", b"second".to_vec(), Vec::new(), None);
        }
        _ => {}
      }
    }));
    let migration = Migration::sealing(raw.clone(), keyring(K1), false);
    assert!(matches!(
      migration.object("k", None).await,
      Outcome::Changed
    ));
    assert_eq!(raw.raw("k").unwrap().body, b"second");
    assert_eq!(copies.load(std::sync::atomic::Ordering::SeqCst), 3);
  }

  /// The settle fails after the copy: the object is not rewritten again from
  /// a HEAD, and the ids are kept for a later pass, which settles it.
  #[tokio::test]
  async fn an_unsettled_rewrite_is_recorded_and_settled_later() {
    let raw = Arc::new(MemoryStore {
      ignores_if_match: true,
      ..MemoryStore::versioned()
    });
    raw.insert("k", b"old".to_vec(), Vec::new(), None);
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let failing = fail.clone();
    *raw.copy_hook.lock().unwrap() = Some(Box::new(move |store, to| {
      if to == "k" && failing.load(std::sync::atomic::Ordering::SeqCst) {
        store.insert("k", b"device".to_vec(), Vec::new(), None);
      }
    }));
    // Every put-back copy also races a device write, so the history never
    // holds still within SETTLE_ROUNDS.
    let keys = keyring(K1);
    let report = migrate(raw.clone(), keys.clone(), &options())
      .await
      .unwrap();
    assert_eq!(report.failed, 1);
    let state_store = crate::sealed_store::SealedStore::new(raw.clone(), keys.clone());
    let state = read_state(&state_store).await.unwrap();
    assert_eq!(state.failed.len(), 1);
    assert!(state.failed[0].settle.is_some());
    // A later run settles it without a new rewrite.
    fail.store(false, std::sync::atomic::Ordering::SeqCst);
    let report = migrate(raw.clone(), keys, &options()).await.unwrap();
    assert_eq!(report.failed, 0, "{report:?}");
    assert!(read_state(&state_store).await.unwrap().failed.is_empty());
    // The device's write stands, and this run sealed it.
    let served = crate::served_store(raw.clone(), Some(&keyring(K1)));
    assert_eq!(served.get_object_text("k").await.unwrap(), "device");
  }

  /// HEAD fails as B2 does in an incident, or refuses: a 500 is tried
  /// ATTEMPTS times with backoff, a 403 once.
  #[tokio::test(start_paused = true)]
  async fn storage_failures_are_retried_with_backoff_only_when_they_may_pass() {
    for (status, tries) in [(500, ATTEMPTS as usize), (503, ATTEMPTS as usize), (403, 1)] {
      let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
      let seen = calls.clone();
      let raw = Arc::new(MemoryStore {
        head_hook: Some(Box::new(move |_| {
          seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
          Err(StoreError::Service {
            status,
            code: "InternalError".to_string(),
            message: "internal incident".to_string(),
          })
        })),
        ..MemoryStore::default()
      });
      let migration = Migration::sealing(raw, keyring(K1), false);
      let started = tokio::time::Instant::now();
      assert!(matches!(
        migration.object("k", None).await,
        Outcome::Failed(_)
      ));
      assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        tries,
        "status {status}"
      );
      if tries > 1 {
        assert_eq!(started.elapsed(), Duration::from_secs(1 + 2 + 4 + 8 + 16));
      }
    }
  }

  #[test]
  fn arguments_parse() {
    let args: Vec<String> = ["--dry-run", "--prefix", "users/", "--max-mib-per-sec", "8"]
      .iter()
      .map(|s| s.to_string())
      .collect();
    let options = parse(&args).unwrap();
    assert!(options.dry_run);
    assert_eq!(options.prefix.as_deref(), Some("users/"));
    assert_eq!(options.bytes_per_sec, Some(8 * 1024 * 1024));
    assert_eq!(options.concurrency, 4);
    assert!(parse(&["--concurrency".to_string(), "0".to_string()]).is_err());
    assert!(parse(&["--bogus".to_string()]).is_err());
  }
}
