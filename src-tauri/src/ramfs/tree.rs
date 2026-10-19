//! The file tree of the RAM volume. It holds no WinFsp types: names are UTF-16
//! path parts like Windows sends them, so the tests run on every OS.
//!
//! File contents never go back to the allocator with data in them. A buffer is
//! zeroed before it is freed, before it is replaced by a larger or smaller one,
//! and in the part a truncation cuts off.

use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;

pub type NodeId = u64;
pub const ROOT: NodeId = 1;

pub const ATTR_READONLY: u32 = 0x1;
pub const ATTR_DIRECTORY: u32 = 0x10;
pub const ATTR_ARCHIVE: u32 = 0x20;
pub const ATTR_NORMAL: u32 = 0x80;

pub const ALLOCATION_UNIT: u64 = 512;
pub const MAX_NAME_LEN: usize = 255;

const SEPARATOR: u16 = b'\\' as u16;
const DOT: &[u16] = &[b'.' as u16];
const DOT_DOT: &[u16] = &[b'.' as u16, b'.' as u16];
/// A growing file gets spare room of its own size, up to this much, so a file
/// written in small appends is not copied on every append.
const MAX_GROWTH_STEP: u64 = 8 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsError {
  NotFound,
  PathNotFound,
  NameCollision,
  NameInvalid,
  NotADirectory,
  IsADirectory,
  DirectoryNotEmpty,
  AccessDenied,
  CannotDelete,
  DiskFull,
  EndOfFile,
  InvalidParameter,
}

pub type FsResult<T> = Result<T, FsError>;

/// Times are Windows FILETIME values: 100 ns units since 1601-01-01.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Info {
  pub attributes: u32,
  pub allocation_size: u64,
  pub file_size: u64,
  pub creation_time: u64,
  pub last_access_time: u64,
  pub last_write_time: u64,
  pub change_time: u64,
  pub index_number: u64,
}

/// Time changes for `Tree::set_basic`. `None` keeps the current value.
#[derive(Debug, Clone, Copy, Default)]
pub struct BasicInfo {
  pub attributes: Option<u32>,
  pub creation_time: Option<u64>,
  pub last_access_time: Option<u64>,
  pub last_write_time: Option<u64>,
  pub change_time: Option<u64>,
}

pub fn now() -> u64 {
  const UNIX_EPOCH_AS_FILETIME: u64 = 116_444_736_000_000_000;
  let since_unix = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default();
  UNIX_EPOCH_AS_FILETIME + (since_unix.as_nanos() / 100) as u64
}

fn wipe(bytes: &mut [u8]) {
  bytes.fill(0);
  std::hint::black_box(bytes);
}

fn round_up(size: u64) -> u64 {
  size.div_ceil(ALLOCATION_UNIT) * ALLOCATION_UNIT
}

/// File contents. `bytes.len()` is the file size, `allocation` the size
/// Windows sees as allocated, and `room` the memory actually held, which the
/// volume charges. `bytes` never reallocates on its own, because a
/// reallocation would free the old buffer without zeroing it.
#[derive(Default)]
struct Data {
  bytes: Vec<u8>,
  allocation: u64,
  room: u64,
}

impl Data {
  fn with_room(room: u64) -> Self {
    Data {
      bytes: Vec::with_capacity(room as usize),
      allocation: room,
      room,
    }
  }

  fn len(&self) -> u64 {
    self.bytes.len() as u64
  }

  /// Move the contents to a buffer of `room` bytes. The caller first
  /// truncates to at most `room`.
  fn move_to(&mut self, room: u64) {
    debug_assert!(self.len() <= room);
    let mut next = Vec::with_capacity(room as usize);
    next.extend_from_slice(&self.bytes);
    wipe(&mut self.bytes);
    self.bytes = next;
    self.room = room;
  }

  fn truncate(&mut self, len: u64) {
    if len < self.len() {
      wipe(&mut self.bytes[len as usize..]);
      self.bytes.truncate(len as usize);
    }
  }

  /// Extend with zeros. The caller first makes `room` large enough.
  fn extend(&mut self, len: u64) {
    debug_assert!(len <= self.room && self.bytes.capacity() as u64 >= len);
    if len > self.len() {
      self.bytes.resize(len as usize, 0);
    }
  }
}

impl Drop for Data {
  fn drop(&mut self) {
    wipe(&mut self.bytes);
  }
}

struct Node {
  name: Vec<u16>,
  /// `None` for the root and for a node unlinked while a handle still has it
  /// open.
  parent: Option<NodeId>,
  /// `Some` for a directory: its children by case-folded name.
  children: Option<BTreeMap<Vec<u16>, NodeId>>,
  data: Data,
  attributes: u32,
  creation_time: u64,
  last_access_time: u64,
  last_write_time: u64,
  change_time: u64,
  security: Vec<u8>,
  opens: u32,
}

impl Node {
  fn is_dir(&self) -> bool {
    self.children.is_some()
  }
}

