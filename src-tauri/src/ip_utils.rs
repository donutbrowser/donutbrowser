//! IP address utilities shared across the application.
//!
//! Provides IP validation and public IP fetching functionality.

use std::net::IpAddr;
use std::str::FromStr;

/// IP utility error type.
#[derive(Debug, thiserror::Error)]
pub enum IpError {
  #[error("Network error: {0}")]
  Network(String),
}

/// Validate an IP address (IPv4 or IPv6).
pub fn validate_ip(ip: &str) -> bool {
  IpAddr::from_str(ip).is_ok()
}

/// Tried in order. The first three answer over IPv4 only.
const ENDPOINTS: [&str; 6] = [
  "https://api.ipify.org",
  "https://checkip.amazonaws.com",
  "https://ipinfo.io/ip",
  "https://icanhazip.com",
  "https://ifconfig.co/ip",
  "https://ipecho.net/plain",
];

/// Answer over IPv6 only. Asked at the same time as `ENDPOINTS`, so an exit
/// with no IPv4 route gets its address before a provider that stalls on IPv4
/// targets uses up the deadline.
const IPV6_ENDPOINTS: [&str; 2] = ["https://api6.ipify.org", "https://ipv6.icanhazip.com"];

/// 10s rather than 5s: residential proxies that allocate an exit on first
/// connect routinely need more than 5s for the initial request.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Without it, a proxy that accepts connections but stalls holds callers for
/// every endpoint's full timeout.
const OVERALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// Fetch public IP address, optionally through a proxy.
pub async fn fetch_public_ip(proxy: Option<&str>) -> Result<String, IpError> {
  let client_builder = reqwest::Client::builder().timeout(REQUEST_TIMEOUT);
  let client = if let Some(proxy_url) = proxy {
    let proxy = reqwest::Proxy::all(proxy_url)
      .map_err(|e| IpError::Network(format!("Invalid proxy: {}", e)))?;
    client_builder
      .no_proxy()
      .proxy(proxy)
      .build()
      .map_err(|e| IpError::Network(e.to_string()))?
  } else {
    client_builder
      .build()
      .map_err(|e| IpError::Network(e.to_string()))?
  };

  let deadline = std::time::Instant::now() + OVERALL_DEADLINE;
  // The first IPv4 endpoint keeps its whole attempt, so an exit with both
  // families reports IPv4.
  prefer_first(
    ask_in_order(&client, &ENDPOINTS, deadline),
    ask_in_order(&client, &IPV6_ENDPOINTS, deadline),
    REQUEST_TIMEOUT,
  )
  .await
  .map_err(|errors| {
    IpError::Network(format!(
      "All {} endpoints failed: {}",
      errors.len(),
      errors.join("; ")
    ))
  })
}

/// The first endpoint's address, or every endpoint's error.
async fn ask_in_order(
  client: &reqwest::Client,
  urls: &[&str],
  deadline: std::time::Instant,
) -> Result<String, Vec<String>> {
  let mut errors = Vec::new();
  for url in urls {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
      errors.push(format!("{}: skipped (30s overall deadline reached)", url));
      continue;
    }

    let attempt = async {
      match client.get(*url).send().await {
        Ok(response) if response.status().is_success() => match response.text().await {
          Ok(text) => {
            let ip = text.trim().to_string();
            if validate_ip(&ip) {
              Ok(ip)
            } else {
              Err(format!("{}: response is not an IP address", url))
            }
          }
          Err(e) => Err(format!("{}: {}", url, e)),
        },
        Ok(response) => Err(format!("{}: HTTP {}", url, response.status())),
        Err(e) => Err(format!("{}: {}", url, e)),
      }
    };

    match tokio::time::timeout(remaining, attempt).await {
      Ok(Ok(ip)) => return Ok(ip),
      Ok(Err(e)) => errors.push(e),
      Err(_) => errors.push(format!("{}: timed out (30s overall deadline reached)", url)),
    }
  }
  Err(errors)
}

