//! The chat sync crypto, byte for byte as the web reads it. P-256 ECDH and
//! HKDF-SHA256 wrap the account's chat key for one device; AES-256-GCM seals
//! each chat, gzipped JSON, under the chat key. base64url without padding.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rand::RngExt;
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::hkdf;
use std::io::{Read, Write};

const WRAP_INFO: &[u8] = b"donut-chat/v1 wrap";
/// The most a sealed chat may unpack to; more is not a chat.
const MAX_PLAIN: u64 = 64 << 20;

pub fn b64(bytes: &[u8]) -> String {
  URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
  URL_SAFE_NO_PAD.decode(text).ok()
}

/// The account's chat key and its id.
#[derive(Clone, PartialEq, Eq)]
pub struct ChatKey {
  pub id: String,
  pub key: [u8; 32],
}

impl std::fmt::Debug for ChatKey {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ChatKey").field("id", &self.id).finish()
  }
}

impl ChatKey {
  pub fn mint() -> Self {
    let id: [u8; 16] = rand::rng().random();
    Self {
      id: b64(&id),
      key: rand::rng().random(),
    }
  }

  pub fn from_parts(id: &str, key: &str) -> Option<Self> {
    let key = unb64(key)?.try_into().ok()?;
    Some(Self {
      id: id.to_string(),
      key,
    })
  }

  pub fn key_b64(&self) -> String {
    b64(&self.key)
  }

  fn cipher(&self) -> Aes256Gcm {
    Aes256Gcm::new(&Key::<Aes256Gcm>::from(self.key))
  }
}

/// This device's key pair while it waits for a wrap. The private half opens
/// one wrap and is gone.
pub struct DeviceKey {
  private: EphemeralPrivateKey,
  pub public: String,
}

impl DeviceKey {
  pub fn generate() -> Option<Self> {
    let private =
      EphemeralPrivateKey::generate(&ECDH_P256, &ring::rand::SystemRandom::new()).ok()?;
    Self::from_private(private)
  }

  fn from_private(private: EphemeralPrivateKey) -> Option<Self> {
    let public = b64(private.compute_public_key().ok()?.as_ref());
    Some(Self { private, public })
  }

  /// The chat key in a wrap made for this device.
  pub fn unwrap(self, wrapped: &str, key_id: &str, device_id: &str) -> Option<ChatKey> {
    let mut parts = wrapped.split('.');
    let (Some("v1"), Some(eph), Some(nonce), Some(sealed), None) = (
      parts.next(),
      parts.next(),
      parts.next(),
      parts.next(),
      parts.next(),
    ) else {
      return None;
    };
    let eph = unb64(eph)?;
    let nonce: [u8; 12] = unb64(nonce)?.try_into().ok()?;
    let sealed = unb64(sealed)?;
    let w = agree(self.private, &eph)?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(w));
    let aad = wrap_aad(key_id, device_id);
    let key = cipher
      .decrypt(
        &Nonce::from(nonce),
        Payload {
          msg: &sealed,
          aad: aad.as_bytes(),
        },
      )
      .ok()?;
    Some(ChatKey {
      id: key_id.to_string(),
      key: key.try_into().ok()?,
    })
  }
}

fn wrap_aad(key_id: &str, device_id: &str) -> String {
  format!("donut-chat/v1 wrap|{key_id}|{device_id}")
}

fn chat_aad(chat_id: &str) -> String {
  format!("donut-chat/v1 chat|{chat_id}")
}

struct Len(usize);

impl hkdf::KeyType for Len {
  fn len(&self) -> usize {
    self.0
  }
}

/// The wrapping key both sides derive: HKDF over the ECDH x-coordinate.
fn agree(private: EphemeralPrivateKey, peer_public: &[u8]) -> Option<[u8; 32]> {
  let peer = UnparsedPublicKey::new(&ECDH_P256, peer_public);
  agreement::agree_ephemeral(private, &peer, |z| {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &[]).extract(z);
    let mut w = [0u8; 32];
    prk
      .expand(&[WRAP_INFO], Len(32))
      .and_then(|okm| okm.fill(&mut w))
      .ok()
      .map(|_| w)
  })
  .ok()
  .flatten()
}

/// The chat key, wrapped for device `device_id` whose public key is given.
pub fn wrap(key: &ChatKey, device_id: &str, public_key: &str) -> Option<String> {
  let eph = EphemeralPrivateKey::generate(&ECDH_P256, &ring::rand::SystemRandom::new()).ok()?;
  wrap_with(key, device_id, public_key, eph, rand::rng().random())
}

