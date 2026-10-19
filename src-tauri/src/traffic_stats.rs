use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

/// Individual bandwidth data point for time-series tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandwidthDataPoint {
  /// Unix timestamp in seconds
  pub timestamp: u64,
  /// Bytes sent in this interval
  pub bytes_sent: u64,
  /// Bytes received in this interval
  pub bytes_received: u64,
}

/// Individual domain access data point for time-series tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainAccessPoint {
  /// Unix timestamp in seconds
  pub timestamp: u64,
  /// Domain name
  pub domain: String,
  /// Bytes sent in this request
  pub bytes_sent: u64,
  /// Bytes received in this request
  pub bytes_received: u64,
  /// Requests this row stands for. Files from before the field count each
  /// row as one request.
  #[serde(default = "one_request", skip_serializing_if = "is_one_request")]
  pub requests: u64,
}

fn one_request() -> u64 {
  1
}

fn is_one_request(requests: &u64) -> bool {
  *requests == 1
}

/// Domain access information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainAccess {
  /// Domain name
  pub domain: String,
  /// Number of requests to this domain
  pub request_count: u64,
  /// Total bytes sent to this domain
  pub bytes_sent: u64,
  /// Total bytes received from this domain
  pub bytes_received: u64,
  /// First access timestamp
  pub first_access: u64,
  /// Last access timestamp
  pub last_access: u64,
}

/// Lightweight snapshot for real-time updates (sent via events)
/// Contains only the data needed for the mini chart and summary display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficSnapshot {
  /// Profile ID (for matching)
  pub profile_id: Option<String>,
  /// Session start timestamp
  pub session_start: u64,
  /// Last update timestamp
  pub last_update: u64,
  /// Total bytes sent across all time
  pub total_bytes_sent: u64,
  /// Total bytes received across all time
  pub total_bytes_received: u64,
  /// Total requests made
  pub total_requests: u64,
  /// Current bandwidth (bytes per second) sent
  pub current_bytes_sent: u64,
  /// Current bandwidth (bytes per second) received
  pub current_bytes_received: u64,
  /// Recent bandwidth history (last 60 seconds only, for mini chart)
  pub recent_bandwidth: Vec<BandwidthDataPoint>,
  /// Dials to the upstream proxy that failed this session (refused,
  /// unreachable, rejected credentials or payment).
  #[serde(default)]
  pub upstream_failures: u64,
  /// Dials to the upstream proxy that timed out this session.
  #[serde(default)]
  pub upstream_timeouts: u64,
}

/// How the worker's dial to its upstream proxy ended. A refusal about the
/// destination still counts as reached: the proxy answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamOutcome {
  Reached,
  ConnectFailed,
  TimedOut,
  AuthRefused,
  PaymentRequired,
}

/// Upstream dial outcomes of one worker session, cumulative. The worker
/// writes them into its session snapshot; the app reads them for route health.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamCounts {
  #[serde(default)]
  pub reached: u64,
  #[serde(default)]
  pub failed: u64,
  #[serde(default)]
  pub timed_out: u64,
  #[serde(default)]
  pub auth_refused: u64,
  #[serde(default)]
  pub payment_required: u64,
}

impl UpstreamCounts {
  fn failures(&self) -> u64 {
    self.refused() + self.timed_out
  }

  /// Failures other than timeouts.
  fn refused(&self) -> u64 {
    self.failed + self.auth_refused + self.payment_required
  }

  /// `self - earlier`, or `self` when the counters went back, which means a
  /// new worker started for the profile.
  fn since(&self, earlier: &UpstreamCounts) -> UpstreamCounts {
    let reset = self.reached < earlier.reached
      || self.failed < earlier.failed
      || self.timed_out < earlier.timed_out
      || self.auth_refused < earlier.auth_refused
      || self.payment_required < earlier.payment_required;
    if reset {
      return *self;
    }
    UpstreamCounts {
      reached: self.reached - earlier.reached,
      failed: self.failed - earlier.failed,
      timed_out: self.timed_out - earlier.timed_out,
      auth_refused: self.auth_refused - earlier.auth_refused,
      payment_required: self.payment_required - earlier.payment_required,
    }
  }

  fn add(&mut self, other: &UpstreamCounts) {
    self.reached += other.reached;
    self.failed += other.failed;
    self.timed_out += other.timed_out;
    self.auth_refused += other.auth_refused;
    self.payment_required += other.payment_required;
  }
}

/// How far back the route health of a running profile looks.
pub const ROUTE_HEALTH_WINDOW_SECS: u64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteHealthStatus {
  Ok,
  Degraded,
  Down,
}

/// What the window says, with the reason code when it is not ok.
pub type RouteHealthVerdict = (RouteHealthStatus, Option<&'static str>);

/// The verdict for the dials of one window, or `None` with no dial at all:
/// an idle profile has given no evidence either way.
fn route_health_verdict(counts: &UpstreamCounts) -> Option<RouteHealthVerdict> {
  let failures = counts.failures();
  let attempts = failures + counts.reached;
  if attempts == 0 {
    return None;
  }
  let code = if counts.payment_required > 0 {
    "PROXY_PAYMENT_REQUIRED"
  } else if counts.auth_refused > 0 {
    "PROXY_AUTH_FAILED"
  } else if counts.timed_out > counts.failed {
    "PROXY_UPSTREAM_TIMEOUT"
  } else {
    "PROXY_UPSTREAM_UNREACHABLE"
  };
  if failures >= 3 && counts.reached == 0 {
    Some((RouteHealthStatus::Down, Some(code)))
  } else if failures >= 2 && failures * 5 >= attempts {
    Some((RouteHealthStatus::Degraded, Some(code)))
  } else {
    Some((RouteHealthStatus::Ok, None))
  }
}

/// The route health of one running profile over a sliding window, fed with
/// the worker's cumulative counters.
#[derive(Debug, Default)]
pub struct RouteHealthWindow {
  last: Option<UpstreamCounts>,
  samples: std::collections::VecDeque<(u64, UpstreamCounts)>,
  current: Option<RouteHealthVerdict>,
}

impl RouteHealthWindow {
  /// Take the counters read at `now`; returns the verdict when it changed.
  /// The first reading is the baseline: dials before it belong to a past
  /// window.
  pub fn observe(&mut self, now: u64, counts: UpstreamCounts) -> Option<RouteHealthVerdict> {
    let delta = match &self.last {
      Some(last) => counts.since(last),
      None => UpstreamCounts::default(),
    };
    self.last = Some(counts);
    if delta.failures() + delta.reached > 0 {
      self.samples.push_back((now, delta));
    }
    let cutoff = now.saturating_sub(ROUTE_HEALTH_WINDOW_SECS);
    while self.samples.front().is_some_and(|(at, _)| *at <= cutoff) {
      self.samples.pop_front();
    }
    let mut window = UpstreamCounts::default();
    for (_, sample) in &self.samples {
      window.add(sample);
    }
    let verdict = route_health_verdict(&window)?;
    if self.current == Some(verdict) {
      return None;
    }
    self.current = Some(verdict);
    Some(verdict)
  }

  pub fn current(&self) -> Option<RouteHealthVerdict> {
    self.current
  }
}

/// Traffic statistics for a profile/proxy session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficStats {
  /// Proxy ID this stats belong to (for backwards compatibility)
  pub proxy_id: String,
  /// Profile ID (if associated) - this is now the primary key for storage
  pub profile_id: Option<String>,
  /// Session start timestamp
  pub session_start: u64,
  /// Last update timestamp
  pub last_update: u64,
  /// Timestamp of the last flush to disk (used to avoid double-counting session snapshots)
  #[serde(default)]
  pub last_flush_timestamp: u64,
  /// Total bytes sent across all time
  pub total_bytes_sent: u64,
  /// Total bytes received across all time
  pub total_bytes_received: u64,
  /// Total requests made
  pub total_requests: u64,
  /// Bandwidth data points, oldest first: every point of the last hour,
  /// one per minute before that, for 7 days.
  #[serde(default)]
  pub bandwidth_history: Vec<BandwidthDataPoint>,
  /// Domain access statistics (aggregated all-time)
  #[serde(default)]
  pub domains: HashMap<String, DomainAccess>,
  /// Domain access history, oldest first: one row per domain and write for
  /// the last hour, one per domain and hour before that, for 7 days.
  #[serde(default)]
  pub domain_access_history: Vec<DomainAccessPoint>,
  /// Unique IPs accessed
  #[serde(default)]
  pub unique_ips: Vec<String>,
}

/// History younger than this keeps every point. Older bandwidth is kept per
/// minute, older site rows per domain and hour.
const FULL_RESOLUTION_SECS: u64 = 60 * 60;

/// How long the history is kept.
const RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

/// How far `compact_history` has got on one history: everything before these
/// timestamps is compacted already.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Compacted {
  bandwidth_before: u64,
  domains_before: u64,
}

/// Requests and bytes of one domain that are not in the stats file yet.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct DomainDelta {
  requests: u64,
  bytes_sent: u64,
  bytes_received: u64,
  first: u64,
  last: u64,
}

impl TrafficStats {
  pub fn new(proxy_id: String, profile_id: Option<String>) -> Self {
    let now = current_timestamp();
    Self {
      proxy_id,
      profile_id,
      session_start: now,
      last_update: now,
      last_flush_timestamp: 0,
      total_bytes_sent: 0,
      total_bytes_received: 0,
      total_requests: 0,
      bandwidth_history: Vec::new(),
      domains: HashMap::new(),
      domain_access_history: Vec::new(),
      unique_ips: Vec::new(),
    }
  }

  /// Create a lightweight snapshot for real-time UI updates
  pub fn to_snapshot(&self) -> TrafficSnapshot {
    let now = current_timestamp();
    StatsSummary::of(self, now).snapshot(now)
  }

  /// Record bandwidth for current second (data is stored indefinitely)
  pub fn record_bandwidth(&mut self, bytes_sent: u64, bytes_received: u64) {
    let now = current_timestamp();
    self.last_update = now;
    self.total_bytes_sent += bytes_sent;
    self.total_bytes_received += bytes_received;
    self.push_bandwidth(BandwidthDataPoint {
      timestamp: now,
      bytes_sent,
      bytes_received,
    });
  }

  /// Append a point, adding it to the last one when it is not later (the
  /// same second, or a clock that went back), so the history stays sorted.
  fn push_bandwidth(&mut self, point: BandwidthDataPoint) {
    match self.bandwidth_history.last_mut() {
      Some(last) if last.timestamp >= point.timestamp => {
        last.bytes_sent += point.bytes_sent;
        last.bytes_received += point.bytes_received;
      }
      _ => self.bandwidth_history.push(point),
    }
  }

  /// Prune old data to prevent unbounded growth
  /// Keeps only the last 7 days of bandwidth history and domain access history
  pub fn prune_old_data(&mut self) {
    self.prune_old_data_at(current_timestamp());
  }

  fn prune_old_data_at(&mut self, now: u64) {
    let cutoff = now.saturating_sub(RETENTION_SECS);
    self.bandwidth_history.retain(|dp| dp.timestamp >= cutoff);
    self
      .domain_access_history
      .retain(|dp| dp.timestamp >= cutoff);

    // Keep domains that were accessed recently OR have high total traffic
    let recent_domains: HashSet<&str> = self
      .domain_access_history
      .iter()
      .map(|dp| dp.domain.as_str())
      .collect();
    self.domains.retain(|domain, access| {
      recent_domains.contains(domain.as_str())
        || access.last_access >= cutoff
        || (access.bytes_sent + access.bytes_received) > 1_000_000 // Keep domains with >1MB traffic
    });
  }

