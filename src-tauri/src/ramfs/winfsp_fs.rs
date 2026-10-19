//! The WinFsp side of the RAM volume: each request maps onto `Tree`.
//!
//! WinFsp's kernel driver handles byte-range locks, memory-mapped files, the
//! cache and change notifications; this layer keeps names, data and security
//! descriptors.

use std::ffi::c_void;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use windows::Win32::Foundation::{
  STATUS_ACCESS_DENIED, STATUS_BUFFER_OVERFLOW, STATUS_CANNOT_DELETE, STATUS_DIRECTORY_NOT_EMPTY,
  STATUS_DISK_FULL, STATUS_END_OF_FILE, STATUS_FILE_IS_A_DIRECTORY, STATUS_INSUFFICIENT_RESOURCES,
  STATUS_INVALID_DEVICE_REQUEST, STATUS_INVALID_PARAMETER, STATUS_NOT_A_DIRECTORY,
  STATUS_NOT_A_REPARSE_POINT, STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_INVALID,
  STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
};
use windows::Win32::Security::{GetSecurityDescriptorLength, PSECURITY_DESCRIPTOR};
use winfsp::constants::FspCleanupFlags;
use winfsp::filesystem::{
  DirInfo, DirMarker, FileInfo, FileSecurity, FileSystemContext, ModificationDescriptor,
  OpenFileInfo, VolumeInfo, WideNameInfo,
};
use winfsp::{FspError, U16CStr};
use winfsp_sys::{FILE_ACCESS_RIGHTS, FILE_FLAGS_AND_ATTRIBUTES};

use super::tree::{BasicInfo, FsError, Info, NodeId, Tree, ROOT};

const FILE_DIRECTORY_FILE: u32 = 0x1;
const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;
const VOLUME_LABEL: &str = "DonutEphemeral";

/// WinFsp reads a security descriptor by name into a 1024-byte buffer, and this
/// binding cannot report that more room is needed. Larger descriptors are
/// refused when they are set, so no open ever fails on one.
pub const MAX_SECURITY_LEN: usize = 1024;

impl From<FsError> for FspError {
  fn from(error: FsError) -> Self {
    let status = match error {
      FsError::NotFound => STATUS_OBJECT_NAME_NOT_FOUND,
      FsError::PathNotFound => STATUS_OBJECT_PATH_NOT_FOUND,
      FsError::NameCollision => STATUS_OBJECT_NAME_COLLISION,
      FsError::NameInvalid => STATUS_OBJECT_NAME_INVALID,
      FsError::NotADirectory => STATUS_NOT_A_DIRECTORY,
      FsError::IsADirectory => STATUS_FILE_IS_A_DIRECTORY,
      FsError::DirectoryNotEmpty => STATUS_DIRECTORY_NOT_EMPTY,
      FsError::AccessDenied => STATUS_ACCESS_DENIED,
      FsError::CannotDelete => STATUS_CANNOT_DELETE,
      FsError::DiskFull => STATUS_DISK_FULL,
      FsError::EndOfFile => STATUS_END_OF_FILE,
      FsError::InvalidParameter => STATUS_INVALID_PARAMETER,
    };
    FspError::NTSTATUS(status.0)
  }
}

fn status(status: windows::Win32::Foundation::NTSTATUS) -> FspError {
  FspError::NTSTATUS(status.0)
}

fn fill(out: &mut FileInfo, info: Info) {
  out.file_attributes = info.attributes;
  out.reparse_tag = 0;
  out.allocation_size = info.allocation_size;
  out.file_size = info.file_size;
  out.creation_time = info.creation_time;
  out.last_access_time = info.last_access_time;
  out.last_write_time = info.last_write_time;
  out.change_time = info.change_time;
  out.index_number = info.index_number;
  out.hard_links = 0;
  out.ea_size = 0;
}

/// One open of a file or directory.
pub struct Handle {
  id: NodeId,
}

pub struct RamFs {
  tree: Mutex<Tree>,
}

impl RamFs {
  pub fn new(capacity: u64, root_security: Vec<u8>) -> Self {
    RamFs {
      tree: Mutex::new(Tree::new(capacity, root_security)),
    }
  }

  /// A callback that panicked poisons the lock; the tree stays consistent
  /// because every change finishes before the next can fail.
  fn tree(&self) -> MutexGuard<'_, Tree> {
    self.tree.lock().unwrap_or_else(PoisonError::into_inner)
  }

  fn opened(
    &self,
    tree: &Tree,
    id: NodeId,
    file_info: &mut OpenFileInfo,
  ) -> winfsp::Result<Handle> {
    fill(file_info.as_mut(), tree.info(id)?);
    // The stored case of every name, so Windows reports what was created.
    let path = tree.full_path(id)?;
    if path.len() * 2 < file_info.normalized_name_size() as usize {
      file_info.set_normalized_name(&path, None);
    }
    Ok(Handle { id })
  }
}

