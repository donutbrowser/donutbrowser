//! The tray icon and its menu: the running profiles, the recent ones, stop
//! all, show and quit.
//!
//! The menu acts through the frontend: an item emits `tray-action`, and the
//! page runs its own launch, stop and open code. The menu is built again when a
//! profile starts, stops or changes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Wry};

const RECENT_LIMIT: usize = 5;
/// A menu longer than this no longer fits on a laptop screen.
const RUNNING_LIMIT: usize = 25;
const NAME_CHARS: usize = 40;
/// A bulk launch changes many profiles at once; the menu is built once after.
const REBUILD_DELAY: Duration = Duration::from_millis(400);

#[cfg(not(feature = "e2e"))]
pub(crate) const TRAY_ACTION_EVENT: &str = "tray-action";

static REBUILD_PENDING: AtomicBool = AtomicBool::new(false);
/// The Show and Quit labels the frontend pushed, which win over the table.
static PUSHED_LABELS: Mutex<Option<(String, String)>> = Mutex::new(None);
static REBUILD: crate::log_streak::Streak =
  crate::log_streak::Streak::new(module_path!(), "Tray menu rebuild");

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Labels {
  pub show: &'static str,
  pub quit: &'static str,
  pub running: &'static str,
  pub recent: &'static str,
  pub stop_all: &'static str,
  pub stop: &'static str,
  pub open_details: &'static str,
}

/// The menu's words in one of the app's languages; English for any other.
pub(crate) fn labels_for(language: &str) -> Labels {
  let code = language
    .split(['-', '_'])
    .next()
    .unwrap_or("en")
    .to_ascii_lowercase();
  let (show, quit, running, recent, stop_all, stop, open_details) = match code.as_str() {
    "de" => (
      "Donut Browser anzeigen",
      "Beenden",
      "Laufend",
      "Zuletzt verwendet",
      "Alle laufenden stoppen",
      "Stoppen",
      "Details öffnen",
    ),
    "es" => (
      "Mostrar Donut Browser",
      "Salir",
      "En ejecución",
      "Recientes",
      "Detener todos",
      "Detener",
      "Abrir detalles",
    ),
    "fr" => (
      "Afficher Donut Browser",
      "Quitter",
      "En cours",
      "Récents",
      "Tout arrêter",
      "Arrêter",
      "Ouvrir les détails",
    ),
    "ja" => (
      "Donut Browser を表示",
      "終了",
      "実行中",
      "最近使用",
      "実行中をすべて停止",
      "停止",
      "詳細を開く",
    ),
    "ko" => (
      "Donut Browser 표시",
      "종료",
      "실행 중",
      "최근 항목",
      "실행 중인 항목 모두 중지",
      "중지",
      "세부 정보 열기",
    ),
    "pt" => (
      "Mostrar Donut Browser",
      "Sair",
      "Em execução",
      "Recentes",
      "Parar todos",
      "Parar",
      "Abrir detalhes",
    ),
    "ru" => (
      "Показать Donut Browser",
      "Выход",
      "Запущенные",
      "Недавние",
      "Остановить все",
      "Остановить",
      "Открыть сведения",
    ),
    "tr" => (
      "Donut Browser'ı Göster",
      "Çık",
      "Çalışanlar",
      "Son kullanılanlar",
      "Tümünü durdur",
      "Durdur",
      "Ayrıntıları aç",
    ),
    "vi" => (
      "Hiển thị Donut Browser",
      "Thoát",
      "Đang chạy",
      "Gần đây",
      "Dừng tất cả",
      "Dừng",
      "Mở chi tiết",
    ),
    "zh" => (
      "显示 Donut Browser",
      "退出",
      "运行中",
      "最近使用",
      "全部停止",
      "停止",
      "打开详情",
    ),
    _ => (
      "Show Donut Browser",
      "Quit",
      "Running",
      "Recent",
      "Stop all running",
      "Stop",
      "Open details",
    ),
  };
  Labels {
    show,
    quit,
    running,
    recent,
    stop_all,
    stop,
    open_details,
  }
}

fn app_language() -> String {
  crate::settings_manager::SettingsManager::instance()
    .load_settings()
    .ok()
    .and_then(|settings| settings.language)
    .unwrap_or_else(crate::settings_manager::get_system_language)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MenuProfile {
  pub id: String,
  pub name: String,
}

/// What the menu lists.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct MenuState {
  pub running: Vec<MenuProfile>,
  pub recent: Vec<MenuProfile>,
}

