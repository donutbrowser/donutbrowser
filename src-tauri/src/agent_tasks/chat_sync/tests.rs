//! Several devices of one account against the in-memory server.

use super::crypto::DeviceKey;
use super::memory::{live_ids, Memory, Server};
use super::records::{fit, merge};
use super::remote::{Item, KeyState, Page, Remote, Waiting, WaitingDevice};
use super::syncer::{Deletes, Local, Merge, Stamp, Syncer};
use crate::agent_tasks::chat::Chat;
use crate::agent_tasks::model::{Step, TaskStatus};
use crate::cloud_errors::BackendFailure;
use async_trait::async_trait;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Phone {
  chats: Mutex<BTreeMap<String, Chat>>,
  running: Mutex<HashSet<String>>,
  removed: Mutex<Vec<String>>,
  listed: AtomicUsize,
}

impl Phone {
  fn put(&self, chat: Chat) {
    self.chats.lock().unwrap().insert(chat.id.clone(), chat);
  }

  fn chat(&self, id: &str) -> Option<Chat> {
    self.chats.lock().unwrap().get(id).cloned()
  }

  fn ids(&self) -> Vec<String> {
    self.chats.lock().unwrap().keys().cloned().collect()
  }

  /// A change on this device: a new title and a later `updatedAt`.
  fn edit(&self, id: &str, title: &str, at: u64) {
    let mut chats = self.chats.lock().unwrap();
    let chat = chats.get_mut(id).unwrap();
    chat.title = title.to_string();
    chat.updated_at = at;
  }
}

#[async_trait]
impl Local for Phone {
  fn stamps(&self) -> Vec<Stamp> {
    let running = self.running.lock().unwrap();
    self
      .chats
      .lock()
      .unwrap()
      .values()
      .map(|chat| Stamp {
        id: chat.id.clone(),
        updated_at: chat.updated_at,
        active: running.contains(&chat.id),
      })
      .collect()
  }

  fn get(&self, id: &str) -> Option<Chat> {
    self.chat(id)
  }

  fn offer(&self, chat: Chat) -> Merge {
    let runs = self.running.lock().unwrap().contains(&chat.id);
    let mut chats = self.chats.lock().unwrap();
    let merged = merge(chats.get(&chat.id), &chat, runs);
    if merged == Merge::Take {
      chats.insert(chat.id.clone(), chat);
    }
    merged
  }

  async fn remove(&self, id: &str) {
    self.running.lock().unwrap().remove(id);
    if self.chats.lock().unwrap().remove(id).is_some() {
      self.removed.lock().unwrap().push(id.to_string());
    }
  }

  fn profile_names(&self) -> HashMap<String, String> {
    HashMap::from([("p1".to_string(), "Travel".to_string())])
  }

  fn listed(&self) {
    self.listed.fetch_add(1, Ordering::SeqCst);
  }
}

struct Device {
  sync: Syncer,
  phone: Arc<Phone>,
  deletes: Arc<Deletes>,
}

fn cloud() -> Arc<Mutex<Server>> {
  Arc::new(Mutex::new(Server::default()))
}

fn device_with(remote: Box<dyn Remote>) -> Device {
  let phone = Arc::new(Phone::default());
  let deletes = Arc::new(Deletes::in_memory());
  let sync = Syncer::new("acct", remote, phone.clone(), deletes.clone(), None);
  Device {
    sync,
    phone,
    deletes,
  }
}

fn device(server: &Arc<Mutex<Server>>) -> Device {
  device_with(Box::new(Memory::new(server.clone())))
}

fn chat_at(title: &str, at: u64) -> Chat {
  let mut chat = Chat::new("p1", title.to_string(), at);
  chat.turns[0].task.status = TaskStatus::Done;
  chat
}

fn add_turn(chat: &mut Chat, text: &str, at: u64) {
  let mut turn = chat.turns[0].clone();
  turn.id = uuid::Uuid::new_v4().to_string();
  turn.text = text.to_string();
  turn.task.steps.clear();
  chat.turns.push(turn);
  chat.updated_at = at;
}

fn step(index: u64) -> Step {
  Step {
    index,
    kind: "act".into(),
    text: format!("Clicked button number {index} on the page with a long label"),
    url: Some(format!("https://example.com/page/{index}")),
    tool: None,
    at: index,
  }
}

fn requests(server: &Arc<Mutex<Server>>, name: &str) -> usize {
  server
    .lock()
    .unwrap()
    .requests
    .iter()
    .filter(|r| *r == name)
    .count()
}

