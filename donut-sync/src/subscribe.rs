//! `GET /v1/objects/subscribe`: a long-lived poll per client, sent as
//! server-sent events.
//!
//! The steady-state cost is one HEAD per scope per poll. A LIST is only made
//! on the first poll (to learn what exists) and when a write bumped the
//! scope's manifest. This is eventual cross-device sync, at the poll interval.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior, interval, interval_at};

use crate::auth::{Mode, UserContext};
use crate::error::ApiError;
use crate::log;
use crate::store::{ListInput, StoreError};
use crate::sync::{MANIFEST_KEY, SyncService};
use crate::time;

const CONTEXT: &str = "SyncService";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// Frames queued for a client that is not reading. Past this, the poll waits.
const QUEUE: usize = 1024;

/// Every key prefix the desktop reacts to. Filtering happens after the one
/// LIST per scope, so a prefix here costs no extra S3 call.
const BASE_PREFIXES: [&str; 9] = [
  "profiles/",
  "proxies/",
  "groups/",
  "vpns/",
  "extensions/",
  "extension_groups/",
  "statuses/",
  "templates/",
  "tombstones/",
];

/// The keys seen on the last listing, in listing order.
#[derive(Default)]
struct Seen {
  order: Vec<String>,
  state: HashMap<String, String>,
}

impl Seen {
  fn insert(&mut self, key: String, state: String) {
    if self.state.insert(key.clone(), state).is_none() {
      self.order.push(key);
    }
  }
}

#[derive(Default)]
struct PollState {
  etags: HashMap<String, Option<String>>,
  seen: Seen,
  initialized: bool,
}

fn scopes_for(ctx: &UserContext) -> Vec<String> {
  match ctx.mode {
    Mode::SelfHosted => vec![String::new()],
    _ => vec![ctx.prefix.clone()],
  }
}

async fn poll_once(
  service: &SyncService,
  ctx: &UserContext,
  state: &mut PollState,
) -> Result<Vec<Value>, ApiError> {
  let store = service.store();
  let scopes = scopes_for(ctx);

  // Phase 1: a HEAD on each scope's manifest.
  let mut any_scope_changed = false;
  for scope in &scopes {
    let manifest = format!("{scope}{MANIFEST_KEY}");
    let etag = match store.head_object(&manifest).await {
      Ok(head) => head.etag,
      // No manifest yet: no change.
      Err(StoreError::NotFound) => None,
      Err(e) => {
        log::error(
          CONTEXT,
          &format!("Manifest HEAD failed for {manifest}: {e}"),
        );
        continue;
      }
    };
    let previous = state.etags.get(scope).cloned().flatten();
    if previous != etag {
      any_scope_changed = true;
    }
    state.etags.insert(scope.clone(), etag);
  }
  if state.initialized && !any_scope_changed {
    return Ok(Vec::new());
  }

  // Phase 2: one LIST per scope, filtered to the base prefixes here.
  let mut events = Vec::new();
  let mut current = Seen::default();
  for scope in &scopes {
    let mut token = None;
    loop {
      let page = match store
        .list_objects_v2(&ListInput {
          prefix: Some(scope.clone()),
          max_keys: Some("1000".to_string()),
          continuation_token: token.clone(),
          delimiter: None,
        })
        .await
      {
        Ok(page) => page,
        Err(e) => {
          log::error(CONTEXT, &format!("List failed for scope '{scope}': {e}"));
          break;
        }
      };
      for object in page.contents {
        let relative = object
          .key
          .strip_prefix(scope.as_str())
          .unwrap_or(&object.key)
          .to_string();
        if relative == MANIFEST_KEY || !BASE_PREFIXES.iter().any(|p| relative.starts_with(p)) {
          continue;
        }
        let last_modified = object
          .last_modified_ms
          .map(time::iso_from_ms)
          .unwrap_or_default();
        let state_key = format!("{relative}:{last_modified}");
        if state.seen.state.get(&relative) != Some(&state_key) {
          events.push(json!({
            "type": "change",
            "key": relative,
            "lastModified": last_modified,
            "size": object.size.unwrap_or(0),
          }));
        }
        current.insert(relative, state_key);
      }
      token = page.next_continuation_token;
      if token.is_none() {
        break;
      }
    }
  }

  // Deletes: keys seen last time and missing now.
  for key in &state.seen.order {
    if !current.state.contains_key(key) {
      events.push(json!({ "type": "delete", "key": key }));
    }
  }
  state.seen = current;
  state.initialized = true;

  // A limited member learns nothing about profiles outside its groups, not
  // even that they changed.
  let prefix = ctx.prefix.clone();
  service
    .reachable_only(ctx, events, |event| {
      format!("{prefix}{}", event["key"].as_str().unwrap_or(""))
    })
    .await
}

fn frame(id: u64, data: &Value) -> Bytes {
  Bytes::from(format!("id: {id}\ndata: {data}\n\n"))
}

/// Starts a client's poll loop. The stream begins with a blank line, then one
/// `id:`/`data:` frame per event. The loop ends when the client goes away.
pub fn spawn(service: Arc<SyncService>, ctx: UserContext) -> mpsc::Receiver<Bytes> {
  let (tx, rx) = mpsc::channel(QUEUE);
  tokio::spawn(async move {
    if tx.send(Bytes::from_static(b"\n")).await.is_err() {
      return;
    }
    let mut id = 0u64;
    let mut state = PollState::default();
    let mut poll = interval(POLL_INTERVAL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ping = interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    loop {
      let events = tokio::select! {
        () = tx.closed() => return,
        _ = poll.tick() => match poll_once(&service, &ctx, &mut state).await {
          Ok(events) => events,
          Err(e) => {
            log::error(CONTEXT, &format!("Error in subscribe poll: {}", e.describe()));
            vec![json!({ "type": "ping" })]
          }
        },
        _ = ping.tick() => vec![json!({ "type": "ping" })],
      };
      for event in events {
        id += 1;
        if tx.send(frame(id, &event)).await.is_err() {
          return;
        }
      }
    }
  });
  rx
}