  /// Order both histories by time. Files merged by older versions, or written
  /// across a clock change, may be out of order.
  fn sort_history(&mut self) {
    self.bandwidth_history.sort_by_key(|p| p.timestamp);
    self.domain_access_history.sort_by_key(|p| p.timestamp);
  }

  /// Downsample history older than an hour: bandwidth to one point per
  /// minute, site rows to one row per domain and hour, with every sum kept.
  /// Only whole minutes and hours are compacted, so a later call never has
  /// to merge into a row compacted earlier. `done` is what an earlier call on
  /// this same history covered; the default compacts everything.
  fn compact_history(&mut self, now: u64, done: Compacted) -> Compacted {
    let horizon = now.saturating_sub(FULL_RESOLUTION_SECS);
    let bandwidth_before = horizon - horizon % 60;
    let domains_before = horizon - horizon % 3600;

    let history = &mut self.bandwidth_history;
    let start = history.partition_point(|p| p.timestamp < done.bandwidth_before);
    let end = history.partition_point(|p| p.timestamp < bandwidth_before);
    if start < end {
      let mut minutes: Vec<BandwidthDataPoint> = Vec::new();
      for point in &history[start..end] {
        let minute = point.timestamp - point.timestamp % 60;
        match minutes.last_mut() {
          Some(last) if last.timestamp == minute => {
            last.bytes_sent += point.bytes_sent;
            last.bytes_received += point.bytes_received;
          }
          _ => minutes.push(BandwidthDataPoint {
            timestamp: minute,
            ..point.clone()
          }),
        }
      }
      history.splice(start..end, minutes);
    }

    let history = &mut self.domain_access_history;
    let start = history.partition_point(|p| p.timestamp < done.domains_before);
    let end = history.partition_point(|p| p.timestamp < domains_before);
    if start < end {
      let mut hours: HashMap<(u64, String), DomainDelta> = HashMap::new();
      for row in history.drain(start..end) {
        let delta = hours.entry((row.timestamp / 3600, row.domain)).or_default();
        delta.requests += row.requests;
        delta.bytes_sent += row.bytes_sent;
        delta.bytes_received += row.bytes_received;
        delta.last = delta.last.max(row.timestamp);
      }
      let mut rows: Vec<DomainAccessPoint> = hours
        .into_iter()
        .map(|((_, domain), delta)| DomainAccessPoint {
          timestamp: delta.last,
          domain,
          bytes_sent: delta.bytes_sent,
          bytes_received: delta.bytes_received,
          requests: delta.requests,
        })
        .collect();
      rows.sort_by(|a, b| {
        a.timestamp
          .cmp(&b.timestamp)
          .then_with(|| a.domain.cmp(&b.domain))
      });
      history.splice(start..start, rows);
    }

    Compacted {
      bandwidth_before: bandwidth_before.max(done.bandwidth_before),
      domains_before: domains_before.max(done.domains_before),
    }
  }

  /// Record a request to a domain
  pub fn record_request(&mut self, domain: &str, bytes_sent: u64, bytes_received: u64) {
    let now = current_timestamp();
    self.total_requests += 1;
    self.record_domain(
      domain,
      &DomainDelta {
        requests: 1,
        bytes_sent,
        bytes_received,
        first: now,
        last: now,
      },
    );
  }

  /// Add a domain's requests and bytes to its totals and to the history, as
  /// one row at its last access.
  fn record_domain(&mut self, domain: &str, delta: &DomainDelta) {
    let entry = self
      .domains
      .entry(domain.to_string())
      .or_insert(DomainAccess {
        domain: domain.to_string(),
        request_count: 0,
        bytes_sent: 0,
        bytes_received: 0,
        first_access: delta.first,
        last_access: delta.last,
      });
    entry.request_count += delta.requests;
    entry.bytes_sent += delta.bytes_sent;
    entry.bytes_received += delta.bytes_received;
    entry.first_access = entry.first_access.min(delta.first);
    entry.last_access = entry.last_access.max(delta.last);

    let timestamp = self
      .domain_access_history
      .last()
      .map_or(delta.last, |last| last.timestamp.max(delta.last));
    self.domain_access_history.push(DomainAccessPoint {
      timestamp,
      domain: domain.to_string(),
      bytes_sent: delta.bytes_sent,
      bytes_received: delta.bytes_received,
      requests: delta.requests,
    });
  }

  /// Record an IP address access
  pub fn record_ip(&mut self, ip: &str) {
    if !self.unique_ips.iter().any(|known| known == ip) {
      self.unique_ips.push(ip.to_string());
    }
  }

  /// Get bandwidth data for the last N seconds
  pub fn get_recent_bandwidth(&self, seconds: u64) -> Vec<BandwidthDataPoint> {
    let now = current_timestamp();
    let cutoff = now.saturating_sub(seconds);
    self
      .bandwidth_history
      .iter()
      .filter(|dp| dp.timestamp >= cutoff)
      .cloned()
      .collect()
  }

  /// Add traffic a worker collected since its last write.
  fn apply(&mut self, pending: &Pending, now: u64) {
    self.total_bytes_sent += pending.bytes_sent;
    self.total_bytes_received += pending.bytes_received;
    self.total_requests += pending.requests;
    for point in &pending.bandwidth {
      self.push_bandwidth(point.clone());
    }
    let mut domains: Vec<(&String, &DomainDelta)> = pending.domains.iter().collect();
    domains.sort_by(|a, b| a.1.last.cmp(&b.1.last).then_with(|| a.0.cmp(b.0)));
    for (domain, delta) in domains {
      self.record_domain(domain, delta);
    }
    for ip in &pending.ips {
      self.record_ip(ip);
    }
    self.last_update = now;
    self.last_flush_timestamp = now;
  }
}

/// Get current Unix timestamp in seconds
fn current_timestamp() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

/// File lock guard for preventing concurrent writes
struct FileLockGuard {
  _file: std::fs::File,
}

/// Acquire a file lock for exclusive access
/// On Unix, uses flock; on Windows, uses file handles
fn acquire_file_lock(lock_path: &PathBuf) -> Result<FileLockGuard, Box<dyn std::error::Error>> {
  use std::fs::OpenOptions;

  let file = OpenOptions::new()
    .create(true)
    .write(true)
    .truncate(false)
    .open(lock_path)?;

  #[cfg(unix)]
  {
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    unsafe {
      if libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) != 0 {
        return Err("Failed to acquire file lock".into());
      }
    }
  }

  #[cfg(windows)]
  {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::LockFileEx;
    use windows::Win32::Storage::FileSystem::LOCKFILE_EXCLUSIVE_LOCK;
    use windows::Win32::Storage::FileSystem::LOCKFILE_FAIL_IMMEDIATELY;
    use windows::Win32::System::IO::OVERLAPPED;

    let raw_handle = file.as_raw_handle();
    let handle = HANDLE(raw_handle);
    unsafe {
      let mut overlapped: OVERLAPPED = std::mem::zeroed();
      if LockFileEx(
        handle,
        LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        Some(0),
        u32::MAX,
        u32::MAX,
        &mut overlapped,
      )
      .is_err()
      {
        return Err("Failed to acquire file lock".into());
      }
    }
  }

  Ok(FileLockGuard { _file: file })
}

pub fn get_traffic_stats_dir() -> PathBuf {
  crate::app_dirs::cache_dir().join("traffic_stats")
}

/// What a file in the traffic stats directory is. Names are
/// `{key}.json`, `{key}.session.json`, `{key}.lock` and temp files ending in
/// `.tmp`; a key (a profile or proxy id) has no dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatsFileKind {
  Stats,
  Session,
  Lock,
  Temp,
}

fn classify_stats_file(name: &str) -> Option<(&str, StatsFileKind)> {
  let (key, rest) = name.split_once('.')?;
  let kind = match rest {
    "json" => StatsFileKind::Stats,
    "session.json" => StatsFileKind::Session,
    "lock" => StatsFileKind::Lock,
    _ if rest.ends_with("tmp") => StatsFileKind::Temp,
    _ => return None,
  };
  (!key.is_empty()).then_some((key, kind))
}

/// Size, time and identity of a file, to tell whether it changed since it
/// was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileSig {
  modified: Option<std::time::SystemTime>,
  len: u64,
  #[cfg(unix)]
  inode: u64,
}

impl FileSig {
  fn of(meta: &fs::Metadata) -> Self {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    FileSig {
      modified: meta.modified().ok(),
      len: meta.len(),
      #[cfg(unix)]
      inode: meta.ino(),
    }
  }

  fn of_path(path: &Path) -> Option<Self> {
    fs::metadata(path).ok().map(|meta| Self::of(&meta))
  }
}

/// Get the storage key for traffic stats (profile_id if available, otherwise proxy_id)
fn get_stats_storage_key(stats: &TrafficStats) -> String {
  stats
    .profile_id
    .clone()
    .unwrap_or_else(|| stats.proxy_id.clone())
}

/// Save traffic stats to disk using profile_id as the key
pub fn save_traffic_stats(stats: &TrafficStats) -> Result<(), Box<dyn std::error::Error>> {
  let storage_dir = get_traffic_stats_dir();
  fs::create_dir_all(&storage_dir)?;
  save_traffic_stats_in(&storage_dir, &get_stats_storage_key(stats), stats)
}

/// Write `{key}.json` in `dir` atomically via temp file + rename, so readers
/// never observe a partially-written file.
fn save_traffic_stats_in(
  dir: &Path,
  key: &str,
  stats: &TrafficStats,
) -> Result<(), Box<dyn std::error::Error>> {
  let temp_path = dir.join(format!("{key}.json.tmp"));
  fs::write(&temp_path, serde_json::to_vec(stats)?)?;
  fs::rename(&temp_path, dir.join(format!("{key}.json")))?;
  Ok(())
}

/// Load traffic stats from disk by profile_id or proxy_id
pub fn load_traffic_stats(id: &str) -> Option<TrafficStats> {
  read_stats_file(&get_traffic_stats_dir().join(format!("{id}.json")))
}

fn read_stats_file(path: &Path) -> Option<TrafficStats> {
  let content = fs::read(path).ok()?;
  serde_json::from_slice(&content).ok()
}

/// Load traffic stats by profile_id
pub fn load_traffic_stats_by_profile(profile_id: &str) -> Option<TrafficStats> {
  load_traffic_stats(profile_id)
}

