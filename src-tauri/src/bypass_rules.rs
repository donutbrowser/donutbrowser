//! Proxy bypass rules: hosts a profile reaches directly, without its proxy or VPN.

use regex_lite::Regex;
use std::net::IpAddr;
use std::sync::Arc;

enum Rule {
  /// `example.com` matches the domain and its subdomains; `*.example.com` and
  /// `.example.com` only its subdomains.
  Domain {
    name: String,
    subdomains_only: bool,
  },
  Ip(IpAddr),
  /// `10.0.0.0/8`. Only a host given as an address is in a range: names are
  /// not resolved to decide.
  Range {
    network: IpAddr,
    prefix: u8,
  },
  /// Anything else. It must match the whole host name, so `example\.com`
  /// cannot also send `example.com.attacker.net` around the proxy.
  Regex(Regex),
}

impl Rule {
  fn parse(text: &str) -> Option<Self> {
    let text = text.trim();
    if text.is_empty() {
      return None;
    }
    let unbracketed = text
      .strip_prefix('[')
      .and_then(|rest| rest.strip_suffix(']'))
      .unwrap_or(text);
    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
      return Some(Self::Ip(ip));
    }
    if let Some((address, prefix)) = text.split_once('/') {
      if let Ok(network) = address.parse::<IpAddr>() {
        let max = if network.is_ipv4() { 32 } else { 128 };
        return prefix
          .parse::<u8>()
          .ok()
          .filter(|prefix| *prefix <= max)
          .map(|prefix| Self::Range { network, prefix });
      }
    }
    let lower = text.to_ascii_lowercase();
    let (name, subdomains_only) = match lower.strip_prefix("*.").or_else(|| lower.strip_prefix('.'))
    {
      Some(rest) => (rest, true),
      None => (lower.as_str(), false),
    };
    let name = name.strip_suffix('.').unwrap_or(name);
    if is_host_name(name) {
      return Some(Self::Domain {
        name: name.to_string(),
        subdomains_only,
      });
    }
    // A pasted URL: no host has a scheme, so as a regex it would match nothing.
    if text.contains("://") {
      return None;
    }
    Regex::new(&format!("(?i)^(?:{text})$"))
      .ok()
      .map(Self::Regex)
  }

  fn matches(&self, host: &str, ip: Option<IpAddr>) -> bool {
    match self {
      Self::Domain {
        name,
        subdomains_only,
      } => host
        .strip_suffix(name.as_str())
        .is_some_and(|rest| match rest {
          "" => !subdomains_only,
          rest => rest.ends_with('.'),
        }),
      Self::Ip(rule) => ip == Some(*rule),
      Self::Range { network, prefix } => ip.is_some_and(|ip| in_range(ip, *network, *prefix)),
      Self::Regex(regex) => regex.is_match(host),
    }
  }
}