/// The address of `FspSetSecurityDescriptor` inside the WinFsp DLL. WinFsp
/// frees a descriptor by comparing the function that made it to its own
/// exports, and the delay-load stub this binary links has another address.
fn set_security_descriptor_export() -> Option<unsafe extern "C" fn() -> i32> {
  use windows::core::{PCSTR, PCWSTR};
  use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
  static EXPORT: OnceLock<Option<unsafe extern "C" fn() -> i32>> = OnceLock::new();
  *EXPORT.get_or_init(|| {
    let name: Vec<u16> = super::host::DLL_NAME
      .encode_utf16()
      .chain(std::iter::once(0))
      .collect();
    let module = unsafe { GetModuleHandleW(PCWSTR(name.as_ptr())) }.ok()?;
    let export =
      unsafe { GetProcAddress(module, PCSTR(c"FspSetSecurityDescriptor".as_ptr().cast())) }?;
    // SAFETY: WinFsp's FspDeleteSecurityDescriptor takes this function as an
    // untyped `NTSTATUS (*)()` and only compares it.
    Some(unsafe {
      std::mem::transmute::<unsafe extern "system" fn() -> isize, unsafe extern "C" fn() -> i32>(
        export,
      )
    })
  })
}

/// Apply a SetSecurity request to a stored descriptor.
fn modified_security(
  current: &[u8],
  security_information: u32,
  modification: &ModificationDescriptor,
) -> winfsp::Result<Vec<u8>> {
  let export = set_security_descriptor_export().ok_or(status(STATUS_INVALID_DEVICE_REQUEST))?;
  // The input parameter is not const, so it gets a private copy.
  let mut input = current.to_vec();
  let mut output: winfsp_sys::PSECURITY_DESCRIPTOR = std::ptr::null_mut();
  let result = unsafe {
    winfsp_sys::FspSetSecurityDescriptor(
      input.as_mut_ptr().cast(),
      security_information,
      modification.as_mut_ptr(),
      &mut output,
    )
  };
  if result < 0 {
    return Err(FspError::NTSTATUS(result));
  }
  let len = unsafe { GetSecurityDescriptorLength(PSECURITY_DESCRIPTOR(output)) } as usize;
  let updated = unsafe { std::slice::from_raw_parts(output.cast::<u8>(), len) }.to_vec();
  unsafe { winfsp_sys::FspDeleteSecurityDescriptor(output, Some(export)) };
  Ok(updated)
}

impl FileSystemContext for RamFs {
  type FileContext = Handle;

  fn get_security_by_name(
    &self,
    file_name: &U16CStr,
    security_descriptor: Option<&mut [c_void]>,
    _reparse_point_resolver: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
  ) -> winfsp::Result<FileSecurity> {
    let tree = self.tree();
    let id = tree.lookup(file_name.as_slice())?;
    let attributes = tree.info(id)?.attributes;
    let security = tree.security(id)?;
    if let Some(buffer) = security_descriptor {
      if buffer.len() < security.len() {
        // Never STATUS_BUFFER_OVERFLOW: WinFsp would retry with the same size.
        return Err(status(STATUS_INSUFFICIENT_RESOURCES));
      }
      unsafe {
        std::ptr::copy_nonoverlapping(
          security.as_ptr(),
          buffer.as_mut_ptr().cast::<u8>(),
          security.len(),
        )
      };
    }
    Ok(FileSecurity {
      reparse: false,
      sz_security_descriptor: security.len() as u64,
      attributes,
    })
  }

  fn open(
    &self,
    file_name: &U16CStr,
    create_options: u32,
    _granted_access: FILE_ACCESS_RIGHTS,
    file_info: &mut OpenFileInfo,
  ) -> winfsp::Result<Handle> {
    let mut tree = self.tree();
    let id = tree.lookup(file_name.as_slice())?;
    let is_dir = tree.is_dir(id)?;
    if create_options & FILE_DIRECTORY_FILE != 0 && !is_dir {
      return Err(FsError::NotADirectory.into());
    }
    if create_options & FILE_NON_DIRECTORY_FILE != 0 && is_dir {
      return Err(FsError::IsADirectory.into());
    }
    tree.open(id)?;
    self.opened(&tree, id, file_info)
  }

  fn close(&self, context: Handle) {
    self.tree().close(context.id);
  }