/// Load all traffic stats files keyed by storage key, migrating old
/// proxy-id based files to profile-id based ones. Only writes to disk when a
/// migration or merge actually changed data; the common case is read-only.
fn collect_traffic_stats() -> HashMap<String, TrafficStats> {
  let storage_dir = get_traffic_stats_dir();

  if !storage_dir.exists() {
    return HashMap::new();
  }

  let mut stats_map: HashMap<String, TrafficStats> = HashMap::new();
  let mut dirty_keys: HashSet<String> = HashSet::new();
  let mut files_to_delete: Vec<std::path::PathBuf> = Vec::new();

  if let Ok(entries) = fs::read_dir(&storage_dir) {
    for entry in entries.flatten() {
      let path = entry.path();
      let is_stats_file = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(classify_stats_file)
        .is_some_and(|(_, kind)| kind == StatsFileKind::Stats);
      if !is_stats_file {
        continue;
      }
      let Some(s) = read_stats_file(&path) else {
        continue;
      };
      // Determine the key for this stats entry
      let key = s.profile_id.clone().unwrap_or_else(|| s.proxy_id.clone());

      // Check if this is an old proxy-id based file that should be migrated
      let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
      let is_old_proxy_file = file_stem.starts_with("proxy_")
        && s.profile_id.as_deref().is_some_and(|id| id != file_stem);

      if let Some(existing) = stats_map.get_mut(&key) {
        // Merge stats from this file into existing
        merge_traffic_stats(existing, &s);
        dirty_keys.insert(key);
        if is_old_proxy_file {
          files_to_delete.push(path.clone());
        }
      } else {
        stats_map.insert(key.clone(), s);
        if is_old_proxy_file {
          dirty_keys.insert(key);
          files_to_delete.push(path.clone());
        }
      }
    }
  }

  // Persist only entries actually changed by a merge or migration
  for key in &dirty_keys {
    if let Some(stats) = stats_map.get(key) {
      if let Err(e) = save_traffic_stats(stats) {
        log::warn!("Merged traffic stats save failed err=\"{e}\"");
      }
    }
  }

  for path in files_to_delete {
    if let Err(e) = fs::remove_file(&path) {
      log::warn!(
        "Old traffic stats file delete failed path=\"{}\" err=\"{e}\"",
        path.display()
      );
    }
  }

  stats_map
}

/// List all traffic stats files and migrate old proxy-id based files to profile-id based
pub fn list_traffic_stats() -> Vec<TrafficStats> {
  collect_traffic_stats().into_values().collect()
}

/// Merge traffic stats from source into destination
fn merge_traffic_stats(dest: &mut TrafficStats, src: &TrafficStats) {
  // Update totals
  dest.total_bytes_sent += src.total_bytes_sent;
  dest.total_bytes_received += src.total_bytes_received;
  dest.total_requests += src.total_requests;

  // Update timestamps
  dest.session_start = dest.session_start.min(src.session_start);
  dest.last_update = dest.last_update.max(src.last_update);

  // Merge bandwidth history (keep all data, sorted by timestamp)
  let known: HashSet<u64> = dest.bandwidth_history.iter().map(|p| p.timestamp).collect();
  for point in &src.bandwidth_history {
    if !known.contains(&point.timestamp) {
      dest.bandwidth_history.push(point.clone());
    }
  }
  dest.bandwidth_history.sort_by_key(|p| p.timestamp);

  // Merge domains
  for (domain, access) in &src.domains {
    let entry = dest.domains.entry(domain.clone()).or_insert(DomainAccess {
      domain: domain.clone(),
      request_count: 0,
      bytes_sent: 0,
      bytes_received: 0,
      first_access: access.first_access,
      last_access: access.last_access,
    });
    entry.request_count += access.request_count;
    entry.bytes_sent += access.bytes_sent;
    entry.bytes_received += access.bytes_received;
    entry.first_access = entry.first_access.min(access.first_access);
    entry.last_access = entry.last_access.max(access.last_access);
  }

  // Merge domain access history
  dest
    .domain_access_history
    .extend(src.domain_access_history.iter().cloned());
  dest.domain_access_history.sort_by_key(|p| p.timestamp);

  // Merge unique IPs
  for ip in &src.unique_ips {
    if !dest.unique_ips.contains(ip) {
      dest.unique_ips.push(ip.clone());
    }
  }
}

/// Delete traffic stats by id (profile_id or proxy_id).
///
/// Removes the session snapshot and any temp orphans alongside the main file.
/// The snapshot is what a running worker writes every few seconds, and
/// `get_all_traffic_snapshots_realtime` rebuilds an entry straight from it when
/// no main file exists — so clearing only `{id}.json` resurrects the very
/// totals the user asked to erase, and leaves the snapshot's copy on disk.
pub fn delete_traffic_stats(id: &str) -> bool {
  let storage_dir = get_traffic_stats_dir();
  let mut removed = false;

  for name in [
    format!("{id}.json"),
    format!("{id}.json.tmp"),
    format!("{id}.session.json"),
    format!("{id}.session.json.tmp"),
  ] {
    let path = storage_dir.join(name);
    if path.exists() && secure_remove_file(&path).is_ok() {
      removed = true;
    }
  }
  forget_cached(Some(&storage_dir.join(format!("{id}.json"))));

  removed
}

/// Best-effort secure erase. Shared with the ephemeral-profile teardown, which
/// needs exactly the same "zero then unlink, never let the overwrite gate the
/// unlink" behaviour; see `crate::fs_secure` for the caveats.
use crate::fs_secure::secure_remove_file;

/// Clear all traffic stats (used when clearing cache), securely erasing each
/// file first.
pub fn clear_all_traffic_stats() -> Result<(), Box<dyn std::error::Error>> {
  let storage_dir = get_traffic_stats_dir();

  if storage_dir.exists() {
    for entry in fs::read_dir(&storage_dir)?.flatten() {
      let path = entry.path();
      // Wipe the live stats files and any temp orphan left by an interrupted
      // atomic save, which still holds a copy of the history. This directory
      // holds nothing but traffic stats, so matching every `.json`/`.tmp` also
      // catches orphans from older temp-naming schemes.
      let is_stats = path
        .extension()
        .is_some_and(|ext| ext == "json" || ext == "tmp");
      if is_stats {
        let _ = secure_remove_file(&path);
      }
    }
  }
  forget_cached(None);

  Ok(())
}

/// Lightweight session snapshot for real-time updates, written by the worker
/// every few seconds while its numbers change. It holds what the worker has
/// not written to the stats file yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SessionSnapshot {
  proxy_id: String,
  profile_id: Option<String>,
  timestamp: u64,
  bytes_sent: u64,
  bytes_received: u64,
  requests: u64,
  #[serde(default)]
  upstream: UpstreamCounts,
  /// Bytes per second over the worker's last collection interval. Missing
  /// in files from older workers, which reported only `bytes_*`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  current_bytes_sent: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  current_bytes_received: Option<u64>,
  /// Bandwidth points of the last minute that are not in the stats file yet.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  bandwidth: Vec<BandwidthDataPoint>,
}

/// A session snapshot without its time: two equal keys mean the file on
/// disk already says the same.
type SessionKey = (
  u64,
  u64,
  u64,
  Option<u64>,
  Option<u64>,
  usize,
  UpstreamCounts,
);

impl SessionSnapshot {
  fn change_key(&self) -> SessionKey {
    (
      self.bytes_sent,
      self.bytes_received,
      self.requests,
      self.current_bytes_sent,
      self.current_bytes_received,
      self.bandwidth.len(),
      self.upstream,
    )
  }
}

/// A session snapshot newer than this describes a worker that is still
/// collecting; an older one's rate is no longer current.
const SESSION_FRESH_SECS: u64 = 6;

/// How often a worker writes its whole stats file while it has new traffic.
/// The session snapshot carries the live numbers in between.
const FULL_WRITE_INTERVAL_SECS: u64 = 60;

/// How often a worker drops history older than the retention.
const PRUNE_INTERVAL_SECS: u64 = 60 * 60;

/// Traffic a worker collected that is not in the stats file yet.
#[derive(Debug, Default)]
struct Pending {
  bytes_sent: u64,
  bytes_received: u64,
  requests: u64,
  bandwidth: Vec<BandwidthDataPoint>,
  domains: HashMap<String, DomainDelta>,
  ips: Vec<String>,
}

impl Pending {
  fn is_empty(&self) -> bool {
    self.bytes_sent == 0
      && self.bytes_received == 0
      && self.requests == 0
      && self.bandwidth.is_empty()
      && self.domains.is_empty()
      && self.ips.is_empty()
  }
}

/// A worker's stats file as it last read or wrote it, and what came since.
#[derive(Debug, Default)]
struct Persist {
  /// Loaded at the first write and kept: the file is parsed again only when
  /// someone else changed it (cleared history, another worker).
  stats: Option<TrafficStats>,
  disk_sig: Option<FileSig>,
  compacted: Compacted,
  pending: Pending,
  last_collect: u64,
  /// Bytes per second sent and received over the last collect interval.
  rate: (u64, u64),
  last_write: u64,
  last_prune: u64,
  session_written: Option<SessionKey>,
}

/// Live bandwidth tracker for real-time stats collection in the proxy
/// This is designed to be used from within the proxy server
pub struct LiveTrafficTracker {
  pub proxy_id: String,
  pub profile_id: Option<String>,
  bytes_sent: AtomicU64,
  bytes_received: AtomicU64,
  requests: AtomicU64,
  domain_stats: RwLock<HashMap<String, (u64, u64, u64)>>, // domain -> (count, sent, recv)
  ips: RwLock<Vec<String>>,
  /// False when the user turned off site history: bytes and requests are
  /// still counted, but no domain or address is kept.
  record_domains: bool,
  session_start: u64,
  upstream_reached: AtomicU64,
  upstream_failed: AtomicU64,
  upstream_timed_out: AtomicU64,
  upstream_auth_refused: AtomicU64,
  upstream_payment_required: AtomicU64,
  persist: Mutex<Persist>,
}

impl LiveTrafficTracker {
  pub fn new(proxy_id: String, profile_id: Option<String>, record_domains: bool) -> Self {
    let session_start = current_timestamp();
    Self {
      proxy_id,
      profile_id,
      record_domains,
      bytes_sent: AtomicU64::new(0),
      bytes_received: AtomicU64::new(0),
      requests: AtomicU64::new(0),
      domain_stats: RwLock::new(HashMap::new()),
      ips: RwLock::new(Vec::new()),
      session_start,
      upstream_reached: AtomicU64::new(0),
      upstream_failed: AtomicU64::new(0),
      upstream_timed_out: AtomicU64::new(0),
      upstream_auth_refused: AtomicU64::new(0),
      upstream_payment_required: AtomicU64::new(0),
      persist: Mutex::new(Persist {
        last_collect: session_start,
        last_write: session_start,
        ..Persist::default()
      }),
    }
  }

  fn storage_key(&self) -> String {
    self
      .profile_id
      .clone()
      .unwrap_or_else(|| self.proxy_id.clone())
  }

  fn state(&self) -> std::sync::MutexGuard<'_, Persist> {
    self
      .persist
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  /// Count one dial to the upstream proxy. Never reset by a flush: the app
  /// takes differences between readings.
  pub fn record_upstream(&self, outcome: UpstreamOutcome) {
    let counter = match outcome {
      UpstreamOutcome::Reached => &self.upstream_reached,
      UpstreamOutcome::ConnectFailed => &self.upstream_failed,
      UpstreamOutcome::TimedOut => &self.upstream_timed_out,
      UpstreamOutcome::AuthRefused => &self.upstream_auth_refused,
      UpstreamOutcome::PaymentRequired => &self.upstream_payment_required,
    };
    counter.fetch_add(1, Ordering::Relaxed);
  }

  pub fn upstream_counts(&self) -> UpstreamCounts {
    UpstreamCounts {
      reached: self.upstream_reached.load(Ordering::Relaxed),
      failed: self.upstream_failed.load(Ordering::Relaxed),
      timed_out: self.upstream_timed_out.load(Ordering::Relaxed),
      auth_refused: self.upstream_auth_refused.load(Ordering::Relaxed),
      payment_required: self.upstream_payment_required.load(Ordering::Relaxed),
    }
  }

