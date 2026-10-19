//! The tail of the app log for the in-app log viewer.
//!
//! The log plugin writes `<app name>.log` and renames it to
//! `<app name>_<date>.log` when it grows past its size limit. A read takes the
//! end of the current file, and the newest renamed one when the current file
//! alone has too few matching lines.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: usize = 2_000;
/// Read first from the end of a file; the rest only when too few lines match.
const FIRST_READ_BYTES: u64 = 512 * 1024;
/// More than a rotated file ever holds (the plugin rotates at 5 MB).
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
  Trace,
  Debug,
  Info,
  Warn,
  Error,
}

impl Level {
  fn parse(text: &str) -> Option<Self> {
    match text {
      "TRACE" => Some(Self::Trace),
      "DEBUG" => Some(Self::Debug),
      "INFO" => Some(Self::Info),
      "WARN" => Some(Self::Warn),
      "ERROR" => Some(Self::Error),
      _ => None,
    }
  }

  fn name(self) -> &'static str {
    match self {
      Self::Trace => "trace",
      Self::Debug => "debug",
      Self::Info => "info",
      Self::Warn => "warn",
      Self::Error => "error",
    }
  }
}

/// One log record. Lines that do not open a record belong to the one before.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LogLine {
  /// Stable across reads: the file and the byte offset the record starts at.
  pub key: String,
  pub time: String,
  pub level: &'static str,
  pub target: String,
  pub message: String,
}

#[derive(Debug, Default)]
struct Query {
  profile: Option<String>,
  min_level: Option<Level>,
  limit: usize,
}

impl Query {
  fn matches(&self, level: Level, message: &str) -> bool {
    self.min_level.is_none_or(|min| level >= min)
      && self
        .profile
        .as_deref()
        .is_none_or(|needle| message.contains(needle))
  }
}

/// `[time][target][LEVEL] message`, the shape `run_with_builder` writes.
fn parse_head(line: &str) -> Option<(&str, &str, Level, &str)> {
  let rest = line.strip_prefix('[')?;
  let (time, rest) = rest.split_once("][")?;
  let (target, rest) = rest.split_once("][")?;
  let (level, message) = rest.split_once(']')?;
  let level = Level::parse(level)?;
  Some((
    time,
    target,
    level,
    message.strip_prefix(' ').unwrap_or(message),
  ))
}

fn cap(mut message: String) -> String {
  if message.chars().count() > MAX_MESSAGE_CHARS {
    message = message.chars().take(MAX_MESSAGE_CHARS).collect();
    message.push('…');
  }
  message
}

/// The matching records of `text`, oldest first. `base` is the file offset of
/// `text`'s first byte; a partial first line is skipped when `partial`.
fn records(text: &str, base: u64, file_key: &str, partial: bool, query: &Query) -> Vec<LogLine> {
  let mut out = Vec::new();
  let mut current: Option<(LogLine, Level)> = None;
  let mut offset = 0usize;
  let mut skip_first = partial;
  let flush = |record: Option<(LogLine, Level)>, out: &mut Vec<LogLine>| {
    if let Some((mut line, level)) = record {
      if query.matches(level, &line.message) {
        // As written: the file names entities by id on purpose, and "Copy
        // logs" hands out the same text.
        line.message = cap(line.message);
        out.push(line);
      }
    }
  };
  for raw in text.split_inclusive('\n') {
    let start = offset;
    offset += raw.len();
    if std::mem::take(&mut skip_first) {
      continue;
    }
    let line = raw.trim_end_matches(['\n', '\r']);
    match parse_head(line) {
      Some((time, target, level, message)) => {
        flush(current.take(), &mut out);
        current = Some((
          LogLine {
            key: format!("{file_key}:{}", base + start as u64),
            time: time.to_string(),
            level: level.name(),
            target: target.to_string(),
            message: message.to_string(),
          },
          level,
        ));
      }
      None => {
        if let Some((record, _)) = current.as_mut() {
          if record.message.len() < MAX_MESSAGE_CHARS * 4 {
            record.message.push('\n');
            record.message.push_str(line);
          }
        }
      }
    }
  }
  flush(current.take(), &mut out);
  out
}

