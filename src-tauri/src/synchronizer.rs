use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;

use crate::log_redaction::ShortId;
use crate::profile::manager::ProfileManager;
use crate::profile::types::BrowserProfile;

/// Maximum number of profiles to launch concurrently
const MAX_CONCURRENT_LAUNCHES: usize = 5;

/// Event captured from the leader browser via Wayfern.inputCaptured CDP events.
/// Fields up to `timestamp` match the Wayfern.inputCaptured event schema; the
/// rest are added on the leader side before the event fans out.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapturedEvent {
  #[serde(rename = "type")]
  pub event_type: String,
  #[serde(default)]
  pub url: Option<String>,
  #[serde(default)]
  pub x: Option<f64>,
  #[serde(default)]
  pub y: Option<f64>,
  #[serde(default)]
  pub button: Option<String>,
  #[serde(default, rename = "clickCount")]
  pub click_count: Option<i32>,
  #[serde(default)]
  pub key: Option<String>,
  #[serde(default)]
  pub code: Option<String>,
  #[serde(default, rename = "windowsVirtualKeyCode")]
  pub key_code: Option<i32>,
  #[serde(default)]
  pub modifiers: Option<i32>,
  #[serde(default)]
  pub text: Option<String>,
  #[serde(default, rename = "deltaX")]
  pub delta_x: Option<f64>,
  #[serde(default, rename = "deltaY")]
  pub delta_y: Option<f64>,
  #[serde(default)]
  pub timestamp: Option<f64>,
  /// Where a pointer event landed on the leader, for followers whose layout
  /// differs.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub anchor: Option<PointAnchor>,
  /// "navigated": the leader got there without an input just before it,
  /// which is what typing an address looks like.
  #[serde(default)]
  pub typed: Option<bool>,
  /// "dialogClosed": how the leader answered the dialog.
  #[serde(default)]
  pub accept: Option<bool>,
  #[serde(default, rename = "promptText")]
  pub prompt_text: Option<String>,
}

/// An element and a spot inside it, found on the leader and looked up again on
/// each follower, so a click lands on the same thing when text, scrollbars,
/// window size or a mobile layout put it somewhere else.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PointAnchor {
  /// Ids, tag names and :nth-of-type steps from the nearest id down.
  pub selector: String,
  /// Which of the element's content quads held the point (a wrapped link has
  /// one per line).
  pub quad: usize,
  /// Where in that quad, as fractions of its width and height.
  pub rx: f64,
  pub ry: f64,
  /// The quad's top and height on the leader, in viewport CSS pixels.
  pub top: f64,
  pub height: f64,
}

/// The bounding box of a CDP quad (eight numbers, four corners).
fn quad_box(quad: &[f64]) -> Option<(f64, f64, f64, f64)> {
  if quad.len() < 8 {
    return None;
  }
  let xs = [quad[0], quad[2], quad[4], quad[6]];
  let ys = [quad[1], quad[3], quad[5], quad[7]];
  let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
  let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
  Some((min(&xs), min(&ys), max(&xs), max(&ys)))
}

fn quads_of(value: &serde_json::Value) -> Vec<Vec<f64>> {
  value
    .get("quads")
    .and_then(|q| q.as_array())
    .map(|quads| {
      quads
        .iter()
        .filter_map(|q| q.as_array())
        .map(|q| q.iter().filter_map(|n| n.as_f64()).collect())
        .collect()
    })
    .unwrap_or_default()
}

/// The quad nearest to (x, y) and the point's place in it.
fn anchor_in_quads(selector: String, quads: &[Vec<f64>], x: f64, y: f64) -> Option<PointAnchor> {
  let mut best: Option<(usize, f64)> = None;
  for (index, quad) in quads.iter().enumerate() {
    let Some((left, top, right, bottom)) = quad_box(quad) else {
      continue;
    };
    let dx = (left - x).max(0.0).max(x - right);
    let dy = (top - y).max(0.0).max(y - bottom);
    let closer = match best {
      None => true,
      Some((_, distance)) => dx + dy < distance,
    };
    if closer {
      best = Some((index, dx + dy));
    }
  }
  let (quad, _) = best?;
  let (left, top, right, bottom) = quad_box(&quads[quad])?;
  let ratio = |v: f64, lo: f64, hi: f64| {
    if hi > lo {
      ((v - lo) / (hi - lo)).clamp(0.0, 1.0)
    } else {
      0.5
    }
  };
  Some(PointAnchor {
    selector,
    quad,
    rx: ratio(x, left, right),
    ry: ratio(y, top, bottom),
    top,
    height: bottom - top,
  })
}

/// Where an anchor lands among a follower's quads for the same element:
/// the point, and the quad's top and height.
fn point_in_quads(anchor: &PointAnchor, quads: &[Vec<f64>]) -> Option<(f64, f64, f64, f64)> {
  let quad = quads.get(anchor.quad).or_else(|| quads.last())?;
  let (left, top, right, bottom) = quad_box(quad)?;
  Some((
    left + anchor.rx * (right - left),
    top + anchor.ry * (bottom - top),
    top,
    bottom - top,
  ))
}

fn css_escape_ident(ident: &str) -> String {
  let mut out = String::with_capacity(ident.len());
  for (index, c) in ident.chars().enumerate() {
    let plain = c.is_ascii_alphanumeric() || c == '-' || c == '_' || !c.is_ascii();
    if plain && !(index == 0 && c.is_ascii_digit()) {
      out.push(c);
    } else {
      out.push_str(&format!("\\{:x} ", c as u32));
    }
  }
  out
}

/// A selector for the element `backend_node_id` names (or the element holding
/// it, for a text node) in a DOM.getDocument tree, and that element's id.
fn selector_for_node(root: &serde_json::Value, backend_node_id: i64) -> Option<(String, i64)> {
  fn find<'a>(
    node: &'a serde_json::Value,
    target: i64,
    path: &mut Vec<&'a serde_json::Value>,
  ) -> bool {
    path.push(node);
    if node.get("backendNodeId").and_then(|v| v.as_i64()) == Some(target) {
      return true;
    }
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
      for child in children {
        if find(child, target, path) {
          return true;
        }
      }
    }
    path.pop();
    false
  }
  let is_element =
    |node: &serde_json::Value| node.get("nodeType").and_then(|t| t.as_i64()) == Some(1);
  let attribute = |node: &serde_json::Value, name: &str| -> Option<String> {
    let list = node.get("attributes")?.as_array()?;
    list
      .chunks(2)
      .find(|pair| pair.first().and_then(|n| n.as_str()) == Some(name))
      .and_then(|pair| pair.get(1))
      .and_then(|v| v.as_str())
      .map(str::to_string)
  };
  let mut path = Vec::new();
  if !find(root, backend_node_id, &mut path) {
    return None;
  }
  // A hit on text belongs to the element around it.
  while path.last().is_some_and(|node| !is_element(node)) {
    path.pop();
  }
  let element_id = path.last()?.get("backendNodeId")?.as_i64()?;
  let mut steps: Vec<String> = Vec::new();
  for depth in (0..path.len()).rev() {
    let node = path[depth];
    if !is_element(node) {
      break;
    }
    if let Some(id) = attribute(node, "id").filter(|id| !id.is_empty()) {
      steps.push(format!("#{}", css_escape_ident(&id)));
      break;
    }
    let name = node.get("nodeName").and_then(|n| n.as_str()).unwrap_or("");
    let tag = node
      .get("localName")
      .and_then(|n| n.as_str())
      .filter(|n| !n.is_empty())
      .map(str::to_string)
      .unwrap_or_else(|| name.to_lowercase());
    if tag == "html" {
      steps.push(tag);
      break;
    }
    let position = depth
      .checked_sub(1)
      .and_then(|parent| path[parent].get("children"))
      .and_then(|c| c.as_array())
      .and_then(|siblings| {
        siblings
          .iter()
          .filter(|s| is_element(s) && s.get("nodeName").and_then(|n| n.as_str()) == Some(name))
          .position(|s| std::ptr::eq(s, node))
      })
      .map_or(1, |p| p + 1);
    steps.push(format!("{tag}:nth-of-type({position})"));
  }
  steps.reverse();
  Some((steps.join(" > "), element_id))
}

/// Whether two URLs show the same page: same origin and path. Queries and
/// fragments can carry per-session values, so they do not count.
fn same_page(a: &str, b: &str) -> bool {
  match (url::Url::parse(a), url::Url::parse(b)) {
    (Ok(a), Ok(b)) => a.origin() == b.origin() && a.path() == b.path(),
    _ => a == b,
  }
}

/// The editing command a Ctrl/Cmd shortcut runs. A key event sent by CDP does
/// not reach the macOS menu, and the shortcut key differs between macOS and the
/// other systems, so the command travels with the key.
fn shortcut_command(key: &str, shift: bool) -> Option<&'static str> {
  match (key.to_ascii_lowercase().as_str(), shift) {
    ("a", false) => Some("selectAll"),
    ("c", false) => Some("copy"),
    ("x", false) => Some("cut"),
    ("v", false) => Some("paste"),
    ("z", false) => Some("undo"),
    ("z", true) | ("y", false) => Some("redo"),
    _ => None,
  }
}

/// A wheel burst ends after this much quiet.
const WHEEL_BURST_IDLE: std::time::Duration = std::time::Duration::from_millis(150);
/// How long a follower may take to reach, by replaying the input, the page the
/// leader moved to before it is sent there.
const NAVIGATION_GRACE: std::time::Duration = std::time::Duration::from_secs(4);
/// How long a page that a follower was sent to may take to load.
const LOAD_GRACE: std::time::Duration = std::time::Duration::from_secs(6);
/// How long a click waits for its element, as on a page that is still loading.
const ANCHOR_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
/// How long a wheel waits for its element; a scroll is not worth a long stall.
const WHEEL_ANCHOR_WAIT: std::time::Duration = std::time::Duration::from_millis(300);
/// How long a follower waits for its own copy of the leader's dialog.
const DIALOG_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// The longest a reply is awaited. An open dialog holds the reply to an input
/// event until it closes.
const REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

type FollowerSocket =
  tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type PendingReplies =
  Arc<std::sync::Mutex<HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>>>;

/// What a follower's own page events say about where it is.
#[derive(Debug, Clone, Default, PartialEq)]
struct FollowerPage {
  main_frame: String,
  url: String,
  loaded: bool,
  dialog_open: bool,
}

fn apply_page_event(page: &mut FollowerPage, method: &str, params: &serde_json::Value) {
  let text = |path: &str| {
    params
      .pointer(path)
      .and_then(|v| v.as_str())
      .unwrap_or_default()
      .to_string()
  };
  match method {
    "Page.frameNavigated" if params.pointer("/frame/parentId").is_none() => {
      page.main_frame = text("/frame/id");
      page.url = text("/frame/url");
      page.loaded = false;
    }
    "Page.navigatedWithinDocument" if text("/frameId") == page.main_frame => {
      page.url = text("/url");
    }
    "Page.domContentEventFired" => page.loaded = true,
    "Page.javascriptDialogOpening" => page.dialog_open = true,
    "Page.javascriptDialogClosed" => page.dialog_open = false,
    _ => {}
  }
}

/// Where a follower stands against the page the leader moved to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Barrier {
  /// On that page and loaded: replay.
  Ready,
  /// Not there yet, and still in time to get there by itself.
  Wait,
  /// Out of time on another page: send it there.
  Navigate,
  /// Out of time on that page while it still loads: replay anyway.
  Proceed,
}

fn barrier(expected: &str, page: &FollowerPage, out_of_time: bool) -> Barrier {
  match (same_page(expected, &page.url), page.loaded, out_of_time) {
    (true, true, _) => Barrier::Ready,
    (_, _, false) => Barrier::Wait,
    (false, _, true) => Barrier::Navigate,
    (true, false, true) => Barrier::Proceed,
  }
}

