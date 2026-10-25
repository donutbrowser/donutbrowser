//! RS256 tokens: the sync tokens Donut's backend issues for its own sync
//! server. Verification follows the `jsonwebtoken` package the server used: the
//! header must name RS256, keys are at least 2048 bits, there is no clock
//! leeway, `exp` and `nbf` are checked only when present, and the audience is
//! not checked.

use base64::Engine;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use serde_json::{Map, Value};

/// An RSA public key as PKCS#1 `RSAPublicKey` DER.
#[derive(Clone, Debug)]
pub struct PublicKey(Vec<u8>);

/// The body of the first PEM block, and its label.
pub fn pem_decode(pem: &str) -> Result<(String, Vec<u8>), String> {
  let begin = pem.find("-----BEGIN ").ok_or("no PEM block")?;
  let rest = &pem[begin + "-----BEGIN ".len()..];
  let label_end = rest.find("-----").ok_or("unterminated PEM header")?;
  let label = rest[..label_end].to_string();
  let body_and_rest = &rest[label_end + 5..];
  let footer = format!("-----END {label}-----");
  let body_end = body_and_rest.find(&footer).ok_or("no PEM footer")?;
  let body: String = body_and_rest[..body_end]
    .chars()
    .filter(|c| !c.is_whitespace())
    .collect();
  let der = base64::engine::general_purpose::STANDARD
    .decode(body)
    .map_err(|e| format!("PEM body is not base64: {e}"))?;
  Ok((label, der))
}

/// One DER element: its tag, its content and what follows it.
fn der(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
  let (&tag, rest) = input.split_first()?;
  let (&first, rest) = rest.split_first()?;
  let (length, rest) = if first < 0x80 {
    (usize::from(first), rest)
  } else {
    let bytes = usize::from(first & 0x7f);
    if bytes == 0 || bytes > 4 || rest.len() < bytes {
      return None;
    }
    let length = rest[..bytes]
      .iter()
      .fold(0usize, |acc, &b| (acc << 8) | usize::from(b));
    (length, &rest[bytes..])
  };
  (rest.len() >= length).then(|| (tag, &rest[..length], &rest[length..]))
}

const SEQUENCE: u8 = 0x30;
const BIT_STRING: u8 = 0x03;
const OBJECT_ID: u8 = 0x06;
/// 1.2.840.113549.1.1.1
const RSA_ENCRYPTION: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/// The PKCS#1 key inside a `SubjectPublicKeyInfo`.
fn from_spki(spki: &[u8]) -> Result<Vec<u8>, String> {
  let (tag, content, _) = der(spki).ok_or("malformed public key")?;
  if tag != SEQUENCE {
    return Err("malformed public key".to_string());
  }
  let (tag, algorithm, rest) = der(content).ok_or("malformed public key")?;
  let (oid_tag, oid, _) = der(algorithm).ok_or("malformed public key")?;
  if tag != SEQUENCE || oid_tag != OBJECT_ID || oid != RSA_ENCRYPTION {
    return Err("the public key is not an RSA key".to_string());
  }
  let (tag, bits, _) = der(rest).ok_or("malformed public key")?;
  match (tag, bits.split_first()) {
    (BIT_STRING, Some((0, key))) => Ok(key.to_vec()),
    _ => Err("malformed public key".to_string()),
  }
}

/// The `SubjectPublicKeyInfo` of an X.509 certificate.
fn spki_of_certificate(certificate: &[u8]) -> Result<&[u8], String> {
  let malformed = || "malformed certificate".to_string();
  let (_, content, _) = der(certificate).ok_or_else(malformed)?;
  let (_, mut tbs, _) = der(content).ok_or_else(malformed)?;
  // An explicit version comes first when present.
  if tbs.first() == Some(&0xa0) {
    tbs = der(tbs).ok_or_else(malformed)?.2;
  }
  // serialNumber, signature, issuer, validity, subject.
  for _ in 0..5 {
    tbs = der(tbs).ok_or_else(malformed)?.2;
  }
  let (_, _, after) = der(tbs).ok_or_else(malformed)?;
  Ok(&tbs[..tbs.len() - after.len()])
}

impl PublicKey {
  /// A PEM `PUBLIC KEY`, `RSA PUBLIC KEY` or `CERTIFICATE`.
  pub fn from_pem(pem: &str) -> Result<Self, String> {
    let (label, body) = pem_decode(pem)?;
    let pkcs1 = match label.as_str() {
      "PUBLIC KEY" => from_spki(&body)?,
      "RSA PUBLIC KEY" => body,
      "CERTIFICATE" => from_spki(spki_of_certificate(&body)?)?,
      other => return Err(format!("unsupported key type: {other}")),
    };
    Ok(Self(pkcs1))
  }
}

fn b64url(part: &str) -> Result<Vec<u8>, String> {
  base64::engine::general_purpose::URL_SAFE_NO_PAD
    .decode(part.trim_end_matches('='))
    .map_err(|_| "jwt malformed".to_string())
}

