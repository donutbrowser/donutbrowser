//! Updates for extensions that came from the Chrome Web Store.
//!
//! The store's update service, the one Chromium itself asks, says which of
//! them have a newer version. An update replaces the stored archive and keeps
//! the name; one that asks for permissions the installed version did not have
//! waits for the person's consent.

use serde::Serialize;
use std::collections::BTreeSet;

use crate::extension_fetch::{chromium_product_version, nacl_arch};
use crate::extension_manager::{Extension, EXTENSION_MANAGER};

/// At most this many extensions in one update-service request.
const CHECK_BATCH: usize = 25;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtensionUpdate {
  pub extension_id: String,
  pub version: String,
  pub available: String,
}

fn update_check_url(entries: &[(String, String)]) -> String {
  let mut url = format!(
    "https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion={}&nacl_arch={}",
    chromium_product_version(),
    nacl_arch()
  );
  for (store_id, version) in entries {
    url.push_str("&x=");
    url.push_str(&urlencoding::encode(&format!(
      "id={store_id}&v={version}&uc"
    )));
  }
  url
}

/// The value of `name="..."` inside one tag.
fn tag_attribute(tag: &str, name: &str) -> Option<String> {
  let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
  let end = tag[at..].find('"')? + at;
  Some(tag[at..end].to_string())
}

/// Store id to the version the update service offers, for each `app` it
/// answered with an `updatecheck` of `status="ok"`.
fn parse_update_response(xml: &str) -> Vec<(String, String)> {
  let mut found = Vec::new();
  for app in xml.split("<app ").skip(1) {
    let app = app.split("</app>").next().unwrap_or(app);
    let Some(id) = tag_attribute(&format!(" {app}"), "appid") else {
      continue;
    };
    let Some(check) = app.split("<updatecheck").nth(1) else {
      continue;
    };
    let check = check.split('>').next().unwrap_or(check);
    if tag_attribute(check, "status").as_deref() == Some("ok") {
      if let Some(version) = tag_attribute(check, "version") {
        found.push((id, version));
      }
    }
  }
  found
}

/// Whether dotted version `available` is newer than `installed`.
fn is_newer(available: &str, installed: &str) -> bool {
  let parts = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
  let (a, b) = (parts(available), parts(installed));
  for i in 0..a.len().max(b.len()) {
    let (x, y) = (
      a.get(i).copied().unwrap_or(0),
      b.get(i).copied().unwrap_or(0),
    );
    if x != y {
      return x > y;
    }
  }
  false
}

/// Everything a manifest lets the extension reach: API permissions, host
/// patterns and the sites its content scripts run on.
fn grants(manifest: &serde_json::Value) -> BTreeSet<String> {
  let strings = |key: &str| {
    manifest
      .get(key)
      .and_then(|v| v.as_array())
      .into_iter()
      .flatten()
      .filter_map(|v| v.as_str().map(str::to_string))
      .collect::<Vec<_>>()
  };
  let mut all: BTreeSet<String> = strings("permissions").into_iter().collect();
  all.extend(strings("host_permissions"));
  for script in manifest
    .get("content_scripts")
    .and_then(|v| v.as_array())
    .into_iter()
    .flatten()
  {
    for pattern in script
      .get("matches")
      .and_then(|v| v.as_array())
      .into_iter()
      .flatten()
    {
      if let Some(pattern) = pattern.as_str() {
        all.insert(pattern.to_string());
      }
    }
  }
  all
}

fn stored_manifest(ext: &Extension) -> Option<serde_json::Value> {
  let manager = EXTENSION_MANAGER.lock().unwrap_or_else(|e| e.into_inner());
  let data = std::fs::read(manager.get_file_dir_public(&ext.id).join(&ext.file_name)).ok()?;
  crate::extension_manager::read_manifest_from_archive(&data, &ext.file_type)
}

fn store_extensions() -> Result<Vec<Extension>, String> {
  let manager = EXTENSION_MANAGER.lock().unwrap_or_else(|e| e.into_inner());
  manager
    .list_extensions()
    .map(|all| {
      all
        .into_iter()
        .filter(|ext| ext.web_store_id.is_some() && !ext.is_linked())
        .collect()
    })
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))
}

