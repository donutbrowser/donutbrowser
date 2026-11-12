//! Tools for what surrounds a profile: its cloud sync, the statuses and
//! templates profiles are given, and its Playwright storage state.

use super::{McpError, McpServer, McpTool};
use crate::profile::ProfileManager;
use serde_json::{json, Value};

pub(super) fn tools() -> Vec<McpTool> {
  let tool = |name: &str, description: &str, input_schema: Value| McpTool {
    name: name.to_string(),
    description: description.to_string(),
    input_schema,
  };
  let status_fields = json!({
    "name": { "type": "string", "description": "1 to 40 characters, unique (any case)" },
    "color": { "type": "string", "description": "#rrggbb" }
  });
  let template_settings = json!({
    "type": "object",
    "description": "Keys: name_prefix, proxy_id or vpn_id, proxy_ids (spread over the profiles), group_id, tags, status_id, note, extension_group_id, dns_blocklist, dns_server, proxy_bypass_rules, start_urls, launch_hook, ephemeral, clear_on_close, wayfern_config (fingerprint OS and options; device fields are dropped). Left out is empty."
  });
  vec![
    tool(
      "set_profile_cloud_sync",
      "Turn cloud sync on or off for a profile. Regular sync is what run_profile_remote and the Cookie Bot need: a remote host gets the profile from the cloud. Encrypted sync needs the account's sync password and cannot run remotely. The browser must be stopped to turn sync on. The answer says whether the profile can now run remotely and in the Cookie Bot, and why not. The first upload starts at once and can take minutes; remote runs wait for it.",
      json!({
        "type": "object",
        "properties": {
          "profile_id": { "type": "string", "description": "The UUID of the profile" },
          "mode": {
            "type": "string",
            "enum": ["Regular", "Encrypted", "Disabled"],
            "description": "Regular: synced and runnable remotely. Encrypted: end-to-end encrypted, this computer only. Disabled: not synced."
          }
        },
        "required": ["profile_id", "mode"]
      }),
    ),
    tool(
      "create_profile_status",
      "Add a profile status (a named, colored label such as Active or Banned). Set it on profiles with update_profile's status_id.",
      json!({ "type": "object", "properties": status_fields, "required": ["name", "color"] }),
    ),
    tool(
      "update_profile_status",
      "Rename or recolor a profile status.",
      json!({
        "type": "object",
        "properties": {
          "status_id": { "type": "string", "description": "From list_profile_statuses" },
          "name": status_fields["name"],
          "color": status_fields["color"]
        },
        "required": ["status_id", "name", "color"]
      }),
    ),
    tool(
      "delete_profile_status",
      "Delete a profile status and take it off every profile that has it.",
      json!({
        "type": "object",
        "properties": { "status_id": { "type": "string", "description": "From list_profile_statuses" } },
        "required": ["status_id"]
      }),
    ),
    tool(
      "create_profile_template",
      "Save a profile template: settings that create_profiles_from_template gives new profiles. A template never holds a device.",
      json!({
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "1 to 60 characters, unique (any case)" },
          "settings": template_settings
        },
        "required": ["name"]
      }),
    ),
    tool(
      "update_profile_template",
      "Replace a profile template's name and settings. Profiles made from it keep theirs.",
      json!({
        "type": "object",
        "properties": {
          "template_id": { "type": "string", "description": "From list_profile_templates" },
          "name": { "type": "string", "description": "1 to 60 characters, unique (any case)" },
          "settings": template_settings
        },
        "required": ["template_id", "name"]
      }),
    ),
    tool(
      "delete_profile_template",
      "Delete a profile template. Profiles made from it keep their settings.",
      json!({
        "type": "object",
        "properties": { "template_id": { "type": "string", "description": "From list_profile_templates" } },
        "required": ["template_id"]
      }),
    ),
    tool(
      "export_profile_storage_state",
      "Read a profile's Playwright storageState: each origin's Local Storage, and its cookies and IndexedDB when asked for. Works while the browser runs, except with indexed_db. Name origins to keep the answer small.",
      json!({
        "type": "object",
        "properties": {
          "profile_id": { "type": "string", "description": "The UUID of the profile" },
          "origins": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Only these sites: an origin (https://example.com) or a host name (example.com, which also takes its subdomains). Left out is every site."
          },
          "include_cookies": { "type": "boolean", "description": "Also the cookies. False when left out" },
          "indexed_db": { "type": "boolean", "description": "Also each origin's IndexedDB. The browser must be stopped. False when left out" }
        },
        "required": ["profile_id"]
      }),
    ),
    tool(
      "import_profile_storage_state",
      "Write a Playwright storageState into a stopped profile: Local Storage items replace those of the same name, cookies are imported.",
      json!({
        "type": "object",
        "properties": {
          "profile_id": { "type": "string", "description": "The UUID of the profile" },
          "storage_state": {
            "type": "object",
            "description": "{ cookies: [...], origins: [{ origin, localStorage: [{ name, value }] }] }"
          }
        },
        "required": ["profile_id", "storage_state"]
      }),
    ),
  ]
}