/// The running profiles by name, and the most recently launched of the rest.
/// A profile bound to another OS cannot launch here and is not offered.
pub(crate) fn menu_state(
  profiles: &[crate::profile::BrowserProfile],
  is_running: impl Fn(&crate::profile::BrowserProfile) -> bool,
) -> MenuState {
  let entry = |profile: &crate::profile::BrowserProfile| MenuProfile {
    id: profile.id.to_string(),
    name: profile.name.clone(),
  };
  let (running, idle): (Vec<_>, Vec<_>) = profiles.iter().partition(|p| is_running(p));
  let mut running: Vec<MenuProfile> = running.into_iter().map(entry).collect();
  running.sort_by_key(|p| p.name.to_lowercase());
  running.truncate(RUNNING_LIMIT);

  let mut recent: Vec<_> = idle
    .into_iter()
    .filter(|p| p.last_launch.is_some() && !p.is_cross_os())
    .collect();
  recent.sort_by_key(|p| std::cmp::Reverse(p.last_launch));
  MenuState {
    running,
    recent: recent.into_iter().take(RECENT_LIMIT).map(entry).collect(),
  }
}

fn current_state() -> MenuState {
  let profiles = crate::profile::ProfileManager::instance()
    .list_profiles()
    .unwrap_or_default();
  menu_state(&profiles, |profile| {
    profile
      .process_id
      .is_some_and(crate::proxy_storage::is_process_running)
  })
}

/// A profile name as a menu item shows it: one line, not too long, and on
/// Windows with `&` kept literal instead of read as a mnemonic.
fn item_text(name: &str) -> String {
  let line: String = name.split_whitespace().collect::<Vec<_>>().join(" ");
  let mut text: String = line.chars().take(NAME_CHARS).collect();
  if line.chars().count() > NAME_CHARS {
    text.push('…');
  }
  if cfg!(target_os = "windows") {
    text = text.replace('&', "&&");
  }
  text
}

fn build_menu(app: &AppHandle, state: &MenuState) -> tauri::Result<Menu<Wry>> {
  let labels = labels_for(&app_language());
  let pushed = PUSHED_LABELS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .clone();
  let (show_label, quit_label) =
    pushed.unwrap_or_else(|| (labels.show.to_string(), labels.quit.to_string()));

  let mut menu = MenuBuilder::new(app);
  if !state.running.is_empty() {
    let mut running =
      SubmenuBuilder::new(app, format!("{} ({})", labels.running, state.running.len()));
    for profile in &state.running {
      let submenu = SubmenuBuilder::new(app, item_text(&profile.name))
        .item(
          &MenuItemBuilder::with_id(format!("tray_stop:{}", profile.id), labels.stop).build(app)?,
        )
        .item(
          &MenuItemBuilder::with_id(format!("tray_open:{}", profile.id), labels.open_details)
            .build(app)?,
        )
        .build()?;
      running = running.item(&submenu);
    }
    menu = menu.item(&running.build()?);
  }
  if !state.recent.is_empty() {
    let mut recent = SubmenuBuilder::new(app, labels.recent);
    for profile in &state.recent {
      let item = MenuItemBuilder::with_id(
        format!("tray_launch:{}", profile.id),
        item_text(&profile.name),
      )
      .build(app)?;
      recent = recent.item(&item);
    }
    menu = menu.item(&recent.build()?);
  }
  let stop_all = MenuItemBuilder::with_id("tray_stop_all", labels.stop_all)
    .enabled(!state.running.is_empty())
    .build(app)?;
  let show = MenuItemBuilder::with_id("tray_show", show_label).build(app)?;
  let quit = MenuItemBuilder::with_id("tray_quit", quit_label).build(app)?;
  menu
    .item(&stop_all)
    .separator()
    .item(&show)
    .separator()
    .item(&quit)
    .build()
}

fn rebuild(app: &AppHandle, state: &MenuState) -> tauri::Result<()> {
  let Some(tray) = app.tray_by_id("main") else {
    return Ok(());
  };
  tray.set_menu(Some(build_menu(app, state)?))
}

