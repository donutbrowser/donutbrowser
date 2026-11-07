//! Native dialogs (alert, confirm, prompt, "leave this page?") on the pages the
//! agent tools drive.
//!
//! While such a dialog is open the page runs no script and answers no command
//! that needs it. Only a CDP session whose Page domain was on when the dialog
//! opened can answer it, and a session opened later gets its `Page.enable`
//! answered only once the dialog closes. So the first time a tool touches a
//! page, a session with the Page domain on is opened to it and kept for as long
//! as the page lives. It sees each dialog open and close, answers one when
//! asked, and lets every other connection to the page fail at once instead of
//! waiting for a reply that cannot come.
//!
//! A page on this computer gets a socket of its own. A cloud session gets one
//! relay socket for all its pages: it follows the session's tabs and pins the
//! one the tools drive, so every connection to the session attaches to the
//! page that is watched, and the watch costs one of the session's few relay
//! attachments however many tabs it has.

use crate::cdp_target::{cdp_frame, pick_remote_page_target, CdpError, CdpTarget};
use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

/// How long a new watch waits for the page to turn its Page domain on, and a
/// cloud session's browser to list or attach its pages.
const ENABLE_WAIT: Duration = Duration::from_secs(3);
/// How long one `Page.enable` of a page that does not answer is waited for
/// before another is sent.
const ENABLE_RETRY: Duration = Duration::from_secs(30);
/// How long the browser may take to answer a dialog.
const ANSWER_WAIT: Duration = Duration::from_secs(10);
/// How long the close of an answered dialog is waited for.
const CLOSE_WAIT: Duration = Duration::from_secs(3);
/// How long after a close another dialog the page opens in answer still counts
/// as the next one.
const NEXT_DIALOG_WAIT: Duration = Duration::from_millis(300);
/// The longest dialog text kept.
const MAX_MESSAGE_CHARS: usize = 2_000;
/// The longest dialog text quoted in an error sentence.
const QUOTED_CHARS: usize = 300;

/// Methods the browser answers by itself, so they still work while a dialog is
/// open. Everything else waits in the page until the dialog closes.
pub fn answered_during_dialog(method: &str) -> bool {
  matches!(
    method,
    "Page.handleJavaScriptDialog" | "Page.bringToFront" | "Vellum.release"
  ) || method.starts_with("Target.")
    || method.starts_with("Browser.")
}

/// A dialog open on a page.
#[derive(Debug, Clone, PartialEq, Serialize, utoipa::ToSchema)]
pub struct OpenDialog {
  /// `alert`, `confirm`, `prompt` or `beforeunload`.
  #[serde(rename = "type")]
  pub kind: String,
  pub message: String,
  /// The text a prompt puts in its field.
  pub default_prompt: String,
  /// The page that opened it.
  pub url: String,
  /// Tells two dialogs with the same text apart.
  #[serde(skip)]
  serial: u64,
}

fn clipped(text: &str, max: usize) -> String {
  let mut chars = text.chars();
  let head: String = chars.by_ref().take(max).collect();
  if chars.next().is_some() {
    format!("{head}…")
  } else {
    head
  }
}

static DIALOG_SERIAL: AtomicU64 = AtomicU64::new(1);

impl OpenDialog {
  fn from_event(params: &Value) -> Self {
    let text = |key: &str| {
      params
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
    };
    Self {
      kind: text("type"),
      message: clipped(&text("message"), MAX_MESSAGE_CHARS),
      default_prompt: clipped(&text("defaultPrompt"), MAX_MESSAGE_CHARS),
      url: text("url"),
      serial: DIALOG_SERIAL.fetch_add(1, Ordering::Relaxed),
    }
  }

  /// A dialog the browser reported without saying which.
  pub fn unknown() -> Self {
    Self {
      kind: String::new(),
      message: String::new(),
      default_prompt: String::new(),
      url: String::new(),
      serial: 0,
    }
  }

  /// "A confirm dialog that says "Delete it?"".
  pub fn describe(&self) -> String {
    let what = match self.kind.as_str() {
      "alert" => "An alert dialog",
      "confirm" => "A confirm dialog",
      "prompt" => "A prompt dialog",
      "beforeunload" => "A \"leave this page?\" dialog",
      _ => "A dialog",
    };
    if self.message.trim().is_empty() {
      what.to_string()
    } else {
      format!(
        "{what} that says {:?}",
        clipped(&self.message, QUOTED_CHARS)
      )
    }
  }

  /// Why a command on the page was refused.
  pub fn refusal(&self) -> String {
    format!(
      "{} is open on the page. The page does nothing else until the dialog is answered.",
      self.describe()
    )
  }
}

/// What the watch of a page knows.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum PageState {
  /// The page has not answered the watch yet. A page held by a dialog that
  /// opened before the watch stays here until something ends the dialog.
  #[default]
  Unanswered,
  Ready,
  Dialog(OpenDialog),
}

impl PageState {
  pub fn dialog(&self) -> Option<&OpenDialog> {
    match self {
      Self::Dialog(dialog) => Some(dialog),
      _ => None,
    }
  }
}

type Replies = Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>;

/// A kept socket: to one page on this computer, or to the browser of a cloud
/// session, where each watched page is a CDP session of its own.
struct Link {
  serial: u64,
  outgoing: mpsc::UnboundedSender<Message>,
  replies: Replies,
  next_id: AtomicU64,
  /// A cloud session's targets, in the order the browser reported them.
  targets: Mutex<Vec<Value>>,
  /// The page of a cloud session the tools drive.
  pinned: Mutex<Option<String>>,
}

static LINK_SERIAL: AtomicU64 = AtomicU64::new(1);

impl Link {
  fn new(outgoing: mpsc::UnboundedSender<Message>) -> Self {
    Self {
      serial: LINK_SERIAL.fetch_add(1, Ordering::Relaxed),
      outgoing,
      replies: Mutex::default(),
      next_id: AtomicU64::new(1),
      targets: Mutex::default(),
      pinned: Mutex::default(),
    }
  }