/// How far to scroll down so the spot under the leader's pointer comes under
/// the same point here, given where the anchored quad is on this follower.
fn scroll_to_align(anchor: &PointAnchor, top: f64, height: f64) -> f64 {
  let here = top + anchor.ry * height;
  let there = anchor.top + anchor.ry * anchor.height;
  here - there
}

/// How editing shortcuts travel to a follower. The person at the leader uses
/// the host's shortcut key (Cmd on a Mac, Ctrl elsewhere); a page claiming
/// macOS or iOS expects Cmd; and on a Mac host a key event sent through CDP
/// never reaches the menu that runs the shortcut, so the command is sent with
/// the key there.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ShortcutEditing {
  follower_apple: bool,
  host_mac: bool,
}

impl ShortcutEditing {
  fn for_profile(follower: &BrowserProfile) -> Self {
    let follower_apple = follower
      .wayfern_config
      .as_ref()
      .and_then(|config| config.os.as_deref())
      .and_then(crate::wayfern_manager::WayfernManager::normalize_os_name)
      .is_some_and(|os| os == "macos" || os == "ios");
    Self {
      follower_apple,
      host_mac: cfg!(target_os = "macos"),
    }
  }

  /// The modifiers to send, and the editing command to send with them.
  fn map_shortcut(&self, key: &str, modifiers: i32, key_down: bool) -> (i32, Option<&'static str>) {
    const CTRL: i32 = 2;
    const META: i32 = 4;
    const SHIFT: i32 = 8;
    if modifiers & (CTRL | META) == 0 {
      return (modifiers, None);
    }
    let Some(command) = shortcut_command(key, modifiers & SHIFT != 0) else {
      return (modifiers, None);
    };
    let leader_shortcut = if self.host_mac { META } else { CTRL };
    if modifiers & leader_shortcut == 0 {
      return (modifiers, None);
    }
    let follower_shortcut = if self.follower_apple { META } else { CTRL };
    let mapped = (modifiers & !leader_shortcut) | follower_shortcut;
    let send_command = key_down && (self.follower_apple || self.host_mac);
    (mapped, send_command.then_some(command))
  }
}

/// The follower end of the replay: commands out, replies and page events in.
struct FollowerLink {
  sink: futures_util::stream::SplitSink<FollowerSocket, tokio_tungstenite::tungstenite::Message>,
  replies: PendingReplies,
  page: tokio::sync::watch::Receiver<FollowerPage>,
  page_tx: Arc<tokio::sync::watch::Sender<FollowerPage>>,
  next_id: u64,
}

impl FollowerLink {
  fn new(ws: FollowerSocket) -> Self {
    use futures_util::stream::StreamExt;
    let (sink, mut stream) = ws.split();
    let replies: PendingReplies = Arc::default();
    let (page_tx, page) = tokio::sync::watch::channel(FollowerPage::default());
    let page_tx = Arc::new(page_tx);
    let reader_replies = replies.clone();
    let reader_page = page_tx.clone();
    tokio::spawn(async move {
      while let Some(Ok(message)) = stream.next().await {
        let tokio_tungstenite::tungstenite::Message::Text(text) = message else {
          continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
          continue;
        };
        if let Some(id) = value.get("id").and_then(|id| id.as_u64()) {
          let waiter = reader_replies
            .lock()
            .ok()
            .and_then(|mut replies| replies.remove(&id));
          if let Some(waiter) = waiter {
            let _ = waiter.send(value);
          }
          continue;
        }
        let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = value.get("params").cloned().unwrap_or_default();
        reader_page.send_modify(|page| apply_page_event(page, method, &params));
      }
      // The socket is gone: nobody will answer the calls still waiting.
      if let Ok(mut replies) = reader_replies.lock() {
        replies.clear();
      }
    });
    Self {
      sink,
      replies,
      page,
      page_tx,
      next_id: 0,
    }
  }

  /// Send a command without waiting for its reply. Fails only when the socket
  /// is gone.
  async fn send(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
    use futures_util::sink::SinkExt;
    self.next_id += 1;
    let command = serde_json::json!({ "id": self.next_id, "method": method, "params": params });
    self
      .sink
      .send(tokio_tungstenite::tungstenite::Message::Text(
        command.to_string().into(),
      ))
      .await
      .map_err(|e| e.to_string())
  }

  /// Send a command and wait a bounded time for its result: Ok(None) when the
  /// browser refused it or did not answer in time, Err when the socket is gone.
  async fn call(
    &mut self,
    method: &str,
    params: serde_json::Value,
  ) -> Result<Option<serde_json::Value>, String> {
    self.call_within(method, params, REPLY_TIMEOUT).await
  }

  async fn call_within(
    &mut self,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
  ) -> Result<Option<serde_json::Value>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let id = self.next_id + 1;
    if let Ok(mut replies) = self.replies.lock() {
      replies.insert(id, tx);
    }
    self.send(method, params).await?;
    let reply = tokio::time::timeout(timeout, rx).await;
    if let Ok(mut replies) = self.replies.lock() {
      replies.remove(&id);
    }
    Ok(match reply {
      Ok(Ok(reply)) if reply.get("error").is_none() => reply.get("result").cloned(),
      _ => None,
    })
  }

  /// Where an anchor lands on this follower's page (point, quad top, quad
  /// height), waiting up to `wait` for the element to exist. Scrolls the
  /// element into view first when the point is outside the viewport.
  async fn resolve(
    &mut self,
    anchor: &PointAnchor,
    wait: std::time::Duration,
  ) -> Option<(f64, f64, f64, f64)> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
      if let Some(found) = self.resolve_once(anchor, deadline).await {
        return Some(found);
      }
      if tokio::time::Instant::now() >= deadline {
        return None;
      }
      tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    }
  }

  async fn resolve_once(
    &mut self,
    anchor: &PointAnchor,
    deadline: tokio::time::Instant,
  ) -> Option<(f64, f64, f64, f64)> {
    // Each query gets what is left of the wait, so a page that answers slowly
    // while it loads cannot stretch it.
    let left = || {
      deadline
        .saturating_duration_since(tokio::time::Instant::now())
        .clamp(std::time::Duration::from_millis(100), REPLY_TIMEOUT)
    };
    let document = self
      .call_within("DOM.getDocument", serde_json::json!({ "depth": 0 }), left())
      .await
      .ok()??;
    let root = document.pointer("/root/nodeId")?.as_i64()?;
    let found = self
      .call_within(
        "DOM.querySelector",
        serde_json::json!({ "nodeId": root, "selector": anchor.selector }),
        left(),
      )
      .await
      .ok()??;
    let node = found.get("nodeId")?.as_i64().filter(|id| *id > 0)?;
    let quads = self
      .call_within(
        "DOM.getContentQuads",
        serde_json::json!({ "nodeId": node }),
        left(),
      )
      .await
      .ok()??;
    let mut point = point_in_quads(anchor, &quads_of(&quads))?;
    let metrics = self
      .call_within("Page.getLayoutMetrics", serde_json::json!({}), left())
      .await
      .ok()??;
    let size = |key: &str| {
      metrics
        .pointer(&format!("/cssVisualViewport/{key}"))
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::MAX)
    };
    let (width, height) = (size("clientWidth"), size("clientHeight"));
    if point.0 < 0.0 || point.1 < 0.0 || point.0 >= width || point.1 >= height {
      let _ = self
        .call_within(
          "DOM.scrollIntoViewIfNeeded",
          serde_json::json!({ "nodeId": node }),
          left(),
        )
        .await;
      let quads = self
        .call_within(
          "DOM.getContentQuads",
          serde_json::json!({ "nodeId": node }),
          left(),
        )
        .await
        .ok()??;
      point = point_in_quads(anchor, &quads_of(&quads))?;
    }
    // Reading the document turned on DOM events, which nothing here uses.
    let _ = self.send("DOM.disable", serde_json::json!({})).await;
    Some(point)
  }

  /// Wait until this follower is on `url`, giving it `grace` to get there by
  /// itself; then send it there, unless it already was, and wait for the load.
  async fn reach(
    &mut self,
    url: &str,
    grace: std::time::Duration,
    already_sent: bool,
  ) -> Result<(), String> {
    let mut deadline = tokio::time::Instant::now() + grace;
    let mut sent = already_sent;
    loop {
      let page = self.page.borrow().clone();
      match barrier(url, &page, tokio::time::Instant::now() >= deadline) {
        Barrier::Ready | Barrier::Proceed => return Ok(()),
        Barrier::Navigate if sent => return Ok(()),
        Barrier::Navigate => {
          self
            .send("Page.navigate", serde_json::json!({ "url": url }))
            .await?;
          sent = true;
          deadline = tokio::time::Instant::now() + LOAD_GRACE;
        }
        Barrier::Wait => {
          let left = deadline.saturating_duration_since(tokio::time::Instant::now());
          let _ = tokio::time::timeout(left, self.page.changed()).await;
        }
      }
    }
  }
}

// No JavaScript injection needed — Wayfern.enableInputCapture handles everything natively.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFollowerState {
  pub profile_id: String,
  pub profile_name: String,
  /// None = healthy, Some(url) = desynced at this URL
  pub failed_at_url: Option<String>,
  /// Held out of the mirroring on purpose. The window stays open and usable;
  /// it simply stops receiving what the leader does until it is brought back.
  #[serde(default)]
  pub held: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSessionInfo {
  pub id: String,
  pub leader_profile_id: String,
  pub leader_profile_name: String,
  pub followers: Vec<SyncFollowerState>,
  /// Mirroring is suspended for the whole session, so the leader can be used
  /// on its own without every follower copying it.
  #[serde(default)]
  pub paused: bool,
}

/// How the follower windows are placed on the host display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowLayout {
  /// Even tiles, as square a grid as the count allows. Never overlapping.
  Grid,
  /// One full-height column per window, left to right.
  Columns,
  /// Stacked with a fixed offset, so every title bar stays reachable.
  Cascade,
}

/// A window position in the host display's CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WindowRect {
  pub left: i32,
  pub top: i32,
  pub width: u32,
  pub height: u32,
}

/// Smallest window an arrangement will ask for. Below this a browser window is
/// not usable, and Chromium clamps it anyway, which would break the "no
/// overlap" promise of the grid without anyone noticing.
const MIN_WINDOW_WIDTH: u32 = 240;
const MIN_WINDOW_HEIGHT: u32 = 180;

/// Cascade offsets, capped so a long session does not walk the last window off
/// the bottom of the display.
const CASCADE_MAX_STEP_X: u32 = 48;
const CASCADE_MAX_STEP_Y: u32 = 40;

/// Where each of `count` follower windows goes on a `screen_width` by
/// `screen_height` display.
///
/// Pure arithmetic on purpose: it is the part that can be wrong in a way no
/// screenshot would show, and it is the part a test can hold to "every window
/// is on the display, and the grid never overlaps".
pub fn layout_windows(
  layout: WindowLayout,
  count: usize,
  screen_width: u32,
  screen_height: u32,
) -> Vec<WindowRect> {
  if count == 0 || screen_width == 0 || screen_height == 0 {
    return Vec::new();
  }

  match layout {
    WindowLayout::Grid => {
      let columns = (count as f64).sqrt().ceil() as usize;
      let rows = count.div_ceil(columns);
      let cell_width = (screen_width / columns as u32).max(1);
      let cell_height = (screen_height / rows as u32).max(1);
      (0..count)
        .map(|index| {
          let column = index % columns;
          let row = index / columns;
          WindowRect {
            left: (column as u32 * cell_width) as i32,
            top: (row as u32 * cell_height) as i32,
            width: cell_width,
            height: cell_height,
          }
        })
        .collect()
    }
    WindowLayout::Columns => {
      let width = (screen_width / count as u32).max(1);
      (0..count)
        .map(|index| WindowRect {
          left: (index as u32 * width) as i32,
          top: 0,
          width,
          height: screen_height,
        })
        .collect()
    }
    WindowLayout::Cascade => {
      let width = (screen_width * 2 / 3).clamp(1, screen_width);
      let height = (screen_height * 2 / 3).clamp(1, screen_height);
      let steps = count.saturating_sub(1) as u32;
      // Spread the leftover room over the gaps, then cap it, so the last
      // window lands inside the display however many there are.
      let step_x = (screen_width - width)
        .checked_div(steps)
        .map_or(0, |step| step.min(CASCADE_MAX_STEP_X));
      let step_y = (screen_height - height)
        .checked_div(steps)
        .map_or(0, |step| step.min(CASCADE_MAX_STEP_Y));
      (0..count)
        .map(|index| WindowRect {
          left: (index as u32 * step_x) as i32,
          top: (index as u32 * step_y) as i32,
          width,
          height,
        })
        .collect()
    }
  }
}

