//! The proxy Donut's own requests go through: Wayfern and app downloads,
//! version and update checks, sign-in, cloud sync and the other calls to
//! Donut's servers. It is for networks where those servers are reachable only
//! through a proxy and the operating system's proxy cannot be changed.
//!
//! With no proxy set, requests go out as before: directly, or through the
//! system proxy (`system_proxy`). Requests to loopback never use it, and
//! browser profiles never do: each profile has its own route.
//!
//! The URL can carry credentials, so it is sealed on disk like the other
//! secrets and never sent to the frontend; the frontend sees `redacted`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

static CURRENT: RwLock<Option<String>> = RwLock::new(None);
/// Bumped on every change, so a shared client knows it is stale.
static GENERATION: AtomicU64 = AtomicU64::new(0);

const SCHEMES: [&str; 4] = ["http", "https", "socks5", "socks5h"];
const LOOPBACK: &str = "localhost,127.0.0.1,::1";
const TEST_URL: &str = "https://donutbrowser.com/wayfern.json";
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

/// The proxy URL, normalized, or `APP_PROXY_INVALID`.
pub fn parse(value: &str) -> Result<String, String> {
  let invalid = || crate::backend_error("APP_PROXY_INVALID");
  let url = url::Url::parse(value.trim()).map_err(|_| invalid())?;
  if !SCHEMES.contains(&url.scheme())
    || url.host_str().is_none_or(str::is_empty)
    || url.port_or_known_default().is_none()
    || !matches!(url.path(), "" | "/")
    || url.query().is_some()
    || url.fragment().is_some()
  {
    return Err(invalid());
  }
  let mut url = url;
  url.set_path("");
  reqwest::Proxy::all(url.as_str()).map_err(|_| invalid())?;
  Ok(url.as_str().trim_end_matches('/').to_string())
}

/// `scheme://host:port`, without credentials: what logs and errors may show.
pub fn redacted(proxy: &str) -> String {
  match url::Url::parse(proxy) {
    Ok(url) => format!(
      "{}://{}:{}",
      url.scheme(),
      url.host_str().unwrap_or_default(),
      url.port_or_known_default().unwrap_or_default()
    ),
    Err(_) => "<invalid>".to_string(),
  }
}

pub fn current() -> Option<String> {
  CURRENT.read().ok()?.clone()
}