fn data_of(server: &Arc<Mutex<Server>>, id: &str) -> Option<String> {
  server
    .lock()
    .unwrap()
    .chats
    .get(id)
    .and_then(|row| row.data.clone())
}

/// A and B, both holding the key, with `chat` synced to both.
async fn pair_with(server: &Arc<Mutex<Server>>, chat: Chat) -> (Device, Device) {
  let mut a = device(server);
  let mut b = device(server);
  a.phone.put(chat);
  a.sync.cycle().await.unwrap();
  b.sync.cycle().await.unwrap();
  a.sync.cycle().await.unwrap();
  b.sync.cycle().await.unwrap();
  assert!(!b.sync.locked);
  (a, b)
}

#[tokio::test]
async fn the_first_app_makes_the_key_and_the_next_device_waits_for_its_wrap() {
  let server = cloud();
  let mut a = device(&server);
  let flight = chat_at("Find the cheapest flight to Lisbon", 10);
  a.phone.put(flight.clone());
  a.sync.cycle().await.unwrap();
  assert!(!a.sync.locked);
  let key_id = server.lock().unwrap().key_id.clone().unwrap();
  assert_eq!(a.sync.key.as_ref().unwrap().id, key_id);
  let data = data_of(&server, &flight.id).unwrap();
  assert!(data.starts_with(&format!("v1.{key_id}.")));
  assert!(!data.contains("Lisbon"), "the server holds no words");

  let mut b = device(&server);
  b.phone.put(chat_at("A chat made while locked", 11));
  b.sync.cycle().await.unwrap();
  assert!(b.sync.locked);
  assert!(b.sync.key.is_none());
  assert_eq!(requests(&server, "list"), 1, "only A listed");
  assert_eq!(
    server.lock().unwrap().live(),
    1,
    "a locked device uploads nothing"
  );

  // A sees B waiting and wraps the key for it.
  a.sync.cycle().await.unwrap();
  b.sync.cycle().await.unwrap();
  assert!(!b.sync.locked);
  assert_eq!(b.sync.key, a.sync.key);
  assert_eq!(b.phone.chat(&flight.id).unwrap().title, flight.title);
  assert_eq!(
    server.lock().unwrap().live(),
    2,
    "B's own chat went up once it held the key"
  );
  a.sync.cycle().await.unwrap();
  assert_eq!(a.phone.ids().len(), 2);

  // A web browser that registers is wrapped for too, and opens the key.
  let web = DeviceKey::generate().unwrap();
  let web_id = "33333333-3333-4333-8333-333333333333";
  Memory::new(server.clone())
    .register(web_id, &web.public)
    .await
    .unwrap();
  a.sync.cycle().await.unwrap();
  let KeyState {
    key_id: Some(current),
    wrapped_key: Some(wrapped),
  } = Memory::new(server.clone()).key(web_id).await.unwrap()
  else {
    panic!("no wrap for the web");
  };
  assert_eq!(web.unwrap(&wrapped, &current, web_id), a.sync.key);
}

#[tokio::test]
async fn a_lost_key_race_waits_for_the_winners_wrap() {
  struct LateCreate {
    inner: Memory,
  }
  #[async_trait]
  impl Remote for LateCreate {
    async fn key(&self, d: &str) -> Result<KeyState, BackendFailure> {
      self.inner.key(d).await
    }
    async fn register(&self, d: &str, p: &str) -> Result<(), BackendFailure> {
      self.inner.register(d, p).await
    }
    async fn create_key(&self, k: &str, d: &str) -> Result<(), BackendFailure> {
      // Another app made the key between our read and our write.
      self.inner.server.lock().unwrap().key_id = Some("AAECAwQFBgcICQoLDA0ODw".into());
      self.inner.create_key(k, d).await
    }
    async fn waiting(&self) -> Result<Waiting, BackendFailure> {
      self.inner.waiting().await
    }
    async fn put_wrap(&self, d: &str, k: &str, p: &str, w: &str) -> Result<(), BackendFailure> {
      self.inner.put_wrap(d, k, p, w).await
    }
    async fn erase(&self) -> Result<(), BackendFailure> {
      self.inner.erase().await
    }
    async fn list(&self, after: Option<&str>) -> Result<Page, BackendFailure> {
      self.inner.list(after).await
    }
    async fn put_chat(&self, c: &str, d: &str, b: Option<i64>) -> Result<i64, BackendFailure> {
      self.inner.put_chat(c, d, b).await
    }
    async fn delete_chat(&self, c: &str) -> Result<(), BackendFailure> {
      self.inner.delete_chat(c).await
    }
  }
  let server = cloud();
  let mut loser = device_with(Box::new(LateCreate {
    inner: Memory::new(server.clone()),
  }));
  loser.sync.cycle().await.unwrap();
  assert!(loser.sync.locked);
  assert!(loser.sync.key.is_none(), "the loser drops its key");
  assert_eq!(
    server.lock().unwrap().key_id.as_deref(),
    Some("AAECAwQFBgcICQoLDA0ODw")
  );
}

