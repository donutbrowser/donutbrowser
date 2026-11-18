//! Sign-in for a task: the profile's saved logins for the task's site, from
//! its own `Login Data` and `os_crypt_key`, with the 2FA key the profile keeps
//! for that site. They go only into `Wayfern.agentStart` over the profile's
//! own local debugging socket: never into a prompt, a log or the cloud.

use crate::profile_import::os_crypt::key_for_tag;
use crate::totp::TotpKey;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

/// Logins one task gets at most.
const MAX_LOGINS: usize = 5;

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Totp {
  pub secret: String,
  pub algorithm: crate::totp::TotpAlgorithm,
  pub digits: u32,
  pub period: u64,
}

/// One account on the site. No `Debug`: nothing prints it by mistake.
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Login {
  pub origin: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub username: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub password: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub totp: Option<Totp>,
}

/// A saved row as it reads, before it is matched to a site.
pub struct Saved {
  pub origin: String,
  pub username: String,
  pub password: String,
}

/// A host without `www.`, lower case.
pub fn host_of(url: &str) -> Option<String> {
  let parsed = url::Url::parse(url).ok()?;
  if !matches!(parsed.scheme(), "http" | "https") {
    return None;
  }
  let host = parsed.host_str()?.to_ascii_lowercase();
  Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

/// The registered part of a host: `shop.example.com` is `example.com`,
/// `a.example.co.uk` is `example.co.uk`.
pub fn base_of(host: &str) -> String {
  let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
  let keep = match labels.as_slice() {
    [.., second, last] if last.len() == 2 && second.len() <= 3 && labels.len() > 2 => 3,
    _ => 2,
  };
  labels[labels.len().saturating_sub(keep)..].join(".")
}

/// Whether a login saved for `saved` serves `site`.
pub fn same_site(saved: &str, site: &str) -> bool {
  saved == site || base_of(saved) == base_of(site)
}

/// The site's name as people write it: `github` for `github.com`.
fn site_name(site: &str) -> String {
  base_of(site)
    .split('.')
    .next()
    .unwrap_or_default()
    .to_string()
}

/// Whether a 2FA key, by its label, issuer or account, is for `site`.
pub fn totp_for(label: &str, key: &TotpKey, site: &str) -> bool {
  let name = site_name(site);
  if name.len() < 3 {
    return false;
  }
  [Some(label), key.issuer.as_deref(), key.account.as_deref()]
    .into_iter()
    .flatten()
    .any(|text| {
      let text = text.to_lowercase();
      text.contains(&name) || text.contains(&base_of(site))
    })
}

/// The logins for `site`: each saved account, then a 2FA key matched to the
/// site, on the first account or alone when none is saved.
pub fn select(saved: Vec<Saved>, keys: &[(String, TotpKey)], site: &str) -> Vec<Login> {
  let mut logins: Vec<Login> = Vec::new();
  for row in saved {
    let Some(host) = host_of(&row.origin) else {
      continue;
    };
    if !same_site(&host, site) || (row.username.is_empty() && row.password.is_empty()) {
      continue;
    }
    let duplicate = logins
      .iter()
      .any(|login| login.username.as_deref() == Some(row.username.as_str()));
    if duplicate {
      continue;
    }
    logins.push(Login {
      origin: row.origin,
      username: (!row.username.is_empty()).then_some(row.username),
      password: (!row.password.is_empty()).then_some(row.password),
      totp: None,
    });
    if logins.len() == MAX_LOGINS {
      break;
    }
  }
  let totp = keys
    .iter()
    .find(|(label, key)| totp_for(label, key, site))
    .map(|(_, key)| Totp {
      secret: key.secret.clone(),
      algorithm: key.algorithm,
      digits: key.digits,
      period: key.period,
    });
  if let Some(totp) = totp {
    match logins.first_mut() {
      Some(first) => first.totp = Some(totp),
      None => logins.push(Login {
        origin: format!("https://{site}"),
        username: None,
        password: None,
        totp: Some(totp),
      }),
    }
  }
  logins
}

/// Open one stored password as Chromium sealed it.
fn open_value(key_file: &[u8], stored: &[u8]) -> Option<String> {
  if stored.len() < 3 {
    return String::from_utf8(stored.to_vec()).ok();
  }
  let (tag, body) = stored.split_at(3);
  if !matches!(tag, b"v10" | b"v11") {
    return String::from_utf8(stored.to_vec()).ok();
  }
  let key = key_for_tag(key_file, tag)?;
  let plain = key
    .with_fallbacks()
    .iter()
    .find_map(|candidate| candidate.decrypt(body))?;
  String::from_utf8(plain).ok()
}

/// Every saved login of a profile's user-data folder, read from a copy.
pub fn saved_logins(user_data_dir: &Path) -> Vec<Saved> {
  let Some(file) = [
    user_data_dir.join("Default").join("Login Data"),
    user_data_dir.join("Login Data"),
  ]
  .into_iter()
  .find(|path| path.is_file()) else {
    return Vec::new();
  };
  let key_file = std::fs::read(user_data_dir.join(crate::profile_import::os_crypt::KEY_FILE_NAME))
    .unwrap_or_default();
  let read = || -> Result<Vec<Saved>, String> {
    let dir = tempfile::Builder::new()
      .prefix("donut-logins-")
      .tempdir()
      .map_err(|e| e.to_string())?;
    let copy = dir.path().join("Login Data");
    std::fs::copy(&file, &copy).map_err(|e| e.to_string())?;
    crate::app_dirs::restrict_to_owner(&copy);
    let conn = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY)
      .map_err(|e| e.to_string())?;
    let mut statement = conn
      .prepare("SELECT origin_url, username_value, password_value FROM logins ORDER BY date_last_used DESC")
      .or_else(|_| conn.prepare("SELECT origin_url, username_value, password_value FROM logins"))
      .map_err(|e| e.to_string())?;
    let rows = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, Option<String>>(1)?,
          row.get::<_, Option<Vec<u8>>>(2)?,
        ))
      })
      .map_err(|e| e.to_string())?;
    Ok(
      rows
        .flatten()
        .map(|(origin, username, stored)| Saved {
          origin,
          username: username.unwrap_or_default(),
          password: stored
            .and_then(|stored| open_value(&key_file, &stored))
            .unwrap_or_default(),
        })
        .collect(),
    )
  };
  read().unwrap_or_else(|e| {
    log::warn!("Agent logins unreadable err=\"{e}\"");
    Vec::new()
  })
}

