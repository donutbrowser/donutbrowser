//! Who a request is from, and which part of the bucket it may reach.

use std::sync::Arc;

use serde_json::Value;

use crate::accounts::{DonutAccounts, TeamScope};
use crate::backend::Backend;
use crate::jsval::truthy;
use crate::jwt::{PublicKey, verify_rs256};
use crate::log;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
  /// The static `SYNC_TOKEN`: the whole bucket.
  SelfHosted,
  /// Donut's own sync server.
  Cloud,
  /// A Donut account on a server the customer runs, with the same namespace
  /// and team rules as `Cloud`.
  Account,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TeamRole {
  Owner,
  Admin,
  Member,
  /// May run profiles and sync what a session changed, never change a
  /// profile's settings, proxies or groups.
  Launcher,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UserContext {
  pub mode: Mode,
  /// The effective namespace: `""` for self-hosted, else the user's own
  /// `users/{sub}/` or, for a team member, the team owner's.
  pub prefix: String,
  /// 0 is unlimited.
  pub profile_limit: f64,
  pub sub: Option<String>,
  pub team_role: Option<TeamRole>,
  /// The profile groups this member may reach, when the owner limited them.
  /// `None` is every group. `__ungrouped__` stands for profiles in no group.
  pub group_ids: Option<Vec<String>>,
}

impl UserContext {
  pub fn self_hosted() -> Self {
    Self {
      mode: Mode::SelfHosted,
      prefix: String::new(),
      profile_limit: 0.0,
      sub: None,
      team_role: None,
      group_ids: None,
    }
  }
}

#[derive(Debug, PartialEq)]
pub enum AuthError {
  Unauthorized(&'static str),
  Unavailable(&'static str),
}

const CONTEXT: &str = "AuthGuard";

pub fn group_id_valid(id: &str) -> bool {
  (1..=128).contains(&id.len())
    && id
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A role the backend names, or `Member` for one this build does not know.
fn team_role_of(role: Option<&Value>) -> TeamRole {
  match role.and_then(Value::as_str) {
    Some("owner") => TeamRole::Owner,
    Some("admin") => TeamRole::Admin,
    Some("launcher") => TeamRole::Launcher,
    _ => TeamRole::Member,
  }
}

fn single_segment(s: &str) -> bool {
  !s.is_empty() && !s.contains('/')
}

/// A user's effective namespace: their own, or for a team member the shared
/// owner namespace with the team's role, group access and limit.
pub fn scoped_context(
  mode: Mode,
  sub: &str,
  profile_limit: f64,
  scope: Option<&TeamScope>,
) -> UserContext {
  let mut context = UserContext {
    mode,
    prefix: format!("users/{sub}/"),
    profile_limit,
    sub: Some(sub.to_string()),
    team_role: None,
    group_ids: None,
  };
  let Some(TeamScope(scope)) = scope else {
    return context;
  };
  let Some(owner) = scope
    .get("ownerId")
    .and_then(Value::as_str)
    .filter(|o| single_segment(o))
  else {
    return context;
  };
  context.prefix = format!("users/{owner}/");
  context.team_role = Some(team_role_of(scope.get("role")));
  // A malformed id cannot name a group, so it grants nothing; it never turns
  // a limited member into an unlimited one.
  if let Some(ids) = scope.get("groupIds").and_then(Value::as_array) {
    context.group_ids = Some(
      ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| group_id_valid(id))
        .map(str::to_string)
        .collect(),
    );
  }
  if let Some(limit) = scope.get("teamProfileLimit").and_then(Value::as_f64)
    && limit > 0.0
  {
    context.profile_limit = limit;
  }
  context
}

/// Only a JWT can be a Donut account token; anything else skips the API.
fn looks_like_jwt(token: &str) -> bool {
  let parts: Vec<&str> = token.split('.').collect();
  parts.len() == 3
    && parts.iter().all(|part| {
      !part.is_empty()
        && part
          .bytes()
          .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// Constant-time comparison; false on a length mismatch.
pub fn safe_equal(a: &str, b: &str) -> bool {
  let (a, b) = (a.as_bytes(), b.as_bytes());
  if a.len() != b.len() {
    return false;
  }
  a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct Guard {
  sync_token: Option<String>,
  /// The configured key, or why it does not parse. A key that does not parse
  /// still counts as configured: every JWT is then refused.
  jwt_key: Option<Result<PublicKey, String>>,
  backend: Option<Arc<Backend>>,
  accounts: Option<DonutAccounts>,
}

impl Guard {
  pub fn new(
    sync_token: Option<String>,
    jwt_public_key: Option<String>,
    backend: Option<Arc<Backend>>,
    accounts: Option<DonutAccounts>,
  ) -> Self {
    let jwt_key = jwt_public_key.map(|key| {
      log::log(CONTEXT, "JWT public key configured — cloud auth enabled");
      PublicKey::from_pem(&key.replace("\\n", "\n"))
    });
    if let Some(accounts) = &accounts {
      log::log(
        CONTEXT,
        &format!("Donut account sign-in enabled for {}", accounts.public_url),
      );
    }
    Self {
      sync_token,
      jwt_key,
      backend,
      accounts,
    }
  }

  pub async fn authenticate(&self, authorization: Option<&str>) -> Result<UserContext, AuthError> {
    let Some(token) = authorization.and_then(|h| h.strip_prefix("Bearer ")) else {
      return Err(AuthError::Unauthorized(
        "Missing or invalid authorization header",
      ));
    };

    if let Some(expected) = &self.sync_token
      && safe_equal(token, expected)
    {
      return Ok(UserContext::self_hosted());
    }

    if let Some(key) = &self.jwt_key {
      match self.cloud_context(token, key).await {
        Ok(context) => return Ok(context),
        Err(message) => log::warn(CONTEXT, &format!("JWT verification failed: {message}")),
      }
    }

    if let Some(accounts) = self.accounts.as_ref().filter(|_| looks_like_jwt(token)) {
      match accounts.resolve(token).await {
        Err(e) => {
          log::warn(CONTEXT, &format!("Donut account check failed: {}", e.0));
          return Err(AuthError::Unavailable(
            "The Donut account service could not be reached",
          ));
        }
        Ok(Some(account)) => {
          return Ok(scoped_context(
            Mode::Account,
            &account.sub,
            account.profile_limit,
            account.team.as_ref(),
          ));
        }
        Ok(None) => {}
      }
    }

    if self.sync_token.is_none() && self.jwt_key.is_none() && self.accounts.is_none() {
      return Err(AuthError::Unauthorized(
        "No auth method configured on server (set SYNC_TOKEN, SYNC_PUBLIC_URL or SYNC_JWT_PUBLIC_KEY)",
      ));
    }
    Err(AuthError::Unauthorized("Invalid sync token or JWT"))
  }

  async fn cloud_context(
    &self,
    token: &str,
    key: &Result<PublicKey, String>,
  ) -> Result<UserContext, String> {
    let key = key.as_ref().map_err(|e| e.clone())?;
    let claims = verify_rs256(token, key)?;

    if claims.get("scope").and_then(Value::as_str) != Some("sync") {
      return Err("Token scope is not accepted".to_string());
    }
    let sub = claims
      .get("sub")
      .and_then(Value::as_str)
      .unwrap_or("")
      .to_string();
    // The prefix claim is checked before it is trusted as an S3 key prefix:
    // an empty or over-broad one would authorize the whole bucket.
    let prefix_claim = claims.get("prefix");
    let own_prefix = match prefix_claim.filter(|prefix| truthy(prefix)) {
      Some(prefix) => prefix.as_str().map(str::to_string),
      None => Some(format!("users/{sub}/")),
    };
    let Some(own_prefix) = own_prefix.filter(|prefix| is_user_namespace(prefix)) else {
      return Err(format!(
        "Invalid prefix claim: {}",
        prefix_claim.map_or("undefined".to_string(), crate::jsval::to_js_string)
      ));
    };

    // A team member's requests are scoped to the shared team owner namespace.
    // The JWT carries no team data: the backend is the only authority. On any
    // resolver error this fails closed, to the user's own namespace.
    let own_limit = claims
      .get("profileLimit")
      .and_then(Value::as_f64)
      .unwrap_or(0.0);
    let mut scope = None;
    if let Some(backend) = self.backend.as_ref().filter(|_| !sub.is_empty()) {
      match backend.team_scope(&sub).await {
        Ok(found) => scope = found,
        Err(e) => log::warn(
          CONTEXT,
          &format!("Team scope resolution failed for {sub}; using own namespace: {e}"),
        ),
      }
    }
    let mut context = scoped_context(Mode::Cloud, &sub, own_limit, scope.as_ref());
    if scope.is_none() {
      context.prefix = own_prefix;
    }
    Ok(context)
  }
}

fn is_user_namespace(prefix: &str) -> bool {
  prefix
    .strip_prefix("users/")
    .and_then(|rest| rest.strip_suffix('/'))
    .is_some_and(single_segment)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn team_scope_moves_a_member_into_the_owner_namespace() {
    let scope = TeamScope(json!({
      "ownerId": "owner-1",
      "teamId": "team-1",
      "teamProfileLimit": 50,
      "role": "superuser",
      "groupIds": ["g1", "bad/id", 7]
    }));
    let context = scoped_context(Mode::Cloud, "u1", 5.0, Some(&scope));
    assert_eq!(context.prefix, "users/owner-1/");
    assert_eq!(context.profile_limit, 50.0);
    assert_eq!(context.team_role, Some(TeamRole::Member));
    assert_eq!(context.group_ids, Some(vec!["g1".to_string()]));

    let every_group = TeamScope(json!({ "ownerId": "o", "role": "launcher", "groupIds": null }));
    let context = scoped_context(Mode::Account, "u1", 5.0, Some(&every_group));
    assert_eq!(context.team_role, Some(TeamRole::Launcher));
    assert_eq!(context.group_ids, None);
    assert_eq!(context.profile_limit, 5.0);

    let malformed = TeamScope(json!({ "ownerId": "a/b" }));
    assert_eq!(
      scoped_context(Mode::Cloud, "u1", 5.0, Some(&malformed)).prefix,
      "users/u1/"
    );
  }

  #[test]
  fn jwt_shapes_and_namespaces() {
    assert!(looks_like_jwt("aaa.bbb.ccc"));
    assert!(looks_like_jwt("a-_.b.c"));
    assert!(!looks_like_jwt("a.b"));
    assert!(!looks_like_jwt("a..c"));
    assert!(!looks_like_jwt("not a token"));
    assert!(is_user_namespace("users/x/"));
    assert!(!is_user_namespace("users/"));
    assert!(!is_user_namespace("users//"));
    assert!(!is_user_namespace("users/a/b/"));
  }

  #[test]
  fn constant_time_compare() {
    assert!(safe_equal("abc", "abc"));
    assert!(!safe_equal("abc", "abx"));
    assert!(!safe_equal("abc", "abcd"));
  }
}
