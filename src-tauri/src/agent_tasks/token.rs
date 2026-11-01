//! The short-lived agent token Wayfern spends credits with. Donut mints it
//! with the signed-in account and hands it over; Wayfern never sees the
//! account's refresh token.

use serde_json::Value;
use std::sync::Mutex;

/// Mint a new token this long before the old one expires.
pub const REFRESH_MARGIN_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentToken {
  pub token: String,
  /// Unix seconds.
  pub expires_at: u64,
}

static CURRENT: Mutex<Option<AgentToken>> = Mutex::new(None);

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

fn cached(now: u64) -> Option<AgentToken> {
  CURRENT
    .lock()
    .ok()?
    .clone()
    .filter(|token| !needs_refresh(now, token.expires_at))
}

/// A token good for at least the refresh margin, minted when needed.
/// Returns whether it is new, so the caller can hand it to running browsers.
pub async fn current() -> Result<(AgentToken, bool), String> {
  let now = crate::proxy_manager::now_secs();
  if let Some(token) = cached(now) {
    return Ok((token, false));
  }
  let token = super::cloud::mint_token().await?;
  if let Ok(mut slot) = CURRENT.lock() {
    *slot = Some(token.clone());
  }
  log::info!(
    "Agent token minted expires_in_s={}",
    token.expires_at.saturating_sub(now)
  );
  Ok((token, true))
}

/// Forget the token, on sign-out or when the entitlement goes.
pub fn clear() {
  if let Ok(mut slot) = CURRENT.lock() {
    *slot = None;
  }
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
}