/// A refusal from the app: the `{"code":…}` envelope as data when it is one.
fn failed(err: String) -> McpError {
  let data = serde_json::from_str::<Value>(&err)
    .ok()
    .filter(|value| value.get("code").is_some());
  McpError {
    code: -32000,
    message: err,
    data,
  }
}

fn invalid(message: String) -> McpError {
  McpError {
    code: -32602,
    message,
    data: None,
  }
}

fn optional_bool(arguments: &Value, key: &str) -> Result<bool, McpError> {
  match arguments.get(key) {
    None | Some(Value::Null) => Ok(false),
    Some(Value::Bool(value)) => Ok(*value),
    Some(_) => Err(invalid(format!("{key} must be true or false"))),
  }
}

fn template_settings(
  arguments: &Value,
) -> Result<crate::profile_templates::TemplateSettings, McpError> {
  match arguments.get("settings") {
    None | Some(Value::Null) => Ok(Default::default()),
    Some(settings) => {
      serde_json::from_value(settings.clone()).map_err(|e| invalid(format!("settings: {e}")))
    }
  }
}

/// Whether a storageState origin is one the caller named.
fn origin_matches(origin: &str, wanted: &[String]) -> bool {
  let host = url::Url::parse(origin)
    .ok()
    .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
  wanted.iter().any(|item| {
    let item = item.trim().trim_end_matches('/').to_ascii_lowercase();
    item == origin.trim_end_matches('/').to_ascii_lowercase()
      || host
        .as_deref()
        .is_some_and(|host| host == item || host.ends_with(&format!(".{item}")))
  })
}

/// Whether a cookie's domain belongs to a site the caller named.
fn cookie_matches(domain: &str, wanted: &[String]) -> bool {
  let domain = domain.trim_start_matches('.').to_ascii_lowercase();
  wanted.iter().any(|item| {
    let item = item.trim().trim_end_matches('/').to_ascii_lowercase();
    let host = url::Url::parse(&item)
      .ok()
      .and_then(|url| url.host_str().map(str::to_string))
      .unwrap_or(item);
    domain == host || domain.ends_with(&format!(".{host}")) || host.ends_with(&format!(".{domain}"))
  })
}

/// The storageState with only the named sites.
fn keep_sites(mut state: Value, wanted: &[String]) -> Value {
  if let Some(origins) = state.get_mut("origins").and_then(Value::as_array_mut) {
    origins.retain(|entry| {
      entry
        .get("origin")
        .and_then(Value::as_str)
        .is_some_and(|origin| origin_matches(origin, wanted))
    });
  }
  if let Some(cookies) = state.get_mut("cookies").and_then(Value::as_array_mut) {
    cookies.retain(|cookie| {
      cookie
        .get("domain")
        .and_then(Value::as_str)
        .is_some_and(|domain| cookie_matches(domain, wanted))
    });
  }
  state
}

/// The `code` of a refusal envelope, or the refusal itself.
fn refusal_code(err: String) -> Value {
  serde_json::from_str::<Value>(&err)
    .ok()
    .and_then(|value| value.get("code").cloned())
    .unwrap_or(Value::String(err))
}