/// Ask the Web Store which extensions have a newer version.
#[tauri::command]
pub async fn check_extension_updates() -> Result<Vec<ExtensionUpdate>, String> {
  let started = std::time::Instant::now();
  let extensions = store_extensions()?;
  let entries: Vec<(String, String, String)> = extensions
    .iter()
    .filter_map(|ext| {
      Some((
        ext.id.clone(),
        ext.web_store_id.clone()?,
        ext.version.clone().unwrap_or_else(|| "0".to_string()),
      ))
    })
    .collect();
  let client = crate::app_proxy::client_builder()
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|e| crate::backend_error_with_detail("EXTENSION_UPDATE_CHECK_FAILED", e))?;
  let mut updates = Vec::new();
  for batch in entries.chunks(CHECK_BATCH) {
    let query: Vec<(String, String)> = batch
      .iter()
      .map(|(_, store_id, version)| (store_id.clone(), version.clone()))
      .collect();
    let body = client
      .get(update_check_url(&query))
      .send()
      .await
      .and_then(|response| response.error_for_status())
      .map_err(|e| crate::backend_error_with_detail("EXTENSION_UPDATE_CHECK_FAILED", e))?
      .text()
      .await
      .map_err(|e| crate::backend_error_with_detail("EXTENSION_UPDATE_CHECK_FAILED", e))?;
    for (store_id, available) in parse_update_response(&body) {
      for (extension_id, id, version) in batch {
        if *id == store_id && is_newer(&available, version) {
          updates.push(ExtensionUpdate {
            extension_id: extension_id.clone(),
            version: version.clone(),
            available: available.clone(),
          });
        }
      }
    }
  }
  log::info!(
    "Extension updates checked extensions={} updates={} elapsed_ms={}",
    entries.len(),
    updates.len(),
    started.elapsed().as_millis()
  );
  Ok(updates)
}

/// Replace an extension with the Web Store's current version. A version that
/// asks for more than the installed one is refused with the new grants until
/// `accept_new_permissions` is set.
#[tauri::command]
pub async fn update_extension_from_store(
  extension_id: String,
  accept_new_permissions: bool,
) -> Result<Extension, String> {
  let ext = {
    let manager = EXTENSION_MANAGER.lock().unwrap_or_else(|e| e.into_inner());
    manager
      .get_extension(&extension_id)
      .map_err(|_| crate::backend_error("EXTENSION_NOT_FOUND"))?
  };
  let store_id = ext
    .web_store_id
    .clone()
    .ok_or_else(|| crate::backend_error("EXTENSION_NOT_FROM_STORE"))?;
  let fetched = crate::extension_fetch::fetch_extension(&store_id).await?;
  if !accept_new_permissions {
    let before = stored_manifest(&ext)
      .map(|m| grants(&m))
      .unwrap_or_default();
    let after = crate::extension_manager::read_manifest_from_archive(&fetched.file_data, "zip")
      .map(|m| grants(&m))
      .unwrap_or_default();
    let added: Vec<String> = after.difference(&before).cloned().collect();
    if !added.is_empty() {
      return Err(
        serde_json::json!({
          "code": "EXTENSION_UPDATE_NEEDS_CONSENT",
          "params": { "permissions": added.join(", ") },
        })
        .to_string(),
      );
    }
  }
  let updated = {
    let manager = EXTENSION_MANAGER.lock().unwrap_or_else(|e| e.into_inner());
    manager
      .update_extension(
        &extension_id,
        None,
        Some(fetched.file_name),
        Some(fetched.file_data),
      )
      .map_err(|e| crate::wrap_backend_error(e, "Failed to update extension"))?
  };
  log::info!(
    "Extension updated from the Web Store extension={extension_id} version={}",
    updated.version.as_deref().unwrap_or("-")
  );
  Ok(updated)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_update_service_answer_names_new_versions() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="nkbihfbeogaeaoehlefnkodbefgpgknn" status="ok">
    <updatecheck codebase="https://x/y.crx" version="13.5.0" status="ok"/>
  </app>
  <app appid="cjpalhdlnbpafiamejdnhcphjbkeiagm" status="ok">
    <updatecheck status="noupdate"/>
  </app>
</gupdate>"#;
    assert_eq!(
      parse_update_response(xml),
      vec![(
        "nkbihfbeogaeaoehlefnkodbefgpgknn".to_string(),
        "13.5.0".to_string()
      )]
    );
    assert!(parse_update_response("not xml").is_empty());
  }

  #[test]
  fn versions_compare_part_by_part() {
    assert!(is_newer("13.10.0", "13.9.2"));
    assert!(is_newer("2.0", "1.99.99"));
    assert!(!is_newer("1.0.0", "1.0"));
    assert!(!is_newer("1.2", "1.10"));
  }

  #[test]
  fn new_grants_are_the_ones_the_old_manifest_lacked() {
    let old = serde_json::json!({ "permissions": ["storage"], "host_permissions": ["https://a.example/*"] });
    let new = serde_json::json!({
      "permissions": ["storage", "tabs"],
      "host_permissions": ["https://a.example/*"],
      "content_scripts": [{ "matches": ["<all_urls>"] }],
    });
    let added: Vec<String> = grants(&new).difference(&grants(&old)).cloned().collect();
    assert_eq!(added, ["<all_urls>", "tabs"]);
  }

  #[test]
  fn the_check_url_lists_each_extension() {
    let url = update_check_url(&[("abc".to_string(), "1.0".to_string())]);
    assert!(url.starts_with("https://clients2.google.com/service/update2/crx?response=updatecheck"));
    assert!(url.contains("&x=id%3Dabc%26v%3D1.0%26uc"));
  }
}