/// Windows compares names case-insensitively with an upcase table of single
/// UTF-16 units. This maps each unit the same way where Unicode gives a single
/// BMP uppercase form.
pub fn fold(name: &[u16]) -> Vec<u16> {
  name
    .iter()
    .map(|&unit| {
      if unit < 0x80 {
        return (unit as u8).to_ascii_uppercase() as u16;
      }
      let Some(c) = char::from_u32(unit as u32) else {
        return unit;
      };
      let mut upper = c.to_uppercase();
      match (upper.next(), upper.next()) {
        (Some(u), None) if (u as u32) <= 0xFFFF => u as u16,
        _ => unit,
      }
    })
    .collect()
}

fn components(path: &[u16]) -> impl Iterator<Item = &[u16]> {
  path
    .split(|&unit| unit == SEPARATOR)
    .filter(|part| !part.is_empty())
}

/// Split `\a\b\name` into `\a\b` and `name`.
fn split_parent(path: &[u16]) -> FsResult<(&[u16], &[u16])> {
  let end = path
    .iter()
    .rposition(|&unit| unit != SEPARATOR)
    .map(|last| last + 1)
    .ok_or(FsError::NameInvalid)?;
  let path = &path[..end];
  let start = path
    .iter()
    .rposition(|&unit| unit == SEPARATOR)
    .map(|sep| sep + 1)
    .unwrap_or(0);
  Ok((&path[..start], &path[start..]))
}

fn check_name(name: &[u16]) -> FsResult<()> {
  if name.is_empty()
    || name.len() > MAX_NAME_LEN
    || name == DOT
    || name == DOT_DOT
    || name.contains(&0)
  {
    return Err(FsError::NameInvalid);
  }
  Ok(())
}

fn normalized_attributes(attributes: u32, directory: bool) -> u32 {
  let attributes = attributes & !(ATTR_DIRECTORY | ATTR_NORMAL);
  if directory {
    attributes | ATTR_DIRECTORY
  } else {
    attributes
  }
}

pub struct Tree {
  nodes: HashMap<NodeId, Node>,
  next_id: NodeId,
  capacity: u64,
  used: u64,
}

impl Tree {
  pub fn new(capacity: u64, root_security: Vec<u8>) -> Self {
    let time = now();
    let root = Node {
      name: Vec::new(),
      parent: None,
      children: Some(BTreeMap::new()),
      data: Data::default(),
      attributes: ATTR_DIRECTORY,
      creation_time: time,
      last_access_time: time,
      last_write_time: time,
      change_time: time,
      security: root_security,
      opens: 0,
    };
    Tree {
      nodes: HashMap::from([(ROOT, root)]),
      next_id: ROOT + 1,
      capacity,
      used: 0,
    }
  }

  pub fn capacity(&self) -> u64 {
    self.capacity
  }

  pub fn used(&self) -> u64 {
    self.used
  }

  pub fn free(&self) -> u64 {
    self.capacity.saturating_sub(self.used)
  }

  fn node(&self, id: NodeId) -> FsResult<&Node> {
    self.nodes.get(&id).ok_or(FsError::InvalidParameter)
  }

  fn node_mut(&mut self, id: NodeId) -> FsResult<&mut Node> {
    self.nodes.get_mut(&id).ok_or(FsError::InvalidParameter)
  }

  fn file_mut(&mut self, id: NodeId) -> FsResult<&mut Node> {
    let node = self.node_mut(id)?;
    if node.is_dir() {
      return Err(FsError::IsADirectory);
    }
    Ok(node)
  }

  pub fn lookup(&self, path: &[u16]) -> FsResult<NodeId> {
    let mut id = ROOT;
    let mut parts = components(path).peekable();
    while let Some(part) = parts.next() {
      let children = self
        .node(id)?
        .children
        .as_ref()
        .ok_or(FsError::PathNotFound)?;
      match children.get(&fold(part)) {
        Some(&child) => id = child,
        None if parts.peek().is_none() => return Err(FsError::NotFound),
        None => return Err(FsError::PathNotFound),
      }
    }
    Ok(id)
  }

  fn lookup_dir(&self, path: &[u16]) -> FsResult<NodeId> {
    let id = self.lookup(path).map_err(|e| match e {
      FsError::NotFound => FsError::PathNotFound,
      other => other,
    })?;
    if !self.node(id)?.is_dir() {
      return Err(FsError::PathNotFound);
    }
    Ok(id)
  }

  pub fn info(&self, id: NodeId) -> FsResult<Info> {
    let node = self.node(id)?;
    Ok(Info {
      attributes: if node.attributes == 0 {
        ATTR_NORMAL
      } else {
        node.attributes
      },
      allocation_size: node.data.allocation,
      file_size: node.data.len(),
      creation_time: node.creation_time,
      last_access_time: node.last_access_time,
      last_write_time: node.last_write_time,
      change_time: node.change_time,
      index_number: id,
    })
  }

  pub fn is_dir(&self, id: NodeId) -> FsResult<bool> {
    Ok(self.node(id)?.is_dir())
  }

