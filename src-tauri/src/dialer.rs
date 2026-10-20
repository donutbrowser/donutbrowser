//! Outbound TCP dials of the proxy worker: the destination of a direct route,
//! and the upstream proxy itself.
//!
//! One name lookup per host runs at a time, and a good answer is used again
//! for a short time. The connection then races across the addresses
//! (RFC 8305): the first address starts at once, the next one when an attempt
//! fails or `ATTEMPT_DELAY` passes, and the first connection wins. An address
//! that never answers (often an IPv6 route that drops packets) costs one
//! delay, not the whole time limit. A failure is never remembered: the next
//! dial of the same host starts again.

use futures_util::future::BoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time::Instant;

/// Wait before the next address starts while earlier attempts still run.
const ATTEMPT_DELAY: Duration = Duration::from_millis(250);
/// Limit for one attempt while more addresses wait. The last attempt runs
/// until the limit of the dial.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(4);
/// Attempts of one dial that run at the same time. Keeps a dial inside the
/// descriptor budget of one connection.
const MAX_IN_FLIGHT: usize = 4;
/// Limit for a caller that waits for a name lookup.
pub(crate) const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// Until a lookup has run this long, every caller for the same host waits for
/// it. A stuck system resolver then gets one blocking call per host, not one
/// per connection, and each caller still waits for an answer that can come.
const STALE_LOOKUP: Duration = LOOKUP_TIMEOUT;
/// How long a good answer is used again.
const ANSWER_TTL: Duration = Duration::from_secs(30);
const MAX_HOSTS: usize = 2048;

type Answer = Result<Arc<[SocketAddr]>, (io::ErrorKind, String)>;
pub(crate) type Lookup =
  Arc<dyn Fn(String) -> BoxFuture<'static, io::Result<Vec<SocketAddr>>> + Send + Sync>;

enum Entry {
  Ready {
    addrs: Arc<[SocketAddr]>,
    until: Instant,
  },
  Pending {
    id: u64,
    started: Instant,
    done: watch::Receiver<Option<Answer>>,
  },
}

struct ResolverInner {
  lookup: Lookup,
  hosts: Mutex<HashMap<String, Entry>>,
  next_id: AtomicU64,
}

