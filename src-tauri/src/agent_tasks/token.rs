//! The short-lived agent token Wayfern spends credits with. Donut mints it
//! with the signed-in account and hands it over; Wayfern never sees the
//! account's refresh token.

use serde_json::Value;
use std::future::Future;
use std::sync::Mutex;

/// Mint a new token this long before the old one expires.
pub const REFRESH_MARGIN_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToken {
  pub token: String,
  /// Unix seconds.
  pub expires_at: u64,
}

/// The token in use, and the turn of the one caller that mints a new one.
struct Slot {
  current: Mutex<Option<AgentToken>>,
  minting: tokio::sync::Mutex<()>,
}

static SLOT: Slot = Slot::new();

pub fn needs_refresh(now: u64, expires_at: u64) -> bool {
  now.saturating_add(REFRESH_MARGIN_SECS) >= expires_at
}

/// `expiresAt` as unix seconds, from seconds, milliseconds or an RFC 3339 date.
pub fn parse_expiry(value: &Value) -> Option<u64> {
  if let Some(number) = value.as_u64() {
    return Some(if number > 100_000_000_000 {
      number / 1000
    } else {
      number
    });
  }
  let text = value.as_str()?;
  if let Ok(number) = text.parse::<u64>() {
    return parse_expiry(&Value::from(number));
  }
  chrono::DateTime::parse_from_rfc3339(text)
    .ok()
    .and_then(|at| u64::try_from(at.timestamp()).ok())
}

pub fn decode(body: &Value) -> Option<AgentToken> {
  let token = body.get("token")?.as_str()?.trim();
  if token.is_empty() {
    return None;
  }
  Some(AgentToken {
    token: token.to_string(),
    expires_at: parse_expiry(body.get("expiresAt")?)?,
  })
}

impl Slot {
  const fn new() -> Self {
    Self {
      current: Mutex::new(None),
      minting: tokio::sync::Mutex::const_new(()),
    }
  }

  fn cached(&self, now: u64) -> Option<AgentToken> {
    self
      .current
      .lock()
      .ok()?
      .clone()
      .filter(|token| !needs_refresh(now, token.expires_at))
  }

  /// One caller at a time mints; a caller that waited for it takes that token.
  async fn current<F, Fut>(
    &self,
    now: impl Fn() -> u64,
    mint: F,
  ) -> Result<(AgentToken, bool), String>
  where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<AgentToken, String>>,
  {
    if let Some(token) = self.cached(now()) {
      return Ok((token, false));
    }
    let _turn = self.minting.lock().await;
    if let Some(token) = self.cached(now()) {
      return Ok((token, false));
    }
    let token = mint().await?;
    if let Ok(mut current) = self.current.lock() {
      *current = Some(token.clone());
    }
    log::info!(
      "Agent token minted expires_in_s={}",
      token.expires_at.saturating_sub(now())
    );
    Ok((token, true))
  }

  fn clear(&self) {
    if let Ok(mut current) = self.current.lock() {
      *current = None;
    }
  }
}

/// A token good for at least the refresh margin, minted when needed.
/// Returns whether this call minted it, so the caller hands it to every
/// running browser.
pub async fn current() -> Result<(AgentToken, bool), String> {
  SLOT
    .current(crate::proxy_manager::now_secs, super::cloud::mint_token)
    .await
}

/// Forget the token, on sign-out or when the entitlement goes.
pub fn clear() {
  SLOT.clear();
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn a_token_is_renewed_before_it_expires() {
    assert!(!needs_refresh(1_000, 1_000 + REFRESH_MARGIN_SECS + 1));
    assert!(needs_refresh(1_000, 1_000 + REFRESH_MARGIN_SECS));
    assert!(needs_refresh(2_000, 1_000));
  }

  #[test]
  fn the_expiry_reads_seconds_milliseconds_or_a_date() {
    assert_eq!(parse_expiry(&json!(1_800_000_000)), Some(1_800_000_000));
    assert_eq!(
      parse_expiry(&json!(1_800_000_000_000u64)),
      Some(1_800_000_000)
    );
    assert_eq!(parse_expiry(&json!("1800000000")), Some(1_800_000_000));
    assert_eq!(
      parse_expiry(&json!("2027-01-15T08:00:00Z")),
      Some(1_800_000_000)
    );
    assert_eq!(parse_expiry(&json!("soon")), None);
    assert_eq!(parse_expiry(&json!(null)), None);
  }

  #[test]
  fn a_token_reply_needs_both_fields() {
    let good = decode(&json!({"token": "jwt", "expiresAt": 1_800_000_000})).unwrap();
    assert_eq!(good.token, "jwt");
    assert!(decode(&json!({"token": "  ", "expiresAt": 1})).is_none());
    assert!(decode(&json!({"token": "jwt"})).is_none());
  }

  #[tokio::test]
  async fn many_callers_share_one_mint() {
    static MINTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static SHARED: Slot = Slot::new();
    let callers = (0..8).map(|_| {
      tokio::spawn(async {
        SHARED
          .current(
            || 1_000,
            || async {
              MINTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
              tokio::time::sleep(std::time::Duration::from_millis(20)).await;
              Ok(AgentToken {
                token: "jwt".into(),
                expires_at: 10_000,
              })
            },
          )
          .await
      })
    });
    let mut minted = 0;
    for caller in callers {
      let (token, new) = caller.await.unwrap().unwrap();
      assert_eq!(token.token, "jwt");
      minted += usize::from(new);
    }
    assert_eq!(MINTS.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(minted, 1, "only the caller that minted hands it out");
  }
}
