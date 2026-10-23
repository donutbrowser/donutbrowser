//! The locator and perception tools against a real Wayfern build, on a feed
//! built the way web-component sites build one: each card a custom element
//! with an open shadow root, its title link slotted in, a full-card link
//! under it, a sticky header and more cards loaded as the page scrolls.
//!
//! `DONUT_TEST_WAYFERN_DIR` names the build and `WAYFERN_TEST_TOKEN` an
//! entitled token; `DONUT_TEST_WAYFERN_VERSION` the version, when the
//! directory's name is not it.

use super::*;
use crate::browser::{create_browser, BrowserType};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const FEED: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Feed</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  feed-header { display: block; position: sticky; top: 0; z-index: 5; background: #fff; height: 56px; border-bottom: 1px solid #ddd; }
  feed-header nav { display: flex; gap: 12px; align-items: center; height: 56px; padding: 0 16px; }
  .grid { display: flex; }
  side-nav { display: block; width: 200px; position: sticky; top: 57px; height: calc(100vh - 57px); }
  main { flex: 1; max-width: 700px; padding: 0 16px; }
  article { display: block; }
</style></head>
<body>
  <feed-header><nav>
    <a href="/" aria-label="Home">home</a>
    <search-box placeholder="Search"></search-box>
    <a id="login-button" href="/login">Log In</a>
  </nav></feed-header>
  <div class="grid">
    <side-nav><nav-link href="/popular">Popular</nav-link><nav-link href="/all">All</nav-link></side-nav>
    <main><div id="feed"></div><div id="more">Loading more</div></main>
  </div>
<script>
  customElements.define('feed-post', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>
        :host { display: block; position: relative; padding: 8px 16px; }
        ::slotted([slot="full-post-link"]) { position: absolute; inset: 0; z-index: 0; }
        ::slotted([slot="title"]) { position: relative; z-index: 1; display: block; font-weight: 600; font-size: 18px; margin: 4px 0; }
        ::slotted([slot="text-body"]), .actions { position: relative; z-index: 1; }
      </style>
      <slot name="full-post-link"></slot>
      <div><slot name="credit-bar"></slot><slot name="title"></slot><slot name="text-body"></slot>
      <div class="actions"><button aria-label="Upvote">up</button><button>Share</button></div></div>`;
    }
  });
  customElements.define('screen-reader-text', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = '<style>:host { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }</style><slot></slot>';
    }
  });
  customElements.define('search-box', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = '<input type="search" name="q">';
    }
  });
  customElements.define('nav-link', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = `<a style="display:block;padding:8px" href="${this.getAttribute('href')}"><slot></slot></a>`;
    }
  });
  let next = 0;
  const feed = document.getElementById('feed');
  const add = (n) => {
    for (let k = 0; k < n; k++) {
      const i = next++;
      const id = 't3_' + (1000 + i).toString(36);
      const title = 'Post ' + i + ': a thread' + (i % 3 === 0 ? ' with a longer title that wraps onto a second line of the card' : '');
      const href = '/post?id=' + id;
      const article = document.createElement('article');
      article.innerHTML = `<feed-post id="${id}">
        <a slot="full-post-link" href="${href}"><screen-reader-text>${title}</screen-reader-text></a>
        <span slot="credit-bar"><a href="/r/${i}/">r/${i}</a> ${i + 1} hr. ago</span>
        <a id="post-title-${id}" slot="title" href="${href}">
          ${title}
        </a>
        <div slot="text-body"><p>Body of post ${i}. Words to make the card tall enough to scroll past.</p><p>Second paragraph.</p></div>
      </feed-post>`;
      feed.appendChild(article);
    }
  };
  add(120);
  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) add(10); }, { rootMargin: '800px' })
    .observe(document.getElementById('more'));
</script></body></html>"#;

const POST: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Thread</title></head>
<body><h1>Thread</h1><a href="/feed">Back</a></body></html>"#;

const PROFILE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Profile</title></head>
<body><main>
  <h1>u/someone</h1>
  <profile-stats><span slot="label">Account Age</span> <span slot="age">15 y</span></profile-stats>
  <p>After the stats.</p>
</main>
<script>
  customElements.define('profile-stats', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = '<div><slot name="label"></slot> <slot name="age"></slot></div><div>Cake day <time datetime="2010-03-03">Mar 3, 2010</time></div>';
    }
  });
</script></body></html>"#;

/// Serve the fixture pages on a loopback port.
async fn serve_fixture() -> u16 {
  use tokio::io::{AsyncReadExt, AsyncWriteExt};
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let port = listener.local_addr().unwrap().port();
  tokio::spawn(async move {
    while let Ok((mut stream, _)) = listener.accept().await {
      tokio::spawn(async move {
        let mut request = Vec::new();
        let mut buffer = [0u8; 2048];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
          match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(n) => request.extend_from_slice(&buffer[..n]),
          }
        }
        let head = String::from_utf8_lossy(&request);
        let path = head.split_whitespace().nth(1).unwrap_or("/");
        let (status, body) = if path.starts_with("/feed") {
          ("200 OK", FEED)
        } else if path.starts_with("/post") {
          ("200 OK", POST)
        } else if path.starts_with("/profile") {
          ("200 OK", PROFILE)
        } else {
          ("404 Not Found", "<!doctype html><title>404</title>")
        };
        let reply = format!(
          "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
          body.len()
        );
        let _ = stream.write_all(reply.as_bytes()).await;
      });
    }
  });
  port
}

fn wayfern_dir() -> PathBuf {
  std::env::var("DONUT_TEST_WAYFERN_DIR")
    .ok()
    .filter(|dir| !dir.trim().is_empty())
    .map(PathBuf::from)
    .expect("DONUT_TEST_WAYFERN_DIR is required")
}

/// `DONUT_TEST_WAYFERN_VERSION`, or the directory's name, which is the
/// version in Donut's own binaries layout.
fn wayfern_version(dir: &Path) -> String {
  std::env::var("DONUT_TEST_WAYFERN_VERSION")
    .ok()
    .filter(|version| !version.trim().is_empty())
    .or_else(|| {
      dir
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.split('.').count() == 4)
        .map(str::to_string)
    })
    .expect("DONUT_TEST_WAYFERN_VERSION, or a directory named for the version")
}

/// A headless Wayfern with the test token, and its first page.
struct LiveBrowser {
  child: tokio::process::Child,
  user_data_dir: tempfile::TempDir,
  target: CdpTarget,
}

impl LiveBrowser {
  async fn start(dir: &Path) -> Self {
    let token = std::env::var("WAYFERN_TEST_TOKEN")
      .ok()
      .filter(|token| !token.is_empty())
      .expect("WAYFERN_TEST_TOKEN is required");
    let exe = create_browser(BrowserType::Wayfern)
      .get_executable_path(dir)
      .expect("DONUT_TEST_WAYFERN_DIR holds a Wayfern build");
    let user_data_dir = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new(exe);
    command
      .arg("--headless=new")
      .arg("--remote-debugging-port=0")
      .arg("--remote-debugging-address=127.0.0.1")
      .arg(format!(
        "--user-data-dir={}",
        user_data_dir.path().display()
      ))
      .arg("--no-first-run")
      .arg("--no-default-browser-check")
      .arg("--disable-background-mode")
      .arg("--use-mock-keychain")
      .arg("--password-store=basic")
      .arg("--window-size=1280,900")
      .arg("about:blank")
      .env("WAYFERN_TOKEN", token)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .kill_on_drop(true);
    #[cfg(target_os = "linux")]
    command.arg("--no-sandbox");
    let child = command.spawn().expect("the browser starts");

    let port_file = user_data_dir.path().join("DevToolsActivePort");
    let mut port = None;
    for _ in 0..150 {
      if let Some(line) = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|text| text.lines().next().map(str::to_string))
      {
        port = line.trim().parse::<u16>().ok();
        if port.is_some() {
          break;
        }
      }
      tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let port = port.expect("the browser opens its debugging port");
    let mut ws_url = None;
    for _ in 0..50 {
      let listing: Vec<Value> =
        match reqwest::get(format!("http://127.0.0.1:{port}/json/list")).await {
          Ok(response) => response.json().await.unwrap_or_default(),
          Err(_) => Vec::new(),
        };
      ws_url = listing
        .iter()
        .find(|t| t["type"] == "page")
        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
        .map(str::to_string);
      if ws_url.is_some() {
        break;
      }
      tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Self {
      child,
      user_data_dir,
      target: CdpTarget::Local {
        ws_url: ws_url.expect("the browser lists a page"),
      },
    }
  }

  async fn stop(mut self) {
    let _ = self.child.kill().await;
    let _ = self.user_data_dir.close();
  }

  async fn evaluate(&self, expression: &str) -> Value {
    let reply = crate::cdp_target::run_command(
      &self.target,
      "Runtime.evaluate",
      json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
    )
    .await
    .unwrap();
    reply["result"]["value"].clone()
  }

  async fn open(&self, url: &str) {
    let mut session = WayfernSession::open(&self.target).await.unwrap();
    session.call("Page.enable", json!({})).await.unwrap();
    let (_, loaded) = session
      .call_then_await_navigation(
        "Page.navigate",
        json!({ "url": url }),
        Duration::from_secs(20),
      )
      .await
      .unwrap();
    session.close().await;
    assert!(loaded, "{url} loads");
  }

  /// Open the feed and scroll far down it, as an agent reading it would.
  async fn scrolled_feed(&self, base: &str) -> f64 {
    self.open(&format!("{base}/feed")).await;
    self.evaluate("window.scrollTo(0, 6000)").await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    self.evaluate("window.innerHeight").await.as_f64().unwrap()
  }

  /// A title link fully in view below the sticky header: its id and text.
  async fn title_in_view(&self) -> (String, String) {
    let found = self
      .evaluate(
        "(() => { for (const a of document.querySelectorAll('a[slot=title]')) { const r = a.getBoundingClientRect(); if (r.top > 120 && r.bottom < innerHeight - 40) return [a.id, a.textContent.trim()]; } return null; })()",
      )
      .await;
    (
      found[0].as_str().expect("a title in view").to_string(),
      found[1].as_str().unwrap().to_string(),
    )
  }
}

fn context(version: &str, target: &CdpTarget) -> AgentContext {
  AgentContext::new(
    BrowserProfile {
      id: uuid::Uuid::new_v4(),
      name: "browser test".to_string(),
      browser: "wayfern".to_string(),
      version: version.to_string(),
      ..Default::default()
    },
    target.clone(),
  )
}

fn click(locator: Value) -> AgentClickRequest {
  serde_json::from_value(json!({ "locator": locator })).unwrap()
}

/// Every node an answer reports in the viewport overlaps the window: the
/// bounds are viewport coordinates on both engines.
fn assert_viewport_bounds(page: &PerceptionPage, height: f64, what: &str) {
  for node in page.nodes.iter().filter(|n| n.in_viewport) {
    assert!(
      node.y < height && node.y + node.height > 0.0,
      "{what}: {} {:?} at y={} h={}",
      node.role,
      node.name,
      node.y,
      node.height
    );
  }
}

fn post_titles(page: &PerceptionPage) -> Vec<String> {
  page
    .nodes
    .iter()
    .filter(|n| n.role == "link" && n.in_viewport)
    .filter_map(|n| n.name.clone())
    .filter(|name| name.starts_with("Post "))
    .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a Wayfern build in DONUT_TEST_WAYFERN_DIR and WAYFERN_TEST_TOKEN"]
async fn the_agent_tools_read_and_click_a_feed_of_web_components() {
  let dir = wayfern_dir();
  let version = wayfern_version(&dir);
  assert!(crate::wayfern_manager::supports_wayfern_152(&version));
  let base = format!("http://127.0.0.1:{}", serve_fixture().await);
  let browser = LiveBrowser::start(&dir).await;
  let native = context(&version, &browser.target);
  let page_engine = context("151.0.7922.76", &browser.target);

  // Perception of the window after a scroll holds the cards on screen, with a
  // node ceiling too, on both engines.
  let height = browser.scrolled_feed(&base).await;
  for (request, what) in [
    (json!({ "viewport_only": true }), "viewport"),
    (
      json!({ "viewport_only": true, "max_nodes": 200 }),
      "viewport, 200 nodes",
    ),
    (
      json!({ "viewport_only": true, "max_nodes": 20 }),
      "viewport, 20 nodes",
    ),
  ] {
    let request: PerceptionRequest = serde_json::from_value(request).unwrap();
    for ctx in [&native, &page_engine] {
      let page = agent_perceive(ctx, &request).await.unwrap();
      let what = format!("{what} ({:?})", page.engine);
      if let Some(cap) = request.max_nodes {
        assert!(
          page.nodes.len() as u64 <= cap,
          "{what}: {}",
          page.nodes.len()
        );
      }
      assert_viewport_bounds(&page, height, &what);
      if request.max_nodes != Some(20) {
        assert!(
          !post_titles(&page).is_empty(),
          "{what}: no card in {:?}",
          page.nodes.iter().map(|n| &n.name).collect::<Vec<_>>()
        );
      }
    }
  }
  // A label a web component slots into its own link names that link.
  let page = agent_perceive(&page_engine, &PerceptionRequest::default())
    .await
    .unwrap();
  assert!(
    page
      .nodes
      .iter()
      .any(|n| n.role == "link" && n.name.as_deref() == Some("Popular")),
    "the slotted nav label"
  );

  // A title named only by its text matches the full-card link too; the title
  // inside the card is the one clicked, and it opens the thread.
  let (id, title) = browser.title_in_view().await;
  let resolved = agent_resolve_locator(
    &native,
    &serde_json::from_value(json!({ "locator": { "role": "link", "name": title } })).unwrap(),
  )
  .await
  .unwrap();
  assert!(
    resolved
      .matched
      .attributes
      .iter()
      .any(|a| a.name == "id" && a.value == id)
      || resolved
        .matched
        .attributes
        .iter()
        .any(|a| a.name == "slot" && a.value == "title"),
    "{:?}",
    resolved.matched
  );
  let thread = id.trim_start_matches("post-title-");
  let clicked = agent_click_locator(
    &native,
    &click(json!({ "role": "link", "name": title, "attributes": [{ "name": "slot", "value": "title" }] })),
  )
  .await
  .unwrap();
  assert!(clicked.navigated, "the title opens its thread");
  let href = browser.evaluate("location.href").await;
  assert!(
    href
      .as_str()
      .unwrap()
      .ends_with(&format!("/post?id={thread}")),
    "{href}"
  );

  // By the id the page gives the title, which the browser's index may not
  // carry.
  browser.scrolled_feed(&base).await;
  let (id, _) = browser.title_in_view().await;
  let clicked = agent_click_locator(
    &native,
    &click(json!({ "attributes": [{ "name": "id", "value": id }] })),
  )
  .await
  .unwrap();
  assert!(clicked.navigated, "the id opens its thread");
  let thread = id.trim_start_matches("post-title-");
  let href = browser.evaluate("location.href").await;
  assert!(
    href
      .as_str()
      .unwrap()
      .ends_with(&format!("/post?id={thread}")),
    "{href}"
  );

  // Page text reaches into shadow roots, where innerText does not.
  browser.open(&format!("{base}/profile")).await;
  let inner = browser.evaluate("document.body.innerText").await;
  assert!(!inner.as_str().unwrap().contains("Cake day"), "{inner}");
  let text = browser.evaluate(&rendered_text_js("document.body")).await;
  let text = text.as_str().unwrap();
  assert!(text.contains("Account Age 15 y"), "{text}");
  assert!(text.contains("Cake day Mar 3, 2010"), "{text}");
  assert!(text.contains("After the stats."), "{text}");

  browser.stop().await;
}
