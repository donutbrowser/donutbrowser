use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TableSortingSettings {
  pub column: String,    // Column to sort by: "name", "browser", "status"
  pub direction: String, // "asc" or "desc"
}

impl Default for TableSortingSettings {
  fn default() -> Self {
    Self {
      column: "name".to_string(),
      direction: "asc".to_string(),
    }
  }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct TableSort {
  pub id: String,
  pub desc: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TableDensity {
  #[default]
  Compact,
  Comfortable,
}

/// A named table view: the search, filters, sort, visible columns and column
/// order saved under one name.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct TableSavedView {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub query: String,
  #[serde(default)]
  pub filters: BTreeMap<String, Vec<String>>,
  #[serde(default)]
  pub sorting: Vec<TableSort>,
  #[serde(default)]
  pub visibility: BTreeMap<String, bool>,
  #[serde(default)]
  pub column_order: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(default)]
pub struct TablePreferences {
  pub visibility: BTreeMap<String, bool>,
  pub sizing: BTreeMap<String, f64>,
  pub sorting: Vec<TableSort>,
  pub density: TableDensity,
  /// Column ids, left to right. Columns not listed keep their place.
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub column_order: Vec<String>,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub views: Vec<TableSavedView>,
  /// The id of the view applied when the app starts.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_view: Option<String>,
}

impl Default for TablePreferences {
  fn default() -> Self {
    Self {
      visibility: BTreeMap::new(),
      sizing: BTreeMap::new(),
      sorting: vec![TableSort {
        id: "name".into(),
        desc: false,
      }],
      density: TableDensity::Compact,
      column_order: Vec::new(),
      views: Vec::new(),
      default_view: None,
    }
  }
}

const TABLE_VIEW_LIMIT: usize = 32;

fn valid_table_column_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_table_sorting(sorting: &[TableSort]) -> bool {
  let mut ids = HashSet::new();
  sorting.len() <= 16
    && sorting
      .iter()
      .all(|sort| valid_table_column_id(&sort.id) && ids.insert(sort.id.as_str()))
}

fn valid_table_visibility(visibility: &BTreeMap<String, bool>) -> bool {
  visibility.len() <= 64 && visibility.keys().all(|id| valid_table_column_id(id))
}

fn valid_table_column_order(order: &[String]) -> bool {
  let mut ids = HashSet::new();
  order.len() <= 64
    && order
      .iter()
      .all(|id| valid_table_column_id(id) && ids.insert(id.as_str()))
}

fn valid_table_view(view: &TableSavedView) -> bool {
  !view.id.is_empty()
    && view.id.len() <= 64
    && view
      .id
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    && !view.name.trim().is_empty()
    && view.name.chars().count() <= 80
    && view.query.chars().count() <= 1000
    && view.filters.len() <= 32
    && view.filters.iter().all(|(id, values)| {
      valid_table_column_id(id)
        && values.len() <= 256
        && values.iter().all(|value| value.chars().count() <= 256)
    })
    && valid_table_sorting(&view.sorting)
    && valid_table_visibility(&view.visibility)
    && valid_table_column_order(&view.column_order)
}

fn table_preferences_valid(table_id: &str, preferences: &TablePreferences) -> bool {
  let mut view_ids = HashSet::new();
  matches!(
    table_id,
    "profiles" | "proxies" | "vpns" | "extensions" | "extensionGroups" | "groups" | "trash"
  ) && valid_table_visibility(&preferences.visibility)
    && preferences.sizing.len() <= 64
    && preferences.sizing.iter().all(|(id, width)| {
      valid_table_column_id(id) && width.is_finite() && (28.0..=1600.0).contains(width)
    })
    && valid_table_sorting(&preferences.sorting)
    && valid_table_column_order(&preferences.column_order)
    && preferences.views.len() <= TABLE_VIEW_LIMIT
    && preferences
      .views
      .iter()
      .all(|view| valid_table_view(view) && view_ids.insert(view.id.as_str()))
    && preferences
      .default_view
      .as_ref()
      .is_none_or(|id| view_ids.contains(id.as_str()))
}

#[tauri::command]
pub fn get_table_preferences(table_id: String) -> Result<TablePreferences, String> {
  let default = TablePreferences::default();
  if !table_preferences_valid(&table_id, &default) {
    return Err(serde_json::json!({"code": "TABLE_PREFERENCES_INVALID"}).to_string());
  }
  let manager = SettingsManager::instance();
  let path = manager
    .get_settings_dir()
    .join(format!("table_{table_id}.json"));
  let load = || -> Result<TablePreferences, Box<dyn std::error::Error>> {
    if path.exists() {
      let preferences = serde_json::from_slice::<TablePreferences>(&fs::read(path)?)?;
      if !table_preferences_valid(&table_id, &preferences) {
        return Err("Invalid saved table preferences".into());
      }
      return Ok(preferences);
    }
    let mut preferences = default;
    if table_id == "profiles" {
      let legacy = manager.load_table_sorting()?;
      preferences.sorting = vec![TableSort {
        id: legacy.column,
        desc: legacy.direction == "desc",
      }];
    }
    if table_id == "trash" {
      // What was deleted last is what is most often brought back.
      preferences.sorting = vec![TableSort {
        id: "deleted".into(),
        desc: true,
      }];
    }
    Ok(preferences)
  };
  load().map_err(|error| {
    log::warn!("Table preferences load failed table={table_id} err=\"{error}\"");
    serde_json::json!({"code": "TABLE_PREFERENCES_LOAD_FAILED"}).to_string()
  })
}

#[tauri::command]
pub fn save_table_preferences(
  table_id: String,
  preferences: TablePreferences,
) -> Result<(), String> {
  if !table_preferences_valid(&table_id, &preferences) {
    return Err(serde_json::json!({"code": "TABLE_PREFERENCES_INVALID"}).to_string());
  }
  static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
  let persist = || -> Result<(), Box<dyn std::error::Error>> {
    let _guard = WRITE_LOCK
      .lock()
      .map_err(|_| "Table preferences lock failed")?;
    let directory = SettingsManager::instance().get_settings_dir();
    create_dir_all(&directory)?;
    let json = serde_json::to_vec_pretty(&preferences)?;
    write_whole(&directory.join(format!("table_{table_id}.json")), &json)?;
    Ok(())
  };
  persist().map_err(|error| {
    log::warn!("Table preferences save failed table={table_id} err=\"{error}\"");
    serde_json::json!({"code": "TABLE_PREFERENCES_SAVE_FAILED"}).to_string()
  })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
  #[serde(default)]
  pub set_as_default_browser: bool,
  #[serde(default = "default_theme")]
  pub theme: String, // "light", "dark", or "system"
  #[serde(default)]
  pub custom_theme: Option<std::collections::HashMap<String, String>>, // CSS var name -> value (e.g., "--background": "#1a1b26")
  #[serde(default)]
  pub api_enabled: bool,
  #[serde(default = "default_api_port")]
  pub api_port: u16,
  #[serde(default)]
  pub api_token: Option<String>, // Displayed token for user to copy
  #[serde(default)]
  pub sync_server_url: Option<String>, // URL of the sync server
  /// The customer's own donut-sync a signed-in paid account syncs with,
  /// instead of Donut cloud (`sync::account_server`). Owned by
  /// `set_account_sync_server`, never by a settings save.
  #[serde(default)]
  pub account_sync_server_url: Option<String>,
  /// The source a signed-in device syncs with, when its person picked one
  /// (`sync::account_server`). Owned by `set_sync_source` and
  /// `set_account_sync_server`, never by a settings save.
  #[serde(default)]
  pub sync_source: Option<crate::sync::account_server::SyncSourceKind>,
  #[serde(default)]
  pub first_launch_timestamp: Option<u64>, // Unix epoch seconds when app was first launched
  #[serde(default)]
  pub commercial_trial_acknowledged: bool, // Has user dismissed the trial expiration modal
  /// Let Donut cloud drive this installation's MCP tools over an outbound
  /// bridge, so an agent on the website can control this browser.
  ///
  /// Defaults to OFF and stays off until the user says otherwise. It opens a
  /// long-lived socket to Donut cloud and hands the far end the ability to
  /// launch and drive profiles, which is not something to switch on for
  /// somebody by default because their plan happens to include it.
  #[serde(default)]
  pub mcp_remote_enabled: bool,
  /// The durable `dmk_` credential agents present to the remote MCP endpoint.
  ///
  /// Plaintext, kept in an encrypted file with the same posture as
  /// `api_token`: loaded into the struct for a frontend settings read (the
  /// page shows only its prefix; the fx export line, the copied examples and
  /// the copy button carry the key), and stripped by `save_settings` so the
  /// settings JSON never carries it. Absent from the wire when there is none,
  /// so a settings file written by an older build stays byte-for-byte
  /// unchanged.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mcp_remote_key: Option<String>,
  /// The server-side id of `mcp_remote_key`, so a rotation can revoke exactly
  /// the key it replaces. Not a secret; lives in the settings JSON.
  #[serde(default)]
  pub mcp_remote_key_id: Option<String>,
  #[serde(default)]
  pub language: Option<String>, // ISO 639-1: "en", "es", "pt", "fr", "de", "zh", "ja", "ko", "ru", "tr", "vi", or None for system default
  #[serde(default)]
  pub window_resize_warning_dismissed: bool,
  /// Stop blocking launches whose proxy exit disagrees with the fingerprint.
  /// Lives here rather than in localStorage because the Rust launch path is
  /// what enforces the block and cannot read the frontend's storage.
  #[serde(default)]
  pub fingerprint_gate_disabled: bool,
  /// Stop warning about VPN/proxy extensions found in a profile.
  #[serde(default)]
  pub vpn_extension_warning_disabled: bool,
  #[serde(default)]
  pub onboarding_completed: bool, // First-launch onboarding has been shown/handled (one-shot)
  #[serde(default)]
  pub disable_auto_updates: bool,
  /// When true, the decrypted in-RAM copy of a password-protected profile is
  /// preserved between launches for faster subsequent startups. The on-disk
  /// copy is always re-encrypted regardless of this flag.
  #[serde(default)]
  pub keep_decrypted_profiles_in_ram: bool,
  /// Feature tips. Whether a tip may appear on the Profiles page, at most
  /// one a day. Off is the user's choice, made in the tips catalog or on the
  /// tip itself.
  #[serde(default = "default_tips_auto_show")]
  pub tips_auto_show: bool,
  /// Ids of the tips that have been read: shown in the catalog, or dismissed
  /// or acted on where they appeared. The inline tip never repeats one.
  #[serde(default)]
  pub tips_seen: Vec<String>,
  /// Unix seconds when the last inline tip appeared.
  #[serde(default)]
  pub tips_last_auto_shown_at: Option<u64>,
  /// Unix seconds before which no new inline tip appears. Set when one is
  /// closed: the next local day, and at least `TIPS_INLINE_MIN_GAP_SECS`
  /// later, so a restart keeps the same wait.
  #[serde(default)]
  pub tips_next_auto_show_at: Option<u64>,
  /// The tip on the Profiles page now. It stays, across restarts, until it is
  /// dismissed, acted on, or read in the catalog.
  #[serde(default)]
  pub tips_inline: Option<String>,
  /// Features seen in use that leave no other trace, such as the command
  /// palette or a field search. Their tips are not shown.
  #[serde(default)]
  pub tips_used: Vec<String>,
  /// Unix seconds when the person last sent feedback from the app. Only the
  /// feedback command writes it; the feedback tip is not offered once set.
  #[serde(default)]
  pub feedback_sent_at: Option<u64>,
  /// Cloud user ids that have had the paid-plan welcome.
  #[serde(default)]
  pub paid_welcome_seen_for: Vec<String>,
  /// The plan status last observed per cloud user id, `"free"` or `"paid"`.
  /// A change from free to paid is what earns the paid-plan welcome.
  #[serde(default)]
  pub cloud_plan_memory: std::collections::HashMap<String, String>,
  /// Refuse every launch that would reach the internet without a proxy or
  /// VPN: a profile with no route, and one whose proxy or VPN is gone.
  #[serde(default)]
  pub require_route_for_launch: bool,
  /// Days a deleted profile can still be restored. 0 destroys it at once.
  #[serde(default = "default_trash_retention_days")]
  pub trash_retention_days: u32,
  /// Record which sites each profile visits in its traffic stats. Off keeps
  /// byte counts only, so nothing on disk lists where a profile went.
  #[serde(default = "default_record_traffic_domains")]
  pub record_traffic_domains: bool,
  /// Soft interface sounds: the master switch over the fields below.
  #[serde(default = "default_ui_sounds")]
  pub ui_sounds: bool,
  /// Interface sound volume, 0 to 100. Out-of-range numbers are clamped as
  /// they are read, so a bad value never resets the whole settings file.
  #[serde(
    default = "default_ui_sound_volume",
    deserialize_with = "deserialize_ui_sound_volume"
  )]
  pub ui_sound_volume: u8,
  /// Sounds for presses, toggles and navigation.
  #[serde(default = "default_ui_sounds")]
  pub ui_sound_interface: bool,
  /// Sounds for results: success, error, warning, copy, delete, restore.
  #[serde(default = "default_ui_sounds")]
  pub ui_sound_feedback: bool,
  /// Sounds for events: launch, stop, sync, downloads, notifications.
  #[serde(default = "default_ui_sounds")]
  pub ui_sound_events: bool,
  /// The sound pack id. The frontend plays an unknown id as the default
  /// pack and keeps it stored, so a downgrade does not lose the choice.
  #[serde(default = "default_ui_sound_pack")]
  pub ui_sound_pack: String,
  /// The optional MCP toolsets written into clients' endpoint URLs. Empty is
  /// every tool.
  #[serde(default)]
  pub mcp_toolsets: Vec<String>,
  /// Pause between two launches of one bulk run, in milliseconds.
  #[serde(
    default = "default_bulk_launch_delay_ms",
    deserialize_with = "deserialize_bulk_launch_delay_ms"
  )]
  pub bulk_launch_delay_ms: u32,
  /// How many profiles of one bulk run may be starting at the same time.
  #[serde(
    default = "default_bulk_launch_concurrency",
    deserialize_with = "deserialize_bulk_launch_concurrency"
  )]
  pub bulk_launch_concurrency: u32,
  /// System notifications for events that finish while the window is not in
  /// front: an agent asking for help, a bulk job, a failed sync.
  #[serde(default = "default_system_notifications")]
  pub system_notifications: bool,
  /// Start Donut when the user logs in.
  #[serde(default)]
  pub launch_at_login: bool,
  /// Open again, at startup, the profiles that were running when Donut quit.
  #[serde(default)]
  pub reopen_running_profiles: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SyncSettings {
  pub sync_server_url: Option<String>,
  pub sync_token: Option<String>, // Only populated when reading, not stored in JSON
  #[serde(default)]
  pub source: Option<crate::sync::account_server::SyncSourceKind>,
}