fn wrap_with(
  key: &ChatKey,
  device_id: &str,
  public_key: &str,
  eph: EphemeralPrivateKey,
  nonce: [u8; 12],
) -> Option<String> {
  let eph_public = b64(eph.compute_public_key().ok()?.as_ref());
  let w = agree(eph, &unb64(public_key)?)?;
  let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(w));
  let aad = wrap_aad(&key.id, device_id);
  let sealed = cipher
    .encrypt(
      &Nonce::from(nonce),
      Payload {
        msg: &key.key,
        aad: aad.as_bytes(),
      },
    )
    .ok()?;
  Some(format!("v1.{eph_public}.{}.{}", b64(&nonce), b64(&sealed)))
}

/// A chat's JSON, gzipped and sealed under the chat key.
pub fn seal_chat(key: &ChatKey, chat_id: &str, json: &[u8]) -> Option<String> {
  let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
  gzip.write_all(json).ok()?;
  seal_plain(key, chat_id, &gzip.finish().ok()?, rand::rng().random())
}

fn seal_plain(key: &ChatKey, chat_id: &str, plain: &[u8], nonce: [u8; 12]) -> Option<String> {
  let aad = chat_aad(chat_id);
  let sealed = key
    .cipher()
    .encrypt(
      &Nonce::from(nonce),
      Payload {
        msg: plain,
        aad: aad.as_bytes(),
      },
    )
    .ok()?;
  Some(format!("v1.{}.{}.{}", key.id, b64(&nonce), b64(&sealed)))
}