/// Build the menu again shortly, once for a burst of changes.
pub(crate) fn schedule_rebuild(app: &AppHandle) {
  if REBUILD_PENDING.swap(true, Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(REBUILD_DELAY).await;
    REBUILD_PENDING.store(false, Ordering::SeqCst);
    let state = tauri::async_runtime::spawn_blocking(current_state)
      .await
      .unwrap_or_default();
    match rebuild(&app, &state) {
      Ok(()) => REBUILD.succeeded(),
      Err(e) => REBUILD.failed(e),
    }
  });
}

#[cfg(not(feature = "e2e"))]
pub(crate) fn show_main_window(app: &AppHandle) {
  use tauri::Manager;
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

#[cfg(not(feature = "e2e"))]
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub(crate) struct TrayAction {
  pub action: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub profile_id: Option<String>,
}

/// The action a menu item id stands for. `None` for Quit and unknown ids.
#[cfg(not(feature = "e2e"))]
pub(crate) fn action_for(id: &str) -> Option<TrayAction> {
  let with_profile = |action: &'static str, profile_id: &str| {
    uuid::Uuid::parse_str(profile_id).ok().map(|_| TrayAction {
      action,
      profile_id: Some(profile_id.to_string()),
    })
  };
  match id {
    "tray_show" => Some(TrayAction {
      action: "show",
      profile_id: None,
    }),
    "tray_stop_all" => Some(TrayAction {
      action: "stop-all",
      profile_id: None,
    }),
    _ => {
      if let Some(profile_id) = id.strip_prefix("tray_stop:") {
        with_profile("stop-profile", profile_id)
      } else if let Some(profile_id) = id.strip_prefix("tray_open:") {
        with_profile("open-profile", profile_id)
      } else if let Some(profile_id) = id.strip_prefix("tray_launch:") {
        with_profile("launch-profile", profile_id)
      } else {
        None
      }
    }
  }
}

/// Whether the person has to see the window for this action: a launch that
/// first asks for the profile's password does.
#[cfg(not(feature = "e2e"))]
fn needs_window(action: &TrayAction) -> bool {
  match action.action {
    "show" | "open-profile" => true,
    "launch-profile" => action.profile_id.as_deref().is_some_and(|id| {
      crate::profile::ProfileManager::instance()
        .list_profiles()
        .unwrap_or_default()
        .iter()
        .any(|p| p.id.to_string() == id && p.password_protected)
    }),
    _ => false,
  }
}

#[cfg(not(feature = "e2e"))]
fn on_menu_event(app: &AppHandle, id: &str) {
  use tauri::Emitter;
  if id == "tray_quit" {
    crate::QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
    return;
  }
  let Some(action) = action_for(id) else {
    return;
  };
  if needs_window(&action) {
    show_main_window(app);
  }
  log::debug!(
    "Tray action action={} profile={}",
    action.action,
    action.profile_id.as_deref().unwrap_or("-")
  );
  if let Err(e) = app.emit(TRAY_ACTION_EVENT, &action) {
    log::warn!("Emit tray-action failed err=\"{e}\"");
  }
}

/// Keep the frontend's Show and Quit labels and build the menu again; the
/// frontend calls this on mount and when the language changes.
#[tauri::command]
pub fn update_tray_menu(
  app_handle: AppHandle,
  show_label: String,
  quit_label: String,
) -> Result<(), String> {
  *PUSHED_LABELS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((show_label, quit_label));
  schedule_rebuild(&app_handle);
  Ok(())
}

