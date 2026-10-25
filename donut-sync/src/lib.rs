//! Donut Sync: the server behind Donut Browser's sync. It authenticates
//! clients, scopes them to their namespace in one S3 bucket, and hands out
//! presigned URLs, so profile files go straight between devices and storage.

pub mod accounts;
pub mod auth;
pub mod backend;
pub mod config;
pub mod error;
pub mod http;
pub mod jsval;
pub mod jwt;
pub mod log;
pub mod net;
pub mod s3;
pub mod sigv4;
pub mod store;
pub mod subscribe;
pub mod sync;
pub mod time;

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;

use crate::accounts::{DonutAccounts, normalize_sync_server_url};
use crate::auth::Guard;
use crate::backend::Backend;
use crate::config::Config;
use crate::http::AppState;
use crate::s3::{Location, Presigner, S3Store};
use crate::sigv4::Credentials;
use crate::sync::{SyncOptions, SyncService};

const DEFAULT_PORT: u16 = 3929;
/// Shipped placeholders that must never guard a real server.
const INSECURE_DEFAULT_TOKENS: [&str; 3] = [
  "secret-sync-token",
  "CHANGE_ME_generate_a_long_random_secret",
  "CHANGE_ME",
];
/// How long in-flight requests get to finish after a stop signal. Open
/// subscriptions never finish on their own, so this bounds every stop.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// The checks made before anything starts. `Err` is the line to print.
pub fn validate_env(config: &Config) -> Result<(), String> {
  if let Some(url) = &config.sync_public_url
    && normalize_sync_server_url(url).is_none()
  {
    return Err(
        "SYNC_PUBLIC_URL must be the http(s) address Donut Browser uses for this server, e.g. https://sync.example.com"
          .to_string(),
      );
  }
  if config.sync_token.is_none()
    && config.sync_public_url.is_none()
    && config.jwt_public_key.is_none()
  {
    return Err("Set SYNC_TOKEN, SYNC_PUBLIC_URL (Donut account sign-in), or both".to_string());
  }
  // A static SYNC_TOKEN is the only credential on a self-hosted server that is
  // typically exposed on 0.0.0.0, so the shipped placeholders and any token
  // short enough to brute-force are refused.
  if let Some(token) = &config.sync_token
    && (INSECURE_DEFAULT_TOKENS.contains(&token.as_str()) || token.encode_utf16().count() < 24)
  {
    return Err(
        "SYNC_TOKEN is a known default or too short. Set a long, random secret, e.g. `openssl rand -hex 32`."
          .to_string(),
      );
  }
  Ok(())
}

fn require(value: &Option<String>, name: &str) -> Result<String, String> {
  value
    .clone()
    .ok_or_else(|| format!("Required environment variable {name} is not set"))
}

/// Everything the server needs, connected and checked: storage reachable and
/// the bucket created if it was missing.
pub async fn build_state(config: &Config) -> Result<Arc<AppState>, String> {
  // No defaults for storage: a misconfigured server must not start pointed at
  // an unintended or public-default backend.
  let endpoint = require(&config.s3_endpoint, "S3_ENDPOINT")?;
  let region = config
    .s3_region
    .clone()
    .unwrap_or_else(|| "us-east-1".to_string());
  let access_key_id = require(&config.s3_access_key_id, "S3_ACCESS_KEY_ID")?;
  let secret_access_key = require(&config.s3_secret_access_key, "S3_SECRET_ACCESS_KEY")?;
  let force_path_style = config.s3_force_path_style.as_deref() != Some("false");
  let bucket = require(&config.s3_bucket, "S3_BUCKET")?;
  let credentials = Credentials {
    access_key_id,
    secret_access_key,
  };

  // Presigned URLs go to a desktop on another machine, so they must name a
  // host that machine can reach. Signing is bound to the host, so they are
  // signed against the public address rather than rewritten after signing.
  let public_endpoint = config
    .s3_public_endpoint
    .clone()
    .unwrap_or_else(|| endpoint.clone());
  let store = S3Store::new(
    Location::parse(&endpoint, &bucket, force_path_style)?,
    credentials.clone(),
    region.clone(),
  );
  let presigner = Presigner::new(
    Location::parse(&public_endpoint, &bucket, force_path_style)?,
    credentials,
    region,
  );

  let backend = config
    .backend()
    .map(|(url, key)| Arc::new(Backend::new(url, key)));
  let sync = Arc::new(SyncService::new(
    Arc::new(store),
    SyncOptions {
      presigner,
      public_endpoint,
      public_endpoint_configured: config.s3_public_endpoint.is_some(),
      cloud: config.jwt_public_key.is_some(),
      backend: backend.clone(),
    },
  ));
  let guard = Guard::new(
    config.sync_token.clone(),
    config.jwt_public_key.clone(),
    backend,
    DonutAccounts::from_config(config),
  );

  sync.ensure_bucket_exists().await?;
  sync.warn_if_presign_endpoint_is_server_only();

  Ok(Arc::new(AppState {
    guard,
    sync,
    internal_key: config.internal_key.clone(),
    account_url: config
      .sync_public_url
      .as_deref()
      .and_then(normalize_sync_server_url),
  }))
}