  fn send(
    &self,
    session: Option<&str>,
    id: u64,
    method: &str,
    params: Value,
  ) -> Result<(), CdpError> {
    let frame = cdp_frame(session, id, method, params);
    self
      .outgoing
      .send(Message::Text(frame.to_string().into()))
      .map_err(|_| CdpError::Transport("the page's watch socket is closed".to_string()))
  }

  async fn call(
    &self,
    session: Option<&str>,
    method: &str,
    params: Value,
    timeout: Duration,
  ) -> Result<Value, CdpError> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    lock(&self.replies).insert(id, tx);
    if let Err(error) = self.send(session, id, method, params) {
      lock(&self.replies).remove(&id);
      return Err(error);
    }
    match tokio::time::timeout(timeout, rx).await {
      Ok(Ok(result)) => result,
      Ok(Err(_)) => Err(CdpError::Transport(
        "the page closed before it answered".to_string(),
      )),
      Err(_) => {
        lock(&self.replies).remove(&id);
        Err(CdpError::Transport(
          "timed out waiting for a CDP response".to_string(),
        ))
      }
    }
  }

  /// Hand a reply to the caller that waits for it. False for an event.
  fn reply(&self, message: &Value) -> bool {
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
      return false;
    };
    if let Some(waiter) = lock(&self.replies).remove(&id) {
      let reply = match message.get("error") {
        Some(error) => Err(CdpError::Protocol(error.to_string())),
        None => Ok(message.get("result").cloned().unwrap_or_default()),
      };
      let _ = waiter.send(reply);
    }
    true
  }

  fn close(&self) {
    let _ = self.outgoing.send(Message::Close(None));
  }

  fn note_target(&self, info: &Value) {
    let Some(id) = info.get("targetId").and_then(Value::as_str) else {
      return;
    };
    let mut targets = lock(&self.targets);
    match targets.iter_mut().find(|known| known["targetId"] == id) {
      Some(known) => *known = info.clone(),
      None => targets.push(info.clone()),
    }
  }

  fn forget_target(&self, id: &str) {
    lock(&self.targets).retain(|known| known["targetId"] != id);
  }

  /// The page the tools drive: the pinned one while it is open, else the
  /// first page the browser lists, which is pinned from then on. The browser
  /// lists its tabs in no fixed order, so without the pin each new connection
  /// could drive another tab.
  fn page(&self) -> Option<String> {
    let targets = lock(&self.targets);
    let mut pinned = lock(&self.pinned);
    if let Some(page) = pinned.as_deref() {
      if targets.iter().any(|known| known["targetId"] == page) {
        return pinned.clone();
      }
    }
    *pinned = pick_remote_page_target(&serde_json::json!({ "targetInfos": *targets }));
    pinned.clone()
  }
}

/// What the watch of one page knows.
pub struct PageWatch {
  link: Arc<Link>,
  /// The page's CDP session on a cloud session's socket.
  session: Option<String>,
  /// The page's target id on a cloud session's socket.
  page: Option<String>,
  state: watch::Sender<PageState>,
  /// A `Page.enable` is waiting for its answer.
  enabling: AtomicBool,
}

impl PageWatch {
  fn new(link: Arc<Link>, session: Option<String>, page: Option<String>) -> Self {
    Self {
      link,
      session,
      page,
      state: watch::Sender::new(PageState::Unanswered),
      enabling: AtomicBool::new(false),
    }
  }

  async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, CdpError> {
    self
      .link
      .call(self.session.as_deref(), method, params, timeout)
      .await
  }

  /// Turn the Page domain on, unless an earlier attempt still waits. A page
  /// held by a dialog answers once something ends the dialog; an attempt that
  /// is never answered is followed by another on the next look.
  fn enable(self: &Arc<Self>) {
    if self.enabling.swap(true, Ordering::AcqRel) {
      return;
    }
    let watch = self.clone();
    tokio::spawn(async move {
      let answered = watch
        .call("Page.enable", serde_json::json!({}), ENABLE_RETRY)
        .await
        .is_ok();
      if answered {
        watch.state.send_if_modified(|state| {
          let unanswered = *state == PageState::Unanswered;
          if unanswered {
            *state = PageState::Ready;
          }
          unanswered
        });
      }
      watch.enabling.store(false, Ordering::Release);
    });
  }

  /// A dialog event of this page. A browser may announce a dialog that opened
  /// before the watch, in answer to its `Page.enable`.
  fn take_dialog(&self, method: &str, params: &Value) {
    match method {
      "Page.javascriptDialogOpening" => {
        let dialog = OpenDialog::from_event(params);
        log::debug!("Page dialog opened type={}", dialog.kind);
        self.state.send_replace(PageState::Dialog(dialog));
      }
      "Page.javascriptDialogClosed" => {
        log::debug!("Page dialog closed");
        self.state.send_replace(PageState::Ready);
      }
      _ => {}
    }
  }
}

/// Watched pages, by [`CdpTarget::page_key`].
static WATCHES: LazyLock<Mutex<HashMap<String, Arc<PageWatch>>>> = LazyLock::new(Default::default);

/// The sockets of cloud sessions, by [`CdpTarget::pool_key`].
static LINKS: LazyLock<Mutex<HashMap<String, Arc<Link>>>> = LazyLock::new(Default::default);

/// One socket or page session is opened at a time, so two tools that touch a
/// new page together do not open two.
static OPENING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  mutex
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn registered(key: &str) -> Option<Arc<PageWatch>> {
  lock(&WATCHES).get(key).cloned()
}

/// The watch that `session` names on `link`.
fn watch_on(link: &Link, session: Option<&str>) -> Option<Arc<PageWatch>> {
  lock(&WATCHES)
    .values()
    .find(|watch| watch.link.serial == link.serial && watch.session.as_deref() == session)
    .cloned()
}

/// Stop watching the pages of `link` that `gone` names. Their connections
/// see the state end and stop counting on it.
fn drop_watches(link: &Link, gone: impl Fn(&PageWatch) -> bool) {
  lock(&WATCHES).retain(|_, watch| watch.link.serial != link.serial || !gone(watch));
}

