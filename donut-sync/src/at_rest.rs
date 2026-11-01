//! Encryption at rest with the server's own key (`SYNC_AT_REST_KEY`).
//!
//! An encrypted object is a header and a run of AES-256-GCM frames:
//!
//! ```text
//! "DSAR" | version (1) | key id length (1) | key id | salt (32)
//! frame 0 | frame 1 | ... | final frame
//! ```
//!
//! Each frame holds up to `FRAME` plaintext bytes and a 16-byte tag. The
//! object key is HKDF-SHA256 of the server key and the object's random salt;
//! a frame's nonce is its index and a final flag, so frames cannot be dropped,
//! reordered or cut off at a frame boundary. Every frame authenticates the
//! header. Only the last frame may be short; an empty object is one empty
//! final frame. The object's metadata carries `MARKER` (`1:<key id>`), so a
//! HEAD tells an encrypted object from a plaintext one and gives its
//! plaintext size.

use std::collections::VecDeque;
use std::sync::Arc;

use base64::Engine;
use bytes::Bytes;
use futures_util::StreamExt;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::hkdf;

use crate::store::{ByteStream, StoreError};

/// The user-metadata name (`x-amz-meta-donut-at-rest`) of an encrypted object.
pub const MARKER: &str = "donut-at-rest";
const MAGIC: &[u8; 4] = b"DSAR";
const VERSION: u8 = 1;
/// Plaintext bytes per frame.
pub const FRAME: usize = 64 * 1024;
const TAG: usize = 16;
const SALT: usize = 32;
const MAX_KEY_ID: usize = 32;
const OBJECT_KEY_INFO: &[u8] = b"donut-sync at-rest v1 object key";
const URL_KEY_INFO: &[u8] = b"donut-sync at-rest v1 transfer url";

pub struct Key {
  id: String,
  secret: [u8; 32],
}

impl Key {
  pub fn id(&self) -> &str {
    &self.id
  }
}

/// The server keys. The first one encrypts; all of them decrypt.
pub struct Keyring {
  keys: Vec<Key>,
}

fn key_id_valid(id: &str) -> bool {
  (1..=MAX_KEY_ID).contains(&id.len())
    && id
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

impl Keyring {
  /// `id:base64,id:base64`, each key 32 bytes.
  pub fn parse(value: &str) -> Result<Self, String> {
    let mut keys: Vec<Key> = Vec::new();
    for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
      let (id, encoded) = entry
        .split_once(':')
        .ok_or("SYNC_AT_REST_KEY entries are id:base64, e.g. k1:$(openssl rand -base64 32)")?;
      if !key_id_valid(id) {
        return Err(format!(
          "SYNC_AT_REST_KEY key id '{id}' must be 1-{MAX_KEY_ID} letters, digits, '-', '_' or '.'"
        ));
      }
      if keys.iter().any(|k| k.id == id) {
        return Err(format!("SYNC_AT_REST_KEY names key id '{id}' twice"));
      }
      let unpadded = encoded.trim().trim_end_matches('=');
      let decoded = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(unpadded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(unpadded))
        .map_err(|_| format!("SYNC_AT_REST_KEY key '{id}' is not base64"))?;
      let secret: [u8; 32] = decoded
        .try_into()
        .map_err(|_| format!("SYNC_AT_REST_KEY key '{id}' must be 32 bytes"))?;
      keys.push(Key {
        id: id.to_string(),
        secret,
      });
    }
    if keys.is_empty() {
      return Err("SYNC_AT_REST_KEY holds no key".to_string());
    }
    Ok(Self { keys })
  }

  pub fn key_count(&self) -> usize {
    self.keys.len()
  }

  pub fn current(&self) -> &Key {
    &self.keys[0]
  }

  pub fn holds(&self, id: &str) -> bool {
    self.find(id).is_some()
  }

  fn find(&self, id: &str) -> Option<&Key> {
    self.keys.iter().find(|k| k.id == id)
  }

  /// The HMAC keys that sign transfer URLs: the current key's first.
  pub fn url_keys(&self) -> Vec<[u8; 32]> {
    self
      .keys
      .iter()
      .map(|key| derive(&key.secret, &[0; SALT], URL_KEY_INFO))
      .collect()
  }

  /// The marker value an object sealed now carries.
  pub fn marker(&self) -> String {
    format!("{VERSION}:{}", self.current().id)
  }
}

struct Len(usize);

impl hkdf::KeyType for Len {
  fn len(&self) -> usize {
    self.0
  }
}

fn derive(secret: &[u8; 32], salt: &[u8], info: &[u8]) -> [u8; 32] {
  let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(secret);
  let mut out = [0u8; 32];
  prk
    .expand(&[info], Len(32))
    .and_then(|okm| okm.fill(&mut out))
    .expect("32 bytes is a valid HKDF-SHA256 length");
  out
}