/// Whether an arrangement is worth asking a browser for. A display too small
/// to give every window a usable size is better left alone than tiled into
/// slivers Chromium will silently refuse to make.
pub fn layout_fits(rects: &[WindowRect]) -> bool {
  rects
    .iter()
    .all(|rect| rect.width >= MIN_WINDOW_WIDTH && rect.height >= MIN_WINDOW_HEIGHT)
}

/// What the leader's events are currently allowed to reach.
///
/// Kept apart from the session record so the hot event path can read it
/// without an async lock, and so the rules are testable on their own.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct MirrorGate {
  paused: bool,
  held: std::collections::HashSet<String>,
}

impl MirrorGate {
  /// True when this follower should receive what the leader just did.
  pub(crate) fn accepts(&self, follower_id: &str) -> bool {
    !self.paused && !self.held.contains(follower_id)
  }

  pub(crate) fn set_paused(&mut self, paused: bool) {
    self.paused = paused;
  }

  pub(crate) fn is_paused(&self) -> bool {
    self.paused
  }

  pub(crate) fn set_held(&mut self, follower_id: &str, held: bool) {
    if held {
      self.held.insert(follower_id.to_string());
    } else {
      self.held.remove(follower_id);
    }
  }

  pub(crate) fn is_held(&self, follower_id: &str) -> bool {
    self.held.contains(follower_id)
  }

  /// Drop a follower that has left the session, so its id cannot linger and
  /// silence a profile that is later added back.
  pub(crate) fn forget(&mut self, follower_id: &str) {
    self.held.remove(follower_id);
  }
}

type SharedGate = Arc<std::sync::RwLock<MirrorGate>>;

/// Everything the listener task needs to know about the session it drives.
struct SessionLoopContext {
  session_id: String,
  leader_profile_id: String,
  follower_profile_ids: Vec<String>,
  gate: SharedGate,
}

/// Internal session state
struct SyncSession {
  id: String,
  leader_profile_id: String,
  leader_profile_name: String,
  /// Ordered, because the arrangement numbers the windows by it and a list
  /// that reshuffles itself between renders is unusable.
  followers: Vec<SyncFollowerState>,
  gate: SharedGate,
  /// Cancellation token — drop sender to stop the listener task
  cancel_tx: tokio::sync::watch::Sender<bool>,
}

impl SyncSession {
  /// The session as the page sees it.
  ///
  /// `paused` and every `held` flag are read back off the gate rather than
  /// mirrored into the follower records, so what the panel shows is what the
  /// event path actually enforces and the two can never drift apart.
  fn info(&self) -> SyncSessionInfo {
    let gate = self.gate.read().ok();
    SyncSessionInfo {
      id: self.id.clone(),
      leader_profile_id: self.leader_profile_id.clone(),
      leader_profile_name: self.leader_profile_name.clone(),
      followers: self
        .followers
        .iter()
        .map(|follower| SyncFollowerState {
          held: gate
            .as_ref()
            .is_some_and(|gate| gate.is_held(&follower.profile_id)),
          ..follower.clone()
        })
        .collect(),
      paused: gate.as_ref().is_some_and(|gate| gate.is_paused()),
    }
  }

  fn follower_mut(&mut self, profile_id: &str) -> Option<&mut SyncFollowerState> {
    self
      .followers
      .iter_mut()
      .find(|follower| follower.profile_id == profile_id)
  }

  fn has_follower(&self, profile_id: &str) -> bool {
    self
      .followers
      .iter()
      .any(|follower| follower.profile_id == profile_id)
  }
}

pub struct SynchronizerManager {
  inner: Arc<AsyncMutex<SynchronizerInner>>,
}

struct SynchronizerInner {
  sessions: HashMap<String, SyncSession>,
}

static SYNCHRONIZER: std::sync::OnceLock<SynchronizerManager> = std::sync::OnceLock::new();