/// The answer of `first`, which runs beside `second`. The answer of `second`
/// counts when `first` fails or has none after `hold`.
async fn prefer_first<A, B>(
  first: A,
  second: B,
  hold: std::time::Duration,
) -> Result<String, Vec<String>>
where
  A: std::future::Future<Output = Result<String, Vec<String>>>,
  B: std::future::Future<Output = Result<String, Vec<String>>>,
{
  let until = tokio::time::Instant::now() + hold;
  tokio::pin!(first, second);
  tokio::select! {
    biased;
    result = &mut first => match result {
      Ok(ip) => Ok(ip),
      Err(mut errors) => second.await.map_err(|more| {
        errors.extend(more);
        errors
      }),
    },
    result = &mut second => match result {
      Ok(ip) => match tokio::time::timeout_at(until, first).await {
        Ok(Ok(preferred)) => Ok(preferred),
        _ => Ok(ip),
      },
      Err(more) => first.await.map_err(|mut errors| {
        errors.extend(more);
        errors
      }),
    },
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_validate_ip() {
    assert!(validate_ip("8.8.8.8"));
    assert!(validate_ip("192.168.1.1"));
    assert!(validate_ip("2001:4860:4860::8888"));
    assert!(!validate_ip("invalid"));
    assert!(!validate_ip("256.256.256.256"));
  }

  type Answer = Result<String, Vec<String>>;

  async fn after(ms: u64, answer: Answer) -> Answer {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    answer
  }

  fn ip(text: &str) -> Answer {
    Ok(text.to_string())
  }

  fn failed(text: &str) -> Answer {
    Err(vec![text.to_string()])
  }

  const HOLD: std::time::Duration = std::time::Duration::from_millis(200);

  #[tokio::test]
  async fn an_exit_with_both_families_reports_ipv4() {
    let ipv4 = after(150, ip("192.0.2.1"));
    let ipv6 = after(10, ip("2001:db8::1"));
    assert_eq!(prefer_first(ipv4, ipv6, HOLD).await, ip("192.0.2.1"));
  }

  #[tokio::test]
  async fn an_ipv4_answer_after_the_hold_loses_to_ipv6() {
    let ipv4 = after(400, ip("192.0.2.1"));
    let ipv6 = after(10, ip("2001:db8::1"));
    assert_eq!(prefer_first(ipv4, ipv6, HOLD).await, ip("2001:db8::1"));
  }

  #[tokio::test]
  async fn an_ipv6_only_exit_is_not_held_by_stalled_ipv4_endpoints() {
    let started = std::time::Instant::now();
    let ipv4 = std::future::pending::<Answer>();
    let ipv6 = after(10, ip("2001:db8::1"));
    assert_eq!(prefer_first(ipv4, ipv6, HOLD).await, ip("2001:db8::1"));
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
  }

  #[tokio::test]
  async fn an_ipv6_answer_counts_when_ipv4_fails() {
    let ipv4 = after(10, failed("a: refused"));
    let ipv6 = after(50, ip("2001:db8::1"));
    assert_eq!(prefer_first(ipv4, ipv6, HOLD).await, ip("2001:db8::1"));
  }

  #[tokio::test]
  async fn an_ipv4_only_exit_does_not_wait_for_ipv6() {
    let ipv4 = after(10, ip("192.0.2.1"));
    let ipv6 = std::future::pending::<Answer>();
    assert_eq!(prefer_first(ipv4, ipv6, HOLD).await, ip("192.0.2.1"));
  }

  #[tokio::test]
  async fn a_dead_route_reports_every_error() {
    let ipv4 = after(20, failed("a: refused"));
    let ipv6 = after(10, failed("b: refused"));
    assert_eq!(
      prefer_first(ipv4, ipv6, HOLD).await,
      Err(vec!["a: refused".to_string(), "b: refused".to_string()])
    );
  }
}
