//! In-memory storage for ephemeral and password-protected profiles on Windows.
//!
//! Windows has no tmpfs, and the RAM disk drivers that exist need admin rights.
//! WinFsp, when the person has installed it, lets an ordinary user mount a
//! file system served by a process: `donut-proxy ramfs` serves one that keeps
//! every byte in its own memory. It is a separate process because a browser
//! can outlive the app, and its profile must stay readable until it exits.

pub mod state;
pub mod tree;

#[cfg(windows)]
mod host;
#[cfg(windows)]
mod winfsp_fs;

pub use state::VolumeState;

const MIN_CAPACITY: u64 = 512 << 20;
const MAX_CAPACITY: u64 = 4 << 30;

/// A quarter of the RAM, between 512 MiB and 4 GiB.
pub fn volume_capacity(total_ram: u64) -> u64 {
  (total_ram / 4).clamp(MIN_CAPACITY, MAX_CAPACITY)
}

/// Why the volume cannot be used, or `Ok` when WinFsp is ready.
pub fn winfsp_available() -> Result<(), String> {
  #[cfg(windows)]
  {
    host::load().map_err(|e| e.to_string())
  }
  #[cfg(not(windows))]
  {
    Err("winfsp is for windows only".to_string())
  }
}

/// What the ephemeral-storage notice shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
  InMemory,
  WinfspMissing,
  WinfspError,
}

/// Whether the volume at `mount` holds the copy of a password-protected
/// profile. Its changes wait there for the next unlock to seal them. A copy
/// whose profile is gone is not counted; one whose metadata cannot be read is.
#[cfg_attr(not(windows), allow(dead_code))]
fn holds_protected_copy(mount: &std::path::Path, profiles: &std::path::Path) -> bool {
  let Ok(entries) = std::fs::read_dir(mount) else {
    return false;
  };
  entries.flatten().any(|entry| {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if uuid::Uuid::parse_str(&name).is_err() {
      return false;
    }
    match std::fs::read(profiles.join(&*name).join("metadata.json")) {
      Err(e) => e.kind() != std::io::ErrorKind::NotFound,
      Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .is_none_or(|metadata| {
          metadata
            .get("password_protected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        }),
    }
  })
}

/// The mutex that a Donut using the volume at `mount` holds until it exits.
/// Windows closes it with the process, however the process ends.
#[cfg(windows)]
fn owner_mutex_name(mount: &std::path::Path) -> Vec<u16> {
  use sha2::{Digest, Sha256};
  let digest = Sha256::digest(mount.to_string_lossy().to_lowercase().as_bytes());
  let tag: String = digest[..8]
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
  format!("Local\\DonutRamVolume-{tag}")
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect()
}

/// Mark this process as a user of the volume at `mount` until it exits.
#[cfg(windows)]
fn claim_owner(mount: &std::path::Path) {
  use std::sync::{Mutex, PoisonError};
  use windows::core::PCWSTR;
  use windows::Win32::System::Threading::CreateMutexW;
  static CLAIMED: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());
  let mut claimed = CLAIMED.lock().unwrap_or_else(PoisonError::into_inner);
  if claimed.iter().any(|path| path == mount) {
    return;
  }
  let name = owner_mutex_name(mount);
  // The handle stays open on purpose, for the life of the process.
  match unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) } {
    Ok(_) => claimed.push(mount.to_path_buf()),
    Err(e) => log::warn!(
      "Ram volume owner mark failed mount={} err=\"{e}\"",
      mount.display()
    ),
  }
}

/// Whether a Donut that uses the volume at `mount` still runs. Only a missing
/// mutex says no.
#[cfg(windows)]
fn owner_runs(mount: &std::path::Path) -> bool {
  use windows::core::PCWSTR;
  use windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND};
  use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
  let name = owner_mutex_name(mount);
  match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) } {
    Ok(handle) => {
      let _ = unsafe { CloseHandle(handle) };
      true
    }
    Err(e) => e.code() != ERROR_FILE_NOT_FOUND.to_hresult(),
  }
}

/// `donut-proxy ramfs`: mount the volume and serve it while it is used.
pub fn host_main(mount: &std::path::Path, capacity: u64, state_file: &std::path::Path) -> i32 {
  #[cfg(windows)]
  {
    host::host_main(mount, capacity, state_file)
  }
  #[cfg(not(windows))]
  {
    log::error!(
      "Ram volume mount failed mount={} capacity_mb={} state={} err=\"windows only\"",
      mount.display(),
      capacity >> 20,
      state_file.display()
    );
    2
  }
}