fn is_host_name(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= 253
    && name.split('.').all(|label| {
      !label.is_empty()
        && label
          .bytes()
          .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

fn in_range(ip: IpAddr, network: IpAddr, prefix: u8) -> bool {
  match (ip, network) {
    (IpAddr::V4(ip), IpAddr::V4(network)) => {
      let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
      u32::from(ip) & mask == u32::from(network) & mask
    }
    (IpAddr::V6(ip), IpAddr::V6(network)) => {
      let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
      u128::from(ip) & mask == u128::from(network) & mask
    }
    _ => false,
  }
}

/// Trims the rules and drops blank lines and repeats. Refuses a rule that is
/// not a host name, an IP address, an IP range or a regex.
pub fn checked(rules: Vec<String>) -> Result<Vec<String>, String> {
  let mut kept: Vec<String> = Vec::with_capacity(rules.len());
  for rule in rules {
    let rule = rule.trim();
    if rule.is_empty() || kept.iter().any(|known| known == rule) {
      continue;
    }
    if Rule::parse(rule).is_none() {
      return Err(
        serde_json::json!({ "code": "BYPASS_RULE_INVALID", "params": { "rule": rule } })
          .to_string(),
      );
    }
    kept.push(rule.to_string());
  }
  Ok(kept)
}

#[derive(Clone)]
pub struct BypassMatcher {
  rules: Arc<Vec<Rule>>,
}

impl BypassMatcher {
  /// A rule that does not parse matches nothing. Saved rules went through
  /// `checked`; this covers ones written by an older version.
  pub fn new(rules: &[String]) -> Self {
    Self {
      rules: Arc::new(rules.iter().filter_map(|rule| Rule::parse(rule)).collect()),
    }
  }

  pub fn should_bypass(&self, host: &str) -> bool {
    if self.rules.is_empty() {
      return false;
    }
    let host = host
      .strip_prefix('[')
      .and_then(|rest| rest.strip_suffix(']'))
      .unwrap_or(host);
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    let ip = host.parse::<IpAddr>().ok();
    self.rules.iter().any(|rule| rule.matches(&host, ip))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn matcher(rules: &[&str]) -> BypassMatcher {
    BypassMatcher::new(&rules.iter().map(|r| r.to_string()).collect::<Vec<_>>())
  }

  #[test]
  fn a_domain_matches_itself_and_its_subdomains_only() {
    let m = matcher(&["example.com"]);
    assert!(m.should_bypass("example.com"));
    assert!(m.should_bypass("api.example.com"));
    assert!(m.should_bypass("API.Example.COM."));
    assert!(!m.should_bypass("notexample.com"));
    assert!(!m.should_bypass("example.com.attacker.net"));
    assert!(!m.should_bypass("examplexcom"));
  }

  #[test]
  fn a_wildcard_domain_matches_only_subdomains() {
    for rule in ["*.example.com", ".example.com"] {
      let m = matcher(&[rule]);
      assert!(m.should_bypass("a.b.example.com"), "{rule}");
      assert!(!m.should_bypass("example.com"), "{rule}");
      assert!(!m.should_bypass("badexample.com"), "{rule}");
    }
  }

  #[test]
  fn addresses_and_ranges_match_hosts_given_as_addresses() {
    let m = matcher(&["192.168.1.10", "10.0.0.0/8", "[::1]", "fd00::/8"]);
    assert!(m.should_bypass("192.168.1.10"));
    assert!(!m.should_bypass("192.168.1.100"));
    assert!(m.should_bypass("10.200.3.4"));
    assert!(!m.should_bypass("11.0.0.1"));
    assert!(m.should_bypass("[::1]"));
    assert!(m.should_bypass("fd12:3456::1"));
    assert!(!m.should_bypass("fe80::1"));
    assert!(!m.should_bypass("10.example.com"));
    assert!(matcher(&["0.0.0.0/0"]).should_bypass("8.8.8.8"));
  }

  #[test]
  fn a_regex_must_match_the_whole_host() {
    let m = matcher(&[r".*\.local", r"^127\.0\.0\.\d+", "192.168.1.*"]);
    assert!(m.should_bypass("printer.local"));
    assert!(!m.should_bypass("printer.local.attacker.net"));
    assert!(m.should_bypass("127.0.0.7"));
    assert!(m.should_bypass("192.168.1.55"));
    assert!(!m.should_bypass("8.192.168.1.5"));
  }

  #[test]
  fn no_rules_bypass_nothing() {
    assert!(!matcher(&[]).should_bypass("example.com"));
  }

  #[test]
  fn checked_tidies_rules_and_refuses_bad_ones() {
    assert_eq!(
      checked(vec![
        " example.com ".into(),
        String::new(),
        "example.com".into(),
        "10.0.0.0/8".into(),
      ])
      .unwrap(),
      vec!["example.com", "10.0.0.0/8"]
    );
    for bad in [
      "10.0.0.0/33",
      "*",
      "[a-",
      "(unclosed",
      "https://example.com/",
    ] {
      let err: serde_json::Value =
        serde_json::from_str(&checked(vec![bad.into()]).unwrap_err()).unwrap();
      assert_eq!(err["code"], "BYPASS_RULE_INVALID", "{bad}");
      assert_eq!(err["params"]["rule"], bad);
    }
  }
}