/// Read one message off a link and update what is known.
fn take(link: &Link, message: &Value) {
  if link.reply(message) {
    return;
  }
  let params = message.get("params").unwrap_or(&Value::Null);
  match message.get("method").and_then(Value::as_str) {
    Some(method @ ("Page.javascriptDialogOpening" | "Page.javascriptDialogClosed")) => {
      let session = message.get("sessionId").and_then(Value::as_str);
      if let Some(watch) = watch_on(link, session) {
        watch.take_dialog(method, params);
      }
    }
    Some("Target.targetCreated" | "Target.targetInfoChanged") => {
      link.note_target(&params["targetInfo"]);
    }
    Some("Target.targetDestroyed") => {
      if let Some(page) = params["targetId"].as_str() {
        link.forget_target(page);
        drop_watches(link, |watch| watch.page.as_deref() == Some(page));
      }
    }
    Some("Target.detachedFromTarget") => {
      if let Some(session) = params["sessionId"].as_str() {
        drop_watches(link, |watch| watch.session.as_deref() == Some(session));
      }
    }
    _ => {}
  }
}

/// Keep `stream` open as a link, read for as long as it lives.
fn open_link(stream: crate::cdp_target::RelaySocket) -> Arc<Link> {
  let (mut sink, mut stream) = stream.split();
  let (outgoing, mut queued) = mpsc::unbounded_channel::<Message>();
  let link = Arc::new(Link::new(outgoing));
  tokio::spawn(async move {
    while let Some(message) = queued.recv().await {
      let closing = matches!(message, Message::Close(_));
      if sink.send(message).await.is_err() || closing {
        break;
      }
    }
    let _ = sink.close().await;
  });
  let reader = link.clone();
  tokio::spawn(async move {
    while let Some(frame) = stream.next().await {
      match frame {
        Ok(Message::Text(text)) => {
          if let Ok(message) = serde_json::from_str::<Value>(&text) {
            take(&reader, &message);
          }
        }
        Ok(Message::Close(_)) | Err(_) => break,
        Ok(_) => {}
      }
    }
    log::debug!("Page watch socket closed");
    lock(&LINKS).retain(|_, kept| kept.serial != reader.serial);
    drop_watches(&reader, |_| true);
    lock(&reader.replies).clear();
  });
  link
}

/// The dialog state of the page behind `key` ([`CdpTarget::page_key`]), when
/// the page is watched.
pub fn state_of(key: &str) -> Option<watch::Receiver<PageState>> {
  registered(key).map(|watch| watch.state.subscribe())
}

/// The page of a cloud session the tools drive, once the session's socket is
/// open: every connection to the session attaches to it.
pub fn remote_page(target: &CdpTarget) -> Option<String> {
  if !target.is_remote() {
    return None;
  }
  let link = lock(&LINKS).get(&target.pool_key()).cloned()?;
  link.page()
}

/// The key of the page the tools on `target` drive now.
fn current_key(target: &CdpTarget) -> Option<String> {
  if target.is_remote() {
    Some(target.page_key(Some(&remote_page(target)?)))
  } else {
    Some(target.pool_key())
  }
}

/// The dialog open on the page `target` names, when it is watched and one is.
pub fn open_dialog(target: &CdpTarget) -> Option<OpenDialog> {
  registered(&current_key(target)?).and_then(|watch| watch.state.borrow().dialog().cloned())
}

async fn ensure(target: &CdpTarget) -> Result<Arc<PageWatch>, CdpError> {
  if target.is_remote() {
    ensure_remote(target).await
  } else {
    ensure_local(target).await
  }
}

async fn ensure_local(target: &CdpTarget) -> Result<Arc<PageWatch>, CdpError> {
  let key = target.pool_key();
  if let Some(watch) = registered(&key) {
    return Ok(watch);
  }
  let _opening = OPENING.lock().await;
  if let Some(watch) = registered(&key) {
    return Ok(watch);
  }
  let (stream, _) = target.connect().await?.into_parts();
  let watch = Arc::new(PageWatch::new(open_link(stream), None, None));
  lock(&WATCHES).insert(key, watch.clone());
  watch.enable();
  Ok(watch)
}

/// The socket of a cloud session, opened and told to report the session's
/// targets the first time. The browser lists every target it has before it
/// answers, then reports each one that opens, changes or closes.
async fn link_of(target: &CdpTarget) -> Result<Arc<Link>, CdpError> {
  let key = target.pool_key();
  if let Some(link) = lock(&LINKS).get(&key).cloned() {
    return Ok(link);
  }
  let _opening = OPENING.lock().await;
  if let Some(link) = lock(&LINKS).get(&key).cloned() {
    return Ok(link);
  }
  let (stream, _) = target.connect_browser().await?.into_parts();
  let link = open_link(stream);
  if let Err(error) = link
    .call(
      None,
      "Target.setDiscoverTargets",
      serde_json::json!({ "discover": true }),
      ENABLE_WAIT,
    )
    .await
  {
    link.close();
    return Err(error);
  }
  lock(&LINKS).insert(key, link.clone());
  Ok(link)
}

async fn ensure_remote(target: &CdpTarget) -> Result<Arc<PageWatch>, CdpError> {
  let link = link_of(target).await?;
  let page = link
    .page()
    .ok_or_else(|| CdpError::NotDrivable("the remote browser has no page open".to_string()))?;
  let key = target.page_key(Some(&page));
  if let Some(watch) = registered(&key) {
    return Ok(watch);
  }
  let _opening = OPENING.lock().await;
  if let Some(watch) = registered(&key) {
    return Ok(watch);
  }
  let attached = link
    .call(
      None,
      "Target.attachToTarget",
      serde_json::json!({ "targetId": page, "flatten": true }),
      ENABLE_WAIT,
    )
    .await?;
  let session = attached
    .get("sessionId")
    .and_then(Value::as_str)
    .ok_or_else(|| CdpError::Protocol("Target.attachToTarget returned no sessionId".to_string()))?;
  let watch = Arc::new(PageWatch::new(link, Some(session.to_string()), Some(page)));
  lock(&WATCHES).insert(key, watch.clone());
  watch.enable();
  Ok(watch)
}

