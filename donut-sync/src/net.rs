//! The outbound HTTP client: storage, the Donut API and the backend.

use std::time::Duration;

/// Extra trusted certificates, as the Node server took them, for storage or
/// a backend behind a private CA. The system store is trusted as well.
const EXTRA_CA_CERTS: &str = "NODE_EXTRA_CA_CERTS";

pub fn client(read_timeout: Duration) -> reqwest::Client {
  let _ = rustls::crypto::ring::default_provider().install_default();
  let mut builder = reqwest::Client::builder()
    .no_proxy()
    .connect_timeout(Duration::from_secs(10))
    .read_timeout(read_timeout);
  if let Some(path) = std::env::var_os(EXTRA_CA_CERTS).filter(|p| !p.is_empty()) {
    match std::fs::read(&path)
      .map_err(|e| e.to_string())
      .and_then(|pem| reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| e.to_string()))
    {
      Ok(certs) => builder = builder.tls_certs_merge(certs),
      Err(e) => crate::log::warn(
        "TLS",
        &format!(
          "{EXTRA_CA_CERTS} not loaded from {}: {e}",
          path.to_string_lossy()
        ),
      ),
    }
  }
  builder
    .build()
    .expect("the HTTP client configuration is valid")
}
