//! IP-based geolocation lookup using the MaxMind GeoLite2 database,
//! and locale generation based on country/territory information.

use crate::geoip_downloader::GeoIPDownloader;
use maxminddb::{geoip2, Reader};
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use rand::RngExt;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const TERRITORY_INFO_XML: &str = include_str!("territory_info.xml");

pub use crate::ip_utils::IpError;

#[derive(Debug, thiserror::Error)]
pub enum GeolocationError {
  #[error("GeoIP database not found. Please download it first.")]
  DatabaseNotFound,

  #[error("Failed to open GeoIP database: {0}")]
  DatabaseOpen(String),

  #[error("Invalid IP address: {0}")]
  InvalidIP(String),

  #[error("IP location not found: {0}")]
  LocationNotFound(String),

  #[error("Unknown territory: {0}")]
  UnknownTerritory(String),

  #[error("No language data for territory: {0}")]
  NoLanguageData(String),

  #[error("IO error: {0}")]
  Io(#[from] std::io::Error),

  #[error("IP error: {0}")]
  Ip(#[from] IpError),
}

/// The language part of a locale or language tag: `"en"` from `"en-US"`,
/// `"zh"` from `"zh_Hant"`.
pub fn primary_subtag(tag: &str) -> &str {
  tag.split(['-', '_']).next().unwrap_or(tag)
}

/// Shared selector over the bundled CLDR territory data. Parsing the XML costs
/// real time, and the data is immutable, so build it once.
pub fn locale_selector() -> Option<&'static LocaleSelector> {
  static SELECTOR: OnceLock<Option<LocaleSelector>> = OnceLock::new();
  SELECTOR
    .get_or_init(|| match LocaleSelector::new() {
      Ok(s) => Some(s),
      Err(e) => {
        log::warn!("CLDR locale selector build failed err=\"{e}\"");
        None
      }
    })
    .as_ref()
}

#[derive(Debug, Clone)]
pub struct Locale {
  pub language: String,
  pub region: Option<String>,
}

impl Locale {
  pub fn as_string(&self) -> String {
    if let Some(region) = &self.region {
      format!("{}-{}", self.language, region)
    } else {
      self.language.clone()
    }
  }
}

#[derive(Debug, Clone)]
pub struct Geolocation {
  pub locale: Locale,
  pub longitude: f64,
  pub latitude: f64,
  pub timezone: String,
}

struct LanguagePopulation {
  language: String,
  population_percent: f64,
}

pub struct LocaleSelector {
  territories: HashMap<String, Vec<LanguagePopulation>>,
}

impl LocaleSelector {
  pub fn new() -> Result<Self, GeolocationError> {
    let mut territories: HashMap<String, Vec<LanguagePopulation>> = HashMap::new();

    let mut reader = XmlReader::from_str(TERRITORY_INFO_XML);
    reader.config_mut().trim_text(true);

    let mut current_territory: Option<String> = None;
    let mut current_languages: Vec<LanguagePopulation> = Vec::new();

    let mut buf = Vec::new();

    loop {
      match reader.read_event_into(&mut buf) {
        Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
          let name = e.name();
          let name_str = name.as_ref();

          if name_str == "territory" {
            if let Some(code) = current_territory.take() {
              if !current_languages.is_empty() {
                territories.insert(code, std::mem::take(&mut current_languages));
              }
            }

            for attr in e.attributes().flatten() {
              if attr.key.as_ref() == "type" {
                current_territory = Some(attr.value.to_uppercase());
              }
            }
          } else if name_str == "languagePopulation" && current_territory.is_some() {
            let mut lang_type = None;
            let mut pop_percent = 0.0;

            for attr in e.attributes().flatten() {
              match attr.key.as_ref() {
                "type" => {
                  lang_type = Some(attr.value.to_string());
                }
                "populationPercent" => {
                  pop_percent = attr.value.parse().unwrap_or(0.0);
                }
                _ => {}
              }
            }

            if let Some(lang) = lang_type {
              current_languages.push(LanguagePopulation {
                language: lang.replace('_', "-"),
                population_percent: pop_percent,
              });
            }
          }
        }
        Ok(Event::End(ref e)) => {
          let name_ref = e.name();
          let name = name_ref.as_ref();
          if name == "territory" {
            if let Some(code) = current_territory.take() {
              if !current_languages.is_empty() {
                territories.insert(code, std::mem::take(&mut current_languages));
              }
            }
          }
        }
        Ok(Event::Eof) => break,
        Err(e) => {
          log::warn!("Territory XML parse failed err=\"{e}\"");
          break;
        }
        _ => {}
      }
      buf.clear();
    }