fn object_key(secret: &[u8; 32], salt: &[u8]) -> LessSafeKey {
  let key = derive(secret, salt, OBJECT_KEY_INFO);
  LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).expect("32 bytes is an AES-256 key"))
}

fn nonce(index: u64, last: bool) -> Nonce {
  let mut bytes = [0u8; 12];
  bytes[3..11].copy_from_slice(&index.to_be_bytes());
  bytes[11] = u8::from(last);
  Nonce::assume_unique_for_key(bytes)
}

fn header_len(key_id: &str) -> u64 {
  (MAGIC.len() + 2 + key_id.len() + SALT) as u64
}

fn frames(plain: u64) -> u64 {
  plain.div_ceil(FRAME as u64).max(1)
}

/// The stored size of `plain` bytes sealed under `key_id`.
pub fn sealed_len(key_id: &str, plain: u64) -> u64 {
  header_len(key_id) + plain + frames(plain) * TAG as u64
}

/// The plaintext size of a sealed object of `sealed` bytes, or `None` when no
/// sealed object has that size.
pub fn plain_len(key_id: &str, sealed: u64) -> Option<u64> {
  let body = sealed.checked_sub(header_len(key_id))?;
  let full = (FRAME + TAG) as u64;
  let (count, rest) = (body / full, body % full);
  match rest {
    0 if count > 0 => Some(count * FRAME as u64),
    rest if rest >= TAG as u64 => Some(count * FRAME as u64 + rest - TAG as u64),
    _ => None,
  }
}

/// The key id a marker value names, for this format version.
pub fn marker_key_id(marker: &str) -> Option<&str> {
  marker
    .strip_prefix(&format!("{VERSION}:"))
    .filter(|id| key_id_valid(id))
}

fn corrupt(message: &str) -> StoreError {
  StoreError::Corrupt(message.to_string())
}

/// Encrypts a byte stream, frame by frame.
pub struct Sealer {
  key: LessSafeKey,
  header: Vec<u8>,
  index: u64,
  pending: Vec<u8>,
}

impl Sealer {
  /// A sealer and the header that starts its output.
  pub fn new(keyring: &Keyring) -> (Self, Bytes) {
    let current = keyring.current();
    let mut salt = [0u8; SALT];
    rand::fill(&mut salt);
    let mut header = Vec::with_capacity(header_len(&current.id) as usize);
    header.extend_from_slice(MAGIC);
    header.push(VERSION);
    header.push(current.id.len() as u8);
    header.extend_from_slice(current.id.as_bytes());
    header.extend_from_slice(&salt);
    let sealer = Self {
      key: object_key(&current.secret, &salt),
      header: header.clone(),
      index: 0,
      pending: Vec::new(),
    };
    (sealer, Bytes::from(header))
  }

  fn seal(&mut self, mut frame: Vec<u8>, last: bool) -> Bytes {
    self
      .key
      .seal_in_place_append_tag(nonce(self.index, last), Aad::from(&self.header), &mut frame)
      .expect("a frame is far below the AES-GCM limit");
    self.index += 1;
    Bytes::from(frame)
  }

  /// Seals every full frame that is known not to be the last.
  pub fn push(&mut self, data: &[u8], out: &mut VecDeque<Bytes>) {
    self.pending.extend_from_slice(data);
    while self.pending.len() > FRAME {
      let rest = self.pending.split_off(FRAME);
      let frame = std::mem::replace(&mut self.pending, rest);
      out.push_back(self.seal(frame, false));
    }
  }

  pub fn finish(mut self) -> Bytes {
    let frame = std::mem::take(&mut self.pending);
    self.seal(frame, true)
  }
}

/// Decrypts a sealed byte stream, frame by frame.
pub struct Opener {
  keyring: Arc<Keyring>,
  key: Option<(LessSafeKey, Vec<u8>)>,
  index: u64,
  pending: Vec<u8>,
}

impl Opener {
  pub fn new(keyring: Arc<Keyring>) -> Self {
    Self {
      keyring,
      key: None,
      index: 0,
      pending: Vec::new(),
    }
  }

  fn read_header(&mut self) -> Result<bool, StoreError> {
    if self.pending.len() < MAGIC.len() + 2 {
      return Ok(false);
    }
    if &self.pending[..MAGIC.len()] != MAGIC {
      return Err(corrupt("sealed object has no header"));
    }
    if self.pending[MAGIC.len()] != VERSION {
      return Err(corrupt("sealed object has an unknown version"));
    }
    let id_len = self.pending[MAGIC.len() + 1] as usize;
    let total = MAGIC.len() + 2 + id_len + SALT;
    if self.pending.len() < total {
      return Ok(false);
    }
    let id = std::str::from_utf8(&self.pending[MAGIC.len() + 2..MAGIC.len() + 2 + id_len])
      .map_err(|_| corrupt("sealed object has an invalid key id"))?;
    let key = self
      .keyring
      .find(id)
      .ok_or_else(|| StoreError::Corrupt(format!("sealed object needs unknown key id '{id}'")))?;
    let key = object_key(&key.secret, &self.pending[total - SALT..total]);
    let rest = self.pending.split_off(total);
    let header = std::mem::replace(&mut self.pending, rest);
    self.key = Some((key, header));
    Ok(true)
  }

