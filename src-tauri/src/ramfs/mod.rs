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

/// `donut-proxy ramfs`: mount the volume and serve it until killed.
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
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = System::new();
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
  pub fn live_volume() -> Option<VolumeState> {
    let state = VolumeState::read(&state_path())?;
    (state.mount == mount_dir() && host_alive(state.pid) && mount_answers(&state.mount))
      .then_some(state)
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
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let started = Instant::now();
    let mount = mount_dir();
    let capacity = {
      let mut system = sysinfo::System::new();
      system.refresh_memory();
      volume_capacity(system.total_memory())
    };
    let exe = crate::proxy_runner::find_sidecar_executable("donut-proxy")
      .map_err(|e| format!("donut-proxy not found: {e}"))?;
    let log =
      crate::app_dirs::create_owner_only(&log_path()).map_or_else(|_| Stdio::null(), Stdio::from);
    let mut child = Command::new(exe)
      .arg("ramfs")
      .arg("--mount")
      .arg(&mount)
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