    Ok(Self { territories })
  }

  /// Whether CLDR associates `language` with `region` at all.
  ///
  /// Returns `None` for a territory with no language data, so callers can skip
  /// rather than guess. The test is deliberately "is this language listed for
  /// this country", not "is this the country's main language": `from_region`
  /// samples the whole listed distribution weighted by speaker share, so every
  /// listed language is one this selector itself can emit. Anything stricter
  /// would flag fingerprints Donut generated on purpose — CLDR puts `es` at
  /// 9.6% in the US and `fr` at 30% in Canada, and those get picked.
  pub fn region_speaks(&self, region: &str, language: &str) -> Option<bool> {
    let languages = self.territories.get(&region.to_uppercase())?;
    if languages.is_empty() {
      return None;
    }
    let primary = primary_subtag(language);
    Some(
      languages
        .iter()
        .any(|l| primary_subtag(&l.language).eq_ignore_ascii_case(primary)),
    )
  }

  #[allow(clippy::wrong_self_convention)]
  pub fn from_region(&self, region: &str) -> Result<Locale, GeolocationError> {
    let region_upper = region.to_uppercase();

    let languages = self
      .territories
      .get(&region_upper)
      .ok_or_else(|| GeolocationError::UnknownTerritory(region.to_string()))?;

    if languages.is_empty() {
      return Err(GeolocationError::NoLanguageData(region.to_string()));
    }

    let total: f64 = languages.iter().map(|l| l.population_percent).sum();
    let mut rng = rand::rng();
    let target = rng.random::<f64>() * total;
    let mut cumulative = 0.0;

    for lang in languages {
      cumulative += lang.population_percent;
      if cumulative >= target {
        return Ok(normalize_locale(&format!(
          "{}-{}",
          lang.language, region_upper
        )));
      }
    }

    let first_lang = &languages[0].language;
    Ok(normalize_locale(&format!(
      "{}-{}",
      first_lang, region_upper
    )))
  }
}

impl Default for LocaleSelector {
  fn default() -> Self {
    Self::new().unwrap_or(Self {
      territories: HashMap::new(),
    })
  }
}

fn normalize_locale(locale: &str) -> Locale {
  let parts: Vec<&str> = locale.split('-').collect();

  let language = parts
    .first()
    .map(|s| s.to_lowercase())
    .unwrap_or_else(|| "en".to_string());

  let mut region = None;

  for part in parts.iter().skip(1) {
    if part.len() == 4 && part.chars().all(|c| c.is_ascii_alphabetic()) {
      // Script subtag (e.g. Hans/Hant) — ignored; Wayfern fingerprint uses language+region only.
      continue;
    }
    region = Some(part.to_uppercase());
  }

  Locale { language, region }
}

type Database = Arc<Reader<Vec<u8>>>;

struct OpenDatabase {
  stamp: crate::file_stamp::FileStamp,
  reader: Database,
  last_used: Instant,
}

/// Open databases by path. The City file is about 50 MB and one proxy check
/// reads it several times, so it is read once and kept while lookups come.
static DATABASES: Mutex<Option<HashMap<PathBuf, OpenDatabase>>> = Mutex::new(None);

/// A database nobody looked anything up in for this long is let go.
const DATABASE_IDLE: Duration = Duration::from_secs(600);