/// Watch the page `target` names, opening the watch the first time, and say
/// what is known about it. A page that has not answered yet is given
/// [`ENABLE_WAIT`] to do so.
pub async fn watch(target: &CdpTarget) -> Result<PageState, CdpError> {
  let watch = ensure(target).await?;
  let mut state = watch.state.subscribe();
  if *state.borrow() == PageState::Unanswered {
    watch.enable();
    let _ = tokio::time::timeout(
      ENABLE_WAIT,
      state.wait_for(|now| *now != PageState::Unanswered),
    )
    .await;
  }
  let now = state.borrow().clone();
  Ok(now)
}

/// A dialog that was answered, and the one the page opened next, if any.
#[derive(Debug)]
pub struct Answered {
  pub dialog: OpenDialog,
  pub next: Option<OpenDialog>,
}

/// Why a dialog could not be answered.
#[derive(Debug)]
pub enum AnswerError {
  /// No dialog is open.
  NoDialog,
  /// The page does not answer, and no dialog was seen opening on it.
  Unanswered,
  Cdp(CdpError),
}

/// Accept or dismiss the dialog open on the page `target` names. A prompt that
/// is accepted takes `prompt_text`, or keeps its default text.
pub async fn answer(
  target: &CdpTarget,
  accept: bool,
  prompt_text: Option<&str>,
) -> Result<Answered, AnswerError> {
  let state = watch(target).await.map_err(AnswerError::Cdp)?;
  let dialog = match state {
    PageState::Dialog(dialog) => dialog,
    PageState::Ready => return Err(AnswerError::NoDialog),
    PageState::Unanswered => return Err(AnswerError::Unanswered),
  };
  let watch = ensure(target).await.map_err(AnswerError::Cdp)?;
  let mut params = serde_json::json!({ "accept": accept });
  if let Some(text) = prompt_text {
    params["promptText"] = Value::from(text);
  }
  let mut state = watch.state.subscribe();
  match watch
    .call("Page.handleJavaScriptDialog", params, ANSWER_WAIT)
    .await
  {
    Ok(_) => {}
    // The person answered it in the window first.
    Err(CdpError::Protocol(message)) if message.contains("No dialog is showing") => {
      return Err(AnswerError::NoDialog)
    }
    Err(error) => return Err(AnswerError::Cdp(error)),
  }
  let answered = PageState::Dialog(dialog.clone());
  let _ = tokio::time::timeout(CLOSE_WAIT, state.wait_for(|now| *now != answered)).await;
  if state.borrow().dialog().is_none() {
    tokio::time::sleep(NEXT_DIALOG_WAIT).await;
  }
  let next = state.borrow().dialog().cloned();
  Ok(Answered { dialog, next })
}

#[cfg(test)]
pub(crate) mod test_support {
  use super::*;

  /// Register a watch with no socket behind it that reports `state`, so the
  /// connections to `target` behave as on a page in that state.
  pub(crate) fn hold(target: &CdpTarget, state: PageState) -> Arc<PageWatch> {
    let (outgoing, _) = mpsc::unbounded_channel();
    let watch = Arc::new(PageWatch::new(Arc::new(Link::new(outgoing)), None, None));
    watch.state.send_replace(state);
    lock(&WATCHES).insert(target.pool_key(), watch.clone());
    watch
  }

  pub(crate) fn release(target: &CdpTarget) {
    lock(&WATCHES).remove(&target.pool_key());
  }

  pub(crate) fn dialog(kind: &str, message: &str) -> OpenDialog {
    OpenDialog::from_event(&serde_json::json!({
      "type": kind, "message": message, "defaultPrompt": "", "url": "http://fixture.test/"
    }))
  }
}

#[cfg(test)]
mod tests {
  use super::test_support::dialog;
  use super::*;
  use futures_util::stream::StreamExt;

  #[test]
  fn a_dialog_event_is_read_into_the_state_and_its_close_clears_it() {
    let (outgoing, _) = mpsc::unbounded_channel();
    let link = Arc::new(Link::new(outgoing));
    let watch = Arc::new(PageWatch::new(link.clone(), None, None));
    lock(&WATCHES).insert("read-test".to_string(), watch.clone());
    watch.state.send_replace(PageState::Ready);
    take(
      &link,
      &serde_json::json!({
        "method": "Page.javascriptDialogOpening",
        "params": { "type": "prompt", "message": "Your name?", "defaultPrompt": "Ann", "url": "http://a.test/", "hasBrowserHandler": true }
      }),
    );
    let open = watch
      .state
      .borrow()
      .dialog()
      .cloned()
      .expect("a dialog is open");
    assert_eq!(
      (
        open.kind.as_str(),
        open.message.as_str(),
        open.default_prompt.as_str()
      ),
      ("prompt", "Your name?", "Ann")
    );
    take(
      &link,
      &serde_json::json!({ "method": "Page.javascriptDialogClosed", "params": { "result": true } }),
    );
    assert_eq!(*watch.state.borrow(), PageState::Ready);
    lock(&WATCHES).remove("read-test");
  }

  #[test]
  fn the_refusal_names_the_dialog_and_quotes_a_clipped_message() {
    assert_eq!(
      dialog("alert", "Validation error: name is required").refusal(),
      "An alert dialog that says \"Validation error: name is required\" is open on the page. The page does nothing else until the dialog is answered."
    );
    assert!(dialog("beforeunload", "")
      .refusal()
      .starts_with("A \"leave this page?\" dialog is open"));
    let long = dialog("confirm", &"x".repeat(5_000));
    assert_eq!(long.message.chars().count(), MAX_MESSAGE_CHARS + 1);
    assert!(long.describe().chars().count() < QUOTED_CHARS + 40);
  }