/// The logins a task in `profile` gets for the site of `url`.
pub fn for_task(profile: &crate::profile::BrowserProfile, url: Option<&str>) -> Vec<Login> {
  let Some(site) = url.and_then(host_of) else {
    return Vec::new();
  };
  let profile_id = profile.id.to_string();
  let profiles_dir = crate::profile::ProfileManager::instance().get_profiles_dir();
  let user_data_dir = crate::ephemeral_dirs::get_effective_profile_path(profile, &profiles_dir);
  let keys = crate::profile_totp::keys(&profile_id).unwrap_or_default();
  select(saved_logins(&user_data_dir), &keys, &site)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::profile_import::os_crypt::TargetKey;

  fn key(issuer: Option<&str>) -> TotpKey {
    TotpKey {
      secret: "JBSWY3DPEHPK3PXP".into(),
      algorithm: Default::default(),
      digits: 6,
      period: 30,
      issuer: issuer.map(str::to_string),
      account: None,
    }
  }

  fn saved(origin: &str, username: &str, password: &str) -> Saved {
    Saved {
      origin: origin.into(),
      username: username.into(),
      password: password.into(),
    }
  }

  #[test]
  fn sites_match_by_their_registered_part() {
    assert_eq!(base_of("shop.example.com"), "example.com");
    assert_eq!(base_of("a.example.co.uk"), "example.co.uk");
    assert_eq!(base_of("example.com"), "example.com");
    assert!(same_site("accounts.example.com", "example.com"));
    assert!(!same_site("example.org", "example.com"));
    assert!(!same_site("evil-example.com", "example.com"));
    assert_eq!(
      host_of("https://www.GitHub.com/login").as_deref(),
      Some("github.com")
    );
    assert_eq!(host_of("android://abc@com.example/"), None);
  }

  #[test]
  fn a_task_gets_the_site_s_accounts_and_its_2fa_key() {
    let rows = vec![
      saved("https://github.com/session", "alice", "pw1"),
      saved("https://github.com/login", "alice", "pw1-old"),
      saved("https://gist.github.com/", "bob", "pw2"),
      saved("https://gitlab.com/", "carol", "pw3"),
      saved("https://github.com/", "", ""),
    ];
    let keys = vec![
      ("GitLab".to_string(), key(None)),
      ("Work".to_string(), key(Some("GitHub"))),
    ];
    let logins = select(rows, &keys, "github.com");
    let users: Vec<_> = logins.iter().map(|l| l.username.as_deref()).collect();
    assert_eq!(users, vec![Some("alice"), Some("bob")]);
    assert_eq!(logins[0].password.as_deref(), Some("pw1"));
    assert!(logins[0].totp.is_some(), "the key named for the site");
    assert!(logins[1].totp.is_none());
    let wire = serde_json::to_value(&logins[0]).unwrap();
    assert_eq!(wire["totp"]["algorithm"], "SHA1");
    assert!(serde_json::to_value(&logins[1])
      .unwrap()
      .get("totp")
      .is_none());
  }

  #[test]
  fn a_2fa_key_alone_still_goes_and_nothing_goes_for_another_site() {
    let keys = vec![("Shop".to_string(), key(None))];
    let logins = select(Vec::new(), &keys, "shop.example");
    assert_eq!(logins.len(), 1);
    assert_eq!(logins[0].origin, "https://shop.example");
    assert!(logins[0].username.is_none() && logins[0].totp.is_some());
    assert!(select(Vec::new(), &keys, "mail.example").is_empty());
    let many: Vec<Saved> = (0..9)
      .map(|i| saved("https://a.example/", &format!("u{i}"), "p"))
      .collect();
    assert_eq!(select(many, &[], "a.example").len(), MAX_LOGINS);
  }

  #[test]
  fn saved_passwords_are_read_with_the_profile_s_own_key() {
    let dir = tempfile::tempdir().unwrap();
    let target = TargetKey::ensure(dir.path()).unwrap();
    let default = dir.path().join("Default");
    std::fs::create_dir_all(&default).unwrap();
    let conn = Connection::open(default.join("Login Data")).unwrap();
    conn
      .execute_batch(
        "CREATE TABLE logins(origin_url VARCHAR NOT NULL, username_value VARCHAR, password_value BLOB, date_last_used INTEGER NOT NULL DEFAULT 0);",
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO logins VALUES (?1, ?2, ?3, 2)",
        rusqlite::params![
          "https://shop.example/login",
          "alice",
          target.encrypt(b"s3cret").unwrap()
        ],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO logins VALUES (?1, ?2, ?3, 1)",
        rusqlite::params!["https://shop.example/", "plain", b"open".to_vec()],
      )
      .unwrap();
    drop(conn);
    let rows = saved_logins(dir.path());
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].username, "alice");
    assert_eq!(rows[0].password, "s3cret");
    assert_eq!(rows[1].password, "open");
    assert!(saved_logins(&dir.path().join("missing")).is_empty());
  }
}