fn default_theme() -> String {
  "system".to_string()
}

fn default_api_port() -> u16 {
  10108
}

fn default_tips_auto_show() -> bool {
  true
}

pub const DEFAULT_BULK_LAUNCH_DELAY_MS: u32 = 800;
pub const MAX_BULK_LAUNCH_DELAY_MS: u32 = 60_000;
pub const DEFAULT_BULK_LAUNCH_CONCURRENCY: u32 = 3;
pub const MAX_BULK_LAUNCH_CONCURRENCY: u32 = 20;

fn default_bulk_launch_delay_ms() -> u32 {
  DEFAULT_BULK_LAUNCH_DELAY_MS
}

fn default_bulk_launch_concurrency() -> u32 {
  DEFAULT_BULK_LAUNCH_CONCURRENCY
}

fn deserialize_bulk_launch_delay_ms<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
  D: serde::Deserializer<'de>,
{
  let delay = f64::deserialize(deserializer)?;
  Ok(
    delay
      .round()
      .clamp(0.0, f64::from(MAX_BULK_LAUNCH_DELAY_MS)) as u32,
  )
}

fn deserialize_bulk_launch_concurrency<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
  D: serde::Deserializer<'de>,
{
  let concurrency = f64::deserialize(deserializer)?;
  Ok(
    concurrency
      .round()
      .clamp(1.0, f64::from(MAX_BULK_LAUNCH_CONCURRENCY)) as u32,
  )
}

fn default_system_notifications() -> bool {
  true
}

pub const DEFAULT_TRASH_RETENTION_DAYS: u32 = 30;
/// The longest retention the Settings page offers.
pub const MAX_TRASH_RETENTION_DAYS: u32 = 90;

fn default_trash_retention_days() -> u32 {
  DEFAULT_TRASH_RETENTION_DAYS
}

fn default_record_traffic_domains() -> bool {
  true
}

fn default_ui_sounds() -> bool {
  true
}

pub const DEFAULT_UI_SOUND_VOLUME: u8 = 60;
pub const MAX_UI_SOUND_VOLUME: u8 = 100;
pub const DEFAULT_UI_SOUND_PACK: &str = "soft";

fn default_ui_sound_volume() -> u8 {
  DEFAULT_UI_SOUND_VOLUME
}

fn default_ui_sound_pack() -> String {
  DEFAULT_UI_SOUND_PACK.to_string()
}

fn deserialize_ui_sound_volume<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
  D: serde::Deserializer<'de>,
{
  let volume = f64::deserialize(deserializer)?;
  Ok(volume.round().clamp(0.0, f64::from(MAX_UI_SOUND_VOLUME)) as u8)
}

/// The shortest wait between closing one inline tip and the next one. With
/// the next-day rule, a tip closed late in the evening does not make room for
/// another a few minutes later, just after midnight.
pub const TIPS_INLINE_MIN_GAP_SECS: u64 = 12 * 60 * 60;

/// The plan status remembered per cloud user.
const PLAN_STATUS_PAID: &str = "paid";
const PLAN_STATUS_FREE: &str = "free";

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      set_as_default_browser: false,
      theme: "system".to_string(),
      custom_theme: None,
      api_enabled: false,
      api_port: 10108,
      api_token: None,
      sync_server_url: None,
      account_sync_server_url: None,
      sync_source: None,
      first_launch_timestamp: None,
      commercial_trial_acknowledged: false,
      mcp_remote_enabled: false,
      mcp_remote_key: None,
      mcp_remote_key_id: None,
      language: None,
      window_resize_warning_dismissed: false,
      fingerprint_gate_disabled: false,
      vpn_extension_warning_disabled: false,
      onboarding_completed: false,
      disable_auto_updates: false,
      keep_decrypted_profiles_in_ram: false,
      tips_auto_show: true,
      tips_seen: Vec::new(),
      tips_last_auto_shown_at: None,
      tips_next_auto_show_at: None,
      tips_inline: None,
      tips_used: Vec::new(),
      feedback_sent_at: None,
      paid_welcome_seen_for: Vec::new(),
      cloud_plan_memory: std::collections::HashMap::new(),
      require_route_for_launch: false,
      trash_retention_days: DEFAULT_TRASH_RETENTION_DAYS,
      record_traffic_domains: true,
      ui_sounds: true,
      ui_sound_volume: DEFAULT_UI_SOUND_VOLUME,
      ui_sound_interface: true,
      ui_sound_feedback: true,
      ui_sound_events: true,
      ui_sound_pack: DEFAULT_UI_SOUND_PACK.to_string(),
      mcp_toolsets: Vec::new(),
      bulk_launch_delay_ms: DEFAULT_BULK_LAUNCH_DELAY_MS,
      bulk_launch_concurrency: DEFAULT_BULK_LAUNCH_CONCURRENCY,
      system_notifications: true,
      launch_at_login: false,
      reopen_running_profiles: false,
    }
  }
}

/// The remote MCP credential as it is kept on this machine.
#[derive(Debug, Clone)]
pub struct StoredMcpRemoteKey {
  /// The plaintext `dmk_` key.
  pub key: String,
  /// The server-side id, when the store that wrote the key also recorded it.
  pub id: Option<String>,
}

pub struct SettingsManager;

/// Write `content` to `path` in one step: to a sibling first, then renamed
/// into place. A reader that opens the file mid-write, and there are several
/// at startup, sees the old settings or the new ones, never an empty file
/// that parses as the defaults.
fn write_whole(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
  let staging = path.with_extension("json.tmp");
  fs::write(&staging, content)?;
  if let Err(e) = fs::rename(&staging, path) {
    let _ = fs::remove_file(&staging);
    return Err(e);
  }
  Ok(())
}

impl SettingsManager {
  pub(crate) fn new() -> Self {
    Self
  }

