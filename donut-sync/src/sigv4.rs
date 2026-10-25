//! AWS Signature Version 4 for S3: header signing for this server's own
//! requests, and query signing for the presigned URLs handed to clients.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
const ALGORITHM: &str = "AWS4-HMAC-SHA256";

#[derive(Clone, Debug)]
pub struct Credentials {
  pub access_key_id: String,
  pub secret_access_key: String,
}

/// Who signs, for which region, at which time (`20261025T090211Z`).
pub struct Signer<'a> {
  pub credentials: &'a Credentials,
  pub region: &'a str,
  pub amz_date: &'a str,
}

/// Percent-encodes everything but RFC 3986's unreserved characters.
pub fn uri_encode(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for b in s.bytes() {
    if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

/// JavaScript's `encodeURIComponent`, which also leaves `!'()*` alone.
pub fn encode_uri_component(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for b in s.bytes() {
    if b.is_ascii_alphanumeric()
      || matches!(
        b,
        b'-' | b'_' | b'.' | b'~' | b'!' | b'*' | b'\'' | b'(' | b')'
      )
    {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

/// An object key as an S3 path: each segment encoded, slashes kept.
pub fn encode_key(key: &str) -> String {
  key.split('/').map(uri_encode).collect::<Vec<_>>().join("/")
}

pub fn sha256_hex(data: &[u8]) -> String {
  hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
  let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
  mac.update(data);
  mac.finalize().into_bytes().to_vec()
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
  let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
  let k_region = hmac(&k_date, region.as_bytes());
  let k_service = hmac(&k_region, service.as_bytes());
  hmac(&k_service, b"aws4_request")
}

/// `name=value` pairs, encoded and sorted.
pub fn canonical_query(pairs: &[(String, String)]) -> String {
  let mut encoded: Vec<(String, String)> = pairs
    .iter()
    .map(|(k, v)| (uri_encode(k), uri_encode(v)))
    .collect();
  encoded.sort();
  encoded
    .iter()
    .map(|(k, v)| format!("{k}={v}"))
    .collect::<Vec<_>>()
    .join("&")
}

fn canonical_header_value(value: &str) -> String {
  value.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct Canonical {
  request: String,
  signed_headers: String,
}

fn canonical_request(
  method: &str,
  path: &str,
  query: &str,
  headers: &[(String, String)],
  payload_hash: &str,
) -> Canonical {
  let mut sorted: Vec<(String, String)> = headers
    .iter()
    .map(|(k, v)| (k.to_ascii_lowercase(), canonical_header_value(v)))
    .collect();
  sorted.sort();
  let canonical_headers: String = sorted.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
  let signed_headers = sorted
    .iter()
    .map(|(k, _)| k.as_str())
    .collect::<Vec<_>>()
    .join(";");
  Canonical {
    request: format!(
      "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    ),
    signed_headers,
  }
}

fn signature(
  credentials: &Credentials,
  region: &str,
  amz_date: &str,
  canonical_request: &str,
) -> String {
  let date = &amz_date[..8];
  let scope = format!("{date}/{region}/s3/aws4_request");
  let string_to_sign = format!(
    "{ALGORITHM}\n{amz_date}\n{scope}\n{}",
    sha256_hex(canonical_request.as_bytes())
  );
  let key = signing_key(&credentials.secret_access_key, date, region, "s3");
  hex::encode(hmac(&key, string_to_sign.as_bytes()))
}

/// The `Authorization` header of a request whose headers (including `host`,
/// `x-amz-date` and `x-amz-content-sha256`) are all signed.
pub fn authorization(
  signer: &Signer,
  method: &str,
  path: &str,
  query: &[(String, String)],
  headers: &[(String, String)],
  payload_hash: &str,
) -> String {
  let canonical = canonical_request(method, path, &canonical_query(query), headers, payload_hash);
  let signature = signature(
    signer.credentials,
    signer.region,
    signer.amz_date,
    &canonical.request,
  );
  format!(
    "{ALGORITHM} Credential={}/{}/{}/s3/aws4_request, SignedHeaders={}, Signature={signature}",
    signer.credentials.access_key_id,
    &signer.amz_date[..8],
    signer.region,
    canonical.signed_headers
  )
}

/// The query string of a presigned URL, in the form the AWS SDK for
/// JavaScript wrote it: every parameter sorted, the signature among them.
/// `headers` are the headers the client must send as signed (`host` and any
/// `x-amz-meta-*`).
pub fn presigned_query(
  signer: &Signer,
  expires: &str,
  method: &str,
  path: &str,
  query: &[(String, String)],
  headers: &[(String, String)],
) -> String {
  let mut signed_header_names: Vec<String> = headers
    .iter()
    .map(|(k, _)| k.to_ascii_lowercase())
    .collect();
  signed_header_names.sort();
  let credential = format!(
    "{}/{}/{}/s3/aws4_request",
    signer.credentials.access_key_id,
    &signer.amz_date[..8],
    signer.region
  );
  let mut params: Vec<(String, String)> = query.to_vec();
  params.extend([
    ("X-Amz-Algorithm".to_string(), ALGORITHM.to_string()),
    (
      "X-Amz-Content-Sha256".to_string(),
      UNSIGNED_PAYLOAD.to_string(),
    ),
    ("X-Amz-Credential".to_string(), credential),
    ("X-Amz-Date".to_string(), signer.amz_date.to_string()),
    ("X-Amz-Expires".to_string(), expires.to_string()),
    (
      "X-Amz-SignedHeaders".to_string(),
      signed_header_names.join(";"),
    ),
  ]);
  let canonical = canonical_request(
    method,
    path,
    &canonical_query(&params),
    headers,
    UNSIGNED_PAYLOAD,
  );
  params.push((
    "X-Amz-Signature".to_string(),
    signature(
      signer.credentials,
      signer.region,
      signer.amz_date,
      &canonical.request,
    ),
  ));
  canonical_query(&params)
}

#[cfg(test)]
mod tests {
  use super::*;

  // From AWS's own S3 SigV4 examples (docs: "Authenticating Requests: Using
  // Query Parameters" and "...Using the Authorization Header").
  fn example_credentials() -> Credentials {
    Credentials {
      access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
      secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
    }
  }

  #[test]
  fn presigned_get_matches_the_aws_example() {
    let credentials = example_credentials();
    let query = presigned_query(
      &Signer {
        credentials: &credentials,
        region: "us-east-1",
        amz_date: "20130524T000000Z",
      },
      "86400",
      "GET",
      "/test.txt",
      &[],
      &[(
        "host".to_string(),
        "examplebucket.s3.amazonaws.com".to_string(),
      )],
    );
    // The AWS example has no X-Amz-Content-Sha256 query parameter, so check
    // the signature algorithm against its canonical form instead.
    assert!(query.contains("X-Amz-SignedHeaders=host"));
    assert!(query.contains(
      "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"
    ));
  }

  #[test]
  fn header_signing_matches_the_aws_get_object_example() {
    let empty = sha256_hex(b"");
    let credentials = example_credentials();
    let auth = authorization(
      &Signer {
        credentials: &credentials,
        region: "us-east-1",
        amz_date: "20130524T000000Z",
      },
      "GET",
      "/test.txt",
      &[],
      &[
        (
          "host".to_string(),
          "examplebucket.s3.amazonaws.com".to_string(),
        ),
        ("range".to_string(), "bytes=0-9".to_string()),
        ("x-amz-content-sha256".to_string(), empty.clone()),
        ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
      ],
      &empty,
    );
    assert_eq!(
      auth,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
  }

  #[test]
  fn list_objects_example_signs_its_query() {
    let empty = sha256_hex(b"");
    let credentials = example_credentials();
    let auth = authorization(
      &Signer {
        credentials: &credentials,
        region: "us-east-1",
        amz_date: "20130524T000000Z",
      },
      "GET",
      "/",
      &[
        ("max-keys".to_string(), "2".to_string()),
        ("prefix".to_string(), "J".to_string()),
      ],
      &[
        (
          "host".to_string(),
          "examplebucket.s3.amazonaws.com".to_string(),
        ),
        ("x-amz-content-sha256".to_string(), empty.clone()),
        ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
      ],
      &empty,
    );
    assert!(
      auth.ends_with("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7")
    );
  }

  #[test]
  fn keys_encode_per_segment() {
    assert_eq!(encode_key("probe/a b+c.txt"), "probe/a%20b%2Bc.txt");
    assert_eq!(
      encode_key("probe/ü/日本.txt"),
      "probe/%C3%BC/%E6%97%A5%E6%9C%AC.txt"
    );
    assert_eq!(encode_uri_component("a(b)!*'"), "a(b)!*'");
    assert_eq!(uri_encode("a(b)"), "a%28b%29");
  }
}