  fn open(&mut self, mut frame: Vec<u8>, last: bool) -> Result<Bytes, StoreError> {
    let (key, header) = self.key.as_ref().expect("the header is read first");
    let plain = key
      .open_in_place(nonce(self.index, last), Aad::from(header), &mut frame)
      .map_err(|_| corrupt("sealed object failed authentication"))?
      .len();
    frame.truncate(plain);
    self.index += 1;
    Ok(Bytes::from(frame))
  }

  pub fn push(&mut self, data: &[u8], out: &mut VecDeque<Bytes>) -> Result<(), StoreError> {
    self.pending.extend_from_slice(data);
    if self.key.is_none() && !self.read_header()? {
      return Ok(());
    }
    while self.pending.len() > FRAME + TAG {
      let rest = self.pending.split_off(FRAME + TAG);
      let frame = std::mem::replace(&mut self.pending, rest);
      out.push_back(self.open(frame, false)?);
    }
    Ok(())
  }

  pub fn finish(mut self) -> Result<Bytes, StoreError> {
    if self.key.is_none() && !self.read_header()? {
      return Err(corrupt("sealed object is cut off in its header"));
    }
    if self.pending.len() < TAG {
      return Err(corrupt("sealed object is cut off"));
    }
    let frame = std::mem::take(&mut self.pending);
    self.open(frame, true)
  }
}

enum Codec {
  Seal(Option<Sealer>, Option<Bytes>),
  Open(Option<Opener>),
}

impl Codec {
  fn push(&mut self, data: &[u8], out: &mut VecDeque<Bytes>) -> Result<(), StoreError> {
    match self {
      Codec::Seal(sealer, header) => {
        if let Some(header) = header.take() {
          out.push_back(header);
        }
        sealer.as_mut().expect("not finished").push(data, out);
        Ok(())
      }
      Codec::Open(opener) => opener.as_mut().expect("not finished").push(data, out),
    }
  }

  fn finish(&mut self, out: &mut VecDeque<Bytes>) -> Result<(), StoreError> {
    match self {
      Codec::Seal(sealer, header) => {
        if let Some(header) = header.take() {
          out.push_back(header);
        }
        out.push_back(sealer.take().expect("finished once").finish());
        Ok(())
      }
      Codec::Open(opener) => {
        out.push_back(opener.take().expect("finished once").finish()?);
        Ok(())
      }
    }
  }
}

fn transform(input: ByteStream, codec: Codec) -> ByteStream {
  struct State {
    input: ByteStream,
    codec: Codec,
    out: VecDeque<Bytes>,
    done: bool,
  }
  let state = State {
    input,
    codec,
    out: VecDeque::new(),
    done: false,
  };
  Box::pin(futures_util::stream::unfold(
    state,
    |mut state| async move {
      loop {
        if let Some(chunk) = state.out.pop_front() {
          if chunk.is_empty() {
            continue;
          }
          return Some((Ok(chunk), state));
        }
        if state.done {
          return None;
        }
        let step = match state.input.next().await {
          Some(Ok(data)) => state.codec.push(&data, &mut state.out),
          Some(Err(e)) => Err(e),
          None => {
            state.done = true;
            state.codec.finish(&mut state.out)
          }
        };
        if let Err(e) = step {
          state.done = true;
          state.out.clear();
          return Some((Err(e), state));
        }
      }
    },
  ))
}

/// `input` sealed under the current key.
pub fn seal_stream(keyring: &Keyring, input: ByteStream) -> ByteStream {
  let (sealer, header) = Sealer::new(keyring);
  transform(input, Codec::Seal(Some(sealer), Some(header)))
}

/// `input`, a sealed object, opened. A forged, cut or wrongly keyed object
/// ends the stream with `StoreError::Corrupt`.
pub fn open_stream(keyring: Arc<Keyring>, input: ByteStream) -> ByteStream {
  transform(input, Codec::Open(Some(Opener::new(keyring))))
}

pub fn seal(keyring: &Keyring, plain: &[u8]) -> Vec<u8> {
  let (mut sealer, header) = Sealer::new(keyring);
  let mut out = VecDeque::from([header]);
  sealer.push(plain, &mut out);
  out.push_back(sealer.finish());
  out.into_iter().flat_map(|b| b.to_vec()).collect()
}

pub fn open(keyring: Arc<Keyring>, sealed: &[u8]) -> Result<Vec<u8>, StoreError> {
  let mut opener = Opener::new(keyring);
  let mut out = VecDeque::new();
  opener.push(sealed, &mut out)?;
  out.push_back(opener.finish()?);
  Ok(out.into_iter().flat_map(|b| b.to_vec()).collect())
}

#[cfg(test)]
#[path = "at_rest_tests.rs"]
mod tests;