  pub fn instance() -> &'static SettingsManager {
    &SETTINGS_MANAGER
  }

  pub fn get_settings_dir(&self) -> PathBuf {
    crate::app_dirs::settings_dir()
  }

  pub fn get_settings_file(&self) -> PathBuf {
    self.get_settings_dir().join("app_settings.json")
  }

  pub fn get_table_sorting_file(&self) -> PathBuf {
    self.get_settings_dir().join("table_sorting.json")
  }

  pub fn load_settings(&self) -> Result<AppSettings, Box<dyn std::error::Error>> {
    let settings_file = self.get_settings_file();

    if !settings_file.exists() {
      // Return default settings if file doesn't exist
      return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(&settings_file)?;

    // Parse the settings file - serde will use default values for missing fields
    match serde_json::from_str::<AppSettings>(&content) {
      Ok(settings) => Ok(settings),
      Err(e) => {
        log::warn!("Settings file unparsable; using defaults err=\"{e}\"");
        Ok(AppSettings::default())
      }
    }
  }

  pub fn save_settings(&self, settings: &AppSettings) -> Result<(), Box<dyn std::error::Error>> {
    let settings_dir = self.get_settings_dir();
    create_dir_all(&settings_dir)?;

    // The remote MCP credential works from anywhere on the internet and has
    // its own encrypted file; a struct loaded for the frontend carries it, so
    // it is dropped at the one place the JSON gets written rather than at
    // every caller that happens to hold such a struct.
    let mut on_disk = settings.clone();
    on_disk.mcp_remote_key = None;

    let settings_file = self.get_settings_file();
    let json = serde_json::to_string_pretty(&on_disk)?;
    write_whole(&settings_file, json.as_bytes())?;

    Ok(())
  }

  pub fn load_table_sorting(&self) -> Result<TableSortingSettings, Box<dyn std::error::Error>> {
    let sorting_file = self.get_table_sorting_file();

    if !sorting_file.exists() {
      // Return default sorting if file doesn't exist
      return Ok(TableSortingSettings::default());
    }

    let content = fs::read_to_string(sorting_file)?;
    let sorting: TableSortingSettings = serde_json::from_str(&content)?;
    Ok(sorting)
  }

  /// The pre-table-views sort file. Only migration reads it now.
  #[cfg(test)]
  pub fn save_table_sorting(
    &self,
    sorting: &TableSortingSettings,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let settings_dir = self.get_settings_dir();
    create_dir_all(&settings_dir)?;

    let sorting_file = self.get_table_sorting_file();
    let json = serde_json::to_string_pretty(sorting)?;
    write_whole(&sorting_file, json.as_bytes())?;

    Ok(())
  }

  /// Seal `secret` into `file`.
  ///
  /// One implementation for every secret this manager keeps on disk, in
  /// `crate::vault`: the API, MCP and sync tokens and the remote MCP
  /// credential share the layout, and only the five-byte header tells them
  /// apart.
  fn encrypt_to_file(
    file: &std::path::Path,
    header: &[u8; 5],
    secret: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    crate::vault::seal(file, &Self::magic(header), secret)?;
    Ok(())
  }

  /// Read back a secret written by `encrypt_to_file`.
  ///
  /// A missing file, a foreign header or a layout this version does not know
  /// all read as "no secret" rather than an error, so a stale or damaged file
  /// never blocks the feature it belongs to; the caller simply mints again.
  fn decrypt_from_file(
    file: &std::path::Path,
    header: &[u8; 5],
  ) -> Result<Option<String>, Box<dyn std::error::Error>> {
    Ok(crate::vault::open(file, &Self::magic(header))?)
  }

  /// The header plus the layout version every file of this manager carries.
  fn magic(header: &[u8; 5]) -> [u8; 6] {
    let mut magic = [0u8; 6];
    magic[..5].copy_from_slice(header);
    magic[5] = 2;
    magic
  }

  fn remove_secret_file(file: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    if file.exists() {
      std::fs::remove_file(file)?;
    }
    Ok(())
  }

  /// A fresh 256-bit token, base64url so it is safe in a URL path.
  fn random_token() -> String {
    let token_bytes: [u8; 32] = {
      use rand::Rng;
      let mut rng = rand::rng();
      let mut bytes = [0u8; 32];
      rng.fill_bytes(&mut bytes);
      bytes
    };
    use base64::{engine::general_purpose, Engine as _};
    general_purpose::URL_SAFE_NO_PAD.encode(token_bytes)
  }

  fn api_token_file(&self) -> PathBuf {
    self.get_settings_dir().join("api_token.dat")
  }

  fn sync_token_file(&self) -> PathBuf {
    self.get_settings_dir().join("sync_token.dat")
  }

  fn mcp_remote_key_file(&self) -> PathBuf {
    self.get_settings_dir().join("mcp_remote_key.dat")
  }

  pub async fn generate_api_token(
    &self,
    app_handle: &tauri::AppHandle,
  ) -> Result<String, Box<dyn std::error::Error>> {
    let token = Self::random_token();
    self.store_api_token(app_handle, &token).await?;
    Ok(token)
  }

  pub async fn store_api_token(
    &self,
    _app_handle: &tauri::AppHandle,
    token: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    Self::encrypt_to_file(&self.api_token_file(), b"DBAPI", token)
  }

  pub async fn get_api_token(
    &self,
    _app_handle: &tauri::AppHandle,
  ) -> Result<Option<String>, Box<dyn std::error::Error>> {
    Self::decrypt_from_file(&self.api_token_file(), b"DBAPI")
  }

  pub async fn remove_api_token(
    &self,
    _app_handle: &tauri::AppHandle,
  ) -> Result<(), Box<dyn std::error::Error>> {
    Self::remove_secret_file(&self.api_token_file())
  }

  pub async fn store_sync_token(
    &self,
    _app_handle: &tauri::AppHandle,
    token: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    Self::encrypt_to_file(&self.sync_token_file(), b"DBSYN", token)
  }

  pub async fn get_sync_token(
    &self,
    _app_handle: &tauri::AppHandle,
  ) -> Result<Option<String>, Box<dyn std::error::Error>> {
    Self::decrypt_from_file(&self.sync_token_file(), b"DBSYN")
  }

  pub async fn remove_sync_token(
    &self,
    _app_handle: &tauri::AppHandle,
  ) -> Result<(), Box<dyn std::error::Error>> {
    Self::remove_secret_file(&self.sync_token_file())
  }

  /// Keep the remote MCP credential: the `dmk_` key in its own encrypted file
  /// and the server-side key id in the settings JSON, so a later rotation can
  /// name the key it is retiring.
  ///
  /// The plaintext is deliberately NOT part of the settings JSON:
  /// `save_settings` strips it, and `get_app_settings` is the one reader that
  /// loads it back for the frontend, the way the API token is.
  pub fn store_mcp_remote_key(
    &self,
    key: &str,
    key_id: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    Self::encrypt_to_file(&self.mcp_remote_key_file(), b"DBMRK", key)?;
    let mut settings = self.load_settings()?;
    settings.mcp_remote_key_id = Some(key_id.to_string());
    self.save_settings(&settings)
  }

  /// The stored remote MCP credential, if any: the plaintext key and the id
  /// the server knows it by.
  ///
  /// Read with the id from the JSON and the key from its file, so the two
  /// cannot disagree: a key file without an id (an interrupted store) still
  /// yields the key, and an id without a key file yields nothing at all.
  pub fn get_mcp_remote_key(
    &self,
  ) -> Result<Option<StoredMcpRemoteKey>, Box<dyn std::error::Error>> {
    let Some(key) = Self::decrypt_from_file(&self.mcp_remote_key_file(), b"DBMRK")? else {
      return Ok(None);
    };
    let id = self.load_settings()?.mcp_remote_key_id;
    Ok(Some(StoredMcpRemoteKey { key, id }))
  }

  /// Drop the remote MCP credential from this machine. Does not revoke it:
  /// that is the caller's job, because only the caller knows whether it still
  /// has a session to revoke with.
  pub fn remove_mcp_remote_key(&self) -> Result<(), Box<dyn std::error::Error>> {
    self.drop_mcp_remote_key_plaintext()?;
    let mut settings = self.load_settings()?;
    if settings.mcp_remote_key_id.take().is_some() {
      self.save_settings(&settings)?;
    }
    Ok(())
  }

  /// Drop the plaintext and keep the id. For a key that may still be live on
  /// the server with no session left to revoke it: the next mint reads the id
  /// and retires that key.
  pub fn drop_mcp_remote_key_plaintext(&self) -> Result<(), Box<dyn std::error::Error>> {
    Self::remove_secret_file(&self.mcp_remote_key_file())
  }

  pub fn save_sync_server_url(
    &self,
    url: Option<String>,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let mut settings = self.load_settings()?;
    settings.sync_server_url = url;
    self.save_settings(&settings)
  }
}

#[tauri::command]
pub async fn get_app_settings(app_handle: tauri::AppHandle) -> Result<AppSettings, String> {
  let manager = SettingsManager::instance();
  let mut settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;

  // Always load tokens for display purposes if they exist
  settings.api_token = manager
    .get_api_token(&app_handle)
    .await
    .map_err(|e| format!("Failed to load API token: {e}"))?;

  // Same posture as the API token: sent so the page can copy it, never
  // persisted (see `SettingsManager::save_settings`).
  settings.mcp_remote_key = manager
    .get_mcp_remote_key()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
    .map(|stored| stored.key);

  Ok(settings)
}