  pub fn add_bytes_sent(&self, bytes: u64) {
    self.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
  }

  pub fn add_bytes_received(&self, bytes: u64) {
    self.bytes_received.fetch_add(bytes, Ordering::Relaxed);
  }

  pub fn record_request(&self, domain: &str, bytes_sent: u64, bytes_received: u64) {
    self.requests.fetch_add(1, Ordering::Relaxed);
    // Also update total byte counters for HTTP requests (not tunneled)
    self.bytes_sent.fetch_add(bytes_sent, Ordering::Relaxed);
    self
      .bytes_received
      .fetch_add(bytes_received, Ordering::Relaxed);
    if !self.record_domains {
      return;
    }
    if let Ok(mut stats) = self.domain_stats.write() {
      let entry = stats.entry(domain.to_string()).or_insert((0, 0, 0));
      entry.0 += 1;
      entry.1 += bytes_sent;
      entry.2 += bytes_received;
    }
  }

  pub fn record_ip(&self, ip: &str) {
    if !self.record_domains {
      return;
    }
    if let Ok(mut ips) = self.ips.write() {
      if !ips.iter().any(|known| known == ip) {
        ips.push(ip.to_string());
      }
    }
  }

  /// Update domain-specific byte counts (called when CONNECT tunnel closes)
  pub fn update_domain_bytes(&self, domain: &str, bytes_sent: u64, bytes_received: u64) {
    if !self.record_domains {
      return;
    }
    if let Ok(mut stats) = self.domain_stats.write() {
      let entry = stats.entry(domain.to_string()).or_insert((0, 0, 0));
      entry.1 += bytes_sent;
      entry.2 += bytes_received;
    }
  }

  /// The counters not collected yet: bytes sent, bytes received, requests.
  pub fn get_snapshot(&self) -> (u64, u64, u64) {
    (
      self.bytes_sent.load(Ordering::Relaxed),
      self.bytes_received.load(Ordering::Relaxed),
      self.requests.load(Ordering::Relaxed),
    )
  }

  /// Move the live counters into the pending traffic, as one bandwidth point
  /// at `now`.
  fn collect(&self, now: u64) {
    let sent = self.bytes_sent.swap(0, Ordering::Relaxed);
    let received = self.bytes_received.swap(0, Ordering::Relaxed);
    let requests = self.requests.swap(0, Ordering::Relaxed);
    let domains: Vec<(String, (u64, u64, u64))> = self
      .domain_stats
      .write()
      .map(|mut map| map.drain().collect())
      .unwrap_or_default();
    let ips: Vec<String> = self
      .ips
      .write()
      .map(|mut ips| std::mem::take(&mut *ips))
      .unwrap_or_default();

    let mut guard = self.state();
    let state = &mut *guard;
    let secs = now.saturating_sub(state.last_collect).max(1);
    state.rate = (sent / secs, received / secs);
    state.last_collect = now;

    let pending = &mut state.pending;
    pending.bytes_sent += sent;
    pending.bytes_received += received;
    pending.requests += requests;
    if sent > 0 || received > 0 {
      match pending.bandwidth.last_mut() {
        Some(last) if last.timestamp >= now => {
          last.bytes_sent += sent;
          last.bytes_received += received;
        }
        _ => pending.bandwidth.push(BandwidthDataPoint {
          timestamp: now,
          bytes_sent: sent,
          bytes_received: received,
        }),
      }
    }
    for (domain, (count, domain_sent, domain_received)) in domains {
      let delta = pending.domains.entry(domain).or_insert(DomainDelta {
        first: now,
        ..DomainDelta::default()
      });
      delta.requests += count;
      delta.bytes_sent += domain_sent;
      delta.bytes_received += domain_received;
      delta.last = now;
    }
    for ip in ips {
      if !pending.ips.contains(&ip) {
        pending.ips.push(ip);
      }
    }
  }

  /// Write the pending traffic into the stats file, under the file lock.
  /// Returns the bytes written, or `None` with nothing pending. On failure
  /// the pending traffic stays for the next try.
  fn write_full(&self, now: u64) -> Result<Option<(u64, u64)>, String> {
    let mut guard = self.state();
    let state = &mut *guard;
    if state.pending.is_empty() {
      return Ok(None);
    }
    let key = self.storage_key();
    let storage_dir = get_traffic_stats_dir();
    fs::create_dir_all(&storage_dir).map_err(|e| e.to_string())?;
    // Another worker of the same profile may be writing the same file.
    let _lock =
      acquire_file_lock(&storage_dir.join(format!("{key}.lock"))).map_err(|e| e.to_string())?;
    let path = storage_dir.join(format!("{key}.json"));

    let sig = FileSig::of_path(&path);
    let mut stats = match state.stats.take() {
      // A file that is gone was cleared: its history is not written back.
      Some(stats) if sig.is_some() && sig == state.disk_sig => stats,
      _ => {
        let mut stats = read_stats_file(&path)
          .unwrap_or_else(|| TrafficStats::new(self.proxy_id.clone(), self.profile_id.clone()));
        stats.sort_history();
        stats.prune_old_data_at(now);
        state.compacted = Compacted::default();
        state.last_prune = now;
        stats
      }
    };
    if stats.profile_id.is_none() {
      stats.profile_id = self.profile_id.clone();
    }
    stats.proxy_id = self.proxy_id.clone();
    stats.apply(&state.pending, now);
    if now.saturating_sub(state.last_prune) >= PRUNE_INTERVAL_SECS {
      stats.prune_old_data_at(now);
      state.last_prune = now;
    }
    state.compacted = stats.compact_history(now, state.compacted);

    if let Err(e) = save_traffic_stats(&stats) {
      // `stats` holds the pending traffic now; the next try reads the file
      // again and adds it once.
      state.disk_sig = None;
      return Err(e.to_string());
    }
    let pending = std::mem::take(&mut state.pending);
    state.disk_sig = FileSig::of_path(&path);
    state.stats = Some(stats);
    state.last_write = now;
    Ok(Some((pending.bytes_sent, pending.bytes_received)))
  }

  /// What the session snapshot says now: pending traffic plus the counters
  /// not collected yet.
  fn session_view(&self, now: u64) -> SessionSnapshot {
    let (sent, received, requests) = self.get_snapshot();
    let state = self.state();
    let cutoff = now.saturating_sub(60);
    SessionSnapshot {
      proxy_id: self.proxy_id.clone(),
      profile_id: self.profile_id.clone(),
      timestamp: now,
      bytes_sent: state.pending.bytes_sent + sent,
      bytes_received: state.pending.bytes_received + received,
      requests: state.pending.requests + requests,
      upstream: self.upstream_counts(),
      current_bytes_sent: Some(state.rate.0),
      current_bytes_received: Some(state.rate.1),
      bandwidth: state
        .pending
        .bandwidth
        .iter()
        .filter(|point| point.timestamp >= cutoff)
        .cloned()
        .collect(),
    }
  }

  fn write_session_file(
    &self,
    session: &SessionSnapshot,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let storage_key = self.storage_key();
    let storage_dir = get_traffic_stats_dir();
    fs::create_dir_all(&storage_dir)?;
    let session_file = storage_dir.join(format!("{storage_key}.session.json"));
    // Write atomically using a temp file. Named by suffix rather than
    // `with_extension`, which would replace `.json` and yield
    // `{key}.session.tmp` — a name the cleanup sweeps did not recognise.
    let temp_file = storage_dir.join(format!("{storage_key}.session.json.tmp"));
    fs::write(&temp_file, serde_json::to_vec(session)?)?;
    fs::rename(&temp_file, &session_file)?;
    Ok(())
  }

  /// Write the session snapshot now.
  pub fn write_session_snapshot(&self) -> Result<(), Box<dyn std::error::Error>> {
    let session = self.session_view(current_timestamp());
    self.write_session_file(&session)?;
    self.state().session_written = Some(session.change_key());
    Ok(())
  }

  /// One step of the worker's traffic loop: collect the counters, write the
  /// stats file when a minute has passed with new traffic, and rewrite the
  /// session snapshot when its numbers changed.
  pub fn persist_tick(&self) -> Result<(), String> {
    let now = current_timestamp();
    self.collect(now);
    let due = now.saturating_sub(self.state().last_write) >= FULL_WRITE_INTERVAL_SECS;
    let written = if due {
      self.write_full(now).map(|_| ())
    } else {
      Ok(())
    };
    let session = self.session_view(now);
    if self.state().session_written != Some(session.change_key()) {
      self
        .write_session_file(&session)
        .map_err(|e| e.to_string())?;
      self.state().session_written = Some(session.change_key());
    }
    written
  }

  /// Create a real-time snapshot that merges in-memory data with disk-stored data
  /// This provides near real-time updates without waiting for disk flush
  pub fn to_realtime_snapshot(&self) -> TrafficSnapshot {
    let now = current_timestamp();
    let session = self.session_view(now);
    snapshot_for_key(&self.storage_key(), Some(&session), now)
      .unwrap_or_else(|| snapshot_from_session(&session, self.session_start, now))
  }

  /// Collect the counters and write everything pending to the stats file.
  /// Returns the bytes written, or `None` with nothing to write.
  pub fn flush_to_disk(&self) -> Result<Option<(u64, u64)>, Box<dyn std::error::Error>> {
    let now = current_timestamp();
    self.collect(now);
    Ok(self.write_full(now)?)
  }
}

/// Write what the worker's tracker holds before the process exits, so the
/// last minute of traffic is not lost.
pub fn flush_traffic_before_exit() {
  if let Some(tracker) = get_traffic_tracker() {
    if let Err(e) = tracker.flush_to_disk() {
      log::warn!("Traffic stats final write failed err=\"{e}\"");
    }
    let _ = tracker.write_session_snapshot();
  }
}

/// Global traffic tracker that can be accessed from connection handlers
/// Using RwLock to allow reinitialization when proxy config changes
static TRAFFIC_TRACKER: std::sync::RwLock<Option<Arc<LiveTrafficTracker>>> =
  std::sync::RwLock::new(None);

/// Initialize the global traffic tracker
/// This can be called multiple times to update the tracker when proxy config changes
pub fn init_traffic_tracker(proxy_id: String, profile_id: Option<String>, record_domains: bool) {
  let tracker = Arc::new(LiveTrafficTracker::new(
    proxy_id,
    profile_id,
    record_domains,
  ));
  if let Ok(mut guard) = TRAFFIC_TRACKER.write() {
    *guard = Some(tracker);
  }
}

/// Get the global traffic tracker
pub fn get_traffic_tracker() -> Option<Arc<LiveTrafficTracker>> {
  TRAFFIC_TRACKER.read().ok().and_then(|guard| guard.clone())
}

/// What a snapshot shows of a stats file. Read without the site tables,
/// which are most of a large file, and kept per file until the file changes:
/// the GUI asks every second.
#[derive(Debug, Clone)]
struct StatsSummary {
  proxy_id: String,
  profile_id: Option<String>,
  session_start: u64,
  last_update: u64,
  last_flush_timestamp: u64,
  total_bytes_sent: u64,
  total_bytes_received: u64,
  total_requests: u64,
  /// Points of the minute before the file was read. A snapshot shows the
  /// last minute, so later snapshots need no older point.
  recent: Vec<BandwidthDataPoint>,
}

