//! A profile's recent sites, from its own Chromium `History` database: the
//! sites visited most in the last 14 days, with the title of each one's most
//! visited page. Read from a copy, so a running browser's lock never matters.
//! The list stays on this device, except inside the prompt of a task that runs
//! in the same profile, and only while the profile's switch is on.

use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const DAYS: u64 = 14;
const MAX_SITES: usize = 15;
const MAX_TITLE_CHARS: usize = 60;
/// A history this large is not copied for a prompt.
const MAX_COPY_BYTES: u64 = 256 * 1024 * 1024;
/// A list this fresh is used again.
const FRESH_FOR: Duration = Duration::from_secs(10 * 60);
/// Seconds from 1601-01-01, Chromium's epoch, to 1970-01-01.
const WINDOWS_EPOCH_OFFSET_SECS: u64 = 11_644_473_600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
  pub host: String,
  pub visits: u64,
  pub title: Option<String>,
}

fn host_of(url: &str) -> Option<String> {
  let parsed = url::Url::parse(url).ok()?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return None;
  }
  let host = parsed.host_str()?.to_ascii_lowercase();
  Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

fn cut(text: &str) -> String {
  let text = text.trim();
  if text.chars().count() <= MAX_TITLE_CHARS {
    return text.to_string();
  }
  let mut out: String = text.chars().take(MAX_TITLE_CHARS - 1).collect();
  out.push('…');
  out
}

/// The top sites of a `History` database since `since_unix_secs`.
pub fn read(db: &Path, since_unix_secs: u64) -> Result<Vec<Site>, rusqlite::Error> {
  let conn = Connection::open_with_flags(
    db,
    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
  )?;
  let since = (since_unix_secs + WINDOWS_EPOCH_OFFSET_SECS) as i64 * 1_000_000;
  let mut statement = conn.prepare(
    "SELECT urls.url, urls.title, COUNT(*) FROM visits JOIN urls ON urls.id = visits.url \
     WHERE visits.visit_time >= ?1 GROUP BY urls.id",
  )?;
  let rows = statement.query_map([since], |row| {
    Ok((
      row.get::<_, String>(0)?,
      row.get::<_, Option<String>>(1)?,
      row.get::<_, i64>(2)?,
    ))
  })?;
  // Per host: visits, and the title of its most visited page.
  let mut hosts: HashMap<String, (u64, u64, Option<String>)> = HashMap::new();
  for row in rows {
    let (url, title, count) = row?;
    let Some(host) = host_of(&url) else {
      continue;
    };
    let count = count.max(0) as u64;
    let entry = hosts.entry(host).or_insert((0, 0, None));
    entry.0 += count;
    let title = title.map(|t| cut(&t)).filter(|t| !t.is_empty());
    if count > entry.1 && title.is_some() {
      entry.1 = count;
      entry.2 = title;
    }
  }
  let mut sites: Vec<Site> = hosts
    .into_iter()
    .map(|(host, (visits, _, title))| Site {
      host,
      visits,
      title,
    })
    .collect();
  sites.sort_by(|a, b| b.visits.cmp(&a.visits).then_with(|| a.host.cmp(&b.host)));
  sites.truncate(MAX_SITES);
  Ok(sites)
}

/// Where a profile keeps its history.
fn history_file(user_data_dir: &Path) -> Option<PathBuf> {
  [
    user_data_dir.join("Default").join("History"),
    user_data_dir.join("History"),
  ]
  .into_iter()
  .find(|path| path.is_file())
}

/// Read from a copy in a temporary folder that goes away after.
fn read_copy(file: &Path, since: u64) -> Result<Vec<Site>, String> {
  let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
  if size > MAX_COPY_BYTES {
    return Err(format!("history too large bytes={size}"));
  }
  let dir = tempfile::Builder::new()
    .prefix("donut-history-")
    .tempdir()
    .map_err(|e| e.to_string())?;
  let copy = dir.path().join("History");
  std::fs::copy(file, &copy).map_err(|e| e.to_string())?;
  crate::app_dirs::restrict_to_owner(&copy);
  read(&copy, since).map_err(|e| e.to_string())
}

/// Each profile's sites, with when they were read.
type Cache = HashMap<String, (Instant, Vec<Site>)>;

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

