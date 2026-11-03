//! Whether a Wayfern profile's key file still opens its cookies, checked
//! before each launch.
//!
//! The browser drops every cookie its key cannot open, so a key file that
//! changed or went missing since the last launch logs a person out of every
//! site. The line this writes says which: the key file's state, whether it
//! changed since this device last launched the profile, and whether the
//! oldest and the newest encrypted cookie open with it. It never logs the key,
//! a hash of it, or a cookie.

use crate::profile_import::os_crypt;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyFile {
  Missing,
  Blank,
  Present(u64),
}

impl KeyFile {
  fn of(contents: Option<&[u8]>) -> Self {
    match contents {
      None => Self::Missing,
      Some(bytes) if bytes.iter().all(|byte| *byte == 0) => Self::Blank,
      Some(bytes) => Self::Present(bytes.len() as u64),
    }
  }

  fn label(self) -> &'static str {
    match self {
      Self::Missing => "missing",
      Self::Blank => "blank",
      Self::Present(_) => "present",
    }
  }

  fn bytes(self) -> u64 {
    match self {
      Self::Present(bytes) => bytes,
      _ => 0,
    }
  }
}

/// Whether the key file changed since the last launch on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyChange {
  /// No launch recorded yet.
  First,
  Same,
  Changed,
}

impl KeyChange {
  fn label(self) -> &'static str {
    match self {
      Self::First => "first",
      Self::Same => "no",
      Self::Changed => "yes",
    }
  }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CookieStore {
  pub cookies: u64,
  pub encrypted: u64,
  /// Encrypted rows the key file does not open, by their 3-byte tag.
  pub undecryptable: BTreeMap<String, u64>,
  /// `None` when there is no encrypted row.
  pub oldest_ok: Option<bool>,
  pub newest_ok: Option<bool>,
}

impl CookieStore {
  pub fn undecryptable_total(&self) -> u64 {
    self.undecryptable.values().sum()
  }
}

/// Whether `key` opens one stored `encrypted_value`. Only the cipher is
/// checked, not the value inside: a value that is not UTF-8 still opened.
fn row_opens(key: Option<&[u8]>, encrypted: &[u8]) -> bool {
  let Some(key) = key else {
    return false;
  };
  if encrypted.len() < 3 {
    return false;
  }
  let (tag, ciphertext) = encrypted.split_at(3);
  let Some(primary) = os_crypt::key_for_tag(key, tag) else {
    return false;
  };
  ciphertext.is_empty()
    || primary
      .with_fallbacks()
      .iter()
      .any(|candidate| candidate.decrypt(ciphertext).is_some())
}

fn tag_label(encrypted: &[u8]) -> String {
  match encrypted.get(..3) {
    Some(tag) if tag.iter().all(u8::is_ascii_alphanumeric) => {
      String::from_utf8_lossy(tag).into_owned()
    }
    _ => "other".to_string(),
  }
}

/// Read the cookie store at `cookies_path` and test every encrypted row
/// against `key`. `None` when the database does not open.
pub fn inspect_cookies(cookies_path: &Path, key: Option<&[u8]>) -> Option<CookieStore> {
  let conn =
    rusqlite::Connection::open_with_flags(cookies_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
      .ok()?;
  let mut store = CookieStore {
    cookies: conn
      .query_row("SELECT COUNT(*) FROM cookies", [], |row| {
        row.get::<_, i64>(0)
      })
      .ok()?
      .max(0) as u64,
    ..CookieStore::default()
  };
  let mut stmt = conn
    .prepare(
      "SELECT encrypted_value FROM cookies WHERE length(encrypted_value) > 0 ORDER BY creation_utc, rowid",
    )
    .ok()?;
  let mut rows = stmt.query([]).ok()?;
  let mut last_ok = None;
  while let Ok(Some(row)) = rows.next() {
    let encrypted: Vec<u8> = row.get(0).unwrap_or_default();
    let ok = row_opens(key, &encrypted);
    if !ok {
      *store
        .undecryptable
        .entry(tag_label(&encrypted))
        .or_default() += 1;
    }
    if store.oldest_ok.is_none() {
      store.oldest_ok = Some(ok);
    }
    last_ok = Some(ok);
    store.encrypted += 1;
  }
  store.newest_ok = last_ok;
  Some(store)
}

fn key_stamp(install_key: &[u8], contents: &[u8]) -> String {
  use ring::hmac;
  let derived = hmac::sign(
    &hmac::Key::new(hmac::HMAC_SHA256, install_key),
    b"donut cookie key stamp",
  );
  let tag = hmac::sign(
    &hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref()),
    contents,
  );
  tag
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}