/// The fields of a stats file a summary needs; serde skips the rest.
#[derive(Deserialize)]
struct StatsHead {
  proxy_id: String,
  profile_id: Option<String>,
  session_start: u64,
  last_update: u64,
  #[serde(default)]
  last_flush_timestamp: u64,
  total_bytes_sent: u64,
  total_bytes_received: u64,
  total_requests: u64,
  #[serde(default)]
  bandwidth_history: Vec<BandwidthDataPoint>,
}

impl StatsSummary {
  fn of(stats: &TrafficStats, now: u64) -> Self {
    let cutoff = now.saturating_sub(60);
    StatsSummary {
      proxy_id: stats.proxy_id.clone(),
      profile_id: stats.profile_id.clone(),
      session_start: stats.session_start,
      last_update: stats.last_update,
      last_flush_timestamp: stats.last_flush_timestamp,
      total_bytes_sent: stats.total_bytes_sent,
      total_bytes_received: stats.total_bytes_received,
      total_requests: stats.total_requests,
      recent: stats
        .bandwidth_history
        .iter()
        .filter(|point| point.timestamp >= cutoff)
        .cloned()
        .collect(),
    }
  }

  fn read(path: &Path, now: u64) -> Option<Self> {
    let content = fs::read(path).ok()?;
    let head: StatsHead = serde_json::from_slice(&content).ok()?;
    drop(content);
    let cutoff = now.saturating_sub(60);
    let mut recent = head.bandwidth_history;
    recent.retain(|point| point.timestamp >= cutoff);
    recent.shrink_to_fit();
    Some(StatsSummary {
      proxy_id: head.proxy_id,
      profile_id: head.profile_id,
      session_start: head.session_start,
      last_update: head.last_update,
      last_flush_timestamp: head.last_flush_timestamp,
      total_bytes_sent: head.total_bytes_sent,
      total_bytes_received: head.total_bytes_received,
      total_requests: head.total_requests,
      recent,
    })
  }

  fn key(&self) -> String {
    self
      .profile_id
      .clone()
      .unwrap_or_else(|| self.proxy_id.clone())
  }

  fn snapshot(&self, now: u64) -> TrafficSnapshot {
    let cutoff = now.saturating_sub(60); // Last 60 seconds for mini chart

    // Get current bandwidth from last data point
    let (current_sent, current_recv) = self
      .recent
      .last()
      .filter(|dp| dp.timestamp >= now.saturating_sub(2)) // Within last 2 seconds
      .map(|dp| (dp.bytes_sent, dp.bytes_received))
      .unwrap_or((0, 0));

    TrafficSnapshot {
      profile_id: self.profile_id.clone(),
      session_start: self.session_start,
      last_update: self.last_update,
      total_bytes_sent: self.total_bytes_sent,
      total_bytes_received: self.total_bytes_received,
      total_requests: self.total_requests,
      current_bytes_sent: current_sent,
      current_bytes_received: current_recv,
      recent_bandwidth: self
        .recent
        .iter()
        .filter(|dp| dp.timestamp >= cutoff)
        .cloned()
        .collect(),
      upstream_failures: 0,
      upstream_timeouts: 0,
    }
  }
}

type SummaryCache = HashMap<PathBuf, (FileSig, Option<Arc<StatsSummary>>)>;

static SUMMARIES: LazyLock<Mutex<SummaryCache>> = LazyLock::new(Default::default);

/// One full stats file, for the details view that asks every 2 s.
struct FullStatsEntry {
  path: PathBuf,
  sig: FileSig,
  stats: Arc<TrafficStats>,
  used: u64,
}

static FULL_STATS: Mutex<Option<FullStatsEntry>> = Mutex::new(None);

/// A full stats file nobody asked for in this long is dropped from memory.
const FULL_STATS_IDLE_SECS: u64 = 30;

fn lock_cache<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  mutex
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The summary of a stats file, parsed only when the file changed.
fn cached_summary(path: &Path, sig: FileSig, now: u64) -> Option<Arc<StatsSummary>> {
  if let Some((cached_sig, summary)) = lock_cache(&SUMMARIES).get(path) {
    if *cached_sig == sig {
      return summary.clone();
    }
  }
  let summary = StatsSummary::read(path, now).map(Arc::new);
  lock_cache(&SUMMARIES).insert(path.to_path_buf(), (sig, summary.clone()));
  summary
}

/// Drop what the caches hold of a file, or of every file.
fn forget_cached(path: Option<&Path>) {
  let mut summaries = lock_cache(&SUMMARIES);
  let mut full = lock_cache(&FULL_STATS);
  match path {
    Some(path) => {
      summaries.remove(path);
      if full.as_ref().is_some_and(|entry| entry.path == path) {
        *full = None;
      }
    }
    None => {
      summaries.clear();
      *full = None;
    }
  }
}

fn evict_idle_full_stats(now: u64) {
  let mut full = lock_cache(&FULL_STATS);
  if full
    .as_ref()
    .is_some_and(|entry| now.saturating_sub(entry.used) > FULL_STATS_IDLE_SECS)
  {
    *full = None;
  }
}

/// The full stats of `id`, parsed only when the file changed.
fn cached_full_stats(id: &str, now: u64) -> Option<Arc<TrafficStats>> {
  let path = get_traffic_stats_dir().join(format!("{id}.json"));
  let mut full = lock_cache(&FULL_STATS);
  let Some(sig) = FileSig::of_path(&path) else {
    if full.as_ref().is_some_and(|entry| entry.path == path) {
      *full = None;
    }
    return None;
  };
  if let Some(entry) = full.as_mut() {
    if entry.path == path && entry.sig == sig {
      entry.used = now;
      return Some(entry.stats.clone());
    }
  }
  let stats = Arc::new(read_stats_file(&path)?);
  *full = Some(FullStatsEntry {
    path,
    sig,
    stats: stats.clone(),
    used: now,
  });
  Some(stats)
}

/// Add a session snapshot to the snapshot of the same stats file. Its
/// traffic counts only when it is newer than the file's last write: an older
/// one holds bytes the file already has.
fn merge_session(
  snapshot: &mut TrafficSnapshot,
  session: &SessionSnapshot,
  last_flush: u64,
  now: u64,
) {
  snapshot.upstream_failures = session.upstream.refused();
  snapshot.upstream_timeouts = session.upstream.timed_out;
  if session.timestamp > last_flush {
    snapshot.total_bytes_sent = snapshot.total_bytes_sent.saturating_add(session.bytes_sent);
    snapshot.total_bytes_received = snapshot
      .total_bytes_received
      .saturating_add(session.bytes_received);
    snapshot.total_requests = snapshot.total_requests.saturating_add(session.requests);
    let cutoff = now.saturating_sub(60);
    for point in session.bandwidth.iter().filter(|p| p.timestamp >= cutoff) {
      match snapshot.recent_bandwidth.last_mut() {
        Some(last) if last.timestamp >= point.timestamp => {
          last.bytes_sent += point.bytes_sent;
          last.bytes_received += point.bytes_received;
        }
        _ => snapshot.recent_bandwidth.push(point.clone()),
      }
    }
    if session.current_bytes_sent.is_none() {
      // An older worker: its pending bytes were the closest to a rate.
      snapshot.current_bytes_sent = session.bytes_sent;
      snapshot.current_bytes_received = session.bytes_received;
    }
    snapshot.last_update = session.timestamp;
  } else if session.timestamp > snapshot.last_update {
    snapshot.last_update = session.timestamp;
  }
  if let (Some(sent), Some(received)) = (session.current_bytes_sent, session.current_bytes_received)
  {
    let fresh = now.saturating_sub(session.timestamp) <= SESSION_FRESH_SECS;
    snapshot.current_bytes_sent = if fresh { sent } else { 0 };
    snapshot.current_bytes_received = if fresh { received } else { 0 };
  }
}

fn snapshot_from_session(
  session: &SessionSnapshot,
  session_start: u64,
  now: u64,
) -> TrafficSnapshot {
  let mut snapshot = TrafficSnapshot {
    profile_id: session.profile_id.clone(),
    session_start,
    last_update: session.timestamp,
    total_bytes_sent: 0,
    total_bytes_received: 0,
    total_requests: 0,
    current_bytes_sent: 0,
    current_bytes_received: 0,
    recent_bandwidth: Vec::new(),
    upstream_failures: 0,
    upstream_timeouts: 0,
  };
  merge_session(&mut snapshot, session, 0, now);
  snapshot
}

/// The snapshot of one stats file with its session merged, or `None` when
/// the file does not exist or cannot be read.
fn snapshot_for_key(
  key: &str,
  session: Option<&SessionSnapshot>,
  now: u64,
) -> Option<TrafficSnapshot> {
  let path = get_traffic_stats_dir().join(format!("{key}.json"));
  let summary = cached_summary(&path, FileSig::of_path(&path)?, now)?;
  let mut snapshot = summary.snapshot(now);
  if let Some(session) = session {
    merge_session(&mut snapshot, session, summary.last_flush_timestamp, now);
  }
  Some(snapshot)
}

/// The session snapshot of `key`: the in-process tracker's when it is this
/// worker's own, else the file a worker wrote.
fn session_for_key(key: &str, now: u64) -> Option<SessionSnapshot> {
  if let Some(tracker) = get_traffic_tracker() {
    if tracker.storage_key() == key {
      return Some(tracker.session_view(now));
    }
  }
  load_session_snapshot(key)
}

/// Filtered traffic stats for client display (only contains data for requested period)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilteredTrafficStats {
  pub profile_id: Option<String>,
  pub session_start: u64,
  pub last_update: u64,
  pub total_bytes_sent: u64,
  pub total_bytes_received: u64,
  pub total_requests: u64,
  /// Bandwidth history filtered to requested time period
  pub bandwidth_history: Vec<BandwidthDataPoint>,
  /// Period stats: bytes sent/received within the requested period
  pub period_bytes_sent: u64,
  pub period_bytes_received: u64,
  /// Period requests within the requested period
  pub period_requests: u64,
  /// Domain access statistics filtered to requested time period
  pub domains: HashMap<String, DomainAccess>,
  /// Unique IPs accessed
  pub unique_ips: Vec<String>,
}

