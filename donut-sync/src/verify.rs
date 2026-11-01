//! `donut-sync verify-at-rest`: reads the bucket and reports what is sealed,
//! under which key, and what is still plaintext, then opens a random sample of
//! sealed objects end to end. It writes nothing. Exit code 0 means every
//! object is sealed under a key the server holds and every sample opened.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;

use crate::at_rest::{self, Keyring, MARKER};
use crate::config::Config;
use crate::log;
use crate::sealed_store::{SealedStore, sealed_by};
use crate::store::{ListInput, Store, StoreError};
use crate::time;

pub const COMMAND: &str = "verify-at-rest";
const CONTEXT: &str = "Verify";
const PROGRESS_EVERY: Duration = Duration::from_secs(10);
/// Plaintext keys named in the log, so a few can be looked at.
const NAMED_PLAINTEXT: u64 = 20;

const USAGE: &str = "Usage: donut-sync verify-at-rest [--prefix P] [--sample N] [--concurrency N]

Reads S3_BUCKET and counts plaintext objects and objects sealed under each key
of SYNC_AT_REST_KEY, then decrypts N random sealed objects in full. Writes
nothing. Exits 0 only when nothing is plaintext and every sample decrypts.

  --prefix P       Only keys under P.
  --sample N       Sealed objects to decrypt (default 100).
  --concurrency N  HEAD requests at a time (default 8).";

#[derive(Debug, Clone)]
pub struct Options {
  pub prefix: Option<String>,
  pub sample: usize,
  pub concurrency: usize,
}

impl Default for Options {
  fn default() -> Self {
    Self {
      prefix: None,
      sample: 100,
      concurrency: 8,
    }
  }
}