#[cfg(windows)]
pub use windows_client::{ensure_volume, live_volume, status, stop_host};

#[cfg(windows)]
mod windows_client {
  use std::path::{Path, PathBuf};
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::{Mutex, PoisonError};
  use std::time::{Duration, Instant};

  use super::host::{self, Unavailable};
  use super::{volume_capacity, Status, VolumeState};

  const MOUNT_WAIT: Duration = Duration::from_secs(10);
  const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

  /// Set when WinFsp loaded but the last start of the volume failed.
  static LAST_START_FAILED: AtomicBool = AtomicBool::new(false);

  fn mount_dir() -> PathBuf {
    crate::app_dirs::data_dir().join("ephemeral-ram")
  }

  fn state_path() -> PathBuf {
    crate::app_dirs::data_dir().join("ephemeral-ram.json")
  }

  fn log_path() -> PathBuf {
    std::env::temp_dir().join("donut-ramfs.log")
  }

  fn host_alive(pid: u32) -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = crate::proxy_storage::process_table(sysinfo::RefreshKind::nothing());
    system.refresh_processes_specifics(
      ProcessesToUpdate::Some(&[pid]),
      true,
      ProcessRefreshKind::nothing(),
    );
    system.process(pid).is_some_and(|process| {
      crate::proxy_storage::snapshot_process_is_alive(process)
        && process
          .name()
          .to_string_lossy()
          .to_ascii_lowercase()
          .starts_with("donut-proxy")
    })
  }

  /// A live mount point is a junction into the volume, and it lists.
  fn mount_answers(mount: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(mount)
      .is_ok_and(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
      && std::fs::read_dir(mount).is_ok()
  }

  /// The volume of this data directory, when its host runs and it answers.
  /// The app that finds it keeps it until the app exits.
  pub fn live_volume() -> Option<VolumeState> {
    let state = VolumeState::read(&state_path())?;
    let live = state.mount == mount_dir() && host_alive(state.pid) && mount_answers(&state.mount);
    if live {
      super::claim_owner(&state.mount);
    }
    live.then_some(state)
  }

  pub fn status() -> Status {
    match host::load() {
      Err(Unavailable::Missing) => Status::WinfspMissing,
      Err(Unavailable::Broken(_)) => Status::WinfspError,
      Ok(()) if LAST_START_FAILED.load(Ordering::Relaxed) => Status::WinfspError,
      Ok(()) => Status::InMemory,
    }
  }

  /// The mounted volume's path, starting its host when no live one exists.
  pub fn ensure_volume() -> Result<PathBuf, String> {
    static STARTING: Mutex<()> = Mutex::new(());
    let _starting = STARTING.lock().unwrap_or_else(PoisonError::into_inner);
    host::load().map_err(|e| e.to_string())?;
    if live_volume().is_some() {
      LAST_START_FAILED.store(false, Ordering::Relaxed);
      return Ok(mount_dir());
    }
    let started = start_host();
    LAST_START_FAILED.store(started.is_err(), Ordering::Relaxed);
    started
  }

  fn start_host() -> Result<PathBuf, String> {
    let started = Instant::now();
    let mount = mount_dir();
    // Before the host first looks for its owner.
    super::claim_owner(&mount);
    let (mut child, capacity) = spawn_host(&mount)?;
    let pid = child.id();

    loop {
      if live_volume().is_some_and(|state| state.pid == pid) {
        log::info!(
          "Ram volume host started pid={pid} mount={} capacity_mb={} elapsed_ms={}",
          mount.display(),
          capacity >> 20,
          started.elapsed().as_millis()
        );
        return Ok(mount);
      }
      if let Ok(Some(status)) = child.try_wait() {
        return Err(format!(
          "ramfs host exited ({status}) log={}",
          log_path().display()
        ));
      }
      if started.elapsed() > MOUNT_WAIT {
        let _ = child.kill();
        return Err(format!(
          "ramfs host did not mount in {}s log={}",
          MOUNT_WAIT.as_secs(),
          log_path().display()
        ));
      }
      std::thread::sleep(Duration::from_millis(100));
    }
  }

  /// Start `donut-proxy ramfs` for `mount`, and return it with its capacity.
  fn spawn_host(mount: &Path) -> Result<(std::process::Child, u64), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let capacity = {
      let mut system = crate::proxy_storage::process_table(sysinfo::RefreshKind::nothing());
      system.refresh_memory();
      volume_capacity(system.total_memory())
    };
    let exe = crate::proxy_runner::find_sidecar_executable("donut-proxy")
      .map_err(|e| format!("donut-proxy not found: {e}"))?;
    let log =
      crate::app_dirs::create_owner_only(&log_path()).map_or_else(|_| Stdio::null(), Stdio::from);
    let child = Command::new(exe)
      .arg("ramfs")
      .arg("--mount")
      .arg(mount)
      .arg("--capacity")
      .arg(capacity.to_string())
      .arg("--state")
      .arg(state_path())
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(log)
      .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
      .spawn()
      .map_err(|e| format!("ramfs host spawn: {e}"))?;
    Ok((child, capacity))
  }

  /// End the host, which unmounts the volume and frees its memory. Not waited
  /// for, because this runs at exit.
  pub fn stop_host(pid: u32, reason: &str) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let stopped = unsafe {
      OpenProcess(PROCESS_TERMINATE, false, pid).and_then(|process| {
        let result = TerminateProcess(process, 0);
        let _ = CloseHandle(process);
        result
      })
    };
    match stopped {
      Ok(()) => {
        let _ = std::fs::remove_file(state_path());
        log::info!("Ram volume host stopped pid={pid} reason={reason}");
      }
      Err(e) => log::warn!("Ram volume host stop failed pid={pid} reason={reason} err=\"{e}\""),
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn a_missing_winfsp_is_reported_and_never_called() {
      match host::load() {
        Ok(()) => assert_ne!(status(), Status::WinfspMissing),
        Err(Unavailable::Missing) => {
          assert_eq!(status(), Status::WinfspMissing);
          assert_eq!(ensure_volume(), Err("winfsp not installed".to_string()));
        }
        Err(Unavailable::Broken(e)) => panic!("{e}"),
      }
    }

    /// Run after installing WinFsp and building the sidecar:
    /// `cargo build --bin donut-proxy`, then
    /// `cargo test --lib ramfs::windows_client -- --ignored --nocapture`
    #[test]
    #[ignore = "needs WinFsp installed and a built donut-proxy"]
    fn the_sidecar_host_serves_a_volume_until_stopped() {
      let data = tempfile::tempdir().unwrap();
      let _data = crate::app_dirs::set_test_data_dir(data.path().to_path_buf());
      let mount = ensure_volume().unwrap();
      assert_eq!(mount, data.path().join("ephemeral-ram"));
      assert_eq!(status(), Status::InMemory);
      std::fs::write(mount.join("probe"), b"x").unwrap();

      let volume = live_volume().unwrap();
      assert_eq!(ensure_volume().unwrap(), mount);
      assert_eq!(live_volume().unwrap().pid, volume.pid);
      assert_eq!(std::fs::read(mount.join("probe")).unwrap(), b"x");

      stop_host(volume.pid, "test");
      let deadline = Instant::now() + Duration::from_secs(5);
      while live_volume().is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
      }
      assert!(live_volume().is_none());
      assert!(!mount.join("probe").exists());
    }

    /// A host no app has claimed, as after the app that started it quit.
    fn spawn_unclaimed_host() -> PathBuf {
      let mount = mount_dir();
      let (child, _) = spawn_host(&mount).unwrap();
      let deadline = Instant::now() + MOUNT_WAIT;
      while !(VolumeState::read(&state_path()).is_some_and(|state| state.pid == child.id())
        && mount_answers(&mount))
      {
        assert!(Instant::now() < deadline, "the host did not mount");
        std::thread::sleep(Duration::from_millis(100));
      }
      mount
    }

    fn wait_for_exit(pid: u32, within: Duration) -> bool {
      let deadline = Instant::now() + within;
      while host_alive(pid) {
        if Instant::now() > deadline {
          return false;
        }
        std::thread::sleep(Duration::from_millis(100));
      }
      true
    }

    /// The host of a volume no Donut claims, as after the app quit or
    /// crashed: it stays while a file is open or a protected copy waits, and
    /// ends by itself after that. Run like the test above.
    #[test]
    #[ignore = "needs WinFsp installed and a built donut-proxy"]
    fn a_host_nothing_uses_ends_itself() {
      let data = tempfile::tempdir().unwrap();
      let _data = crate::app_dirs::set_test_data_dir(data.path().to_path_buf());
      std::env::set_var("DONUT_PROXY_WATCHDOG_INTERVAL_MS", "200");
      let mount = spawn_unclaimed_host();
      let pid = VolumeState::read(&state_path()).unwrap().pid;

      let open = std::fs::File::create(mount.join("held")).unwrap();
      assert!(
        !wait_for_exit(pid, Duration::from_secs(2)),
        "an open file keeps the host"
      );
      drop(open);

      let profile = "8c67a11e-17d2-4d31-b178-4c19b28e1e48";
      let metadata = data
        .path()
        .join("profiles")
        .join(profile)
        .join("metadata.json");
      std::fs::create_dir_all(metadata.parent().unwrap()).unwrap();
      std::fs::write(&metadata, br#"{"password_protected":true}"#).unwrap();
      std::fs::create_dir(mount.join(profile)).unwrap();
      assert!(
        !wait_for_exit(pid, Duration::from_secs(2)),
        "a protected copy keeps the host"
      );

      std::fs::write(&metadata, br#"{"password_protected":false}"#).unwrap();
      assert!(
        wait_for_exit(pid, Duration::from_secs(5)),
        "the unused host must end"
      );
      assert!(!state_path().exists());
    }

    /// A volume the running app uses stays, however idle.
    #[test]
    #[ignore = "needs WinFsp installed and a built donut-proxy"]
    fn a_claimed_host_stays_while_its_app_runs() {
      let data = tempfile::tempdir().unwrap();
      let _data = crate::app_dirs::set_test_data_dir(data.path().to_path_buf());
      std::env::set_var("DONUT_PROXY_WATCHDOG_INTERVAL_MS", "200");
      ensure_volume().unwrap();
      let pid = live_volume().unwrap().pid;
      assert!(!wait_for_exit(pid, Duration::from_secs(2)));
      stop_host(pid, "test");
      assert!(wait_for_exit(pid, Duration::from_secs(5)));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn capacity_is_a_quarter_of_ram_within_bounds() {
    assert_eq!(volume_capacity(1 << 30), MIN_CAPACITY);
    assert_eq!(volume_capacity(8 << 30), 2 << 30);
    assert_eq!(volume_capacity(64 << 30), MAX_CAPACITY);
    assert_eq!(volume_capacity(0), MIN_CAPACITY);
  }

  #[test]
  fn only_a_protected_profile_copy_holds_the_volume() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("ephemeral-ram");
    let profiles = dir.path().join("profiles");
    std::fs::create_dir_all(mount.join("not-a-profile")).unwrap();
    assert!(!holds_protected_copy(&mount, &profiles));
    assert!(!holds_protected_copy(
      &dir.path().join("missing"),
      &profiles
    ));

    let write = |id: &str, metadata: &[u8]| {
      std::fs::create_dir_all(mount.join(id)).unwrap();
      std::fs::create_dir_all(profiles.join(id)).unwrap();
      std::fs::write(profiles.join(id).join("metadata.json"), metadata).unwrap();
    };
    let gone = "11111111-1111-4111-8111-111111111111";
    std::fs::create_dir_all(mount.join(gone)).unwrap();
    assert!(
      !holds_protected_copy(&mount, &profiles),
      "a deleted profile's copy"
    );

    let plain = "22222222-2222-4222-8222-222222222222";
    write(plain, br#"{"name":"x","password_protected":false}"#);
    write("33333333-3333-4333-8333-333333333333", br#"{"name":"y"}"#);
    assert!(!holds_protected_copy(&mount, &profiles));

    write(plain, b"{");
    assert!(
      holds_protected_copy(&mount, &profiles),
      "unreadable metadata"
    );

    write(plain, br#"{"password_protected":true}"#);
    assert!(holds_protected_copy(&mount, &profiles));
  }

  #[cfg(not(windows))]
  #[test]
  fn other_systems_have_no_volume_host() {
    assert!(winfsp_available().is_err());
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
      host_main(&dir.path().join("m"), MIN_CAPACITY, &dir.path().join("s")),
      2
    );
  }
}
