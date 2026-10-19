//! Network capture for agents: what the pages of a profile running on this
//! computer request and receive, kept in memory while an agent asks for it.
//!
//! One browser-level socket attaches to every tab, and to every frame that runs
//! in a process of its own, and turns the Network domain on there. Nothing the
//! page can see changes. Nothing is written to disk or to the log, the values
//! of cookie and authorization headers are replaced, only text bodies are kept,
//! and nothing is recorded while the person has paused agents or taken over the
//! profile. The capture ends with the browser, and its data with it.

use crate::cdp_target::CdpConnection;
use crate::profile::BrowserProfile;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Requests kept per profile; the oldest go first.
const MAX_ENTRIES: usize = 2_000;
/// The largest response body kept.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// All bodies kept for one profile; the oldest go first.
const MAX_STORED_BODY_BYTES: usize = 32 * 1024 * 1024;
/// The longest request body kept.
const MAX_POST_DATA_BYTES: usize = 64 * 1024;
/// What Chromium keeps per tab for body reads. Its default is far larger than
/// the bodies kept here, and it holds that memory for as long as capture runs.
const BROWSER_BUFFER_BYTES: usize = 8 * 1024 * 1024;
/// How much of a URL a list shows.
const LIST_URL_CHARS: usize = 300;
/// Headers whose values are credentials.
const SECRET_HEADERS: [&str; 4] = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
];
const REDACTED: &str = "[redacted]";
/// How long `start` waits for the browser to accept the attach.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
/// The id of the browser-level attach command; the pump numbers the rest
/// after it.
const ATTACH_ID: u64 = 1;
/// Body fetches the pump waits for at once. A tab that closes never answers
/// its own, so the map is emptied when it passes this.
const MAX_PENDING_FETCHES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
  Pending,
  Done,
  Failed,
  Redirected,
  Incomplete,
}

impl State {
  fn name(self) -> &'static str {
    match self {
      Self::Pending => "pending",
      Self::Done => "done",
      Self::Failed => "failed",
      Self::Redirected => "redirected",
      Self::Incomplete => "incomplete",
    }
  }
}

#[derive(Debug, Clone, PartialEq)]
enum Body {
  /// The response has not finished loading.
  Waiting,
  /// Asked of the browser, not answered yet.
  Fetching,
  Kept(String),
  /// Why there is no body.
  Skipped(&'static str),
}

impl Body {
  fn summary(&self) -> &str {
    match self {
      Self::Waiting | Self::Fetching => "pending",
      Self::Kept(_) => "kept",
      Self::Skipped(reason) => reason,
    }
  }
}

#[derive(Debug, Clone)]
struct Entry {
  id: u64,
  session: String,
  request_id: String,
  tab: String,
  method: String,
  url: String,
  resource_type: String,
  request_headers: Map<String, Value>,
  post_data: Option<String>,
  post_data_truncated: bool,
  /// Unix milliseconds.
  started_at: f64,
  /// The browser's monotonic clock, in seconds.
  started: f64,
  status: Option<u64>,
  status_text: Option<String>,
  response_headers: Map<String, Value>,
  mime_type: Option<String>,
  protocol: Option<String>,
  from_cache: bool,
  state: State,
  error: Option<String>,
  encoded_bytes: Option<u64>,
  duration_ms: Option<f64>,
  body: Body,
}

/// A command the capture sends to the browser.
#[derive(Debug, PartialEq)]
pub(crate) struct Command {
  pub session: Option<String>,
  pub method: &'static str,
  pub params: Value,
  /// The entry whose body this command fetches.
  pub body_for: Option<u64>,
}

impl Command {
  fn setup(session: &str, method: &'static str, params: Value) -> Self {
    Self {
      session: Some(session.to_string()),
      method,
      params,
      body_for: None,
    }
  }
}

/// What a capture has seen, and what it still waits for.
#[derive(Default)]
pub(crate) struct CaptureLog {
  entries: VecDeque<Entry>,
  /// `(session, request id)` of a request still loading, to its entry.
  open: HashMap<(String, String), u64>,
  /// Each attached session, to the tab it belongs to.
  sessions: HashMap<String, String>,
  next_id: u64,
  body_bytes: usize,
  evicted: u64,
  /// Requests not recorded while the person was in control.
  withheld: u64,
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
  value.get(key).and_then(Value::as_str)
}

/// The headers with every credential value replaced.
fn redacted(headers: Option<&Value>) -> Map<String, Value> {
  let Some(Value::Object(headers)) = headers else {
    return Map::new();
  };
  headers
    .iter()
    .map(|(name, value)| {
      if SECRET_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
        (name.clone(), Value::from(REDACTED))
      } else {
        (name.clone(), value.clone())
      }
    })
    .collect()
}

/// Whether a response of this kind is text an agent reads.
fn keeps_body(resource_type: &str, mime_type: Option<&str>) -> bool {
  if matches!(
    resource_type,
    "Image"
      | "Media"
      | "Font"
      | "Script"
      | "Stylesheet"
      | "TextTrack"
      | "Manifest"
      | "WebSocket"
      | "EventSource"
      | "Ping"
      | "CSPViolationReport"
      | "Preflight"
  ) {
    return false;
  }
  let Some(mime) = mime_type else {
    return false;
  };
  let mime = mime.to_ascii_lowercase();
  mime.starts_with("text/")
    || mime.contains("json")
    || mime.contains("xml")
    || mime.contains("javascript")
    || mime.contains("graphql")
    || mime == "application/x-www-form-urlencoded"
}