/// Name lookups shared by every dial of the worker. Cheap to clone.
#[derive(Clone)]
pub(crate) struct HostResolver {
  inner: Arc<ResolverInner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl HostResolver {
  pub(crate) fn new(lookup: Lookup) -> Self {
    Self {
      inner: Arc::new(ResolverInner {
        lookup,
        hosts: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
      }),
    }
  }

  /// The system resolver (`getaddrinfo`).
  pub(crate) fn system() -> &'static HostResolver {
    static SYSTEM: OnceLock<HostResolver> = OnceLock::new();
    SYSTEM.get_or_init(|| {
      HostResolver::new(Arc::new(
        |host: String| -> BoxFuture<'static, io::Result<Vec<SocketAddr>>> {
          Box::pin(async move { Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.collect()) })
        },
      ))
    })
  }

  /// Addresses of `host` with port 0, in the order of the resolver.
  pub(crate) async fn resolve(&self, host: &str, limit: Duration) -> io::Result<Arc<[SocketAddr]>> {
    let key = host.to_ascii_lowercase();
    let mut done = {
      let mut hosts = lock(&self.inner.hosts);
      let now = Instant::now();
      match hosts.get(&key) {
        Some(Entry::Ready { addrs, until }) if *until > now => return Ok(addrs.clone()),
        Some(Entry::Pending { started, done, .. })
          if now.duration_since(*started) < STALE_LOOKUP =>
        {
          done.clone()
        }
        _ => self.start_lookup(&mut hosts, key),
      }
    };
    let limit = limit.min(LOOKUP_TIMEOUT);
    let answer = match tokio::time::timeout(limit, done.wait_for(Option::is_some)).await {
      Ok(Ok(answer)) => (*answer).clone(),
      Ok(Err(_)) => None,
      Err(_) => {
        return Err(io::Error::new(
          io::ErrorKind::TimedOut,
          format!("name lookup for {host} timed out after {limit:?}"),
        ))
      }
    };
    match answer {
      Some(Ok(addrs)) => Ok(addrs),
      Some(Err((kind, e))) => Err(io::Error::new(
        kind,
        format!("name lookup for {host} failed: {e}"),
      )),
      None => Err(io::Error::other(format!("name lookup for {host} stopped"))),
    }
  }

  /// The lookup runs in its own task, so it ends and fills the cache even when
  /// every caller has stopped waiting.
  fn start_lookup(
    &self,
    hosts: &mut HashMap<String, Entry>,
    key: String,
  ) -> watch::Receiver<Option<Answer>> {
    if hosts.len() >= MAX_HOSTS {
      let now = Instant::now();
      hosts.retain(|_, entry| match entry {
        Entry::Ready { until, .. } => *until > now,
        Entry::Pending { .. } => true,
      });
      if hosts.len() >= MAX_HOSTS {
        hosts.retain(|_, entry| matches!(entry, Entry::Pending { .. }));
      }
    }
    let (tx, rx) = watch::channel(None);
    let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
    hosts.insert(
      key.clone(),
      Entry::Pending {
        id,
        started: Instant::now(),
        done: rx.clone(),
      },
    );
    let lookup = (self.inner.lookup)(key.clone());
    let inner = Arc::clone(&self.inner);
    tokio::spawn(async move {
      let answer: Answer = match lookup.await {
        Ok(found) => {
          let mut addrs: Vec<SocketAddr> = Vec::with_capacity(found.len());
          for addr in found {
            if !addrs.contains(&addr) {
              addrs.push(addr);
            }
          }
          if addrs.is_empty() {
            Err((io::ErrorKind::NotFound, "no address".to_string()))
          } else {
            Ok(addrs.into())
          }
        }
        Err(e) => Err((e.kind(), e.to_string())),
      };
      inner.finish(&key, id, &answer);
      let _ = tx.send(Some(answer));
    });
    rx
  }

  /// Put `winner` first for the next dials of `host`, so an address that
  /// does not answer costs the delay once per answer, not once per dial.
  pub(crate) fn prefer(&self, host: &str, winner: IpAddr) {
    let mut hosts = lock(&self.inner.hosts);
    let Some(Entry::Ready { addrs, .. }) = hosts.get_mut(&host.to_ascii_lowercase()) else {
      return;
    };
    if let Some(position) = addrs.iter().position(|a| a.ip() == winner) {
      if position > 0 {
        let mut reordered = addrs.to_vec();
        let first = reordered.remove(position);
        reordered.insert(0, first);
        *addrs = reordered.into();
      }
    }
  }
}

impl ResolverInner {
  /// A good answer is kept; a failed one is dropped, so the next caller looks
  /// the name up again.
  fn finish(&self, key: &str, id: u64, answer: &Answer) {
    let mut hosts = lock(&self.hosts);
    match answer {
      Ok(addrs) => {
        hosts.insert(
          key.to_string(),
          Entry::Ready {
            addrs: addrs.clone(),
            until: Instant::now() + ANSWER_TTL,
          },
        );
      }
      Err(_) => {
        if matches!(hosts.get(key), Some(Entry::Pending { id: pending, .. }) if *pending == id) {
          hosts.remove(key);
        }
      }
    }
  }
}

/// Address families of the attempts of one dial.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Families {
  ipv4: bool,
  ipv6: bool,
}

impl Families {
  fn add(&mut self, addr: SocketAddr) {
    if addr.is_ipv4() {
      self.ipv4 = true;
    } else {
      self.ipv6 = true;
    }
  }
}

impl std::fmt::Display for Families {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(match (self.ipv4, self.ipv6) {
      (true, true) => "ipv4,ipv6",
      (true, false) => "ipv4",
      (false, true) => "ipv6",
      (false, false) => "none",
    })
  }
}

/// Timings of a race across addresses.
pub(crate) struct Race {
  /// Wait before the next address starts while earlier attempts still run.
  pub stagger: Duration,
  /// Limit for one attempt while more addresses wait.
  pub attempt_timeout: Duration,
  /// The dial fails at this instant.
  pub deadline: Instant,
}

/// Why no attempt connected.
#[derive(Debug)]
pub(crate) struct RaceFailure {
  pub attempts: usize,
  pub families: Families,
  pub deadline_hit: bool,
  pub last: Option<io::Error>,
}