/// The reader for the database at `path`, read again when the file changed
/// (a download replaced it). `Ok(None)` when there is no file.
fn open_database(path: &Path) -> Result<Option<Database>, maxminddb::MaxMindDbError> {
  let Some(stamp) = crate::file_stamp::FileStamp::read(path) else {
    if let Ok(mut databases) = DATABASES.lock() {
      if let Some(open) = databases.as_mut() {
        open.remove(path);
      }
    }
    return Ok(None);
  };
  if let Ok(mut databases) = DATABASES.lock() {
    if let Some(open) = databases
      .as_mut()
      .and_then(|open| open.get_mut(path))
      .filter(|open| open.stamp == stamp)
    {
      open.last_used = Instant::now();
      return Ok(Some(open.reader.clone()));
    }
  }

  let reader = Arc::new(Reader::open_readfile(path)?);
  let start_reaper = match DATABASES.lock() {
    Ok(mut databases) => {
      let open = databases.get_or_insert_with(HashMap::new);
      let start = open.is_empty();
      open.insert(
        path.to_path_buf(),
        OpenDatabase {
          stamp,
          reader: reader.clone(),
          last_used: Instant::now(),
        },
      );
      start
    }
    Err(_) => false,
  };
  if start_reaper {
    let _ = std::thread::Builder::new()
      .name("geoip-idle".into())
      .spawn(release_idle_databases);
  }
  Ok(Some(reader))
}

/// Drops databases left idle, and stops once none is open.
fn release_idle_databases() {
  loop {
    std::thread::sleep(DATABASE_IDLE / 10);
    let Ok(mut databases) = DATABASES.lock() else {
      return;
    };
    let Some(open) = databases.as_mut() else {
      return;
    };
    open.retain(|_, database| database.last_used.elapsed() < DATABASE_IDLE);
    if open.is_empty() {
      return;
    }
  }
}

/// What the bundled MaxMind data says about an exit address, beyond the
/// city and country a check already reports.
///
/// Everything here is read from the databases already on disk. A proxy check
/// must not hand the exit address to a third-party lookup service: that would
/// tell an outside party which addresses this machine is testing, which is the
/// opposite of what the proxy is for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExitInsight {
  pub timezone: Option<String>,
  /// The ISP, the registered organisation, or the autonomous system's
  /// organisation, whichever the installed databases carry. `None` means "not
  /// known", never "none".
  pub organization: Option<String>,
}

/// Read timezone and organisation for `ip` out of the local databases.
///
/// Never fails: a missing database, an unroutable address or a record without
/// the field all resolve to `None`, because "unknown" is the honest answer and
/// a check should still report everything else it learned.
pub fn lookup_exit_insight(ip: &str) -> ExitInsight {
  let Ok(ip_addr) = IpAddr::from_str(ip) else {
    return ExitInsight::default();
  };

  let mut insight = ExitInsight::default();

  if let Ok(path) = GeoIPDownloader::get_mmdb_file_path() {
    if let Ok(Some(reader)) = open_database(&path) {
      if let Ok(lookup) = reader.lookup(ip_addr) {
        if let Ok(Some(city)) = lookup.decode::<geoip2::City>() {
          insight.timezone = city.location.time_zone.map(|tz| tz.to_string());
        }
      }
      // The City database carries no organisation, but the same reader decodes
      // one when the file in place is an ISP or Enterprise database instead.
      if let Ok(lookup) = reader.lookup(ip_addr) {
        if let Ok(Some(isp)) = lookup.decode::<geoip2::Isp>() {
          insight.organization = first_non_empty([
            isp.isp,
            isp.organization,
            isp.autonomous_system_organization,
          ]);
        }
      }
    }
  }

  if insight.organization.is_none() {
    insight.organization = lookup_asn_organization(ip_addr);
  }

  insight
}

