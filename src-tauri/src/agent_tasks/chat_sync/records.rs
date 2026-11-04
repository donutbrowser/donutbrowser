//! Sealed chats both ways. The listing brings changes and deletes from the
//! other devices; a full pass also deletes the synced chats the server no
//! longer lists. Uploads carry the rev they were made from, and a conflict
//! is settled by `updatedAt`, except that a turn running here always wins.

use super::crypto::{self, ChatKey};
use super::remote::Item;
use super::syncer::{is_uuid, Merge, Synced, Syncer};
use crate::agent_tasks::chat::Chat;
use crate::cloud_errors::BackendFailure;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// A chat whose turn runs uploads at most this often.
pub const UPLOAD_EVERY: Duration = Duration::from_secs(10);
/// The largest sealed chat the server takes.
const MAX_CHAT_BYTES: usize = 4 * 1024 * 1024;
/// Pages read in one listing before it gives up until the next round.
const MAX_PAGES: usize = 500;
/// Attempts at one upload: a conflict this copy wins, or a copy the server
/// found too large, tries again.
const ATTEMPTS: usize = 6;

static UNREADABLE: crate::log_streak::Throttle =
  crate::log_streak::Throttle::new(Duration::from_secs(3600));

/// Which copy of a chat stays when both devices changed it.
pub fn merge(local: Option<&Chat>, remote: &Chat, runs_here: bool) -> Merge {
  let Some(local) = local else {
    return Merge::Take;
  };
  if runs_here || remote.updated_at < local.updated_at {
    Merge::Keep
  } else if remote.updated_at > local.updated_at {
    Merge::Take
  } else {
    Merge::Same
  }
}

/// The sealed copy that goes up: whole when it fits under `limit`, else
/// without the steps of the oldest turns, then without the oldest turns.
/// The chat on this device keeps everything.
pub fn fit(key: &ChatKey, mut chat: Chat, limit: usize) -> Option<String> {
  let seal = |chat: &Chat| {
    serde_json::to_vec(chat)
      .ok()
      .and_then(|json| crypto::seal_chat(key, &chat.id, &json))
  };
  let data = seal(&chat)?;
  if data.len() <= limit {
    return Some(data);
  }
  let turns = chat.turns.len();
  let mut cut = 1;
  while cut <= turns {
    for turn in &mut chat.turns[..cut] {
      turn.task.steps.clear();
    }
    let data = seal(&chat)?;
    if data.len() <= limit {
      return Some(data);
    }
    cut = if cut == turns {
      cut + 1
    } else {
      (cut * 2).min(turns)
    };
  }
  let mut keep = chat.turns.len() / 2;
  while keep >= 1 {
    let drop = chat.turns.len() - keep;
    chat.turns.drain(..drop);
    let data = seal(&chat)?;
    if data.len() <= limit {
      return Some(data);
    }
    keep /= 2;
  }
  None
}

impl Syncer {
  fn open(&self, key: &ChatKey, id: &str, data: &str) -> Option<Chat> {
    let json = crypto::open_chat(key, id, data)?;
    serde_json::from_slice::<Chat>(&json)
      .ok()
      .filter(|chat| chat.id == id)
  }

  /// One chat of a listing or a conflict. Returns what became of it, or
  /// `None` for a delete or a copy that does not open.
  async fn apply(&mut self, key: &ChatKey, item: Item, changed: &mut bool) -> Option<Merge> {
    let Item { id, rev, data } = item;
    let Some(data) = data else {
      if self.local.get(&id).is_some() {
        self.local.remove(&id).await;
        log::info!("Agent chat deleted on another device chat={id}");
        *changed = true;
      }
      self.state.chats.remove(&id);
      self.deletes.done(&id);
      return None;
    };
    // This device's delete goes out first, and wins.
    if self.deletes.contains(&id) {
      return None;
    }
    let Some(chat) = self.open(key, &id, &data) else {
      if let Some(dropped) = UNREADABLE.allow("chat") {
        log::warn!(
          "Agent chat sync copy did not open chat={id}{}",
          crate::log_streak::suppressed(dropped)
        );
      }
      return None;
    };
    let updated_at = chat.updated_at;
    let merged = self.local.offer(chat);
    if merged == Merge::Take {
      *changed = true;
    }
    self.state.chats.insert(id, Synced { rev, updated_at });
    Some(merged)
  }

  /// Everything that changed on the server since the cursor. A full pass
  /// (no cursor, a new epoch, or a cursor the server let go) ends by
  /// deleting the synced chats it did not list.
  pub(super) async fn pull(&mut self) -> Result<(), BackendFailure> {
    let Some(key) = self.key.clone() else {
      return Ok(());
    };
    let started = Instant::now();
    let mut after = self.state.cursor.clone();
    let mut pass: Option<HashSet<String>> = None;
    let mut changed = false;
    let mut items = 0usize;
    let mut arrived = 0usize;
    let mut finished = false;
    for _ in 0..MAX_PAGES {
      let page = self.remote.list(after.as_deref()).await;
      let page = match page {
        Ok(page) => page,
        Err(e) => {
          self.save_state();
          return Err(e);
        }
      };
      if page.reset {
        pass = Some(HashSet::new());
      }
      for item in page.chats {
        if let Some(seen) = pass.as_mut() {
          seen.insert(item.id.clone());
        }
        items += 1;
        let known = self.state.chats.contains_key(&item.id);
        if self.apply(&key, item, &mut changed).await == Some(Merge::Take) && !known {
          arrived += 1;
        }
      }
      after = Some(page.cursor);
      if !page.more {
        finished = true;
        break;
      }
    }
    if !finished {
      self.save_state();
      return Ok(());
    }
    let mut gone = 0usize;
    if let Some(seen) = &pass {
      let unseen: Vec<String> = self
        .state
        .chats
        .keys()
        .filter(|id| !seen.contains(*id))
        .cloned()
        .collect();
      for id in unseen {
        self.state.chats.remove(&id);
        if self.local.get(&id).is_some() {
          self.local.remove(&id).await;
          gone += 1;
        }
      }
    }
    self.state.cursor = after;
    self.save_state();
    if changed || gone > 0 {
      self.local.listed();
    }
    let elapsed_ms = started.elapsed().as_millis();
    if arrived > 0 || gone > 0 || pass.is_some() {
      log::info!(
        "Agent chat sync pulled chats={items} new={arrived} gone={gone} full={} elapsed_ms={elapsed_ms}",
        pass.is_some()
      );
    } else {
      log::debug!("Agent chat sync pulled chats={items} elapsed_ms={elapsed_ms}");
    }
    Ok(())
  }