  pub fn security(&self, id: NodeId) -> FsResult<&[u8]> {
    Ok(&self.node(id)?.security)
  }

  pub fn set_security(&mut self, id: NodeId, security: Vec<u8>) -> FsResult<()> {
    let node = self.node_mut(id)?;
    node.security = security;
    node.change_time = now();
    Ok(())
  }

  /// The path from the root, with each name in its stored case.
  pub fn full_path(&self, id: NodeId) -> FsResult<Vec<u16>> {
    let mut names = Vec::new();
    let mut current = self.node(id)?;
    while let Some(parent) = current.parent {
      names.push(current.name.as_slice());
      current = self.node(parent)?;
    }
    if names.is_empty() {
      return Ok(vec![SEPARATOR]);
    }
    let mut path = Vec::new();
    for name in names.into_iter().rev() {
      path.push(SEPARATOR);
      path.extend_from_slice(name);
    }
    Ok(path)
  }

  /// Change the space charged to a file from `from` to `to` bytes.
  fn charge(&mut self, from: u64, to: u64) -> FsResult<()> {
    let used = self.used - from;
    if to > from && used + to > self.capacity {
      return Err(FsError::DiskFull);
    }
    self.used = used + to;
    Ok(())
  }

  /// Create a file or directory and open it once.
  pub fn create(
    &mut self,
    path: &[u16],
    directory: bool,
    attributes: u32,
    security: Vec<u8>,
    allocation: u64,
  ) -> FsResult<NodeId> {
    let (parent_path, name) = split_parent(path)?;
    check_name(name)?;
    let parent = self.lookup_dir(parent_path)?;
    let key = fold(name);
    if self
      .node(parent)?
      .children
      .as_ref()
      .is_some_and(|children| children.contains_key(&key))
    {
      return Err(FsError::NameCollision);
    }
    let room = if directory { 0 } else { round_up(allocation) };
    self.charge(0, room)?;

    let id = self.next_id;
    self.next_id += 1;
    let time = now();
    let attributes = if directory {
      normalized_attributes(attributes, true)
    } else {
      normalized_attributes(attributes, false) | ATTR_ARCHIVE
    };
    self.nodes.insert(
      id,
      Node {
        name: name.to_vec(),
        parent: Some(parent),
        children: directory.then(BTreeMap::new),
        data: Data::with_room(room),
        attributes,
        creation_time: time,
        last_access_time: time,
        last_write_time: time,
        change_time: time,
        security,
        opens: 1,
      },
    );
    if let Some(children) = self.node_mut(parent)?.children.as_mut() {
      children.insert(key, id);
    }
    Ok(id)
  }

  pub fn open(&mut self, id: NodeId) -> FsResult<()> {
    self.node_mut(id)?.opens += 1;
    Ok(())
  }

  /// Drop one open. An unlinked node goes when its last open does.
  pub fn close(&mut self, id: NodeId) {
    let Ok(node) = self.node_mut(id) else {
      return;
    };
    node.opens = node.opens.saturating_sub(1);
    if node.opens == 0 && node.parent.is_none() && id != ROOT {
      self.release(id);
    }
  }

  fn release(&mut self, id: NodeId) {
    if let Some(node) = self.nodes.remove(&id) {
      self.used -= node.data.room;
    }
  }

  pub fn overwrite(
    &mut self,
    id: NodeId,
    attributes: u32,
    replace_attributes: bool,
    allocation: u64,
  ) -> FsResult<()> {
    let allocation = round_up(allocation);
    self.file_mut(id)?.data.truncate(0);
    self.fit_room(id, allocation, false)?;
    let node = self.file_mut(id)?;
    node.data.allocation = allocation;
    let attributes = normalized_attributes(attributes, false) | ATTR_ARCHIVE;
    node.attributes = if replace_attributes {
      attributes
    } else {
      node.attributes | attributes
    };
    let time = now();
    node.last_access_time = time;
    node.last_write_time = time;
    node.change_time = time;
    Ok(())
  }

  pub fn read(&self, id: NodeId, offset: u64, out: &mut [u8]) -> FsResult<usize> {
    let node = self.node(id)?;
    if node.is_dir() {
      return Err(FsError::IsADirectory);
    }
    let bytes = &node.data.bytes;
    if offset >= bytes.len() as u64 {
      return Err(FsError::EndOfFile);
    }
    let start = offset as usize;
    let count = out.len().min(bytes.len() - start);
    out[..count].copy_from_slice(&bytes[start..start + count]);
    Ok(count)
  }

  /// Write `data` at `offset`, or at the end of the file. A constrained write
  /// (paging I/O) never changes the file size.
  pub fn write(
    &mut self,
    id: NodeId,
    offset: u64,
    data: &[u8],
    to_end_of_file: bool,
    constrained: bool,
  ) -> FsResult<usize> {
    let size = self.file_mut(id)?.data.len();
    let (offset, count) = if constrained {
      if offset >= size {
        return Ok(0);
      }
      (offset, (data.len() as u64).min(size - offset))
    } else {
      let offset = if to_end_of_file { size } else { offset };
      let end = offset
        .checked_add(data.len() as u64)
        .ok_or(FsError::InvalidParameter)?;
      if end > size {
        self.set_file_size(id, end)?;
      }
      (offset, data.len() as u64)
    };
    let node = self.file_mut(id)?;
    let start = offset as usize;
    let count = count as usize;
    node.data.bytes[start..start + count].copy_from_slice(&data[..count]);
    Ok(count)
  }