/// Get traffic stats for a profile, filtered to a specific time period
/// seconds: number of seconds to include (0 = all time)
/// Adds what the profile's worker has not written to the file yet.
pub fn get_traffic_stats_for_period(
  profile_id: &str,
  seconds: u64,
) -> Option<FilteredTrafficStats> {
  let now = current_timestamp();
  let stats = cached_full_stats(profile_id, now)?;
  let session = session_for_key(profile_id, now)
    .filter(|session| session.timestamp > stats.last_flush_timestamp);

  let cutoff = if seconds == 0 {
    0 // All time
  } else {
    now.saturating_sub(seconds)
  };

  // Filter bandwidth history to requested period, then add the points the
  // worker has not written yet.
  let mut filtered_history: Vec<BandwidthDataPoint> = stats
    .bandwidth_history
    .iter()
    .filter(|dp| dp.timestamp >= cutoff)
    .cloned()
    .collect();
  let (mut total_sent, mut total_received, mut total_requests) = (
    stats.total_bytes_sent,
    stats.total_bytes_received,
    stats.total_requests,
  );
  if let Some(session) = &session {
    total_sent = total_sent.saturating_add(session.bytes_sent);
    total_received = total_received.saturating_add(session.bytes_received);
    total_requests = total_requests.saturating_add(session.requests);
    for point in session.bandwidth.iter().filter(|p| p.timestamp >= cutoff) {
      match filtered_history.last_mut() {
        Some(last) if last.timestamp >= point.timestamp => {
          last.bytes_sent += point.bytes_sent;
          last.bytes_received += point.bytes_received;
        }
        _ => filtered_history.push(point.clone()),
      }
    }
  }

  // Calculate period totals for bandwidth
  let period_bytes_sent: u64 = filtered_history.iter().map(|dp| dp.bytes_sent).sum();
  let period_bytes_received: u64 = filtered_history.iter().map(|dp| dp.bytes_received).sum();

  // Filter and aggregate domain stats for the period
  let mut filtered_domains: HashMap<String, DomainAccess> = HashMap::new();
  let mut period_requests: u64 = 0;

  for access in stats
    .domain_access_history
    .iter()
    .filter(|a| a.timestamp >= cutoff)
  {
    period_requests += access.requests;
    let entry = filtered_domains
      .entry(access.domain.clone())
      .or_insert(DomainAccess {
        domain: access.domain.clone(),
        request_count: 0,
        bytes_sent: 0,
        bytes_received: 0,
        first_access: access.timestamp,
        last_access: access.timestamp,
      });

    entry.request_count += access.requests;
    entry.bytes_sent += access.bytes_sent;
    entry.bytes_received += access.bytes_received;
    entry.first_access = entry.first_access.min(access.timestamp);
    entry.last_access = entry.last_access.max(access.timestamp);
  }

  // If no domain_access_history exists (old data), fall back to all-time domains
  let domains = if stats.domain_access_history.is_empty() {
    stats.domains.clone()
  } else {
    filtered_domains
  };

  Some(FilteredTrafficStats {
    profile_id: stats.profile_id.clone(),
    session_start: stats.session_start,
    last_update: now, // Use current time for real-time updates
    total_bytes_sent: total_sent,
    total_bytes_received: total_received,
    total_requests,
    bandwidth_history: filtered_history,
    period_bytes_sent,
    period_bytes_received,
    period_requests,
    domains,
    unique_ips: stats.unique_ips.clone(),
  })
}

/// Get lightweight traffic snapshot for a profile (for mini charts, only recent 60 seconds)
/// Adds what the profile's worker has not written to the file yet.
pub fn get_traffic_snapshot_for_profile(profile_id: &str) -> Option<TrafficSnapshot> {
  let now = current_timestamp();
  evict_idle_full_stats(now);
  let session = session_for_key(profile_id, now);
  snapshot_for_key(profile_id, session.as_ref(), now)
    .or_else(|| session.map(|session| snapshot_from_session(&session, now.saturating_sub(60), now)))
}

/// The upstream dial counters the worker of this profile last wrote.
pub fn upstream_counts_for_profile(profile_id: &str) -> Option<UpstreamCounts> {
  load_session_snapshot(profile_id).map(|session| session.upstream)
}

/// Load session snapshot from disk (written by proxy worker processes)
fn load_session_snapshot(profile_id: &str) -> Option<SessionSnapshot> {
  read_session_file(&get_traffic_stats_dir().join(format!("{profile_id}.session.json")))
}

fn read_session_file(path: &Path) -> Option<SessionSnapshot> {
  let content = fs::read(path).ok()?;
  serde_json::from_slice::<SessionSnapshot>(&content).ok()
}

/// What the traffic stats directory holds.
struct StatsDir {
  /// The summary of every stats file, by key.
  summaries: HashMap<String, Arc<StatsSummary>>,
  /// Session files by key.
  sessions: Vec<(String, PathBuf)>,
  /// An old proxy-id file still waits for its migration.
  legacy: bool,
}

fn read_stats_dir(dir: &Path, now: u64) -> StatsDir {
  let mut summaries: HashMap<String, Arc<StatsSummary>> = HashMap::new();
  let mut sessions = Vec::new();
  let mut legacy = false;
  let mut seen: HashSet<PathBuf> = HashSet::new();
  if let Ok(entries) = fs::read_dir(dir) {
    for entry in entries.flatten() {
      let file_name = entry.file_name();
      let Some((key, kind)) = file_name.to_str().and_then(classify_stats_file) else {
        continue;
      };
      let path = entry.path();
      match kind {
        StatsFileKind::Session => sessions.push((key.to_string(), path)),
        StatsFileKind::Stats => {
          let Ok(meta) = entry.metadata() else {
            continue;
          };
          seen.insert(path.clone());
          let Some(summary) = cached_summary(&path, FileSig::of(&meta), now) else {
            continue;
          };
          if key.starts_with("proxy_") && summary.profile_id.as_deref().is_some_and(|id| id != key)
          {
            legacy = true;
          }
          let summary_key = summary.key();
          let newer = summaries
            .get(&summary_key)
            .is_none_or(|existing| summary.last_update > existing.last_update);
          if newer {
            summaries.insert(summary_key, summary);
          }
        }
        StatsFileKind::Lock | StatsFileKind::Temp => {}
      }
    }
  }
  lock_cache(&SUMMARIES).retain(|path, _| seen.contains(path));
  StatsDir {
    summaries,
    sessions,
    legacy,
  }
}

/// Get all traffic snapshots with real-time data merged
/// This provides near real-time updates by merging session snapshots with disk data
pub fn get_all_traffic_snapshots_realtime() -> Vec<TrafficSnapshot> {
  let now = current_timestamp();
  evict_idle_full_stats(now);
  let storage_dir = get_traffic_stats_dir();
  let mut listing = read_stats_dir(&storage_dir, now);
  if listing.legacy {
    // Old proxy-id files are merged into their profile's file and removed.
    collect_traffic_stats();
    listing = read_stats_dir(&storage_dir, now);
  }
  let StatsDir {
    summaries,
    sessions,
    ..
  } = listing;

  let mut snapshots: HashMap<String, TrafficSnapshot> = summaries
    .iter()
    .map(|(key, summary)| (key.clone(), summary.snapshot(now)))
    .collect();

  // A worker process asking about itself merges its own tracker instead.
  let own_key = get_traffic_tracker().map(|tracker| {
    let key = tracker.storage_key();
    snapshots.insert(key.clone(), tracker.to_realtime_snapshot());
    key
  });

  for (key, path) in sessions {
    if own_key.as_deref() == Some(key.as_str()) {
      continue;
    }
    let Some(session) = read_session_file(&path) else {
      continue;
    };
    match snapshots.get_mut(&key) {
      Some(snapshot) => {
        let last_flush = summaries
          .get(&key)
          .map_or(0, |summary| summary.last_flush_timestamp);
        merge_session(snapshot, &session, last_flush, now);
      }
      None => {
        snapshots.insert(
          key,
          snapshot_from_session(&session, now.saturating_sub(60), now),
        );
      }
    }
  }

  snapshots.into_values().collect()
}

/// Files of workers that stopped are left alone for this long, so a worker
/// that is just starting never loses its files.
const STALE_FILE_GRACE_SECS: u64 = 5 * 60;

/// Remove what workers that no longer run left in the traffic stats
/// directory: lock files, temp files, session snapshots (their unwritten
/// traffic goes into the stats file first) and the stats of check workers,
/// which belong to no profile and are never shown. `live_keys` are the
/// storage keys of workers that still run; their files stay.
pub fn sweep_stale_files(live_keys: &HashSet<String>) {
  sweep_stale_files_in(&get_traffic_stats_dir(), live_keys, STALE_FILE_GRACE_SECS);
}

fn sweep_stale_files_in(dir: &Path, live_keys: &HashSet<String>, grace_secs: u64) {
  let Ok(entries) = fs::read_dir(dir) else {
    return;
  };
  let now = std::time::SystemTime::now();
  let mut stale: Vec<(String, StatsFileKind, PathBuf)> = Vec::new();
  for entry in entries.flatten() {
    let file_name = entry.file_name();
    let Some((key, kind)) = file_name.to_str().and_then(classify_stats_file) else {
      continue;
    };
    if live_keys.contains(key) {
      continue;
    }
    let old_enough = entry
      .metadata()
      .and_then(|meta| meta.modified())
      .ok()
      .and_then(|modified| now.duration_since(modified).ok())
      .is_some_and(|age| age.as_secs() >= grace_secs);
    if old_enough {
      stale.push((key.to_string(), kind, entry.path()));
    }
  }
  // Sessions first: folding one in takes the key's lock file.
  stale.sort_by_key(|(_, kind, _)| *kind != StatsFileKind::Session);

  let mut removed = 0usize;
  for (key, kind, path) in stale {
    let gone = match kind {
      StatsFileKind::Temp => fs::remove_file(&path).is_ok(),
      StatsFileKind::Session => {
        absorb_orphan_session(dir, &key, &path) && fs::remove_file(&path).is_ok()
      }
      // Removed while held, so no worker can take it in between; a lock
      // someone holds stays.
      StatsFileKind::Lock => match acquire_file_lock(&path) {
        Ok(_held) => fs::remove_file(&path).is_ok(),
        Err(_) => false,
      },
      StatsFileKind::Stats => {
        let check_worker_stats = key.starts_with("proxy_")
          && FileSig::of_path(&path)
            .and_then(|sig| cached_summary(&path, sig, current_timestamp()))
            .is_some_and(|summary| summary.profile_id.is_none());
        let gone = check_worker_stats && fs::remove_file(&path).is_ok();
        if gone {
          forget_cached(Some(&path));
        }
        gone
      }
    };
    if gone {
      removed += 1;
    }
  }
  if removed > 0 {
    log::info!("Traffic files of stopped workers removed files={removed}");
  }
}

/// Fold a stopped worker's unwritten traffic into its stats file now. A
/// worker killed without a flush (Windows stops it with `taskkill /F`, or it
/// crashed) keeps up to a minute of traffic only in its session file, and the
/// next worker of the same profile writes over that file.
pub fn absorb_stopped_worker(key: &str) {
  let dir = get_traffic_stats_dir();
  let path = dir.join(format!("{key}.session.json"));
  if path.is_file() && absorb_orphan_session(&dir, key, &path) {
    let _ = fs::remove_file(&path);
  }
}

/// Fold the traffic a stopped worker never wrote into its stats file.
/// Returns whether the session file may go.
fn absorb_orphan_session(dir: &Path, key: &str, session_path: &Path) -> bool {
  let Some(session) = read_session_file(session_path) else {
    return true;
  };
  let has_traffic = session.bytes_sent > 0 || session.bytes_received > 0 || session.requests > 0;
  if !has_traffic || session.profile_id.is_none() {
    return true;
  }
  let Ok(_lock) = acquire_file_lock(&dir.join(format!("{key}.lock"))) else {
    return false;
  };
  let stats_path = dir.join(format!("{key}.json"));
  let mut stats = read_stats_file(&stats_path)
    .unwrap_or_else(|| TrafficStats::new(session.proxy_id.clone(), session.profile_id.clone()));
  if session.timestamp <= stats.last_flush_timestamp {
    return true;
  }
  let mut bandwidth = session.bandwidth.clone();
  let in_points: (u64, u64) = bandwidth
    .iter()
    .fold((0, 0), |(s, r), p| (s + p.bytes_sent, r + p.bytes_received));
  let (rest_sent, rest_received) = (
    session.bytes_sent.saturating_sub(in_points.0),
    session.bytes_received.saturating_sub(in_points.1),
  );
  if rest_sent > 0 || rest_received > 0 {
    bandwidth.push(BandwidthDataPoint {
      timestamp: session.timestamp,
      bytes_sent: rest_sent,
      bytes_received: rest_received,
    });
  }
  let pending = Pending {
    bytes_sent: session.bytes_sent,
    bytes_received: session.bytes_received,
    requests: session.requests,
    bandwidth,
    ..Pending::default()
  };
  let last_update = stats.last_update.max(session.timestamp);
  stats.apply(&pending, session.timestamp);
  stats.last_update = last_update;
  match save_traffic_stats_in(dir, key, &stats) {
    Ok(()) => true,
    Err(e) => {
      log::warn!("Stopped worker traffic not saved key={key} err=\"{e}\"");
      false
    }
  }
}