/// Listens on every address: IPv6 with IPv4 mapped, or IPv4 alone where the
/// host has no IPv6.
pub fn bind(port: u16) -> std::io::Result<TcpListener> {
  let dual = (|| {
    let socket = socket2::Socket::new(socket2::Domain::IPV6, socket2::Type::STREAM, None)?;
    socket.set_only_v6(false)?;
    socket.set_reuse_address(true)?;
    socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)).into())?;
    socket.listen(1024)?;
    socket.set_nonblocking(true)?;
    TcpListener::from_std(socket.into())
  })();
  match dual {
    Ok(listener) => Ok(listener),
    Err(_) => {
      let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None)?;
      socket.set_reuse_address(true)?;
      socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into())?;
      socket.listen(1024)?;
      socket.set_nonblocking(true)?;
      TcpListener::from_std(socket.into())
    }
  }
}

/// Serves until `shutdown` resolves, then gives in-flight requests a moment.
pub async fn serve(
  listener: TcpListener,
  state: Arc<AppState>,
  shutdown: impl std::future::Future<Output = ()>,
) {
  let graceful = hyper_util::server::graceful::GracefulShutdown::new();
  tokio::pin!(shutdown);
  loop {
    tokio::select! {
      accepted = listener.accept() => {
        let Ok((stream, _)) = accepted else { continue };
        let _ = stream.set_nodelay(true);
        let state = state.clone();
        let service = service_fn(move |request| http::handle(state.clone(), request));
        let connection = hyper::server::conn::http1::Builder::new()
          .timer(TokioTimer::new())
          .header_read_timeout(Duration::from_secs(60))
          .keep_alive(true)
          .serve_connection(TokioIo::new(stream), service);
        let connection = graceful.watch(connection);
        tokio::spawn(async move {
          let _ = connection.await;
        });
      }
      () = &mut shutdown => break,
    }
  }
  drop(listener);
  tokio::select! {
    () = graceful.shutdown() => {}
    () = tokio::time::sleep(SHUTDOWN_GRACE) => {}
  }
}

async fn stop_signal() {
  let ctrl_c = async {
    let _ = tokio::signal::ctrl_c().await;
  };
  #[cfg(unix)]
  let terminate = async {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
      Ok(mut signal) => {
        signal.recv().await;
      }
      Err(_) => std::future::pending::<()>().await,
    }
  };
  #[cfg(not(unix))]
  let terminate = std::future::pending::<()>();
  tokio::select! {
    () = ctrl_c => {}
    () = terminate => {}
  }
}

/// The whole program. Returns the exit code.
pub async fn run() -> i32 {
  // A `.env` in the working directory fills in what the environment lacks.
  let _ = dotenvy::dotenv();
  let config = Config::from_env();
  if let Err(message) = validate_env(&config) {
    eprintln!("{message}");
    return 1;
  }
  let port = match config.port.as_deref() {
    None => DEFAULT_PORT,
    Some(value) => match value.trim().parse::<u16>() {
      Ok(port) => port,
      Err(_) => {
        eprintln!("PORT must be a port number, not {value}");
        return 1;
      }
    },
  };
  let state = match build_state(&config).await {
    Ok(state) => state,
    Err(message) => {
      eprintln!("{message}");
      return 1;
    }
  };
  let listener = match bind(port) {
    Ok(listener) => listener,
    Err(e) => {
      eprintln!("Could not listen on port {port}: {e}");
      return 1;
    }
  };
  let port = listener.local_addr().map_or(port, |a| a.port());
  println!("Donut Sync service running on port {port}");
  serve(listener, state, stop_signal()).await;
  0
}