fn set_current(proxy: Option<String>) {
  if let Ok(mut current) = CURRENT.write() {
    *current = proxy;
  }
  GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Route `builder`'s requests through the proxy, when one is set.
pub fn apply(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
  match current() {
    Some(proxy) => with_proxy(builder, &proxy),
    None => builder,
  }
}

fn with_proxy(builder: reqwest::ClientBuilder, proxy: &str) -> reqwest::ClientBuilder {
  match reqwest::Proxy::all(proxy) {
    Ok(proxy) => builder.proxy(proxy.no_proxy(reqwest::NoProxy::from_string(LOOPBACK))),
    // `parse` accepted it, so this does not happen. Never fall back to a
    // direct connection the person chose to avoid.
    Err(_) => builder.proxy(reqwest::Proxy::custom(|_| Some("socks5h://0.0.0.0:0")).no_proxy(None)),
  }
}

/// A client builder for Donut's own requests.
pub fn client_builder() -> reqwest::ClientBuilder {
  apply(reqwest::Client::builder())
}

/// A long-lived client for Donut's own requests that follows the proxy
/// setting: it is built again after the setting changes.
pub struct SharedClient {
  configure: fn(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
  slot: Mutex<Option<(u64, reqwest::Client)>>,
}

impl SharedClient {
  pub const fn new(configure: fn(reqwest::ClientBuilder) -> reqwest::ClientBuilder) -> Self {
    Self {
      configure,
      slot: Mutex::new(None),
    }
  }

  pub fn get(&self) -> reqwest::Client {
    let generation = GENERATION.load(Ordering::SeqCst);
    let mut slot = self
      .slot
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((built_at, client)) = slot.as_ref() {
      if *built_at == generation {
        return client.clone();
      }
    }
    let client = (self.configure)(client_builder())
      .build()
      .unwrap_or_else(|e| {
        log::warn!("HTTP client build failed; using defaults err=\"{e}\"");
        apply(reqwest::Client::builder())
          .build()
          .unwrap_or_default()
      });
    *slot = Some((generation, client.clone()));
    client
  }
}

fn store_file() -> std::path::PathBuf {
  crate::settings_manager::SettingsManager::instance()
    .get_settings_dir()
    .join("app_proxy.dat")
}

const STORE_HEADER: [u8; 6] = *b"DBAPX\x02";

/// Load the stored proxy. Runs once at startup, before the first request.
pub fn load() {
  match crate::vault::open(&store_file(), &STORE_HEADER) {
    Ok(Some(proxy)) => match parse(&proxy) {
      Ok(proxy) => {
        log::info!("App proxy in use proxy={}", redacted(&proxy));
        set_current(Some(proxy));
      }
      Err(_) => log::warn!("App proxy stored but invalid; not used"),
    },
    Ok(None) => {}
    Err(e) => log::warn!("App proxy unreadable; not used err=\"{e}\""),
  }
}

/// Whether a request through `proxy` reaches Donut's servers.
async fn reaches_donut(proxy: &str) -> Result<(), String> {
  let client = with_proxy(reqwest::Client::builder(), proxy)
    .timeout(TEST_TIMEOUT)
    .build()
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?;
  match client.head(TEST_URL).send().await {
    Ok(_) => Ok(()),
    Err(e) => {
      log::warn!(
        "App proxy check failed proxy={} err=\"{}\"",
        redacted(proxy),
        e.to_string().replace(proxy, &redacted(proxy))
      );
      Err(unreachable_error(proxy))
    }
  }
}

/// The error for a request the proxy could not carry. The frontend turns it
/// into a sentence that names the proxy and where to change it.
pub fn unreachable_error(proxy: &str) -> String {
  serde_json::json!({
    "code": "APP_PROXY_UNREACHABLE",
    "params": { "proxy": redacted(proxy) }
  })
  .to_string()
}

/// The proxy that is set, without credentials.
#[tauri::command]
pub async fn get_app_proxy() -> Option<String> {
  current().map(|proxy| redacted(&proxy))
}

/// Set the proxy, after checking that Donut's servers answer through it, or
/// clear it with `None`.
#[tauri::command]
pub async fn set_app_proxy(proxy: Option<String>) -> Result<Option<String>, String> {
  let proxy = proxy.filter(|value| !value.trim().is_empty());
  let Some(proxy) = proxy else {
    std::fs::remove_file(store_file())
      .or_else(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(e),
      })
      .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?;
    if current().is_some() {
      log::info!("App proxy removed");
    }
    set_current(None);
    return Ok(None);
  };

  let proxy = parse(&proxy)?;
  reaches_donut(&proxy).await?;
  crate::vault::seal(&store_file(), &STORE_HEADER, &proxy)
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?;
  log::info!("App proxy set proxy={}", redacted(&proxy));
  set_current(Some(proxy.clone()));
  Ok(Some(redacted(&proxy)))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_proxy_url_needs_a_known_scheme_a_host_and_nothing_else() {
    assert_eq!(
      parse(" socks5://user:p%40ss@10.0.0.1:1080 ").as_deref(),
      Ok("socks5://user:p%40ss@10.0.0.1:1080")
    );
    assert_eq!(
      parse("http://proxy.example:3128/").as_deref(),
      Ok("http://proxy.example:3128")
    );
    assert_eq!(
      parse("https://proxy.example").as_deref(),
      Ok("https://proxy.example")
    );
    for bad in [
      "",
      "proxy.example:3128",
      "ftp://proxy.example:21",
      "socks4://proxy.example:1080",
      "http://:3128",
      "http://proxy.example:3128/path",
      "http://proxy.example:3128?x=1",
    ] {
      assert!(parse(bad).is_err(), "{bad} must be refused");
    }
  }

  #[test]
  fn what_is_shown_never_carries_credentials() {
    assert_eq!(
      redacted("socks5h://user:secret@10.0.0.1:1080"),
      "socks5h://10.0.0.1:1080"
    );
    assert_eq!(redacted("http://proxy.example"), "http://proxy.example:80");
    let error = unreachable_error("http://user:secret@proxy.example:3128");
    assert!(!error.contains("secret"));
    assert!(error.contains("APP_PROXY_UNREACHABLE"));
  }

  #[tokio::test]
  #[serial_test::serial]
  async fn a_shared_client_follows_the_setting() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A proxy that answers every request itself, so a request that reaches
    // it proves the client went through it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
      while let Ok((mut socket, _)) = listener.accept().await {
        let mut buffer = [0u8; 1024];
        let _ = socket.read(&mut buffer).await;
        let _ = socket
          .write_all(b"HTTP/1.1 418 I'm a teapot\r\ncontent-length: 0\r\n\r\n")
          .await;
      }
    });

    static CLIENT: SharedClient = SharedClient::new(|builder| builder);
    let status = |client: reqwest::Client| async move {
      client
        .get("http://example.invalid/")
        .send()
        .await
        .map(|response| response.status().as_u16())
        .ok()
    };

    set_current(Some(format!("http://127.0.0.1:{port}")));
    assert_eq!(status(CLIENT.get()).await, Some(418));

    set_current(None);
    assert_eq!(status(CLIENT.get()).await, None);
  }
}