#[cfg(test)]
mod route_health_tests {
  use super::*;

  fn counts(reached: u64, failed: u64, timed_out: u64) -> UpstreamCounts {
    UpstreamCounts {
      reached,
      failed,
      timed_out,
      ..Default::default()
    }
  }

  #[test]
  fn the_first_reading_is_only_a_baseline() {
    let mut window = RouteHealthWindow::default();
    assert_eq!(window.observe(100, counts(0, 50, 0)), None);
    assert_eq!(window.current(), None, "old failures are not this window's");
  }

  #[test]
  fn steady_dials_are_ok_once_and_say_nothing_after() {
    let mut window = RouteHealthWindow::default();
    window.observe(100, counts(0, 0, 0));
    assert_eq!(
      window.observe(105, counts(10, 0, 0)),
      Some((RouteHealthStatus::Ok, None))
    );
    assert_eq!(window.observe(110, counts(20, 0, 0)), None);
  }

  #[test]
  fn only_failures_mean_down_and_some_mean_degraded() {
    let mut window = RouteHealthWindow::default();
    window.observe(0, counts(0, 0, 0));
    assert_eq!(
      window.observe(5, counts(0, 3, 0)),
      Some((RouteHealthStatus::Down, Some("PROXY_UPSTREAM_UNREACHABLE")))
    );
    assert_eq!(
      window.observe(10, counts(8, 3, 0)),
      Some((
        RouteHealthStatus::Degraded,
        Some("PROXY_UPSTREAM_UNREACHABLE")
      ))
    );
    // One failure among many dials is noise.
    let mut busy = RouteHealthWindow::default();
    busy.observe(0, counts(0, 0, 0));
    assert_eq!(
      busy.observe(5, counts(40, 1, 0)),
      Some((RouteHealthStatus::Ok, None))
    );
  }

  #[test]
  fn timeouts_and_refusals_name_their_reason() {
    let mut window = RouteHealthWindow::default();
    window.observe(0, counts(0, 0, 0));
    assert_eq!(
      window.observe(5, counts(0, 1, 4)),
      Some((RouteHealthStatus::Down, Some("PROXY_UPSTREAM_TIMEOUT")))
    );
    let mut auth = RouteHealthWindow::default();
    auth.observe(0, UpstreamCounts::default());
    assert_eq!(
      auth.observe(
        5,
        UpstreamCounts {
          auth_refused: 3,
          ..Default::default()
        }
      ),
      Some((RouteHealthStatus::Down, Some("PROXY_AUTH_FAILED")))
    );
  }

  #[test]
  fn failures_leave_the_window_and_the_route_recovers() {
    let mut window = RouteHealthWindow::default();
    window.observe(0, counts(0, 0, 0));
    window.observe(5, counts(0, 4, 0));
    assert_eq!(window.current().map(|v| v.0), Some(RouteHealthStatus::Down));
    // Quiet for a whole window: no evidence, the last verdict stands.
    assert_eq!(window.observe(80, counts(0, 4, 0)), None);
    assert_eq!(
      window.observe(85, counts(5, 4, 0)),
      Some((RouteHealthStatus::Ok, None))
    );
  }

  #[test]
  fn a_new_worker_restarts_the_counters_without_a_false_spike() {
    let mut window = RouteHealthWindow::default();
    window.observe(0, counts(100, 0, 0));
    window.observe(5, counts(110, 0, 0));
    // The profile restarted: its new worker counts from zero.
    assert_eq!(window.observe(10, counts(2, 0, 0)), None);
    assert_eq!(window.current().map(|v| v.0), Some(RouteHealthStatus::Ok));
  }

  #[test]
  fn the_session_snapshot_carries_the_counters_and_old_files_still_read() {
    let tracker = LiveTrafficTracker::new("p".into(), Some("prof".into()), false);
    tracker.record_upstream(UpstreamOutcome::Reached);
    tracker.record_upstream(UpstreamOutcome::TimedOut);
    tracker.record_upstream(UpstreamOutcome::ConnectFailed);
    assert_eq!(tracker.upstream_counts(), counts(1, 1, 1));
    let old: SessionSnapshot = serde_json::from_str(
      r#"{"proxy_id":"p","profile_id":null,"timestamp":1,"bytes_sent":0,"bytes_received":0,"requests":0}"#,
    )
    .unwrap();
    assert_eq!(old.upstream, UpstreamCounts::default());
  }
}

#[cfg(test)]
mod persistence_tests {
  use super::*;

  fn point(timestamp: u64, bytes_sent: u64, bytes_received: u64) -> BandwidthDataPoint {
    BandwidthDataPoint {
      timestamp,
      bytes_sent,
      bytes_received,
    }
  }

  fn row(timestamp: u64, domain: &str, requests: u64) -> DomainAccessPoint {
    DomainAccessPoint {
      timestamp,
      domain: domain.to_string(),
      bytes_sent: 10,
      bytes_received: 20,
      requests,
    }
  }

  /// Three hours of history: a point every 2 s, two site rows a minute.
  fn three_hours(now: u64) -> TrafficStats {
    let start = now - 3 * 3600;
    let mut stats = TrafficStats::new("proxy_1_1".into(), Some("prof".into()));
    stats.bandwidth_history = (0..3 * 3600 / 2)
      .map(|i| point(start + i * 2, 1, 2))
      .collect();
    stats.domain_access_history = (0..3 * 60)
      .flat_map(|m| {
        [
          row(start + m * 60, "a.example", 1),
          row(start + m * 60 + 7, "b.example", 2),
        ]
      })
      .collect();
    stats
  }

  fn sums(stats: &TrafficStats) -> (u64, u64, u64, u64) {
    (
      stats.bandwidth_history.iter().map(|p| p.bytes_sent).sum(),
      stats
        .bandwidth_history
        .iter()
        .map(|p| p.bytes_received)
        .sum(),
      stats.domain_access_history.iter().map(|r| r.requests).sum(),
      stats
        .domain_access_history
        .iter()
        .map(|r| r.bytes_sent)
        .sum(),
    )
  }

  #[test]
  fn history_older_than_an_hour_is_kept_per_minute_and_per_hour() {
    let now = 400 * 3600 + 1234;
    let mut stats = three_hours(now);
    let before = sums(&stats);
    let done = stats.compact_history(now, Compacted::default());
    assert_eq!(sums(&stats), before, "every byte and request is kept");

    let horizon = now - FULL_RESOLUTION_SECS;
    let minute_line = horizon - horizon % 60;
    let old: Vec<u64> = stats
      .bandwidth_history
      .iter()
      .map(|p| p.timestamp)
      .filter(|t| *t < minute_line)
      .collect();
    assert!(old.iter().all(|t| t % 60 == 0), "one point per minute");
    assert!(old.windows(2).all(|w| w[1] - w[0] == 60));
    let recent = stats
      .bandwidth_history
      .iter()
      .filter(|p| p.timestamp >= minute_line)
      .count();
    assert!(recent >= 1800, "the last hour keeps every point: {recent}");

    let hour_line = horizon - horizon % 3600;
    let mut buckets: Vec<(u64, &str)> = stats
      .domain_access_history
      .iter()
      .filter(|r| r.timestamp < hour_line)
      .map(|r| (r.timestamp / 3600, r.domain.as_str()))
      .collect();
    let rows = buckets.len();
    buckets.sort_unstable();
    buckets.dedup();
    assert_eq!(buckets.len(), rows, "one row per domain and hour");
    assert!(stats
      .domain_access_history
      .windows(2)
      .all(|w| w[0].timestamp <= w[1].timestamp));

    let lengths = (
      stats.bandwidth_history.len(),
      stats.domain_access_history.len(),
    );
    assert_eq!(stats.compact_history(now, done), done);
    let mut again = stats.clone();
    again.compact_history(now, Compacted::default());
    assert_eq!(
      (
        again.bandwidth_history.len(),
        again.domain_access_history.len()
      ),
      lengths,
      "compacting a compacted history changes nothing"
    );
    assert_eq!(sums(&again), before);
  }

  #[test]
  fn compacting_minute_by_minute_matches_compacting_at_once() {
    let end = 500 * 3600 + 77;
    let stats = three_hours(end);
    let mut stepwise = stats.clone();
    let mut done = Compacted::default();
    for now in (end - 2 * 3600..=end).step_by(60) {
      done = stepwise.compact_history(now, done);
    }
    done = stepwise.compact_history(end, done);
    let mut once = stats;
    assert_eq!(once.compact_history(end, Compacted::default()), done);
    assert_eq!(
      serde_json::to_string(&stepwise.bandwidth_history).unwrap(),
      serde_json::to_string(&once.bandwidth_history).unwrap()
    );
    assert_eq!(
      serde_json::to_string(&stepwise.domain_access_history).unwrap(),
      serde_json::to_string(&once.domain_access_history).unwrap()
    );
  }

  #[test]
  fn a_file_written_before_compaction_still_loads() {
    let old = r#"{"proxy_id":"proxy_1_2","profile_id":"prof","session_start":100,"last_update":200,"total_bytes_sent":5,"total_bytes_received":7,"total_requests":3,"bandwidth_history":[{"timestamp":150,"bytes_sent":5,"bytes_received":7}],"domains":{"a.example":{"domain":"a.example","request_count":3,"bytes_sent":5,"bytes_received":7,"first_access":150,"last_access":160}},"domain_access_history":[{"timestamp":150,"domain":"a.example","bytes_sent":2,"bytes_received":3},{"timestamp":160,"domain":"a.example","bytes_sent":3,"bytes_received":4}],"unique_ips":["203.0.113.1"]}"#;
    let stats: TrafficStats = serde_json::from_str(old).unwrap();
    assert_eq!(stats.last_flush_timestamp, 0);
    assert!(stats.domain_access_history.iter().all(|r| r.requests == 1));
    let head: StatsHead = serde_json::from_str(old).unwrap();
    assert_eq!((head.total_bytes_sent, head.total_requests), (5, 3));
    assert_eq!(head.bandwidth_history.len(), 1);

    let single = serde_json::to_string(&stats.domain_access_history[0]).unwrap();
    assert!(!single.contains("requests"), "{single}");
    let grouped = DomainAccessPoint {
      requests: 4,
      ..stats.domain_access_history[0].clone()
    };
    assert!(serde_json::to_string(&grouped)
      .unwrap()
      .contains("\"requests\":4"));
  }

  #[test]
  fn stats_files_are_told_apart_by_name() {
    use StatsFileKind::*;
    for (name, expected) in [
      ("abc.json", Some(("abc", Stats))),
      ("abc.session.json", Some(("abc", Session))),
      ("abc.lock", Some(("abc", Lock))),
      ("abc.json.tmp", Some(("abc", Temp))),
      ("abc.session.json.tmp", Some(("abc", Temp))),
      ("abc.session.tmp", Some(("abc", Temp))),
      (".DS_Store", None),
      ("abc.txt", None),
      ("abc", None),
    ] {
      assert_eq!(classify_stats_file(name), expected, "{name}");
    }
  }

