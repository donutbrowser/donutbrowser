//! Profile leases: one device at a time runs a synced profile.
//!
//! A browser rotates its session cookies while it runs. Two devices that run
//! the same profile, or one that starts from an older copy, make the site
//! revoke the session on both. A device takes the profile's lease before its
//! browser starts, renews it while the browser runs, and releases it once its
//! last upload is done. An expired lease is free.
//!
//! Leases live under this server's internal prefix, so listings never show
//! them and a sealed store seals them. Every operation on one profile's lease
//! runs under that profile's lock in this process (one replica), which makes
//! acquire a read and a write that nothing can come between.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{PROFILE_ROOT, SyncService, store_error};
use crate::auth::UserContext;
use crate::error::ApiError;
use crate::jsval::Body;
use crate::log;
use crate::store::StoreError;
use crate::time;

const CONTEXT: &str = "Leases";
/// Where leases are stored, before the profile's scoped root.
pub const LEASE_ROOT: &str = ".donut-sync-at-rest/locks/";
pub const MIN_TTL_SECS: u64 = 90;
pub const MAX_TTL_SECS: u64 = 300;
pub const DEFAULT_TTL_SECS: u64 = 120;
const MAX_DEVICE_ID: usize = 128;
const MAX_DEVICE_NAME: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
  pub token: String,
  pub device_id: String,
  #[serde(default)]
  pub device_name: Option<String>,
  /// The account that took it: only that account may take it over.
  #[serde(default)]
  pub sub: Option<String>,
  pub acquired_at_ms: i64,
  pub expires_at_ms: i64,
}

impl Lease {
  fn live(&self, now: i64) -> bool {
    self.expires_at_ms > now
  }

  fn holder_json(&self, ctx: &UserContext) -> Value {
    json!({
      "code": "PROFILE_LEASE_HELD",
      "holder": { "deviceId": self.device_id, "deviceName": self.device_name },
      "expiresAt": time::iso_from_ms(self.expires_at_ms),
      "sameAccount": self.sub == ctx.sub,
    })
  }

  fn granted_json(&self) -> Value {
    json!({
      "token": self.token,
      "expiresAt": time::iso_from_ms(self.expires_at_ms),
    })
  }
}

/// One lock per profile lease, dropped once nobody waits on it.
#[derive(Default)]
pub struct LeaseLocks(Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>);

impl LeaseLocks {
  fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = self.0.lock().unwrap();
    if let Some(found) = map.get(key).and_then(Weak::upgrade) {
      return found;
    }
    map.retain(|_, weak| weak.strong_count() > 0);
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    map.insert(key.to_string(), Arc::downgrade(&lock));
    lock
  }
}

fn invalid() -> ApiError {
  ApiError::bad_request_body(json!({ "code": "LEASE_INVALID" }))
}

fn conflict(body: Value) -> ApiError {
  ApiError::Http { status: 409, body }
}

/// A short, stable stand-in for a device id in the log.
fn short_device(id: &str) -> String {
  use sha2::Digest;
  hex::encode(&sha2::Sha256::digest(id.as_bytes())[..4])
}

fn profile_id_of(root: &str) -> &str {
  root
    .trim_end_matches('/')
    .rsplit('/')
    .next()
    .unwrap_or_default()
}

