//! Native dialogs (alert, confirm, prompt, "leave this page?") on the pages the
//! agent tools drive.
//!
//! While such a dialog is open the page runs no script and answers no command
//! that needs it. Only a CDP session whose Page domain was on when the dialog
//! opened can answer it; a session opened later cannot even turn the domain on.
//! So the first time a tool touches a page, a socket with the Page domain on is
//! opened to it and kept for as long as the page lives. It sees each dialog open
//! and close, answers one when asked, and lets every other connection to the
//! page fail at once instead of waiting for a reply that cannot come.

use crate::cdp_target::{cdp_frame, CdpError, CdpTarget};
use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

/// How long a new watch waits for the page to turn its Page domain on.
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
#[derive(Debug, Clone, PartialEq, Serialize)]
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

/// The kept socket to one page.
pub struct PageWatch {
  serial: u64,
  outgoing: mpsc::UnboundedSender<Message>,
  session: Option<String>,
  replies: Replies,
  state: watch::Sender<PageState>,
  next_id: AtomicU64,
  /// A `Page.enable` is waiting for its answer.
  enabling: std::sync::atomic::AtomicBool,
}

impl PageWatch {
  fn new(outgoing: mpsc::UnboundedSender<Message>, session: Option<String>) -> Self {
    Self {
      serial: WATCH_SERIAL.fetch_add(1, Ordering::Relaxed),
      outgoing,
      session,
      replies: Mutex::default(),
      state: watch::Sender::new(PageState::Unanswered),
      next_id: AtomicU64::new(1),
      enabling: std::sync::atomic::AtomicBool::new(false),
    }
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

  fn send(&self, id: u64, method: &str, params: Value) -> Result<(), CdpError> {
    let frame = cdp_frame(self.session.as_deref(), id, method, params);
    self
      .outgoing
      .send(Message::Text(frame.to_string().into()))
      .map_err(|_| CdpError::Transport("the page's watch socket is closed".to_string()))
  }

  async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, CdpError> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    lock(&self.replies).insert(id, tx);
    if let Err(error) = self.send(id, method, params) {
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

  /// Read one message off the page and update what is known.
  fn take(&self, message: &Value) {
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
      if let Some(waiter) = lock(&self.replies).remove(&id) {
        let reply = match message.get("error") {
          Some(error) => Err(CdpError::Protocol(error.to_string())),
          None => Ok(message.get("result").cloned().unwrap_or_default()),
        };
        let _ = waiter.send(reply);
      }
      return;
    }
    match message.get("method").and_then(Value::as_str) {
      Some("Page.javascriptDialogOpening") => {
        let dialog = OpenDialog::from_event(message.get("params").unwrap_or(&Value::Null));
        log::debug!("Page dialog opened type={}", dialog.kind);
        self.state.send_replace(PageState::Dialog(dialog));
      }
      Some("Page.javascriptDialogClosed") => {
        log::debug!("Page dialog closed");
        self.state.send_replace(PageState::Ready);
      }
      _ => {}
    }
  }
}

static WATCH_SERIAL: AtomicU64 = AtomicU64::new(1);

static WATCHES: LazyLock<Mutex<HashMap<String, Arc<PageWatch>>>> = LazyLock::new(Default::default);

/// One watch is opened at a time, so two tools that touch a new page together
/// do not open two.
static OPENING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  mutex
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn registered(key: &str) -> Option<Arc<PageWatch>> {
  lock(&WATCHES).get(key).cloned()
}

/// The dialog state of the page behind `key` (a target's pool key), when the
/// page is watched.
pub fn state_of(key: &str) -> Option<watch::Receiver<PageState>> {
  registered(key).map(|watch| watch.state.subscribe())
}

/// The dialog open on the page `target` names, when it is watched and one is.
pub fn open_dialog(target: &CdpTarget) -> Option<OpenDialog> {
  registered(&target.pool_key()).and_then(|watch| watch.state.borrow().dialog().cloned())
}

async fn ensure(target: &CdpTarget) -> Result<Arc<PageWatch>, CdpError> {
  let key = target.pool_key();
  if let Some(watch) = registered(&key) {
    return Ok(watch);
  }
  let _opening = OPENING.lock().await;
  if let Some(watch) = registered(&key) {
    return Ok(watch);
  }
  let (stream, session) = target.connect().await?.into_parts();
  let (mut sink, mut stream) = stream.split();
  let (outgoing, mut queued) = mpsc::unbounded_channel::<Message>();
  let watch = Arc::new(PageWatch::new(outgoing, session));
  lock(&WATCHES).insert(key.clone(), watch.clone());

  tokio::spawn(async move {
    while let Some(message) = queued.recv().await {
      if sink.send(message).await.is_err() {
        break;
      }
    }
    let _ = sink.close().await;
  });
  let reader = watch.clone();
  tokio::spawn(async move {
    while let Some(frame) = stream.next().await {
      match frame {
        Ok(Message::Text(text)) => {
          if let Ok(message) = serde_json::from_str::<Value>(&text) {
            reader.take(&message);
          }
        }
        Ok(Message::Close(_)) | Err(_) => break,
        Ok(_) => {}
      }
    }
    log::debug!("Page watch closed");
    lock(&WATCHES).retain(|_, kept| kept.serial != reader.serial);
    lock(&reader.replies).clear();
  });

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
    let watch = Arc::new(PageWatch::new(outgoing, None));
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
    let watch = PageWatch::new(outgoing, None);
    watch.state.send_replace(PageState::Ready);
    watch.take(&serde_json::json!({
      "method": "Page.javascriptDialogOpening",
      "params": { "type": "prompt", "message": "Your name?", "defaultPrompt": "Ann", "url": "http://a.test/", "hasBrowserHandler": true }
    }));
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
    watch.take(
      &serde_json::json!({ "method": "Page.javascriptDialogClosed", "params": { "result": true } }),
    );
    assert_eq!(*watch.state.borrow(), PageState::Ready);
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
      .send(
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
}