  #[test]
  #[serial_test::serial]
  fn a_worker_writes_its_minute_and_never_restores_a_cleared_history() {
    let temp = tempfile::tempdir().unwrap();
    let _cache = crate::app_dirs::set_test_cache_dir(temp.path().to_path_buf());
    let tracker = LiveTrafficTracker::new("proxy_1_1".into(), Some("prof-w".into()), true);
    let t0 = tracker.session_start;

    tracker.record_request("a.example", 100, 200);
    tracker.collect(t0 + 2);
    assert!(
      load_traffic_stats("prof-w").is_none(),
      "collecting writes nothing"
    );
    let session = tracker.session_view(t0 + 2);
    assert_eq!(
      (session.bytes_sent, session.bytes_received, session.requests),
      (100, 200, 1)
    );
    assert_eq!(session.bandwidth.len(), 1);
    assert_eq!(session.current_bytes_sent, Some(50), "bytes per second");

    assert_eq!(tracker.write_full(t0 + 60).unwrap(), Some((100, 200)));
    let stats = load_traffic_stats("prof-w").unwrap();
    assert_eq!(
      (
        stats.total_bytes_sent,
        stats.total_requests,
        stats.last_flush_timestamp
      ),
      (100, 1, t0 + 60)
    );
    assert_eq!(stats.domains["a.example"].request_count, 1);
    assert_eq!(tracker.write_full(t0 + 61).unwrap(), None);
    assert_eq!(tracker.session_view(t0 + 61).bytes_sent, 0);

    // Another writer changed the file: its numbers stay, ours are added.
    let mut other = load_traffic_stats("prof-w").unwrap();
    other.total_bytes_sent += 1000;
    save_traffic_stats(&other).unwrap();
    tracker.add_bytes_sent(1);
    tracker.collect(t0 + 64);
    tracker.write_full(t0 + 120).unwrap();
    assert_eq!(load_traffic_stats("prof-w").unwrap().total_bytes_sent, 1101);

    // The person clears the history while the worker runs.
    assert!(delete_traffic_stats("prof-w"));
    tracker.add_bytes_sent(5);
    tracker.collect(t0 + 130);
    tracker.write_full(t0 + 180).unwrap();
    let stats = load_traffic_stats("prof-w").unwrap();
    assert_eq!(stats.total_bytes_sent, 5);
    assert!(stats.domains.is_empty());
  }

  #[test]
  fn a_session_adds_only_what_the_file_does_not_have() {
    let now = 1_000_000;
    let summary = StatsSummary {
      proxy_id: "p".into(),
      profile_id: Some("prof".into()),
      session_start: 1,
      last_update: now - 30,
      last_flush_timestamp: now - 30,
      total_bytes_sent: 1000,
      total_bytes_received: 2000,
      total_requests: 10,
      recent: vec![point(now - 40, 7, 7)],
    };
    let session = SessionSnapshot {
      timestamp: now - 1,
      bytes_sent: 50,
      bytes_received: 60,
      requests: 2,
      current_bytes_sent: Some(25),
      current_bytes_received: Some(30),
      bandwidth: vec![point(now - 10, 20, 20), point(now - 1, 30, 40)],
      ..SessionSnapshot::default()
    };
    let mut snapshot = summary.snapshot(now);
    merge_session(&mut snapshot, &session, summary.last_flush_timestamp, now);
    assert_eq!(
      (
        snapshot.total_bytes_sent,
        snapshot.total_bytes_received,
        snapshot.total_requests
      ),
      (1050, 2060, 12)
    );
    let times: Vec<u64> = snapshot
      .recent_bandwidth
      .iter()
      .map(|p| p.timestamp)
      .collect();
    assert_eq!(times, [now - 40, now - 10, now - 1]);
    assert_eq!(
      (snapshot.current_bytes_sent, snapshot.current_bytes_received),
      (25, 30)
    );

    let written = SessionSnapshot {
      timestamp: now - 31,
      ..session.clone()
    };
    let mut snapshot = summary.snapshot(now);
    merge_session(&mut snapshot, &written, summary.last_flush_timestamp, now);
    assert_eq!(snapshot.total_bytes_sent, 1000, "the file has these bytes");
    assert_eq!(snapshot.current_bytes_sent, 0, "an old rate is not current");

    let older_worker: SessionSnapshot = serde_json::from_str(
      r#"{"proxy_id":"p","profile_id":"prof","timestamp":999999,"bytes_sent":40,"bytes_received":0,"requests":1}"#,
    )
    .unwrap();
    let mut snapshot = summary.snapshot(now);
    merge_session(
      &mut snapshot,
      &older_worker,
      summary.last_flush_timestamp,
      now,
    );
    assert_eq!(
      (snapshot.total_bytes_sent, snapshot.current_bytes_sent),
      (1040, 40)
    );
  }

  #[test]
  #[serial_test::serial]
  fn snapshots_read_only_stats_files_and_follow_their_changes() {
    let temp = tempfile::tempdir().unwrap();
    let _cache = crate::app_dirs::set_test_cache_dir(temp.path().to_path_buf());
    let dir = get_traffic_stats_dir();
    fs::create_dir_all(&dir).unwrap();
    let mut stats = TrafficStats::new("proxy_1_1".into(), Some("prof-s".into()));
    stats.total_bytes_sent = 10;
    save_traffic_stats(&stats).unwrap();
    fs::write(dir.join("prof-s.lock"), b"").unwrap();
    fs::write(dir.join("prof-s.json.tmp"), b"{").unwrap();
    let session = SessionSnapshot {
      proxy_id: "proxy_1_1".into(),
      profile_id: Some("prof-s".into()),
      timestamp: current_timestamp() + 1,
      bytes_sent: 5,
      ..SessionSnapshot::default()
    };
    fs::write(
      dir.join("prof-s.session.json"),
      serde_json::to_vec(&session).unwrap(),
    )
    .unwrap();

    let total = || {
      get_all_traffic_snapshots_realtime()
        .into_iter()
        .filter(|s| s.profile_id.as_deref() == Some("prof-s"))
        .map(|s| s.total_bytes_sent)
        .collect::<Vec<_>>()
    };
    assert_eq!(total(), [15]);
    stats.total_bytes_sent = 20;
    save_traffic_stats(&stats).unwrap();
    assert_eq!(total(), [25], "a changed file is read again");
    assert_eq!(
      get_traffic_snapshot_for_profile("prof-s")
        .unwrap()
        .total_bytes_sent,
      25
    );
    assert_eq!(
      get_traffic_stats_for_period("prof-s", 0)
        .unwrap()
        .total_bytes_sent,
      25
    );
  }

  #[test]
  fn the_sweep_removes_what_stopped_workers_left_and_keeps_their_traffic() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let mut stats = TrafficStats::new("proxy_1_1".into(), Some("gone".into()));
    stats.total_bytes_sent = 100;
    stats.last_flush_timestamp = 50;
    save_traffic_stats_in(dir, "gone", &stats).unwrap();
    let session = SessionSnapshot {
      proxy_id: "proxy_1_1".into(),
      profile_id: Some("gone".into()),
      timestamp: 60,
      bytes_sent: 7,
      bytes_received: 3,
      requests: 1,
      bandwidth: vec![point(58, 2, 1)],
      ..SessionSnapshot::default()
    };
    fs::write(
      dir.join("gone.session.json"),
      serde_json::to_vec(&session).unwrap(),
    )
    .unwrap();
    fs::write(dir.join("gone.lock"), b"").unwrap();
    fs::write(dir.join("gone.session.tmp"), b"").unwrap();
    save_traffic_stats_in(
      dir,
      "proxy_9_9",
      &TrafficStats::new("proxy_9_9".into(), None),
    )
    .unwrap();
    fs::write(dir.join("live.session.json"), b"{}").unwrap();
    fs::write(dir.join("live.lock"), b"").unwrap();
    let live: HashSet<String> = HashSet::from(["live".to_string()]);

    sweep_stale_files_in(dir, &live, 3600);
    assert!(dir.join("gone.lock").exists(), "recent files wait");

    sweep_stale_files_in(dir, &live, 0);
    let names: HashSet<String> = fs::read_dir(dir)
      .unwrap()
      .flatten()
      .map(|entry| entry.file_name().into_string().unwrap())
      .collect();
    let expected: HashSet<String> = ["gone.json", "live.session.json", "live.lock"]
      .map(String::from)
      .into();
    assert_eq!(names, expected);
    let kept = read_stats_file(&dir.join("gone.json")).unwrap();
    assert_eq!(
      (
        kept.total_bytes_sent,
        kept.total_bytes_received,
        kept.total_requests,
        kept.last_flush_timestamp
      ),
      (107, 3, 1, 60)
    );
    let in_history: (u64, u64) = kept
      .bandwidth_history
      .iter()
      .fold((0, 0), |(s, r), p| (s + p.bytes_sent, r + p.bytes_received));
    assert_eq!(in_history, (7, 3));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_tracker_without_site_history_counts_bytes_only() {
    let tracker = LiveTrafficTracker::new("proxy".into(), Some("profile".into()), false);
    tracker.record_request("example.com", 100, 200);
    tracker.update_domain_bytes("example.com", 5, 5);
    tracker.record_ip("203.0.113.7");

    assert_eq!(tracker.get_snapshot(), (100, 200, 1));
    assert!(tracker.domain_stats.read().unwrap().is_empty());
    assert!(tracker.ips.read().unwrap().is_empty());
  }

  #[test]
  fn test_traffic_stats_creation() {
    let stats = TrafficStats::new(
      "test_proxy".to_string(),
      Some("test-profile-id".to_string()),
    );
    assert_eq!(stats.proxy_id, "test_proxy");
    assert_eq!(stats.profile_id, Some("test-profile-id".to_string()));
    assert_eq!(stats.total_bytes_sent, 0);
    assert_eq!(stats.total_bytes_received, 0);
  }

  #[test]
  fn test_bandwidth_recording() {
    let mut stats = TrafficStats::new("test_proxy".to_string(), None);

    stats.record_bandwidth(1000, 2000);
    assert_eq!(stats.total_bytes_sent, 1000);
    assert_eq!(stats.total_bytes_received, 2000);
    assert_eq!(stats.bandwidth_history.len(), 1);

    stats.record_bandwidth(500, 1000);
    assert_eq!(stats.total_bytes_sent, 1500);
    assert_eq!(stats.total_bytes_received, 3000);
  }

  #[test]
  fn test_domain_recording() {
    let mut stats = TrafficStats::new("test_proxy".to_string(), None);

    stats.record_request("example.com", 100, 500);
    stats.record_request("example.com", 200, 1000);
    stats.record_request("google.com", 50, 200);

    assert_eq!(stats.domains.len(), 2);
    assert_eq!(stats.domains["example.com"].request_count, 2);
    assert_eq!(stats.domains["example.com"].bytes_sent, 300);
    assert_eq!(stats.domains["google.com"].request_count, 1);
  }

  #[test]
  fn test_ip_recording() {
    let mut stats = TrafficStats::new("test_proxy".to_string(), None);

    stats.record_ip("192.168.1.1");
    stats.record_ip("192.168.1.1"); // Duplicate
    stats.record_ip("10.0.0.1");

    assert_eq!(stats.unique_ips.len(), 2);
  }
}