  #[test]
  fn a_dialog_the_browser_did_not_describe_is_still_named_as_one() {
    assert_eq!(
      OpenDialog::unknown().refusal(),
      "A dialog is open on the page. The page does nothing else until the dialog is answered."
    );
  }

  #[test]
  fn only_what_the_browser_answers_itself_passes_a_dialog() {
    for method in [
      "Page.handleJavaScriptDialog",
      "Vellum.release",
      "Target.getTargets",
    ] {
      assert!(answered_during_dialog(method), "{method}");
    }
    for method in [
      "Runtime.evaluate",
      "Page.enable",
      "Page.navigate",
      "Input.dispatchKeyEvent",
      "Vellum.strike",
    ] {
      assert!(!answered_during_dialog(method), "{method}");
    }
  }

  /// A page that answers `Page.enable` (unless `enable` is false), opens an
  /// alert when told to evaluate `alert`, answers
  /// `Page.handleJavaScriptDialog`, and never answers any other command, the
  /// way a page held by a dialog does not. Dialog events reach every socket
  /// that turned the Page domain on, as in the browser.
  async fn fake_page(enable: bool) -> (CdpTarget, Arc<Mutex<Vec<Value>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let frames: Arc<Mutex<Vec<Value>>> = Arc::default();
    let recorded = frames.clone();
    let (events, _) = tokio::sync::broadcast::channel::<String>(16);
    tokio::spawn(async move {
      while let Ok((socket, _)) = listener.accept().await {
        let recorded = recorded.clone();
        let events = events.clone();
        tokio::spawn(async move {
          let Ok(stream) = tokio_tungstenite::accept_async(socket).await else {
            return;
          };
          let (sink, mut stream) = stream.split();
          let sink = Arc::new(tokio::sync::Mutex::new(sink));
          while let Some(Ok(Message::Text(text))) = stream.next().await {
            let request: Value = serde_json::from_str(&text).unwrap_or_default();
            lock(&recorded).push(request.clone());
            let id = request["id"].clone();
            let reply = |result: Value| {
              Message::Text(
                serde_json::json!({ "id": id, "result": result })
                  .to_string()
                  .into(),
              )
            };
            match request["method"].as_str().unwrap_or_default() {
              "Page.enable" => {
                let mut subscribed = events.subscribe();
                let forward = sink.clone();
                tokio::spawn(async move {
                  while let Ok(event) = subscribed.recv().await {
                    if forward
                      .lock()
                      .await
                      .send(Message::Text(event.into()))
                      .await
                      .is_err()
                    {
                      break;
                    }
                  }
                });
                if enable {
                  let _ = sink.lock().await.send(reply(serde_json::json!({}))).await;
                }
              }
              "Runtime.evaluate" if request["params"]["expression"] == "alert" => {
                let _ = sink
                  .lock()
                  .await
                  .send(reply(
                    serde_json::json!({ "result": { "type": "undefined" } }),
                  ))
                  .await;
                let _ = events.send(
                  serde_json::json!({
                    "method": "Page.javascriptDialogOpening",
                    "params": { "type": "alert", "message": "Saved?", "defaultPrompt": "", "url": "http://a.test/" }
                  })
                  .to_string(),
                );
              }
              // The page goes away, as a closed tab's socket does.
              "Runtime.evaluate" if request["params"]["expression"] == "close" => {
                let _ = sink.lock().await.close().await;
                break;
              }
              "Page.handleJavaScriptDialog" => {
                let _ = sink.lock().await.send(reply(serde_json::json!({}))).await;
                let _ = events.send(
                  serde_json::json!({ "method": "Page.javascriptDialogClosed", "params": { "result": true, "userInput": "" } })
                    .to_string(),
                );
              }
              _ => {}
            }
          }
        });
      }
    });
    let target = CdpTarget::Local {
      ws_url: format!("ws://127.0.0.1:{port}/devtools/page/fake"),
    };
    (target, frames)
  }

