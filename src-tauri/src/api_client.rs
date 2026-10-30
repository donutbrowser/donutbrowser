use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::log_streak::Streak;

static WAYFERN_VERSION_FETCH: Streak = Streak::new(module_path!(), "Wayfern version fetch");
static LAST_WAYFERN_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn wayfern_version_changed(version: &str) -> bool {
  let mut last = LAST_WAYFERN_VERSION
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner);
  if last.as_deref() == Some(version) {
    return false;
  }
  *last = Some(version.to_string());
  true
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionComponent {
  pub major: u32,
  pub minor: u32,
  pub patch: u32,
  pub build: u32,
  /// The rebuild of one Chromium version: "155.0.8059.79-2" is revision 2, a plain version is 1.
  pub revision: u32,
}

impl VersionComponent {
  pub fn parse(version: &str) -> Self {
    let version = version.trim();
    let version = if version.starts_with('v') || version.starts_with('V') {
      &version[1..]
    } else {
      version
    };

    let (version, revision) = Self::split_revision(version);
    let numeric_part = Self::numeric_prefix(version);

    let parts: Vec<u32> = numeric_part
      .split('.')
      .filter_map(|part| part.parse().ok())
      .collect();

    VersionComponent {
      major: parts.first().copied().unwrap_or(0),
      minor: parts.get(1).copied().unwrap_or(0),
      patch: parts.get(2).copied().unwrap_or(0),
      build: parts.get(3).copied().unwrap_or(0),
      revision,
    }
  }

  /// Splits a trailing "-<digits>" rebuild revision off a version; a version without one is
  /// revision 1.
  fn split_revision(version: &str) -> (&str, u32) {
    if let Some((base, tail)) = version.rsplit_once('-') {
      if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(revision) = tail.parse() {
          return (base, revision);
        }
      }
    }
    (version, 1)
  }

  fn numeric_prefix(version: &str) -> String {
    let version = version.to_lowercase();
    for (i, ch) in version.char_indices() {
      if ch.is_alphabetic() && i > 0 {
        return version[..i].to_string();
      }
    }
    version
  }
}

impl PartialOrd for VersionComponent {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    Some(self.cmp(other))
  }
}

impl Ord for VersionComponent {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    (
      self.major,
      self.minor,
      self.patch,
      self.build,
      self.revision,
    )
      .cmp(&(
        other.major,
        other.minor,
        other.patch,
        other.build,
        other.revision,
      ))
  }
}

pub fn sort_versions(versions: &mut [String]) {
  versions.sort_by(|a, b| {
    let version_a = VersionComponent::parse(a);
    let version_b = VersionComponent::parse(b);
    version_b.cmp(&version_a)
  });
}

pub fn compare_versions(version1: &str, version2: &str) -> std::cmp::Ordering {
  let version_a = VersionComponent::parse(version1);
  let version_b = VersionComponent::parse(version2);
  version_a.cmp(&version_b)
}

