//! Live previews of running profiles: one small picture of each window, taken
//! over the browser's own debugging connection. Part of browser automation
//! (Pro and up), and of the agent while it works in a profile.

use serde_json::{json, Value};

/// Widest preview, in CSS pixels; the page is scaled down to fit.
const PREVIEW_WIDTH: f64 = 360.0;
const PREVIEW_QUALITY: u8 = 55;

static PREVIEW_FAILURES: crate::log_streak::KeyedStreak =
  crate::log_streak::KeyedStreak::new(module_path!(), "Profile preview capture");

/// The part of the page in view and the scale that fits it into a preview.
fn preview_clip(metrics: &Value) -> Option<Value> {
  let viewport = metrics
    .get("cssVisualViewport")
    .or_else(|| metrics.get("visualViewport"))?;
  let width = viewport.get("clientWidth")?.as_f64()?;
  let height = viewport.get("clientHeight")?.as_f64()?;
  if width <= 0.0 || height <= 0.0 {
    return None;
  }
  Some(json!({
    "x": viewport.get("pageX").and_then(Value::as_f64).unwrap_or(0.0),
    "y": viewport.get("pageY").and_then(Value::as_f64).unwrap_or(0.0),
    "width": width,
    "height": height,
    "scale": (PREVIEW_WIDTH / width).min(1.0),
  }))
}

async fn capture(profile: &crate::profile::BrowserProfile) -> Result<String, String> {
  let target = crate::cdp_target::resolve(profile)
    .await
    .map_err(|e| e.to_string())?;
  let metrics = crate::cdp_target::run_command(&target, "Page.getLayoutMetrics", json!({}))
    .await
    .map_err(|e| e.to_string())?;
  let mut params = json!({
    "format": "jpeg",
    "quality": PREVIEW_QUALITY,
    "optimizeForSpeed": true,
  });
  if let Some(clip) = preview_clip(&metrics) {
    params["clip"] = clip;
  }
  let shot = crate::cdp_target::run_command(&target, "Page.captureScreenshot", params)
    .await
    .map_err(|e| e.to_string())?;
  let data = shot
    .get("data")
    .and_then(Value::as_str)
    .ok_or("no image data")?;
  Ok(format!("data:image/jpeg;base64,{data}"))
}

/// A JPEG data URL of what the profile's window shows now, or `None` when it
/// is not running on this device.
#[tauri::command]
pub async fn capture_profile_preview(profile_id: String) -> Result<Option<String>, String> {
  if !crate::agent_tasks::working_in(&profile_id)
    && !crate::cloud_auth::CLOUD_AUTH
      .can_use_browser_automation()
      .await
  {
    return Err(crate::backend_error("PREVIEWS_NOT_ENTITLED"));
  }
  let profile = crate::profile::ProfileManager::instance()
    .list_profiles()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
    .into_iter()
    .find(|profile| profile.id.to_string() == profile_id)
    .ok_or_else(|| crate::backend_error("PROFILE_NOT_FOUND"))?;
  if !profile
    .process_id
    .is_some_and(crate::proxy_storage::is_process_running)
  {
    return Ok(None);
  }
  match capture(&profile).await {
    Ok(image) => {
      PREVIEW_FAILURES.succeeded(&profile_id);
      Ok(Some(image))
    }
    Err(e) => {
      // The window may be mid-navigation or closing; the next poll tries again.
      PREVIEW_FAILURES.failed(&profile_id, e);
      Ok(None)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_clip_covers_the_view_and_scales_it_down() {
    let metrics = json!({
      "cssVisualViewport": {
        "pageX": 0.0, "pageY": 240.0, "clientWidth": 1440.0, "clientHeight": 900.0
      }
    });
    let clip = preview_clip(&metrics).unwrap();
    assert_eq!(clip["y"], 240.0);
    assert_eq!(clip["width"], 1440.0);
    assert_eq!(clip["scale"], 0.25);
  }

  #[test]
  fn a_small_view_is_never_scaled_up() {
    let metrics = json!({ "cssVisualViewport": { "clientWidth": 300.0, "clientHeight": 200.0 } });
    assert_eq!(preview_clip(&metrics).unwrap()["scale"], 1.0);
    assert!(preview_clip(&json!({})).is_none());
  }
}