  /// Hold `room` bytes for a file, or at least `room` with spare room for a
  /// growing file. Without `grow`, room beyond `room` is given back.
  fn fit_room(&mut self, id: NodeId, room: u64, grow: bool) -> FsResult<()> {
    let current = self.file_mut(id)?.data.room;
    let target = if room > current {
      let spare = round_up(room.max(current + current.min(MAX_GROWTH_STEP)));
      if grow && self.charge(current, spare).is_ok() {
        spare
      } else {
        self.charge(current, room)?;
        room
      }
    } else if room < current && !grow {
      self.charge(current, room)?;
      room
    } else {
      return Ok(());
    };
    self.file_mut(id)?.data.move_to(target);
    Ok(())
  }

  /// Set the end of file. Growing past the allocation grows it to the next
  /// allocation unit, with spare room, so small extensions do not copy the
  /// file each time.
  pub fn set_file_size(&mut self, id: NodeId, size: u64) -> FsResult<()> {
    if size > self.file_mut(id)?.data.allocation {
      let allocation = round_up(size);
      self.fit_room(id, allocation, true)?;
      self.file_mut(id)?.data.allocation = allocation;
    }
    let data = &mut self.file_mut(id)?.data;
    if size < data.len() {
      data.truncate(size);
    } else {
      data.extend(size);
    }
    Ok(())
  }

  /// Set the allocation size. Less than the file size cuts the file to fit.
  /// Memory is given back when the allocation falls below half of it.
  pub fn set_allocation_size(&mut self, id: NodeId, allocation: u64) -> FsResult<()> {
    let allocation = round_up(allocation);
    let data = &self.file_mut(id)?.data;
    let room = data.room;
    if allocation == data.allocation {
      return Ok(());
    }
    if allocation > room {
      self.fit_room(id, allocation, true)?;
    }
    let data = &mut self.file_mut(id)?.data;
    data.truncate(allocation);
    data.allocation = allocation;
    if allocation < room / 2 {
      self.fit_room(id, allocation, false)?;
    }
    Ok(())
  }

  /// Fit the allocation and memory to the file size, as NTFS does when the
  /// last handle of a changed file closes.
  pub fn trim_allocation(&mut self, id: NodeId) -> FsResult<()> {
    if self.node(id)?.is_dir() {
      return Ok(());
    }
    let allocation = round_up(self.file_mut(id)?.data.len());
    self.file_mut(id)?.data.allocation = allocation;
    self.fit_room(id, allocation, false)
  }

  pub fn set_basic(&mut self, id: NodeId, basic: BasicInfo) -> FsResult<()> {
    let node = self.node_mut(id)?;
    if let Some(attributes) = basic.attributes {
      node.attributes = normalized_attributes(attributes, node.is_dir());
    }
    if let Some(time) = basic.creation_time {
      node.creation_time = time;
    }
    if let Some(time) = basic.last_access_time {
      node.last_access_time = time;
    }
    if let Some(time) = basic.last_write_time {
      node.last_write_time = time;
    }
    if let Some(time) = basic.change_time {
      node.change_time = time;
    }
    Ok(())
  }

  /// The updates Windows asks for when the last handle of a changed file
  /// closes.
  pub fn touch(
    &mut self,
    id: NodeId,
    access: bool,
    write: bool,
    change: bool,
    archive: bool,
  ) -> FsResult<()> {
    let node = self.node_mut(id)?;
    let time = now();
    if access {
      node.last_access_time = time;
    }
    if write {
      node.last_write_time = time;
    }
    if change {
      node.change_time = time;
    }
    if archive && !node.is_dir() {
      node.attributes |= ATTR_ARCHIVE;
    }
    Ok(())
  }

  pub fn can_delete(&self, id: NodeId) -> FsResult<()> {
    let node = self.node(id)?;
    if id == ROOT {
      return Err(FsError::AccessDenied);
    }
    if node
      .children
      .as_ref()
      .is_some_and(|children| !children.is_empty())
    {
      return Err(FsError::DirectoryNotEmpty);
    }
    if node.attributes & ATTR_READONLY != 0 {
      return Err(FsError::CannotDelete);
    }
    Ok(())
  }