#[tokio::test]
async fn the_newer_copy_wins_and_a_turn_running_here_keeps_its_own() {
  let server = cloud();
  let first = chat_at("Plan a trip", 10);
  let id = first.id.clone();
  let (mut a, mut b) = pair_with(&server, first).await;

  // Both change it; B's change is later, A's goes up first.
  a.phone.edit(&id, "A's title", 20);
  b.phone.edit(&id, "B's title", 30);
  a.sync.cycle().await.unwrap();
  b.sync.cycle().await.unwrap();
  a.sync.cycle().await.unwrap();
  assert_eq!(a.phone.chat(&id).unwrap().title, "B's title");
  assert_eq!(b.phone.chat(&id).unwrap().title, "B's title");

  // An upload that conflicts with an older copy tries again over it.
  b.phone.edit(&id, "B again", 50);
  a.phone.edit(&id, "A older", 40);
  a.sync.cycle().await.unwrap();
  let before = requests(&server, "put_chat");
  b.sync.push_only().await.unwrap();
  assert_eq!(
    requests(&server, "put_chat") - before,
    2,
    "409, then over it"
  );
  a.sync.cycle().await.unwrap();
  assert_eq!(a.phone.chat(&id).unwrap().title, "B again");

  // A newer copy does not replace a turn that runs here.
  a.phone.running.lock().unwrap().insert(id.clone());
  b.phone.edit(&id, "B while A works", 70);
  b.sync.cycle().await.unwrap();
  a.phone.edit(&id, "A working", 60);
  // Ten seconds since A's last upload.
  a.sync.last_upload.clear();
  a.sync.cycle().await.unwrap();
  assert_eq!(a.phone.chat(&id).unwrap().title, "A working");
  let server_copy = data_of(&server, &id).unwrap();
  let opened = super::crypto::open_chat(a.sync.key.as_ref().unwrap(), &id, &server_copy).unwrap();
  let on_server: Chat = serde_json::from_slice(&opened).unwrap();
  assert_eq!(on_server.title, "A working");
  assert_eq!(on_server.profile_name.as_deref(), Some("Travel"));
}

#[tokio::test]
async fn a_delete_reaches_every_device_and_always_wins() {
  let server = cloud();
  let first = chat_at("Check the weather", 10);
  let id = first.id.clone();
  let (mut a, mut b) = pair_with(&server, first).await;
  b.phone.running.lock().unwrap().insert(id.clone());

  // Deleted on A while offline: the delete waits, then goes.
  a.phone.remove(&id).await;
  a.deletes.add(&id);
  server.lock().unwrap().offline = true;
  assert!(a.sync.cycle().await.is_err());
  assert!(a.deletes.contains(&id));
  server.lock().unwrap().offline = false;
  a.sync.cycle().await.unwrap();
  assert!(!a.deletes.contains(&id));

  // B removes it and stops its turn.
  b.sync.cycle().await.unwrap();
  assert!(b.phone.chat(&id).is_none());
  assert_eq!(*b.phone.removed.lock().unwrap(), vec![id.clone()]);
  assert!(b.phone.listed.load(Ordering::SeqCst) > 0);
  assert!(live_ids(&server.lock().unwrap()).is_empty());

  // An edit made before B saw the delete gets 410 and goes too.
  let second = chat_at("Second", 20);
  let second_id = second.id.clone();
  a.phone.put(second);
  a.sync.cycle().await.unwrap();
  b.sync.cycle().await.unwrap();
  a.phone.remove(&second_id).await;
  a.deletes.add(&second_id);
  a.sync.cycle().await.unwrap();
  b.phone.edit(&second_id, "Edited too late", 30);
  b.sync.push_only().await.unwrap();
  assert!(b.phone.chat(&second_id).is_none());
  assert!(live_ids(&server.lock().unwrap()).is_empty());

  // A delete for a chat the server never had leaves a tombstone, so a late
  // first upload loses.
  let mut c = device(&server);
  let late = chat_at("Late", 40);
  let late_id = late.id.clone();
  Memory::new(server.clone())
    .delete_chat(&late_id)
    .await
    .unwrap();
  c.phone.put(late);
  c.sync.cycle().await.unwrap();
  a.sync.cycle().await.unwrap();
  c.sync.cycle().await.unwrap();
  assert!(c.phone.chat(&late_id).is_none());
}