/// `text` cut to `max` bytes at a character boundary.
fn cut(text: &str, max: usize) -> (&str, bool) {
  if text.len() <= max {
    return (text, false);
  }
  let mut end = max;
  while !text.is_char_boundary(end) {
    end -= 1;
  }
  (&text[..end], true)
}

impl CaptureLog {
  /// Read one event from the browser, and answer with what to send it.
  ///
  /// `private` is whether the person is in control right now: a request that
  /// starts then is not recorded.
  pub(crate) fn on_event(
    &mut self,
    session: Option<&str>,
    method: &str,
    params: &Value,
    private: bool,
  ) -> Vec<Command> {
    match method {
      "Target.attachedToTarget" => self.attached(session, params),
      "Target.detachedFromTarget" => {
        if let Some(gone) = str_of(params, "sessionId") {
          self.detached(gone);
        }
        Vec::new()
      }
      _ => {
        let Some(session) = session else {
          return Vec::new();
        };
        let Some(request_id) = str_of(params, "requestId") else {
          return Vec::new();
        };
        let key = (session.to_string(), request_id.to_string());
        match method {
          "Network.requestWillBeSent" => {
            self.request(key, params, private);
            Vec::new()
          }
          "Network.requestServedFromCache" => {
            if let Some(entry) = self.open_entry(&key) {
              entry.from_cache = true;
            }
            Vec::new()
          }
          "Network.responseReceived" => {
            if let Some(entry) = self.open_entry(&key) {
              let response = params.get("response").unwrap_or(&Value::Null);
              entry.status = response.get("status").and_then(Value::as_u64);
              entry.status_text = str_of(response, "statusText").map(str::to_string);
              entry.response_headers = redacted(response.get("headers"));
              entry.mime_type = str_of(response, "mimeType").map(str::to_string);
              entry.protocol = str_of(response, "protocol").map(str::to_string);
              entry.from_cache |= ["fromDiskCache", "fromServiceWorker", "fromPrefetchCache"]
                .iter()
                .any(|flag| response.get(*flag).and_then(Value::as_bool) == Some(true));
              if let Some(kind) = str_of(params, "type") {
                entry.resource_type = kind.to_string();
              }
            }
            Vec::new()
          }
          "Network.loadingFinished" => self.finished(&key, params),
          "Network.loadingFailed" => {
            if let Some(id) = self.open.remove(&key) {
              if let Some(entry) = self.entry_mut(id) {
                entry.state = State::Failed;
                entry.error = Some(
                  if params.get("canceled").and_then(Value::as_bool) == Some(true) {
                    "canceled".to_string()
                  } else {
                    let text = str_of(params, "errorText").unwrap_or("failed");
                    match str_of(params, "blockedReason") {
                      Some(reason) => format!("{text} (blocked: {reason})"),
                      None => text.to_string(),
                    }
                  },
                );
                entry.duration_ms = duration(entry.started, params);
                entry.body = Body::Skipped("failed");
              }
            }
            Vec::new()
          }
          _ => Vec::new(),
        }
      }
    }
  }

  fn attached(&mut self, parent: Option<&str>, params: &Value) -> Vec<Command> {
    let Some(child) = str_of(params, "sessionId") else {
      return Vec::new();
    };
    let info = params.get("targetInfo").unwrap_or(&Value::Null);
    let kind = str_of(info, "type").unwrap_or_default();
    if kind != "page" && kind != "iframe" {
      return Vec::new();
    }
    let target = str_of(info, "targetId").unwrap_or_default().to_string();
    // A frame belongs to the tab whose session reported it.
    let tab = match kind {
      "page" => target,
      _ => parent
        .and_then(|parent| self.sessions.get(parent).cloned())
        .unwrap_or(target),
    };
    self.sessions.insert(child.to_string(), tab);
    let mut commands = vec![
      Command::setup(
        child,
        "Network.enable",
        json!({
          "maxPostDataSize": MAX_POST_DATA_BYTES,
          "maxTotalBufferSize": BROWSER_BUFFER_BYTES,
          "maxResourceBufferSize": MAX_BODY_BYTES,
        }),
      ),
      Command::setup(
        child,
        "Target.setAutoAttach",
        json!({
          "autoAttach": true,
          "waitForDebuggerOnStart": false,
          "flatten": true,
          "filter": [{ "type": "iframe" }],
        }),
      ),
    ];
    if params.get("waitingForDebugger").and_then(Value::as_bool) == Some(true) {
      commands.push(Command::setup(
        child,
        "Runtime.runIfWaitingForDebugger",
        json!({}),
      ));
    }
    commands
  }

  fn detached(&mut self, session: &str) {
    self.sessions.remove(session);
    let gone: Vec<u64> = self
      .open
      .iter()
      .filter(|((owner, _), _)| owner == session)
      .map(|(_, id)| *id)
      .collect();
    self.open.retain(|(owner, _), _| owner != session);
    for id in gone {
      if let Some(entry) = self.entry_mut(id) {
        entry.state = State::Incomplete;
        entry.body = Body::Skipped("tab closed");
      }
    }
  }