#[tauri::command]
pub async fn save_app_settings(
  app_handle: tauri::AppHandle,
  mut settings: AppSettings,
) -> Result<AppSettings, String> {
  let manager = SettingsManager::instance();

  // The remote MCP credential is minted by `rotate_mcp_remote_credential` and
  // by nothing else. A settings read hands the frontend the plaintext (for the
  // fx export line) and the frontend echoes the whole struct back, so the
  // field is simply not the frontend's to write: whatever arrived is dropped
  // here and the stored key is what the answer below carries.
  settings.mcp_remote_key = None;

  // Handle API token
  if settings.api_enabled {
    if let Some(ref token) = settings.api_token {
      manager
        .store_api_token(&app_handle, token)
        .await
        .map_err(|e| format!("Failed to store API token: {e}"))?;
    } else {
      // Check if a token already exists on disk before generating a new one
      let existing = manager.get_api_token(&app_handle).await.ok().flatten();
      if let Some(t) = existing {
        settings.api_token = Some(t);
      } else {
        let token = manager
          .generate_api_token(&app_handle)
          .await
          .map_err(|e| format!("Failed to generate API token: {e}"))?;
        settings.api_token = Some(token);
      }
    }
  }

  if !settings.api_enabled {
    manager
      .remove_api_token(&app_handle)
      .await
      .map_err(|e| format!("Failed to remove API token: {e}"))?;
    settings.api_token = None;
  }

  // Preserve the fields the frontend does not own. Read directly from the
  // file to avoid load_settings' save-on-load behavior.
  //
  // `mcp_remote_enabled` is flipped ONLY by `start_mcp_remote_bridge` and
  // `stop_mcp_remote_bridge`, which also start and stop the bridge task. A
  // settings save that carried the flag could switch the internet-facing
  // bridge on for the next launch without ever going through the sign-in and
  // terms gates those commands enforce, or switch it off on disk while the
  // task kept running. The key id is bookkeeping for the rotation path and is
  // never the frontend's to write.
  settings.trash_retention_days = settings.trash_retention_days.min(MAX_TRASH_RETENTION_DAYS);
  let mut previous_retention = None;
  // A tips command between this read and the save below would be lost.
  let tips_serial = TIPS_WRITE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Ok(content) = std::fs::read_to_string(manager.get_settings_file()) {
    if let Ok(current) = serde_json::from_str::<AppSettings>(&content) {
      previous_retention = Some(current.trash_retention_days);
      keep_tips_state(&mut settings, &current);
      settings.window_resize_warning_dismissed = current.window_resize_warning_dismissed;
      settings.mcp_remote_enabled = current.mcp_remote_enabled;
      settings.mcp_remote_key_id = current.mcp_remote_key_id;
      settings.feedback_sent_at = current.feedback_sent_at;
      settings.account_sync_server_url = current.account_sync_server_url;
      settings.sync_source = current.sync_source;
    }
  } else {
    settings.mcp_remote_enabled = false;
    settings.mcp_remote_key_id = None;
    settings.account_sync_server_url = None;
    settings.sync_source = None;
  }

  let mut persist_settings = settings.clone();
  persist_settings.api_token = None;

  log::debug!(
    "Settings saved theme={} custom_theme_keys={}",
    persist_settings.theme,
    persist_settings
      .custom_theme
      .as_ref()
      .map(|t| t.len())
      .unwrap_or(0)
  );

  manager
    .save_settings(&persist_settings)
    .map_err(|e| format!("Failed to save settings: {e}"))?;
  drop(tips_serial);

  {
    let handle = app_handle.clone();
    let launch_at_login = settings.launch_at_login;
    tauri::async_runtime::spawn_blocking(move || crate::autostart::apply(&handle, launch_at_login));
  }

  // A shorter retention applies to what is already in the trash. Sweep now
  // rather than at the next six-hourly pass, so "delete after 1 day" does not
  // keep a month-old profile until then.
  if previous_retention != Some(settings.trash_retention_days) {
    tauri::async_runtime::spawn_blocking(|| {
      crate::profile::trash::purge_expired_everywhere();
    });
  }

  // Answer with what a fresh read would show, the stored credential included,
  // so a page that keeps the answer as its settings does not lose the fx
  // export line on every save.
  settings.mcp_remote_key = manager
    .get_mcp_remote_key()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
    .map(|stored| stored.key);

  Ok(settings)
}

const TRUNCATED_MARK: &str = "[…truncated — older content elided…]\n";

/// The newest log files, redacted, each under a `===== name =====` header and
/// in chronological order so the freshest lines are at the bottom. At most
/// `max_bytes`: the oldest file that only fits in part keeps its last whole
/// lines.
pub(crate) fn recent_logs(dir: &Path, max_bytes: usize) -> std::io::Result<String> {
  let mut entries: Vec<(PathBuf, std::time::SystemTime)> = std::fs::read_dir(dir)?
    .filter_map(Result::ok)
    .filter_map(|entry| {
      let path = entry.path();
      let modified = entry.metadata().ok()?.modified().ok()?;
      let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
      (path.is_file() && (ext == "log" || ext == "txt")).then_some((path, modified))
    })
    .collect();
  entries.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));

  let mut sections = Vec::new();
  let mut used = 0;
  for (path, _) in entries {
    let header = format!(
      "===== {} =====\n",
      path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("log")
    );
    let Ok(raw) = std::fs::read(&path) else {
      continue;
    };
    let mut content = crate::log_redaction::text(&String::from_utf8_lossy(&raw));
    if !content.ends_with('\n') {
      content.push('\n');
    }
    let room = max_bytes.saturating_sub(used + header.len());
    if content.len() > room {
      let tail = last_lines(&content, room.saturating_sub(TRUNCATED_MARK.len()));
      if !tail.is_empty() {
        sections.push(format!("{header}{TRUNCATED_MARK}{tail}"));
      }
      break;
    }
    used += header.len() + content.len();
    sections.push(format!("{header}{content}"));
  }
  sections.reverse();
  Ok(sections.concat())
}

/// The whole lines at the end of `text` that fit in `max_bytes`.
fn last_lines(text: &str, max_bytes: usize) -> &str {
  if text.len() <= max_bytes {
    return text;
  }
  let start = text.len() - max_bytes;
  // A newline byte is always a character boundary, so this never splits one.
  match text.as_bytes()[start..].iter().position(|&b| b == b'\n') {
    Some(offset) => &text[start + offset + 1..],
    None => "",
  }
}

/// Read the most recent log files concatenated into a single string,
/// suitable for paste-into-issue-tracker. Capped at 5 MB to keep clipboard
/// payloads sane.
#[tauri::command]
pub async fn read_log_files(app_handle: tauri::AppHandle) -> Result<String, String> {
  let dir = crate::app_dirs::log_dir(&app_handle);
  if !dir.exists() {
    return Err("Log directory does not exist yet".to_string());
  }
  recent_logs(&dir, 5 * 1024 * 1024).map_err(|e| format!("Failed to read log dir: {e}"))
}

/// Reveal the log directory in the OS file manager.
#[tauri::command]
pub async fn open_log_directory(app_handle: tauri::AppHandle) -> Result<(), String> {
  let dir = crate::app_dirs::log_dir(&app_handle);
  if !dir.exists() {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create log dir: {e}"))?;
  }
  let path = dir.to_string_lossy().to_string();

  #[cfg(target_os = "macos")]
  {
    let child = std::process::Command::new("open")
      .arg(&path)
      .spawn()
      .map_err(|e| format!("Failed to open log dir: {e}"))?;
    log::info!(
      "Process spawned pid={} purpose=\"reveal log dir\" tool=open",
      child.id()
    );
  }
  #[cfg(target_os = "windows")]
  {
    let child = std::process::Command::new("explorer")
      .arg(&path)
      .spawn()
      .map_err(|e| format!("Failed to open log dir: {e}"))?;
    log::info!(
      "Process spawned pid={} purpose=\"reveal log dir\" tool=explorer",
      child.id()
    );
  }
  #[cfg(target_os = "linux")]
  {
    let child = std::process::Command::new("xdg-open")
      .arg(&path)
      .spawn()
      .map_err(|e| format!("Failed to open log dir: {e}"))?;
    log::info!(
      "Process spawned pid={} purpose=\"reveal log dir\" tool=xdg-open",
      child.id()
    );
  }
  Ok(())
}

#[tauri::command]
pub async fn get_sync_settings(app_handle: tauri::AppHandle) -> Result<SyncSettings, String> {
  use crate::sync::account_server::SyncSource;

  let source = crate::sync::account_server::current().await;
  let (sync_server_url, sync_token) = match &source {
    Some(SyncSource::Account(server)) => (
      Some(server.clone()),
      crate::cloud_auth::CLOUD_AUTH
        .server_sync_token(server)
        .await
        .ok(),
    ),
    Some(SyncSource::Cloud) => (
      Some(crate::cloud_auth::CLOUD_SYNC_URL.to_string()),
      crate::cloud_auth::CLOUD_AUTH
        .get_or_refresh_sync_token()
        .await
        .map_err(|e| format!("Failed to get cloud sync token: {e}"))?,
    ),
    Some(SyncSource::SelfHosted(server)) => (
      Some(server.clone()),
      SettingsManager::instance()
        .get_sync_token(&app_handle)
        .await
        .map_err(|e| format!("Failed to load sync token: {e}"))?,
    ),
    None => (None, None),
  };
  Ok(SyncSettings {
    sync_server_url,
    sync_token,
    source: source.map(|source| source.kind()),
  })
}

#[tauri::command]
pub async fn save_sync_settings(
  app_handle: tauri::AppHandle,
  sync_server_url: Option<String>,
  sync_token: Option<String>,
) -> Result<SyncSettings, String> {
  // Cloud login and self-hosted sync share the same sync engine and a
  // profile can't be sync'd to two backends at once. Block any *write*
  // (non-null URL or token) while the user is signed into their cloud
  // account — the clearing path (both `None`) is always allowed so logged-
  // in users can wipe a stale self-hosted config that pre-dates their
  // sign-in.
  let is_setting_self_hosted = sync_server_url.is_some() || sync_token.is_some();
  if is_setting_self_hosted && crate::cloud_auth::CLOUD_AUTH.is_logged_in().await {
    return Err(serde_json::json!({ "code": "SELF_HOSTED_REQUIRES_LOGOUT" }).to_string());
  }

  let manager = SettingsManager::instance();

  manager
    .save_sync_server_url(sync_server_url.clone())
    .map_err(|e| format!("Failed to save sync server URL: {e}"))?;

  if let Some(ref token) = sync_token {
    manager
      .store_sync_token(&app_handle, token)
      .await
      .map_err(|e| format!("Failed to store sync token: {e}"))?;
  } else {
    manager
      .remove_sync_token(&app_handle)
      .await
      .map_err(|e| format!("Failed to remove sync token: {e}"))?;
  }

  Ok(SyncSettings {
    sync_server_url,
    sync_token,
    source: crate::sync::account_server::current()
      .await
      .map(|source| source.kind()),
  })
}

#[tauri::command]
pub async fn dismiss_window_resize_warning() -> Result<(), String> {
  let manager = SettingsManager::instance();
  let mut settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  settings.window_resize_warning_dismissed = true;
  manager
    .save_settings(&settings)
    .map_err(|e| format!("Failed to save settings: {e}"))
}

#[tauri::command]
pub async fn get_window_resize_warning_dismissed() -> Result<bool, String> {
  let manager = SettingsManager::instance();
  let settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  Ok(settings.window_resize_warning_dismissed)
}

#[tauri::command]
pub async fn get_onboarding_completed() -> Result<bool, String> {
  let manager = SettingsManager::instance();
  let settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  Ok(settings.onboarding_completed)
}

#[tauri::command]
pub async fn complete_onboarding() -> Result<(), String> {
  let manager = SettingsManager::instance();
  let mut settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  settings.onboarding_completed = true;
  manager
    .save_settings(&settings)
    .map_err(|e| format!("Failed to save settings: {e}"))
}

/// What the tips flow needs to decide what to show and what to skip.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct TipsState {
  pub auto_show: bool,
  pub seen: Vec<String>,
  /// Features seen in use that leave no other trace.
  pub used: Vec<String>,
  /// The tip on the Profiles page now, if any.
  pub inline_tip: Option<String>,
  pub last_auto_shown_at: Option<u64>,
  /// Unix seconds from which a new inline tip may appear, or `None` before
  /// the first one closes.
  pub next_auto_show_at: Option<u64>,
  /// Whether a new inline tip may appear right now: tips are on, none is on
  /// the page, and the wait after the last one is over.
  pub auto_due: bool,
}

