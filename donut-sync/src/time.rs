//! Dates in the forms the API has always used: JavaScript's
//! `Date.prototype.toISOString`, S3's timestamps, and SigV4's stamps.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

/// Days since 1970-01-01 to a civil date (proleptic Gregorian).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A civil date to days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
  let y = if m <= 2 { y - 1 } else { y };
  let era = y.div_euclid(400);
  let yoe = y.rem_euclid(400);
  let m = i64::from(m);
  let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  era * 146_097 + doe - 719_468
}

struct Parts {
  year: i64,
  month: u32,
  day: u32,
  hour: i64,
  minute: i64,
  second: i64,
  millis: i64,
}

fn parts(ms: i64) -> Parts {
  let days = ms.div_euclid(86_400_000);
  let rest = ms.rem_euclid(86_400_000);
  let (year, month, day) = civil_from_days(days);
  Parts {
    year,
    month,
    day,
    hour: rest / 3_600_000,
    minute: rest / 60_000 % 60,
    second: rest / 1000 % 60,
    millis: rest % 1000,
  }
}

/// `2026-10-25T09:02:11.155Z`, as `Date.prototype.toISOString` writes it.
pub fn iso_from_ms(ms: i64) -> String {
  let p = parts(ms);
  let year = if (0..=9999).contains(&p.year) {
    format!("{:04}", p.year)
  } else if p.year < 0 {
    format!("-{:06}", -p.year)
  } else {
    format!("+{:06}", p.year)
  };
  format!(
    "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
    p.month, p.day, p.hour, p.minute, p.second, p.millis
  )
}

/// `20261025T090211Z`: SigV4's `X-Amz-Date`, and the time part of a restore
/// point's id.
pub fn compact_stamp(ms: i64) -> String {
  let p = parts(ms);
  format!(
    "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
    p.year, p.month, p.day, p.hour, p.minute, p.second
  )
}

fn digits(s: &str) -> Option<i64> {
  if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  s.parse().ok()
}

/// An S3 XML timestamp (RFC 3339 with an offset). Fractions round to the
/// millisecond, as the AWS SDK for JavaScript did.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
  let b = s.as_bytes();
  if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') {
    return None;
  }
  if b[13] != b':' || b[16] != b':' {
    return None;
  }
  let year = digits(&s[0..4])?;
  let month = digits(&s[5..7])? as u32;
  let day = digits(&s[8..10])? as u32;
  let hour = digits(&s[11..13])?;
  let minute = digits(&s[14..16])?;
  let second = digits(&s[17..19])?;
  let mut rest = &s[19..];
  let mut millis = 0i64;
  if let Some(fraction) = rest.strip_prefix('.') {
    let end = fraction
      .find(|c: char| !c.is_ascii_digit())
      .unwrap_or(fraction.len());
    if end == 0 {
      return None;
    }
    let value: f64 = format!("0.{}", &fraction[..end]).parse().ok()?;
    millis = (value * 1000.0).round() as i64;
    rest = &fraction[end..];
  }
  let offset_minutes = match rest {
    "Z" | "z" => 0,
    _ => {
      let sign = match rest.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
      };
      if rest.len() != 6 || rest.as_bytes()[3] != b':' {
        return None;
      }
      sign * (digits(&rest[1..3])? * 60 + digits(&rest[4..6])?)
    }
  };
  if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
    return None;
  }
  if second > 60 {
    return None;
  }
  let days = days_from_civil(year, month, day);
  let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
  Some(seconds * 1000 + millis)
}

/// An HTTP `Last-Modified` date.
pub fn parse_http_date_ms(s: &str) -> Option<i64> {
  let time = httpdate::parse_http_date(s.trim()).ok()?;
  time
    .duration_since(UNIX_EPOCH)
    .ok()
    .map(|d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn iso_matches_javascript() {
    assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_from_ms(1_792_918_931_155), "2026-10-25T09:02:11.155Z");
    assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
  }

  #[test]
  fn stamps_drop_separators_and_millis() {
    assert_eq!(compact_stamp(1_792_918_931_155), "20261025T090211Z");
  }

  #[test]
  fn rfc3339_rounds_fractions_and_applies_offsets() {
    let base = parse_rfc3339_ms("2026-10-25T09:02:11Z").unwrap();
    assert_eq!(base, 1_792_918_931_000);
    assert_eq!(
      parse_rfc3339_ms("2026-10-25T09:02:11.155Z"),
      Some(base + 155)
    );
    assert_eq!(
      parse_rfc3339_ms("2026-10-25T09:02:11.1239Z"),
      Some(base + 124)
    );
    assert_eq!(parse_rfc3339_ms("2026-10-25T11:02:11+02:00"), Some(base));
    assert_eq!(parse_rfc3339_ms("2026-10-25 09:02:11Z"), None);
  }

  #[test]
  fn http_dates_parse() {
    assert_eq!(
      parse_http_date_ms("Sun, 25 Oct 2026 09:02:11 GMT"),
      Some(1_792_918_931_000)
    );
  }
}