#[tokio::test]
async fn a_full_pass_deletes_the_synced_chats_the_server_no_longer_has() {
  let server = cloud();
  server.lock().unwrap().page = 2;
  let mut a = device(&server);
  let chats: Vec<Chat> = (0..5).map(|n| chat_at(&format!("Chat {n}"), n)).collect();
  for chat in &chats {
    a.phone.put(chat.clone());
  }
  a.sync.cycle().await.unwrap();
  assert_eq!(server.lock().unwrap().live(), 5);

  // B reads all five over three pages.
  let mut b = device(&server);
  b.sync.cycle().await.unwrap();
  a.sync.cycle().await.unwrap();
  b.sync.cycle().await.unwrap();
  assert_eq!(b.phone.ids().len(), 5);

  // A tombstone purged after its time: an older cursor resets.
  let gone = chats[2].id.clone();
  {
    let mut s = server.lock().unwrap();
    s.chats.remove(&gone);
    s.rev += 1;
    s.purged_rev = s.rev;
  }
  let unsynced = chat_at("Only on B", 99);
  b.phone.put(unsynced.clone());
  b.sync.cycle().await.unwrap();
  assert!(b.phone.chat(&gone).is_none());
  assert_eq!(b.phone.ids().len(), 5, "four kept, one new");
  assert!(b.sync.state.cursor.is_some());
  assert!(live_ids(&server.lock().unwrap()).contains(&unsynced.id));
}

#[tokio::test]
async fn an_upload_of_a_chat_the_server_lost_deletes_it_here() {
  let server = cloud();
  let first = chat_at("Lost", 10);
  let id = first.id.clone();
  let (mut a, _b) = pair_with(&server, first).await;
  server.lock().unwrap().chats.remove(&id);
  a.phone.edit(&id, "Edited", 20);
  a.sync.push_only().await.unwrap();
  assert!(a.phone.chat(&id).is_none());
}

#[tokio::test]
async fn a_running_turn_uploads_at_most_every_ten_seconds() {
  let server = cloud();
  let mut a = device(&server);
  let chat = chat_at("Working", 10);
  let id = chat.id.clone();
  a.phone.put(chat);
  a.phone.running.lock().unwrap().insert(id.clone());
  a.sync.cycle().await.unwrap();
  assert_eq!(requests(&server, "put_chat"), 1, "a new chat goes at once");
  a.phone.edit(&id, "Step 1", 11);
  a.sync.push_only().await.unwrap();
  a.phone.edit(&id, "Step 2", 12);
  a.sync.push_only().await.unwrap();
  assert_eq!(requests(&server, "put_chat"), 1);
  assert!(a.sync.next_due.is_some());

  // The turn ends: the chat goes at once.
  a.phone.running.lock().unwrap().remove(&id);
  a.phone.edit(&id, "Done", 13);
  a.sync.push_only().await.unwrap();
  assert_eq!(requests(&server, "put_chat"), 2);
  a.sync.push_only().await.unwrap();
  assert_eq!(requests(&server, "put_chat"), 2, "nothing changed");
}

#[tokio::test]
async fn erase_unlocks_and_the_old_synced_chats_go_from_every_device() {
  let server = cloud();
  let old = chat_at("Synced under the first key", 10);
  let old_id = old.id.clone();
  let mut a = device(&server);
  a.phone.put(old);
  a.sync.cycle().await.unwrap();

  // C cannot unlock (A is away) and erases.
  let mut c = device(&server);
  let mine = chat_at("Made on C", 20);
  let mine_id = mine.id.clone();
  c.phone.put(mine);
  c.sync.cycle().await.unwrap();
  assert!(c.sync.locked);
  c.sync.erase().await.unwrap();
  c.sync.cycle().await.unwrap();
  assert!(!c.sync.locked);
  assert_eq!(
    live_ids(&server.lock().unwrap()),
    [mine_id.clone()].into_iter().collect()
  );

  // A finds another key: it drops its own and waits.
  a.sync.cycle().await.unwrap();
  assert!(a.sync.locked);
  assert!(a.sync.key.is_none());
  assert!(a.phone.chat(&old_id).is_some(), "kept while locked");
  c.sync.cycle().await.unwrap();
  a.sync.cycle().await.unwrap();
  assert!(!a.sync.locked);
  assert!(a.phone.chat(&old_id).is_none(), "erased everywhere");
  assert!(a.phone.chat(&mine_id).is_some());
}