/// City, country and country code for `ip`, read from the local City
/// database. Proxy checks used to ask ip-api.com over plain HTTP, which showed
/// that service and everyone on the path which exit address this machine was
/// testing. `None` wherever the database has no answer.
pub fn lookup_place(ip: &str) -> (Option<String>, Option<String>, Option<String>) {
  let Ok(ip_addr) = IpAddr::from_str(ip) else {
    return (None, None, None);
  };
  let Some(reader) = GeoIPDownloader::get_mmdb_file_path()
    .ok()
    .and_then(|path| open_database(&path).ok().flatten())
  else {
    return (None, None, None);
  };
  let Ok(Some(city)) = reader
    .lookup(ip_addr)
    .and_then(|lookup| lookup.decode::<geoip2::City>())
  else {
    return (None, None, None);
  };
  (
    first_non_empty([city.city.names.english]),
    first_non_empty([city.country.names.english]),
    first_non_empty([city.country.iso_code]).map(|code| code.to_uppercase()),
  )
}

/// The autonomous system's organisation, from the ASN database that ships
/// alongside the city one. Absent on an install that has only ever fetched the
/// city database, which is why the caller treats `None` as "unknown".
fn lookup_asn_organization(ip_addr: IpAddr) -> Option<String> {
  let path = GeoIPDownloader::get_asn_mmdb_file_path().ok()?;
  let reader = open_database(&path).ok()??;
  let asn: geoip2::Asn = reader.lookup(ip_addr).ok()?.decode().ok()??;
  first_non_empty([asn.autonomous_system_organization])
}

fn first_non_empty<const N: usize>(candidates: [Option<&str>; N]) -> Option<String> {
  candidates
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(|value| value.to_string())
}

