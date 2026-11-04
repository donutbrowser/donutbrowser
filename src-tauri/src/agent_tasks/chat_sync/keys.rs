//! The account's chat key on this device: register a public key every
//! session, make the key when the account has none, take a wrap when another
//! device made one for this device, and wrap the key for every device that
//! waits.

use super::crypto::{self, ChatKey, DeviceKey};
use super::syncer::Syncer;
use crate::cloud_errors::BackendFailure;

fn key_lost() -> BackendFailure {
  crate::cloud_errors::transport_failure("no key pair")
}

impl Syncer {
  /// A new key pair for this device, registered. A new public key drops any
  /// wrap the server held for the old one.
  pub(super) async fn register(&mut self) -> Result<(), BackendFailure> {
    let device = DeviceKey::generate().ok_or_else(key_lost)?;
    self
      .remote
      .register(&self.device_id, &device.public)
      .await?;
    self.public = Some(device.public.clone());
    self.private = Some(device);
    Ok(())
  }

  fn held_key_id(&self) -> Option<&str> {
    self.key.as_ref().map(|key| key.id.as_str())
  }

  /// Settle which key this device holds: keep it, make it, take it from a
  /// wrap, or wait for one (locked).
  pub(super) async fn keys(&mut self) -> Result<(), BackendFailure> {
    if self.public.is_none() {
      self.register().await?;
    }
    let mut server = self.remote.key(&self.device_id).await?;
    let moved_on = self
      .seen_key
      .as_ref()
      .is_some_and(|seen| *seen != server.key_id);
    let ours_gone = self
      .held_key_id()
      .is_some_and(|held| server.key_id.as_deref() != Some(held));
    if moved_on || ours_gone {
      if ours_gone {
        // Only an erase changes the key: what was synced under ours is gone.
        log::info!("Agent chat sync key dropped: the account's key changed");
        self.key = None;
        self.save_secrets();
        self.state.cursor = None;
        self.save_state();
      }
      // An erase removes every device.
      self.register().await?;
      server = self.remote.key(&self.device_id).await?;
    }
    self.seen_key = Some(server.key_id.clone());
    if self.key.is_some() {
      self.locked = false;
      return Ok(());
    }
    match (server.key_id, server.wrapped_key) {
      (None, _) => self.create_key().await,
      (Some(key_id), Some(wrapped)) => self.accept_wrap(&key_id, &wrapped).await,
      (Some(_), None) => {
        self.locked = true;
        Ok(())
      }
    }
  }

  /// Hold `key` from now on. The next listing is a full pass, so chats
  /// synced under an earlier key that the server no longer has go.
  fn hold(&mut self, key: ChatKey) {
    self.key = Some(key);
    self.save_secrets();
    self.state.cursor = None;
    self.save_state();
    self.locked = false;
  }

  async fn create_key(&mut self) -> Result<(), BackendFailure> {
    let key = ChatKey::mint();
    match self.remote.create_key(&key.id, &self.device_id).await {
      Ok(()) => {
        log::info!("Agent chat sync key created");
        self.seen_key = Some(Some(key.id.clone()));
        self.hold(key);
        Ok(())
      }
      // Another device made it first; its wrap comes next.
      Err(e) if e.code == "CHAT_KEY_EXISTS" => {
        self.locked = true;
        self.seen_key = None;
        Ok(())
      }
      Err(e) => Err(e),
    }
  }

  async fn accept_wrap(&mut self, key_id: &str, wrapped: &str) -> Result<(), BackendFailure> {
    let opened = self
      .private
      .take()
      .and_then(|device| device.unwrap(wrapped, key_id, &self.device_id));
    match opened {
      Some(key) => {
        log::info!("Agent chat sync key received");
        self.hold(key);
        Ok(())
      }
      None => {
        // Made for a key pair this session no longer has: ask again.
        log::warn!("Agent chat sync key wrap did not open");
        self.locked = true;
        self.register().await
      }
    }
  }

  /// Wrap the key for every device that waits for it, this one included
  /// after it registered a new public key.
  pub(super) async fn wrap_waiting(&mut self) -> Result<(), BackendFailure> {
    let Some(key) = self.key.clone() else {
      return Ok(());
    };
    let waiting = self.remote.waiting().await?;
    if waiting.key_id.as_deref() != Some(key.id.as_str()) {
      return Ok(());
    }
    let mut others = 0usize;
    for device in waiting.devices {
      let Some(wrapped) = crypto::wrap(&key, &device.device_id, &device.public_key) else {
        continue;
      };
      match self
        .remote
        .put_wrap(&device.device_id, &key.id, &device.public_key, &wrapped)
        .await
      {
        Ok(()) if device.device_id != self.device_id => others += 1,
        Ok(()) => {}
        // The device took a new key pair, or the key moved on.
        Err(e) if matches!(e.status, 400 | 409) => {}
        Err(e) => return Err(e),
      }
    }
    if others > 0 {
      log::info!("Agent chat sync key shared devices={others}");
    }
    Ok(())
  }

  /// Erase the account's key, every device and every synced chat. The chats
  /// on this device stay, and go up under a new key at the next round.
  pub async fn erase(&mut self) -> Result<(), BackendFailure> {
    self.remote.erase().await?;
    log::info!("Agent chat sync erased chats={}", self.state.chats.len());
    self.key = None;
    self.save_secrets();
    self.state = Default::default();
    self.save_state();
    self.public = None;
    self.private = None;
    self.seen_key = None;
    self.refused.clear();
    self.last_upload.clear();
    Ok(())
  }
}