  fn request(&mut self, key: (String, String), params: &Value, private: bool) {
    // A redirect reuses the request id: the hop that was answered ends here.
    if let Some(redirect) = params.get("redirectResponse") {
      if let Some(id) = self.open.remove(&key) {
        if let Some(entry) = self.entry_mut(id) {
          entry.state = State::Redirected;
          entry.status = redirect.get("status").and_then(Value::as_u64);
          entry.status_text = str_of(redirect, "statusText").map(str::to_string);
          entry.response_headers = redacted(redirect.get("headers"));
          entry.duration_ms = duration(entry.started, params);
          entry.body = Body::Skipped("redirect");
        }
      }
    }
    let request = params.get("request").unwrap_or(&Value::Null);
    let url = str_of(request, "url").unwrap_or_default();
    let lowered = url.to_ascii_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
      return;
    }
    if private {
      self.withheld += 1;
      return;
    }
    let (post_data, post_data_truncated) = match str_of(request, "postData") {
      Some(data) => {
        let (kept, truncated) = cut(data, MAX_POST_DATA_BYTES);
        (Some(kept.to_string()), truncated)
      }
      // The browser leaves out a body larger than `maxPostDataSize`.
      None => (
        None,
        request.get("hasPostData").and_then(Value::as_bool) == Some(true),
      ),
    };
    self.next_id += 1;
    let id = self.next_id;
    self.entries.push_back(Entry {
      id,
      tab: self.sessions.get(&key.0).cloned().unwrap_or_default(),
      session: key.0.clone(),
      request_id: key.1.clone(),
      method: str_of(request, "method").unwrap_or("GET").to_string(),
      url: url.to_string(),
      resource_type: str_of(params, "type").unwrap_or("Other").to_string(),
      request_headers: redacted(request.get("headers")),
      post_data,
      post_data_truncated,
      started_at: params
        .get("wallTime")
        .and_then(Value::as_f64)
        .map_or(0.0, |seconds| (seconds * 1000.0).round()),
      started: params
        .get("timestamp")
        .and_then(Value::as_f64)
        .unwrap_or_default(),
      status: None,
      status_text: None,
      response_headers: Map::new(),
      mime_type: None,
      protocol: None,
      from_cache: false,
      state: State::Pending,
      error: None,
      encoded_bytes: None,
      duration_ms: None,
      body: Body::Waiting,
    });
    self.open.insert(key, id);
    while self.entries.len() > MAX_ENTRIES {
      if let Some(old) = self.entries.pop_front() {
        if let Body::Kept(text) = &old.body {
          self.body_bytes -= text.len();
        }
        self.open.remove(&(old.session, old.request_id));
        self.evicted += 1;
      }
    }
  }

  fn finished(&mut self, key: &(String, String), params: &Value) -> Vec<Command> {
    let Some(id) = self.open.remove(key) else {
      return Vec::new();
    };
    let Some(entry) = self.entry_mut(id) else {
      return Vec::new();
    };
    entry.state = State::Done;
    entry.duration_ms = duration(entry.started, params);
    entry.encoded_bytes = params
      .get("encodedDataLength")
      .and_then(Value::as_f64)
      .map(|bytes| bytes.max(0.0) as u64);
    if !keeps_body(&entry.resource_type, entry.mime_type.as_deref()) {
      entry.body = Body::Skipped("not text");
      return Vec::new();
    }
    if entry
      .encoded_bytes
      .is_some_and(|bytes| bytes as usize > MAX_BODY_BYTES)
    {
      entry.body = Body::Skipped("too large");
      return Vec::new();
    }
    entry.body = Body::Fetching;
    vec![Command {
      session: Some(key.0.clone()),
      method: "Network.getResponseBody",
      params: json!({ "requestId": key.1 }),
      body_for: Some(id),
    }]
  }

  /// Store the browser's answer to a body fetch; `None` when it refused.
  pub(crate) fn on_body(&mut self, id: u64, result: Option<&Value>) {
    let Some(entry) = self.entry_mut(id) else {
      return;
    };
    if entry.body != Body::Fetching {
      return;
    }
    let Some(result) = result else {
      entry.body = Body::Skipped("unavailable");
      return;
    };
    if result.get("base64Encoded").and_then(Value::as_bool) == Some(true) {
      entry.body = Body::Skipped("binary");
      return;
    }
    let text = str_of(result, "body").unwrap_or_default();
    if text.len() > MAX_BODY_BYTES {
      entry.body = Body::Skipped("too large");
      return;
    }
    entry.body = Body::Kept(text.to_string());
    self.body_bytes += text.len();
    for old in self.entries.iter_mut() {
      if self.body_bytes <= MAX_STORED_BODY_BYTES {
        break;
      }
      if let Body::Kept(text) = &old.body {
        self.body_bytes -= text.len();
        old.body = Body::Skipped("dropped to stay under the memory limit");
      }
    }
  }

  fn entry_mut(&mut self, id: u64) -> Option<&mut Entry> {
    let index = self.entries.partition_point(|entry| entry.id < id);
    self.entries.get_mut(index).filter(|entry| entry.id == id)
  }

  fn entry(&self, id: u64) -> Option<&Entry> {
    let index = self.entries.partition_point(|entry| entry.id < id);
    self.entries.get(index).filter(|entry| entry.id == id)
  }

  fn open_entry(&mut self, key: &(String, String)) -> Option<&mut Entry> {
    let id = *self.open.get(key)?;
    self.entry_mut(id)
  }

  fn tabs(&self) -> usize {
    self.sessions.values().collect::<HashSet<_>>().len()
  }

  /// The requests that match `query`, oldest first, in short form.
  pub(crate) fn list(&self, query: &ListQuery) -> Value {
    let mut matching = self
      .entries
      .iter()
      .filter(|entry| entry.id > query.after && query.matches(entry));
    let requests: Vec<Value> = matching.by_ref().take(query.limit).map(summary).collect();
    let next_after = if matching.next().is_some() {
      requests
        .last()
        .and_then(|last| last.get("id"))
        .and_then(Value::as_u64)
    } else {
      None
    };
    json!({
      "requests": requests,
      "next_after": next_after,
      "last_id": self.next_id,
      "kept": self.entries.len(),
      "evicted": self.evicted,
      "withheld": self.withheld,
    })
  }

  /// One request in full. Its body is shown from `offset` for at most
  /// `max_chars` characters.
  pub(crate) fn detail(
    &self,
    id: u64,
    with_body: bool,
    offset: usize,
    max_chars: usize,
  ) -> Option<Value> {
    let entry = self.entry(id)?;
    let mut value = summary(entry);
    value["url"] = Value::from(entry.url.clone());
    value["status_text"] = json!(entry.status_text);
    value["protocol"] = json!(entry.protocol);
    value["from_cache"] = Value::from(entry.from_cache);
    value["started_at"] = Value::from(entry.started_at);
    value["error"] = json!(entry.error);
    value["request_headers"] = Value::Object(entry.request_headers.clone());
    value["post_data"] = json!(entry.post_data);
    value["post_data_truncated"] = Value::from(entry.post_data_truncated);
    value["response_headers"] = Value::Object(entry.response_headers.clone());
    if let (true, Body::Kept(text)) = (with_body, &entry.body) {
      let total = text.chars().count();
      let shown: String = text.chars().skip(offset).take(max_chars).collect();
      let end = offset.saturating_add(shown.chars().count());
      value["body"] = json!({
        "text": shown,
        "offset": offset,
        "chars": total,
        "next_offset": (end < total).then_some(end),
      });
    }
    Some(value)
  }
}