impl RaceFailure {
  /// One error for the log. `what` names the dial: `direct connect to h:443`.
  /// It never names an address: a log line must not list visited sites.
  pub(crate) fn into_error(self, what: &str, limit: Duration) -> io::Error {
    let tail = format!("attempts={} families={}", self.attempts, self.families);
    match self.last {
      _ if self.deadline_hit => io::Error::new(
        io::ErrorKind::TimedOut,
        format!("{what} timed out after {limit:?} {tail}"),
      ),
      Some(last) => io::Error::new(last.kind(), format!("{what} failed: {last} {tail}")),
      None => io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{what} failed: no address {tail}"),
      ),
    }
  }
}

/// RFC 8305 order: the families alternate, starting with the family of the
/// first address.
fn interleave(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
  let Some(first) = addrs.first() else {
    return addrs;
  };
  let lead_is_v6 = first.is_ipv6();
  let (lead, other): (Vec<_>, Vec<_>) = addrs
    .into_iter()
    .partition(|addr| addr.is_ipv6() == lead_is_v6);
  let mut order = Vec::with_capacity(lead.len() + other.len());
  let mut lead = lead.into_iter();
  let mut other = other.into_iter();
  loop {
    match (lead.next(), other.next()) {
      (None, None) => return order,
      (a, b) => order.extend(a.into_iter().chain(b)),
    }
  }
}

/// Run `connect` across `addrs` and return the first connection with its
/// address. The losing attempts are dropped.
pub(crate) async fn race<T, F, Fut>(
  addrs: Vec<SocketAddr>,
  plan: &Race,
  mut connect: F,
) -> Result<(T, SocketAddr), RaceFailure>
where
  F: FnMut(SocketAddr) -> Fut,
  Fut: Future<Output = io::Result<T>>,
{
  let mut waiting: VecDeque<SocketAddr> = interleave(addrs).into();
  let mut running = FuturesUnordered::new();
  let mut failure = RaceFailure {
    attempts: 0,
    families: Families::default(),
    deadline_hit: false,
    last: None,
  };
  let mut next_start = Instant::now();
  loop {
    let now = Instant::now();
    if running.len() < MAX_IN_FLIGHT && (running.is_empty() || now >= next_start) {
      if let Some(addr) = waiting.pop_front() {
        failure.attempts += 1;
        failure.families.add(addr);
        let limit = if waiting.is_empty() {
          plan.deadline
        } else {
          (now + plan.attempt_timeout).min(plan.deadline)
        };
        let attempt = connect(addr);
        running.push(async move { (addr, tokio::time::timeout_at(limit, attempt).await) });
        next_start = now + plan.stagger;
        continue;
      }
    }
    if running.is_empty() {
      failure.deadline_hit = Instant::now() >= plan.deadline;
      return Err(failure);
    }
    let may_start = running.len() < MAX_IN_FLIGHT && !waiting.is_empty();
    tokio::select! {
      Some((addr, outcome)) = running.next() => {
        let error = match outcome {
          Ok(Ok(value)) => return Ok((value, addr)),
          Ok(Err(e)) => e,
          Err(_) => io::Error::new(io::ErrorKind::TimedOut, "attempt timed out"),
        };
        log::debug!("Dial attempt failed addr={addr} err=\"{error}\"");
        failure.last = Some(error);
        next_start = Instant::now();
      }
      () = tokio::time::sleep_until(next_start), if may_start => {}
      () = tokio::time::sleep_until(plan.deadline) => {
        failure.deadline_hit = true;
        return Err(failure);
      }
    }
  }
}

/// Race TCP connections to `addrs` with the timings of RFC 8305.
pub(crate) async fn connect_addrs(
  what: &str,
  addrs: Vec<SocketAddr>,
  deadline: Instant,
  limit: Duration,
) -> io::Result<(TcpStream, SocketAddr)> {
  let plan = Race {
    stagger: ATTEMPT_DELAY,
    attempt_timeout: ATTEMPT_TIMEOUT,
    deadline,
  };
  match race(addrs, &plan, TcpStream::connect).await {
    Ok((stream, addr)) => {
      let _ = stream.set_nodelay(true);
      Ok((stream, addr))
    }
    Err(failure) => Err(failure.into_error(what, limit)),
  }
}