  /// Take a node out of its directory. Open handles keep its contents until
  /// they close. A directory that still has children stays.
  pub fn unlink(&mut self, id: NodeId) -> bool {
    let Ok(node) = self.node(id) else {
      return false;
    };
    let Some(parent) = node.parent else {
      return false;
    };
    if node
      .children
      .as_ref()
      .is_some_and(|children| !children.is_empty())
    {
      return false;
    }
    let key = fold(&node.name);
    let opens = node.opens;
    if let Ok(parent) = self.node_mut(parent) {
      if let Some(children) = parent.children.as_mut() {
        children.remove(&key);
      }
    }
    if let Ok(node) = self.node_mut(id) {
      node.parent = None;
    }
    if opens == 0 {
      self.release(id);
    }
    true
  }

  pub fn rename(&mut self, id: NodeId, new_path: &[u16], replace: bool) -> FsResult<()> {
    let (parent_path, name) = split_parent(new_path)?;
    check_name(name)?;
    let new_parent = self.lookup_dir(parent_path)?;
    let node = self.node(id)?;
    let old_parent = node.parent.ok_or(FsError::NotFound)?;
    let old_key = fold(&node.name);
    if node.is_dir() {
      let mut ancestor = Some(new_parent);
      while let Some(current) = ancestor {
        if current == id {
          return Err(FsError::InvalidParameter);
        }
        ancestor = self.node(current)?.parent;
      }
    }

    let key = fold(name);
    let existing = self
      .node(new_parent)?
      .children
      .as_ref()
      .and_then(|children| children.get(&key).copied());
    if let Some(existing) = existing.filter(|&existing| existing != id) {
      if !replace {
        return Err(FsError::NameCollision);
      }
      let target = self.node(existing)?;
      if target.is_dir() || target.attributes & ATTR_READONLY != 0 {
        return Err(FsError::AccessDenied);
      }
      self.unlink(existing);
    }

    if let Some(children) = self.node_mut(old_parent)?.children.as_mut() {
      children.remove(&old_key);
    }
    if let Some(children) = self.node_mut(new_parent)?.children.as_mut() {
      children.insert(key, id);
    }
    let node = self.node_mut(id)?;
    node.parent = Some(new_parent);
    node.name = name.to_vec();
    node.change_time = now();
    Ok(())
  }