  /// Upload every chat that changed here since the server last had it. A
  /// chat whose turn runs goes at most once per `UPLOAD_EVERY`.
  pub(super) async fn push(&mut self) -> Result<(), BackendFailure> {
    let Some(key) = self.key.clone() else {
      return Ok(());
    };
    let now = Instant::now();
    let mut names: Option<HashMap<String, String>> = None;
    let mut sent = 0usize;
    for stamp in self.local.stamps() {
      if !is_uuid(&stamp.id) || self.deletes.contains(&stamp.id) {
        continue;
      }
      let synced = self.state.chats.get(&stamp.id);
      if synced.is_some_and(|s| s.updated_at == stamp.updated_at)
        || self.refused.get(&stamp.id) == Some(&stamp.updated_at)
      {
        continue;
      }
      if stamp.active {
        if let Some(due) = self.last_upload.get(&stamp.id).map(|at| *at + UPLOAD_EVERY) {
          if due > now {
            self.next_due = Some(self.next_due.map_or(due, |next| next.min(due)));
            continue;
          }
        }
      }
      let names = names.get_or_insert_with(|| self.local.profile_names());
      match self.upload(&key, &stamp.id, names).await {
        Ok(true) => sent += 1,
        Ok(false) => {}
        Err(e) => {
          self.save_state();
          return Err(e);
        }
      }
    }
    self.save_state();
    if sent > 0 {
      log::debug!("Agent chat sync pushed chats={sent}");
    }
    Ok(())
  }

  /// Upload one chat. Returns whether the server took this device's copy.
  async fn upload(
    &mut self,
    key: &ChatKey,
    id: &str,
    names: &HashMap<String, String>,
  ) -> Result<bool, BackendFailure> {
    let mut limit = MAX_CHAT_BYTES;
    let mut changed = false;
    for _ in 0..ATTEMPTS {
      let Some(mut chat) = self.local.get(id) else {
        return Ok(false);
      };
      if let Some(name) = names.get(&chat.profile_id) {
        chat.profile_name = Some(name.clone());
      }
      let updated_at = chat.updated_at;
      let base = self.state.chats.get(id).map(|s| s.rev);
      let Some(data) = fit(key, chat, limit) else {
        log::warn!("Agent chat sync chat too large chat={id}");
        self.refused.insert(id.to_string(), updated_at);
        return Ok(false);
      };
      let sent_len = data.len();
      match self.remote.put_chat(id, &data, base).await {
        Ok(rev) => {
          self
            .state
            .chats
            .insert(id.to_string(), Synced { rev, updated_at });
          self.last_upload.insert(id.to_string(), Instant::now());
          return Ok(true);
        }
        Err(e) if e.status == 410 => {
          self.forget(id, "deleted").await;
          return Ok(false);
        }
        // A server that takes less: a quarter less each time.
        Err(e) if e.status == 413 => limit = sent_len * 3 / 4,
        Err(e) if e.code == "CHAT_CHANGED" => {
          let rev = e.params.get("rev").and_then(|rev| rev.parse::<i64>().ok());
          let (Some(rev), Some(data)) = (rev, e.params.get("data").cloned()) else {
            // The account no longer has it, and no delete says so.
            self.forget(id, "gone").await;
            return Ok(false);
          };
          let item = Item {
            id: id.to_string(),
            rev,
            data: Some(data),
          };
          match self.apply(key, item, &mut changed).await {
            Some(Merge::Keep) => {}
            Some(_) => {
              if changed {
                self.local.listed();
              }
              return Ok(false);
            }
            None => {
              self.refused.insert(id.to_string(), updated_at);
              return Ok(false);
            }
          }
        }
        Err(e) if e.code == "CHAT_LIMIT" => {
          if let Some(dropped) = UNREADABLE.allow("limit") {
            log::warn!(
              "Agent chat sync refused: too many chats chat={id}{}",
              crate::log_streak::suppressed(dropped)
            );
          }
          self.refused.insert(id.to_string(), updated_at);
          return Ok(false);
        }
        Err(e) => return Err(e),
      }
    }
    Ok(false)
  }

  /// A chat the server says is deleted: it goes here too.
  async fn forget(&mut self, id: &str, why: &str) {
    self.state.chats.remove(id);
    self.last_upload.remove(id);
    self.local.remove(id).await;
    self.local.listed();
    log::info!("Agent chat deleted on another device chat={id} reason={why}");
  }
}