/// The recent sites of a profile, or none when its history cannot be read.
pub fn recent_sites(profile: &crate::profile::BrowserProfile) -> Vec<Site> {
  let profile_id = profile.id.to_string();
  if let Some((at, sites)) = CACHE
    .lock()
    .ok()
    .and_then(|cache| cache.get(&profile_id).cloned())
  {
    if at.elapsed() < FRESH_FOR {
      return sites;
    }
  }
  let profiles_dir = crate::profile::ProfileManager::instance().get_profiles_dir();
  let user_data_dir = crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
  let Some(file) = history_file(&user_data_dir) else {
    return Vec::new();
  };
  let since = crate::proxy_manager::now_secs().saturating_sub(DAYS * 86_400);
  let started = Instant::now();
  match read_copy(&file, since) {
    Ok(sites) => {
      log::debug!(
        "Agent history read profile={profile_id} sites={} elapsed_ms={}",
        sites.len(),
        started.elapsed().as_millis()
      );
      if let Ok(mut cache) = CACHE.lock() {
        cache.insert(profile_id, (Instant::now(), sites.clone()));
      }
      sites
    }
    Err(e) => {
      log::warn!("Agent history unreadable profile={profile_id} err=\"{e}\"");
      Vec::new()
    }
  }
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  /// A `History` database with Chromium's own columns, and visits given as
  /// (url, title, unix seconds).
  pub fn fixture(path: &Path, visits: &[(&str, &str, u64)]) {
    let conn = Connection::open(path).unwrap();
    conn
      .execute_batch(
        "CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, \
         visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, \
         last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL); \
         CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, \
         from_visit INTEGER, transition INTEGER DEFAULT 0 NOT NULL);",
      )
      .unwrap();
    for (url, title, at) in visits {
      let time = (*at + WINDOWS_EPOCH_OFFSET_SECS) as i64 * 1_000_000;
      let id: Option<i64> = conn
        .query_row("SELECT id FROM urls WHERE url = ?1", [url], |row| {
          row.get(0)
        })
        .ok();
      let id = match id {
        Some(id) => id,
        None => {
          conn
            .execute(
              "INSERT INTO urls(url, title, last_visit_time) VALUES (?1, ?2, ?3)",
              rusqlite::params![url, title, time],
            )
            .unwrap();
          conn.last_insert_rowid()
        }
      };
      conn
        .execute(
          "INSERT INTO visits(url, visit_time) VALUES (?1, ?2)",
          rusqlite::params![id, time],
        )
        .unwrap();
    }
  }

  #[test]
  fn the_top_sites_of_the_last_days_with_their_best_title() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("History");
    let now = 2_000_000_000;
    let day = 86_400;
    let long_title = "A".repeat(200);
    fixture(
      &db,
      &[
        ("https://www.shop.example/orders", "Orders", now - day),
        ("https://www.shop.example/orders", "Orders", now - 2 * day),
        ("https://shop.example/cart", "Cart", now - day),
        ("https://mail.example/", &long_title, now - 3 * day),
        ("https://old.example/", "Old", now - 30 * day),
        ("chrome://settings/", "Settings", now - day),
        ("file:///etc/hosts", "hosts", now - day),
      ],
    );
    let sites = read(&db, now - DAYS * day).unwrap();
    assert_eq!(sites.len(), 2, "old visits and other schemes stay out");
    assert_eq!(sites[0].host, "shop.example");
    assert_eq!(sites[0].visits, 3, "www and bare are one site");
    assert_eq!(sites[0].title.as_deref(), Some("Orders"));
    assert_eq!(sites[1].host, "mail.example");
    assert_eq!(
      sites[1].title.as_deref().unwrap().chars().count(),
      MAX_TITLE_CHARS
    );
  }

  #[test]
  fn a_copy_is_read_and_a_missing_history_is_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let default = dir.path().join("Default");
    std::fs::create_dir_all(&default).unwrap();
    assert!(history_file(dir.path()).is_none());
    let now = crate::proxy_manager::now_secs();
    fixture(
      &default.join("History"),
      &[("https://shop.example/", "Shop", now - 60)],
    );
    let file = history_file(dir.path()).unwrap();
    let sites = read_copy(&file, now - 3_600).unwrap();
    assert_eq!(sites[0].host, "shop.example");
    let many: Vec<(String, u64)> = (0..40)
      .map(|i| (format!("https://s{i}.example/"), now - 60))
      .collect();
    let db = dir.path().join("Many");
    fixture(
      &db,
      &many
        .iter()
        .map(|(url, at)| (url.as_str(), "t", *at))
        .collect::<Vec<_>>(),
    );
    assert_eq!(read(&db, now - 3_600).unwrap().len(), MAX_SITES);
  }
}