pub fn is_version_newer(version1: &str, version2: &str) -> bool {
  let version_a = VersionComponent::parse(version1);
  let version_b = VersionComponent::parse(version2);
  version_a > version_b
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowserRelease {
  pub version: String,
  pub date: String,
}

/// Wayfern version info from https://donutbrowser.com/wayfern.json
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WayfernVersionInfo {
  pub version: String,
  pub downloads: std::collections::HashMap<String, Option<String>>,
  /// The rebuild of `version`, when it is not the first. It is folded into `version` as
  /// "<version>-<revision>" when the manifest is read, so a rebuild of the same Chromium version
  /// gets its own install directory and counts as an update.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub revision: Option<u32>,
}

impl WayfernVersionInfo {
  /// Folds `revision` into `version`. Revision 1, or none, keeps the plain Chromium version, so a
  /// manifest without the field reads as before. Folding twice changes nothing.
  fn with_revision_folded(mut self) -> Self {
    if let Some(revision) = self.revision.take() {
      if revision >= 2 {
        self.version = format!("{}-{revision}", self.version);
      }
    }
    self
  }
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedVersionData {
  releases: Vec<BrowserRelease>,
  timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedWayfernData {
  version_info: WayfernVersionInfo,
  timestamp: u64,
}

pub struct ApiClient {
  client: crate::app_proxy::SharedClient,
}

impl ApiClient {
  pub fn new() -> Self {
    let client = crate::app_proxy::SharedClient::new(|builder| {
      builder.timeout(std::time::Duration::from_secs(30))
    });

    Self { client }
  }

  pub fn instance() -> &'static ApiClient {
    &API_CLIENT
  }

  fn get_cache_dir() -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let cache_dir = crate::app_dirs::cache_dir().join("version_cache");
    fs::create_dir_all(&cache_dir)?;
    Ok(cache_dir)
  }

  fn get_current_timestamp() -> u64 {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default()
      .as_secs()
  }

  fn is_cache_valid(timestamp: u64) -> bool {
    let current_time = Self::get_current_timestamp();
    let cache_duration = 10 * 60;
    current_time - timestamp < cache_duration
  }

  pub fn load_cached_versions(&self, browser: &str) -> Option<Vec<BrowserRelease>> {
    let cache_dir = Self::get_cache_dir().ok()?;
    let cache_file = cache_dir.join(format!("{browser}_versions.json"));

    if !cache_file.exists() {
      return None;
    }

    let content = fs::read_to_string(&cache_file).ok()?;
    if let Ok(cached) = serde_json::from_str::<CachedVersionData>(&content) {
      log::debug!("Browser versions from cache browser={browser}");
      return Some(cached.releases);
    }

    if let Ok(legacy_versions) = serde_json::from_str::<Vec<String>>(&content) {
      log::debug!("Browser versions from legacy cache browser={browser}");
      let releases: Vec<BrowserRelease> = legacy_versions
        .into_iter()
        .map(|version| BrowserRelease {
          version,
          date: "".to_string(),
        })
        .collect();
      return Some(releases);
    }

    None
  }

  pub fn is_cache_expired(&self, browser: &str) -> bool {
    let cache_dir = match Self::get_cache_dir() {
      Ok(dir) => dir,
      Err(_) => return true,
    };
    let cache_file = cache_dir.join(format!("{browser}_versions.json"));

    if !cache_file.exists() {
      return true;
    }

    let content = match fs::read_to_string(&cache_file) {
      Ok(content) => content,
      Err(_) => return true,
    };

    let cached_data: CachedVersionData = match serde_json::from_str(&content) {
      Ok(data) => data,
      Err(_) => return true,
    };

    !Self::is_cache_valid(cached_data.timestamp)
  }

  pub fn save_cached_versions(
    &self,
    browser: &str,
    releases: &[BrowserRelease],
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cache_dir = Self::get_cache_dir()?;
    let cache_file = cache_dir.join(format!("{browser}_versions.json"));

    let cached_data = CachedVersionData {
      releases: releases.to_vec(),
      timestamp: Self::get_current_timestamp(),
    };

    let content = serde_json::to_string_pretty(&cached_data)?;
    fs::write(&cache_file, content)?;
    log::debug!(
      "Browser versions cached browser={browser} count={}",
      releases.len()
    );
    Ok(())
  }

  fn load_cached_wayfern_version(&self) -> Option<WayfernVersionInfo> {
    let cache_dir = Self::get_cache_dir().ok()?;
    let cache_file = cache_dir.join("wayfern_version.json");

    if !cache_file.exists() {
      return None;
    }

    let content = fs::read_to_string(&cache_file).ok()?;
    let cached_data: CachedWayfernData = serde_json::from_str(&content).ok()?;

    Some(cached_data.version_info)
  }

  fn save_cached_wayfern_version(
    &self,
    version_info: &WayfernVersionInfo,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cache_dir = Self::get_cache_dir()?;
    let cache_file = cache_dir.join("wayfern_version.json");

    let cached_data = CachedWayfernData {
      version_info: version_info.clone(),
      timestamp: Self::get_current_timestamp(),
    };

    let content = serde_json::to_string_pretty(&cached_data)?;
    fs::write(&cache_file, content)?;
    log::debug!("Wayfern version cached version={}", version_info.version);
    Ok(())
  }

  /// Fetch Wayfern version info from https://donutbrowser.com/wayfern.json
  pub async fn fetch_wayfern_version_with_caching(
    &self,
    no_caching: bool,
  ) -> Result<WayfernVersionInfo, Box<dyn std::error::Error + Send + Sync>> {
    if !no_caching {
      if let Some(cached_version) = self.load_cached_wayfern_version() {
        log::debug!(
          "Wayfern version from cache version={}",
          cached_version.version
        );
        return Ok(cached_version);
      }
    }

    let url = "https://donutbrowser.com/wayfern.json";

    let mut last_err = None;
    let mut proxy_err = None;
    let mut version_info: Option<WayfernVersionInfo> = None;

    for attempt in 1..=3 {
      match self
        .client
        .get()
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36")
        .send()
        .await
      {
        Ok(response) => {
          if !response.status().is_success() {
            last_err = Some(format!("HTTP {}", response.status().as_u16()));
          } else {
            match response.json::<WayfernVersionInfo>().await {
              Ok(info) => {
                version_info = Some(info);
                break;
              }
              Err(e) => last_err = Some(format!("Failed to parse response: {e}")),
            }
          }
        }
        Err(e) => {
          log::debug!("Wayfern version fetch attempt failed attempt={attempt} err=\"{e}\"");
          proxy_err = crate::system_proxy::explain(&e);
          last_err = Some(e.to_string());
        }
      }

      if attempt < 3 {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
      }
    }

    let version_info = match version_info {
      Some(info) => {
        WAYFERN_VERSION_FETCH.succeeded();
        info.with_revision_folded()
      }
      None => {
        let err = proxy_err.unwrap_or_else(|| {
          format!(
            "Failed to fetch Wayfern version after 3 attempts: {}",
            last_err.unwrap_or_default()
          )
        });
        WAYFERN_VERSION_FETCH.failed(&err);
        return Err(err.into());
      }
    };
    if wayfern_version_changed(&version_info.version) {
      log::info!("Wayfern version fetched version={}", version_info.version);
    } else {
      log::debug!("Wayfern version fetched version={}", version_info.version);
    }

    if !no_caching {
      if let Err(e) = self.save_cached_wayfern_version(&version_info) {
        log::warn!("Wayfern version not cached err=\"{e}\"");
      }
    }

    Ok(version_info)
  }

  /// Get the download URL for Wayfern based on current platform
  pub fn get_wayfern_download_url(&self, version_info: &WayfernVersionInfo) -> Option<String> {
    let (os, arch) = Self::get_platform_info();
    let slot = wayfern_slot_for(&version_info.downloads, &os, &arch)?;
    version_info.downloads.get(&slot).cloned().flatten()
  }

  /// The downloads key that this host takes from the last fetched Wayfern manifest, or None when
  /// no manifest is cached or nothing in it runs here.
  pub fn cached_wayfern_slot(&self) -> Option<String> {
    let (os, arch) = Self::get_platform_info();
    let version_info = self.load_cached_wayfern_version()?;
    wayfern_slot_for(&version_info.downloads, &os, &arch)
  }

  /// Check if Wayfern has a compatible download for current platform
  pub fn has_wayfern_compatible_download(&self, version_info: &WayfernVersionInfo) -> bool {
    self.get_wayfern_download_url(version_info).is_some()
  }

  fn get_platform_info() -> (String, String) {
    crate::browser_version_manager::host_platform()
  }

  pub fn clear_all_cache(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cache_dir = Self::get_cache_dir()?;

    if cache_dir.exists() {
      for entry in fs::read_dir(&cache_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
          fs::remove_file(&path)?;
          log::debug!("Version cache file removed path={path:?}");
        }
      }
      log::info!("Version cache cleared");
    }

    Ok(())
  }
}