impl SynchronizerManager {
  pub fn instance() -> &'static SynchronizerManager {
    SYNCHRONIZER.get_or_init(|| SynchronizerManager {
      inner: Arc::new(AsyncMutex::new(SynchronizerInner {
        sessions: HashMap::new(),
      })),
    })
  }

  /// Start a new sync session. Launches all profiles and begins event capture.
  pub async fn start_session(
    &self,
    app_handle: tauri::AppHandle,
    leader_profile_id: String,
    follower_profile_ids: Vec<String>,
  ) -> Result<SyncSessionInfo, String> {
    // Validate: leader must be wayfern
    let profiles = ProfileManager::instance()
      .list_profiles()
      .map_err(|e| format!("Failed to list profiles: {e}"))?;

    let leader = profiles
      .iter()
      .find(|p| p.id.to_string() == leader_profile_id)
      .ok_or("Leader profile not found")?
      .clone();

    if leader.browser != "wayfern" {
      return Err("Synchronizer only supports Wayfern profiles.".to_string());
    }

    // Check leader is not already running
    if leader.process_id.is_some() {
      let sys = crate::proxy_storage::process_table(sysinfo::RefreshKind::everything());
      if let Some(pid) = leader.process_id {
        if sys.process(sysinfo::Pid::from(pid as usize)).is_some() {
          return Err(
            "Leader profile is already running. Stop it first to start a sync session.".to_string(),
          );
        }
      }
    }

    let mut follower_profiles: Vec<BrowserProfile> = Vec::new();
    for fid in &follower_profile_ids {
      let fp = profiles
        .iter()
        .find(|p| p.id.to_string() == *fid)
        .ok_or(format!("Follower profile '{fid}' not found"))?
        .clone();
      if fp.browser != "wayfern" {
        return Err(format!(
          "Profile '{}' is not a Wayfern profile. Only Wayfern profiles can be synchronized.",
          fp.name
        ));
      }
      follower_profiles.push(fp);
    }

    // Check no profile is part of another active session
    {
      let inner = self.inner.lock().await;
      for session in inner.sessions.values() {
        if session.leader_profile_id == leader_profile_id {
          return Err("Leader profile is already in another sync session.".to_string());
        }
        for fid in &follower_profile_ids {
          if session.leader_profile_id == *fid || session.has_follower(fid) {
            return Err(format!(
              "Profile '{fid}' is already part of another sync session."
            ));
          }
        }
      }
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    // Launch leader first so it gets focus
    crate::browser_runner::launch_browser_profile(app_handle.clone(), leader.clone(), None, None)
      .await
      .map_err(|e| {
        // The launch logged its own failure; its text can carry the name.
        log::error!(
          "Synchronizer start failed step=launch_leader profile={}",
          leader.id
        );
        format!("Failed to launch leader: {e}")
      })?;

    // Launch followers in parallel batches of MAX_CONCURRENT_LAUNCHES
    for chunk in follower_profiles.chunks(MAX_CONCURRENT_LAUNCHES) {
      let mut set = tokio::task::JoinSet::new();
      for fp in chunk {
        let ah = app_handle.clone();
        let fp = fp.clone();
        set.spawn(async move {
          crate::browser_runner::launch_browser_profile(ah, fp.clone(), None, None)
            .await
            .map_err(|e| (fp.id, fp.name.clone(), e.to_string()))
        });
      }
      while let Some(result) = set.join_next().await {
        match result {
          Ok(Ok(_)) => {}
          Ok(Err((id, name, e))) => {
            log::error!("Synchronizer start failed step=launch_follower profile={id}");
            // Kill leader and all already-launched followers
            let _ =
              crate::browser_runner::kill_browser_profile(app_handle.clone(), leader.clone()).await;
            for fp in &follower_profiles {
              let _ =
                crate::browser_runner::kill_browser_profile(app_handle.clone(), fp.clone()).await;
            }
            return Err(format!("Failed to launch follower '{name}': {e}"));
          }
          Err(e) => {
            log::error!("Synchronizer start failed step=launch_task err=\"{e}\"");
            let _ =
              crate::browser_runner::kill_browser_profile(app_handle.clone(), leader.clone()).await;
            return Err(format!("Launch task panicked: {e}"));
          }
        }
      }
    }

    // Bring leader window to front after all followers launched
    Self::focus_leader_window(&leader).await;

    // Build follower states, keeping the order the user selected them in.
    let followers: Vec<SyncFollowerState> = follower_profiles
      .iter()
      .map(|fp| SyncFollowerState {
        profile_id: fp.id.to_string(),
        profile_name: fp.name.clone(),
        failed_at_url: None,
        held: false,
      })
      .collect();

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let gate: SharedGate = Arc::new(std::sync::RwLock::new(MirrorGate::default()));

    let session = SyncSession {
      id: session_id.clone(),
      leader_profile_id: leader_profile_id.clone(),
      leader_profile_name: leader.name.clone(),
      followers: followers.clone(),
      gate: gate.clone(),
      cancel_tx,
    };

    let info = session.info();

    {
      let mut inner = self.inner.lock().await;
      inner.sessions.insert(session_id.clone(), session);
    }

    // Emit initial session event
    let _ = app_handle.emit("sync-session-changed", &info);

    // Spawn the CDP listener task with a readiness signal
    let manager = self.inner.clone();
    let ah = app_handle.clone();
    let sid = session_id.clone();
    let lid = leader_profile_id.clone();
    let fids: Vec<String> = follower_profile_ids.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    let all_profile_ids: Vec<String> = std::iter::once(leader_profile_id.clone())
      .chain(follower_profile_ids.iter().cloned())
      .collect();

    tokio::spawn(async move {
      if let Err(e) = Self::run_session_loop(
        ah.clone(),
        manager.clone(),
        SessionLoopContext {
          session_id: sid.clone(),
          leader_profile_id: lid,
          follower_profile_ids: fids,
          gate,
        },
        cancel_rx,
        ready_tx,
      )
      .await
      {
        log::error!(
          "Synchronizer session failed session={} err=\"{e}\"",
          ShortId(&sid)
        );
        // Kill all profiles on error (leader + followers)
        for pid in &all_profile_ids {
          if let Ok(p) = Self::get_profile(pid) {
            let _ = crate::browser_runner::kill_browser_profile(ah.clone(), p).await;
          }
        }
      }
      // Session ended — clean up
      let mut inner = manager.lock().await;
      inner.sessions.remove(&sid);
      let _ = ah.emit("sync-session-ended", &sid);
    });

    // Wait for the CDP session to be ready (or fail)
    match tokio::time::timeout(std::time::Duration::from_secs(90), ready_rx).await {
      Ok(Ok(Ok(()))) => Ok(info),
      Ok(Ok(Err(e))) => Err(format!("Synchronizer setup failed: {e}")),
      // The session task logged why it ended.
      Ok(Err(_)) => Err("Synchronizer setup channel closed unexpectedly".to_string()),
      Err(_) => {
        log::error!(
          "Synchronizer start failed step=setup session={} err=\"timed out after 90s\"",
          ShortId(&session_id)
        );
        Err("Synchronizer setup timed out".to_string())
      }
    }
  }

  /// Bring the leader browser window to front.
  ///
  /// On macOS this is a no-op on purpose: the only way to raise another
  /// app's window from Rust is via `osascript` / Apple Events, which
  /// triggers the TCC "prevented from modifying other apps" prompt. Donut
  /// must never touch other apps on the user's Mac.
  async fn focus_leader_window(leader: &BrowserProfile) {
    let profile = match Self::get_profile(&leader.id.to_string()) {
      Ok(p) => p,
      Err(_) => return,
    };
    let Some(pid) = profile.process_id else {
      return;
    };

    #[cfg(target_os = "linux")]
    {
      let _ = tokio::process::Command::new("xdotool")
        .args([
          "search",
          "--pid",
          &pid.to_string(),
          "--onlyvisible",
          "windowactivate",
        ])
        .output()
        .await;
    }

    #[cfg(not(target_os = "linux"))]
    {
      let _ = pid;
    }
  }

  /// Core session loop: inject capture script on leader, listen for events, replay on followers.
  async fn run_session_loop(
    app_handle: tauri::AppHandle,
    manager: Arc<AsyncMutex<SynchronizerInner>>,
    session: SessionLoopContext,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    ready_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
  ) -> Result<(), String> {
    let SessionLoopContext {
      session_id,
      leader_profile_id,
      follower_profile_ids,
      gate,
    } = session;
    use futures_util::sink::SinkExt;
    use futures_util::stream::StreamExt;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message;

    let started = std::time::Instant::now();
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // Connect to leader page-level target for reliable event capture
    let leader_profile = Self::get_profile(&leader_profile_id)?;
    let leader_port = Self::get_cdp_port(&leader_profile).await?;
    let leader_ws_url = Self::get_page_ws_url(leader_port).await?;

    let (mut ws_stream, _) = connect_async(&leader_ws_url)
      .await
      .map_err(|e| format!("Failed to connect to leader CDP: {e}"))?;

    // Helper: send command and collect response, buffering non-response events
    let mut cmd_id: u64 = 0;
    let mut pending_events: Vec<serde_json::Value> = Vec::new();

    // Send a CDP command and wait for its response, buffering events that arrive in between
    async fn send_cmd(
      ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
      >,
      cmd_id: &mut u64,
      pending_events: &mut Vec<serde_json::Value>,
      method: &str,
      params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
      *cmd_id += 1;
      let id = *cmd_id;
      let cmd = serde_json::json!({ "id": id, "method": method, "params": params });
      ws.send(Message::Text(cmd.to_string().into()))
        .await
        .map_err(|e| format!("Failed to send {method}: {e}"))?;
      let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
      loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
          return Err(format!("Timeout waiting for {method} response"));
        }
        match tokio::time::timeout(remaining, ws.next()).await {
          Ok(Some(Ok(Message::Text(text)))) => {
            let resp: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
            if resp.get("id") == Some(&serde_json::json!(id)) {
              if let Some(error) = resp.get("error") {
                return Err(format!("CDP error for {method}: {error}"));
              }
              return Ok(resp.get("result").cloned().unwrap_or(serde_json::json!({})));
            }
            // Buffer events that arrive while waiting for response
            if resp.get("method").is_some() {
              pending_events.push(resp);
            }
          }
          Ok(Some(Ok(_))) => continue,
          Ok(Some(Err(e))) => return Err(format!("WebSocket error: {e}")),
          Ok(None) => return Err("WebSocket closed".to_string()),
          Err(_) => return Err(format!("Timeout waiting for {method} response")),
        }
      }
    }

    /// What is at (x, y) on the leader's page, as something a follower can
    /// look up in its own layout. None when the point holds no element.
    async fn leader_anchor(
      ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
      >,
      cmd_id: &mut u64,
      pending_events: &mut Vec<serde_json::Value>,
      x: f64,
      y: f64,
    ) -> Option<PointAnchor> {
      let metrics = send_cmd(
        ws,
        cmd_id,
        pending_events,
        "Page.getLayoutMetrics",
        serde_json::json!({}),
      )
      .await
      .ok()?;
      let scroll = |axis: &str| {
        metrics
          .pointer(&format!("/cssVisualViewport/{axis}"))
          .and_then(|v| v.as_f64())
          .unwrap_or(0.0)
      };
      // The hit test takes document coordinates, the captured point is in the
      // viewport.
      let hit = send_cmd(
        ws,
        cmd_id,
        pending_events,
        "DOM.getNodeForLocation",
        serde_json::json!({
          "x": (x + scroll("pageX")).round() as i64,
          "y": (y + scroll("pageY")).round() as i64,
          "includeUserAgentShadowDOM": false,
          "ignorePointerEventsNone": true,
        }),
      )
      .await
      .ok()?;
      let hit_node = hit.get("backendNodeId")?.as_i64()?;
      let document = send_cmd(
        ws,
        cmd_id,
        pending_events,
        "DOM.getDocument",
        serde_json::json!({ "depth": -1 }),
      )
      .await;
      let found = document
        .as_ref()
        .ok()
        .and_then(|document| document.get("root"))
        .and_then(|root| selector_for_node(root, hit_node));
      let quads = match &found {
        Some((_, element)) => send_cmd(
          ws,
          cmd_id,
          pending_events,
          "DOM.getContentQuads",
          serde_json::json!({ "backendNodeId": element }),
        )
        .await
        .ok(),
        None => None,
      };
      // Reading the document turned on DOM events, which nothing here uses.
      let _ = send_cmd(
        ws,
        cmd_id,
        pending_events,
        "DOM.disable",
        serde_json::json!({}),
      )
      .await;
      let (selector, _) = found?;
      anchor_in_quads(selector, &quads_of(&quads?), x, y)
    }

    // Use Wayfern's native input capture — no JS injection needed.
    // Captures all real user input at the browser process level.
    let setup_commands: Vec<(&str, serde_json::Value)> = vec![
      ("Page.enable", serde_json::json!({})),
      // Pointer moves are needed for hover menus, drags and selections.
      (
        "Wayfern.enableInputCapture",
        serde_json::json!({ "trackMouseMove": true }),
      ),
    ];

    for (method, params) in setup_commands {
      match send_cmd(
        &mut ws_stream,
        &mut cmd_id,
        &mut pending_events,
        method,
        params,
      )
      .await
      {
        Ok(_) => {}
        Err(e) => {
          return Err(format!("{method} failed: {e}"));
        }
      }
    }

    // Same-document navigations are reported per frame; only the main frame's
    // move the leader to another page.
    let leader_main_frame: Option<String> = send_cmd(
      &mut ws_stream,
      &mut cmd_id,
      &mut pending_events,
      "Page.getFrameTree",
      serde_json::json!({}),
    )
    .await
    .ok()
    .and_then(|tree| {
      tree
        .pointer("/frameTree/frame/id")
        .and_then(|id| id.as_str())
        .map(str::to_string)
    });

    // Get leader window size and resize all followers to match
    let leader_bounds = send_cmd(
      &mut ws_stream,
      &mut cmd_id,
      &mut pending_events,
      "Browser.getWindowForTarget",
      serde_json::json!({}),
    )
    .await
    .ok();

    if let Some(bounds_result) = &leader_bounds {
      if let Some(bounds) = bounds_result.get("bounds") {
        let width = bounds.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
        let height = bounds.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
        if width > 0 && height > 0 {
          log::debug!("Synchronizer resizing followers width={width} height={height}");
          for fid in &follower_profile_ids {
            if let Ok(fp) = Self::get_profile(fid) {
              if let Ok(port) = Self::get_cdp_port(&fp).await {
                if let Ok(f_ws) = Self::get_page_ws_url(port).await {
                  if let Ok((mut fws, _)) = tokio_tungstenite::connect_async(&f_ws).await {
                    // Get follower's window ID
                    let get_win = serde_json::json!({ "id": 1, "method": "Browser.getWindowForTarget", "params": {} });
                    let _ = fws.send(Message::Text(get_win.to_string().into())).await;
                    if let Some(Ok(Message::Text(text))) = fws.next().await {
                      if let Ok(resp) = serde_json::from_str::<serde_json::Value>(text.as_str()) {
                        if let Some(win_id) = resp
                          .get("result")
                          .and_then(|r| r.get("windowId"))
                          .and_then(|w| w.as_i64())
                        {
                          let set_bounds = serde_json::json!({
                            "id": 2,
                            "method": "Browser.setWindowBounds",
                            "params": { "windowId": win_id, "bounds": { "width": width, "height": height } }
                          });
                          let _ = fws.send(Message::Text(set_bounds.to_string().into())).await;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Open persistent WebSocket connections to each follower and create event channels.
    // Each follower gets a dedicated replay task with a long-lived WS connection.
    let mut follower_senders: HashMap<String, tokio::sync::mpsc::UnboundedSender<CapturedEvent>> =
      HashMap::new();

    for fid in &follower_profile_ids {
      match Self::get_profile(fid) {
        Ok(fp) => match Self::get_cdp_port(&fp).await {
          Ok(port) => match Self::get_page_ws_url(port).await {
            Ok(url) => {
              match tokio_tungstenite::connect_async(&url).await {
                Ok((ws, _)) => {
                  let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<CapturedEvent>();
                  follower_senders.insert(fid.clone(), tx);

                  // Spawn dedicated replay task for this follower
                  let fid_clone = fid.clone();
                  let mgr = manager.clone();
                  let sid = session_id.clone();
                  let ah = app_handle.clone();
                  let editing = ShortcutEditing::for_profile(&fp);
                  tokio::spawn(async move {
                    Self::follower_replay_loop(ws, rx, fid_clone, mgr, sid, ah, editing).await;
                  });
                }
                Err(e) => log::warn!(
                  "Synchronizer follower not connected step=connect profile={fid} err=\"{e}\""
                ),
              }
            }
            Err(e) => log::warn!(
              "Synchronizer follower not connected step=ws_url profile={fid} err=\"{e}\""
            ),
          },
          Err(e) => log::warn!(
            "Synchronizer follower not connected step=cdp_port profile={fid} err=\"{e}\""
          ),
        },
        Err(e) => {
          log::warn!("Synchronizer follower not connected step=profile profile={fid} err=\"{e}\"")
        }
      }
    }

    log::info!(
      "Synchronizer session started session={} leader={leader_profile_id} leader_cdp_port={leader_port} followers_connected={}/{} elapsed_ms={}",
      ShortId(&session_id),
      follower_senders.len(),
      follower_profile_ids.len(),
      started.elapsed().as_millis()
    );

    // Track when the last user interaction was captured (for suppressing click-caused nav replay)
    let mut last_user_event_time = std::time::Instant::now() - std::time::Duration::from_secs(60);

    // Signal that the session is ready for interaction
    let _ = ready_tx.send(Ok(()));

    // Events that arrived while a command waited for its reply, oldest first.
    let mut backlog: std::collections::VecDeque<serde_json::Value> =
      pending_events.drain(..).collect();
    // Where the last press was, so the release of a click reuses its anchor.
    let mut last_press: Option<(f64, f64)> = None;
    // The pointer of the wheel burst in progress, and when it counts as over.
    let mut wheel_burst: Option<(f64, f64, tokio::time::Instant)> = None;

    // Main event loop — listen for Wayfern.inputCaptured events
    let end_reason: String;
    loop {
      let value = if let Some(value) = backlog.pop_front() {
        value
      } else {
        let wheel_end = wheel_burst.map(|(_, _, at)| at);
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    end_reason = "cancelled".to_string();
                    break;
                }
                continue;
            }
            _ = tokio::time::sleep_until(wheel_end.unwrap_or_else(tokio::time::Instant::now)), if wheel_end.is_some() => {
                // The scroll stopped: tell the followers what is under the
                // pointer now, so they can line the same content up.
                if let Some((x, y, _)) = wheel_burst.take() {
                    let anchor =
                        leader_anchor(&mut ws_stream, &mut cmd_id, &mut pending_events, x, y).await;
                    backlog.extend(pending_events.drain(..));
                    let ended = CapturedEvent {
                        event_type: "wheelEnd".to_string(),
                        x: Some(x),
                        y: Some(y),
                        anchor,
                        ..Default::default()
                    };
                    Self::fan_out(&gate, &follower_senders, &ended);
                }
                continue;
            }
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str(text.as_str()) {
                        Ok(value) => value,
                        Err(_) => continue,
                    },
                    Some(Ok(_)) => continue, // pings, binary, etc.
                    Some(Err(e)) => {
                        end_reason = format!("leader_ws_error err=\"{e}\"");
                        break;
                    }
                    None => {
                        end_reason = "leader_closed".to_string();
                        break;
                    }
                }
            }
        }
      };

      let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");

      // Log CDP command response errors
      if let (Some(id), Some(error)) = (value.get("id"), value.get("error")) {
        log::warn!(
          "Synchronizer leader CDP command failed session={} id={id} err={error}",
          ShortId(&session_id)
        );
      }

      match method {
        "Wayfern.inputCaptured" => {
          let Some(mut event) = value
            .get("params")
            .and_then(|params| serde_json::from_value::<CapturedEvent>(params.clone()).ok())
          else {
            continue;
          };
          // A pointer move is not an action: the pointer crossing the page on
          // its way to the address bar must not hide the navigation typed there.
          if event.event_type != "mousemove" {
            last_user_event_time = std::time::Instant::now();
          }
          let point = (event.x.unwrap_or(0.0), event.y.unwrap_or(0.0));
          let needs_anchor = match event.event_type.as_str() {
            "mousedown" => {
              last_press = Some(point);
              true
            }
            "mouseup" => !last_press
              .take()
              .is_some_and(|(x, y)| (x - point.0).hypot(y - point.1) < 4.0),
            "wheel" => {
              let starts = wheel_burst.is_none();
              wheel_burst = Some((
                point.0,
                point.1,
                tokio::time::Instant::now() + WHEEL_BURST_IDLE,
              ));
              starts
            }
            _ => false,
          };
          if needs_anchor {
            event.anchor = leader_anchor(
              &mut ws_stream,
              &mut cmd_id,
              &mut pending_events,
              point.0,
              point.1,
            )
            .await;
            backlog.extend(pending_events.drain(..));
          }
          log::trace!("Synchronizer captured event={}", event.event_type);
          Self::fan_out(&gate, &follower_senders, &event);
        }
        // Every top-level navigation tells the followers where the leader is
        // now. Those that got there by replaying the input are already there;
        // the rest are sent.
        "Page.frameNavigated" => {
          let frame = value.pointer("/params/frame");
          let is_top = frame.is_some_and(|frame| frame.get("parentId").is_none());
          let url = frame
            .and_then(|frame| frame.get("url"))
            .and_then(|url| url.as_str());
          if let (true, Some(url)) = (is_top, url) {
            if !url.starts_with("about:") && !url.starts_with("chrome://") {
              let typed = last_user_event_time.elapsed() >= std::time::Duration::from_secs(2);
              let navigated = CapturedEvent {
                event_type: "navigated".to_string(),
                url: Some(url.to_string()),
                typed: Some(typed),
                ..Default::default()
              };
              Self::fan_out(&gate, &follower_senders, &navigated);
            }
          }
        }
        "Page.navigatedWithinDocument" => {
          let frame_id = value.pointer("/params/frameId").and_then(|id| id.as_str());
          let url = value.pointer("/params/url").and_then(|url| url.as_str());
          if let (true, Some(url)) = (
            frame_id.is_some() && frame_id == leader_main_frame.as_deref(),
            url,
          ) {
            let navigated = CapturedEvent {
              event_type: "navigated".to_string(),
              url: Some(url.to_string()),
              typed: Some(false),
              ..Default::default()
            };
            Self::fan_out(&gate, &follower_senders, &navigated);
          }
        }
        // A dialog blocks the follower's page until someone answers it, so the
        // leader's answer is passed on.
        "Page.javascriptDialogClosed" => {
          let closed = CapturedEvent {
            event_type: "dialogClosed".to_string(),
            accept: value.pointer("/params/result").and_then(|r| r.as_bool()),
            prompt_text: value
              .pointer("/params/userInput")
              .and_then(|text| text.as_str())
              .map(str::to_string),
            ..Default::default()
          };
          Self::fan_out(&gate, &follower_senders, &closed);
        }
        _ => {}
      }
    }

    // Leader closed or session cancelled — kill all followers
    let follower_ids: Vec<String> = {
      let inner = manager.lock().await;
      if let Some(session) = inner.sessions.get(&session_id) {
        session
          .followers
          .iter()
          .map(|follower| follower.profile_id.clone())
          .collect()
      } else {
        Vec::new()
      }
    };

    let followers_stopped = follower_ids.len();
    for fid in follower_ids {
      if let Ok(fp) = Self::get_profile(&fid) {
        let _ = crate::browser_runner::kill_browser_profile(app_handle.clone(), fp).await;
      }
    }
    log::log!(
      if end_reason.starts_with("leader_ws_error") {
        log::Level::Warn
      } else {
        log::Level::Info
      },
      "Synchronizer session ended session={} reason={end_reason} followers_stopped={followers_stopped} duration_s={}",
      ShortId(&session_id),
      started.elapsed().as_secs()
    );

    Ok(())
  }

  /// Send one captured event to every follower the gate still admits.
  ///
  /// The lock is held across the whole fan-out and released before any await,
  /// so a pause taking effect mid-event cannot deliver to half the followers.
  fn fan_out(
    gate: &SharedGate,
    follower_senders: &HashMap<String, tokio::sync::mpsc::UnboundedSender<CapturedEvent>>,
    event: &CapturedEvent,
  ) {
    let Ok(gate) = gate.read() else {
      log::warn!("Synchronizer mirroring gate poisoned; event dropped");
      return;
    };
    if gate.is_paused() {
      return;
    }
    for (follower_id, tx) in follower_senders {
      if !gate.accepts(follower_id) {
        continue;
      }
      let _ = tx.send(event.clone());
    }
  }

  /// Dedicated replay loop for a single follower with a persistent WebSocket connection.
  /// Processes events from the channel sequentially — no per-event connection overhead.
  ///
  /// Pointer events carry an anchor from the leader and are replayed on the
  /// same element here, wherever this follower's layout put it. Input waits
  /// until the follower is on the page the leader last moved to.
  async fn follower_replay_loop(
    ws: FollowerSocket,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<CapturedEvent>,
    follower_id: String,
    manager: Arc<AsyncMutex<SynchronizerInner>>,
    session_id: String,
    app_handle: tauri::AppHandle,
    editing: ShortcutEditing,
  ) {
    let mut link = FollowerLink::new(ws);
    // The follower's own page events tell the barrier where it is.
    let _ = link.call("Page.enable", serde_json::json!({})).await;
    if let Ok(Some(tree)) = link.call("Page.getFrameTree", serde_json::json!({})).await {
      let frame = tree.pointer("/frameTree/frame");
      let text = |key: &str| {
        frame
          .and_then(|frame| frame.get(key))
          .and_then(|v| v.as_str())
          .unwrap_or_default()
          .to_string()
      };
      let (main_frame, url) = (text("id"), text("url"));
      link.page_tx.send_modify(|page| {
        page.main_frame = main_frame;
        page.url = url;
        page.loaded = true;
      });
    }

    // Buttons the leader holds down, as Input.dispatchMouseEvent's bit mask, so
    // moves between a press and a release replay as a drag.
    let mut buttons_held: i32 = 0;
    // An event read ahead while collapsing a run of pointer moves.
    let mut queued: Option<CapturedEvent> = None;
    // This follower's point minus the leader's at the last anchored event;
    // moves and the release of a click follow it.
    let mut offset = (0.0f64, 0.0f64);
    // The page the leader moved to, and until when the follower may get there
    // by itself.
    let mut barrier_target: Option<(String, tokio::time::Instant, bool)> = None;

    loop {
      let mut event = match queued.take() {
        Some(event) => event,
        None => {
          let due = barrier_target.as_ref().map(|(_, at, _)| *at);
          tokio::select! {
            event = rx.recv() => match event {
              Some(event) => event,
              None => break,
            },
            _ = tokio::time::sleep_until(due.unwrap_or_else(tokio::time::Instant::now)), if due.is_some() => {
              if let Some((url, _, sent)) = barrier_target.take() {
                if link.reach(&url, std::time::Duration::ZERO, sent).await.is_err() {
                  Self::mark_follower_desynced(&manager, &session_id, &follower_id, &app_handle).await;
                  break;
                }
              }
              continue;
            }
          }
        }
      };
      // Only the last of a run of queued moves matters: a follower that fell
      // behind catches up instead of replaying every intermediate position.
      while event.event_type == "mousemove" {
        match rx.try_recv() {
          Ok(newer) if newer.event_type == "mousemove" => event = newer,
          Ok(other) => {
            queued = Some(other);
            break;
          }
          Err(_) => break,
        }
      }

      let is_input = matches!(
        event.event_type.as_str(),
        "mousedown"
          | "mouseup"
          | "mousemove"
          | "keydown"
          | "keyup"
          | "char"
          | "wheel"
          | "insertText"
      );
      if is_input {
        if let Some((url, until, sent)) = barrier_target.take() {
          let grace = until.saturating_duration_since(tokio::time::Instant::now());
          if link.reach(&url, grace, sent).await.is_err() {
            Self::mark_follower_desynced(&manager, &session_id, &follower_id, &app_handle).await;
            break;
          }
        }
      }

      let leader_point = (event.x.unwrap_or(0.0), event.y.unwrap_or(0.0));
      let modifiers = event.modifiers.unwrap_or(0);
      let button = event.button.clone().unwrap_or_else(|| "left".to_string());
      let button_bit = match button.as_str() {
        "left" => 1,
        "right" => 2,
        "middle" => 4,
        "back" => 8,
        "forward" => 16,
        _ => 0,
      };

      let sent: Result<(), String> = match event.event_type.as_str() {
        "navigated" => match event.url.clone() {
          Some(url) if event.typed == Some(true) => {
            // An address the leader typed: nothing replayed brings the
            // follower there, so it is sent at once.
            barrier_target = Some((url.clone(), tokio::time::Instant::now() + LOAD_GRACE, true));
            link
              .send("Page.navigate", serde_json::json!({ "url": url }))
              .await
          }
          Some(url) => {
            barrier_target = Some((url, tokio::time::Instant::now() + NAVIGATION_GRACE, false));
            Ok(())
          }
          None => Ok(()),
        },
        "dialogClosed" => {
          let deadline = tokio::time::Instant::now() + DIALOG_WAIT;
          loop {
            let open = link.page.borrow().dialog_open;
            if open || tokio::time::Instant::now() >= deadline {
              break;
            }
            let _ =
              tokio::time::timeout(std::time::Duration::from_millis(100), link.page.changed())
                .await;
          }
          let open = link.page.borrow().dialog_open;
          if open {
            link
              .call(
                "Page.handleJavaScriptDialog",
                serde_json::json!({
                  "accept": event.accept.unwrap_or(false),
                  "promptText": event.prompt_text.clone().unwrap_or_default(),
                }),
              )
              .await
              .map(|_| ())
          } else {
            Ok(())
          }
        }
        "mousedown" | "mouseup" => {
          if let Some(anchor) = &event.anchor {
            offset = match link.resolve(anchor, ANCHOR_WAIT).await {
              Some((x, y, _, _)) => (x - leader_point.0, y - leader_point.1),
              None => (0.0, 0.0),
            };
          } else if event.event_type == "mousedown" {
            // Nothing to look up: the leader's point as it is, not the last
            // element's offset.
            offset = (0.0, 0.0);
          }
          let (x, y) = (leader_point.0 + offset.0, leader_point.1 + offset.1);
          let before = buttons_held;
          if event.event_type == "mousedown" {
            buttons_held |= button_bit;
          } else {
            buttons_held &= !button_bit;
          }
          // The pointer gets there first, so hover and the press land together.
          let moved = link
            .send(
              "Input.dispatchMouseEvent",
              serde_json::json!({
                "type": "mouseMoved",
                "x": x,
                "y": y,
                "button": if before & 1 != 0 { "left" } else { "none" },
                "buttons": before,
                "modifiers": modifiers,
              }),
            )
            .await;
          match moved {
            Err(e) => Err(e),
            // Acknowledged, so the next lookup sees what the click did.
            Ok(()) => link
              .call(
                "Input.dispatchMouseEvent",
                serde_json::json!({
                  "type": if event.event_type == "mousedown" { "mousePressed" } else { "mouseReleased" },
                  "x": x,
                  "y": y,
                  "button": button,
                  "buttons": buttons_held,
                  "clickCount": event.click_count.unwrap_or(1),
                  "modifiers": modifiers,
                }),
              )
              .await
              .map(|_| ()),
          }
        }
        "mousemove" => {
          link
            .send(
              "Input.dispatchMouseEvent",
              serde_json::json!({
                "type": "mouseMoved",
                "x": leader_point.0 + offset.0,
                "y": leader_point.1 + offset.1,
                "button": if buttons_held & 1 != 0 { "left" } else { "none" },
                "buttons": buttons_held,
                "modifiers": modifiers,
              }),
            )
            .await
        }
        // A wheel event at the pointer scrolls whatever is under it (a list, a
        // pane, a modal), as on the leader. The captured deltas have the
        // opposite sign of the command's.
        "wheel" => {
          if let Some(anchor) = &event.anchor {
            if let Some((x, y, _, _)) = link.resolve(anchor, WHEEL_ANCHOR_WAIT).await {
              offset = (x - leader_point.0, y - leader_point.1);
            }
          }
          link
            .call(
              "Input.dispatchMouseEvent",
              serde_json::json!({
                "type": "mouseWheel",
                "x": leader_point.0 + offset.0,
                "y": leader_point.1 + offset.1,
                "deltaX": -event.delta_x.unwrap_or(0.0),
                "deltaY": -event.delta_y.unwrap_or(0.0),
                "modifiers": modifiers,
              }),
            )
            .await
            .map(|_| ())
        }
        // After a scroll, the content under the leader's pointer is moved under
        // the same point here: relative wheel deltas drift with other heights.
        "wheelEnd" => match &event.anchor {
          Some(anchor) => {
            let middle = PointAnchor {
              rx: 0.5,
              ..anchor.clone()
            };
            match link.resolve(&middle, WHEEL_ANCHOR_WAIT).await {
              Some((_, _, top, height)) => {
                let delta = scroll_to_align(anchor, top, height);
                if delta.abs() >= 1.0 {
                  link
                    .call(
                      "Input.dispatchMouseEvent",
                      serde_json::json!({
                        "type": "mouseWheel",
                        "x": leader_point.0 + offset.0,
                        "y": leader_point.1,
                        "deltaX": 0,
                        "deltaY": delta,
                      }),
                    )
                    .await
                    .map(|_| ())
                } else {
                  Ok(())
                }
              }
              None => Ok(()),
            }
          }
          None => Ok(()),
        },
        "keydown" | "keyup" => {
          let key = event.key.clone().unwrap_or_default();
          let (mapped, command) =
            editing.map_shortcut(&key, modifiers, event.event_type == "keydown");
          let mut params = serde_json::json!({
            "type": if event.event_type == "keydown" { "keyDown" } else { "keyUp" },
            "key": key,
            "code": event.code.clone().unwrap_or_default(),
            "windowsVirtualKeyCode": event.key_code.unwrap_or(0),
            "modifiers": mapped,
          });
          if let Some(command) = command {
            params["commands"] = serde_json::json!([command]);
          }
          link
            .call("Input.dispatchKeyEvent", params)
            .await
            .map(|_| ())
        }
        "char" => match event.text.clone().filter(|text| !text.is_empty()) {
          Some(text) => link
            .call(
              "Input.dispatchKeyEvent",
              serde_json::json!({
                "type": "char",
                "text": text,
                "unmodifiedText": text,
                "modifiers": modifiers,
              }),
            )
            .await
            .map(|_| ()),
          None => Ok(()),
        },
        "insertText" => match event.text.clone().filter(|text| !text.is_empty()) {
          Some(text) => link
            .call("Input.insertText", serde_json::json!({ "text": text }))
            .await
            .map(|_| ()),
          None => Ok(()),
        },
        _ => Ok(()),
      };

      if let Err(e) = sent {
        log::warn!(
          "Synchronizer follower desynced: send failed session={} profile={follower_id} err=\"{e}\"",
          ShortId(&session_id)
        );
        Self::mark_follower_desynced(&manager, &session_id, &follower_id, &app_handle).await;
        break;
      }
    }
  }

  async fn mark_follower_desynced(
    manager: &Arc<AsyncMutex<SynchronizerInner>>,
    session_id: &str,
    follower_id: &str,
    app_handle: &tauri::AppHandle,
  ) {
    let mut inner = manager.lock().await;
    if let Some(session) = inner.sessions.get_mut(session_id) {
      if let Some(follower) = session.follower_mut(follower_id) {
        follower.failed_at_url = Some("connection lost".to_string());
        let info = session.info();
        let _ = app_handle.emit("sync-session-changed", &info);
      }
    }
  }

  /// Stop a sync session by ID. Kills all followers.
  pub async fn stop_session(
    &self,
    app_handle: tauri::AppHandle,
    session_id: &str,
  ) -> Result<(), String> {
    let mut inner = self.inner.lock().await;
    let session = inner
      .sessions
      .remove(session_id)
      .ok_or("Session not found")?;

    // Signal the listener task to stop
    let _ = session.cancel_tx.send(true);

    // Kill followers
    for follower in &session.followers {
      if let Ok(fp) = Self::get_profile(&follower.profile_id) {
        let _ = crate::browser_runner::kill_browser_profile(app_handle.clone(), fp).await;
      }
    }

    // Kill leader
    if let Ok(leader) = Self::get_profile(&session.leader_profile_id) {
      let _ = crate::browser_runner::kill_browser_profile(app_handle.clone(), leader).await;
    }

    let _ = app_handle.emit("sync-session-ended", session_id);
    Ok(())
  }

  /// Remove a single follower from an active session (user clicked stop on follower).
  pub async fn remove_follower(
    &self,
    app_handle: tauri::AppHandle,
    session_id: &str,
    follower_profile_id: &str,
  ) -> Result<(), String> {
    let mut inner = self.inner.lock().await;
    let session = inner
      .sessions
      .get_mut(session_id)
      .ok_or("Session not found")?;

    session
      .followers
      .retain(|follower| follower.profile_id != follower_profile_id);
    // A removed follower must not leave its id sitting in the held set: the
    // profile could be a follower again in a later session and would then be
    // silently ignored.
    if let Ok(mut gate) = session.gate.write() {
      gate.forget(follower_profile_id);
    }

    // Kill the follower browser
    if let Ok(fp) = Self::get_profile(follower_profile_id) {
      let _ = crate::browser_runner::kill_browser_profile(app_handle.clone(), fp).await;
    }

    // Emit updated session info
    let info = session.info();
    let _ = app_handle.emit("sync-session-changed", &info);

    Ok(())
  }

  /// Suspend or resume mirroring for a whole session.
  ///
  /// Nothing is queued while it is paused: the leader can be used on its own
  /// and the followers stay exactly where they were, rather than replaying a
  /// backlog the moment mirroring comes back.
  pub async fn set_paused(
    &self,
    app_handle: tauri::AppHandle,
    session_id: &str,
    paused: bool,
  ) -> Result<SyncSessionInfo, String> {
    let mut inner = self.inner.lock().await;
    let session = inner
      .sessions
      .get_mut(session_id)
      .ok_or_else(|| serde_json::json!({ "code": "SYNC_SESSION_NOT_FOUND" }).to_string())?;

    session
      .gate
      .write()
      .map_err(|_| serde_json::json!({ "code": "SYNC_SESSION_UNAVAILABLE" }).to_string())?
      .set_paused(paused);

    let info = session.info();
    let _ = app_handle.emit("sync-session-changed", &info);
    log::info!(
      "Synchronizer mirroring {} session={}",
      if paused { "paused" } else { "resumed" },
      ShortId(session_id)
    );
    Ok(info)
  }

  /// Hold one follower out of the mirroring, or bring it back.
  ///
  /// Unlike removing a follower this keeps the browser open, so a person can
  /// do something in that one window and then rejoin it to the session.
  pub async fn set_follower_held(
    &self,
    app_handle: tauri::AppHandle,
    session_id: &str,
    follower_profile_id: &str,
    held: bool,
  ) -> Result<SyncSessionInfo, String> {
    let mut inner = self.inner.lock().await;
    let session = inner
      .sessions
      .get_mut(session_id)
      .ok_or_else(|| serde_json::json!({ "code": "SYNC_SESSION_NOT_FOUND" }).to_string())?;

    if !session.has_follower(follower_profile_id) {
      return Err(serde_json::json!({ "code": "SYNC_FOLLOWER_NOT_FOUND" }).to_string());
    }

    session
      .gate
      .write()
      .map_err(|_| serde_json::json!({ "code": "SYNC_SESSION_UNAVAILABLE" }).to_string())?
      .set_held(follower_profile_id, held);

    let info = session.info();
    let _ = app_handle.emit("sync-session-changed", &info);
    Ok(info)
  }

  /// Place the session's windows on the host display, the leader first.
  ///
  /// Held-out followers are placed too: they are still windows on the screen,
  /// and a person who held one out is usually the one who wants to see it.
  pub async fn arrange_windows(
    &self,
    app_handle: tauri::AppHandle,
    session_id: &str,
    layout: WindowLayout,
  ) -> Result<SyncSessionInfo, String> {
    // The leader takes the first tile: every window gets the same size, so
    // every page lays out as the leader's does and a replayed point finds the
    // same content.
    let (info, window_ids) = {
      let inner = self.inner.lock().await;
      let session = inner
        .sessions
        .get(session_id)
        .ok_or_else(|| serde_json::json!({ "code": "SYNC_SESSION_NOT_FOUND" }).to_string())?;
      (
        session.info(),
        std::iter::once(session.leader_profile_id.clone())
          .chain(
            session
              .followers
              .iter()
              .map(|follower| follower.profile_id.clone()),
          )
          .collect::<Vec<_>>(),
      )
    };

    if window_ids.len() < 2 {
      return Ok(info);
    }

    let (screen_width, screen_height) = crate::wayfern_manager::host_screen_size(&app_handle)
      .ok_or_else(|| serde_json::json!({ "code": "SYNC_DISPLAY_UNAVAILABLE" }).to_string())?;

    let rects = layout_windows(layout, window_ids.len(), screen_width, screen_height);
    if !layout_fits(&rects) {
      return Err(
        serde_json::json!({
          "code": "SYNC_DISPLAY_TOO_SMALL",
          "params": { "count": window_ids.len().to_string() }
        })
        .to_string(),
      );
    }

    let mut placed = 0usize;
    for (profile_id, rect) in window_ids.iter().zip(rects) {
      match Self::place_window(profile_id, rect).await {
        Ok(()) => placed += 1,
        Err(e) => {
          log::warn!("Synchronizer window placement failed profile={profile_id} err=\"{e}\"")
        }
      }
    }

    if placed == 0 {
      return Err(serde_json::json!({ "code": "SYNC_ARRANGE_FAILED" }).to_string());
    }
    log::info!(
      "Synchronizer windows arranged session={} placed={placed}/{}",
      ShortId(session_id),
      window_ids.len()
    );
    Ok(info)
  }

  /// Move one session window (leader or follower) through CDP.
  async fn place_window(follower_profile_id: &str, rect: WindowRect) -> Result<(), String> {
    use futures_util::sink::SinkExt;
    use futures_util::stream::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let profile = Self::get_profile(follower_profile_id)?;
    let port = Self::get_cdp_port(&profile).await?;
    let ws_url = Self::get_page_ws_url(port).await?;
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
      .await
      .map_err(|e| format!("Failed to connect to follower CDP: {e}"))?;

    let ask = serde_json::json!({ "id": 1, "method": "Browser.getWindowForTarget", "params": {} });
    ws.send(Message::Text(ask.to_string().into()))
      .await
      .map_err(|e| format!("Failed to ask for the window: {e}"))?;

    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
    let window_id = loop {
      let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
      if remaining.is_zero() {
        return Err("Timed out waiting for the window id".to_string());
      }
      match tokio::time::timeout(remaining, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
          let Ok(response) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
            continue;
          };
          if response.get("id") != Some(&serde_json::json!(1)) {
            continue;
          }
          match response
            .get("result")
            .and_then(|r| r.get("windowId"))
            .and_then(|w| w.as_i64())
          {
            Some(id) => break id,
            None => return Err("The browser reported no window".to_string()),
          }
        }
        Ok(Some(Ok(_))) => continue,
        Ok(Some(Err(e))) => return Err(format!("WebSocket error: {e}")),
        Ok(None) => return Err("WebSocket closed".to_string()),
        Err(_) => return Err("Timed out waiting for the window id".to_string()),
      }
    };

    // `normal` travels with the bounds so a maximised or minimised window is
    // restored first; without it Chromium refuses to move the window at all.
    let place = serde_json::json!({
      "id": 2,
      "method": "Browser.setWindowBounds",
      "params": {
        "windowId": window_id,
        "bounds": {
          "left": rect.left,
          "top": rect.top,
          "width": rect.width,
          "height": rect.height,
          "windowState": "normal",
        }
      }
    });
    ws.send(Message::Text(place.to_string().into()))
      .await
      .map_err(|e| format!("Failed to move the window: {e}"))?;

    // Wait for the acknowledgement rather than firing and forgetting: the
    // panel reports how many windows actually moved.
    match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
      Ok(Some(Ok(Message::Text(text)))) => {
        let response: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
        if let Some(error) = response.get("error") {
          return Err(format!("CDP refused the move: {error}"));
        }
        Ok(())
      }
      Ok(Some(Ok(_))) | Ok(None) => Ok(()),
      Ok(Some(Err(e))) => Err(format!("WebSocket error: {e}")),
      Err(_) => Err("Timed out moving the window".to_string()),
    }
  }

  /// Get all active sync sessions.
  pub async fn get_sessions(&self) -> Vec<SyncSessionInfo> {
    let inner = self.inner.lock().await;
    inner.sessions.values().map(SyncSession::info).collect()
  }

  // --- Helper methods ---

  fn get_profile(profile_id: &str) -> Result<BrowserProfile, String> {
    let profiles = ProfileManager::instance()
      .list_profiles()
      .map_err(|e| format!("Failed to list profiles: {e}"))?;
    profiles
      .into_iter()
      .find(|p| p.id.to_string() == profile_id)
      .ok_or(format!("Profile '{profile_id}' not found"))
  }

  async fn get_cdp_port(profile: &BrowserProfile) -> Result<u16, String> {
    for attempt in 0..15 {
      if attempt > 0 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
      }
      let port = crate::wayfern_manager::WayfernManager::instance()
        .cdp_port_for_profile(profile)
        .await;
      if let Some(p) = port {
        return Ok(p);
      }
    }
    Err(format!(
      "No CDP port available for profile '{}'. Browser may not be running.",
      profile.name
    ))
  }

  /// Get a page-level WebSocket URL
  async fn get_page_ws_url(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/json");
    let client = reqwest::Client::new();
    for attempt in 0..15 {
      if attempt > 0 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
      }
      if let Ok(resp) = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
      {
        if let Ok(targets) = resp.json::<Vec<serde_json::Value>>().await {
          if let Some(ws_url) = targets
            .iter()
            .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
            .and_then(|t| t.get("webSocketDebuggerUrl"))
            .and_then(|v| v.as_str())
          {
            return Ok(ws_url.to_string());
          }
        }
      }
    }
    Err("Failed to get CDP WebSocket URL".to_string())
  }
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn start_sync_session(
  app_handle: tauri::AppHandle,
  leader_profile_id: String,
  follower_profile_ids: Vec<String>,
) -> Result<SyncSessionInfo, String> {
  SynchronizerManager::instance()
    .start_session(app_handle, leader_profile_id, follower_profile_ids)
    .await
}