fn device_id(body: &Body) -> Result<String, ApiError> {
  body
    .optional_field("deviceId")
    .as_str()
    .filter(|id| {
      !id.is_empty()
        && id.len() <= MAX_DEVICE_ID
        && id
          .bytes()
          .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
    .map(str::to_string)
    .ok_or_else(invalid)
}

/// A readable name, without control characters, at most 64 characters.
fn device_name(body: &Body) -> Option<String> {
  let name: String = body
    .optional_field("deviceName")
    .as_str()?
    .chars()
    .filter(|c| !c.is_control())
    .take(MAX_DEVICE_NAME)
    .collect();
  let name = name.trim();
  (!name.is_empty()).then(|| name.to_string())
}

/// The requested lifetime, bounded; the default when none is given.
fn ttl_ms(body: &Body) -> Result<i64, ApiError> {
  let secs = match body.optional_field("ttlSeconds").as_number() {
    None if body.optional_field("ttlSeconds").is_nullish() => DEFAULT_TTL_SECS,
    Some(n) if n.is_finite() && n > 0.0 => (n as u64).clamp(MIN_TTL_SECS, MAX_TTL_SECS),
    _ => return Err(invalid()),
  };
  Ok(secs as i64 * 1000)
}

fn token(body: &Body) -> Result<String, ApiError> {
  body
    .optional_field("token")
    .as_str()
    .filter(|t| !t.is_empty() && t.len() <= 64)
    .map(str::to_string)
    .ok_or_else(invalid)
}

impl SyncService {
  fn lease_root<'a>(&self, body: &'a Body) -> Result<&'a str, ApiError> {
    body
      .optional_field("profileRoot")
      .as_str()
      .filter(|root| PROFILE_ROOT.is_match(root))
      .ok_or_else(invalid)
  }

  /// The lease's key, after the checks that let a caller open the profile:
  /// its namespace and, for a member limited to some groups, the group.
  async fn lease_key(&self, ctx: &UserContext, root: &str) -> Result<String, ApiError> {
    let live = self.scope_str(ctx, root);
    self.validate_key_access(ctx, Some(&live))?;
    self
      .assert_reachable(ctx, Some(&format!("{live}manifest.json")))
      .await?;
    Ok(format!("{LEASE_ROOT}{live}lease.json"))
  }

  async fn read_lease(&self, key: &str) -> Result<Option<Lease>, ApiError> {
    match self.store.get_object_text(key).await {
      // A record this server cannot read is treated as free: it only ever
      // blocks, it never holds data.
      Ok(text) => Ok(serde_json::from_str(&text).ok()),
      Err(StoreError::NotFound) => Ok(None),
      Err(e) => Err(store_error(e)),
    }
  }

  async fn write_lease(&self, key: &str, lease: &Lease) -> Result<(), ApiError> {
    let body = serde_json::to_vec(lease).map_err(|e| ApiError::Internal(e.to_string()))?;
    self
      .store
      .put_object(key, body, "application/json", &[])
      .await
      .map_err(store_error)
  }

  pub async fn acquire_lease(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    self.acquire_lease_at(body, ctx, time::now_ms()).await
  }

  pub(crate) async fn acquire_lease_at(
    &self,
    body: &Body,
    ctx: &UserContext,
    now: i64,
  ) -> Result<Value, ApiError> {
    let root = self.lease_root(body)?;
    let device = device_id(body)?;
    let ttl = ttl_ms(body)?;
    let force = matches!(
      body.optional_field("force"),
      crate::jsval::Field::Value(Value::Bool(true))
    );
    let key = self.lease_key(ctx, root).await?;
    let lock = self.lease_locks.lock_for(&key);
    let _held = lock.lock().await;

    let current = self.read_lease(&key).await?;
    let taken_over = match &current {
      Some(lease) if lease.live(now) && lease.device_id != device => {
        if !force || lease.sub != ctx.sub {
          log::log(
            CONTEXT,
            &format!(
              "Lease refused profile={} device={} holder={} force={force}",
              profile_id_of(root),
              short_device(&device),
              short_device(&lease.device_id)
            ),
          );
          return Err(conflict(lease.holder_json(ctx)));
        }
        Some(lease.device_id.clone())
      }
      _ => None,
    };
    let same_device = current
      .as_ref()
      .is_some_and(|lease| lease.live(now) && lease.device_id == device);
    let lease = Lease {
      token: uuid::Uuid::new_v4().simple().to_string(),
      device_id: device.clone(),
      device_name: device_name(body),
      sub: ctx.sub.clone(),
      acquired_at_ms: now,
      expires_at_ms: now + ttl,
    };
    self.write_lease(&key, &lease).await?;
    if let Some(previous) = taken_over {
      log::log(
        CONTEXT,
        &format!(
          "Lease taken over profile={} device={} previous={}",
          profile_id_of(root),
          short_device(&device),
          short_device(&previous)
        ),
      );
    } else if !same_device {
      log::log(
        CONTEXT,
        &format!(
          "Lease acquired profile={} device={}",
          profile_id_of(root),
          short_device(&device)
        ),
      );
    }
    Ok(lease.granted_json())
  }

  pub async fn renew_lease(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    self.renew_lease_at(body, ctx, time::now_ms()).await
  }

  /// Extends the caller's lease. A lease that ran out is renewed too while
  /// no other device has taken it.
  pub(crate) async fn renew_lease_at(
    &self,
    body: &Body,
    ctx: &UserContext,
    now: i64,
  ) -> Result<Value, ApiError> {
    let root = self.lease_root(body)?;
    let token = token(body)?;
    let ttl = ttl_ms(body)?;
    let key = self.lease_key(ctx, root).await?;
    let lock = self.lease_locks.lock_for(&key);
    let _held = lock.lock().await;
    match self.read_lease(&key).await? {
      Some(mut lease) if lease.token == token => {
        lease.expires_at_ms = now + ttl;
        self.write_lease(&key, &lease).await?;
        Ok(lease.granted_json())
      }
      Some(lease) if lease.live(now) => Err(conflict(json!({
        "code": "PROFILE_LEASE_LOST",
        "holder": lease.holder_json(ctx)["holder"],
        "expiresAt": time::iso_from_ms(lease.expires_at_ms),
      }))),
      _ => Err(conflict(json!({ "code": "PROFILE_LEASE_LOST" }))),
    }
  }

  /// Gives the lease up. Releasing a lease the caller no longer holds
  /// changes nothing.
  pub async fn release_lease(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let root = self.lease_root(body)?;
    let token = token(body)?;
    let key = self.lease_key(ctx, root).await?;
    let lock = self.lease_locks.lock_for(&key);
    let _held = lock.lock().await;
    let Some(lease) = self.read_lease(&key).await? else {
      return Ok(json!({ "released": false }));
    };
    if lease.token != token {
      return Ok(json!({ "released": false }));
    }
    match self.store.delete_object(&key).await {
      Ok(_) | Err(StoreError::NotFound) => {}
      Err(e) => return Err(store_error(e)),
    }
    log::log(
      CONTEXT,
      &format!(
        "Lease released profile={} device={} held_ms={}",
        profile_id_of(root),
        short_device(&lease.device_id),
        time::now_ms() - lease.acquired_at_ms
      ),
    );
    Ok(json!({ "released": true }))
  }

  pub async fn lease_status(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let root = self.lease_root(body)?;
    let key = self.lease_key(ctx, root).await?;
    let now = time::now_ms();
    Ok(match self.read_lease(&key).await? {
      Some(lease) if lease.live(now) => json!({
        "held": true,
        "holder": { "deviceId": lease.device_id, "deviceName": lease.device_name },
        "expiresAt": time::iso_from_ms(lease.expires_at_ms),
        "sameAccount": lease.sub == ctx.sub,
      }),
      _ => json!({ "held": false }),
    })
  }
}

#[cfg(test)]
#[path = "locks_tests.rs"]
mod tests;