/// The claims of a valid token, or why it is not one.
pub fn verify_rs256(token: &str, key: &PublicKey) -> Result<Map<String, Value>, String> {
  let parts: Vec<&str> = token.split('.').collect();
  let [header, payload, signature] = parts[..] else {
    return Err("jwt malformed".to_string());
  };
  let header: Value =
    serde_json::from_slice(&b64url(header)?).map_err(|_| "invalid token".to_string())?;
  if header.get("alg").and_then(Value::as_str) != Some("RS256") {
    return Err("invalid algorithm".to_string());
  }
  let signature = b64url(signature)?;
  UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &key.0)
    .verify(format!("{}.{}", parts[0], payload).as_bytes(), &signature)
    .map_err(|_| "invalid signature".to_string())?;
  let Ok(Value::Object(claims)) = serde_json::from_slice::<Value>(&b64url(payload)?) else {
    return Err("jwt payload is not an object".to_string());
  };
  let now = crate::time::now_ms().div_euclid(1000) as f64;
  if let Some(nbf) = claims.get("nbf") {
    let nbf = nbf.as_f64().ok_or("invalid nbf value")?;
    if nbf > now {
      return Err("jwt not active".to_string());
    }
  }
  if let Some(exp) = claims.get("exp") {
    let exp = exp.as_f64().ok_or("invalid exp value")?;
    if now >= exp {
      return Err("jwt expired".to_string());
    }
  }
  Ok(claims)
}

#[cfg(test)]
mod tests {
  use super::*;
  use ring::rand::SystemRandom;
  use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
  use serde_json::json;

  const PRIVATE: &str = include_str!("../tests/fixtures/test-jwt-private.pem");
  const PUBLIC: &str = include_str!("../tests/fixtures/test-jwt-public.pem");
  const PUBLIC_PKCS1: &str = include_str!("../tests/fixtures/test-jwt-public-pkcs1.pem");
  const CERTIFICATE: &str = include_str!("../tests/fixtures/test-jwt-cert.pem");

  fn token(header: Value, claims: Value) -> String {
    let b64 = |v: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    let input = format!("{}.{}", b64(&header), b64(&claims));
    let pair = RsaKeyPair::from_pkcs8(&pem_decode(PRIVATE).unwrap().1).unwrap();
    let mut signature = vec![0; pair.public().modulus_len()];
    pair
      .sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        input.as_bytes(),
        &mut signature,
      )
      .unwrap();
    format!(
      "{input}.{}",
      base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature)
    )
  }

  fn rs256(claims: Value) -> String {
    token(json!({ "alg": "RS256", "typ": "JWT" }), claims)
  }

  #[test]
  fn each_key_form_verifies() {
    let signed = rs256(json!({ "sub": "u", "scope": "sync" }));
    for pem in [PUBLIC, PUBLIC_PKCS1, CERTIFICATE] {
      let key = PublicKey::from_pem(pem).unwrap();
      assert_eq!(verify_rs256(&signed, &key).unwrap()["sub"], "u");
    }
  }

  #[test]
  fn tampering_other_algorithms_and_times_are_refused() {
    let key = PublicKey::from_pem(PUBLIC).unwrap();
    let now = crate::time::now_ms() / 1000;
    let signed = rs256(json!({ "sub": "u" }));
    let (head, rest) = signed.split_once('.').unwrap();
    let (_, signature) = rest.split_once('.').unwrap();
    let forged_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
      .encode(json!({ "sub": "admin" }).to_string());
    assert_eq!(
      verify_rs256(&format!("{head}.{forged_payload}.{signature}"), &key),
      Err("invalid signature".to_string())
    );
    assert_eq!(
      verify_rs256(&token(json!({ "alg": "HS256" }), json!({})), &key),
      Err("invalid algorithm".to_string())
    );
    assert_eq!(
      verify_rs256(&rs256(json!({ "exp": now - 1 })), &key),
      Err("jwt expired".to_string())
    );
    assert_eq!(
      verify_rs256(&rs256(json!({ "exp": now })), &key),
      Err("jwt expired".to_string())
    );
    assert!(verify_rs256(&rs256(json!({ "exp": now + 60 })), &key).is_ok());
    assert_eq!(
      verify_rs256(&rs256(json!({ "nbf": now + 60 })), &key),
      Err("jwt not active".to_string())
    );
    assert_eq!(
      verify_rs256(&rs256(json!({ "exp": "soon" })), &key),
      Err("invalid exp value".to_string())
    );
    assert_eq!(verify_rs256("a.b", &key), Err("jwt malformed".to_string()));
  }

  #[test]
  fn keys_that_are_not_rsa_public_keys_are_refused() {
    assert!(
      PublicKey::from_pem("-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----")
        .is_err()
    );
    assert!(PublicKey::from_pem(PRIVATE).is_err());
    assert!(PublicKey::from_pem("nothing").is_err());
  }
}
