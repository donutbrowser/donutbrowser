//! Donut's backend, for the cloud deployment: who is on which team, and how
//! many profiles an account stores.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::accounts::TeamScope;

/// Membership revocation takes effect within this time, without a backend
/// round-trip on every request.
const TEAM_SCOPE_TTL: Duration = Duration::from_secs(30);
const CACHE_MAX: usize = 10_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Backend {
  url: String,
  key: String,
  http: reqwest::Client,
  team_scopes: Mutex<HashMap<String, (Option<TeamScope>, Instant)>>,
}

impl Backend {
  pub fn new(url: String, key: String) -> Self {
    Self {
      url,
      key,
      http: crate::net::client(REQUEST_TIMEOUT),
      team_scopes: Mutex::new(HashMap::new()),
    }
  }

  /// A cloud user's team scope. The backend is the only authority for team
  /// membership. Fails on a backend error, so the caller can fail closed.
  pub async fn team_scope(&self, sub: &str) -> Result<Option<TeamScope>, String> {
    let now = Instant::now();
    if let Some((value, expires)) = self.team_scopes.lock().unwrap().get(sub)
      && *expires > now
    {
      return Ok(value.clone());
    }
    let response = self
      .http
      .post(format!("{}/api/auth/internal/team-scope", self.url))
      .timeout(REQUEST_TIMEOUT)
      .header("x-internal-key", &self.key)
      .json(&serde_json::json!({ "userId": sub }))
      .send()
      .await
      .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
      return Err(format!(
        "team-scope resolver returned {}",
        response.status().as_u16()
      ));
    }
    // A user with no team is answered with an empty body, not `null`.
    let body = response.text().await.map_err(|e| e.to_string())?;
    let value = if body.is_empty() {
      None
    } else {
      let parsed: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
      (!parsed.is_null()).then_some(TeamScope(parsed))
    };
    let mut cache = self.team_scopes.lock().unwrap();
    if cache.len() > CACHE_MAX {
      cache.clear();
    }
    cache.insert(sub.to_string(), (value.clone(), now + TEAM_SCOPE_TTL));
    Ok(value)
  }

  pub async fn report_profile_usage(&self, user_id: &str, count: usize) -> Result<(), String> {
    let response = self
      .http
      .post(format!("{}/api/auth/internal/profile-usage", self.url))
      .timeout(REQUEST_TIMEOUT)
      .header("x-internal-key", &self.key)
      .json(&serde_json::json!({ "userId": user_id, "count": count }))
      .send()
      .await
      .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
      crate::log::warn(
        "SyncService",
        &format!(
          "Profile usage report failed: {} {}",
          response.status().as_u16(),
          response.status().canonical_reason().unwrap_or("")
        ),
      );
    }
    Ok(())
  }
}