  fn create(
    &self,
    file_name: &U16CStr,
    create_options: u32,
    _granted_access: FILE_ACCESS_RIGHTS,
    file_attributes: FILE_FLAGS_AND_ATTRIBUTES,
    security_descriptor: Option<&[c_void]>,
    allocation_size: u64,
    extra_buffer: Option<&[u8]>,
    extra_buffer_is_reparse_point: bool,
    file_info: &mut OpenFileInfo,
  ) -> winfsp::Result<Handle> {
    if extra_buffer_is_reparse_point && extra_buffer.is_some_and(|buffer| !buffer.is_empty()) {
      return Err(status(STATUS_ACCESS_DENIED));
    }
    let mut tree = self.tree();
    let security = match security_descriptor {
      Some(descriptor) => {
        unsafe { std::slice::from_raw_parts(descriptor.as_ptr().cast::<u8>(), descriptor.len()) }
          .to_vec()
      }
      None => tree.security(ROOT)?.to_vec(),
    };
    if security.len() > MAX_SECURITY_LEN {
      return Err(status(STATUS_INSUFFICIENT_RESOURCES));
    }
    let id = tree.create(
      file_name.as_slice(),
      create_options & FILE_DIRECTORY_FILE != 0,
      file_attributes,
      security,
      allocation_size,
    )?;
    self.opened(&tree, id, file_info)
  }

  fn cleanup(&self, context: &Handle, _file_name: Option<&U16CStr>, flags: u32) {
    let mut tree = self.tree();
    let flagged = |flag: FspCleanupFlags| flag.is_flagged(flags);
    if flagged(FspCleanupFlags::FspCleanupSetAllocationSize) {
      let _ = tree.trim_allocation(context.id);
    }
    let _ = tree.touch(
      context.id,
      flagged(FspCleanupFlags::FspCleanupSetLastAccessTime),
      flagged(FspCleanupFlags::FspCleanupSetLastWriteTime),
      flagged(FspCleanupFlags::FspCleanupSetChangeTime),
      flagged(FspCleanupFlags::FspCleanupSetArchiveBit),
    );
    if flagged(FspCleanupFlags::FspCleanupDelete) {
      tree.unlink(context.id);
    }
  }

  fn flush(&self, context: Option<&Handle>, file_info: &mut FileInfo) -> winfsp::Result<()> {
    if let Some(context) = context {
      fill(file_info, self.tree().info(context.id)?);
    }
    Ok(())
  }

  fn get_file_info(&self, context: &Handle, file_info: &mut FileInfo) -> winfsp::Result<()> {
    fill(file_info, self.tree().info(context.id)?);
    Ok(())
  }

  fn get_security(
    &self,
    context: &Handle,
    security_descriptor: Option<&mut [c_void]>,
  ) -> winfsp::Result<u64> {
    let tree = self.tree();
    let security = tree.security(context.id)?;
    if let Some(buffer) = security_descriptor {
      if buffer.len() < security.len() {
        return Err(status(STATUS_BUFFER_OVERFLOW));
      }
      unsafe {
        std::ptr::copy_nonoverlapping(
          security.as_ptr(),
          buffer.as_mut_ptr().cast::<u8>(),
          security.len(),
        )
      };
    }
    Ok(security.len() as u64)
  }

  fn set_security(
    &self,
    context: &Handle,
    security_information: u32,
    modification_descriptor: ModificationDescriptor,
  ) -> winfsp::Result<()> {
    let mut tree = self.tree();
    let updated = modified_security(
      tree.security(context.id)?,
      security_information,
      &modification_descriptor,
    )?;
    if updated.len() > MAX_SECURITY_LEN {
      return Err(status(STATUS_INSUFFICIENT_RESOURCES));
    }
    tree.set_security(context.id, updated)?;
    Ok(())
  }

  fn overwrite(
    &self,
    context: &Handle,
    file_attributes: FILE_FLAGS_AND_ATTRIBUTES,
    replace_file_attributes: bool,
    allocation_size: u64,
    _extra_buffer: Option<&[u8]>,
    file_info: &mut FileInfo,
  ) -> winfsp::Result<()> {
    let mut tree = self.tree();
    tree.overwrite(
      context.id,
      file_attributes,
      replace_file_attributes,
      allocation_size,
    )?;
    fill(file_info, tree.info(context.id)?);
    Ok(())
  }

