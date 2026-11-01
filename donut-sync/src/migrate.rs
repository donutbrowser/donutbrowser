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

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;

use crate::at_rest::{self, Keyring, MARKER};
use crate::config::Config;
use crate::log;
use crate::sealed_store::{ORIGINAL_MTIME, original_mtime, sealed_by};
use crate::store::{ByteStream, ListInput, Store, StoreError, Upload};

pub const COMMAND: &str = "migrate-at-rest";
const CONTEXT: &str = "Migrate";
/// Temporary sealed copies. No client prefix matches it.
pub const TMP_PREFIX: &str = ".donut-sync-at-rest-tmp/";
const PROGRESS_EVERY: Duration = Duration::from_secs(10);
/// Tries per object: storage has transient failures.
const ATTEMPTS: u32 = 3;

const USAGE: &str = "Usage: donut-sync migrate-at-rest [--dry-run] [--prefix P] [--concurrency N] [--max-mib-per-sec N] [--checkpoint FILE]

Seals every plaintext object in S3_BUCKET with the first key of SYNC_AT_REST_KEY,
and re-seals objects under its other keys. Safe to stop and run again.

  --dry-run            Count what would change; write nothing.
  --prefix P           Only keys under P.
  --concurrency N      Objects at a time (default 4).
  --max-mib-per-sec N  Read at most N MiB/s (default unlimited).
  --checkpoint FILE    Resume after the key in FILE, and keep it current.";

#[derive(Debug, Default, Clone)]
pub struct Options {
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
  /// Written or deleted by someone else meanwhile; left as they are.
  pub changed: u64,
  pub failed: u64,
}

enum Outcome {
  Current,
  Sealed(u64),
  Rotated(u64),
  Changed,
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

struct Migration {
  store: Arc<dyn Store>,
  keyring: Arc<Keyring>,
  dry_run: bool,
  conditional: bool,
  limit: Option<Arc<RateLimit>>,
}

fn precondition_failed(error: &StoreError) -> bool {
  matches!(error, StoreError::Service { status: 412, .. })
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
  let _ = store.delete_object(&probe).await;
  match outcome {
    Ok(()) => Ok(false),
    Err(e) if precondition_failed(&e) => Ok(true),
    // Some stores (Backblaze B2) refuse the header instead of honoring it.
    Err(StoreError::Service { .. }) => Ok(false),
    Err(e) => Err(e),
  }
}

impl Migration {
  /// `listed_ms` is the LastModified the listing gave: it has milliseconds,
  /// where a HEAD has seconds.
  async fn object(&self, key: &str, listed_ms: Option<i64>) -> Outcome {
    let mut attempt = 0;
    loop {
      attempt += 1;
      match self.try_object(key, listed_ms).await {
        Ok(outcome) => return outcome,
        Err(StoreError::NotFound) => return Outcome::Changed,
        Err(e) if precondition_failed(&e) => return Outcome::Changed,
        Err(e @ StoreError::Corrupt(_)) => return Outcome::Failed(e.to_string()),
        Err(e) if attempt >= ATTEMPTS => return Outcome::Failed(e.to_string()),
        Err(_) => tokio::time::sleep(Duration::from_millis(500 << attempt)).await,
      }
    }
  }

  async fn try_object(&self, key: &str, listed_ms: Option<i64>) -> Result<Outcome, StoreError> {
    let head = self.store.head_object(key).await?;
    let current = self.keyring.current().id();
    let old_key = match sealed_by(&head) {
      Some(id) if id == current => return Ok(Outcome::Current),
      Some(id) => Some(id.to_string()),
      None => None,
    };
    let stored = head.content_length.unwrap_or(0);
    let plain = match &old_key {
      Some(id) => at_rest::plain_len(id, stored).ok_or_else(|| {
        StoreError::Corrupt(format!("sealed object has an invalid size {stored}"))
      })?,
      None => stored,
    };
    let done = |plain| match old_key {
      Some(_) => Outcome::Rotated(plain),
      None => Outcome::Sealed(plain),
    };
    if self.dry_run {
      return Ok(done(plain));
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
    if old_key.is_some() {
      body = at_rest::open_stream(self.keyring.clone(), body);
    }
    let sealed = at_rest::seal_stream(&self.keyring, body);
    let mut metadata: Vec<(String, String)> = head
      .metadata
      .iter()
      .filter(|(name, _)| name != MARKER && name != ORIGINAL_MTIME)
      .cloned()
      .collect();
    metadata.push((MARKER.to_string(), self.keyring.marker()));
    if let Some(ms) = original_mtime(&head)
      .or(listed_ms)
      .or(head.last_modified_ms)
    {
      metadata.push((ORIGINAL_MTIME.to_string(), ms.to_string()));
    }
    let upload = Upload {
      length: at_rest::sealed_len(current, plain),
      content_type: head.content_type.as_deref(),
      metadata: &metadata,
      if_match: None,
    };
    if self.conditional {
      self
        .store
        .put_object_stream(
          key,
          sealed,
          Upload {
            if_match: Some(&etag),
            ..upload
          },
        )
        .await?;
      return Ok(done(plain));
    }
    let tmp = format!("{TMP_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let placed = async {
      self.store.put_object_stream(&tmp, sealed, upload).await?;
      if self.store.head_object(key).await?.etag.as_deref() != Some(etag.as_str()) {
        return Ok(false);
      }
      self.store.copy_object(&tmp, key).await?;
      Ok::<_, StoreError>(true)
    }
    .await;
    let _ = self.store.delete_object(&tmp).await;
    Ok(if placed? {
      done(plain)
    } else {
      Outcome::Changed
    })
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

fn summary(report: &Report, elapsed: Duration) -> String {
  format!(
    "scanned={} current={} sealed={} sealed_bytes={} rotated={} rotated_bytes={} changed={} failed={} elapsed_ms={}",
    report.scanned,
    report.current,
    report.sealed,
    report.sealed_bytes,
    report.rotated,
    report.rotated_bytes,
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
      "Migration started key={} dry_run={} conditional_put={conditional} concurrency={} max_bytes_per_sec={} resume_after={}",
      keyring.current().id(),
      options.dry_run,
      options.concurrency,
      options.bytes_per_sec.unwrap_or(0),
      start_after.as_deref().unwrap_or("-"),
    ),
  );
  let migration = Migration {
    store: store.clone(),
    keyring,
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
      .filter(|(key, _)| !key.starts_with(TMP_PREFIX))
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
        Outcome::Changed => report.changed += 1,
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
    let sealed = SealedStore::new(raw.clone(), keyring.clone());
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
    let store = SealedStore::new(raw.clone(), only_new);
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
