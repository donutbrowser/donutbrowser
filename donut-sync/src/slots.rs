//! Who may stream through the server at once. Every transfer holds a slot:
//! one of `MAX_TRANSFERS`, and one of `MAX_PER_NAMESPACE` of its account, so a
//! few devices syncing at once cannot hold every slot. A request that finds
//! none free within `SLOT_WAIT` is answered 503, well inside a proxy's
//! response timeout. A slot is given back after `MAX_HOLD` even if its
//! transfer still runs, so a client that stops reading cannot keep it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_TRANSFERS: usize = 64;
const MAX_PER_NAMESPACE: usize = 8;
pub const SLOT_WAIT: Duration = Duration::from_secs(20);
const MAX_HOLD: Duration = Duration::from_secs(600);
/// Accounts whose semaphores are kept while idle.
const NAMESPACES_KEPT: usize = 10_000;

type Permits = (Option<OwnedSemaphorePermit>, OwnedSemaphorePermit);

/// A held slot; dropping it gives the slot back.
pub struct Slot {
  _permits: Arc<Mutex<Option<Permits>>>,
}

pub struct Slots {
  global: Arc<Semaphore>,
  namespaces: Mutex<HashMap<String, Arc<Semaphore>>>,
  max_hold: Duration,
}

impl Default for Slots {
  fn default() -> Self {
    Self::new(MAX_TRANSFERS, MAX_HOLD)
  }
}

/// The account a key belongs to (`users/<id>/`); `None` on a self-hosted
/// server, where every key is the same owner's.
fn namespace(key: &str) -> Option<&str> {
  let rest = key.strip_prefix("users/")?;
  let end = rest.find('/')?;
  Some(&key[..6 + end + 1])
}

impl Slots {
  pub fn new(global: usize, max_hold: Duration) -> Self {
    Self {
      global: Arc::new(Semaphore::new(global)),
      namespaces: Mutex::new(HashMap::new()),
      max_hold,
    }
  }

  fn namespace_semaphore(&self, key: &str) -> Option<Arc<Semaphore>> {
    let namespace = namespace(key)?;
    let mut namespaces = self.namespaces.lock().unwrap();
    if namespaces.len() > NAMESPACES_KEPT {
      namespaces.retain(|_, s| s.available_permits() < MAX_PER_NAMESPACE);
    }
    Some(
      namespaces
        .entry(namespace.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_PER_NAMESPACE)))
        .clone(),
    )
  }

  /// A slot for a transfer of `key`, or `None` when none came free within
  /// `wait`.
  pub async fn acquire(&self, key: &str, wait: Duration) -> Option<Slot> {
    let own = self.namespace_semaphore(key);
    let global = self.global.clone();
    let permits = tokio::time::timeout(wait, async move {
      let own = match own {
        Some(own) => Some(own.acquire_owned().await.ok()?),
        None => None,
      };
      Some((own, global.acquire_owned().await.ok()?))
    })
    .await
    .ok()??;
    let held = Arc::new(Mutex::new(Some(permits)));
    let weak: Weak<Mutex<Option<Permits>>> = Arc::downgrade(&held);
    let max_hold = self.max_hold;
    tokio::spawn(async move {
      tokio::time::sleep(max_hold).await;
      if let Some(held) = weak.upgrade() {
        held.lock().unwrap().take();
      }
    });
    Some(Slot { _permits: held })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const WAIT: Duration = Duration::from_millis(50);

  #[test]
  fn namespaces_are_accounts() {
    assert_eq!(namespace("users/u1/profiles/p/files/a"), Some("users/u1/"));
    assert_eq!(namespace("users/u1"), None);
    assert_eq!(namespace("profiles/p/files/a"), None);
  }

  #[tokio::test]
  async fn one_account_cannot_take_every_slot() {
    let slots = Slots::new(10, MAX_HOLD);
    let mut held = Vec::new();
    for _ in 0..MAX_PER_NAMESPACE {
      held.push(slots.acquire("users/a/x", WAIT).await.unwrap());
    }
    assert!(slots.acquire("users/a/y", WAIT).await.is_none());
    held.push(slots.acquire("users/b/x", WAIT).await.unwrap());
    held.push(slots.acquire("users/c/x", WAIT).await.unwrap());
    assert!(
      slots.acquire("users/d/x", WAIT).await.is_none(),
      "all 10 in use"
    );
    held.pop();
    assert!(slots.acquire("users/d/x", WAIT).await.is_some());
  }

  #[tokio::test]
  async fn self_hosted_keys_share_only_the_global_limit() {
    let slots = Slots::new(MAX_PER_NAMESPACE + 2, MAX_HOLD);
    let mut held = Vec::new();
    for _ in 0..MAX_PER_NAMESPACE + 2 {
      held.push(slots.acquire("profiles/p/files/a", WAIT).await.unwrap());
    }
    assert!(slots.acquire("profiles/p/files/a", WAIT).await.is_none());
  }

  #[tokio::test]
  async fn a_slot_held_too_long_is_given_back() {
    let slots = Slots::new(1, Duration::from_millis(20));
    let _stuck = slots.acquire("k", WAIT).await.unwrap();
    assert!(
      slots
        .acquire("k", Duration::from_millis(200))
        .await
        .is_some()
    );
  }
}