fn parse(args: &[String]) -> Result<Options, String> {
  let mut options = Options::default();
  let mut args = args.iter();
  while let Some(arg) = args.next() {
    let value = args
      .next()
      .ok_or_else(|| format!("Unknown argument {arg}"))?;
    match arg.as_str() {
      "--prefix" => options.prefix = Some(value.clone()),
      "--sample" => {
        options.sample = value
          .parse()
          .map_err(|_| "--sample must be a whole number")?;
      }
      "--concurrency" => {
        options.concurrency = value
          .parse()
          .ok()
          .filter(|n| (1..=64).contains(n))
          .ok_or("--concurrency must be 1-64")?;
      }
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
  match verify(store, keyring, &options).await {
    Ok(report) if report.complete() => 0,
    Ok(_) => 1,
    Err(message) => {
      log::error(CONTEXT, &format!("Verify stopped err=\"{message}\""));
      1
    }
  }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Sealed {
  pub objects: u64,
  pub stored_bytes: u64,
  pub plain_bytes: u64,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Report {
  pub objects: u64,
  pub stored_bytes: u64,
  pub plaintext: u64,
  pub plaintext_bytes: u64,
  /// By key id, including ids the keyring does not hold.
  pub sealed: BTreeMap<String, Sealed>,
  /// Sealed under a key id the keyring does not hold.
  pub unknown_key: u64,
  /// A marker of another format version, or a size no sealed object has.
  pub invalid: u64,
  /// This server's own objects: records of direct uploads, and leftovers of
  /// an interrupted migration.
  pub internal: u64,
  /// Gone between the listing and the HEAD.
  pub vanished: u64,
  pub sampled: u64,
  pub sample_failed: u64,
  /// Marked as sealed, but the bytes are not: plaintext with a marker a
  /// device set itself. Counted as plaintext too.
  pub forged_marker: u64,
  /// Keys the background sealer could not seal (its state).
  pub sealer_failed: u64,
  /// Older versions kept by the bucket, with their bytes, and delete markers.
  /// `None` when the store keeps or lists no versions.
  pub noncurrent: Option<Noncurrent>,
  /// Verified for a rollback (`SYNC_AT_REST_KEY` has `unseal`).
  pub unsealing: bool,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Noncurrent {
  pub versions: u64,
  pub bytes: u64,
  pub delete_markers: u64,
}

impl Report {
  /// Sealing: nothing left in plaintext, and every sample opened. Unsealing:
  /// nothing sealed left, this server's own objects included, so the key can
  /// go.
  pub fn complete(&self) -> bool {
    if self.unsealing {
      return self.sealed.values().all(|s| s.objects == 0)
        && self.invalid == 0
        && self.internal == 0;
    }
    self.plaintext == 0
      && self.unknown_key == 0
      && self.invalid == 0
      && self.sample_failed == 0
      && self.sealer_failed == 0
  }

  fn line(&self) -> String {
    let mut line = format!(
      "objects={} stored_bytes={} plaintext={} plaintext_bytes={}",
      self.objects, self.stored_bytes, self.plaintext, self.plaintext_bytes
    );
    for (id, sealed) in &self.sealed {
      line.push_str(&format!(
        " sealed[{id}]={} sealed[{id}]_bytes={} sealed[{id}]_plain_bytes={}",
        sealed.objects, sealed.stored_bytes, sealed.plain_bytes
      ));
    }
    line.push_str(&format!(
      " unknown_key={} invalid={} forged_marker={} internal={} vanished={} sampled={} sample_failed={} sealer_failed={}",
      self.unknown_key,
      self.invalid,
      self.forged_marker,
      self.internal,
      self.vanished,
      self.sampled,
      self.sample_failed,
      self.sealer_failed
    ));
    match &self.noncurrent {
      Some(n) => line.push_str(&format!(
        " noncurrent_versions={} noncurrent_bytes={} delete_markers={}",
        n.versions, n.bytes, n.delete_markers
      )),
      None => line.push_str(" noncurrent_versions=unsupported"),
    }
    line
  }
}

type Classified = Result<(Kind, u64), StoreError>;

enum Kind {
  Plaintext,
  /// A marker over bytes that are not sealed.
  Forged,
  Sealed {
    id: String,
    plain: u64,
  },
  Invalid(String),
  Vanished,
}

async fn classify(store: &dyn Store, key: &str) -> Classified {
  let head = match store.head_object(key).await {
    Ok(head) => head,
    Err(StoreError::NotFound) => return Ok((Kind::Vanished, 0)),
    Err(e) => return Err(e),
  };
  let stored = head.content_length.unwrap_or(0);
  let kind = match (head.metadata_value(MARKER), sealed_by(&head)) {
    (None, _) => Kind::Plaintext,
    (Some(marker), None) => Kind::Invalid(format!("unknown marker \"{marker}\"")),
    (Some(_), Some(id)) => {
      let start = match store.get_range(key, at_rest::header_len(id)).await {
        Ok(start) => start,
        Err(StoreError::NotFound) => return Ok((Kind::Vanished, 0)),
        Err(e) => return Err(e),
      };
      match at_rest::plain_len(id, stored) {
        _ if !at_rest::header_names(&start, id) => Kind::Forged,
        Some(plain) => Kind::Sealed {
          id: id.to_string(),
          plain,
        },
        None => Kind::Invalid(format!("size {stored} fits no sealed object")),
      }
    }
  };
  Ok((kind, stored))
}

/// Downloads and opens the whole object; `Err` says why it does not open.
async fn open_fully(
  store: &dyn Store,
  keyring: &Arc<Keyring>,
  key: &str,
  plain: u64,
) -> Result<(), String> {
  let download = store.get_object(key).await.map_err(|e| e.to_string())?;
  let mut body = at_rest::open_stream(keyring.clone(), download.body);
  let mut read = 0u64;
  while let Some(chunk) = body.next().await {
    read += chunk.map_err(|e| e.to_string())?.len() as u64;
  }
  if read != plain {
    return Err(format!("opened {read} bytes, expected {plain}"));
  }
  Ok(())
}

pub async fn verify(
  store: Arc<dyn Store>,
  keyring: Arc<Keyring>,
  options: &Options,
) -> Result<Report, String> {
  let started = Instant::now();
  log::log(
    CONTEXT,
    &format!(
      "Verify started prefix={} sample={} concurrency={}",
      options.prefix.as_deref().unwrap_or("-"),
      options.sample,
      options.concurrency
    ),
  );
  let mut report = Report {
    unsealing: keyring.unsealing(),
    ..Report::default()
  };
  // A uniform sample of sealed objects under keys the keyring holds.
  let mut sample: Vec<(String, u64)> = Vec::new();
  let mut candidates = 0u64;
  let mut token: Option<String> = None;
  let mut last_progress = Instant::now();
  loop {
    let page = store
      .list_objects_v2(&ListInput {
        prefix: options.prefix.clone(),
        max_keys: Some("1000".to_string()),
        continuation_token: token.clone(),
        ..ListInput::default()
      })
      .await
      .map_err(|e| format!("Listing failed: {e}"))?;
    let (internal, keys): (Vec<String>, Vec<String>) = page
      .contents
      .into_iter()
      .map(|object| object.key)
      .partition(|key| key.starts_with(crate::sealer::INTERNAL_ROOT));
    report.internal += internal.len() as u64;
    let classified: Vec<(String, Classified)> = futures_util::stream::iter(keys)
      .map(|key| {
        let store = store.clone();
        async move {
          let kind = classify(store.as_ref(), &key).await;
          (key, kind)
        }
      })
      .buffer_unordered(options.concurrency)
      .collect()
      .await;
    for (key, result) in classified {
      let (kind, stored) = result.map_err(|e| format!("HEAD failed key={key} err=\"{e}\""))?;
      if !matches!(kind, Kind::Vanished) {
        report.objects += 1;
        report.stored_bytes += stored;
      }
      if matches!(kind, Kind::Forged) {
        report.forged_marker += 1;
        log::warn(
          CONTEXT,
          &format!("Marked as sealed but not sealed key={key}"),
        );
      }
      match kind {
        Kind::Plaintext | Kind::Forged => {
          report.plaintext += 1;
          report.plaintext_bytes += stored;
          if report.plaintext <= NAMED_PLAINTEXT {
            log::warn(
              CONTEXT,
              &format!("Plaintext object key={key} bytes={stored}"),
            );
          }
        }
        Kind::Sealed { id, plain } => {
          let held = keyring.holds(&id);
          let entry = report.sealed.entry(id.clone()).or_default();
          entry.objects += 1;
          entry.stored_bytes += stored;
          entry.plain_bytes += plain;
          if !held {
            report.unknown_key += 1;
            log::warn(
              CONTEXT,
              &format!("Object under a key not held key={key} kid={id}"),
            );
            continue;
          }
          candidates += 1;
          if sample.len() < options.sample {
            sample.push((key, plain));
          } else {
            let slot = rand::random_range(0..candidates) as usize;
            if slot < options.sample {
              sample[slot] = (key, plain);
            }
          }
        }
        Kind::Invalid(why) => {
          report.invalid += 1;
          log::warn(
            CONTEXT,
            &format!("Invalid sealed object key={key} err=\"{why}\""),
          );
        }
        Kind::Vanished => report.vanished += 1,
      }
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
          "Verify progress {} elapsed_ms={}",
          report.line(),
          started.elapsed().as_millis()
        ),
      );
    }
  }
  let opened: Vec<(String, Result<(), String>)> = futures_util::stream::iter(sample)
    .map(|(key, plain)| {
      let store = store.clone();
      let keyring = keyring.clone();
      async move {
        let result = open_fully(store.as_ref(), &keyring, &key, plain).await;
        (key, result)
      }
    })
    .buffer_unordered(options.concurrency)
    .collect()
    .await;
  for (key, result) in opened {
    report.sampled += 1;
    if let Err(e) = result {
      report.sample_failed += 1;
      log::warn(
        CONTEXT,
        &format!("Sample did not open key={key} err=\"{e}\""),
      );
    }
  }
  let sealed_store = SealedStore::new(store.clone(), keyring.clone());
  match crate::sealer::read_state(&sealed_store).await {
    Ok(state) => {
      report.sealer_failed = state.failed.len() as u64;
      for failed in state.failed.iter().take(NAMED_PLAINTEXT as usize) {
        log::warn(
          CONTEXT,
          &format!(
            "Sealer could not seal key={} since={} err=\"{}\"",
            failed.key,
            time::iso_from_ms(failed.at),
            failed.reason
          ),
        );
      }
    }
    Err(e) => return Err(format!("Sealer state unreadable: {e}")),
  }
  report.noncurrent = store
    .list_versions(options.prefix.as_deref().unwrap_or(""))
    .await
    .map_err(|e| format!("Versions not listed: {e}"))?
    .map(|versions| {
      let mut n = Noncurrent::default();
      for version in versions.iter().filter(|v| !v.is_latest || v.delete_marker) {
        if version.delete_marker {
          n.delete_markers += 1;
        } else {
          n.versions += 1;
          n.bytes += version.size;
        }
      }
      n
    });
  let line = format!(
    "Verify done complete={} {} elapsed_ms={}",
    report.complete(),
    report.line(),
    started.elapsed().as_millis()
  );
  if report.complete() {
    log::log(CONTEXT, &line);
  } else {
    log::warn(CONTEXT, &line);
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

  fn keyring(value: &str) -> Arc<Keyring> {
    Arc::new(Keyring::parse(value).unwrap())
  }

  #[tokio::test]
  async fn counts_by_key_and_proves_completion_after_migration() {
    let raw = Arc::new(MemoryStore::default());
    raw.set("a", "plain-a");
    raw.set("b", "plain-bb");
    SealedStore::new(raw.clone(), keyring(K2))
      .put_object("c", b"ccc".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    raw.set(&format!("{}left", crate::migrate::TMP_PREFIX), "x");
    let keys = keyring(&format!("{K1},{K2}"));

    let before = verify(raw.clone(), keys.clone(), &Options::default())
      .await
      .unwrap();
    assert!(!before.complete());
    assert_eq!(
      (before.objects, before.plaintext, before.plaintext_bytes),
      (3, 2, 15)
    );
    assert_eq!(before.sealed["k2"].objects, 1);
    assert_eq!(before.sealed["k2"].plain_bytes, 3);
    assert_eq!(
      (before.internal, before.sampled, before.sample_failed),
      (1, 1, 0)
    );

    crate::migrate::migrate(
      raw.clone(),
      keys.clone(),
      &crate::migrate::Options {
        concurrency: 2,
        ..Default::default()
      },
    )
    .await
    .unwrap();
    let after = verify(raw.clone(), keys, &Options::default())
      .await
      .unwrap();
    assert!(after.complete(), "{after:?}");
    assert_eq!(after.sealed["k1"].objects, 3);
    assert_eq!(after.sealed["k1"].plain_bytes, 18);
    assert_eq!(after.sampled, 3);
  }

  #[tokio::test]
  async fn a_damaged_sample_unknown_keys_and_bad_markers_fail_it() {
    let raw = Arc::new(MemoryStore::default());
    let keys = keyring(K1);
    SealedStore::new(raw.clone(), keys.clone())
      .put_object("good", b"hello".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    let mut damaged = raw.raw("good").unwrap();
    let last = damaged.body.len() - 1;
    damaged.body[last] ^= 1;
    raw.insert("bad", damaged.body, damaged.metadata, None);
    SealedStore::new(raw.clone(), keyring(K2))
      .put_object("other", b"x".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    raw.insert(
      "odd",
      b"short".to_vec(),
      vec![(MARKER.to_string(), "9:k1".to_string())],
      None,
    );
    let report = verify(raw, keys, &Options::default()).await.unwrap();
    assert!(!report.complete());
    assert_eq!(
      (report.plaintext, report.unknown_key, report.invalid),
      (0, 1, 1)
    );
    assert_eq!((report.sampled, report.sample_failed), (2, 1));
  }

  #[tokio::test]
  async fn the_sample_is_bounded() {
    let raw = Arc::new(MemoryStore::default());
    let keys = keyring(K1);
    let sealed = SealedStore::new(raw.clone(), keys.clone());
    for i in 0..50 {
      sealed
        .put_object(&format!("k{i}"), vec![1; i], "text/plain", &[])
        .await
        .unwrap();
    }
    let options = Options {
      sample: 5,
      ..Options::default()
    };
    let report = verify(raw, keys, &options).await.unwrap();
    assert!(report.complete());
    assert_eq!((report.objects, report.sampled), (50, 5));
  }

  #[tokio::test]
  async fn forged_markers_versions_and_sealer_failures_are_reported() {
    let raw = Arc::new(MemoryStore::versioned());
    let keys = keyring(K1);
    let sealed = SealedStore::new(raw.clone(), keys.clone());
    sealed
      .put_object("a", b"one".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    sealed
      .put_object("a", b"two".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    raw.set("gone", "x");
    raw.remove("gone");
    raw.insert(
      "forged",
      b"not sealed at all, but long enough to read a header from".to_vec(),
      vec![(MARKER.to_string(), "1:k1".to_string())],
      None,
    );
    let state = crate::sealer::State {
      backstop_since: Some(1),
      failed: vec![crate::sealer::Failed {
        key: "x".into(),
        reason: "r".into(),
        at: 1,
      }],
    };
    sealed
      .put_object(
        crate::sealer::STATE,
        serde_json::to_vec(&state).unwrap(),
        "application/json",
        &[],
      )
      .await
      .unwrap();
    let report = verify(raw, keys, &Options::default()).await.unwrap();
    assert!(!report.complete());
    assert_eq!((report.plaintext, report.forged_marker), (1, 1));
    assert_eq!(report.sealer_failed, 1);
    let n = report.noncurrent.unwrap();
    assert_eq!(
      (n.versions, n.delete_markers),
      (2, 1),
      "a's first version and gone's"
    );
  }

  #[tokio::test]
  async fn unsealing_is_complete_when_nothing_sealed_is_left() {
    let raw = Arc::new(MemoryStore::default());
    SealedStore::new(raw.clone(), keyring(K1))
      .put_object("a", b"x".to_vec(), "text/plain", &[])
      .await
      .unwrap();
    let unsealing = keyring(&format!("unseal,{K1}"));
    let before = verify(raw.clone(), unsealing.clone(), &Options::default())
      .await
      .unwrap();
    assert!(before.unsealing && !before.complete());
    crate::migrate::migrate(
      raw.clone(),
      unsealing.clone(),
      &crate::migrate::Options {
        unseal: true,
        concurrency: 2,
        ..Default::default()
      },
    )
    .await
    .unwrap();
    let after = verify(raw, unsealing, &Options::default()).await.unwrap();
    assert!(after.complete(), "{after:?}");
    assert_eq!((after.plaintext, after.internal), (1, 0));
    assert_eq!(after.noncurrent, None, "this bucket keeps no versions");
  }

  #[test]
  fn arguments_parse() {
    let args: Vec<String> = ["--prefix", "users/", "--sample", "0"]
      .iter()
      .map(|s| s.to_string())
      .collect();
    let options = parse(&args).unwrap();
    assert_eq!(options.prefix.as_deref(), Some("users/"));
    assert_eq!((options.sample, options.concurrency), (0, 8));
    assert!(parse(&["--dry-run".to_string()]).is_err());
  }
}