/// Connect to `host:port` within `limit`, name lookup included. `role` starts
/// the error text: `direct`, `upstream proxy`.
pub(crate) async fn connect_host(
  role: &str,
  host: &str,
  port: u16,
  limit: Duration,
) -> io::Result<TcpStream> {
  connect_host_with(HostResolver::system(), role, host, port, limit).await
}

async fn connect_host_with(
  resolver: &HostResolver,
  role: &str,
  host: &str,
  port: u16,
  limit: Duration,
) -> io::Result<TcpStream> {
  let deadline = Instant::now() + limit;
  let host = host
    .strip_prefix('[')
    .and_then(|h| h.strip_suffix(']'))
    .unwrap_or(host);
  let what = format!(
    "{role} connect to {}",
    crate::proxy_server::connect_authority(host, port)
  );
  if let Ok(ip) = host.parse::<IpAddr>() {
    let addrs = vec![SocketAddr::new(ip, port)];
    return Ok(connect_addrs(&what, addrs, deadline, limit).await?.0);
  }
  let addrs = resolver
    .resolve(host, limit)
    .await?
    .iter()
    .map(|addr| {
      let mut addr = *addr;
      addr.set_port(port);
      addr
    })
    .collect();
  let (stream, winner) = connect_addrs(&what, addrs, deadline, limit).await?;
  resolver.prefer(host, winner.ip());
  Ok(stream)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::AtomicUsize;

  fn plan(attempt_timeout: Duration, limit: Duration) -> Race {
    Race {
      stagger: ATTEMPT_DELAY,
      attempt_timeout,
      deadline: Instant::now() + limit,
    }
  }

  /// A port on this machine where nothing listens.
  async fn closed_port() -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap()
  }

  fn resolver_of(
    addrs: Vec<SocketAddr>,
    calls: Arc<AtomicUsize>,
    fail_first: bool,
  ) -> HostResolver {
    HostResolver::new(Arc::new(
      move |_host: String| -> BoxFuture<'static, io::Result<Vec<SocketAddr>>> {
        let call = calls.fetch_add(1, Ordering::SeqCst);
        let addrs = addrs.clone();
        Box::pin(async move {
          tokio::time::sleep(Duration::from_millis(100)).await;
          if fail_first && call == 0 {
            Err(io::Error::other("resolver not ready"))
          } else {
            Ok(addrs)
          }
        })
      },
    ))
  }

  #[test]
  fn families_alternate_from_the_first_answer() {
    let v6 = |n: u16| {
      SocketAddr::new(
        IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, n)),
        443,
      )
    };
    let v4 = |n: u8| SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, n)), 443);
    assert_eq!(
      interleave(vec![v6(1), v6(2), v6(3), v4(1), v4(2)]),
      vec![v6(1), v4(1), v6(2), v4(2), v6(3)]
    );
    assert_eq!(
      interleave(vec![v4(1), v4(2), v6(1)]),
      vec![v4(1), v6(1), v4(2)]
    );
    assert!(interleave(Vec::new()).is_empty());
  }

  #[tokio::test]
  async fn an_address_that_never_answers_costs_one_delay() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let good = listener.local_addr().unwrap();
    let black_hole: SocketAddr = "192.0.2.1:9".parse().unwrap();
    let started = std::time::Instant::now();
    let (_, winner) = race(
      vec![black_hole, good],
      &plan(Duration::from_secs(4), Duration::from_secs(10)),
      |addr| async move {
        if addr == black_hole {
          std::future::pending::<()>().await;
        }
        TcpStream::connect(addr).await
      },
    )
    .await
    .expect("the second address connects");
    assert_eq!(winner, good);
    assert!(
      started.elapsed() < Duration::from_secs(1),
      "{:?}",
      started.elapsed()
    );
  }

  #[tokio::test]
  async fn a_real_unreachable_first_address_does_not_use_the_whole_limit() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let good = listener.local_addr().unwrap();
    let started = std::time::Instant::now();
    let (_, winner) = connect_addrs(
      "direct connect to test",
      vec!["10.255.255.1:9".parse().unwrap(), good],
      Instant::now() + Duration::from_secs(10),
      Duration::from_secs(10),
    )
    .await
    .expect("the local listener connects");
    assert_eq!(winner, good);
    assert!(
      started.elapsed() < Duration::from_secs(2),
      "{:?}",
      started.elapsed()
    );
  }

  #[tokio::test]
  async fn when_every_address_fails_the_error_counts_the_attempts() {
    let addrs = vec![closed_port().await, closed_port().await];
    let error = connect_addrs(
      "direct connect to test",
      addrs,
      Instant::now() + Duration::from_secs(5),
      Duration::from_secs(5),
    )
    .await
    .expect_err("nothing listens");
    let text = error.to_string();
    assert!(text.contains("attempts=2"), "{text}");
    assert!(text.contains("families=ipv4"), "{text}");
    assert_ne!(error.kind(), io::ErrorKind::TimedOut, "{text}");

    let silent: Vec<SocketAddr> = vec![
      "192.0.2.1:9".parse().unwrap(),
      "[2001:db8::1]:9".parse().unwrap(),
    ];
    let failure = race(
      silent,
      &plan(Duration::from_millis(200), Duration::from_millis(600)),
      |_| std::future::pending::<io::Result<()>>(),
    )
    .await
    .expect_err("nothing answers");
    assert_eq!(failure.attempts, 2);
    assert!(failure.deadline_hit);
    let error = failure.into_error("direct connect to test", Duration::from_millis(600));
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(error.to_string().contains("families=ipv4,ipv6"), "{error}");
  }

  #[tokio::test]
  async fn concurrent_dials_of_one_host_share_one_lookup() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(AtomicUsize::new(0));
    let resolver = resolver_of(vec!["127.0.0.1:0".parse().unwrap()], calls.clone(), false);
    let dials = (0..16).map(|_| {
      let resolver = resolver.clone();
      tokio::spawn(async move {
        connect_host_with(
          &resolver,
          "direct",
          "Example.Test",
          port,
          Duration::from_secs(5),
        )
        .await
      })
    });
    for dial in futures_util::future::join_all(dials).await {
      dial.unwrap().expect("dial through the shared lookup");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    connect_host_with(
      &resolver,
      "direct",
      "example.test",
      port,
      Duration::from_secs(5),
    )
    .await
    .expect("cached answer");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the answer is reused");
  }

  #[tokio::test]
  async fn a_failed_dial_does_not_fail_the_next_dial_of_the_host() {
    let calls = Arc::new(AtomicUsize::new(0));
    let resolver = resolver_of(vec!["127.0.0.1:0".parse().unwrap()], calls.clone(), true);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    connect_host_with(
      &resolver,
      "direct",
      "example.test",
      port,
      Duration::from_secs(5),
    )
    .await
    .expect_err("the first lookup fails");
    connect_host_with(
      &resolver,
      "direct",
      "example.test",
      port,
      Duration::from_secs(5),
    )
    .await
    .expect("a failed lookup is not remembered");
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let refused = closed_port().await.port();
    let error = connect_host_with(
      &resolver,
      "direct",
      "example.test",
      refused,
      Duration::from_secs(5),
    )
    .await
    .expect_err("nothing listens");
    assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused, "{error}");
    let started = std::time::Instant::now();
    connect_host_with(
      &resolver,
      "direct",
      "example.test",
      port,
      Duration::from_secs(5),
    )
    .await
    .expect("a failed connect is not remembered");
    assert!(started.elapsed() < Duration::from_secs(1));
  }

  #[tokio::test]
  async fn the_address_that_answered_goes_first_next_time() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(AtomicUsize::new(0));
    let resolver = resolver_of(
      vec![
        "127.0.0.2:0".parse().unwrap(),
        "127.0.0.1:0".parse().unwrap(),
      ],
      calls,
      false,
    );
    // 127.0.0.2 refuses on Linux and times out on macOS; either way the
    // second address wins.
    connect_host_with(
      &resolver,
      "direct",
      "example.test",
      port,
      Duration::from_secs(5),
    )
    .await
    .expect("the second address connects");
    let order = resolver
      .resolve("example.test", LOOKUP_TIMEOUT)
      .await
      .unwrap();
    assert_eq!(order[0].ip(), "127.0.0.1".parse::<IpAddr>().unwrap());
  }

  #[tokio::test]
  async fn ip_literals_skip_the_lookup() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(AtomicUsize::new(0));
    let resolver = resolver_of(Vec::new(), calls.clone(), false);
    connect_host_with(
      &resolver,
      "direct",
      "127.0.0.1",
      port,
      Duration::from_secs(5),
    )
    .await
    .expect("literal");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
  }
}