  #[tokio::test]
  async fn a_dialog_fails_the_next_command_at_once_and_handle_ends_it() {
    let (target, frames) = fake_page(true).await;
    assert_eq!(watch(&target).await.unwrap(), PageState::Ready);

    let mut connection = target.connect().await.unwrap();
    connection
      .call(
        1,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "alert" }),
      )
      .await
      .unwrap();
    let opened = tokio::time::timeout(Duration::from_secs(2), async {
      while open_dialog(&target).is_none() {
        tokio::time::sleep(Duration::from_millis(10)).await;
      }
    })
    .await;
    assert!(opened.is_ok(), "the watch saw the dialog open");

    let started = tokio::time::Instant::now();
    let refused = connection
      .call(
        2,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "1" }),
      )
      .await;
    assert!(matches!(refused, Err(CdpError::DialogOpen(ref d)) if d.message == "Saved?"));
    assert!(
      started.elapsed() < Duration::from_millis(200),
      "refused before it was sent"
    );
    assert!(
      !lock(&frames)
        .iter()
        .any(|frame| frame["id"] == 2 && frame["method"] == "Runtime.evaluate"),
      "a refused command never reaches the page"
    );

    let answered = answer(&target, true, None).await.unwrap();
    assert_eq!(answered.dialog.kind, "alert");
    assert!(answered.next.is_none());
    assert!(open_dialog(&target).is_none());
    assert!(matches!(
      answer(&target, true, None).await,
      Err(AnswerError::NoDialog)
    ));
    lock(&WATCHES).remove(&target.pool_key());
  }

  #[tokio::test]
  async fn a_reply_cut_short_by_a_dialog_ends_within_the_grace() {
    let (target, _frames) = fake_page(true).await;
    watch(&target).await.unwrap();
    let mut connection = target.connect().await.unwrap();
    connection
      .send_command(
        7,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "1" }),
      )
      .await
      .unwrap();
    let held = registered(&target.pool_key()).unwrap();
    held
      .state
      .send_replace(PageState::Dialog(dialog("confirm", "Leave?")));
    let started = tokio::time::Instant::now();
    let result = connection.await_reply(7, Duration::from_secs(60)).await;
    assert!(matches!(result, Err(CdpError::DialogOpen(_))));
    assert!(started.elapsed() < Duration::from_secs(5));
    lock(&WATCHES).remove(&target.pool_key());
  }

  #[tokio::test]
  async fn a_page_that_never_answers_is_reported_unanswered_not_waited_on() {
    let (target, _frames) = fake_page(false).await;
    let started = tokio::time::Instant::now();
    assert_eq!(watch(&target).await.unwrap(), PageState::Unanswered);
    assert!(started.elapsed() < ENABLE_WAIT + Duration::from_secs(1));
    assert!(matches!(
      answer(&target, true, None).await,
      Err(AnswerError::Unanswered)
    ));
    lock(&WATCHES).remove(&target.pool_key());
  }

  #[tokio::test]
  async fn a_dialog_announced_before_the_enable_reply_is_answered_without_it() {
    // A browser that announces an open dialog to a new client still answers
    // that client's Page.enable only after the dialog closes.
    let (target, _frames) = fake_page(false).await;
    let watch_open = tokio::spawn({
      let target = target.clone();
      async move { watch(&target).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut connection = target.connect().await.unwrap();
    connection
      .send_command(
        1,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "alert" }),
      )
      .await
      .unwrap();
    let started = tokio::time::Instant::now();
    let state = watch_open.await.unwrap().unwrap();
    assert!(
      matches!(state, PageState::Dialog(ref d) if d.message == "Saved?"),
      "{state:?}"
    );
    assert!(started.elapsed() < ENABLE_WAIT, "the event ends the wait");
    let answered = answer(&target, false, None).await.unwrap();
    assert_eq!(answered.dialog.kind, "alert");
    lock(&WATCHES).remove(&target.pool_key());
  }

  #[tokio::test]
  async fn a_closed_page_drops_its_watch() {
    let (target, _frames) = fake_page(true).await;
    watch(&target).await.unwrap();
    let watch = registered(&target.pool_key()).unwrap();
    watch
      .link
      .send(
        None,
        99,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "close" }),
      )
      .unwrap();
    drop(watch);
    let gone = tokio::time::timeout(Duration::from_secs(2), async {
      while registered(&target.pool_key()).is_some() {
        tokio::time::sleep(Duration::from_millis(10)).await;
      }
    })
    .await;
    assert!(gone.is_ok());
  }

  /// A browser behind page sockets and relay sockets: pages, flat sessions,
  /// target discovery, and alerts that hold their page. A command to a page
  /// an alert holds is never answered. With `reannounce`, a session that turns
  /// the Page domain on while an alert is open is told of the alert at once;
  /// its `Page.enable` is answered when the alert closes, in either case.
  #[derive(Default)]
  struct Browser {
    /// Pages, in the order `Target.getTargets` lists them.
    pages: Vec<String>,
    /// The message of the alert open on a page.
    alerts: HashMap<String, String>,
    sockets: Vec<FakeSocket>,
    reannounce: bool,
    /// Every request, with the socket it came on.
    requests: Vec<(usize, Value)>,
    next_page: u32,
  }

  struct FakeSocket {
    out: mpsc::UnboundedSender<Option<String>>,
    /// The page a page socket is on.
    page: Option<String>,
    /// Flat sessions and their pages.
    sessions: HashMap<String, String>,
    /// Sessions with the Page domain on; "" is the page socket itself.
    enabled: Vec<String>,
    /// `Page.enable` answers an alert holds back: (session, id).
    held: Vec<(String, Value)>,
    discover: bool,
  }

  fn frame(session: &str, body: Value) -> Value {
    let mut body = body;
    if !session.is_empty() {
      body["sessionId"] = Value::from(session);
    }
    body
  }

  impl Browser {
    fn send(&self, socket: usize, frame: Value) {
      let _ = self.sockets[socket].out.send(Some(frame.to_string()));
    }

    fn info(page: &str) -> Value {
      serde_json::json!({ "targetId": page, "type": "page", "url": format!("http://{page}.test/"), "attached": false })
    }

    /// Send `method` to every session with the Page domain on `page`.
    fn to_page(&self, page: &str, method: &str, params: Value) {
      for (index, socket) in self.sockets.iter().enumerate() {
        for key in &socket.enabled {
          let on_page = if key.is_empty() {
            socket.page.as_deref() == Some(page)
          } else {
            socket.sessions.get(key).map(String::as_str) == Some(page)
          };
          if on_page {
            self.send(
              index,
              frame(
                key,
                serde_json::json!({ "method": method, "params": params }),
              ),
            );
          }
        }
      }
    }

    fn alert_event(message: &str) -> Value {
      serde_json::json!({ "type": "alert", "message": message, "defaultPrompt": "", "url": "http://a.test/" })
    }

    fn open_alert(&mut self, page: &str, message: &str) {
      self.alerts.insert(page.to_string(), message.to_string());
      self.to_page(
        page,
        "Page.javascriptDialogOpening",
        Self::alert_event(message),
      );
    }

    fn close_alert(&mut self, page: &str) {
      if self.alerts.remove(page).is_none() {
        return;
      }
      self.to_page(
        page,
        "Page.javascriptDialogClosed",
        serde_json::json!({ "result": true, "userInput": "" }),
      );
      for index in 0..self.sockets.len() {
        let socket = &mut self.sockets[index];
        let page_socket = socket.page.clone();
        let sessions = socket.sessions.clone();
        let (released, kept): (Vec<_>, Vec<_>) = socket.held.drain(..).partition(|(key, _)| {
          if key.is_empty() {
            page_socket.as_deref() == Some(page)
          } else {
            sessions.get(key).map(String::as_str) == Some(page)
          }
        });
        socket.held = kept;
        for (key, id) in released {
          self.send(
            index,
            frame(&key, serde_json::json!({ "id": id, "result": {} })),
          );
        }
      }
    }

    fn close_page(&mut self, page: &str) {
      self.close_alert(page);
      self.pages.retain(|known| known != page);
      for index in 0..self.sockets.len() {
        let gone: Vec<String> = self.sockets[index]
          .sessions
          .iter()
          .filter(|(_, on)| on.as_str() == page)
          .map(|(session, _)| session.clone())
          .collect();
        for session in gone {
          self.sockets[index].sessions.remove(&session);
          self.send(
            index,
            serde_json::json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": session, "targetId": page } }),
          );
        }
        if self.sockets[index].discover {
          self.send(
            index,
            serde_json::json!({ "method": "Target.targetDestroyed", "params": { "targetId": page } }),
          );
        }
        if self.sockets[index].page.as_deref() == Some(page) {
          let _ = self.sockets[index].out.send(None);
        }
      }
    }

    fn handle(&mut self, socket: usize, request: Value) {
      self.requests.push((socket, request.clone()));
      let id = request["id"].clone();
      let session = request["sessionId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
      let params = &request["params"];
      let reply =
        |result: Value| frame(&session, serde_json::json!({ "id": id, "result": result }));
      let page = if session.is_empty() {
        self.sockets[socket].page.clone()
      } else {
        match self.sockets[socket].sessions.get(&session) {
          Some(page) => Some(page.clone()),
          None => {
            self.send(
              socket,
              frame(
                &session,
                serde_json::json!({ "id": id, "error": { "code": -32001, "message": "Session with given id not found." } }),
              ),
            );
            return;
          }
        }
      };
      match request["method"].as_str().unwrap_or_default() {
        "Target.getTargets" => {
          let infos: Vec<Value> = self.pages.iter().map(|page| Self::info(page)).collect();
          self.send(socket, reply(serde_json::json!({ "targetInfos": infos })));
        }
        "Target.setDiscoverTargets" => {
          for page in self.pages.clone() {
            self.send(
              socket,
              serde_json::json!({ "method": "Target.targetCreated", "params": { "targetInfo": Self::info(&page) } }),
            );
          }
          self.sockets[socket].discover = true;
          self.send(socket, reply(serde_json::json!({})));
        }
        "Target.attachToTarget" => {
          let wanted = params["targetId"].as_str().unwrap_or_default().to_string();
          if !self.pages.contains(&wanted) {
            self.send(
              socket,
              serde_json::json!({ "id": id, "error": { "code": -32602, "message": "No target with given id found" } }),
            );
            return;
          }
          let session = format!("S{socket}-{}", self.sockets[socket].sessions.len() + 1);
          self.sockets[socket]
            .sessions
            .insert(session.clone(), wanted);
          self.send(socket, reply(serde_json::json!({ "sessionId": session })));
        }
        "Target.createTarget" => {
          self.next_page += 1;
          let page = format!("N{}", self.next_page);
          self.pages.push(page.clone());
          for index in 0..self.sockets.len() {
            if self.sockets[index].discover {
              self.send(
                index,
                serde_json::json!({ "method": "Target.targetCreated", "params": { "targetInfo": Self::info(&page) } }),
              );
            }
          }
          self.send(socket, reply(serde_json::json!({ "targetId": page })));
        }
        "Page.enable" => {
          let page = page.unwrap_or_default();
          self.sockets[socket].enabled.push(session.clone());
          match self.alerts.get(&page).cloned() {
            Some(message) => {
              if self.reannounce {
                self.send(
                  socket,
                  frame(
                    &session,
                    serde_json::json!({ "method": "Page.javascriptDialogOpening", "params": Self::alert_event(&message) }),
                  ),
                );
              }
              self.sockets[socket].held.push((session, id));
            }
            None => self.send(socket, reply(serde_json::json!({}))),
          }
        }
        "Page.handleJavaScriptDialog" => {
          let page = page.unwrap_or_default();
          if self.alerts.contains_key(&page) {
            self.send(socket, reply(serde_json::json!({})));
            self.close_alert(&page);
          } else {
            self.send(
              socket,
              frame(
                &session,
                serde_json::json!({ "id": id, "error": { "code": -32000, "message": "No dialog is showing" } }),
              ),
            );
          }
        }
        "Runtime.evaluate" => {
          let page = page.unwrap_or_default();
          if self.alerts.contains_key(&page) {
            return;
          }
          if params["expression"] == "alert" {
            self.send(
              socket,
              reply(serde_json::json!({ "result": { "type": "undefined" } })),
            );
            self.open_alert(&page, "Saved?");
          } else {
            self.send(
              socket,
              reply(serde_json::json!({ "result": { "type": "string", "value": page } })),
            );
          }
        }
        _ => self.send(socket, reply(serde_json::json!({}))),
      }
    }
  }

  /// Serve a [`Browser`] with `pages`. `/devtools/page/<id>` is a page
  /// socket; any other path is the browser, as a relay is.
  async fn serve_browser(pages: &[&str], reannounce: bool) -> (u16, Arc<Mutex<Browser>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let browser = Arc::new(Mutex::new(Browser {
      pages: pages.iter().map(|page| page.to_string()).collect(),
      reannounce,
      ..Browser::default()
    }));
    let served = browser.clone();
    tokio::spawn(async move {
      while let Ok((socket, _)) = listener.accept().await {
        let browser = served.clone();
        tokio::spawn(async move {
          let path = Arc::new(Mutex::new(String::new()));
          let seen = path.clone();
          #[allow(clippy::result_large_err)]
          let callback =
            move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                  response| {
              *lock(&seen) = request.uri().path().to_string();
              Ok(response)
            };
          let Ok(stream) = tokio_tungstenite::accept_hdr_async(socket, callback).await else {
            return;
          };
          let page = lock(&path)
            .strip_prefix("/devtools/page/")
            .map(str::to_string);
          let (mut sink, mut stream) = stream.split();
          let (out, mut queued) = mpsc::unbounded_channel::<Option<String>>();
          let index = {
            let mut browser = lock(&browser);
            browser.sockets.push(FakeSocket {
              out,
              page,
              sessions: HashMap::new(),
              enabled: Vec::new(),
              held: Vec::new(),
              discover: false,
            });
            browser.sockets.len() - 1
          };
          tokio::spawn(async move {
            while let Some(Some(text)) = queued.recv().await {
              if sink.send(Message::Text(text.into())).await.is_err() {
                return;
              }
            }
            let _ = sink.close().await;
          });
          while let Some(Ok(Message::Text(text))) = stream.next().await {
            if let Ok(request) = serde_json::from_str::<Value>(&text) {
              lock(&browser).handle(index, request);
            }
          }
        });
      }
    });
    (port, browser)
  }

  fn cloud_session(port: u16, session: &str) -> CdpTarget {
    CdpTarget::Remote {
      ws_url: format!("ws://127.0.0.1:{port}/devtools/browser/fake"),
      bearer: "token".to_string(),
      session_id: session.to_string(),
    }
  }

  async fn where_is(connection: &mut crate::cdp_target::CdpConnection, id: u64) -> Value {
    connection
      .call(
        id,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "where" }),
      )
      .await
      .unwrap()["result"]["value"]
      .clone()
  }

  async fn until(what: &str, done: impl Fn() -> bool) {
    let waited = tokio::time::timeout(Duration::from_secs(3), async {
      while !done() {
        tokio::time::sleep(Duration::from_millis(10)).await;
      }
    })
    .await;
    assert!(waited.is_ok(), "{what}");
  }

  fn forget(target: &CdpTarget) {
    let key = target.pool_key();
    lock(&LINKS).remove(&key);
    lock(&WATCHES).retain(|kept, _| !kept.starts_with(&key));
  }

  #[tokio::test]
  async fn a_cloud_session_drives_one_pinned_page_and_watches_every_page_on_one_socket() {
    let (port, browser) = serve_browser(&["A", "B"], false).await;
    let target = cloud_session(port, "pinned");
    assert_eq!(watch(&target).await.unwrap(), PageState::Ready);

    // The browser lists its tabs in another order: the tools stay on the
    // watched page, and attach to it without asking for the list.
    lock(&browser).pages.reverse();
    let mut connection = target.connect().await.unwrap();
    assert_eq!(where_is(&mut connection, 1).await, "A");
    let socket = lock(&browser).sockets.len() - 1;
    assert!(!lock(&browser)
      .requests
      .iter()
      .any(|(on, request)| *on == socket && request["method"] == "Target.getTargets"));

    // An alert on it fails the next command of every connection at once.
    connection
      .call(
        2,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "alert" }),
      )
      .await
      .unwrap();
    until("the alert is seen", || open_dialog(&target).is_some()).await;
    let started = tokio::time::Instant::now();
    assert!(matches!(
      where_is_result(&mut connection, 3).await,
      Err(CdpError::DialogOpen(ref d)) if d.message == "Saved?"
    ));
    let mut other = target.connect().await.unwrap();
    assert!(matches!(
      where_is_result(&mut other, 1).await,
      Err(CdpError::DialogOpen(_))
    ));
    assert!(started.elapsed() < Duration::from_millis(500));

    // The page closes with its alert open: the tools move to the page left,
    // which no dialog holds, and its dialogs are seen on the same socket.
    lock(&browser).close_page("A");
    let page_a = target.page_key(Some("A"));
    until("the closed page is no longer watched", || {
      registered(&page_a).is_none()
    })
    .await;
    assert_eq!(watch(&target).await.unwrap(), PageState::Ready);
    assert_eq!(remote_page(&target).as_deref(), Some("B"));
    let mut moved = target.connect().await.unwrap();
    assert_eq!(where_is(&mut moved, 1).await, "B");
    moved
      .call(
        2,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "alert" }),
      )
      .await
      .unwrap();
    until("the second alert is seen", || {
      open_dialog(&target).is_some()
    })
    .await;
    let answered = answer(&target, true, None).await.unwrap();
    assert_eq!(answered.dialog.message, "Saved?");
    assert_eq!(where_is(&mut moved, 3).await, "B");

    let browser = lock(&browser);
    let watching: std::collections::HashSet<usize> = browser
      .requests
      .iter()
      .filter(|(_, request)| request["method"] == "Page.enable")
      .map(|(on, _)| *on)
      .collect();
    assert_eq!(watching.len(), 1, "one socket watches both pages");
    drop(browser);
    forget(&target);
  }

  async fn where_is_result(
    connection: &mut crate::cdp_target::CdpConnection,
    id: u64,
  ) -> Result<Value, CdpError> {
    connection
      .call(
        id,
        "Runtime.evaluate",
        serde_json::json!({ "expression": "where" }),
      )
      .await
  }

  #[tokio::test]
  async fn a_dialog_announced_again_to_a_new_watch_is_seen_at_once_and_answered() {
    // A browser may tell a session that turns the Page domain on about a
    // dialog that opened before it, and answer its Page.enable only after the
    // dialog closes.
    for remote in [false, true] {
      let (port, browser) = serve_browser(&["A"], true).await;
      lock(&browser).open_alert("A", "Opened before");
      let target = if remote {
        cloud_session(port, "reannounced")
      } else {
        CdpTarget::Local {
          ws_url: format!("ws://127.0.0.1:{port}/devtools/page/A"),
        }
      };
      let started = tokio::time::Instant::now();
      let state = watch(&target).await.unwrap();
      assert!(
        matches!(state, PageState::Dialog(ref d) if d.message == "Opened before"),
        "remote={remote} {state:?}"
      );
      assert!(
        started.elapsed() < Duration::from_secs(1),
        "remote={remote}"
      );

      let mut connection = target.connect().await.unwrap();
      assert!(matches!(
        where_is_result(&mut connection, 1).await,
        Err(CdpError::DialogOpen(_))
      ));
      let answered = answer(&target, false, None).await.unwrap();
      assert_eq!(answered.dialog.message, "Opened before");
      assert!(answered.next.is_none());
      // The Page.enable answer that comes with the close changes nothing.
      tokio::time::sleep(Duration::from_millis(100)).await;
      assert_eq!(watch(&target).await.unwrap(), PageState::Ready);
      assert_eq!(where_is(&mut connection, 2).await, "A");
      forget(&target);
    }
  }
}