#[tokio::test]
async fn the_wrap_loop_skips_a_device_that_moved_on() {
  struct Stale {
    inner: Memory,
  }
  #[async_trait]
  impl Remote for Stale {
    async fn key(&self, d: &str) -> Result<KeyState, BackendFailure> {
      self.inner.key(d).await
    }
    async fn register(&self, d: &str, p: &str) -> Result<(), BackendFailure> {
      self.inner.register(d, p).await
    }
    async fn create_key(&self, k: &str, d: &str) -> Result<(), BackendFailure> {
      self.inner.create_key(k, d).await
    }
    async fn waiting(&self) -> Result<Waiting, BackendFailure> {
      // A device listed with a public key it has since replaced.
      let mut waiting = self.inner.waiting().await?;
      waiting.devices.push(WaitingDevice {
        device_id: "44444444-4444-4444-8444-444444444444".into(),
        public_key: DeviceKey::generate().unwrap().public,
      });
      Ok(waiting)
    }
    async fn put_wrap(&self, d: &str, k: &str, p: &str, w: &str) -> Result<(), BackendFailure> {
      self.inner.put_wrap(d, k, p, w).await
    }
    async fn erase(&self) -> Result<(), BackendFailure> {
      self.inner.erase().await
    }
    async fn list(&self, after: Option<&str>) -> Result<Page, BackendFailure> {
      self.inner.list(after).await
    }
    async fn put_chat(&self, c: &str, d: &str, b: Option<i64>) -> Result<i64, BackendFailure> {
      self.inner.put_chat(c, d, b).await
    }
    async fn delete_chat(&self, c: &str) -> Result<(), BackendFailure> {
      self.inner.delete_chat(c).await
    }
  }
  let server = cloud();
  let mut a = device_with(Box::new(Stale {
    inner: Memory::new(server.clone()),
  }));
  a.sync.cycle().await.unwrap();
  a.sync.cycle().await.unwrap();
  assert!(!a.sync.locked);
}

#[tokio::test]
async fn a_chat_too_large_goes_up_trimmed_and_stays_whole_here() {
  let server = cloud();
  let mut a = device(&server);
  let mut chat = chat_at("Long", 10);
  for turn in 1..6u64 {
    add_turn(&mut chat, &format!("Turn {turn}"), 10 + turn);
  }
  for (n, turn) in chat.turns.iter_mut().enumerate() {
    turn.task.status = TaskStatus::Done;
    for index in 0..60 {
      turn.task.steps.push_back(step(index * 100 + n as u64));
    }
  }
  let id = chat.id.clone();
  // A server that takes less than the whole chat: it answers 413.
  let whole = fit(&super::crypto::ChatKey::mint(), chat.clone(), usize::MAX).unwrap();
  server.lock().unwrap().max_bytes = whole.len() * 6 / 10;
  a.phone.put(chat.clone());
  a.sync.cycle().await.unwrap();
  let data = data_of(&server, &id).expect("a trimmed copy went up");
  assert!(requests(&server, "put_chat") > 1);
  let opened = super::crypto::open_chat(a.sync.key.as_ref().unwrap(), &id, &data).unwrap();
  let uploaded: Chat = serde_json::from_slice(&opened).unwrap();
  assert_eq!(uploaded.turns.len(), 6);
  assert!(
    uploaded.turns[0].task.steps.is_empty(),
    "the oldest turn lost its steps"
  );
  assert_eq!(
    a.phone.chat(&id).unwrap().turns[0].task.steps.len(),
    60,
    "the local chat keeps them"
  );
}