#[tauri::command]
pub async fn stop_sync_session(
  app_handle: tauri::AppHandle,
  session_id: String,
) -> Result<(), String> {
  SynchronizerManager::instance()
    .stop_session(app_handle, &session_id)
    .await
}

#[tauri::command]
pub async fn remove_sync_follower(
  app_handle: tauri::AppHandle,
  session_id: String,
  follower_profile_id: String,
) -> Result<(), String> {
  SynchronizerManager::instance()
    .remove_follower(app_handle, &session_id, &follower_profile_id)
    .await
}

#[tauri::command]
pub async fn get_sync_sessions() -> Result<Vec<SyncSessionInfo>, String> {
  Ok(SynchronizerManager::instance().get_sessions().await)
}

#[tauri::command]
pub async fn set_sync_session_paused(
  app_handle: tauri::AppHandle,
  session_id: String,
  paused: bool,
) -> Result<SyncSessionInfo, String> {
  SynchronizerManager::instance()
    .set_paused(app_handle, &session_id, paused)
    .await
}

#[tauri::command]
pub async fn set_sync_follower_held(
  app_handle: tauri::AppHandle,
  session_id: String,
  follower_profile_id: String,
  held: bool,
) -> Result<SyncSessionInfo, String> {
  SynchronizerManager::instance()
    .set_follower_held(app_handle, &session_id, &follower_profile_id, held)
    .await
}