/// Compare the key file with the stamp kept for `profile_id` in
/// `stamps_file`, and keep the new stamp. A missing key file keeps the old
/// stamp, so the key that comes back is compared with the one that was lost.
pub fn key_change(
  stamps_file: &Path,
  install_key: &[u8],
  profile_id: &str,
  contents: Option<&[u8]>,
) -> KeyChange {
  let mut stamps: BTreeMap<String, String> = std::fs::read(stamps_file)
    .ok()
    .and_then(|raw| serde_json::from_slice(&raw).ok())
    .unwrap_or_default();
  let current = contents
    .filter(|bytes| KeyFile::of(Some(bytes)) != KeyFile::Blank)
    .map(|bytes| key_stamp(install_key, bytes));
  let change = match (stamps.get(profile_id), &current) {
    (None, _) => KeyChange::First,
    (Some(old), Some(new)) if old == new => KeyChange::Same,
    _ => KeyChange::Changed,
  };
  if let Some(new) = current {
    if stamps.get(profile_id) != Some(&new) {
      stamps.insert(profile_id.to_string(), new);
      save_stamps(stamps_file, &stamps);
    }
  }
  change
}

/// Forget a deleted profile's stamp.
pub fn forget(profile_id: &str) {
  let path = stamps_file();
  let Ok(raw) = std::fs::read(&path) else {
    return;
  };
  let Ok(mut stamps) = serde_json::from_slice::<BTreeMap<String, String>>(&raw) else {
    return;
  };
  if stamps.remove(profile_id).is_some() {
    save_stamps(&path, &stamps);
  }
}

fn save_stamps(path: &Path, stamps: &BTreeMap<String, String>) {
  let Ok(json) = serde_json::to_vec(stamps) else {
    return;
  };
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let staging = path.with_extension("json.tmp");
  if std::fs::write(&staging, json).is_ok() && std::fs::rename(&staging, path).is_ok() {
    crate::app_dirs::restrict_to_owner(path);
  }
}

fn stamps_file() -> std::path::PathBuf {
  crate::app_dirs::settings_dir().join("cookie_key_stamps.json")
}

fn flag(value: Option<bool>) -> &'static str {
  match value {
    Some(true) => "true",
    Some(false) => "false",
    None => "-",
  }
}

fn tags(undecryptable: &BTreeMap<String, u64>) -> String {
  if undecryptable.is_empty() {
    return "-".to_string();
  }
  undecryptable
    .iter()
    .map(|(tag, count)| format!("{tag}:{count}"))
    .collect::<Vec<_>>()
    .join(",")
}

/// The line about a profile's key file and cookies, and its level.
pub fn report(
  profile_id: &str,
  key: KeyFile,
  change: KeyChange,
  store: Option<&CookieStore>,
) -> (log::Level, String) {
  let default = CookieStore::default();
  let store = store.unwrap_or(&default);
  let undecryptable = store.undecryptable_total();
  let level =
    if store.encrypted > 0 && (store.newest_ok == Some(false) || key != KeyFile::Present(32)) {
      log::Level::Error
    } else if change == KeyChange::Changed || undecryptable > 0 {
      log::Level::Warn
    } else {
      log::Level::Debug
    };
  (
    level,
    format!(
      "Cookie store before launch profile={profile_id} key={} key_bytes={} key_changed={} cookies={} encrypted={} undecryptable={undecryptable} undecryptable_tags={} oldest_ok={} newest_ok={}",
      key.label(),
      key.bytes(),
      change.label(),
      store.cookies,
      store.encrypted,
      tags(&store.undecryptable),
      flag(store.oldest_ok),
      flag(store.newest_ok),
    ),
  )
}

/// Check a Wayfern profile's key file and cookies before a launch and log
/// what was found. `profile_data_dir` is the browser's user-data dir.
pub fn log_before_launch(profile_id: &str, profile_data_dir: &Path) {
  let contents = std::fs::read(profile_data_dir.join(os_crypt::KEY_FILE_NAME)).ok();
  let key = KeyFile::of(contents.as_deref());
  let change = match crate::vault::install_key() {
    Ok(install_key) => key_change(
      &stamps_file(),
      &install_key,
      profile_id,
      contents.as_deref(),
    ),
    Err(_) => KeyChange::First,
  };
  let cookies_path = crate::cookie_manager::CookieManager::wayfern_cookie_path(profile_data_dir);
  let usable_key = contents.as_deref().filter(|_| key != KeyFile::Blank);
  let store = cookies_path
    .exists()
    .then(|| inspect_cookies(&cookies_path, usable_key))
    .flatten();
  let (level, line) = report(profile_id, key, change, store.as_ref());
  log::log!(level, "{line}");
}