impl TipsState {
  fn of(settings: &AppSettings, now: u64) -> Self {
    // Settings from versions that stored no wait carry only the time of the
    // last automatic tip; the shortest wait applies to those. A tip on the
    // page has no wait yet: closing it sets one.
    let next_auto_show_at = settings.tips_next_auto_show_at.or_else(|| {
      settings
        .tips_last_auto_shown_at
        .filter(|_| settings.tips_inline.is_none())
        .map(|last| last.saturating_add(TIPS_INLINE_MIN_GAP_SECS))
    });
    Self {
      auto_show: settings.tips_auto_show,
      seen: settings.tips_seen.clone(),
      used: settings.tips_used.clone(),
      inline_tip: settings.tips_inline.clone(),
      last_auto_shown_at: settings.tips_last_auto_shown_at,
      next_auto_show_at,
      auto_due: settings.tips_auto_show
        && settings.tips_inline.is_none()
        && next_auto_show_at.is_none_or(|next| now >= next),
    }
  }
}

/// When the next inline tip may appear, after one closed at `now`: the start
/// of the next day in `tz`, and never sooner than `TIPS_INLINE_MIN_GAP_SECS`.
/// A midnight that a clock change repeats counts at its first occurrence; one
/// it skips moves to the first local time that exists.
fn next_inline_tip_at<Tz: chrono::TimeZone>(now: u64, tz: &Tz) -> u64 {
  let earliest = now.saturating_add(TIPS_INLINE_MIN_GAP_SECS);
  let Some(today) = i64::try_from(now)
    .ok()
    .and_then(|secs| tz.timestamp_opt(secs, 0).earliest())
    .map(|local| local.date_naive())
  else {
    return earliest;
  };
  let next_day = today
    .succ_opt()
    .and_then(|day| day.and_hms_opt(0, 0, 0))
    .and_then(|midnight| {
      (0..=24).find_map(|quarter| {
        tz.from_local_datetime(&(midnight + chrono::Duration::minutes(15 * quarter)))
          .earliest()
      })
    })
    .and_then(|start| u64::try_from(start.timestamp()).ok());
  next_day.map_or(earliest, |start| start.max(earliest))
}

/// Serialises every read-modify-write of the tips fields. Two tips shown in
/// quick succession are two concurrent commands, and without this the second
/// load could precede the first save and drop it.
static TIPS_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn unix_now() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn listed(list: &[String], id: &str) -> bool {
  list.iter().any(|item| item == id)
}

/// Takes the inline tip off the page when it is `tip_id`, and starts the
/// wait for the next one.
fn close_inline_tip<Tz: chrono::TimeZone>(
  settings: &mut AppSettings,
  tip_id: &str,
  now: u64,
  tz: &Tz,
) {
  if settings.tips_inline.as_deref() != Some(tip_id) {
    return;
  }
  settings.tips_inline = None;
  settings.tips_next_auto_show_at = Some(next_inline_tip_at(now, tz));
}

/// Remembers a tip as read: shown in the catalog, or dismissed or acted on
/// on the Profiles page. Reading the inline tip closes it.
fn record_tip_seen<Tz: chrono::TimeZone>(
  settings: &mut AppSettings,
  tip_id: &str,
  now: u64,
  tz: &Tz,
) {
  if !listed(&settings.tips_seen, tip_id) {
    settings.tips_seen.push(tip_id.to_string());
  }
  close_inline_tip(settings, tip_id, now, tz);
}

/// Puts `tip_id` on the Profiles page if a new tip is due and the tip is
/// neither read nor about a feature in use. Answers whether it did.
fn pin_inline_tip(settings: &mut AppSettings, tip_id: &str, now: u64) -> bool {
  if !TipsState::of(settings, now).auto_due
    || listed(&settings.tips_seen, tip_id)
    || listed(&settings.tips_used, tip_id)
  {
    return false;
  }
  settings.tips_inline = Some(tip_id.to_string());
  settings.tips_last_auto_shown_at = Some(now);
  true
}

/// Takes the inline tip off the page unread, when this seat may no longer see
/// it (the plan that offered it is gone). It goes back to the pool, and the
/// next tip still waits for the day after this one appeared.
fn unpin_inline_tip<Tz: chrono::TimeZone>(settings: &mut AppSettings, tip_id: &str, tz: &Tz) {
  if settings.tips_inline.as_deref() != Some(tip_id) {
    return;
  }
  settings.tips_inline = None;
  settings.tips_next_auto_show_at = settings
    .tips_last_auto_shown_at
    .map(|shown| next_inline_tip_at(shown, tz));
}

/// Notes a feature in use. Its tip is not shown again, and leaves the page
/// if it is there.
fn note_feature_used<Tz: chrono::TimeZone>(
  settings: &mut AppSettings,
  tip_id: &str,
  now: u64,
  tz: &Tz,
) {
  if !listed(&settings.tips_used, tip_id) {
    settings.tips_used.push(tip_id.to_string());
  }
  close_inline_tip(settings, tip_id, now, tz);
}

/// Switched off, tips stop appearing and the one on the page goes, unread.
/// It counts as the day's tip, so switching back on brings none before the
/// next day.
fn apply_tips_auto_show<Tz: chrono::TimeZone>(
  settings: &mut AppSettings,
  enabled: bool,
  now: u64,
  tz: &Tz,
) {
  settings.tips_auto_show = enabled;
  if !enabled {
    if let Some(tip_id) = settings.tips_inline.clone() {
      close_inline_tip(settings, &tip_id, now, tz);
    }
  }
}

/// The tips and paid-welcome fields are written only by their own commands.
/// A settings save carries the copy the Settings page loaded, which can be
/// older, so these come from the stored settings instead.
fn keep_tips_state(settings: &mut AppSettings, current: &AppSettings) {
  settings.tips_auto_show = current.tips_auto_show;
  settings.tips_seen = current.tips_seen.clone();
  settings.tips_used = current.tips_used.clone();
  settings.tips_inline = current.tips_inline.clone();
  settings.tips_last_auto_shown_at = current.tips_last_auto_shown_at;
  settings.tips_next_auto_show_at = current.tips_next_auto_show_at;
  settings.paid_welcome_seen_for = current.paid_welcome_seen_for.clone();
  settings.cloud_plan_memory = current.cloud_plan_memory.clone();
}

/// Records the plan status seen for a cloud account and answers whether the
/// paid-plan welcome is due for it.
///
/// The welcome is for an account that just became paid: one this desktop last
/// saw as free, or one it sees for the first time right after the user signed
/// in (they bought a plan on the website and came back). An account that was
/// already paid the last time anybody looked, or that turns up paid in an old
/// session after an app update, is not new to its plan and is recorded as
/// greeted without a dialog.
fn paid_welcome_due(
  settings: &mut AppSettings,
  user_id: &str,
  paid: bool,
  fresh_login: bool,
) -> bool {
  let status = if paid {
    PLAN_STATUS_PAID
  } else {
    PLAN_STATUS_FREE
  };
  let previous = settings
    .cloud_plan_memory
    .insert(user_id.to_string(), status.to_string());
  if !paid {
    return false;
  }
  if settings
    .paid_welcome_seen_for
    .iter()
    .any(|id| id == user_id)
  {
    return false;
  }
  let due = match previous.as_deref() {
    Some(PLAN_STATUS_FREE) => true,
    Some(_) => false,
    None => fresh_login,
  };
  settings.paid_welcome_seen_for.push(user_id.to_string());
  due
}

#[tauri::command]
pub async fn get_tips_state() -> Result<TipsState, String> {
  let manager = SettingsManager::instance();
  let settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  Ok(TipsState::of(&settings, unix_now()))
}

/// Loads the settings, applies `change` under the tips lock, saves them, and
/// answers the new tips state.
fn update_tips(change: impl FnOnce(&mut AppSettings, u64)) -> Result<TipsState, String> {
  let _serial = TIPS_WRITE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let manager = SettingsManager::instance();
  let mut settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  let now = unix_now();
  change(&mut settings, now);
  manager
    .save_settings(&settings)
    .map_err(|e| format!("Failed to save settings: {e}"))?;
  Ok(TipsState::of(&settings, now))
}

#[tauri::command]
pub async fn mark_tip_seen(tip_id: String) -> Result<TipsState, String> {
  update_tips(|settings, now| record_tip_seen(settings, &tip_id, now, &chrono::Local))
}

#[tauri::command]
pub async fn show_inline_tip(tip_id: String) -> Result<TipsState, String> {
  update_tips(|settings, now| {
    pin_inline_tip(settings, &tip_id, now);
  })
}

#[tauri::command]
pub async fn release_inline_tip(tip_id: String) -> Result<TipsState, String> {
  update_tips(|settings, _| unpin_inline_tip(settings, &tip_id, &chrono::Local))
}

#[tauri::command]
pub async fn note_tip_feature_used(tip_id: String) -> Result<TipsState, String> {
  update_tips(|settings, now| note_feature_used(settings, &tip_id, now, &chrono::Local))
}

/// Remember that the person has sent feedback, so the feedback tip is not
/// offered again.
pub(crate) fn note_feedback_sent() {
  let _serial = TIPS_WRITE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let manager = SettingsManager::instance();
  let saved = manager.load_settings().and_then(|mut settings| {
    settings.feedback_sent_at = Some(unix_now());
    manager.save_settings(&settings)
  });
  if let Err(e) = saved {
    log::warn!("Feedback sent time not saved err=\"{e}\"");
  }
}

#[tauri::command]
pub async fn set_tips_auto_show(enabled: bool) -> Result<TipsState, String> {
  update_tips(|settings, now| apply_tips_auto_show(settings, enabled, now, &chrono::Local))
}

#[tauri::command]
pub async fn observe_cloud_plan(
  user_id: String,
  paid: bool,
  fresh_login: bool,
) -> Result<bool, String> {
  let _serial = TIPS_WRITE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let manager = SettingsManager::instance();
  let mut settings = manager
    .load_settings()
    .map_err(|e| format!("Failed to load settings: {e}"))?;
  let due = paid_welcome_due(&mut settings, &user_id, paid, fresh_login);
  manager
    .save_settings(&settings)
    .map_err(|e| format!("Failed to save settings: {e}"))?;
  Ok(due)
}