  /// Visit a directory's entries in case-insensitive order: `.` and `..`
  /// first (not in the root), then the children. With a marker, start after
  /// the entry of that name. `visit` returns false to stop.
  pub fn for_each_entry(
    &self,
    dir: NodeId,
    marker: Option<&[u16]>,
    mut visit: impl FnMut(&[u16], Info) -> bool,
  ) -> FsResult<()> {
    let node = self.node(dir)?;
    let children = node.children.as_ref().ok_or(FsError::NotADirectory)?;
    let (dot, dot_dot, after) = match marker {
      None => (true, true, None),
      Some(m) if m == DOT => (false, true, None),
      Some(m) if m == DOT_DOT => (false, false, None),
      Some(m) => (false, false, Some(fold(m))),
    };
    if dir != ROOT {
      if dot && !visit(DOT, self.info(dir)?) {
        return Ok(());
      }
      if dot_dot && !visit(DOT_DOT, self.info(node.parent.unwrap_or(dir))?) {
        return Ok(());
      }
    }
    let start = match &after {
      Some(key) => Bound::Excluded(key.as_slice()),
      None => Bound::Unbounded,
    };
    for (_, &child) in children.range::<[u16], _>((start, Bound::Unbounded)) {
      if !visit(&self.node(child)?.name, self.info(child)?) {
        break;
      }
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn w(path: &str) -> Vec<u16> {
    path.encode_utf16().collect()
  }

  fn tree() -> Tree {
    Tree::new(1 << 20, b"root-sd".to_vec())
  }

  fn file(tree: &mut Tree, path: &str) -> NodeId {
    tree.create(&w(path), false, 0, b"sd".to_vec(), 0).unwrap()
  }

  fn dir(tree: &mut Tree, path: &str) -> NodeId {
    tree.create(&w(path), true, 0, b"sd".to_vec(), 0).unwrap()
  }

  fn names(tree: &Tree, id: NodeId, marker: Option<&str>) -> Vec<String> {
    let marker = marker.map(w);
    let mut out = Vec::new();
    tree
      .for_each_entry(id, marker.as_deref(), |name, _| {
        out.push(String::from_utf16_lossy(name));
        true
      })
      .unwrap();
    out
  }

  fn read_all(tree: &Tree, id: NodeId) -> Vec<u8> {
    let size = tree.info(id).unwrap().file_size as usize;
    let mut out = vec![0; size];
    if size > 0 {
      assert_eq!(tree.read(id, 0, &mut out).unwrap(), size);
    }
    out
  }

  #[test]
  fn names_match_without_case_and_keep_their_case() {
    let mut tree = tree();
    let dir_id = dir(&mut tree, "\\Default");
    let id = file(&mut tree, "\\Default\\Cookies-Journal");
    assert_eq!(tree.lookup(&w("\\DEFAULT\\cookies-journal")), Ok(id));
    assert_eq!(tree.lookup(&w("\\")), Ok(ROOT));
    assert_eq!(
      String::from_utf16_lossy(&tree.full_path(id).unwrap()),
      "\\Default\\Cookies-Journal"
    );
    assert_eq!(tree.full_path(ROOT).unwrap(), w("\\"));
    assert_eq!(
      tree.create(&w("\\default\\COOKIES-journal"), false, 0, Vec::new(), 0),
      Err(FsError::NameCollision)
    );
    assert_eq!(
      tree.lookup(&w("\\Default\\Missing")),
      Err(FsError::NotFound)
    );
    assert_eq!(tree.lookup(&w("\\Missing\\x")), Err(FsError::PathNotFound));
    assert_eq!(
      tree.lookup(&w("\\Default\\Cookies-Journal\\x")),
      Err(FsError::PathNotFound)
    );
    assert_eq!(fold(&w("straße ÄÖ")), w("STRAßE ÄÖ"));
    assert!(tree.is_dir(dir_id).unwrap());
  }

  #[test]
  fn create_refuses_bad_names_and_missing_parents() {
    let mut tree = tree();
    file(&mut tree, "\\file");
    for (path, error) in [
      ("\\missing\\x", FsError::PathNotFound),
      ("\\file\\x", FsError::PathNotFound),
      ("\\", FsError::NameInvalid),
      ("\\..", FsError::NameInvalid),
    ] {
      assert_eq!(
        tree.create(&w(path), false, 0, Vec::new(), 0),
        Err(error),
        "{path}"
      );
    }
    let long = format!("\\{}", "a".repeat(MAX_NAME_LEN + 1));
    assert_eq!(
      tree.create(&w(&long), false, 0, Vec::new(), 0),
      Err(FsError::NameInvalid)
    );
  }

  #[test]
  fn writes_extend_reads_stop_at_the_end_and_paging_writes_never_extend() {
    let mut tree = tree();
    let id = file(&mut tree, "\\data");
    assert_eq!(tree.write(id, 0, b"hello", false, false), Ok(5));
    assert_eq!(tree.write(id, 8, b"world", false, false), Ok(5));
    assert_eq!(read_all(&tree, id), b"hello\0\0\0world");
    assert_eq!(tree.write(id, 0, b"!", true, false), Ok(1));
    assert_eq!(read_all(&tree, id), b"hello\0\0\0world!");

    let mut out = [0u8; 4];
    assert_eq!(tree.read(id, 12, &mut out), Ok(2));
    assert_eq!(&out[..2], b"d!");
    assert_eq!(tree.read(id, 14, &mut out), Err(FsError::EndOfFile));

    assert_eq!(tree.write(id, 12, b"XYZ", false, true), Ok(2));
    assert_eq!(tree.write(id, 20, b"XYZ", false, true), Ok(0));
    assert_eq!(read_all(&tree, id), b"hello\0\0\0worlXY");
  }

  #[test]
  fn space_is_charged_by_allocation_and_given_back() {
    let mut tree = Tree::new(4096, Vec::new());
    let id = file(&mut tree, "\\a");
    tree.write(id, 0, &[7; 1000], false, false).unwrap();
    assert_eq!(tree.info(id).unwrap().allocation_size, 1024);
    tree.write(id, 1000, &[7; 100], false, false).unwrap();
    let info = tree.info(id).unwrap();
    assert_eq!(info.file_size, 1100);
    assert_eq!(info.allocation_size, 1536);
    // The memory held has spare room for more appends, and is what counts.
    assert_eq!(tree.used(), 2048);
    assert_eq!(tree.free(), 4096 - 2048);

    tree.trim_allocation(id).unwrap();
    assert_eq!(tree.info(id).unwrap().allocation_size, 1536);
    assert_eq!(tree.used(), 1536);
    assert_eq!(read_all(&tree, id), vec![7; 1100]);

    tree.set_file_size(id, 100).unwrap();
    assert_eq!(read_all(&tree, id), vec![7; 100]);
    tree.set_file_size(id, 200).unwrap();
    let mut expected = vec![7; 100];
    expected.resize(200, 0);
    assert_eq!(read_all(&tree, id), expected);

    tree.set_allocation_size(id, 0).unwrap();
    assert_eq!(tree.info(id).unwrap().file_size, 0);
    assert_eq!(tree.used(), 0);
  }

  #[test]
  fn small_extensions_get_spare_room_until_the_last_close() {
    let mut tree = tree();
    let id = file(&mut tree, "\\LOG");
    for size in (512..=66048).step_by(512) {
      tree.set_file_size(id, size).unwrap();
    }
    assert_eq!(tree.info(id).unwrap().allocation_size, 66048);
    // The room doubled as the file grew, so the data moved a few times, not
    // once per extension.
    assert_eq!(tree.used(), 131072);
    tree.trim_allocation(id).unwrap();
    assert_eq!(tree.used(), 66048);
  }

  #[test]
  fn a_full_volume_refuses_growth_but_uses_the_last_bytes() {
    let mut tree = Tree::new(2048, Vec::new());
    let id = file(&mut tree, "\\a");
    tree.write(id, 0, &[1; 1500], false, false).unwrap();
    // Spare room would pass the cap, so the file gets exactly what it needs.
    tree.write(id, 1500, &[2; 548], false, false).unwrap();
    assert_eq!(tree.used(), 2048);
    assert_eq!(tree.free(), 0);
    assert_eq!(
      tree.write(id, 2048, &[3; 1], false, false),
      Err(FsError::DiskFull)
    );
    assert_eq!(
      tree.create(&w("\\b"), false, 0, Vec::new(), 512),
      Err(FsError::DiskFull)
    );
    assert_eq!(tree.info(id).unwrap().file_size, 2048);
  }

  #[test]
  fn overwrite_empties_the_file_and_resets_its_attributes() {
    let mut tree = tree();
    let id = file(&mut tree, "\\a");
    tree.write(id, 0, &[1; 3000], false, false).unwrap();
    tree
      .set_basic(
        id,
        BasicInfo {
          attributes: Some(ATTR_READONLY),
          ..Default::default()
        },
      )
      .unwrap();
    tree.overwrite(id, 0x2, false, 0).unwrap();
    let info = tree.info(id).unwrap();
    assert_eq!(info.file_size, 0);
    assert_eq!(info.allocation_size, 0);
    assert_eq!(info.attributes, ATTR_READONLY | 0x2 | ATTR_ARCHIVE);
    assert_eq!(tree.used(), 0);

    tree.overwrite(id, 0, true, 1000).unwrap();
    let info = tree.info(id).unwrap();
    assert_eq!(info.attributes, ATTR_ARCHIVE);
    assert_eq!(info.allocation_size, 1024);
  }

  #[test]
  fn attributes_follow_the_node_kind() {
    let mut tree = tree();
    let dir_id = dir(&mut tree, "\\d");
    let id = file(&mut tree, "\\f");
    assert_eq!(tree.info(dir_id).unwrap().attributes, ATTR_DIRECTORY);
    assert_eq!(tree.info(id).unwrap().attributes, ATTR_ARCHIVE);
    for target in [dir_id, id] {
      tree
        .set_basic(
          target,
          BasicInfo {
            attributes: Some(ATTR_NORMAL),
            last_write_time: Some(42),
            ..Default::default()
          },
        )
        .unwrap();
    }
    assert_eq!(tree.info(dir_id).unwrap().attributes, ATTR_DIRECTORY);
    assert_eq!(tree.info(id).unwrap().attributes, ATTR_NORMAL);
    assert_eq!(tree.info(id).unwrap().last_write_time, 42);
    tree.touch(id, false, true, false, true).unwrap();
    assert_eq!(tree.info(id).unwrap().attributes, ATTR_ARCHIVE);
    assert!(tree.info(id).unwrap().last_write_time > 42);
  }

  #[test]
  fn an_unlinked_file_stays_readable_until_its_last_handle_closes() {
    let mut tree = tree();
    let id = file(&mut tree, "\\LOCK");
    tree.write(id, 0, b"locked", false, false).unwrap();
    tree.open(id).unwrap();
    assert!(tree.unlink(id));
    assert_eq!(tree.lookup(&w("\\LOCK")), Err(FsError::NotFound));
    assert_eq!(read_all(&tree, id), b"locked");

    let again = file(&mut tree, "\\lock");
    assert_ne!(again, id);
    tree.close(id);
    assert_eq!(read_all(&tree, id), b"locked");
    tree.close(id);
    assert_eq!(tree.info(id), Err(FsError::InvalidParameter));
    assert_eq!(tree.used(), tree.info(again).unwrap().allocation_size);
  }

  #[test]
  fn deletes_check_children_and_the_read_only_flag() {
    let mut tree = tree();
    let parent = dir(&mut tree, "\\d");
    let child = file(&mut tree, "\\d\\f");
    assert_eq!(tree.can_delete(parent), Err(FsError::DirectoryNotEmpty));
    assert!(!tree.unlink(parent));
    assert_eq!(tree.can_delete(ROOT), Err(FsError::AccessDenied));
    tree
      .set_basic(
        child,
        BasicInfo {
          attributes: Some(ATTR_READONLY),
          ..Default::default()
        },
      )
      .unwrap();
    assert_eq!(tree.can_delete(child), Err(FsError::CannotDelete));

    tree.close(child);
    assert!(tree.unlink(child));
    assert_eq!(tree.info(child), Err(FsError::InvalidParameter));
    assert_eq!(tree.can_delete(parent), Ok(()));
    assert!(tree.unlink(parent));
    assert_eq!(names(&tree, ROOT, None), Vec::<String>::new());
  }

  #[test]
  fn rename_moves_replaces_and_changes_case() {
    let mut tree = tree();
    dir(&mut tree, "\\a");
    dir(&mut tree, "\\b");
    let temp = file(&mut tree, "\\a\\Preferences.tmp");
    tree.write(temp, 0, b"new", false, false).unwrap();
    let old = file(&mut tree, "\\b\\Preferences");
    tree.write(old, 0, b"old", false, false).unwrap();

    assert_eq!(
      tree.rename(temp, &w("\\b\\preferences"), false),
      Err(FsError::NameCollision)
    );
    tree.rename(temp, &w("\\b\\Preferences"), true).unwrap();
    assert_eq!(tree.lookup(&w("\\b\\PREFERENCES")), Ok(temp));
    assert_eq!(
      tree.lookup(&w("\\a\\Preferences.tmp")),
      Err(FsError::NotFound)
    );
    // The replaced file is still open, so it still reads.
    assert_eq!(read_all(&tree, old), b"old");
    tree.close(old);
    assert_eq!(tree.info(old), Err(FsError::InvalidParameter));

    tree.rename(temp, &w("\\b\\PREFERENCES"), false).unwrap();
    assert_eq!(
      names(&tree, tree.lookup(&w("\\b")).unwrap(), None)[2],
      "PREFERENCES"
    );

    assert_eq!(
      tree.rename(temp, &w("\\missing\\x"), false),
      Err(FsError::PathNotFound)
    );
    let used = tree.used();
    tree.close(temp);
    assert_eq!(tree.used(), used);
  }

  #[test]
  fn a_directory_moves_with_its_open_children() {
    let mut tree = tree();
    let parent = dir(&mut tree, "\\Default");
    let child = file(&mut tree, "\\Default\\History");
    tree.write(child, 0, b"visits", false, false).unwrap();
    tree.rename(parent, &w("\\Profile 1"), false).unwrap();
    assert_eq!(read_all(&tree, child), b"visits");
    assert_eq!(tree.lookup(&w("\\profile 1\\HISTORY")), Ok(child));
    assert_eq!(
      tree.lookup(&w("\\Default\\History")),
      Err(FsError::PathNotFound)
    );
    assert_eq!(
      String::from_utf16_lossy(&tree.full_path(child).unwrap()),
      "\\Profile 1\\History"
    );
  }

  #[test]
  fn rename_refuses_to_replace_a_directory_or_move_into_itself() {
    let mut tree = tree();
    let outer = dir(&mut tree, "\\outer");
    dir(&mut tree, "\\outer\\inner");
    let other = file(&mut tree, "\\other");
    assert_eq!(
      tree.rename(other, &w("\\outer"), true),
      Err(FsError::AccessDenied)
    );
    assert_eq!(
      tree.rename(outer, &w("\\outer\\inner\\x"), false),
      Err(FsError::InvalidParameter)
    );
    tree.rename(outer, &w("\\moved"), false).unwrap();
    assert!(tree.lookup(&w("\\moved\\inner")).is_ok());
    assert_eq!(
      String::from_utf16_lossy(
        &tree
          .full_path(tree.lookup(&w("\\moved\\INNER")).unwrap())
          .unwrap()
      ),
      "\\moved\\inner"
    );
  }

  #[test]
  fn listing_is_sorted_without_case_and_resumes_after_a_marker() {
    let mut tree = tree();
    let parent = dir(&mut tree, "\\d");
    for name in ["b", "C", "a", "D"] {
      file(&mut tree, &format!("\\d\\{name}"));
    }
    assert_eq!(names(&tree, parent, None), [".", "..", "a", "b", "C", "D"]);
    assert_eq!(names(&tree, parent, Some(".")), ["..", "a", "b", "C", "D"]);
    assert_eq!(names(&tree, parent, Some("..")), ["a", "b", "C", "D"]);
    assert_eq!(names(&tree, parent, Some("B")), ["C", "D"]);
    // A marker whose entry is gone still resumes in order.
    assert_eq!(names(&tree, parent, Some("bb")), ["C", "D"]);
    assert_eq!(names(&tree, ROOT, None), ["d"]);

    let mut seen = 0;
    tree
      .for_each_entry(parent, None, |_, _| {
        seen += 1;
        seen < 3
      })
      .unwrap();
    assert_eq!(seen, 3);
    let file_id = tree.lookup(&w("\\d\\a")).unwrap();
    assert_eq!(
      tree.for_each_entry(file_id, None, |_, _| true),
      Err(FsError::NotADirectory)
    );
  }

  #[test]
  fn security_descriptors_are_kept_per_node() {
    let mut tree = tree();
    let id = file(&mut tree, "\\Network");
    assert_eq!(tree.security(ROOT).unwrap(), b"root-sd");
    assert_eq!(tree.security(id).unwrap(), b"sd");
    tree.set_security(id, b"with-acl".to_vec()).unwrap();
    assert_eq!(tree.security(id).unwrap(), b"with-acl");
  }

  #[test]
  fn truncation_zeroes_the_cut_bytes() {
    let mut data = Data::with_room(1024);
    data.extend(1024);
    data.bytes.fill(0xAA);
    data.truncate(10);
    // Every byte of the buffer was written above, so all of it may be read.
    let whole = unsafe { std::slice::from_raw_parts(data.bytes.as_ptr(), 1024) };
    assert!(whole[..10].iter().all(|&b| b == 0xAA));
    assert!(whole[10..].iter().all(|&b| b == 0));
  }
}