/// The JSON of a sealed chat, when it opens under the chat key.
pub fn open_chat(key: &ChatKey, chat_id: &str, data: &str) -> Option<Vec<u8>> {
  let mut parts = data.split('.');
  let (Some("v1"), Some(key_id), Some(nonce), Some(sealed), None) = (
    parts.next(),
    parts.next(),
    parts.next(),
    parts.next(),
    parts.next(),
  ) else {
    return None;
  };
  if key_id != key.id {
    return None;
  }
  let nonce: [u8; 12] = unb64(nonce)?.try_into().ok()?;
  let aad = chat_aad(chat_id);
  let plain = key
    .cipher()
    .decrypt(
      &Nonce::from(nonce),
      Payload {
        msg: &unb64(sealed)?,
        aad: aad.as_bytes(),
      },
    )
    .ok()?;
  let mut json = Vec::new();
  GzDecoder::new(plain.as_slice())
    .take(MAX_PLAIN + 1)
    .read_to_end(&mut json)
    .ok()?;
  (json.len() as u64 <= MAX_PLAIN).then_some(json)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::Value;

  /// The vector the web checks too (infra `apps/web/src/lib/chat-sync/test-vector.json`).
  const VECTOR: &str = include_str!("test-vector.json");

  fn vector() -> Value {
    serde_json::from_str(VECTOR).unwrap()
  }

  fn text<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path
      .iter()
      .fold(v, |v, key| &v[*key])
      .as_str()
      .unwrap_or_else(|| panic!("{path:?}"))
  }

  fn bytes(v: &Value, path: &[&str]) -> Vec<u8> {
    unb64(text(v, path)).unwrap()
  }

  /// A key pair from a known private scalar.
  #[allow(deprecated)]
  fn fixed(d: &[u8]) -> EphemeralPrivateKey {
    EphemeralPrivateKey::generate(&ECDH_P256, &ring::test::rand::FixedSliceRandom { bytes: d })
      .unwrap()
  }

  fn vector_key(v: &Value) -> ChatKey {
    ChatKey::from_parts(text(v, &["keyId"]), text(v, &["chatKey"])).unwrap()
  }

  #[test]
  fn the_test_vector_opens_and_seals_byte_for_byte() {
    let v = vector();
    let key = vector_key(&v);
    let device_id = text(&v, &["deviceId"]);

    // Both sides of the ECDH reach the same wrapping key.
    let wrapping = bytes(&v, &["wrappingKey"]);
    let from_eph = agree(
      fixed(&bytes(&v, &["ephemeral", "d"])),
      &bytes(&v, &["device", "publicKey"]),
    )
    .unwrap();
    let from_device = agree(
      fixed(&bytes(&v, &["device", "d"])),
      &bytes(&v, &["ephemeral", "publicKey"]),
    )
    .unwrap();
    assert_eq!(from_eph.as_slice(), wrapping.as_slice());
    assert_eq!(from_device.as_slice(), wrapping.as_slice());
    assert_eq!(wrap_aad(&key.id, device_id), text(&v, &["wrapAad"]));

    // The wrap comes out exactly as the web made it, and opens back.
    let nonce: [u8; 12] = bytes(&v, &["wrapNonce"]).try_into().unwrap();
    let wrapped = wrap_with(
      &key,
      device_id,
      text(&v, &["device", "publicKey"]),
      fixed(&bytes(&v, &["ephemeral", "d"])),
      nonce,
    )
    .unwrap();
    assert_eq!(wrapped, text(&v, &["wrappedKey"]));
    let device = DeviceKey::from_private(fixed(&bytes(&v, &["device", "d"]))).unwrap();
    assert_eq!(device.public, text(&v, &["device", "publicKey"]));
    assert_eq!(
      device.unwrap(&wrapped, &key.id, device_id),
      Some(key.clone())
    );

    // The chat record: the given gzip bytes seal to `data`, and `data` opens
    // to the chat JSON, which reads as a chat.
    assert_eq!(chat_aad(text(&v, &["chatId"])), text(&v, &["chatAad"]));
    let nonce: [u8; 12] = bytes(&v, &["chatNonce"]).try_into().unwrap();
    let data = seal_plain(
      &key,
      text(&v, &["chatId"]),
      &bytes(&v, &["chatGzip"]),
      nonce,
    )
    .unwrap();
    assert_eq!(data, text(&v, &["data"]));
    let json = open_chat(&key, text(&v, &["chatId"]), &data).unwrap();
    assert_eq!(json, text(&v, &["chatJson"]).as_bytes());
    let chat: crate::agent_tasks::chat::Chat = serde_json::from_slice(&json).unwrap();
    assert_eq!(chat.profile_name.as_deref(), Some("Travel"));
    assert_eq!(chat.turns[0].task.steps.len(), 2);
  }

  #[test]
  fn a_chat_round_trips_and_opens_only_where_it_was_sealed() {
    let key = ChatKey::mint();
    let json = br#"{"id":"a"}"#;
    let data = seal_chat(&key, "chat-a", json).unwrap();
    assert!(data.starts_with(&format!("v1.{}.", key.id)));
    assert_eq!(open_chat(&key, "chat-a", &data).unwrap(), json);
    // Another chat id is another AAD.
    assert_eq!(open_chat(&key, "chat-b", &data), None);
    // Another key with the same id opens nothing.
    let other = ChatKey {
      id: key.id.clone(),
      key: ChatKey::mint().key,
    };
    assert_eq!(open_chat(&other, "chat-a", &data), None);
    // A changed byte fails the tag.
    let mut tampered = data.clone().into_bytes();
    let last = tampered.len() - 2;
    tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
    assert_eq!(
      open_chat(&key, "chat-a", &String::from_utf8(tampered).unwrap()),
      None
    );
    assert_eq!(open_chat(&key, "chat-a", "v1.x.y"), None);
  }

  #[test]
  fn a_wrap_opens_only_for_its_device_and_key_id() {
    let key = ChatKey::mint();
    let device = DeviceKey::generate().unwrap();
    let wrapped = wrap(&key, "dev-1", &device.public).unwrap();
    assert!(wrapped.starts_with("v1."));
    assert_eq!(wrapped.split('.').count(), 4);
    assert_eq!(
      DeviceKey::generate()
        .unwrap()
        .unwrap(&wrapped, &key.id, "dev-1"),
      None,
      "another device's private key"
    );
    let public = device.public.clone();
    assert_eq!(device.unwrap(&wrapped, &key.id, "dev-2"), None, "wrong AAD");
    let device = DeviceKey::generate().unwrap();
    let wrapped = wrap(&key, "dev-1", &device.public).unwrap();
    assert_ne!(device.public, public);
    assert_eq!(device.unwrap(&wrapped, "other-key-id", "dev-1"), None);
    let device = DeviceKey::generate().unwrap();
    let wrapped = wrap(&key, "dev-1", &device.public).unwrap();
    assert_eq!(device.unwrap(&wrapped, &key.id, "dev-1"), Some(key));
    assert!(wrap(&ChatKey::mint(), "dev-1", "not-a-point").is_none());
  }
}