/// The last `bytes` of a file, with its starting offset.
fn read_end(path: &Path, bytes: u64) -> std::io::Result<(String, u64)> {
  let mut file = std::fs::File::open(path)?;
  let len = file.metadata()?.len();
  let start = len.saturating_sub(bytes.min(MAX_FILE_BYTES));
  file.seek(SeekFrom::Start(start))?;
  let mut raw = Vec::with_capacity((len - start) as usize);
  file.take(len - start).read_to_end(&mut raw)?;
  Ok((String::from_utf8_lossy(&raw).into_owned(), start))
}

/// The matching records at the end of one file, at most `limit`, and whether
/// the whole file was read.
fn tail_of(path: &Path, query: &Query) -> (Vec<LogLine>, bool) {
  let file_key = path
    .file_stem()
    .and_then(|stem| stem.to_str())
    .unwrap_or("log")
    .to_string();
  let mut want = FIRST_READ_BYTES;
  loop {
    let Ok((text, start)) = read_end(path, want) else {
      return (Vec::new(), true);
    };
    let whole = start == 0;
    let mut lines = records(&text, start, &file_key, !whole, query);
    if lines.len() >= query.limit || whole || want >= MAX_FILE_BYTES {
      let excess = lines.len().saturating_sub(query.limit);
      lines.drain(..excess);
      return (lines, whole);
    }
    want = MAX_FILE_BYTES;
  }
}

/// The current log file and the newest rotated one.
fn log_files(dir: &Path, name: &str) -> (PathBuf, Option<PathBuf>) {
  let current = dir.join(format!("{name}.log"));
  let prefix = format!("{name}_");
  let previous = std::fs::read_dir(dir)
    .ok()
    .into_iter()
    .flatten()
    .filter_map(Result::ok)
    .map(|entry| entry.path())
    .filter(|path| {
      path
        .file_name()
        .and_then(|file| file.to_str())
        .is_some_and(|file| file.starts_with(&prefix) && file.ends_with(".log"))
    })
    // The date in the name sorts as text.
    .max();
  (current, previous)
}

fn read_tail(dir: &Path, name: &str, query: &Query) -> Vec<LogLine> {
  let (current, previous) = log_files(dir, name);
  let (mut lines, whole) = tail_of(&current, query);
  if lines.len() < query.limit && whole {
    if let Some(previous) = previous {
      let (mut older, _) = tail_of(&previous, query);
      let room = query.limit - lines.len();
      let excess = older.len().saturating_sub(room);
      older.drain(..excess);
      older.append(&mut lines);
      lines = older;
    }
  }
  lines
}

fn query_from(profile_id: Option<String>, level: Option<String>, limit: Option<usize>) -> Query {
  Query {
    profile: profile_id
      .map(|id| id.trim().to_string())
      .filter(|id| !id.is_empty())
      .map(|id| format!("profile={id}")),
    min_level: match level.as_deref() {
      Some("warn") => Some(Level::Warn),
      Some("error") => Some(Level::Error),
      Some("info") => Some(Level::Info),
      _ => None,
    },
    limit: limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
  }
}

/// The newest records of the app log, oldest first: of one profile when
/// `profile_id` is given, at `level` or above, never more than `limit` (2000).
#[tauri::command]
pub async fn read_app_log(
  app_handle: tauri::AppHandle,
  profile_id: Option<String>,
  level: Option<String>,
  limit: Option<usize>,
) -> Result<Vec<LogLine>, String> {
  let dir = crate::app_dirs::log_dir(&app_handle);
  let query = query_from(profile_id, level, limit);
  tauri::async_runtime::spawn_blocking(move || read_tail(&dir, crate::app_dirs::app_name(), &query))
    .await
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))
}

#[cfg(test)]
mod tests {
  use super::*;

  const PROFILE: &str = "6d6e21a1-4829-4d2b-bc7f-1b25707b61e4";

  fn line(n: usize, level: &str, message: &str) -> String {
    format!(
      "[2026-10-08 17:53:{:02}.000][app][{level}] {message}\n",
      n % 60
    )
  }

  fn query(profile: Option<&str>, level: Option<&str>, limit: usize) -> Query {
    query_from(
      profile.map(str::to_string),
      level.map(str::to_string),
      Some(limit),
    )
  }

