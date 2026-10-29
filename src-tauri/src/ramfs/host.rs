//! The process that serves the RAM volume (`donut-proxy ramfs`), and the WinFsp
//! loading it needs. The volume lives exactly as long as this process, which
//! ends when nothing uses the volume any more.
//!
//! WinFsp is a file system driver that Donut does not ship. When it is
//! installed, an ordinary user can mount a user-mode file system on a
//! directory; this process mounts one that keeps everything in its own memory.

use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER};
use winfsp::host::{FileSystemHost, VolumeParams};

use super::state::VolumeState;
use super::tree::{now, ALLOCATION_UNIT, MAX_NAME_LEN};
use super::winfsp_fs::RamFs;

#[cfg(target_arch = "x86_64")]
pub const DLL_NAME: &str = "winfsp-x64.dll";
#[cfg(target_arch = "aarch64")]
pub const DLL_NAME: &str = "winfsp-a64.dll";
#[cfg(target_arch = "x86")]
pub const DLL_NAME: &str = "winfsp-x86.dll";

/// How long Windows may answer free-space questions from its cache.
const VOLUME_INFO_TIMEOUT_MS: u32 = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
  Missing,
  Broken(String),
}

impl std::fmt::Display for Unavailable {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Unavailable::Missing => f.write_str("winfsp not installed"),
      Unavailable::Broken(e) => write!(f, "winfsp unusable: {e}"),
    }
  }
}

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
  text.encode_wide().chain(std::iter::once(0)).collect()
}

fn install_dir() -> Option<PathBuf> {
  use winreg::enums::HKEY_LOCAL_MACHINE;
  use winreg::RegKey;
  let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
  ["SOFTWARE\\WOW6432Node\\WinFsp", "SOFTWARE\\WinFsp"]
    .iter()
    .find_map(|key| {
      machine
        .open_subkey(key)
        .ok()?
        .get_value::<String, _>("InstallDir")
        .ok()
    })
    .map(PathBuf::from)
}

/// Load the installed WinFsp DLL by its full path, then let the crate bind to
/// it. Nothing may call into WinFsp before this succeeds: the DLL is
/// delay-loaded, and a missing DLL would end the process at the first call.
pub fn load() -> Result<(), Unavailable> {
  use windows::Win32::System::LibraryLoader::LoadLibraryW;
  static LOADED: OnceLock<()> = OnceLock::new();
  if LOADED.get().is_some() {
    return Ok(());
  }
  let dll = install_dir()
    .map(|dir| dir.join("bin").join(DLL_NAME))
    .filter(|dll| dll.is_file())
    .ok_or(Unavailable::Missing)?;
  let name = wide(dll.as_os_str());
  unsafe { LoadLibraryW(PCWSTR(name.as_ptr())) }
    .map_err(|e| Unavailable::Broken(format!("load {}: {e}", dll.display())))?;
  winfsp::winfsp_init().map_err(|e| Unavailable::Broken(format!("init: {e:?}")))?;
  let _ = LOADED.set(());
  Ok(())
}

fn user_sid() -> Result<String, String> {
  use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
  use windows::Win32::Security::{GetTokenInformation, TokenUser};
  use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
  unsafe {
    let mut token = HANDLE::default();
    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
      .map_err(|e| format!("process token: {e}"))?;
    let mut len = 0u32;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
    // u64 elements keep the buffer aligned for TOKEN_USER.
    let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
    let read = GetTokenInformation(
      token,
      TokenUser,
      Some(buffer.as_mut_ptr().cast()),
      len,
      &mut len,
    );
    let _ = CloseHandle(token);
    read.map_err(|e| format!("token user: {e}"))?;
    let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(|e| format!("user sid: {e}"))?;
    let sid = text.to_string();
    let _ = LocalFree(Some(HLOCAL(text.0.cast())));
    sid.map_err(|e| format!("user sid: {e}"))
  }
}