static API_CLIENT: std::sync::LazyLock<ApiClient> = std::sync::LazyLock::new(ApiClient::new);

/// The downloads key of the Wayfern build for one platform: its own key, or windows-x64 on Windows
/// on Arm, which runs the x64 build through emulation, while no windows-arm64 build is published.
/// Other platforms have no fallback: an x64 build cannot run on Linux on Arm, and an absent entry
/// means "not available".
pub(crate) fn wayfern_slot_for(
  downloads: &std::collections::HashMap<String, Option<String>>,
  os: &str,
  arch: &str,
) -> Option<String> {
  let published = |key: &str| downloads.get(key).is_some_and(Option::is_some);
  let own = format!("{os}-{arch}");
  if published(&own) {
    return Some(own);
  }
  if os == "windows" && arch == "arm64" && published("windows-x64") {
    return Some("windows-x64".to_string());
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_rebuild_revision_orders_after_the_same_chromium_version() {
    let rebuilt = VersionComponent::parse("155.0.8059.79-2");
    assert_eq!((rebuilt.build, rebuilt.revision), (79, 2));
    assert_eq!(VersionComponent::parse("155.0.8059.79").revision, 1);
    assert_eq!(VersionComponent::parse("155").revision, 1);
    assert!(is_version_newer("155.0.8059.79-2", "155.0.8059.79"));
    assert!(!is_version_newer("155.0.8059.79", "155.0.8059.79-2"));
    assert!(is_version_newer("155.0.8059.79-3", "155.0.8059.79-2"));
    assert!(is_version_newer("156.0.7000.1", "155.0.8059.79-3"));
    assert_eq!(
      compare_versions("155.0.8059.79-1", "155.0.8059.79"),
      std::cmp::Ordering::Equal
    );
    // The version gates of Wayfern features still see the Chromium version.
    assert_ne!(
      compare_versions("155.0.8059.79-2", "155"),
      std::cmp::Ordering::Less
    );
  }

  #[test]
  fn the_manifest_revision_folds_into_the_version_once() {
    let read = |json: &str| -> WayfernVersionInfo { serde_json::from_str(json).unwrap() };
    let plain = read(r#"{"version":"155.0.8059.79","downloads":{}}"#).with_revision_folded();
    assert_eq!(plain.version, "155.0.8059.79");
    let first =
      read(r#"{"version":"155.0.8059.79","downloads":{},"revision":1}"#).with_revision_folded();
    assert_eq!(first.version, "155.0.8059.79");
    let rebuilt =
      read(r#"{"version":"155.0.8059.79","downloads":{},"revision":2}"#).with_revision_folded();
    assert_eq!(rebuilt.version, "155.0.8059.79-2");
    assert_eq!(rebuilt.revision, None);
    let cached: WayfernVersionInfo =
      serde_json::from_str(&serde_json::to_string(&rebuilt).unwrap()).unwrap();
    assert_eq!(cached.with_revision_folded().version, "155.0.8059.79-2");
  }

  #[test]
  fn wayfern_slot_for_takes_the_host_build_and_falls_back_only_on_windows_arm() {
    let downloads = |pairs: &[(&str, Option<&str>)]| {
      pairs
        .iter()
        .map(|(key, url)| (key.to_string(), url.map(str::to_string)))
        .collect::<std::collections::HashMap<_, _>>()
    };
    let both = downloads(&[
      ("windows-x64", Some("https://d/x64.zip")),
      ("windows-arm64", Some("https://d/arm64.zip")),
    ]);
    assert_eq!(
      wayfern_slot_for(&both, "windows", "arm64").as_deref(),
      Some("windows-arm64")
    );
    let x64_only = downloads(&[
      ("windows-x64", Some("https://d/x64.zip")),
      ("windows-arm64", None),
      ("linux-x64", Some("https://d/linux-x64.tar.xz")),
      ("linux-arm64", None),
    ]);
    assert_eq!(
      wayfern_slot_for(&x64_only, "windows", "arm64").as_deref(),
      Some("windows-x64")
    );
    assert_eq!(
      wayfern_slot_for(&x64_only, "windows", "x64").as_deref(),
      Some("windows-x64")
    );
    assert_eq!(wayfern_slot_for(&x64_only, "linux", "arm64"), None);
    let with_linux_arm = downloads(&[
      ("linux-x64", Some("https://d/linux-x64.tar.xz")),
      ("linux-arm64", Some("https://d/linux-arm64.tar.xz")),
    ]);
    assert_eq!(
      wayfern_slot_for(&with_linux_arm, "linux", "arm64").as_deref(),
      Some("linux-arm64")
    );
    assert_eq!(
      wayfern_slot_for(&with_linux_arm, "linux", "x64").as_deref(),
      Some("linux-x64")
    );
    let missing = downloads(&[("windows-x64", Some("https://d/x64.zip"))]);
    assert_eq!(
      wayfern_slot_for(&missing, "windows", "arm64").as_deref(),
      Some("windows-x64")
    );
    assert_eq!(wayfern_slot_for(&downloads(&[]), "windows", "arm64"), None);
  }

  #[test]
  fn test_version_parsing() {
    let v1 = VersionComponent::parse("1.2.3");
    assert_eq!(v1.major, 1);
    assert_eq!(v1.minor, 2);
    assert_eq!(v1.patch, 3);

    let v2 = VersionComponent::parse("138.0.7204.50");
    assert_eq!(v2.major, 138);
    assert_eq!(v2.minor, 0);
    assert_eq!(v2.patch, 7204);
    assert_eq!(v2.build, 50);

    let v3 = VersionComponent::parse("137.0b5");
    assert_eq!(v3.major, 137);
    assert_eq!(v3.minor, 0);
    assert_eq!(v3.patch, 0);
  }

  #[test]
  fn test_version_comparison() {
    assert!(VersionComponent::parse("1.2.4") > VersionComponent::parse("1.2.3"));
    assert!(VersionComponent::parse("2.0.0") > VersionComponent::parse("1.9.9"));
    assert!(VersionComponent::parse("138.0.7204.50") > VersionComponent::parse("138.0.7204.49"));
  }

  #[test]
  fn test_version_sorting() {
    let mut versions = vec![
      "138.0.7204.50".to_string(),
      "138.0.7204.49".to_string(),
      "139.0.7204.1".to_string(),
      "137.0.7204.99".to_string(),
    ];

    sort_versions(&mut versions);

    assert_eq!(versions[0], "139.0.7204.1");
    assert_eq!(versions[1], "138.0.7204.50");
    assert_eq!(versions[2], "138.0.7204.49");
    assert_eq!(versions[3], "137.0.7204.99");
  }
}