fn duration(started: f64, params: &Value) -> Option<f64> {
  let at = params.get("timestamp").and_then(Value::as_f64)?;
  Some(((at - started) * 1000.0).max(0.0).round())
}

fn summary(entry: &Entry) -> Value {
  let (url, cut_off) = cut(&entry.url, LIST_URL_CHARS);
  json!({
    "id": entry.id,
    "tab": entry.tab,
    "method": entry.method,
    "url": if cut_off { format!("{url}…") } else { url.to_string() },
    "type": entry.resource_type,
    "state": entry.state.name(),
    "status": entry.status,
    "mime": entry.mime_type,
    "bytes": entry.encoded_bytes,
    "ms": entry.duration_ms,
    "body": entry.body.summary(),
  })
}

/// What `list_network_requests` filters by.
#[derive(Debug, Default)]
pub(crate) struct ListQuery {
  pub after: u64,
  pub limit: usize,
  pub url_contains: Option<String>,
  pub method: Option<String>,
  pub resource_type: Option<String>,
  pub status: Option<u64>,
  pub failed: Option<bool>,
  pub body_contains: Option<String>,
}

impl ListQuery {
  fn matches(&self, entry: &Entry) -> bool {
    let contains = |haystack: &str, needle: &str| {
      haystack
        .to_lowercase()
        .contains(needle.to_lowercase().as_str())
    };
    self
      .url_contains
      .as_deref()
      .is_none_or(|needle| contains(&entry.url, needle))
      && self
        .method
        .as_deref()
        .is_none_or(|method| entry.method.eq_ignore_ascii_case(method))
      && self
        .resource_type
        .as_deref()
        .is_none_or(|kind| entry.resource_type.eq_ignore_ascii_case(kind))
      && self
        .status
        .is_none_or(|status| entry.status == Some(status))
      && self
        .failed
        .is_none_or(|failed| (entry.state == State::Failed) == failed)
      && self
        .body_contains
        .as_deref()
        .is_none_or(|needle| match &entry.body {
          Body::Kept(text) => contains(text, needle),
          _ => false,
        })
  }
}

struct Capture {
  generation: u64,
  log: CaptureLog,
  task: tokio::task::AbortHandle,
}

static CAPTURES: LazyLock<Mutex<HashMap<String, Capture>>> = LazyLock::new(Default::default);
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn captures() -> std::sync::MutexGuard<'static, HashMap<String, Capture>> {
  CAPTURES
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run `f` on the log of capture `generation`; `None` once it is gone.
fn with_log<T>(
  profile_id: &str,
  generation: u64,
  f: impl FnOnce(&mut CaptureLog) -> T,
) -> Option<T> {
  let mut captures = captures();
  let capture = captures
    .get_mut(profile_id)
    .filter(|capture| capture.generation == generation)?;
  Some(f(&mut capture.log))
}

/// Why a capture could not start.
#[derive(Debug)]
pub(crate) enum StartError {
  /// The browser is not running on this computer.
  NotLocal,
  /// The browser refused, or did not answer, the attach.
  Refused(String),
}

