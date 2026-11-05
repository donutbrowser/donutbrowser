//! Live previews of running profiles: one small picture of each window, taken
//! over the browser's own debugging connection. Part of browser automation
//! (Pro and up), and of the agent while it works in a profile.

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

/// Width of a preview in pixels: sharp on a 2x screen at the largest tile.
const PREVIEW_WIDTH: u32 = 720;
const PREVIEW_QUALITY: u8 = 70;

static PREVIEW_FAILURES: crate::log_streak::KeyedStreak =
  crate::log_streak::KeyedStreak::new(module_path!(), "Profile preview capture");

#[derive(Debug, Serialize)]
pub struct ProfilePreview {
  /// JPEG data URL of what the window shows.
  image: String,
  /// Host of the page in view, empty for a blank or internal page.
  host: String,
}

/// Chromium draws a scaled `clip` into a full-size image on a visible
/// window, so the page is taken at full size and scaled down here.
fn shrink(jpeg: &[u8]) -> Result<Vec<u8>, String> {
  let picture = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
    .map_err(|e| e.to_string())?;
  let picture = if picture.width() > PREVIEW_WIDTH {
    let height = (u64::from(picture.height()) * u64::from(PREVIEW_WIDTH)
      / u64::from(picture.width()))
    .max(1) as u32;
    picture.thumbnail_exact(PREVIEW_WIDTH, height)
  } else {
    picture
  };
  let mut out = Vec::new();
  image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, PREVIEW_QUALITY)
    .encode_image(&picture.to_rgb8())
    .map_err(|e| e.to_string())?;
  Ok(out)
}

fn current_host(history: &Value) -> String {
  let index = history
    .get("currentIndex")
    .and_then(Value::as_u64)
    .unwrap_or(0) as usize;
  history
    .get("entries")
    .and_then(Value::as_array)
    .and_then(|entries| entries.get(index))
    .and_then(|entry| entry.get("url"))
    .and_then(Value::as_str)
    .and_then(|url| url::Url::parse(url).ok())
    .filter(|url| matches!(url.scheme(), "http" | "https"))
    .and_then(|url| {
      url
        .host_str()
        .map(|host| host.trim_start_matches("www.").to_string())
    })
    .unwrap_or_default()
}

async fn capture(profile: &crate::profile::BrowserProfile) -> Result<ProfilePreview, String> {
  let target = crate::cdp_target::resolve(profile)
    .await
    .map_err(|e| e.to_string())?;
  let shot = crate::cdp_target::run_command(
    &target,
    "Page.captureScreenshot",
    json!({ "format": "jpeg", "quality": 80, "optimizeForSpeed": true }),
  )
  .await
  .map_err(|e| e.to_string())?;
  let history = crate::cdp_target::run_command(&target, "Page.getNavigationHistory", json!({}))
    .await
    .unwrap_or(Value::Null);
  let data = shot
    .get("data")
    .and_then(Value::as_str)
    .ok_or("no image data")?;
  let jpeg = base64::engine::general_purpose::STANDARD
    .decode(data)
    .map_err(|e| e.to_string())?;
  let small = tokio::task::spawn_blocking(move || shrink(&jpeg))
    .await
    .map_err(|e| e.to_string())??;
  Ok(ProfilePreview {
    image: format!(
      "data:image/jpeg;base64,{}",
      base64::engine::general_purpose::STANDARD.encode(small)
    ),
    host: current_host(&history),
  })
}

/// What the profile's window shows now, or `None` when it is not running on
/// this device.
#[tauri::command]
pub async fn capture_profile_preview(profile_id: String) -> Result<Option<ProfilePreview>, String> {
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

  fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
      .encode_image(&image::RgbImage::new(width, height))
      .unwrap();
    out
  }

  #[test]
  fn a_large_window_is_scaled_to_the_preview_width() {
    let small = image::load_from_memory(&shrink(&jpeg(2880, 1800)).unwrap()).unwrap();
    assert_eq!((small.width(), small.height()), (720, 450));
  }

  #[test]
  fn a_small_window_is_never_scaled_up() {
    let same = image::load_from_memory(&shrink(&jpeg(300, 200)).unwrap()).unwrap();
    assert_eq!((same.width(), same.height()), (300, 200));
  }

  #[test]
  fn the_host_is_that_of_the_page_in_view() {
    let history = json!({
      "currentIndex": 1,
      "entries": [{ "url": "https://example.com/" }, { "url": "https://www.shop.test/cart" }]
    });
    assert_eq!(current_host(&history), "shop.test");
    let blank = json!({ "currentIndex": 0, "entries": [{ "url": "chrome://newtab/" }] });
    assert_eq!(current_host(&blank), "");
    assert_eq!(current_host(&Value::Null), "");
  }
}