  fn read_directory(
    &self,
    context: &Handle,
    _pattern: Option<&U16CStr>,
    marker: DirMarker,
    buffer: &mut [u8],
  ) -> winfsp::Result<u32> {
    let tree = self.tree();
    let mut cursor = 0u32;
    let mut entry: DirInfo = DirInfo::new();
    let mut full = false;
    tree.for_each_entry(context.id, marker.inner(), |name, info| {
      entry.reset();
      fill(entry.file_info_mut(), info);
      if entry.set_name_raw(name).is_err() {
        return true;
      }
      if !entry.append_to_buffer(buffer, &mut cursor) {
        full = true;
        return false;
      }
      true
    })?;
    if !full {
      <DirInfo as WideNameInfo>::finalize_buffer(buffer, &mut cursor);
    }
    Ok(cursor)
  }

  fn rename(
    &self,
    context: &Handle,
    _file_name: &U16CStr,
    new_file_name: &U16CStr,
    replace_if_exists: bool,
  ) -> winfsp::Result<()> {
    self
      .tree()
      .rename(context.id, new_file_name.as_slice(), replace_if_exists)?;
    Ok(())
  }

  fn set_basic_info(
    &self,
    context: &Handle,
    file_attributes: u32,
    creation_time: u64,
    last_access_time: u64,
    last_write_time: u64,
    last_change_time: u64,
    file_info: &mut FileInfo,
  ) -> winfsp::Result<()> {
    let set = |time: u64| (time != 0).then_some(time);
    let mut tree = self.tree();
    tree.set_basic(
      context.id,
      BasicInfo {
        attributes: (file_attributes != INVALID_FILE_ATTRIBUTES).then_some(file_attributes),
        creation_time: set(creation_time),
        last_access_time: set(last_access_time),
        last_write_time: set(last_write_time),
        change_time: set(last_change_time),
      },
    )?;
    fill(file_info, tree.info(context.id)?);
    Ok(())
  }

  fn set_delete(
    &self,
    context: &Handle,
    _file_name: &U16CStr,
    delete_file: bool,
  ) -> winfsp::Result<()> {
    if delete_file {
      self.tree().can_delete(context.id)?;
    }
    Ok(())
  }

  fn set_file_size(
    &self,
    context: &Handle,
    new_size: u64,
    set_allocation_size: bool,
    file_info: &mut FileInfo,
  ) -> winfsp::Result<()> {
    let mut tree = self.tree();
    if set_allocation_size {
      tree.set_allocation_size(context.id, new_size)?;
    } else {
      tree.set_file_size(context.id, new_size)?;
    }
    fill(file_info, tree.info(context.id)?);
    Ok(())
  }

  fn read(&self, context: &Handle, buffer: &mut [u8], offset: u64) -> winfsp::Result<u32> {
    Ok(self.tree().read(context.id, offset, buffer)? as u32)
  }

  fn write(
    &self,
    context: &Handle,
    buffer: &[u8],
    offset: u64,
    write_to_eof: bool,
    constrained_io: bool,
    file_info: &mut FileInfo,
  ) -> winfsp::Result<u32> {
    let mut tree = self.tree();
    let written = tree.write(context.id, offset, buffer, write_to_eof, constrained_io)?;
    fill(file_info, tree.info(context.id)?);
    Ok(written as u32)
  }

  fn get_volume_info(&self, out_volume_info: &mut VolumeInfo) -> winfsp::Result<()> {
    let tree = self.tree();
    out_volume_info.total_size = tree.capacity();
    out_volume_info.free_size = tree.free();
    out_volume_info.set_volume_label(VOLUME_LABEL);
    Ok(())
  }

  // The volume holds no reparse points, but it answers for them as NTFS does,
  // because callers treat "not a reparse point" and "not supported" apart.
  fn get_reparse_point_by_name(
    &self,
    _file_name: &U16CStr,
    _is_directory: bool,
    _buffer: &mut [u8],
  ) -> winfsp::Result<u64> {
    Err(status(STATUS_NOT_A_REPARSE_POINT))
  }

  fn get_reparse_point(
    &self,
    _context: &Handle,
    _file_name: &U16CStr,
    _buffer: &mut [u8],
  ) -> winfsp::Result<u64> {
    Err(status(STATUS_NOT_A_REPARSE_POINT))
  }

  fn set_reparse_point(
    &self,
    _context: &Handle,
    _file_name: &U16CStr,
    _buffer: &[u8],
  ) -> winfsp::Result<()> {
    Err(status(STATUS_ACCESS_DENIED))
  }

  fn delete_reparse_point(
    &self,
    _context: &Handle,
    _file_name: &U16CStr,
    _buffer: &[u8],
  ) -> winfsp::Result<()> {
    Err(status(STATUS_NOT_A_REPARSE_POINT))
  }
}