/// Start capturing a running profile's traffic. A capture already running is
/// left as it is; the answer says so.
pub(crate) async fn start(profile: &BrowserProfile) -> Result<Value, StartError> {
  let profile_id = profile.id.to_string();
  if let Some(capture) = captures().get(&profile_id) {
    return Ok(json!({
      "capturing": true,
      "already_running": true,
      "tabs": capture.log.tabs(),
      "kept": capture.log.entries.len(),
    }));
  }
  let connection = crate::cdp_target::connect_local_browser(profile)
    .await
    .ok_or(StartError::NotLocal)?;
  let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
  let (go, wait_for_go) = tokio::sync::oneshot::channel::<()>();
  let (ready, attached) = tokio::sync::oneshot::channel::<Result<(), String>>();
  let pump_profile = profile_id.clone();
  let task = tokio::spawn(async move {
    if wait_for_go.await.is_ok() {
      pump(pump_profile, generation, connection, ready).await;
    }
  });
  {
    let mut captures = captures();
    if let Some(capture) = captures.get(&profile_id) {
      // Another call started one while this one dialed.
      task.abort();
      return Ok(json!({
        "capturing": true,
        "already_running": true,
        "tabs": capture.log.tabs(),
        "kept": capture.log.entries.len(),
      }));
    }
    captures.insert(
      profile_id.clone(),
      Capture {
        generation,
        log: CaptureLog::default(),
        task: task.abort_handle(),
      },
    );
  }
  let _ = go.send(());
  let outcome = match tokio::time::timeout(ATTACH_TIMEOUT, attached).await {
    Ok(Ok(outcome)) => outcome,
    Ok(Err(_)) => Err("the browser closed the connection".to_string()),
    Err(_) => Err("the browser did not answer".to_string()),
  };
  if let Err(reason) = outcome {
    end(&profile_id, generation);
    return Err(StartError::Refused(reason));
  }
  log::info!("Network capture started profile={profile_id}");
  let tabs = with_log(&profile_id, generation, |log| log.tabs()).unwrap_or_default();
  Ok(json!({ "capturing": true, "already_running": false, "tabs": tabs }))
}

/// Remove capture `generation` and stop its pump.
fn end(profile_id: &str, generation: u64) -> Option<CaptureLog> {
  let mut captures = captures();
  if captures
    .get(profile_id)
    .is_some_and(|capture| capture.generation == generation)
  {
    let capture = captures.remove(profile_id)?;
    capture.task.abort();
    return Some(capture.log);
  }
  None
}

/// Stop a profile's capture and forget what it saw. `None` when none ran.
pub(crate) fn stop(profile_id: &str) -> Option<usize> {
  let capture = captures().remove(profile_id)?;
  capture.task.abort();
  let kept = capture.log.entries.len();
  log::info!("Network capture stopped profile={profile_id} requests={kept}");
  Some(kept)
}

/// Read a profile's capture; `None` when none runs.
pub(crate) fn read<T>(profile_id: &str, f: impl FnOnce(&CaptureLog) -> T) -> Option<T> {
  captures().get(profile_id).map(|capture| f(&capture.log))
}

/// Carry events from the browser into the log, and the log's commands back.
async fn pump(
  profile_id: String,
  generation: u64,
  mut connection: CdpConnection,
  ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
  let mut ready = Some(ready);
  let attach = connection
    .send_to(
      None,
      ATTACH_ID,
      "Target.setAutoAttach",
      json!({
        "autoAttach": true,
        "waitForDebuggerOnStart": false,
        "flatten": true,
        "filter": [{ "type": "page" }],
      }),
    )
    .await;
  let mut next_id = ATTACH_ID + 1;
  let mut fetches: HashMap<u64, u64> = HashMap::new();
  let reason = match attach {
    Err(e) => format!("attach failed: {e}"),
    Ok(()) => 'pump: loop {
      let text = match connection.next_text().await {
        Some(Ok(text)) => text,
        Some(Err(e)) => break e.to_string(),
        None => break "browser closed".to_string(),
      };
      let Ok(message) = serde_json::from_str::<Value>(&text) else {
        continue;
      };
      if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if id == ATTACH_ID {
          let refused = message.get("error").map(Value::to_string);
          if let Some(ready) = ready.take() {
            let _ = ready.send(match &refused {
              Some(error) => Err(error.clone()),
              None => Ok(()),
            });
          }
          if refused.is_some() {
            break "attach refused".to_string();
          }
        } else if let Some(entry) = fetches.remove(&id) {
          let result = match message.get("error") {
            Some(_) => None,
            None => message.get("result"),
          };
          if with_log(&profile_id, generation, |log| log.on_body(entry, result)).is_none() {
            break "stopped".to_string();
          }
        }
        continue;
      }
      let Some(method) = message.get("method").and_then(Value::as_str) else {
        continue;
      };
      let session = message.get("sessionId").and_then(Value::as_str);
      let params = message.get("params").unwrap_or(&Value::Null);
      let private = method == "Network.requestWillBeSent"
        && crate::agent_console::person_in_control(&profile_id);
      let Some(commands) = with_log(&profile_id, generation, |log| {
        log.on_event(session, method, params, private)
      }) else {
        break "stopped".to_string();
      };
      for command in commands {
        let id = next_id;
        next_id += 1;
        if let Some(entry) = command.body_for {
          if fetches.len() >= MAX_PENDING_FETCHES {
            fetches.clear();
          }
          fetches.insert(id, entry);
        }
        if let Err(e) = connection
          .send_to(
            command.session.as_deref(),
            id,
            command.method,
            command.params,
          )
          .await
        {
          break 'pump e.to_string();
        }
      }
    },
  };
  if let Some(ready) = ready.take() {
    let _ = ready.send(Err(reason.clone()));
  }
  if let Some(log) = end(&profile_id, generation) {
    log::info!(
      "Network capture ended profile={profile_id} requests={} reason=\"{reason}\"",
      log.entries.len()
    );
  }
}