impl McpServer {
  /// Runs one of [`tools`], or `None` for any other name.
  pub(super) async fn dispatch_profile_tool(
    &self,
    name: &str,
    arguments: &Value,
  ) -> Option<Result<Value, McpError>> {
    Some(match name {
      "set_profile_cloud_sync" => self.handle_set_profile_cloud_sync(arguments).await,
      "create_profile_status" => (|| {
        let status = crate::profile_statuses::create(
          Self::require_str(arguments, "name")?,
          Self::require_str(arguments, "color")?,
        )
        .map_err(failed)?;
        Self::json_content(&status)
      })(),
      "update_profile_status" => (|| {
        let status = crate::profile_statuses::update(
          Self::require_str(arguments, "status_id")?,
          Self::require_str(arguments, "name")?,
          Self::require_str(arguments, "color")?,
        )
        .map_err(failed)?;
        Self::json_content(&status)
      })(),
      "delete_profile_status" => (|| {
        let status_id = Self::require_str(arguments, "status_id")?;
        crate::profile_statuses::delete(status_id).map_err(failed)?;
        Self::json_content(&json!({ "deleted": status_id }))
      })(),
      "create_profile_template" => {
        async {
          let name = Self::require_str(arguments, "name")?;
          let template = crate::profile_templates::create(name, template_settings(arguments)?)
            .await
            .map_err(failed)?;
          Self::json_content(&template)
        }
        .await
      }
      "update_profile_template" => {
        async {
          let template_id = Self::require_str(arguments, "template_id")?;
          let name = Self::require_str(arguments, "name")?;
          let template =
            crate::profile_templates::update(template_id, name, template_settings(arguments)?)
              .await
              .map_err(failed)?;
          Self::json_content(&template)
        }
        .await
      }
      "delete_profile_template" => (|| {
        let template_id = Self::require_str(arguments, "template_id")?;
        crate::profile_templates::delete(template_id).map_err(failed)?;
        Self::json_content(&json!({ "deleted": template_id }))
      })(),
      "export_profile_storage_state" => self.handle_export_profile_storage_state(arguments).await,
      "import_profile_storage_state" => self.handle_import_profile_storage_state(arguments).await,
      _ => return None,
    })
  }

  async fn app(&self) -> Result<tauri::AppHandle, McpError> {
    self
      .inner
      .lock()
      .await
      .app_handle
      .clone()
      .ok_or_else(|| McpError {
        code: -32000,
        message: "MCP server not properly initialized".to_string(),
        data: None,
      })
  }

  async fn handle_set_profile_cloud_sync(&self, arguments: &Value) -> Result<Value, McpError> {
    let profile_id = Self::require_str(arguments, "profile_id")?;
    let mode = Self::require_str(arguments, "mode")?;
    if !["Regular", "Encrypted", "Disabled"].contains(&mode) {
      return Err(invalid(format!(
        "mode must be Regular, Encrypted or Disabled, not {mode:?}"
      )));
    }
    if mode != "Disabled" {
      Self::require_capability(
        "Cloud sync",
        !crate::sync::sync_needs_cloud_backup_plan().await,
      )
      .await?;
    }
    crate::sync::set_profile_sync_mode(self.app().await?, profile_id.to_string(), mode.to_string())
      .await
      .map_err(failed)?;

    let profile = ProfileManager::instance()
      .list_profiles()
      .map_err(|e| failed(e.to_string()))?
      .into_iter()
      .find(|profile| profile.id.to_string() == profile_id)
      .ok_or_else(|| failed(crate::backend_error("PROFILE_NOT_FOUND")))?;
    let remote = crate::api_server::remote_launch_precondition(&profile)
      .await
      .err();
    let cookie_bot = crate::cookie_bot::run_precondition(&profile)
      .err()
      .map(refusal_code);
    Self::json_content(&json!({
      "profile_id": profile_id,
      "mode": mode,
      "remote_launchable": remote.is_none(),
      "remote_blocked_reason": remote,
      "cookie_bot_ready": cookie_bot.is_none(),
      "cookie_bot_blocked_reason": cookie_bot,
    }))
  }