#[tauri::command]
pub fn get_system_language() -> String {
  sys_locale::get_locale()
    .map(|locale| {
      // Extract just the language code (e.g., "en" from "en-US")
      locale
        .split(['-', '_'])
        .next()
        .unwrap_or("en")
        .to_lowercase()
    })
    .unwrap_or_else(|| "en".to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct SystemInfo {
  pub app_version: String,
  pub os: String,
  pub arch: String,
  pub portable: bool,
}

#[tauri::command]
pub fn get_system_info() -> SystemInfo {
  let os = if cfg!(target_os = "macos") {
    "macOS"
  } else if cfg!(target_os = "windows") {
    "Windows"
  } else if cfg!(target_os = "linux") {
    "Linux"
  } else {
    "Unknown"
  };

  let arch = if cfg!(target_arch = "x86_64") {
    "x86_64"
  } else if cfg!(target_arch = "aarch64") {
    "aarch64"
  } else {
    "unknown"
  };

  SystemInfo {
    app_version: crate::app_auto_updater::AppAutoUpdater::get_current_version(),
    os: os.to_string(),
    arch: arch.to_string(),
    portable: crate::app_dirs::is_portable(),
  }
}

// Global singleton instance
static SETTINGS_MANAGER: std::sync::LazyLock<SettingsManager> =
  std::sync::LazyLock::new(SettingsManager::new);

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  fn create_test_settings_manager() -> (SettingsManager, TempDir, crate::app_dirs::TestDirGuard) {
    let temp_dir = TempDir::new().expect("Failed to create temp directory");
    let guard = crate::app_dirs::set_test_data_dir(temp_dir.path().to_path_buf());
    let manager = SettingsManager::new();
    (manager, temp_dir, guard)
  }

  #[test]
  fn test_settings_manager_creation() {
    let (_manager, _temp_dir, _guard) = create_test_settings_manager();
  }

  const HOUR: u64 = 60 * 60;
  const DAY: u64 = 24 * HOUR;
  /// A UTC midnight.
  const MIDNIGHT: u64 = 20_000 * DAY;

  #[test]
  fn tips_state_defaults_to_on_and_due() {
    let state = TipsState::of(&AppSettings::default(), 1_000_000);
    assert!(state.auto_show);
    assert!(state.seen.is_empty() && state.used.is_empty());
    assert_eq!(state.inline_tip, None);
    assert_eq!(state.next_auto_show_at, None);
    assert!(state.auto_due, "a fresh install owes its first tip");
  }

  #[test]
  fn the_next_inline_tip_waits_for_the_next_local_day() {
    let utc = chrono::Utc;
    let zone = |hours: i32| chrono::FixedOffset::east_opt(hours * 3600).expect("offset");
    assert_eq!(
      next_inline_tip_at(MIDNIGHT + 9 * HOUR, &utc),
      MIDNIGHT + DAY,
      "closed in the morning, the next may come at midnight"
    );
    assert_eq!(
      next_inline_tip_at(MIDNIGHT + 23 * HOUR, &utc),
      MIDNIGHT + DAY + 11 * HOUR,
      "closed late, the next waits the shortest gap"
    );
    assert_eq!(
      next_inline_tip_at(MIDNIGHT + 5 * HOUR, &zone(4)),
      MIDNIGHT + 20 * HOUR,
      "UTC+4: 09:00 local, so the local midnight is 20:00 UTC"
    );
    assert_eq!(
      next_inline_tip_at(MIDNIGHT + 16 * HOUR, &zone(-7)),
      MIDNIGHT + DAY + 7 * HOUR,
      "UTC-7: 09:00 local, so the local midnight is 07:00 UTC"
    );
    for seconds in [-12 * 3600, -7 * 3600, 0, 5 * 3600 + 1800, 14 * 3600] {
      let tz = chrono::FixedOffset::east_opt(seconds).expect("offset");
      let local_day = |at: u64| (at as i64 + i64::from(seconds)).div_euclid(DAY as i64);
      for minute in (0..24 * 60).step_by(17) {
        let now = MIDNIGHT + minute * 60;
        let next = next_inline_tip_at(now, &tz);
        assert!(
          local_day(next) > local_day(now),
          "offset {seconds}, minute {minute}: never the same local day"
        );
        assert!(next >= now + TIPS_INLINE_MIN_GAP_SECS);
        assert!(next <= now + DAY);
      }
    }
    assert_eq!(
      next_inline_tip_at(u64::MAX - 1, &utc),
      u64::MAX,
      "no overflow"
    );
  }

  #[test]
  fn the_next_day_survives_clock_changes_at_midnight() {
    use chrono::TimeZone;
    let tz = chrono_tz::America::Sao_Paulo;
    let at = |y, m, d, h| {
      u64::try_from(
        chrono::Utc
          .with_ymd_and_hms(y, m, d, h, 0, 0)
          .single()
          .expect("utc time")
          .timestamp(),
      )
      .expect("after 1970")
    };
    // 2019-02-17 00:00 (UTC-2) went back to 2019-02-16 23:00 (UTC-3). The
    // offset of the morning would put the next day at 23:00 the same day.
    assert_eq!(
      next_inline_tip_at(at(2019, 2, 16, 12), &tz),
      at(2019, 2, 17, 3),
      "the next day starts at 00:00 UTC-3"
    );
    // 2018-11-04 00:00 (UTC-3) jumped to 01:00 (UTC-2): no midnight that day.
    assert_eq!(
      next_inline_tip_at(at(2018, 11, 3, 13), &tz),
      at(2018, 11, 4, 3),
      "the next day starts at its first local time, 01:00 UTC-2"
    );
  }

  #[test]
  fn one_inline_tip_stays_until_closed_and_the_next_waits_a_day() {
    let mut settings = AppSettings::default();
    let now = MIDNIGHT + 10 * HOUR;
    assert!(pin_inline_tip(&mut settings, "vpn", now));
    assert_eq!(settings.tips_last_auto_shown_at, Some(now));
    let later = TipsState::of(&settings, now + 3 * DAY);
    assert_eq!(later.next_auto_show_at, None, "no wait while it is up");
    assert_eq!(
      later.inline_tip.as_deref(),
      Some("vpn"),
      "it stays across restarts"
    );
    assert!(!later.auto_due, "one tip at a time");
    assert!(!pin_inline_tip(&mut settings, "trash", now + HOUR));
    assert_eq!(settings.tips_inline.as_deref(), Some("vpn"));

    record_tip_seen(&mut settings, "groups", now + HOUR, &chrono::Utc);
    assert_eq!(
      settings.tips_inline.as_deref(),
      Some("vpn"),
      "reading another tip in the catalog leaves the inline one"
    );
    assert_eq!(settings.tips_next_auto_show_at, None);

    record_tip_seen(&mut settings, "vpn", now + 2 * HOUR, &chrono::Utc);
    assert_eq!(settings.tips_inline, None);
    assert_eq!(
      settings.tips_seen,
      vec!["groups".to_string(), "vpn".to_string()]
    );
    assert_eq!(settings.tips_next_auto_show_at, Some(MIDNIGHT + DAY));
    assert!(
      !TipsState::of(&settings, MIDNIGHT + DAY - 1).auto_due,
      "not again the same day"
    );
    assert!(!pin_inline_tip(&mut settings, "trash", MIDNIGHT + DAY - 1));
    assert!(TipsState::of(&settings, MIDNIGHT + DAY).auto_due);

    assert!(
      !pin_inline_tip(&mut settings, "vpn", MIDNIGHT + DAY),
      "a read tip never comes back"
    );
    assert!(pin_inline_tip(&mut settings, "trash", MIDNIGHT + DAY));
    record_tip_seen(&mut settings, "groups", MIDNIGHT + DAY, &chrono::Utc);
    assert_eq!(
      settings
        .tips_seen
        .iter()
        .filter(|id| id.as_str() == "groups")
        .count(),
      1
    );
  }

  #[test]
  fn a_feature_put_to_use_takes_its_tip_away_unread() {
    let mut settings = AppSettings::default();
    let now = MIDNIGHT + 10 * HOUR;
    assert!(pin_inline_tip(&mut settings, "commandPalette", now));
    note_feature_used(&mut settings, "commandPalette", now + 60, &chrono::Utc);
    note_feature_used(&mut settings, "commandPalette", now + 120, &chrono::Utc);
    assert_eq!(settings.tips_used, vec!["commandPalette".to_string()]);
    assert_eq!(settings.tips_inline, None);
    assert!(settings.tips_seen.is_empty());
    assert_eq!(settings.tips_next_auto_show_at, Some(MIDNIGHT + DAY));
    assert!(
      !pin_inline_tip(&mut settings, "commandPalette", MIDNIGHT + 2 * DAY),
      "a feature in use gets no tip"
    );
  }

  #[test]
  fn a_tip_the_seat_lost_goes_back_unread_and_the_day_rule_holds() {
    let mut settings = AppSettings::default();
    let now = MIDNIGHT + 10 * HOUR;
    assert!(pin_inline_tip(&mut settings, "cookieBot", now));
    unpin_inline_tip(&mut settings, "trash", &chrono::Utc);
    assert_eq!(
      settings.tips_inline.as_deref(),
      Some("cookieBot"),
      "only the tip on the page is released"
    );
    unpin_inline_tip(&mut settings, "cookieBot", &chrono::Utc);
    assert_eq!(settings.tips_inline, None);
    assert!(settings.tips_seen.is_empty(), "released is not read");
    assert!(
      !TipsState::of(&settings, now + HOUR).auto_due,
      "no second tip the day one was shown"
    );
    assert!(pin_inline_tip(&mut settings, "trash", MIDNIGHT + DAY));
    record_tip_seen(&mut settings, "trash", MIDNIGHT + DAY, &chrono::Utc);
    assert!(
      pin_inline_tip(&mut settings, "cookieBot", MIDNIGHT + 2 * DAY),
      "the released tip can come back"
    );

    let mut old = AppSettings::default();
    assert!(pin_inline_tip(&mut old, "cookieBot", MIDNIGHT));
    unpin_inline_tip(&mut old, "cookieBot", &chrono::Utc);
    assert!(
      TipsState::of(&old, MIDNIGHT + 3 * DAY).auto_due,
      "a tip shown days ago leaves room for a new one at once"
    );
  }

  #[test]
  fn turning_tips_off_takes_the_inline_tip_away() {
    let mut settings = AppSettings::default();
    let now = MIDNIGHT + 10 * HOUR;
    assert!(pin_inline_tip(&mut settings, "vpn", now));
    apply_tips_auto_show(&mut settings, false, now, &chrono::Utc);
    assert_eq!(settings.tips_inline, None);
    assert!(settings.tips_seen.is_empty(), "turned off is not read");
    assert!(
      !TipsState::of(&settings, 10 * DAY).auto_due,
      "switched off means never due"
    );
    assert!(!pin_inline_tip(&mut settings, "trash", 10 * DAY));
    apply_tips_auto_show(&mut settings, true, now + HOUR, &chrono::Utc);
    assert!(
      !TipsState::of(&settings, now + 2 * HOUR).auto_due,
      "off and on again brings no second tip the same day"
    );
    assert!(TipsState::of(&settings, MIDNIGHT + DAY).auto_due);
  }

  #[test]
  fn a_settings_save_keeps_the_stored_tips_state() {
    let mut stored = AppSettings::default();
    assert!(pin_inline_tip(&mut stored, "vpn", MIDNIGHT));
    record_tip_seen(&mut stored, "groups", MIDNIGHT, &chrono::Utc);
    note_feature_used(&mut stored, "commandPalette", MIDNIGHT, &chrono::Utc);
    assert!(paid_welcome_due(&mut stored, "u1", true, true));

    // The copy the Settings page loaded before any of that.
    let mut saved = AppSettings {
      theme: "dark".to_string(),
      ..AppSettings::default()
    };
    keep_tips_state(&mut saved, &stored);
    assert_eq!(saved.theme, "dark", "the page's own fields are its to save");
    assert_eq!(saved.tips_inline.as_deref(), Some("vpn"));
    assert_eq!(saved.tips_seen, vec!["groups".to_string()]);
    assert_eq!(saved.tips_used, vec!["commandPalette".to_string()]);
    assert_eq!(saved.tips_last_auto_shown_at, Some(MIDNIGHT));
    assert_eq!(saved.paid_welcome_seen_for, vec!["u1".to_string()]);
    assert!(
      !paid_welcome_due(&mut saved, "u1", true, true),
      "the welcome is not shown twice"
    );

    let mut off = stored.clone();
    off.tips_auto_show = false;
    off.tips_next_auto_show_at = Some(MIDNIGHT + DAY);
    keep_tips_state(&mut saved, &off);
    assert!(!saved.tips_auto_show);
    assert_eq!(saved.tips_next_auto_show_at, Some(MIDNIGHT + DAY));
  }

  #[test]
  fn settings_from_older_versions_keep_their_wait() {
    let settings: AppSettings =
      serde_json::from_str(r#"{ "tips_last_auto_shown_at": 1000 }"#).expect("old settings parse");
    assert_eq!(settings.tips_inline, None);
    assert!(settings.tips_used.is_empty());
    let state = TipsState::of(&settings, 1_000 + TIPS_INLINE_MIN_GAP_SECS - 1);
    assert_eq!(
      state.next_auto_show_at,
      Some(1_000 + TIPS_INLINE_MIN_GAP_SECS)
    );
    assert!(!state.auto_due);
    assert!(TipsState::of(&settings, 1_000 + TIPS_INLINE_MIN_GAP_SECS).auto_due);

    let drawn: AppSettings = serde_json::from_str(r#"{ "tips_next_auto_show_at": 500000 }"#)
      .expect("a wait from the old flow parses");
    assert!(
      !TipsState::of(&drawn, 499_999).auto_due,
      "a wait drawn by the old flow still holds"
    );
    assert!(TipsState::of(&drawn, 500_000).auto_due);
  }

  #[test]
  fn paid_welcome_is_due_once_when_an_account_turns_paid() {
    let mut settings = AppSettings::default();
    assert!(!paid_welcome_due(&mut settings, "u1", false, true));
    assert!(
      settings.paid_welcome_seen_for.is_empty(),
      "a free account is not greeted, so nothing is recorded"
    );
    assert!(
      paid_welcome_due(&mut settings, "u1", true, false),
      "free to paid is the upgrade the welcome exists for"
    );
    assert!(!paid_welcome_due(&mut settings, "u1", true, true), "once");
    assert_eq!(settings.paid_welcome_seen_for, vec!["u1".to_string()]);
  }

  #[test]
  fn paid_welcome_greets_a_fresh_sign_in_but_not_an_old_paid_session() {
    let mut settings = AppSettings::default();
    assert!(
      paid_welcome_due(&mut settings, "bought-on-web", true, true),
      "first sight right after signing in: they came back from checkout"
    );

    assert!(
      !paid_welcome_due(&mut settings, "long-paid", true, false),
      "an app update on a machine that was already paid is not a new plan"
    );
    assert!(
      !paid_welcome_due(&mut settings, "long-paid", true, true),
      "and it is recorded as greeted, so it never fires later"
    );
    assert_eq!(
      settings
        .cloud_plan_memory
        .get("long-paid")
        .map(String::as_str),
      Some(PLAN_STATUS_PAID)
    );
  }

  #[test]
  fn test_default_app_settings() {
    let default_settings = AppSettings::default();

    assert!(
      !default_settings.set_as_default_browser,
      "Default should not set as default browser"
    );
    assert_eq!(
      default_settings.theme, "system",
      "Default theme should be system"
    );
  }

  fn table_view(id: &str, name: &str) -> TableSavedView {
    TableSavedView {
      id: id.into(),
      name: name.into(),
      query: "tag:work".into(),
      filters: BTreeMap::from([("status".into(), vec!["running".into(), String::new()])]),
      sorting: vec![TableSort {
        id: "created_at".into(),
        desc: true,
      }],
      visibility: BTreeMap::from([("note".into(), false)]),
      column_order: vec!["name".into(), "tags".into()],
    }
  }

  #[test]
  fn table_preferences_from_an_older_file_get_empty_views() {
    let old = r#"{"visibility":{"note":false},"sizing":{"name":280.5},"sorting":[{"id":"name","desc":true}],"density":"comfortable"}"#;
    let preferences: TablePreferences = serde_json::from_str(old).unwrap();
    assert!(preferences.column_order.is_empty());
    assert!(preferences.views.is_empty());
    assert_eq!(preferences.default_view, None);
    assert!(table_preferences_valid("profiles", &preferences));
    assert_eq!(
      serde_json::to_value(&preferences).unwrap(),
      serde_json::from_str::<serde_json::Value>(old).unwrap(),
      "empty view fields stay out of the file"
    );
  }

  #[test]
  fn table_views_and_column_order_round_trip() {
    let preferences = TablePreferences {
      column_order: vec!["tags".into(), "name".into()],
      views: vec![table_view("view-1", "Work"), table_view("view_2", "Idle")],
      default_view: Some("view_2".into()),
      ..TablePreferences::default()
    };
    assert!(table_preferences_valid("proxies", &preferences));
    let json = serde_json::to_string(&preferences).unwrap();
    assert_eq!(
      serde_json::from_str::<TablePreferences>(&json).unwrap(),
      preferences
    );
    let partial: TableSavedView = serde_json::from_str(r#"{"id":"a","name":"Bare"}"#).unwrap();
    assert_eq!(partial.query, "");
    assert!(partial.filters.is_empty() && partial.sorting.is_empty());
    assert!(partial.visibility.is_empty() && partial.column_order.is_empty());
  }

  #[test]
  fn invalid_table_views_are_rejected() {
    let with = |change: &dyn Fn(&mut TablePreferences)| {
      let mut preferences = TablePreferences {
        views: vec![table_view("a", "One")],
        default_view: Some("a".into()),
        ..TablePreferences::default()
      };
      change(&mut preferences);
      table_preferences_valid("groups", &preferences)
    };
    assert!(with(&|_| {}));
    assert!(!with(&|p| p.default_view = Some("missing".into())));
    assert!(!with(&|p| p.views.push(table_view("a", "Twin"))));
    assert!(!with(&|p| p.views[0].name = "  ".into()));
    assert!(!with(&|p| p.views[0].name = "n".repeat(81)));
    assert!(!with(&|p| p.views[0].id = "../a".into()));
    assert!(!with(&|p| p.views[0].query = "q".repeat(1001)));
    assert!(!with(&|p| {
      p.views[0].filters.insert("bad-id".into(), vec!["x".into()]);
    }));
    assert!(!with(
      &|p| p.views[0].column_order = vec!["name".into(), "name".into()]
    ));
    assert!(!with(&|p| p.column_order = vec!["a b".into()]));
    assert!(!with(&|p| {
      p.views = (0..=TABLE_VIEW_LIMIT)
        .map(|i| table_view(&format!("v{i}"), "View"))
        .collect();
      p.default_view = None;
    }));
  }

  #[test]
  fn test_default_table_sorting_settings() {
    let default_sorting = TableSortingSettings::default();

    assert_eq!(
      default_sorting.column, "name",
      "Default sort column should be name"
    );
    assert_eq!(
      default_sorting.direction, "asc",
      "Default sort direction should be asc"
    );
  }

  #[test]
  fn test_load_settings_nonexistent_file() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    let result = manager.load_settings();
    assert!(
      result.is_ok(),
      "Should handle nonexistent settings file gracefully"
    );

    let settings = result.unwrap();
    assert!(
      !settings.set_as_default_browser,
      "Should return default settings"
    );
    assert_eq!(settings.theme, "system", "Should return default theme");
  }

  #[test]
  fn test_save_and_load_settings() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    let test_settings = AppSettings {
      set_as_default_browser: true,
      theme: "dark".to_string(),
      custom_theme: None,
      api_enabled: false,
      api_port: 10108,
      api_token: None,
      sync_server_url: None,
      account_sync_server_url: None,
      sync_source: None,
      first_launch_timestamp: None,
      commercial_trial_acknowledged: false,
      mcp_remote_enabled: false,
      mcp_remote_key: None,
      mcp_remote_key_id: None,
      language: None,
      window_resize_warning_dismissed: false,
      fingerprint_gate_disabled: false,
      vpn_extension_warning_disabled: false,
      onboarding_completed: false,
      disable_auto_updates: false,
      keep_decrypted_profiles_in_ram: false,
      tips_auto_show: true,
      tips_seen: Vec::new(),
      tips_last_auto_shown_at: None,
      tips_next_auto_show_at: None,
      tips_inline: None,
      tips_used: Vec::new(),
      feedback_sent_at: None,
      paid_welcome_seen_for: Vec::new(),
      cloud_plan_memory: std::collections::HashMap::new(),
      require_route_for_launch: true,
      trash_retention_days: 7,
      record_traffic_domains: false,
      ui_sounds: false,
      ui_sound_volume: 25,
      ui_sound_interface: false,
      ui_sound_feedback: true,
      ui_sound_events: false,
      ui_sound_pack: "retro".to_string(),
      mcp_toolsets: vec!["network".to_string()],
      bulk_launch_delay_ms: 800,
      bulk_launch_concurrency: 3,
      system_notifications: true,
      launch_at_login: false,
      reopen_running_profiles: false,
    };

    let save_result = manager.save_settings(&test_settings);
    assert!(save_result.is_ok(), "Should save settings successfully");

    let load_result = manager.load_settings();
    assert!(load_result.is_ok(), "Should load settings successfully");

    let loaded_settings = load_result.unwrap();
    assert!(
      loaded_settings.set_as_default_browser,
      "Loaded settings should match saved"
    );
    assert_eq!(
      loaded_settings.theme, "dark",
      "Loaded theme should match saved"
    );
    assert!(loaded_settings.require_route_for_launch);
    assert_eq!(loaded_settings.trash_retention_days, 7);
    assert!(!loaded_settings.record_traffic_domains);
    assert!(!loaded_settings.ui_sounds);
    assert_eq!(loaded_settings.ui_sound_volume, 25);
    assert!(!loaded_settings.ui_sound_interface);
    assert!(loaded_settings.ui_sound_feedback);
    assert!(!loaded_settings.ui_sound_events);
    assert_eq!(loaded_settings.ui_sound_pack, "retro");
  }

  #[test]
  fn settings_written_before_the_privacy_options_keep_the_old_behaviour() {
    let settings: AppSettings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
    assert!(!settings.require_route_for_launch);
    assert_eq!(settings.trash_retention_days, DEFAULT_TRASH_RETENTION_DAYS);
    assert!(settings.record_traffic_domains);
    assert!(settings.ui_sounds, "sounds are on until turned off");
    assert_eq!(settings.ui_sound_volume, DEFAULT_UI_SOUND_VOLUME);
    assert!(settings.ui_sound_interface);
    assert!(settings.ui_sound_feedback);
    assert!(settings.ui_sound_events);
    assert_eq!(settings.ui_sound_pack, DEFAULT_UI_SOUND_PACK);
  }

  #[test]
  fn default_sound_settings_match_a_missing_file() {
    let defaults = AppSettings::default();
    let parsed: AppSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(defaults.ui_sound_volume, 60);
    assert_eq!(defaults.ui_sound_pack, "soft");
    assert_eq!(parsed.ui_sound_volume, defaults.ui_sound_volume);
    assert_eq!(parsed.ui_sound_pack, defaults.ui_sound_pack);
    assert_eq!(parsed.ui_sound_interface, defaults.ui_sound_interface);
    assert_eq!(parsed.ui_sound_feedback, defaults.ui_sound_feedback);
    assert_eq!(parsed.ui_sound_events, defaults.ui_sound_events);
  }

  #[test]
  fn sound_volume_is_clamped_instead_of_resetting_the_settings() {
    let volume = |json: &str| {
      serde_json::from_str::<AppSettings>(json)
        .map(|settings| (settings.ui_sound_volume, settings.theme))
        .unwrap()
    };
    assert_eq!(
      volume(r#"{"theme":"dark","ui_sound_volume":250}"#),
      (100, "dark".to_string())
    );
    assert_eq!(
      volume(r#"{"theme":"dark","ui_sound_volume":-5}"#),
      (0, "dark".to_string())
    );
    assert_eq!(
      volume(r#"{"theme":"dark","ui_sound_volume":42.6}"#),
      (43, "dark".to_string())
    );
    let unknown: AppSettings = serde_json::from_str(r#"{"ui_sound_pack":"future"}"#).unwrap();
    assert_eq!(unknown.ui_sound_pack, "future", "an unknown pack is kept");
  }

  #[test]
  fn the_remote_key_round_trips_and_never_reaches_the_settings_json() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    assert!(manager.get_mcp_remote_key().unwrap().is_none());

    manager
      .store_mcp_remote_key("dmk_abcdefghijklmnop", "key-1")
      .unwrap();
    let stored = manager.get_mcp_remote_key().unwrap().expect("stored");
    assert_eq!(stored.key, "dmk_abcdefghijklmnop");
    assert_eq!(stored.id.as_deref(), Some("key-1"));

    // The id is bookkeeping and belongs in the JSON; the key is a credential
    // that works from anywhere on the internet and must not.
    let json = std::fs::read_to_string(manager.get_settings_file()).unwrap();
    assert!(json.contains("\"mcp_remote_key_id\": \"key-1\""), "{json}");
    assert!(!json.contains("dmk_abcdefghijklmnop"), "{json}");
    assert!(!json.contains("\"mcp_remote_key\""), "{json}");

    // A struct loaded for the frontend carries the plaintext (the fx export
    // line needs it), so the write path is what keeps it off the disk: saving
    // such a struct must not plant the key in the JSON.
    let mut settings = manager.load_settings().unwrap();
    settings.mcp_remote_key = Some("dmk_abcdefghijklmnop".to_string());
    manager.save_settings(&settings).unwrap();
    let json = std::fs::read_to_string(manager.get_settings_file()).unwrap();
    assert!(!json.contains("dmk_"), "{json}");
    assert!(!json.contains("\"mcp_remote_key\""), "{json}");
    assert_eq!(
      manager
        .load_settings()
        .unwrap()
        .mcp_remote_key_id
        .as_deref(),
      Some("key-1")
    );

    // Forgotten without a session, the key reads as gone and its id stays,
    // so the next mint can retire the key still live on the server.
    manager.drop_mcp_remote_key_plaintext().unwrap();
    assert!(manager.get_mcp_remote_key().unwrap().is_none());
    assert_eq!(
      manager
        .load_settings()
        .unwrap()
        .mcp_remote_key_id
        .as_deref(),
      Some("key-1")
    );

    manager.remove_mcp_remote_key().unwrap();
    assert!(manager.get_mcp_remote_key().unwrap().is_none());
    assert!(manager.load_settings().unwrap().mcp_remote_key_id.is_none());
  }

  #[test]
  fn a_key_file_without_an_id_still_yields_the_key() {
    // An interrupted store, or a settings file rewritten by an older build
    // that did not know the field: the credential is still on disk and still
    // valid, so it must still be usable. Only the id is missing, and the
    // rotation path treats a missing id as "nothing to revoke".
    let (manager, _temp_dir, _guard) = create_test_settings_manager();
    manager
      .store_mcp_remote_key("dmk_zzzzzzzzzzzz", "key-2")
      .unwrap();
    let mut settings = manager.load_settings().unwrap();
    settings.mcp_remote_key_id = None;
    manager.save_settings(&settings).unwrap();

    let stored = manager.get_mcp_remote_key().unwrap().expect("stored");
    assert_eq!(stored.key, "dmk_zzzzzzzzzzzz");
    assert!(stored.id.is_none());
  }

  #[test]
  fn test_load_table_sorting_nonexistent_file() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    let result = manager.load_table_sorting();
    assert!(
      result.is_ok(),
      "Should handle nonexistent sorting file gracefully"
    );

    let sorting = result.unwrap();
    assert_eq!(sorting.column, "name", "Should return default sorting");
    assert_eq!(sorting.direction, "asc", "Should return default direction");
  }

  #[test]
  fn test_save_and_load_table_sorting() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    let test_sorting = TableSortingSettings {
      column: "browser".to_string(),
      direction: "desc".to_string(),
    };

    let save_result = manager.save_table_sorting(&test_sorting);
    assert!(save_result.is_ok(), "Should save sorting successfully");

    let load_result = manager.load_table_sorting();
    assert!(load_result.is_ok(), "Should load sorting successfully");

    let loaded_sorting = load_result.unwrap();
    assert_eq!(
      loaded_sorting.column, "browser",
      "Loaded column should match saved"
    );
    assert_eq!(
      loaded_sorting.direction, "desc",
      "Loaded direction should match saved"
    );
  }

  #[test]
  fn test_load_corrupted_settings_file() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    let settings_dir = manager.get_settings_dir();
    fs::create_dir_all(&settings_dir).expect("Should create settings directory");

    let settings_file = manager.get_settings_file();
    fs::write(&settings_file, "{ invalid json }").expect("Should write corrupted file");

    let result = manager.load_settings();
    assert!(
      result.is_ok(),
      "Should handle corrupted settings file gracefully"
    );

    let settings = result.unwrap();
    assert!(
      !settings.set_as_default_browser,
      "Should return default settings for corrupted file"
    );
    assert_eq!(
      settings.theme, "system",
      "Should return default theme for corrupted file"
    );
  }

  #[test]
  fn test_settings_file_paths() {
    let (manager, _temp_dir, _guard) = create_test_settings_manager();

    let settings_dir = manager.get_settings_dir();
    let settings_file = manager.get_settings_file();
    let sorting_file = manager.get_table_sorting_file();

    assert!(
      settings_dir.to_string_lossy().contains("settings"),
      "Settings dir should contain 'settings'"
    );
    assert!(
      settings_file
        .to_string_lossy()
        .ends_with("app_settings.json"),
      "Settings file should end with app_settings.json"
    );
    assert!(
      sorting_file
        .to_string_lossy()
        .ends_with("table_sorting.json"),
      "Sorting file should end with table_sorting.json"
    );
  }

  fn write_log(dir: &Path, name: &str, body: &[u8], age_secs: u64) {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    let modified = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
    std::fs::File::options()
      .write(true)
      .open(&path)
      .unwrap()
      .set_modified(modified)
      .unwrap();
  }

  #[test]
  fn recent_logs_put_the_newest_file_last_and_redact_it() {
    let dir = TempDir::new().unwrap();
    write_log(dir.path(), "DonutBrowser_old.log", b"old line\n", 600);
    write_log(
      dir.path(),
      "DonutBrowser.log",
      b"new line user=me@example.com",
      0,
    );
    write_log(dir.path(), "notes.json", b"skipped", 0);

    let logs = recent_logs(dir.path(), 1024).unwrap();
    assert_eq!(
      logs,
      "===== DonutBrowser_old.log =====\nold line\n===== DonutBrowser.log =====\nnew line user=<redacted-email>\n"
    );
  }

  #[test]
  fn recent_logs_keep_whole_lines_within_the_budget() {
    let dir = TempDir::new().unwrap();
    let mut old = Vec::new();
    for i in 0..200 {
      old.extend_from_slice(format!("older é line {i}\n").as_bytes());
    }
    old.extend_from_slice(&[0xff, 0xfe, b'\n']);
    write_log(dir.path(), "a.log", &old, 600);
    write_log(dir.path(), "b.log", b"newest\n", 0);

    let logs = recent_logs(dir.path(), 400).unwrap();
    assert!(logs.len() <= 400, "{} bytes", logs.len());
    assert!(logs.ends_with("===== b.log =====\nnewest\n"), "{logs}");
    let older = logs
      .strip_prefix("===== a.log =====\n[…truncated — older content elided…]\n")
      .expect("the older file is cut, not dropped");
    assert!(older.lines().all(|line| line.starts_with("older é line ")
      || line == "\u{fffd}\u{fffd}"
      || line.starts_with("=====")
      || line == "newest"));
  }

  #[test]
  fn recent_logs_of_an_empty_directory_are_empty() {
    let dir = TempDir::new().unwrap();
    assert_eq!(recent_logs(dir.path(), 1024).unwrap(), "");
    assert!(recent_logs(&dir.path().join("missing"), 1024).is_err());
  }
}