/// The root directory's descriptor: the user, SYSTEM and Administrators, as in
/// the user's own profile folder, inherited by everything created below.
fn root_security() -> Result<Vec<u8>, String> {
  use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
  };
  let sid = user_sid()?;
  let sddl =
    format!("O:{sid}G:{sid}D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)(A;OICI;FA;;;{sid})");
  let sddl = wide(std::ffi::OsStr::new(&sddl));
  let mut descriptor = PSECURITY_DESCRIPTOR::default();
  let mut len = 0u32;
  unsafe {
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
      PCWSTR(sddl.as_ptr()),
      SDDL_REVISION_1,
      &mut descriptor,
      Some(&mut len),
    )
    .map_err(|e| format!("root security: {e}"))?;
    let bytes = std::slice::from_raw_parts(descriptor.0.cast::<u8>(), len as usize).to_vec();
    let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    Ok(bytes)
  }
}

fn volume_params() -> VolumeParams {
  let mut params = VolumeParams::new();
  params
    .sector_size(ALLOCATION_UNIT as u16)
    .sectors_per_allocation_unit(1)
    .max_component_length(MAX_NAME_LEN as u16)
    .volume_creation_time(now())
    .volume_serial_number(now() as u32)
    .file_info_timeout(u32::MAX)
    .case_sensitive_search(false)
    .case_preserved_names(true)
    .unicode_on_disk(true)
    .persistent_acls(true)
    .post_cleanup_when_modified_only(true)
    .post_disposition_only_when_necessary(true)
    .supports_posix_unlink_rename(true)
    .reparse_points(true)
    .filesystem_name("NTFS");
  // Free space must stay current: Chromium sizes its caches and quotas from
  // it. The crate sets the timeout but not the flag that makes it count.
  // SAFETY: VolumeParams is a transparent wrapper of FSP_FSCTL_VOLUME_PARAMS.
  let raw = unsafe {
    &mut *(&mut params as *mut VolumeParams).cast::<winfsp_sys::FSP_FSCTL_VOLUME_PARAMS>()
  };
  raw.set_VolumeInfoTimeoutValid(1);
  raw.VolumeInfoTimeout = VOLUME_INFO_TIMEOUT_MS;
  params
}

/// A mounted volume. Dropping it unmounts it and frees everything on it.
pub struct Volume {
  _host: FileSystemHost<RamFs>,
  handles: Arc<AtomicUsize>,
}

impl Volume {
  pub fn open_handles(&self) -> usize {
    self.handles.load(Ordering::Relaxed)
  }
}

pub fn mount_volume(mount: &Path, capacity: u64) -> Result<Volume, String> {
  load().map_err(|e| e.to_string())?;
  let fs = RamFs::new(capacity, root_security()?);
  let handles = fs.open_handles();
  let mut host: FileSystemHost<RamFs> =
    FileSystemHost::new(volume_params(), fs).map_err(|e| format!("create: {e}"))?;
  host
    .mount(mount.as_os_str())
    .map_err(|e| format!("mount: {e}"))?;
  host.start().map_err(|e| format!("start: {e}"))?;
  Ok(Volume {
    _host: host,
    handles,
  })
}

/// WinFsp creates the mount point itself, so the path must not exist. A
/// crashed host can leave an empty directory or a dead junction there; either
/// is removed. Anything with contents is left alone.
fn clear_mount_point(mount: &Path) -> Result<(), String> {
  match std::fs::symlink_metadata(mount) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("mount point unreadable: {e}")),
    Ok(_) => std::fs::remove_dir(mount).map_err(|e| format!("mount point in use: {e}")),
  }
}

