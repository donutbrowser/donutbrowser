//! Runs the real binary against the S3 test server of
//! `donut-sync/docker-compose.yml` (rclone on port 8987).

#![allow(dead_code)]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use donut_sync::s3::{Location, S3Store};
use donut_sync::sigv4::Credentials;
use donut_sync::store::{Store, StoreError};

pub const S3_ENDPOINT: &str = "http://127.0.0.1:8987";
pub const SYNC_TOKEN: &str = "test-sync-token-0123456789abcdef";

pub fn http() -> reqwest::Client {
  let _ = rustls::crypto::ring::default_provider().install_default();
  reqwest::Client::builder().no_proxy().build().unwrap()
}

/// Waits for the S3 test server, or fails with how to start it.
pub async fn wait_for_s3() {
  let store = S3Store::new(
    Location::parse(S3_ENDPOINT, "probe-availability", true).unwrap(),
    Credentials {
      access_key_id: "minioadmin".to_string(),
      secret_access_key: "minioadmin".to_string(),
    },
    "us-east-1".to_string(),
  );
  let deadline = Instant::now() + Duration::from_secs(30);
  loop {
    match store.head_bucket().await {
      Ok(()) | Err(StoreError::NotFound) => return,
      Err(_) if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(500)).await,
      Err(e) => panic!(
        "No S3 test server at {S3_ENDPOINT} ({e}). Start it: docker compose -f donut-sync/docker-compose.yml up -d --wait"
      ),
    }
  }
}

fn free_port() -> u16 {
  std::net::TcpListener::bind("127.0.0.1:0")
    .unwrap()
    .local_addr()
    .unwrap()
    .port()
}

pub struct Server {
  pub url: String,
  child: Child,
  output: Arc<Mutex<String>>,
}

impl Server {
  /// The binary with the test storage, a long shared token and a fresh
  /// bucket, plus `overrides` (`None` removes a variable).
  pub async fn start(bucket: &str, overrides: &[(&str, Option<&str>)]) -> Server {
    wait_for_s3().await;
    let port = free_port();
    let mut env: Vec<(String, String)> = vec![
      ("SYNC_TOKEN".into(), SYNC_TOKEN.into()),
      ("S3_ENDPOINT".into(), S3_ENDPOINT.into()),
      ("S3_ACCESS_KEY_ID".into(), "minioadmin".into()),
      ("S3_SECRET_ACCESS_KEY".into(), "minioadmin".into()),
      ("S3_BUCKET".into(), bucket.into()),
      ("S3_FORCE_PATH_STYLE".into(), "true".into()),
      ("PORT".into(), port.to_string()),
    ];
    for (name, value) in overrides {
      env.retain(|(n, _)| n != name);
      if let Some(value) = value {
        env.push((name.to_string(), value.to_string()));
      }
    }
    let output = Arc::new(Mutex::new(String::new()));
    let mut child = spawn(&env);
    collect(&mut child, &output);
    let url = format!("http://127.0.0.1:{port}");
    let client = http();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
      if let Ok(response) = client.get(format!("{url}/health")).send().await
        && response.status().is_success()
      {
        break;
      }
      if let Ok(Some(status)) = child.try_wait() {
        panic!("server exited with {status}: {}", output.lock().unwrap());
      }
      assert!(
        Instant::now() < deadline,
        "server did not start: {}",
        output.lock().unwrap()
      );
      tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Server { url, child, output }
  }

  pub fn logs(&self) -> String {
    self.output.lock().unwrap().clone()
  }
}

impl Drop for Server {
  fn drop(&mut self) {
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

fn spawn(env: &[(String, String)]) -> Child {
  // A directory without a `.env`, so a developer's file cannot leak in.
  let dir = std::env::temp_dir().join("donut-sync-test-cwd");
  std::fs::create_dir_all(&dir).unwrap();
  Command::new(env!("CARGO_BIN_EXE_donut-sync"))
    .env_clear()
    .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
    .current_dir(dir)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .unwrap()
}

fn collect(child: &mut Child, output: &Arc<Mutex<String>>) {
  let stdout = child.stdout.take().unwrap();
  let stderr = child.stderr.take().unwrap();
  for stream in [
    Box::new(stdout) as Box<dyn std::io::Read + Send>,
    Box::new(stderr),
  ] {
    let output = output.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let mut out = output.lock().unwrap();
        out.push_str(&line);
        out.push('\n');
      }
    });
  }
}

/// Runs the binary to its exit (a refused configuration) and returns the
/// exit code and what it printed.
pub fn run_to_exit(env: &[(&str, &str)]) -> (i32, String) {
  let env: Vec<(String, String)> = env
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
  let child = spawn(&env);
  let out = child.wait_with_output().unwrap();
  (
    out.status.code().unwrap_or(-1),
    format!(
      "{}{}",
      String::from_utf8_lossy(&out.stdout),
      String::from_utf8_lossy(&out.stderr)
    ),
  )
}

/// A bucket name of its own for each test.
pub fn bucket(name: &str) -> String {
  format!(
    "it-{name}-{}",
    &uuid::Uuid::new_v4().simple().to_string()[..8]
  )
}

pub async fn post(
  client: &reqwest::Client,
  url: &str,
  token: Option<&str>,
  body: serde_json::Value,
) -> (u16, serde_json::Value) {
  let mut request = client.post(url).json(&body);
  if let Some(token) = token {
    request = request.bearer_auth(token);
  }
  let response = request.send().await.unwrap();
  let status = response.status().as_u16();
  let text = response.text().await.unwrap();
  (
    status,
    serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)),
  )
}

/// A stand-in HTTP service (the Donut API, the backend): answers each POST
/// with `answer(path, body)` and keeps what it was asked.
pub struct Mock {
  pub url: String,
  pub calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
}

impl Mock {
  pub async fn start(
    answer: impl Fn(&str, &serde_json::Value) -> (u16, String) + Send + Sync + 'static,
  ) -> Mock {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let calls: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::default();
    let answer = Arc::new(answer);
    let recorded = calls.clone();
    tokio::spawn(async move {
      loop {
        let Ok((stream, _)) = listener.accept().await else {
          return;
        };
        let answer = answer.clone();
        let recorded = recorded.clone();
        tokio::spawn(async move {
          let service =
            hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
              let answer = answer.clone();
              let recorded = recorded.clone();
              async move {
                let path = request.uri().path().to_string();
                let bytes = request.into_body().collect().await.unwrap().to_bytes();
                let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
                recorded.lock().unwrap().push((path.clone(), body.clone()));
                let (status, text) = answer(&path, &body);
                Ok::<_, std::convert::Infallible>(
                  hyper::Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(Full::new(Bytes::from(text)))
                    .unwrap(),
                )
              }
            });
          let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
            .await;
        });
      }
    });
    Mock { url, calls }
  }

  pub fn calls_to(&self, path: &str) -> Vec<serde_json::Value> {
    self
      .calls
      .lock()
      .unwrap()
      .iter()
      .filter(|(p, _)| p == path)
      .map(|(_, b)| b.clone())
      .collect()
  }
}