/// The most requests the window lists at once.
const MAX_WINDOW_LIST: usize = 500;

impl CaptureLog {
  /// The newest `limit` requests after `after`, for the window: it shows the
  /// end of the capture, where `list` pages from the start.
  fn newest(&self, after: u64, limit: usize) -> Value {
    let after = after.max(self.next_id.saturating_sub(limit as u64));
    let mut answer = self.list(&ListQuery {
      after,
      limit,
      ..Default::default()
    });
    answer["capturing"] = Value::from(true);
    answer
  }
}

/// Start capturing the traffic of a profile running on this computer, from
/// the window. The same capture the MCP tools read, with the same redaction.
#[tauri::command]
pub async fn start_network_capture(profile_id: String) -> Result<Value, String> {
  let profile = crate::profile::ProfileManager::instance()
    .list_profiles()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
    .into_iter()
    .find(|p| p.id.to_string() == profile_id)
    .ok_or_else(|| crate::backend_error("PROFILE_NOT_FOUND"))?;
  start(&profile).await.map_err(|e| match e {
    StartError::NotLocal => crate::backend_error("PROFILE_NOT_RUNNING"),
    StartError::Refused(reason) => {
      log::warn!("Network capture start failed profile={profile_id} err=\"{reason}\"");
      crate::backend_error_with_detail("NETWORK_CAPTURE_FAILED", reason)
    }
  })
}

#[tauri::command]
pub fn stop_network_capture(profile_id: String) -> Value {
  match stop(&profile_id) {
    Some(requests) => json!({ "stopped": true, "requests": requests }),
    None => json!({ "stopped": false }),
  }
}

/// The newest captured requests after `after`, at most `limit` (500).
/// `{ "capturing": false }` when no capture runs.
#[tauri::command]
pub fn list_network_requests(
  profile_id: String,
  after: Option<u64>,
  limit: Option<usize>,
) -> Value {
  let limit = limit.unwrap_or(MAX_WINDOW_LIST).clamp(1, MAX_WINDOW_LIST);
  read(&profile_id, |log| log.newest(after.unwrap_or(0), limit))
    .unwrap_or_else(|| json!({ "capturing": false }))
}