#[tauri::command]
pub async fn arrange_sync_windows(
  app_handle: tauri::AppHandle,
  session_id: String,
  layout: WindowLayout,
) -> Result<SyncSessionInfo, String> {
  SynchronizerManager::instance()
    .arrange_windows(app_handle, &session_id, layout)
    .await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn overlaps(a: &WindowRect, b: &WindowRect) -> bool {
    let a_right = a.left + a.width as i32;
    let a_bottom = a.top + a.height as i32;
    let b_right = b.left + b.width as i32;
    let b_bottom = b.top + b.height as i32;
    a.left < b_right && b.left < a_right && a.top < b_bottom && b.top < a_bottom
  }

  fn on_screen(rect: &WindowRect, width: u32, height: u32) -> bool {
    rect.left >= 0
      && rect.top >= 0
      && rect.width > 0
      && rect.height > 0
      && rect.left + rect.width as i32 <= width as i32
      && rect.top + rect.height as i32 <= height as i32
  }

  #[test]
  fn every_layout_keeps_one_to_nine_windows_on_the_display() {
    for (width, height) in [(1920u32, 1080u32), (1280, 800), (2560, 1440), (1440, 900)] {
      for count in 1..=9usize {
        for layout in [
          WindowLayout::Grid,
          WindowLayout::Columns,
          WindowLayout::Cascade,
        ] {
          let rects = layout_windows(layout, count, width, height);
          assert_eq!(rects.len(), count, "{layout:?} produced the wrong count");
          for rect in &rects {
            assert!(
              on_screen(rect, width, height),
              "{layout:?} put {rect:?} outside {width}x{height} for {count} windows"
            );
          }
        }
      }
    }
  }

  #[test]
  fn the_grid_never_overlaps() {
    for (width, height) in [(1920u32, 1080u32), (1366, 768)] {
      for count in 1..=9usize {
        let rects = layout_windows(WindowLayout::Grid, count, width, height);
        for (i, a) in rects.iter().enumerate() {
          for b in rects.iter().skip(i + 1) {
            assert!(!overlaps(a, b), "{a:?} overlaps {b:?} for {count} windows");
          }
        }
      }
    }
  }

  #[test]
  fn the_grid_is_as_square_as_the_count_allows() {
    // Four windows are two by two, not four in a row: the whole point of the
    // grid rather than the columns layout.
    let rects = layout_windows(WindowLayout::Grid, 4, 1600, 1000);
    assert_eq!(
      rects[0],
      WindowRect {
        left: 0,
        top: 0,
        width: 800,
        height: 500
      }
    );
    assert_eq!(
      rects[1],
      WindowRect {
        left: 800,
        top: 0,
        width: 800,
        height: 500
      }
    );
    assert_eq!(
      rects[2],
      WindowRect {
        left: 0,
        top: 500,
        width: 800,
        height: 500
      }
    );
    assert_eq!(
      rects[3],
      WindowRect {
        left: 800,
        top: 500,
        width: 800,
        height: 500
      }
    );

    // A single window fills the display rather than sitting in a corner.
    assert_eq!(
      layout_windows(WindowLayout::Grid, 1, 1600, 1000),
      vec![WindowRect {
        left: 0,
        top: 0,
        width: 1600,
        height: 1000
      }]
    );
  }

  #[test]
  fn columns_run_left_to_right_at_full_height() {
    let rects = layout_windows(WindowLayout::Columns, 3, 1500, 900);
    for (index, rect) in rects.iter().enumerate() {
      assert_eq!(rect.top, 0);
      assert_eq!(rect.height, 900);
      assert_eq!(rect.width, 500);
      assert_eq!(rect.left, index as i32 * 500);
    }
    for (i, a) in rects.iter().enumerate() {
      for b in rects.iter().skip(i + 1) {
        assert!(!overlaps(a, b), "columns must not overlap either");
      }
    }
  }

  #[test]
  fn a_cascade_steps_down_and_right_without_leaving_the_display() {
    let rects = layout_windows(WindowLayout::Cascade, 5, 1920, 1080);
    for pair in rects.windows(2) {
      assert!(pair[1].left > pair[0].left, "each window steps right");
      assert!(pair[1].top > pair[0].top, "each window steps down");
      assert_eq!(pair[1].width, pair[0].width, "a cascade keeps one size");
    }
    let last = rects.last().unwrap();
    assert!(on_screen(last, 1920, 1080));

    // One window has nowhere to step to, so it sits at the origin.
    let single = layout_windows(WindowLayout::Cascade, 1, 1920, 1080);
    assert_eq!(single[0].left, 0);
    assert_eq!(single[0].top, 0);
  }

  #[test]
  fn nothing_is_arranged_without_windows_or_a_display() {
    assert!(layout_windows(WindowLayout::Grid, 0, 1920, 1080).is_empty());
    assert!(layout_windows(WindowLayout::Columns, 3, 0, 1080).is_empty());
    assert!(layout_windows(WindowLayout::Cascade, 3, 1920, 0).is_empty());
  }

  #[test]
  fn a_display_too_small_to_tile_is_reported_rather_than_tiled() {
    assert!(layout_fits(&layout_windows(
      WindowLayout::Grid,
      9,
      1920,
      1080
    )));
    // Nine columns on a 1280 wide display gives 142px windows, which no
    // browser will honour.
    assert!(!layout_fits(&layout_windows(
      WindowLayout::Columns,
      9,
      1280,
      800
    )));
  }

  /// A DOM.getDocument tree in the shape the browser returns it.
  fn node(
    backend: i64,
    name: &str,
    attributes: &[&str],
    children: Vec<serde_json::Value>,
  ) -> serde_json::Value {
    serde_json::json!({
      "nodeId": backend,
      "backendNodeId": backend,
      "nodeType": 1,
      "nodeName": name.to_uppercase(),
      "localName": name,
      "attributes": attributes,
      "children": children,
    })
  }

  fn text(backend: i64) -> serde_json::Value {
    serde_json::json!({ "nodeId": backend, "backendNodeId": backend, "nodeType": 3, "nodeName": "#text" })
  }

  fn mail_document() -> serde_json::Value {
    let rows = (1..=3)
      .map(|i| {
        node(
          100 + i,
          "div",
          &["class", "row"],
          vec![node(200 + i, "span", &[], vec![text(300 + i)])],
        )
      })
      .collect();
    serde_json::json!({
      "nodeId": 1,
      "backendNodeId": 1,
      "nodeType": 9,
      "nodeName": "#document",
      "children": [node(2, "html", &[], vec![
        node(3, "head", &[], vec![]),
        node(4, "body", &[], vec![
          node(5, "div", &["id", "list"], rows),
          node(6, "p", &[], vec![text(7), node(8, "a", &["href", "/x"], vec![text(9)])]),
        ]),
      ])],
    })
  }

  #[test]
  fn a_selector_starts_at_the_nearest_id_and_counts_same_tag_siblings() {
    let document = mail_document();
    assert_eq!(
      selector_for_node(&document, 203),
      Some((
        "#list > div:nth-of-type(3) > span:nth-of-type(1)".to_string(),
        203
      ))
    );
    // A hit on text names the element around it.
    assert_eq!(
      selector_for_node(&document, 302),
      Some((
        "#list > div:nth-of-type(2) > span:nth-of-type(1)".to_string(),
        202
      ))
    );
    // Without an id on the way up the path starts at html.
    assert_eq!(
      selector_for_node(&document, 9),
      Some((
        "html > body:nth-of-type(1) > p:nth-of-type(1) > a:nth-of-type(1)".to_string(),
        8
      ))
    );
    assert_eq!(selector_for_node(&document, 999), None);
  }

  #[test]
  fn an_id_that_is_not_a_plain_identifier_is_escaped() {
    assert_eq!(css_escape_ident("list"), "list");
    assert_eq!(css_escape_ident("1st"), "\\31 st");
    assert_eq!(css_escape_ident("a.b"), "a\\2e b");
  }

  fn quad(left: f64, top: f64, width: f64, height: f64) -> Vec<f64> {
    vec![
      left,
      top,
      left + width,
      top,
      left + width,
      top + height,
      left,
      top + height,
    ]
  }

  #[test]
  fn an_anchor_finds_the_same_spot_in_a_follower_layout() {
    // A link wrapped over two lines; the leader clicked its second line.
    let leader = [
      quad(500.0, 100.0, 120.0, 20.0),
      quad(40.0, 120.0, 80.0, 20.0),
    ];
    let anchor = anchor_in_quads("a".to_string(), &leader, 60.0, 125.0).unwrap();
    assert_eq!(anchor.quad, 1);
    assert!((anchor.rx - 0.25).abs() < 1e-9 && (anchor.ry - 0.25).abs() < 1e-9);
    // The follower's text is wider, so the link wraps elsewhere and sits lower.
    let follower = [
      quad(520.0, 300.0, 100.0, 22.0),
      quad(40.0, 322.0, 120.0, 22.0),
    ];
    let (x, y, top, height) = point_in_quads(&anchor, &follower).unwrap();
    assert!((x - 70.0).abs() < 1e-9 && (y - 327.5).abs() < 1e-9);
    assert_eq!((top, height), (322.0, 22.0));
    // A follower with fewer boxes uses its last one rather than none.
    let single = [quad(10.0, 10.0, 100.0, 20.0)];
    assert!(point_in_quads(&anchor, &single).is_some());
    // A point outside every box takes the nearest one, held inside it.
    let outside = anchor_in_quads("a".to_string(), &leader, 700.0, 50.0).unwrap();
    assert_eq!((outside.quad, outside.rx, outside.ry), (0, 1.0, 0.0));
  }

  #[test]
  fn alignment_scrolls_the_leader_content_under_the_same_point() {
    let anchor = PointAnchor {
      selector: "p".to_string(),
      quad: 0,
      rx: 0.5,
      ry: 0.5,
      top: 300.0,
      height: 100.0,
    };
    // The paragraph is 60 px lower here and taller: scroll down by the gap
    // between the two midpoints.
    assert_eq!(scroll_to_align(&anchor, 360.0, 120.0), 70.0);
    assert_eq!(scroll_to_align(&anchor, 300.0, 100.0), 0.0);
  }

  #[test]
  fn the_same_page_ignores_query_and_fragment() {
    assert!(same_page(
      "https://a.test/mail?sid=1",
      "https://a.test/mail?sid=2#top"
    ));
    assert!(!same_page("https://a.test/mail", "https://a.test/form"));
    assert!(!same_page("https://a.test/mail", "https://b.test/mail"));
  }

  #[test]
  fn the_barrier_waits_then_sends_the_follower_to_the_leader_page() {
    let mut page = FollowerPage {
      main_frame: "main".to_string(),
      url: "https://a.test/article".to_string(),
      loaded: true,
      dialog_open: false,
    };
    let leader = "https://a.test/mail";
    assert_eq!(barrier(leader, &page, false), Barrier::Wait);
    assert_eq!(barrier(leader, &page, true), Barrier::Navigate);
    page.url = "https://a.test/mail?from=link".to_string();
    page.loaded = false;
    assert_eq!(barrier(leader, &page, false), Barrier::Wait);
    assert_eq!(barrier(leader, &page, true), Barrier::Proceed);
    page.loaded = true;
    assert_eq!(barrier(leader, &page, false), Barrier::Ready);
  }

  #[test]
  fn page_events_move_the_follower_state() {
    let mut page = FollowerPage::default();
    apply_page_event(
      &mut page,
      "Page.frameNavigated",
      &serde_json::json!({ "frame": { "id": "main", "url": "https://a.test/app" } }),
    );
    assert_eq!(
      (page.url.as_str(), page.loaded),
      ("https://a.test/app", false)
    );
    // A child frame's navigation is not the page's.
    apply_page_event(
      &mut page,
      "Page.frameNavigated",
      &serde_json::json!({ "frame": { "id": "child", "parentId": "main", "url": "https://ads.test/" } }),
    );
    assert_eq!(page.url, "https://a.test/app");
    apply_page_event(
      &mut page,
      "Page.domContentEventFired",
      &serde_json::json!({}),
    );
    assert!(page.loaded);
    apply_page_event(
      &mut page,
      "Page.navigatedWithinDocument",
      &serde_json::json!({ "frameId": "main", "url": "https://a.test/app/products" }),
    );
    assert_eq!(page.url, "https://a.test/app/products");
    apply_page_event(
      &mut page,
      "Page.javascriptDialogOpening",
      &serde_json::json!({}),
    );
    assert!(page.dialog_open);
    apply_page_event(
      &mut page,
      "Page.javascriptDialogClosed",
      &serde_json::json!({}),
    );
    assert!(!page.dialog_open);
  }

  #[test]
  fn shortcuts_follow_the_host_key_and_the_follower_system() {
    // Ctrl on a Windows or Linux host, to a follower that claims macOS.
    let to_mac = ShortcutEditing {
      follower_apple: true,
      host_mac: false,
    };
    assert_eq!(to_mac.map_shortcut("a", 2, true), (4, Some("selectAll")));
    assert_eq!(to_mac.map_shortcut("z", 2 | 8, true), (4 | 8, Some("redo")));
    // The release carries the mapped modifier and no command.
    assert_eq!(to_mac.map_shortcut("a", 2, false), (4, None));
    // The same host, a follower that claims Windows: the key goes as it is.
    let same = ShortcutEditing {
      follower_apple: false,
      host_mac: false,
    };
    assert_eq!(same.map_shortcut("c", 2, true), (2, None));
    // Cmd on a Mac host: the command goes with the key to every follower.
    let mac_host = ShortcutEditing {
      follower_apple: false,
      host_mac: true,
    };
    assert_eq!(mac_host.map_shortcut("v", 4, true), (2, Some("paste")));
    let mac_to_mac = ShortcutEditing {
      follower_apple: true,
      host_mac: true,
    };
    assert_eq!(mac_to_mac.map_shortcut("x", 4, true), (4, Some("cut")));
    // Ctrl on a Mac host is not the host's shortcut key.
    assert_eq!(mac_host.map_shortcut("a", 2, true), (2, None));
    // Keys that are not editing shortcuts pass as they are.
    assert_eq!(to_mac.map_shortcut("t", 2, true), (2, None));
    assert_eq!(to_mac.map_shortcut("a", 0, true), (0, None));
  }

  #[test]
  fn an_anchor_travels_with_the_event_and_old_events_still_parse() {
    let captured: CapturedEvent = serde_json::from_value(serde_json::json!({
      "type": "mousedown", "x": 10.0, "y": 20.0, "button": "left", "clickCount": 1
    }))
    .unwrap();
    assert!(captured.anchor.is_none());
    let with_anchor = CapturedEvent {
      anchor: Some(PointAnchor {
        selector: "#list".to_string(),
        ..Default::default()
      }),
      ..captured
    };
    let round_trip: CapturedEvent =
      serde_json::from_value(serde_json::to_value(&with_anchor).unwrap()).unwrap();
    assert_eq!(round_trip.anchor, with_anchor.anchor);
  }

  #[test]
  fn holding_a_follower_out_stops_only_that_one() {
    let mut gate = MirrorGate::default();
    assert!(gate.accepts("a"));
    assert!(gate.accepts("b"));

    gate.set_held("a", true);
    assert!(gate.is_held("a"));
    assert!(!gate.accepts("a"));
    assert!(
      gate.accepts("b"),
      "holding one follower must not silence another"
    );

    gate.set_held("a", false);
    assert!(!gate.is_held("a"));
    assert!(gate.accepts("a"), "a follower comes back exactly as it was");

    // Setting the same state twice is not a toggle.
    gate.set_held("a", true);
    gate.set_held("a", true);
    assert!(!gate.accepts("a"));
    gate.set_held("a", false);
    assert!(gate.accepts("a"));
  }

  #[test]
  fn pausing_stops_everyone_and_resuming_restores_the_held_set() {
    let mut gate = MirrorGate::default();
    gate.set_held("held", true);

    gate.set_paused(true);
    assert!(gate.is_paused());
    assert!(!gate.accepts("free"), "a pause covers every follower");
    assert!(!gate.accepts("held"));

    gate.set_paused(false);
    assert!(!gate.is_paused());
    assert!(gate.accepts("free"));
    assert!(
      !gate.accepts("held"),
      "resuming must not quietly un-hold a follower the user held out"
    );
  }

  #[test]
  fn a_follower_that_leaves_does_not_stay_held() {
    let mut gate = MirrorGate::default();
    gate.set_held("gone", true);
    gate.forget("gone");
    assert!(!gate.is_held("gone"));
    assert!(
      gate.accepts("gone"),
      "a profile that rejoins later must not inherit the old hold"
    );
  }

  #[test]
  fn a_layout_round_trips_through_the_wire_format() {
    // The panel sends these names; a rename here has to fail loudly.
    assert_eq!(
      serde_json::from_str::<WindowLayout>("\"grid\"").unwrap(),
      WindowLayout::Grid
    );
    assert_eq!(
      serde_json::from_str::<WindowLayout>("\"columns\"").unwrap(),
      WindowLayout::Columns
    );
    assert_eq!(
      serde_json::from_str::<WindowLayout>("\"cascade\"").unwrap(),
      WindowLayout::Cascade
    );
    assert!(serde_json::from_str::<WindowLayout>("\"tiled\"").is_err());
  }

  #[test]
  fn session_info_carries_the_pause_and_hold_state() {
    let gate: SharedGate = Arc::new(std::sync::RwLock::new(MirrorGate::default()));
    let (cancel_tx, _cancel_rx) = tokio::sync::watch::channel(false);
    let session = SyncSession {
      id: "session".to_string(),
      leader_profile_id: "leader".to_string(),
      leader_profile_name: "Leader".to_string(),
      followers: vec![
        SyncFollowerState {
          profile_id: "one".to_string(),
          profile_name: "One".to_string(),
          failed_at_url: None,
          held: false,
        },
        SyncFollowerState {
          profile_id: "two".to_string(),
          profile_name: "Two".to_string(),
          failed_at_url: None,
          held: false,
        },
      ],
      gate: gate.clone(),
      cancel_tx,
    };

    let info = session.info();
    assert!(!info.paused);
    // The order the followers were chosen in is the order the panel and the
    // arrangement number them by.
    assert_eq!(
      info
        .followers
        .iter()
        .map(|f| f.profile_id.as_str())
        .collect::<Vec<_>>(),
      vec!["one", "two"]
    );

    gate.write().unwrap().set_paused(true);
    gate.write().unwrap().set_held("two", true);

    let info = session.info();
    assert!(info.paused);
    assert!(!info.followers[0].held);
    assert!(info.followers[1].held);
    assert!(session.has_follower("one"));
    assert!(!session.has_follower("missing"));
  }
}