#[test]
fn trimming_takes_old_steps_then_old_turns() {
  let key = super::crypto::ChatKey::mint();
  let mut chat = chat_at("Trim", 1);
  for turn in 1..4u64 {
    add_turn(&mut chat, &format!("Turn {turn}"), turn);
  }
  for turn in &mut chat.turns {
    for index in 0..40 {
      turn.task.steps.push_back(step(index));
    }
  }
  let whole = fit(&key, chat.clone(), usize::MAX).unwrap();
  let open = |data: &str| -> Chat {
    serde_json::from_slice(&super::crypto::open_chat(&key, &chat.id, data).unwrap()).unwrap()
  };
  assert_eq!(open(&whole).turns[0].task.steps.len(), 40);
  let trimmed = open(&fit(&key, chat.clone(), whole.len() - 1).unwrap());
  assert!(trimmed.turns[0].task.steps.is_empty());
  assert_eq!(
    trimmed.turns[3].task.steps.len(),
    40,
    "the newest turn last"
  );
  assert!(fit(&key, chat, 10).is_none());
}

#[test]
fn the_merge_rule() {
  let local = chat_at("Local", 20);
  let mut remote = local.clone();
  assert_eq!(merge(None, &remote, false), Merge::Take);
  assert_eq!(merge(Some(&local), &remote, false), Merge::Same);
  remote.updated_at = 30;
  assert_eq!(merge(Some(&local), &remote, false), Merge::Take);
  assert_eq!(merge(Some(&local), &remote, true), Merge::Keep);
  remote.updated_at = 10;
  assert_eq!(merge(Some(&local), &remote, false), Merge::Keep);
}

#[test]
fn a_listing_reads_as_the_server_sends_it() {
  let page: Page = serde_json::from_str(
    r#"{"chats":[{"id":"a","rev":3,"data":"v1.x"},{"id":"b","rev":4,"data":null}],"cursor":"1.4","more":false,"reset":true}"#,
  )
  .unwrap();
  assert_eq!(
    page.chats[1],
    Item {
      id: "b".into(),
      rev: 4,
      data: None
    }
  );
  assert!(page.reset);
  let failure = crate::cloud_errors::classify(
    409,
    r#"{"code":"CHAT_CHANGED","rev":null,"data":null}"#,
    super::remote::CODES,
  );
  assert_eq!(failure.code, "CHAT_CHANGED");
  assert!(!failure.params.contains_key("rev"));
  let failure = crate::cloud_errors::classify(
    409,
    r#"{"code":"CHAT_CHANGED","rev":12,"data":"v1.k.n.s"}"#,
    super::remote::CODES,
  );
  assert_eq!(failure.params.get("rev").map(String::as_str), Some("12"));
  assert_eq!(
    failure.params.get("data").map(String::as_str),
    Some("v1.k.n.s")
  );
}

#[tokio::test]
async fn the_key_survives_a_restart_sealed_and_another_account_starts_over() {
  let dir = tempfile::tempdir().unwrap();
  let _guard = crate::app_dirs::set_test_data_dir(dir.path().to_path_buf());
  let files = || super::syncer::Files {
    dir: dir.path().join("agent_chat_sync"),
  };
  let server = cloud();
  let phone = Arc::new(Phone::default());
  phone.put(chat_at("Kept", 10));
  let deletes = Arc::new(Deletes::in_file(files().deletes()));
  let open = |account: &str| {
    Syncer::new(
      account,
      Box::new(Memory::new(server.clone())),
      phone.clone(),
      deletes.clone(),
      Some(files()),
    )
  };
  let mut first = open("acct");
  first.cycle().await.unwrap();
  let key = first.key.clone().unwrap();
  deletes.add("55555555-5555-4555-8555-555555555555");

  let again = open("acct");
  assert_eq!(again.device_id, first.device_id);
  assert_eq!(again.key.as_ref(), Some(&key));
  assert_eq!(again.state, first.state);
  assert!(Deletes::in_file(files().deletes()).contains("55555555-5555-4555-8555-555555555555"));
  let sealed = std::fs::read(files().dir.join("key.dat")).unwrap();
  let needle = key.key_b64();
  assert!(
    !sealed.windows(needle.len()).any(|w| w == needle.as_bytes()),
    "the key is sealed on disk"
  );

  let other = open("someone-else");
  assert_ne!(other.device_id, first.device_id);
  assert!(other.key.is_none());
  assert_eq!(other.state, Default::default());
  assert!(deletes.list().is_empty());
}

#[test]
fn a_turn_running_on_another_device_does_not_run_here() {
  let mut chat = chat_at("Remote", 1);
  chat.turns[0].task.status = TaskStatus::Running;
  assert!(super::runs_here(&chat));
  super::foreign().insert(chat.id.clone(), chat.turns[0].id.clone());
  assert!(!super::runs_here(&chat));
  add_turn(&mut chat, "Then this", 2);
  assert!(super::runs_here(&chat), "a turn started here");
  super::foreign().remove(&chat.id);
}
