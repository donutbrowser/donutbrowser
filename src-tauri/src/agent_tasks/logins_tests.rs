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