/// Mount, record the volume in `state_file`, and serve it while it is used.
///
/// The app stops the host when it quits with nothing on the volume. A browser
/// can outlive the app, though, and so can a crashed app's volume; then the
/// host ends itself once no Donut uses the volume, no file on it is open (a
/// running browser always holds some), and no protected profile's copy waits
/// on it to be sealed. Two checks in a row must agree.
pub fn host_main(mount: &Path, capacity: u64, state_file: &Path) -> i32 {
  let started = std::time::Instant::now();
  let pid = std::process::id();
  let prepared = mount
    .parent()
    .map_or(Ok(()), std::fs::create_dir_all)
    .map_err(|e| format!("mount parent: {e}"))
    .and_then(|()| clear_mount_point(mount));
  let volume = match prepared.and_then(|()| mount_volume(mount, capacity)) {
    Ok(volume) => volume,
    Err(e) => {
      log::error!(
        "Ram volume mount failed mount={} pid={pid} err=\"{e}\"",
        mount.display()
      );
      return 1;
    }
  };
  let state = VolumeState {
    pid,
    mount: mount.to_path_buf(),
    capacity,
  };
  if let Err(e) = state.write(state_file) {
    log::error!(
      "Ram volume state write failed path={} pid={pid} err=\"{e}\"",
      state_file.display()
    );
    return 1;
  }
  log::info!(
    "Ram volume mounted mount={} capacity_mb={} pid={pid} elapsed_ms={}",
    mount.display(),
    capacity >> 20,
    started.elapsed().as_millis()
  );
  let profiles = state_file
    .parent()
    .map_or_else(|| PathBuf::from("profiles"), |dir| dir.join("profiles"));
  let interval = crate::proxy_server::watchdog_poll_interval();
  let mut unused_checks = 0;
  while unused_checks < 2 {
    std::thread::sleep(interval);
    // The protected-copy check lists the volume, which opens a handle on it,
    // so it comes after the handle count.
    let unused = !super::owner_runs(mount)
      && volume.open_handles() == 0
      && !super::holds_protected_copy(mount, &profiles);
    unused_checks = if unused { unused_checks + 1 } else { 0 };
  }
  drop(volume);
  if VolumeState::read(state_file).is_some_and(|state| state.pid == pid) {
    let _ = std::fs::remove_file(state_file);
  }
  log::info!(
    "Ram volume host exiting pid={pid} reason=unused uptime_s={}",
    started.elapsed().as_secs()
  );
  0
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Read, Write};

  fn free_bytes(path: &Path) -> u64 {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut name = path.as_os_str().to_os_string();
    name.push("\\");
    let name = wide(&name);
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(name.as_ptr()), Some(&mut free), None, None) }.unwrap();
    free
  }

  fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
  }

  fn wait_for_volume_info() {
    std::thread::sleep(std::time::Duration::from_millis(
      VOLUME_INFO_TIMEOUT_MS as u64 + 200,
    ));
  }

  /// Run after installing WinFsp:
  /// `cargo test --lib ramfs::host -- --ignored --nocapture`
  #[test]
  #[ignore = "needs WinFsp installed"]
  fn a_mounted_volume_serves_files_like_a_disk() {
    let root = tempfile::tempdir().unwrap();
    let mount = root.path().join("ephemeral-ram");
    let capacity: u64 = 64 << 20;
    let volume = mount_volume(&mount, capacity).unwrap();

    let network = mount.join("profile\\Default\\Network");
    std::fs::create_dir_all(&network).unwrap();
    std::fs::write(network.join("Cookies"), b"a=1").unwrap();
    assert_eq!(
      std::fs::read(mount.join("PROFILE\\default\\NETWORK\\cookies")).unwrap(),
      b"a=1"
    );
    let listed: Vec<String> = std::fs::read_dir(mount.join("profile\\default"))
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(listed, ["Network"]);

    // An atomic write: a temporary file moved over the old one.
    let prefs = mount.join("profile\\Default\\Preferences");
    let temp = mount.join("profile\\Default\\Preferences.tmp");
    std::fs::write(&prefs, b"old").unwrap();
    std::fs::write(&temp, b"new").unwrap();
    std::fs::rename(&temp, &prefs).unwrap();
    assert_eq!(std::fs::read(&prefs).unwrap(), b"new");
    assert!(!temp.exists());

    // Replace and delete a file that another handle still reads.
    let mut held = std::fs::File::open(&prefs).unwrap();
    std::fs::write(&temp, b"newer").unwrap();
    std::fs::rename(&temp, &prefs).unwrap();
    assert_eq!(std::fs::read(&prefs).unwrap(), b"newer");
    let mut old = String::new();
    held.read_to_string(&mut old).unwrap();
    assert_eq!(old, "new");
    std::fs::remove_file(&prefs).unwrap();
    assert!(!prefs.exists());
    drop(held);

    // A delete-on-close file goes when its handle closes.
    let scratch = mount.join("profile\\Default\\scratch");
    {
      use std::os::windows::fs::OpenOptionsExt;
      const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
      let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .open(&scratch)
        .unwrap();
      file.write_all(b"temp").unwrap();
      assert!(scratch.exists());
    }
    assert!(!scratch.exists());

    // Windows may refuse to move a directory with an open file in it, as NTFS
    // does. Either way the open file keeps its data and one path finds it.
    let history = mount.join("profile\\Default\\History");
    std::fs::write(&history, b"visits").unwrap();
    let mut open_child = std::fs::File::open(&history).unwrap();
    let moved = std::fs::rename(
      mount.join("profile\\Default"),
      mount.join("profile\\Profile 1"),
    );
    let mut visits = String::new();
    open_child.read_to_string(&mut visits).unwrap();
    assert_eq!(visits, "visits");
    drop(open_child);
    let default = match moved {
      Ok(()) => mount.join("profile\\Profile 1"),
      Err(e) => {
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied, "{e}");
        mount.join("profile\\Default")
      }
    };
    assert_eq!(std::fs::read(default.join("History")).unwrap(), b"visits");
    let network = default.join("Network");

    // An ACE added to a folder stays and passes to new files, as Chromium's
    // sandbox needs for the Network folder. AC is ALL APPLICATION PACKAGES.
    let sddl = |path: &Path| {
      let script = format!("(Get-Acl -LiteralPath '{}').Sddl", path.display());
      let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .unwrap();
      String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let granted = std::process::Command::new("icacls")
      .arg(&network)
      .args(["/grant", "*S-1-15-2-1:(OI)(CI)(F)"])
      .output()
      .unwrap();
    assert!(granted.status.success(), "{granted:?}");
    let tokens = network.join("Trust Tokens");
    std::fs::write(&tokens, b"x").unwrap();
    assert!(sddl(&network).contains(";;;AC)"), "{}", sddl(&network));
    assert!(sddl(&tokens).contains(";;;AC)"), "{}", sddl(&tokens));

    // A plain file answers "not a reparse point".
    {
      use std::os::windows::fs::OpenOptionsExt;
      use std::os::windows::io::AsRawHandle;
      use windows::Win32::Foundation::ERROR_NOT_A_REPARSE_POINT;
      use windows::Win32::System::IO::DeviceIoControl;
      const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;
      const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
      let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(network.join("Cookies"))
        .unwrap();
      let mut buffer = vec![0u8; 16 * 1024];
      let mut returned = 0u32;
      let queried = unsafe {
        DeviceIoControl(
          HANDLE(file.as_raw_handle()),
          FSCTL_GET_REPARSE_POINT,
          None,
          0,
          Some(buffer.as_mut_ptr().cast()),
          buffer.len() as u32,
          Some(&mut returned),
          None,
        )
      };
      assert_eq!(
        queried.unwrap_err().code(),
        ERROR_NOT_A_REPARSE_POINT.to_hresult()
      );
    }

    // Free space follows what is written and deleted.
    wait_for_volume_info();
    let before = free_bytes(&mount);
    assert!(before < capacity);
    let cache = mount.join("profile\\cache");
    write_synced(&cache, &vec![7u8; 8 << 20]).unwrap();
    wait_for_volume_info();
    let during = free_bytes(&mount);
    assert!(
      before - during >= 8 << 20,
      "before={before} during={during}"
    );
    std::fs::remove_file(&cache).unwrap();
    wait_for_volume_info();
    assert_eq!(free_bytes(&mount), before);

    let huge = mount.join("profile\\huge");
    assert!(write_synced(&huge, &vec![0u8; capacity as usize + 1]).is_err());
    let _ = std::fs::remove_file(&huge);

    std::fs::remove_dir_all(mount.join("profile")).unwrap();
    assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);

    drop(volume);
    assert!(!mount.exists());
  }

  #[test]
  fn a_stale_mount_point_is_cleared_but_contents_are_kept() {
    let root = tempfile::tempdir().unwrap();
    let mount = root.path().join("ephemeral-ram");
    assert!(clear_mount_point(&mount).is_ok());
    std::fs::create_dir(&mount).unwrap();
    assert!(clear_mount_point(&mount).is_ok());
    assert!(!mount.exists());
    std::fs::create_dir(&mount).unwrap();
    std::fs::write(mount.join("keep"), b"x").unwrap();
    assert!(clear_mount_point(&mount).is_err());
    assert!(mount.join("keep").exists());
  }
}
