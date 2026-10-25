//! Donut accounts signing in to a server the customer runs.
//!
//! A paid account's app sends a token the Donut API issued for this server's
//! address. The API says whose it is, with the team scope, so this server
//! applies the same namespace and team rules as Donut's own sync server.
//! Answers are cached briefly: a seat or plan change applies within the cache
//! time.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const DEFAULT_DONUT_API_URL: &str = "https://api.donutbrowser.com";
const CACHE_TTL: Duration = Duration::from_secs(30);
const CACHE_MAX: usize = 10_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The scope of a token the Donut API issues for a customer's server.
const SERVER_SYNC_SCOPE: &str = "server-sync";

/// The canonical form of a sync server address, or `None` when the value
/// cannot be one. The desktop app and the Donut API write addresses the same
/// way, so a token bound to what a person typed matches what this server says
/// it is.
pub fn normalize_sync_server_url(raw: &str) -> Option<String> {
  if raw.encode_utf16().count() > 2048 {
    return None;
  }
  let url = url::Url::parse(raw.trim()).ok()?;
  if url.scheme() != "https" && url.scheme() != "http" {
    return None;
  }
  let host = url.host_str().filter(|h| !h.is_empty())?;
  if !url.username().is_empty() || url.password().is_some() {
    return None;
  }
  if url.query().is_some_and(|q| !q.is_empty()) || url.fragment().is_some_and(|f| !f.is_empty()) {
    return None;
  }
  let host = match url.port() {
    Some(port) => format!("{host}:{port}"),
    None => host.to_string(),
  };
  Some(format!(
    "{}://{host}{}",
    url.scheme(),
    url.path().trim_end_matches('/')
  ))
}

/// What a team scope answer says, kept as the original JSON so absent and
/// malformed fields read exactly as they did.
#[derive(Clone, Debug, PartialEq)]
pub struct TeamScope(pub Value);

/// Whose a token is, as the Donut API answers for this server.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountScope {
  pub sub: String,
  /// The plan's profile limit. 0 is unlimited.
  pub profile_limit: f64,
  pub team: Option<TeamScope>,
}

#[derive(Debug)]
pub struct Unreachable(pub String);

pub struct DonutAccounts {
  pub public_url: String,
  api_url: String,
  http: reqwest::Client,
  cache: Mutex<HashMap<String, (Option<AccountScope>, Instant)>>,
}

impl DonutAccounts {
  pub fn new(public_url: String, api_url: String) -> Self {
    Self {
      public_url,
      api_url,
      http: crate::net::client(REQUEST_TIMEOUT),
      cache: Mutex::new(HashMap::new()),
    }
  }

  pub fn from_config(config: &crate::config::Config) -> Option<Self> {
    let public_url = normalize_sync_server_url(config.sync_public_url.as_deref()?)?;
    let api_url = config
      .donut_api_url
      .clone()
      .unwrap_or_else(|| DEFAULT_DONUT_API_URL.to_string())
      .trim_end_matches('/')
      .to_string();
    Some(Self::new(public_url, api_url))
  }

  /// The account behind `token`, or `None` when the API refuses it. Fails
  /// when the API cannot be asked, so the caller fails closed.
  pub async fn resolve(&self, token: &str) -> Result<Option<AccountScope>, Unreachable> {
    // Only the API can verify the signature. Asking it about tokens that are
    // plainly not for this server would let anyone who reaches this server
    // spend its share of the API's request limit.
    if !self.claims_fit_this_server(token) {
      return Ok(None);
    }
    let key = hex::encode(Sha256::digest(token.as_bytes()));
    let now = Instant::now();
    if let Some((value, expires)) = self.cache.lock().unwrap().get(&key)
      && *expires > now
    {
      return Ok(value.clone());
    }

    let response = self
      .http
      .post(format!("{}/api/auth/server-sync/introspect", self.api_url))
      .timeout(REQUEST_TIMEOUT)
      .json(&serde_json::json!({ "token": token, "server": self.public_url }))
      .send()
      .await
      .map_err(|e| Unreachable(e.to_string()))?;
    if !response.status().is_success() {
      return Err(Unreachable(format!(
        "introspection returned {}",
        response.status().as_u16()
      )));
    }
    let body: Value = response
      .json()
      .await
      .map_err(|e| Unreachable(e.to_string()))?;
    let value = account_scope_of(&body);

    let mut cache = self.cache.lock().unwrap();
    if cache.len() > CACHE_MAX {
      cache.clear();
    }
    cache.insert(key, (value.clone(), now + CACHE_TTL));
    Ok(value)
  }