/// Build the system tray. Best-effort: on Linux the tray depends on
/// libayatana-appindicator at runtime, so the caller logs a failure and goes
/// on without a tray.
#[cfg(not(feature = "e2e"))]
pub(crate) fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
  use tauri::Listener;

  // Show and Quit at once; the profiles are read off the main thread below.
  let menu = build_menu(app, &MenuState::default())?;

  // macOS uses the black icon as a template — the OS tints it for the light or
  // dark menu bar. Linux (and other non-Windows desktops) get a white-bodied
  // icon with a dark outline so it stays legible on both dark and light
  // panels: Tauri feeds the SNI/AppIndicator a fixed pixmap with no template
  // tinting, so the icon has to carry its own contrast (a solid black icon is
  // invisible on GNOME's dark top bar). Windows keeps its own solid icon.
  #[cfg(target_os = "macos")]
  let tray_icon_bytes: &[u8] = include_bytes!("../icons/tray-icon-44.png");
  #[cfg(target_os = "windows")]
  let tray_icon_bytes: &[u8] = include_bytes!("../icons/tray-icon-win-44.png");
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  let tray_icon_bytes: &[u8] = include_bytes!("../icons/tray-icon-linux-44.png");
  let tray_rgba = image::load_from_memory(tray_icon_bytes)?.into_rgba8();
  let (tray_w, tray_h) = tray_rgba.dimensions();
  let tray_image = tauri::image::Image::new_owned(tray_rgba.into_raw(), tray_w, tray_h);

  TrayIconBuilder::with_id("main")
    .icon(tray_image)
    .icon_as_template(cfg!(target_os = "macos"))
    .tooltip("Donut Browser")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app_handle, event| on_menu_event(app_handle, event.id().as_ref()))
    .on_tray_icon_event(|tray, event| {
      // Click events are not delivered on Linux (AppIndicator/SNI only drives
      // the menu), so left-click-to-restore is macOS/Windows only — Linux users
      // restore via the "Show Donut Browser" menu item.
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        show_main_window(tray.app_handle());
      }
    })
    .build(app)?;

  for event in [
    "profile-running-changed",
    "profiles-changed",
    "profile-updated",
  ] {
    let handle = app.clone();
    app.listen_any(event, move |_| schedule_rebuild(&handle));
  }
  schedule_rebuild(app);

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::profile::BrowserProfile;

  fn profile(name: &str, last_launch: Option<u64>) -> BrowserProfile {
    BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: name.to_string(),
      last_launch,
      ..Default::default()
    }
  }

  #[test]
  fn every_app_language_has_its_own_words_and_others_get_english() {
    let english = labels_for("en");
    for code in ["de", "es", "fr", "ja", "ko", "pt", "ru", "tr", "vi", "zh"] {
      assert_ne!(labels_for(code).running, english.running, "{code}");
    }
    assert_eq!(labels_for("pt-BR"), labels_for("pt"));
    assert_eq!(labels_for("xx"), english);
  }

  #[test]
  fn running_profiles_sort_by_name_and_recent_ones_by_last_launch() {
    let profiles = vec![
      profile("beta", Some(10)),
      profile("Alpha", Some(30)),
      profile("never", None),
      profile("old", Some(1)),
      profile("new", Some(50)),
    ];
    let running_ids = [profiles[0].id, profiles[1].id];
    let state = menu_state(&profiles, |p| running_ids.contains(&p.id));
    let names = |list: &[MenuProfile]| list.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&state.running), ["Alpha", "beta"]);
    assert_eq!(names(&state.recent), ["new", "old"]);
  }

  #[test]
  fn recent_keeps_the_five_latest() {
    let profiles: Vec<_> = (0..8).map(|n| profile(&format!("p{n}"), Some(n))).collect();
    let state = menu_state(&profiles, |_| false);
    let names: Vec<_> = state.recent.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["p7", "p6", "p5", "p4", "p3"]);
  }

  #[cfg(not(feature = "e2e"))]
  #[test]
  fn menu_ids_map_to_the_actions_of_the_contract() {
    let id = uuid::Uuid::new_v4().to_string();
    let action = |item: &str| action_for(item).map(|a| (a.action, a.profile_id));
    assert_eq!(action("tray_show"), Some(("show", None)));
    assert_eq!(action("tray_stop_all"), Some(("stop-all", None)));
    assert_eq!(
      action(&format!("tray_stop:{id}")),
      Some(("stop-profile", Some(id.clone())))
    );
    assert_eq!(
      action(&format!("tray_open:{id}")),
      Some(("open-profile", Some(id.clone())))
    );
    assert_eq!(
      action(&format!("tray_launch:{id}")),
      Some(("launch-profile", Some(id)))
    );
    assert_eq!(action("tray_launch:../x"), None);
    assert_eq!(action("tray_quit"), None);
  }

  #[test]
  fn a_long_name_becomes_one_short_line() {
    let text = item_text(&format!("a\nb {}", "x".repeat(80)));
    assert!(!text.contains('\n'));
    assert_eq!(text.chars().count(), NAME_CHARS + 1);
  }
}