  async fn handle_export_profile_storage_state(
    &self,
    arguments: &Value,
  ) -> Result<Value, McpError> {
    let profile_id = Self::require_str(arguments, "profile_id")?;
    let wanted: Option<Vec<String>> = match arguments.get("origins") {
      None | Some(Value::Null) => None,
      Some(value) => Some(
        serde_json::from_value(value.clone())
          .map_err(|_| invalid("origins must be a list of strings".to_string()))?,
      ),
    };
    let text = crate::local_storage::export_storage_state_with(
      &self.app().await?,
      profile_id,
      optional_bool(arguments, "include_cookies")?,
      optional_bool(arguments, "indexed_db")?,
    )
    .await
    .map_err(failed)?;
    let state: Value = serde_json::from_str(&text).map_err(|e| failed(e.to_string()))?;
    let state = match wanted {
      Some(wanted) if !wanted.is_empty() => keep_sites(state, &wanted),
      _ => state,
    };
    Self::json_content(&state)
  }

  async fn handle_import_profile_storage_state(
    &self,
    arguments: &Value,
  ) -> Result<Value, McpError> {
    let profile_id = Self::require_str(arguments, "profile_id")?;
    let state = arguments
      .get("storage_state")
      .filter(|value| value.is_object())
      .ok_or_else(|| invalid("Missing storage_state".to_string()))?;
    let result = crate::local_storage::import_storage_state(
      &self.app().await?,
      profile_id,
      &state.to_string(),
    )
    .await
    .map_err(failed)?;
    Self::json_content(&result)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_site_filter_keeps_the_named_origins_and_their_cookies() {
    let state = json!({
      "cookies": [
        { "name": "a", "domain": ".shop.example.com" },
        { "name": "b", "domain": "example.com" },
        { "name": "c", "domain": "other.org" }
      ],
      "origins": [
        { "origin": "https://shop.example.com", "localStorage": [] },
        { "origin": "https://example.com", "localStorage": [] },
        { "origin": "https://other.org", "localStorage": [] }
      ]
    });
    let kept = keep_sites(state.clone(), &["https://shop.example.com/".to_string()]);
    let origins: Vec<&str> = kept["origins"]
      .as_array()
      .unwrap()
      .iter()
      .map(|o| o["origin"].as_str().unwrap())
      .collect();
    assert_eq!(origins, ["https://shop.example.com"]);
    let cookies: Vec<&str> = kept["cookies"]
      .as_array()
      .unwrap()
      .iter()
      .map(|c| c["name"].as_str().unwrap())
      .collect();
    assert_eq!(
      cookies,
      ["a", "b"],
      "a parent-domain cookie reaches the site"
    );

    let kept = keep_sites(state, &["example.com".to_string()]);
    assert_eq!(kept["origins"].as_array().unwrap().len(), 2);
    assert_eq!(kept["cookies"].as_array().unwrap().len(), 2);
  }

  #[test]
  fn a_refusal_envelope_becomes_data_an_agent_can_branch_on() {
    let error = failed(r#"{"code":"PROFILE_RUNNING"}"#.to_string());
    assert_eq!(error.data.unwrap()["code"], "PROFILE_RUNNING");
    assert!(failed("disk full".to_string()).data.is_none());
    assert_eq!(
      refusal_code(r#"{"code":"COOKIE_BOT_REQUIRES_CLOUD_SYNC"}"#.to_string()),
      "COOKIE_BOT_REQUIRES_CLOUD_SYNC"
    );
  }

  #[test]
  fn template_settings_are_read_whole_and_a_wrong_shape_is_named() {
    let settings =
      template_settings(&json!({ "settings": { "tags": ["a"], "dns_blocklist": "pro" } })).unwrap();
    assert_eq!(settings.tags, ["a"]);
    assert_eq!(settings.dns_blocklist.as_deref(), Some("pro"));
    assert!(template_settings(&json!({})).unwrap().tags.is_empty());
    let error = template_settings(&json!({ "settings": { "tags": "a" } })).unwrap_err();
    assert!(error.message.starts_with("settings:"), "{}", error.message);
  }
}