pub fn get_geolocation(ip: &str) -> Result<Geolocation, GeolocationError> {
  let mmdb_path =
    GeoIPDownloader::get_mmdb_file_path().map_err(|_| GeolocationError::DatabaseNotFound)?;

  let reader = open_database(&mmdb_path)
    .map_err(|e| GeolocationError::DatabaseOpen(e.to_string()))?
    .ok_or(GeolocationError::DatabaseNotFound)?;

  let ip_addr: IpAddr =
    IpAddr::from_str(ip).map_err(|_| GeolocationError::InvalidIP(ip.to_string()))?;

  let lookup_result = reader
    .lookup(ip_addr)
    .map_err(|e| GeolocationError::LocationNotFound(e.to_string()))?;
  let city: geoip2::City = lookup_result
    .decode()
    .map_err(|e| GeolocationError::LocationNotFound(e.to_string()))?
    .ok_or_else(|| GeolocationError::LocationNotFound(ip.to_string()))?;

  let location = &city.location;

  let longitude = location
    .longitude
    .ok_or_else(|| GeolocationError::LocationNotFound("No longitude".to_string()))?;
  let latitude = location
    .latitude
    .ok_or_else(|| GeolocationError::LocationNotFound("No latitude".to_string()))?;
  let timezone = location
    .time_zone
    .ok_or_else(|| GeolocationError::LocationNotFound("No timezone".to_string()))?
    .to_string();

  let country = &city.country;
  let iso_code = country
    .iso_code
    .ok_or_else(|| GeolocationError::LocationNotFound("No country code".to_string()))?
    .to_uppercase();

  // The CLDR data is parsed once for the process, not on every lookup.
  let selector = locale_selector().ok_or_else(|| {
    GeolocationError::LocationNotFound("CLDR locale data is unavailable".to_string())
  })?;
  let locale = selector.from_region(&iso_code)?;

  Ok(Geolocation {
    locale,
    longitude,
    latitude,
    timezone,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_invalid_address_has_no_place() {
    assert_eq!(lookup_place("not-an-ip"), (None, None, None));
  }

  /// The smallest MaxMind DB a reader opens: one IPv4 node with no data.
  fn tiny_database(build_epoch: u8) -> Vec<u8> {
    let mut db = vec![0, 0, 1, 0, 0, 1];
    db.extend_from_slice(&[0; 16]);
    db.extend_from_slice(b"\xAB\xCD\xEFMaxMind.com");
    let key = |db: &mut Vec<u8>, name: &str| {
      db.push(0x40 | name.len() as u8);
      db.extend_from_slice(name.as_bytes());
    };
    db.push(0xE9);
    key(&mut db, "binary_format_major_version");
    db.extend_from_slice(&[0xA1, 2]);
    key(&mut db, "binary_format_minor_version");
    db.push(0xA0);
    key(&mut db, "build_epoch");
    db.extend_from_slice(&[0x01, 0x02, build_epoch]);
    key(&mut db, "database_type");
    key(&mut db, "Test");
    key(&mut db, "description");
    db.push(0xE0);
    key(&mut db, "ip_version");
    db.extend_from_slice(&[0xA1, 4]);
    key(&mut db, "languages");
    db.extend_from_slice(&[0x00, 0x04]);
    key(&mut db, "node_count");
    db.extend_from_slice(&[0xC1, 1]);
    key(&mut db, "record_size");
    db.extend_from_slice(&[0xA1, 24]);
    db
  }

  #[test]
  fn a_database_is_read_once_and_again_after_it_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("GeoLite2-City.mmdb");
    assert!(open_database(&path).unwrap().is_none());

    std::fs::write(&path, tiny_database(1)).unwrap();
    // A stamp taken in the first seconds after a write never matches.
    std::fs::File::options()
      .write(true)
      .open(&path)
      .unwrap()
      .set_modified(std::time::SystemTime::now() - Duration::from_secs(10))
      .unwrap();
    let first = open_database(&path).unwrap().unwrap();
    let again = open_database(&path).unwrap().unwrap();
    assert!(Arc::ptr_eq(&first, &again));

    // A download replaces the file.
    std::thread::sleep(Duration::from_millis(50));
    let staging = dir.path().join("download.tmp");
    std::fs::write(&staging, tiny_database(2)).unwrap();
    std::fs::rename(&staging, &path).unwrap();
    let replaced = open_database(&path).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&first, &replaced));
    assert_eq!(replaced.metadata().build_epoch, 2);

    std::fs::remove_file(&path).unwrap();
    assert!(open_database(&path).unwrap().is_none());
    let held = DATABASES.lock().unwrap();
    assert!(!held.as_ref().is_some_and(|open| open.contains_key(&path)));
  }

  /// Exit addresses stay on this machine. A lookup service would learn which
  /// proxies the user tests, and plain HTTP would tell everyone on the path.
  #[test]
  fn proxy_checks_do_not_send_the_exit_address_to_a_lookup_service() {
    for (name, source) in [
      ("proxy_manager.rs", include_str!("proxy_manager.rs")),
      ("lib.rs", include_str!("lib.rs")),
    ] {
      assert!(
        !source.contains("ip-api.com"),
        "{name} sends the exit address to ip-api.com; use geolocation::lookup_place"
      );
    }
  }

  #[test]
  fn test_locale_selector_creation() {
    let selector = LocaleSelector::new();
    assert!(selector.is_ok());
  }

  #[test]
  fn test_locale_from_region() {
    let selector = LocaleSelector::new().unwrap();

    let us_locale = selector.from_region("US");
    assert!(us_locale.is_ok());
    let us = us_locale.unwrap();
    assert_eq!(us.region, Some("US".to_string()));

    let de_locale = selector.from_region("DE");
    assert!(de_locale.is_ok());
    let de = de_locale.unwrap();
    assert_eq!(de.region, Some("DE".to_string()));
  }

  #[test]
  fn test_locale_as_string() {
    let locale = Locale {
      language: "en".to_string(),
      region: Some("US".to_string()),
    };
    assert_eq!(locale.as_string(), "en-US");

    let locale_no_region = Locale {
      language: "en".to_string(),
      region: None,
    };
    assert_eq!(locale_no_region.as_string(), "en");
  }

  #[test]
  fn test_normalize_locale() {
    let locale = normalize_locale("en-US");
    assert_eq!(locale.language, "en");
    assert_eq!(locale.region, Some("US".to_string()));

    let zh_tw = normalize_locale("zh-TW");
    assert_eq!(zh_tw.language, "zh");
    assert_eq!(zh_tw.region, Some("TW".to_string()));

    let zh_hant_us = normalize_locale("zh-Hant-US");
    assert_eq!(zh_hant_us.language, "zh");
    assert_eq!(zh_hant_us.region, Some("US".to_string()));
  }
}