  /// The token's own, unverified claims name this server and are current.
  fn claims_fit_this_server(&self, token: &str) -> bool {
    let Some(payload) = token.split('.').nth(1).filter(|p| !p.is_empty()) else {
      return false;
    };
    // Node's decoder takes either base64 alphabet, with or without padding.
    let normalized: String = payload
      .trim_end_matches('=')
      .chars()
      .map(|c| match c {
        '+' => '-',
        '/' => '_',
        c => c,
      })
      .collect();
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
      .decode(normalized)
      .ok();
    let Some(claims) = decoded.and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
      return false;
    };
    claims.get("scope").and_then(Value::as_str) == Some(SERVER_SYNC_SCOPE)
      && claims.get("aud").and_then(Value::as_str) == Some(self.public_url.as_str())
      && claims
        .get("exp")
        .and_then(Value::as_f64)
        .is_some_and(|exp| exp * 1000.0 > crate::time::now_ms() as f64)
  }
}

fn account_scope_of(body: &Value) -> Option<AccountScope> {
  let answer = body.as_object()?;
  if answer.get("active") != Some(&Value::Bool(true)) {
    return None;
  }
  let sub = answer
    .get("sub")
    .and_then(Value::as_str)
    .filter(|s| !s.is_empty() && !s.contains('/'))?;
  // 0 means unlimited, so a missing limit refuses rather than reads as 0.
  let profile_limit = answer.get("profileLimit").and_then(Value::as_f64)?;
  let team = answer
    .get("team")
    .filter(|t| t.is_object() || t.is_array())
    .cloned()
    .map(TeamScope);
  Some(AccountScope {
    sub: sub.to_string(),
    profile_limit,
    team,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn addresses_normalize_like_the_api_and_the_app() {
    let n = |s: &str| normalize_sync_server_url(s);
    assert_eq!(
      n("https://Sync.Example.com/").as_deref(),
      Some("https://sync.example.com")
    );
    assert_eq!(
      n(" https://sync.example.com:443/a/// ").as_deref(),
      Some("https://sync.example.com/a")
    );
    assert_eq!(
      n("http://sync.example.com:8080").as_deref(),
      Some("http://sync.example.com:8080")
    );
    assert_eq!(
      n("https://sync.example.com/?").as_deref(),
      Some("https://sync.example.com")
    );
    assert_eq!(
      n("https://sync.example.com/#").as_deref(),
      Some("https://sync.example.com")
    );
    assert_eq!(n("https://sync.example.com/?a=1"), None);
    assert_eq!(n("https://user:pw@sync.example.com"), None);
    assert_eq!(n("ftp://sync.example.com"), None);
    assert_eq!(n("not a url"), None);
    assert_eq!(n(&format!("https://a.com/{}", "x".repeat(2100))), None);
  }

  #[test]
  fn an_answer_without_a_limit_refuses() {
    assert_eq!(
      account_scope_of(&serde_json::json!({ "active": true, "sub": "u" })),
      None
    );
    assert_eq!(
      account_scope_of(&serde_json::json!({ "active": true, "sub": "a/b", "profileLimit": 1 })),
      None
    );
    let scope = account_scope_of(&serde_json::json!({
      "active": true, "sub": "u", "profileLimit": 3, "team": null
    }))
    .unwrap();
    assert_eq!(scope.profile_limit, 3.0);
    assert_eq!(scope.team, None);
  }
}