  #[test]
  fn a_record_keeps_its_continuation_lines_and_its_fields() {
    let text = format!(
      "{}  at frame one\n{}",
      line(1, "ERROR", "Panic"),
      line(2, "INFO", "Done")
    );
    let lines = records(&text, 0, "DonutBrowser", false, &query(None, None, 10));
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].level, "error");
    assert_eq!(lines[0].target, "app");
    assert_eq!(lines[0].time, "2026-10-08 17:53:01.000");
    assert_eq!(lines[0].message, "Panic\n  at frame one");
    assert_eq!(lines[0].key, "DonutBrowser:0");
    assert!(lines[1].key.starts_with("DonutBrowser:"));
  }

  #[test]
  fn levels_and_profiles_filter_and_a_partial_first_line_is_dropped() {
    let text = format!(
      "tail of a cut line\n{}{}{}",
      line(1, "INFO", &format!("Browser launched profile={PROFILE}")),
      line(2, "WARN", "Proxy slow profile=other"),
      line(3, "ERROR", &format!("Browser exited profile={PROFILE}"))
    );
    let all = records(&text, 100, "f", true, &query(None, None, 10));
    assert_eq!(all.len(), 3);
    let warn = records(&text, 100, "f", true, &query(None, Some("warn"), 10));
    assert_eq!(warn.len(), 2);
    let errors = records(&text, 100, "f", true, &query(None, Some("error"), 10));
    assert_eq!(errors.len(), 1);
    let profile = records(&text, 100, "f", true, &query(Some(PROFILE), None, 10));
    assert_eq!(profile.len(), 2);
    assert!(profile.iter().all(|l| l.message.contains(PROFILE)));
  }

  #[test]
  fn the_limit_is_capped_and_keeps_the_newest() {
    assert_eq!(query(None, None, 0).limit, 1);
    assert_eq!(query_from(None, None, Some(1_000_000)).limit, MAX_LIMIT);
    assert_eq!(query_from(None, None, None).limit, DEFAULT_LIMIT);

    let dir = tempfile::tempdir().unwrap();
    let text: String = (0..50)
      .map(|n| line(n, "INFO", &format!("n={n}")))
      .collect();
    std::fs::write(dir.path().join("DonutBrowser.log"), text).unwrap();
    let lines = read_tail(dir.path(), "DonutBrowser", &query(None, None, 5));
    let messages: Vec<_> = lines.iter().map(|l| l.message.as_str()).collect();
    assert_eq!(messages, ["n=45", "n=46", "n=47", "n=48", "n=49"]);
  }

  #[test]
  fn too_few_lines_reach_back_into_the_newest_rotated_file() {
    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, text: String| std::fs::write(dir.path().join(name), text).unwrap();
    write(
      "DonutBrowser_2026-10-01_10-00-00.log",
      line(1, "INFO", "oldest"),
    );
    write(
      "DonutBrowser_2026-10-07_10-00-00.log",
      format!(
        "{}{}",
        line(1, "INFO", "older"),
        line(2, "INFO", "previous")
      ),
    );
    write("DonutBrowser.log", line(3, "INFO", "current"));
    write("other.log", line(4, "INFO", "not ours"));

    let lines = read_tail(dir.path(), "DonutBrowser", &query(None, None, 2));
    let messages: Vec<_> = lines.iter().map(|l| l.message.as_str()).collect();
    assert_eq!(messages, ["previous", "current"]);

    let lines = read_tail(dir.path(), "DonutBrowser", &query(None, None, 10));
    assert_eq!(lines.len(), 3, "only the newest rotated file is read");
  }

  #[test]
  fn a_missing_log_reads_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    assert!(read_tail(dir.path(), "DonutBrowser", &query(None, None, 10)).is_empty());
  }

  #[test]
  fn a_tail_read_from_the_middle_of_a_large_file_starts_at_a_whole_record() {
    let dir = tempfile::tempdir().unwrap();
    let filler = "x".repeat(200);
    let text: String = (0..4_000)
      .map(|n| line(n, "INFO", &format!("n={n} {filler}")))
      .collect();
    assert!(text.len() as u64 > FIRST_READ_BYTES);
    std::fs::write(dir.path().join("DonutBrowser.log"), text).unwrap();
    let lines = read_tail(dir.path(), "DonutBrowser", &query(None, None, 2_000));
    assert_eq!(lines.len(), 2_000);
    assert!(lines.last().unwrap().message.starts_with("n=3999 "));
    assert!(lines.iter().all(|l| l.message.starts_with("n=")));
  }
}