/// One captured request with its redacted headers; `null` once it is gone.
#[tauri::command]
pub fn get_network_request(profile_id: String, request_id: u64) -> Result<Option<Value>, String> {
  read(&profile_id, |log| log.detail(request_id, false, 0, 0))
    .ok_or_else(|| crate::backend_error("NETWORK_CAPTURE_NOT_RUNNING"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_window_lists_the_newest_requests_and_the_cursor_holds() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    for n in 0..10 {
      request(
        &mut log,
        &format!("r{n}"),
        &format!("https://a.test/{n}"),
        false,
      );
    }
    let ids = |answer: &Value| -> Vec<u64> {
      answer["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_u64().unwrap())
        .collect()
    };
    let newest = log.newest(0, 3);
    assert_eq!(newest["capturing"], true);
    let last = ids(&newest);
    assert_eq!(last.len(), 3);
    assert_eq!(*last.last().unwrap(), newest["last_id"].as_u64().unwrap());
    let after_cursor = log.newest(*last.last().unwrap() - 1, 3);
    assert_eq!(ids(&after_cursor), vec![*last.last().unwrap()]);
    let auth = log.detail(last[0], false, 0, 0).unwrap();
    assert_eq!(auth["request_headers"]["Authorization"], REDACTED);
  }

  const PAGE: &str = "S1";

  fn attached_page(log: &mut CaptureLog) -> Vec<Command> {
    log.on_event(
      None,
      "Target.attachedToTarget",
      &json!({
        "sessionId": PAGE,
        "targetInfo": { "targetId": "T1", "type": "page", "url": "about:blank" },
        "waitingForDebugger": false,
      }),
      false,
    )
  }

  fn request(log: &mut CaptureLog, id: &str, url: &str, private: bool) {
    log.on_event(
      Some(PAGE),
      "Network.requestWillBeSent",
      &json!({
        "requestId": id,
        "type": "Fetch",
        "timestamp": 10.0,
        "wallTime": 1_700_000_000.5,
        "request": {
          "url": url,
          "method": "POST",
          "headers": { "Content-Type": "application/json", "Authorization": "Bearer abc" },
          "postData": "{\"q\":1}",
          "hasPostData": true,
        },
      }),
      private,
    );
  }

  fn respond(log: &mut CaptureLog, id: &str, mime: &str) {
    log.on_event(
      Some(PAGE),
      "Network.responseReceived",
      &json!({
        "requestId": id,
        "type": "Fetch",
        "response": {
          "status": 200,
          "statusText": "OK",
          "mimeType": mime,
          "protocol": "h2",
          "headers": { "set-cookie": "sid=secret", "content-type": mime },
        },
      }),
      false,
    );
  }

  fn finish(log: &mut CaptureLog, id: &str, bytes: u64) -> Vec<Command> {
    log.on_event(
      Some(PAGE),
      "Network.loadingFinished",
      &json!({ "requestId": id, "timestamp": 10.25, "encodedDataLength": bytes }),
      false,
    )
  }

  #[test]
  fn a_tab_is_attached_with_network_on_and_its_frames_followed() {
    let mut log = CaptureLog::default();
    let commands = attached_page(&mut log);
    let methods: Vec<&str> = commands.iter().map(|c| c.method).collect();
    assert_eq!(methods, ["Network.enable", "Target.setAutoAttach"]);
    assert!(commands.iter().all(|c| c.session.as_deref() == Some(PAGE)));
    assert_eq!(commands[0].params["maxTotalBufferSize"], 8 * 1024 * 1024);
    assert_eq!(commands[0].params["maxResourceBufferSize"], 2 * 1024 * 1024);
    assert_eq!(commands[1].params["filter"], json!([{ "type": "iframe" }]));

    let frame = log.on_event(
      Some(PAGE),
      "Target.attachedToTarget",
      &json!({
        "sessionId": "S2",
        "targetInfo": { "targetId": "F1", "type": "iframe" },
        "waitingForDebugger": true,
      }),
      false,
    );
    assert_eq!(frame.len(), 3);
    assert_eq!(frame[2].method, "Runtime.runIfWaitingForDebugger");
    assert_eq!(log.sessions.get("S2").map(String::as_str), Some("T1"));
    assert_eq!(log.tabs(), 1);

    let worker = log.on_event(
      None,
      "Target.attachedToTarget",
      &json!({ "sessionId": "S3", "targetInfo": { "targetId": "W", "type": "service_worker" } }),
      false,
    );
    assert!(worker.is_empty());
  }

  #[test]
  fn a_request_is_recorded_with_its_text_body_and_no_credentials() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    request(&mut log, "r1", "https://api.example/items", false);
    respond(&mut log, "r1", "application/json");
    let fetch = finish(&mut log, "r1", 120);
    assert_eq!(
      fetch,
      vec![Command {
        session: Some(PAGE.to_string()),
        method: "Network.getResponseBody",
        params: json!({ "requestId": "r1" }),
        body_for: Some(1),
      }]
    );
    log.on_body(
      1,
      Some(&json!({ "body": "{\"items\":[1,2]}", "base64Encoded": false })),
    );

    let detail = log.detail(1, true, 0, 1000).unwrap();
    assert_eq!(detail["tab"], "T1");
    assert_eq!(detail["method"], "POST");
    assert_eq!(detail["status"], 200);
    assert_eq!(detail["state"], "done");
    assert_eq!(detail["ms"], 250.0);
    assert_eq!(detail["started_at"], 1_700_000_000_500.0);
    assert_eq!(detail["post_data"], "{\"q\":1}");
    assert_eq!(detail["request_headers"]["Authorization"], REDACTED);
    assert_eq!(
      detail["request_headers"]["Content-Type"],
      "application/json"
    );
    assert_eq!(detail["response_headers"]["set-cookie"], REDACTED);
    assert_eq!(detail["body"]["text"], "{\"items\":[1,2]}");
    assert_eq!(detail["body"]["next_offset"], Value::Null);
    assert_eq!(log.body_bytes, 15);
  }

  #[test]
  fn only_web_requests_are_recorded_and_none_while_the_person_is_in_control() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    request(&mut log, "r1", "data:text/plain,hi", false);
    request(&mut log, "r2", "chrome-extension://abc/x.js", false);
    request(&mut log, "r3", "https://bank.example/login", true);
    assert!(log.entries.is_empty());
    assert_eq!(log.withheld, 1);
    // Its answer finds no entry and asks for nothing.
    respond(&mut log, "r3", "text/html");
    assert!(finish(&mut log, "r3", 10).is_empty());
  }

  #[test]
  fn bodies_that_are_not_text_or_too_large_are_not_fetched() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    request(&mut log, "img", "https://cdn.example/a.png", false);
    respond(&mut log, "img", "image/png");
    assert!(finish(&mut log, "img", 10).is_empty());
    request(&mut log, "big", "https://api.example/dump", false);
    respond(&mut log, "big", "application/json");
    assert!(finish(&mut log, "big", MAX_BODY_BYTES as u64 + 1).is_empty());
    let list = log.list(&ListQuery {
      limit: 10,
      ..Default::default()
    });
    assert_eq!(list["requests"][0]["body"], "not text");
    assert_eq!(list["requests"][1]["body"], "too large");

    request(&mut log, "bin", "https://api.example/blob", false);
    respond(&mut log, "bin", "text/plain");
    finish(&mut log, "bin", 10);
    log.on_body(3, Some(&json!({ "body": "AAEC", "base64Encoded": true })));
    assert_eq!(log.entry(3).unwrap().body, Body::Skipped("binary"));
  }

  #[test]
  fn a_redirect_ends_one_hop_and_starts_the_next() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    request(&mut log, "r1", "http://example.test/old", false);
    log.on_event(
      Some(PAGE),
      "Network.requestWillBeSent",
      &json!({
        "requestId": "r1",
        "type": "Document",
        "timestamp": 10.1,
        "request": { "url": "https://example.test/new", "method": "GET", "headers": {} },
        "redirectResponse": { "status": 301, "headers": { "Location": "https://example.test/new" } },
      }),
      false,
    );
    let first = log.entry(1).unwrap();
    assert_eq!(first.state, State::Redirected);
    assert_eq!(first.status, Some(301));
    assert_eq!(log.entry(2).unwrap().url, "https://example.test/new");
    assert_eq!(
      log.open.get(&(PAGE.to_string(), "r1".to_string())),
      Some(&2)
    );
  }

  #[test]
  fn failures_and_closed_tabs_end_their_requests() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    request(&mut log, "r1", "https://blocked.example/", false);
    log.on_event(
      Some(PAGE),
      "Network.loadingFailed",
      &json!({ "requestId": "r1", "timestamp": 11.0, "errorText": "net::ERR_BLOCKED_BY_CLIENT", "blockedReason": "inspector" }),
      false,
    );
    request(&mut log, "r2", "https://slow.example/", false);
    log.on_event(
      None,
      "Target.detachedFromTarget",
      &json!({ "sessionId": PAGE }),
      false,
    );
    assert_eq!(log.entry(1).unwrap().state, State::Failed);
    assert_eq!(
      log.entry(1).unwrap().error.as_deref(),
      Some("net::ERR_BLOCKED_BY_CLIENT (blocked: inspector)")
    );
    assert_eq!(log.entry(2).unwrap().state, State::Incomplete);
    assert!(log.open.is_empty());
    assert!(log.sessions.is_empty());
    let failed = log.list(&ListQuery {
      limit: 10,
      failed: Some(true),
      ..Default::default()
    });
    assert_eq!(failed["requests"].as_array().unwrap().len(), 1);
  }

  #[test]
  fn old_requests_and_old_bodies_give_way() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    for n in 0..MAX_ENTRIES + 5 {
      request(&mut log, &format!("r{n}"), "https://example.test/", false);
    }
    assert_eq!(log.entries.len(), MAX_ENTRIES);
    assert_eq!(log.evicted, 5);
    assert_eq!(log.entries.front().unwrap().id, 6);
    assert_eq!(log.open.len(), MAX_ENTRIES);

    let mut log = CaptureLog::default();
    attached_page(&mut log);
    let body = "x".repeat(MAX_BODY_BYTES);
    let count = MAX_STORED_BODY_BYTES / MAX_BODY_BYTES + 1;
    for n in 0..count {
      let id = format!("b{n}");
      request(&mut log, &id, "https://example.test/", false);
      respond(&mut log, &id, "text/plain");
      finish(&mut log, &id, 10);
      log.on_body(n as u64 + 1, Some(&json!({ "body": body })));
    }
    assert!(log.body_bytes <= MAX_STORED_BODY_BYTES);
    assert_eq!(
      log.entry(1).unwrap().body,
      Body::Skipped("dropped to stay under the memory limit")
    );
    assert!(matches!(
      log.entry(count as u64).unwrap().body,
      Body::Kept(_)
    ));
  }

  #[test]
  fn a_list_filters_and_pages() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    for (n, url) in [
      "https://a.test/api/one",
      "https://b.test/page",
      "https://a.test/api/two",
    ]
    .iter()
    .enumerate()
    {
      let id = format!("r{n}");
      request(&mut log, &id, url, false);
      respond(&mut log, &id, "application/json");
      finish(&mut log, &id, 10);
      log.on_body(
        n as u64 + 1,
        Some(&json!({ "body": format!("{{\"n\":{n}}}") })),
      );
    }
    let page = log.list(&ListQuery {
      limit: 1,
      url_contains: Some("A.TEST/API".to_string()),
      ..Default::default()
    });
    assert_eq!(page["requests"][0]["id"], 1);
    assert_eq!(page["next_after"], 1);
    let rest = log.list(&ListQuery {
      after: 1,
      limit: 1,
      url_contains: Some("a.test/api".to_string()),
      ..Default::default()
    });
    assert_eq!(rest["requests"][0]["id"], 3);
    assert_eq!(rest["next_after"], Value::Null);
    let by_body = log.list(&ListQuery {
      limit: 10,
      body_contains: Some("\"n\":1".to_string()),
      ..Default::default()
    });
    assert_eq!(by_body["requests"].as_array().unwrap().len(), 1);
    assert_eq!(by_body["requests"][0]["id"], 2);
    assert_eq!(by_body["last_id"], 3);
  }

  #[test]
  fn a_long_body_is_read_in_slices() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    request(&mut log, "r1", "https://example.test/", false);
    respond(&mut log, "r1", "text/plain");
    finish(&mut log, "r1", 10);
    log.on_body(1, Some(&json!({ "body": "ab€cd" })));
    let first = log.detail(1, true, 0, 3).unwrap();
    assert_eq!(first["body"]["text"], "ab€");
    assert_eq!(first["body"]["chars"], 5);
    assert_eq!(first["body"]["next_offset"], 3);
    let second = log.detail(1, true, 3, 3).unwrap();
    assert_eq!(second["body"]["text"], "cd");
    assert_eq!(second["body"]["next_offset"], Value::Null);
    assert!(log
      .detail(1, false, 0, 3)
      .unwrap()
      .get("body")
      .unwrap()
      .is_string());
  }

  #[test]
  fn a_long_url_is_cut_in_a_list_and_whole_in_detail() {
    let mut log = CaptureLog::default();
    attached_page(&mut log);
    let url = format!("https://example.test/{}", "é".repeat(400));
    request(&mut log, "r1", &url, false);
    let listed = log.list(&ListQuery {
      limit: 1,
      ..Default::default()
    });
    let shown = listed["requests"][0]["url"].as_str().unwrap();
    assert!(shown.ends_with('…') && shown.len() <= LIST_URL_CHARS + 3);
    assert_eq!(log.detail(1, false, 0, 1).unwrap()["url"], url);
  }
}