#[cfg(test)]
mod tests {
  use super::*;

  fn seal(key: &[u8; 32], host: &str, value: &[u8]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut plain = Sha256::digest(host.as_bytes()).to_vec();
    plain.extend_from_slice(value);
    let mut sealed = b"v10".to_vec();
    sealed.extend(
      os_crypt::CryptoKey::Aes256Gcm(*key)
        .encrypt(&plain)
        .unwrap(),
    );
    sealed
  }

  fn cookie_db(path: &Path, rows: &[(i64, Vec<u8>)]) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn
      .execute_batch(
        "CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)",
      )
      .unwrap();
    for (created, encrypted) in rows {
      conn
        .execute(
          "INSERT INTO cookies VALUES (?1, 'example.com', 'n', '', ?2)",
          rusqlite::params![created, encrypted],
        )
        .unwrap();
    }
  }

  #[test]
  fn reports_the_oldest_and_newest_rows_separately() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("Cookies");
    let key = [7u8; 32];
    let other = [9u8; 32];
    // Inserted newest first, so rowid order differs from creation order.
    cookie_db(
      &db,
      &[
        (300, seal(&key, "example.com", b"new")),
        (100, seal(&other, "example.com", b"stale")),
        (200, seal(&key, "example.com", &[0xE9, 0xFF])),
        (250, b"v20garbage-bytes".to_vec()),
      ],
    );
    let store = inspect_cookies(&db, Some(&key)).unwrap();
    assert_eq!(store.cookies, 4);
    assert_eq!(store.encrypted, 4);
    assert_eq!(store.oldest_ok, Some(false));
    assert_eq!(store.newest_ok, Some(true));
    assert_eq!(
      store.undecryptable,
      BTreeMap::from([("v10".to_string(), 1), ("v20".to_string(), 1)])
    );
    let (level, line) = report("p", KeyFile::Present(32), KeyChange::Same, Some(&store));
    assert_eq!(level, log::Level::Warn);
    assert!(line
      .contains("undecryptable=2 undecryptable_tags=v10:1,v20:1 oldest_ok=false newest_ok=true"));
  }

  #[test]
  fn a_newest_row_that_does_not_open_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("Cookies");
    cookie_db(&db, &[(1, seal(&[1u8; 32], "a.test", b"x"))]);
    let store = inspect_cookies(&db, Some(&[2u8; 32])).unwrap();
    let (level, line) = report("p", KeyFile::Present(32), KeyChange::Changed, Some(&store));
    assert_eq!(level, log::Level::Error);
    assert!(line.contains("key_changed=yes"));
    assert!(line.contains("newest_ok=false"));
    let no_key = inspect_cookies(&db, None).unwrap();
    assert_eq!(no_key.undecryptable_total(), 1);
  }

  #[test]
  fn key_change_tracks_the_file_without_storing_it() {
    let dir = tempfile::tempdir().unwrap();
    let stamps = dir.path().join("stamps.json");
    let install = [3u8; 32];
    let key = [5u8; 32];
    assert_eq!(
      key_change(&stamps, &install, "p", Some(&key)),
      KeyChange::First
    );
    assert_eq!(
      key_change(&stamps, &install, "p", Some(&key)),
      KeyChange::Same
    );
    let raw = std::fs::read(&stamps).unwrap();
    assert!(!raw.windows(key.len()).any(|w| w == key));
    // A lost file is a change, and the old stamp stays to compare against.
    assert_eq!(key_change(&stamps, &install, "p", None), KeyChange::Changed);
    assert_eq!(
      key_change(&stamps, &install, "p", Some(&key)),
      KeyChange::Same
    );
    assert_eq!(
      key_change(&stamps, &install, "p", Some(&[6u8; 32])),
      KeyChange::Changed
    );
    assert_eq!(
      key_change(&stamps, &install, "q", Some(&key)),
      KeyChange::First
    );
  }

  #[test]
  fn a_healthy_store_logs_at_debug() {
    let store = CookieStore {
      cookies: 2,
      encrypted: 2,
      oldest_ok: Some(true),
      newest_ok: Some(true),
      ..CookieStore::default()
    };
    let (level, line) = report("p", KeyFile::Present(32), KeyChange::Same, Some(&store));
    assert_eq!(level, log::Level::Debug);
    assert!(line.contains("key=present key_bytes=32 key_changed=no"));
    assert!(line.contains("undecryptable_tags=-"));
  }
}
