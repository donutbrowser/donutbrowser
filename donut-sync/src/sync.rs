//! The object routes: presigned transfers, listing, deletes, restore points
//! and the team rules that guard them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::try_join_all;
use regex_lite::Regex;
use serde_json::{Map, Value, json};

use crate::auth::{Mode, TeamRole, UserContext, group_id_valid};
use crate::backend::Backend;
use crate::error::ApiError;
use crate::jsval::{Body, Field};
use crate::log;
use crate::s3::Presigner;
use crate::store::{HeadOutput, ListInput, Store, StoreError};
use crate::time;

const CONTEXT: &str = "SyncService";

/// Marker object written under each scope. Subscribers HEAD it on each poll
/// and only LIST when its ETag changed. It starts with a dot so it sorts first
/// and is plainly internal; listings never return it.
pub const MANIFEST_KEY: &str = ".donut-sync-manifest";

/// Max presigned-URL lifetime, whatever a client asks for.
const MAX_PRESIGN_EXPIRES_IN: f64 = 3600.0;
/// Upper bound on a presign batch (each item is a signing operation).
const MAX_BATCH_ITEMS: usize = 1000;
/// How many restore points of each kind a profile keeps.
pub const SNAPSHOTS_PER_KIND: usize = 3;
/// Objects copied at a time.
const COPY_CONCURRENCY: usize = 8;
/// How long a profile's group is trusted before it is read again.
const GROUP_CACHE_TTL: Duration = Duration::from_secs(30);
const GROUP_CACHE_MAX: usize = 10_000;

/// The `group-id` a profile without a group carries.
pub const UNGROUPED: &str = "__ungrouped__";

/// A profile's objects, relative to the namespace: its root and its id. A
/// restore point (`snapshots/<root>`) belongs to the profile it copies.
static PROFILE_KEY: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^(?:snapshots/)?((?:teams/[^/]+/)?profiles/([^/]+)/)").unwrap());
/// A profile root as the restore-point routes take it.
static PROFILE_ROOT: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^(?:teams/[^/]+/)?profiles/[^/]+/$").unwrap());
/// A restore point's id: its UTC time, then a short random part.
static SNAPSHOT_ID: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$").unwrap());
/// A group's config object, relative to the namespace.
static GROUP_KEY: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^(?:teams/[^/]+/)?groups/([^/]+)\.json$").unwrap());
/// What a launcher's session may write, relative to the team namespace.
static LAUNCHER_WRITABLE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new("^(teams/[^/]+/)?profiles/[^/]+/(files/[^\n\r\u{2028}\u{2029}]+|manifest\\.json)$")
    .unwrap()
});
/// A key inside a profile that counts against the plan, relative to the namespace.
static COUNTED_PROFILE_KEY: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^profiles/([^/]+)/").unwrap());

/// A profile's group, read from its metadata object.
#[derive(Clone, Debug, PartialEq)]
enum Group {
  /// No metadata object yet.
  Missing,
  /// A metadata object without a group id (written by an older app).
  Unnamed,
  Named(String),
}

/// A client-supplied `expiresIn`, clamped to a sane positive range.
fn clamp_expires_in(requested: Field) -> f64 {
  let value = requested.as_number().filter(|v| *v > 0.0).unwrap_or(3600.0);
  value.min(MAX_PRESIGN_EXPIRES_IN)
}

/// `new Date(ms).toISOString()` for a fractional millisecond time.
fn iso_at(ms: f64) -> String {
  time::iso_from_ms(ms.trunc() as i64)
}

/// Only these metadata keys mean anything to sync: `updated-at` for
/// last-write-wins, `group-id` for team access by group. Anything else would
/// let a client sign arbitrary `x-amz-meta-*` values.
fn sanitize_metadata(metadata: Field) -> Option<Vec<(String, String)>> {
  if !metadata.truthy() {
    return None;
  }
  let map = metadata.as_object()?;
  let mut out = Vec::new();
  if let Some(Value::String(updated_at)) = map.get("updated-at") {
    out.push(("updated-at".to_string(), updated_at.clone()));
  }
  if let Some(Value::String(group)) = map.get("group-id")
    && group_id_valid(group)
  {
    out.push(("group-id".to_string(), group.clone()));
  }
  (!out.is_empty()).then_some(out)
}

fn metadata_json(metadata: &[(String, String)]) -> Value {
  Value::Object(
    metadata
      .iter()
      .map(|(k, v)| (k.clone(), Value::String(v.clone())))
      .collect(),
  )
}

fn store_error(error: StoreError) -> ApiError {
  ApiError::Internal(error.to_string())
}

/// A key the AWS SDK refused to build a request for (`undefined` or `null`).
fn require_key(key: &Option<String>) -> Result<&str, ApiError> {
  key
    .as_deref()
    .ok_or_else(|| ApiError::Internal("No value provided for input HTTP label: Key.".to_string()))
}

/// `value.startsWith(prefix)` on a field that must be a string. JavaScript
/// threw a `TypeError` on anything else.
fn field_starts_with(field: Field, prefix: &str) -> Result<bool, ApiError> {
  field
    .as_str()
    .map(|s| s.starts_with(prefix))
    .ok_or_else(|| {
      ApiError::Internal(format!(
        "Cannot read startsWith of {}",
        field.to_js_string()
      ))
    })
}

fn group_denied() -> ApiError {
  ApiError::forbidden_body(json!({
    "code": "TEAM_GROUP_ACCESS_DENIED",
    "message": "This member has no access to the group of this profile",
  }))
}

pub struct SyncService {
  store: Arc<dyn Store>,
  presigner: Presigner,
  public_endpoint: String,
  public_endpoint_configured: bool,
  cloud: bool,
  backend: Option<Arc<Backend>>,
  group_cache: Mutex<HashMap<String, (Group, Instant)>>,
}

pub struct SyncOptions {
  pub presigner: Presigner,
  pub public_endpoint: String,
  pub public_endpoint_configured: bool,
  /// `SYNC_JWT_PUBLIC_KEY` is set: Donut's own deployment.
  pub cloud: bool,
  pub backend: Option<Arc<Backend>>,
}

impl SyncService {
  pub fn new(store: Arc<dyn Store>, options: SyncOptions) -> Self {
    Self {
      store,
      presigner: options.presigner,
      public_endpoint: options.public_endpoint,
      public_endpoint_configured: options.public_endpoint_configured,
      cloud: options.cloud,
      backend: options.backend,
      group_cache: Mutex::new(HashMap::new()),
    }
  }

  pub fn store(&self) -> &Arc<dyn Store> {
    &self.store
  }

  // --- startup and probes ----------------------------------------------------

  pub async fn ensure_bucket_exists(&self) -> Result<(), String> {
    match self.store.head_bucket().await {
      Ok(()) => Ok(()),
      Err(StoreError::NotFound) => match self.store.create_bucket().await {
        Ok(()) => Ok(()),
        // The bucket exists and is ours.
        Err(e) if e.code() == Some("BucketAlreadyOwnedByYou") => Ok(()),
        Err(e) => Err(format!("Failed to create S3 bucket: {e}")),
      },
      Err(e) => Err(format!("S3 connection failed: {e}")),
    }
  }

  pub async fn check_s3_connectivity(&self) -> bool {
    self.store.head_bucket().await.is_ok()
  }

  /// The address clients are sent to for transfers, for `/readyz`. Withheld
  /// in cloud mode: `/readyz` is public, and a managed deployment should not
  /// publish its storage host.
  pub fn diagnostic_storage_endpoint(&self) -> Option<&str> {
    (!self.cloud).then_some(self.public_endpoint.as_str())
  }

  /// A single-label host (`minio`, `s3`) resolves only inside a container
  /// network, so every presigned URL built from it fails for the desktop
  /// client while the server's own S3 calls succeed. Say it once at boot.
  pub fn warn_if_presign_endpoint_is_server_only(&self) {
    let Ok(url) = url::Url::parse(&self.public_endpoint) else {
      return;
    };
    let host = url.host_str().unwrap_or("").to_string();
    let single_label = !host.contains('.') && !host.contains(':') && host != "localhost";
    if single_label {
      log::warn(
        CONTEXT,
        &format!(
          "Storage endpoint '{}' uses the container-only host '{host}'. Presigned URLs built from it cannot be reached by Donut Browser, so every transfer will fail while /health and /readyz stay green. Set S3_PUBLIC_ENDPOINT to an address your devices can reach (and publish that port).",
          self.public_endpoint
        ),
      );
      return;
    }
    // A dotted host proves nothing: unset, clients get whatever address this
    // server uses for storage itself. State that, and leave the judgement to
    // the operator.
    if !self.public_endpoint_configured {
      log::log(
        CONTEXT,
        &format!(
          "S3_PUBLIC_ENDPOINT is not set, so presigned URLs will name '{}', the address this server uses for storage itself. Transfers go straight from each device to that address, and this server cannot verify a device can reach it. If transfers fail while /health and /readyz stay green, set S3_PUBLIC_ENDPOINT to an address your devices can reach and publish that port.",
          self.public_endpoint
        ),
      );
    }
  }

  // --- scoping ---------------------------------------------------------------

  /// A client key in the caller's namespace. Self-hosted keys pass through;
  /// `None` is a key the SDK could not use (`undefined` or `null`).
  fn scope_key(&self, ctx: &UserContext, key: Field) -> Option<String> {
    match ctx.mode {
      Mode::SelfHosted => key.to_key(),
      _ => Some(format!("{}{}", ctx.prefix, key.to_js_string())),
    }
  }

  fn scope_str(&self, ctx: &UserContext, key: &str) -> String {
    match ctx.mode {
      Mode::SelfHosted => key.to_string(),
      _ => format!("{}{key}", ctx.prefix),
    }
  }

  fn scope_for_key<'a>(&self, ctx: &'a UserContext, scoped: Option<&str>) -> Option<&'a str> {
    match ctx.mode {
      Mode::SelfHosted => Some(""),
      _ if scoped.is_some_and(|k| k.starts_with(&ctx.prefix)) => Some(&ctx.prefix),
      _ => None,
    }
  }

  fn validate_key_access(&self, ctx: &UserContext, key: Option<&str>) -> Result<(), ApiError> {
    if ctx.mode == Mode::SelfHosted || key.is_some_and(|k| k.starts_with(&ctx.prefix)) {
      return Ok(());
    }
    Err(ApiError::forbidden("Access denied to this key"))
  }

  /// A launcher may write only what a session changes: a profile's files and
  /// its manifest. Never its settings, the team's proxies or groups, and never
  /// a whole profile or a tombstone.
  fn validate_write_access(&self, ctx: &UserContext, key: Option<&str>) -> Result<(), ApiError> {
    self.validate_key_access(ctx, key)?;
    if ctx.team_role != Some(TeamRole::Launcher) {
      return Ok(());
    }
    if LAUNCHER_WRITABLE.is_match(self.relative(ctx, key.unwrap_or(""))) {
      return Ok(());
    }
    Err(ApiError::forbidden_body(json!({
      "code": "TEAM_ROLE_READ_ONLY",
      "message": "This team role can run profiles but not change them",
    })))
  }

  fn relative<'a>(&self, ctx: &UserContext, key: &'a str) -> &'a str {
    key.get(ctx.prefix.len()..).unwrap_or("")
  }

  async fn profile_group(&self, ctx: &UserContext, root: &str) -> Result<Group, ApiError> {
    let key = format!("{}{root}metadata.json", ctx.prefix);
    let now = Instant::now();
    if let Some((group, expires)) = self.group_cache.lock().unwrap().get(&key)
      && *expires > now
    {
      return Ok(group.clone());
    }
    let group = match self.store.head_object(&key).await {
      Ok(head) => match head.metadata_value("group-id") {
        Some(id) if group_id_valid(id) => Group::Named(id.to_string()),
        _ => Group::Unnamed,
      },
      Err(StoreError::NotFound) => Group::Missing,
      Err(e) => return Err(store_error(e)),
    };
    let mut cache = self.group_cache.lock().unwrap();
    if cache.len() > GROUP_CACHE_MAX {
      cache.clear();
    }
    cache.insert(key, (group.clone(), now + GROUP_CACHE_TTL));
    Ok(group)
  }

  /// Whether a member limited to some groups may see the object at `key`. A
  /// profile's objects follow its group; a group's config object follows the
  /// group itself; everything else is shared team config.
  async fn can_reach(&self, ctx: &UserContext, key: &str) -> Result<bool, ApiError> {
    let Some(groups) = &ctx.group_ids else {
      return Ok(true);
    };
    let relative = self.relative(ctx, key);
    if let Some(found) = GROUP_KEY.captures(relative) {
      return Ok(groups.iter().any(|g| g == &found[1]));
    }
    let Some(profile) = PROFILE_KEY.captures(relative) else {
      return Ok(true);
    };
    Ok(match self.profile_group(ctx, &profile[1]).await? {
      Group::Named(group) => groups.contains(&group),
      _ => false,
    })
  }

  async fn assert_reachable(&self, ctx: &UserContext, key: Option<&str>) -> Result<(), ApiError> {
    if ctx.group_ids.is_none() || self.can_reach(ctx, key.unwrap_or("")).await? {
      return Ok(());
    }
    Err(group_denied())
  }

  /// A limited member may change a profile only inside its groups: the group
  /// it is in now, and the group a new metadata object names. A new profile
  /// starts with its metadata, so its first write names its group.
  async fn assert_group_write(
    &self,
    ctx: &UserContext,
    key: Option<&str>,
    metadata: Option<&[(String, String)]>,
  ) -> Result<(), ApiError> {
    let Some(groups) = &ctx.group_ids else {
      return Ok(());
    };
    let relative = self.relative(ctx, key.unwrap_or(""));
    let mut allowed = true;
    if let Some(found) = GROUP_KEY.captures(relative) {
      allowed = groups.iter().any(|g| g == &found[1]);
    } else if let Some(profile) = PROFILE_KEY.captures(relative) {
      let root = profile[1].to_string();
      let current = self.profile_group(ctx, &root).await?;
      let is_metadata = relative == format!("{root}metadata.json");
      let named = metadata.and_then(|m| {
        m.iter()
          .find(|(k, _)| k == "group-id")
          .map(|(_, v)| v.as_str())
      });
      match &current {
        Group::Unnamed => allowed = false,
        Group::Named(group) if !groups.contains(group) => allowed = false,
        Group::Missing if !is_metadata => allowed = false,
        _ => {}
      }
      if is_metadata && !named.is_some_and(|n| groups.iter().any(|g| g == n)) {
        allowed = false;
      }
      if allowed && is_metadata && named.is_some() {
        // The next read must see the group this write gives the profile.
        self
          .group_cache
          .lock()
          .unwrap()
          .remove(&format!("{}{root}metadata.json", ctx.prefix));
      }
    }
    if allowed { Ok(()) } else { Err(group_denied()) }
  }

  /// `items` without the ones a limited member may not see, order kept.
  pub(crate) async fn reachable_only<T>(
    &self,
    ctx: &UserContext,
    items: Vec<T>,
    key_of: impl Fn(&T) -> String,
  ) -> Result<Vec<T>, ApiError> {
    if ctx.group_ids.is_none() {
      return Ok(items);
    }
    let keys: Vec<String> = items.iter().map(&key_of).collect();
    let verdicts = try_join_all(keys.iter().map(|key| self.can_reach(ctx, key))).await?;
    Ok(
      items
        .into_iter()
        .zip(verdicts)
        .filter_map(|(item, reachable)| reachable.then_some(item))
        .collect(),
    )
  }

  /// Bumps the manifest of the scope that owns `scoped`, so subscribers' HEAD
  /// polls see a new ETag. Fire-and-forget: a failure only delays other
  /// devices until their next listing.
  fn bump_manifest(&self, ctx: &UserContext, scoped: Option<&str>) {
    let Some(scope) = self.scope_for_key(ctx, scoped) else {
      return;
    };
    let key = format!("{scope}{MANIFEST_KEY}");
    let store = self.store.clone();
    tokio::spawn(async move {
      let body = json!({
        "updatedAt": time::iso_from_ms(time::now_ms()),
        "nonce": uuid::Uuid::new_v4().to_string(),
      })
      .to_string();
      if let Err(e) = store
        .put_object(&key, body.into_bytes(), "application/json")
        .await
      {
        log::warn(CONTEXT, &format!("Manifest bump failed for {key}: {e}"));
      }
    });
  }

  // --- object routes ---------------------------------------------------------

  pub async fn stat(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let key = self.scope_key(ctx, body.field("key")?);
    self.validate_key_access(ctx, key.as_deref())?;
    self.assert_reachable(ctx, key.as_deref()).await?;
    match self.store.head_object(require_key(&key)?).await {
      Ok(head) => Ok(stat_json(&head)),
      Err(StoreError::NotFound) => Ok(json!({ "exists": false })),
      Err(e) => Err(store_error(e)),
    }
  }

  pub async fn presign_upload(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let raw_key = body.field("key")?;
    let key = self.scope_key(ctx, raw_key);
    self.validate_write_access(ctx, key.as_deref())?;
    let metadata = sanitize_metadata(body.field("metadata")?);
    self
      .assert_group_write(ctx, key.as_deref(), metadata.as_deref())
      .await?;
    self
      .check_profile_limit(ctx, std::slice::from_ref(&key))
      .await?;

    let expires_in = clamp_expires_in(body.field("expiresIn")?);
    let now = time::now_ms();
    let expires_at = iso_at(now as f64 + expires_in * 1000.0);
    let url = self.presigner.put_url(
      require_key(&key)?,
      expires_in,
      metadata.as_deref().unwrap_or(&[]),
      now,
    );

    if ctx.mode == Mode::Cloud && field_starts_with(raw_key, "profiles/")? {
      self.report_profile_usage_async(ctx);
    }
    self.bump_manifest(ctx, key.as_deref());

    let mut out = Map::new();
    out.insert("url".to_string(), Value::String(url));
    out.insert("expiresAt".to_string(), Value::String(expires_at));
    if let Some(metadata) = &metadata {
      out.insert("metadata".to_string(), metadata_json(metadata));
    }
    Ok(Value::Object(out))
  }

  pub async fn presign_download(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let key = self.scope_key(ctx, body.field("key")?);
    self.validate_key_access(ctx, key.as_deref())?;
    self.assert_reachable(ctx, key.as_deref()).await?;
    let expires_in = clamp_expires_in(body.field("expiresIn")?);
    let now = time::now_ms();
    let expires_at = iso_at(now as f64 + expires_in * 1000.0);
    let url = self.presigner.get_url(require_key(&key)?, expires_in, now);
    Ok(json!({ "url": url, "expiresAt": expires_at }))
  }

  pub async fn delete(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let raw_key = body.field("key")?;
    let key = self.scope_key(ctx, raw_key);
    self.validate_write_access(ctx, key.as_deref())?;
    self.assert_group_write(ctx, key.as_deref(), None).await?;
    let raw_tombstone = body.field("tombstoneKey")?;
    let tombstone_key = if raw_tombstone.truthy() {
      self.scope_key(ctx, raw_tombstone)
    } else {
      None
    };
    if raw_tombstone.truthy() {
      self.validate_write_access(ctx, tombstone_key.as_deref())?;
    }

    let deleted = match &key {
      Some(key) => self.store.delete_object(key).await.is_ok(),
      None => false,
    };

    let mut tombstone_created = false;
    if raw_tombstone.truthy() {
      let mut record = Map::new();
      // JSON.stringify drops an `undefined` id.
      match (ctx.mode, raw_key) {
        (Mode::SelfHosted, Field::Value(value)) => {
          record.insert("id".to_string(), value.clone());
        }
        (Mode::SelfHosted, Field::Undefined) => {}
        _ => {
          record.insert(
            "id".to_string(),
            Value::String(key.clone().unwrap_or_default()),
          );
        }
      }
      record.insert("deleted_at".to_string(), or_now(body.field("deletedAt")?));
      self
        .store
        .put_object(
          require_key(&tombstone_key)?,
          Value::Object(record).to_string().into_bytes(),
          "application/json",
        )
        .await
        .map_err(store_error)?;
      tombstone_created = true;
    }

    if ctx.mode == Mode::Cloud && field_starts_with(raw_key, "profiles/")? {
      self.report_profile_usage_async(ctx);
    }
    if deleted || tombstone_created {
      self.bump_manifest(ctx, key.as_deref());
    }
    Ok(json!({ "deleted": deleted, "tombstoneCreated": tombstone_created }))
  }

  pub async fn list(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let prefix = self.scope_key(ctx, body.field("prefix")?);
    // Scope applies to reads too, so a crafted prefix cannot enumerate
    // another tenant's objects.
    self.validate_key_access(ctx, prefix.as_deref())?;
    let max_keys = body.field("maxKeys")?;
    let token = body.field("continuationToken")?;
    let response = self
      .store
      .list_objects_v2(&ListInput {
        prefix,
        max_keys: Some(if max_keys.truthy() {
          max_keys.to_js_string()
        } else {
          "1000".to_string()
        }),
        continuation_token: token.to_key(),
        delimiter: None,
      })
      .await
      .map_err(store_error)?;

    let user_prefix = ctx.prefix.as_str();
    let objects: Vec<Value> = response
      .contents
      .iter()
      .filter(|object| !object.key.ends_with(MANIFEST_KEY))
      .map(|object| {
        let key = if !user_prefix.is_empty() {
          object.key.strip_prefix(user_prefix).unwrap_or(&object.key)
        } else {
          &object.key
        };
        json!({
          "key": key,
          "lastModified": object.last_modified_ms.map(time::iso_from_ms).unwrap_or_default(),
          "size": object.size.unwrap_or(0),
        })
      })
      .collect();
    let objects = self
      .reachable_only(ctx, objects, |object| {
        format!("{user_prefix}{}", object["key"].as_str().unwrap_or(""))
      })
      .await?;

    let mut out = Map::new();
    out.insert("objects".to_string(), Value::Array(objects));
    out.insert(
      "isTruncated".to_string(),
      Value::Bool(response.is_truncated),
    );
    if let Some(token) = response.next_continuation_token {
      out.insert("nextContinuationToken".to_string(), Value::String(token));
    }
    Ok(Value::Object(out))
  }

  pub async fn presign_upload_batch(
    &self,
    body: &Body,
    ctx: &UserContext,
  ) -> Result<Value, ApiError> {
    let items = body
      .field("items")?
      .as_array()
      .filter(|items| items.len() <= MAX_BATCH_ITEMS)
      .ok_or_else(|| {
        ApiError::bad_request(&format!(
          "items must be an array of at most {MAX_BATCH_ITEMS} entries"
        ))
      })?;
    let mut raw_keys = Vec::with_capacity(items.len());
    for item in items {
      if item.is_null() {
        return Err(ApiError::Internal(
          "Cannot read properties of null (reading 'key')".to_string(),
        ));
      }
      raw_keys.push(crate::jsval::field_of(item, "key"));
    }
    let keys: Vec<Option<String>> = raw_keys
      .iter()
      .map(|raw| self.scope_key(ctx, *raw))
      .collect();
    self.check_profile_limit(ctx, &keys).await?;

    let expires_in = clamp_expires_in(body.field("expiresIn")?);
    let now = time::now_ms();
    let expires_at = iso_at(now as f64 + expires_in * 1000.0);

    for key in &keys {
      self.validate_write_access(ctx, key.as_deref())?;
    }
    try_join_all(
      keys
        .iter()
        .map(|key| self.assert_group_write(ctx, key.as_deref(), None)),
    )
    .await?;
    let mut out_items = Vec::with_capacity(keys.len());
    for (raw, key) in raw_keys.iter().zip(&keys) {
      let url = self
        .presigner
        .put_url(require_key(key)?, expires_in, &[], now);
      let mut item = Map::new();
      if let Field::Value(value) = raw {
        item.insert("key".to_string(), (*value).clone());
      }
      item.insert("url".to_string(), Value::String(url));
      item.insert("expiresAt".to_string(), Value::String(expires_at.clone()));
      out_items.push(Value::Object(item));
    }

    if ctx.mode == Mode::Cloud {
      let mut any_profile = false;
      for raw in &raw_keys {
        if field_starts_with(*raw, "profiles/")? {
          any_profile = true;
          break;
        }
      }
      if any_profile {
        self.report_profile_usage_async(ctx);
      }
    }

    let mut scopes_seen = HashSet::new();
    for key in &keys {
      if let Some(scope) = self.scope_for_key(ctx, key.as_deref())
        && scopes_seen.insert(scope.to_string())
      {
        self.bump_manifest(ctx, key.as_deref());
      }
    }
    Ok(json!({ "items": out_items }))
  }

  pub async fn presign_download_batch(
    &self,
    body: &Body,
    ctx: &UserContext,
  ) -> Result<Value, ApiError> {
    let raw_keys = body
      .field("keys")?
      .as_array()
      .filter(|keys| keys.len() <= MAX_BATCH_ITEMS)
      .ok_or_else(|| {
        ApiError::bad_request(&format!(
          "keys must be an array of at most {MAX_BATCH_ITEMS} entries"
        ))
      })?;
    let expires_in = clamp_expires_in(body.field("expiresIn")?);
    let now = time::now_ms();
    let expires_at = iso_at(now as f64 + expires_in * 1000.0);

    let keys: Vec<Option<String>> = raw_keys
      .iter()
      .map(|raw| self.scope_key(ctx, Field::Value(raw)))
      .collect();
    for key in &keys {
      self.validate_key_access(ctx, key.as_deref())?;
    }
    try_join_all(
      keys
        .iter()
        .map(|key| self.assert_reachable(ctx, key.as_deref())),
    )
    .await?;
    let mut items = Vec::with_capacity(keys.len());
    for (raw, key) in raw_keys.iter().zip(&keys) {
      let url = self.presigner.get_url(require_key(key)?, expires_in, now);
      items.push(json!({ "key": raw, "url": url, "expiresAt": expires_at }));
    }
    Ok(json!({ "items": items }))
  }

  pub async fn delete_prefix(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let raw_prefix = body.field("prefix")?;
    let prefix = self.scope_key(ctx, raw_prefix);
    // The highest-blast-radius operation: scope it, and refuse an empty scoped
    // prefix, which would match the whole namespace.
    self.validate_write_access(ctx, prefix.as_deref())?;
    self
      .assert_group_write(ctx, prefix.as_deref(), None)
      .await?;
    if ctx.mode != Mode::SelfHosted && prefix.as_deref().is_some_and(str::is_empty) {
      return Err(ApiError::forbidden("Refusing to delete an empty prefix"));
    }
    let raw_tombstone = body.field("tombstoneKey")?;
    let tombstone_key = if raw_tombstone.truthy() {
      self.scope_key(ctx, raw_tombstone)
    } else {
      None
    };
    if raw_tombstone.truthy() {
      self.validate_write_access(ctx, tombstone_key.as_deref())?;
    }

    let mut deleted_count = 0usize;
    let mut token = None;
    loop {
      let page = self
        .store
        .list_objects_v2(&ListInput {
          prefix: prefix.clone(),
          max_keys: Some("1000".to_string()),
          continuation_token: token.clone(),
          delimiter: None,
        })
        .await
        .map_err(store_error)?;
      let keys: Vec<String> = page.contents.iter().map(|o| o.key.clone()).collect();
      if !keys.is_empty() {
        self
          .store
          .delete_objects(&keys)
          .await
          .map_err(store_error)?;
        deleted_count += keys.len();
      }
      token = page.next_continuation_token;
      if token.is_none() {
        break;
      }
    }

    let mut tombstone_created = false;
    if raw_tombstone.truthy() && deleted_count > 0 {
      let mut record = Map::new();
      if let Field::Value(value) = raw_prefix {
        record.insert("prefix".to_string(), value.clone());
      }
      record.insert("deleted_at".to_string(), or_now(body.field("deletedAt")?));
      record.insert("deleted_count".to_string(), json!(deleted_count));
      self
        .store
        .put_object(
          require_key(&tombstone_key)?,
          Value::Object(record).to_string().into_bytes(),
          "application/json",
        )
        .await
        .map_err(store_error)?;
      tombstone_created = true;
    }

    if ctx.mode == Mode::Cloud && field_starts_with(raw_prefix, "profiles/")? {
      self.report_profile_usage_async(ctx);
    }
    if deleted_count > 0 || tombstone_created {
      self.bump_manifest(ctx, prefix.as_deref());
    }
    Ok(json!({ "deletedCount": deleted_count, "tombstoneCreated": tombstone_created }))
  }

  // --- restore points --------------------------------------------------------

  fn snapshot_root<'a>(&self, raw: Field<'a>) -> Result<&'a str, ApiError> {
    raw
      .as_str()
      .filter(|root| PROFILE_ROOT.is_match(root))
      .ok_or_else(|| ApiError::bad_request_body(json!({ "code": "SNAPSHOT_INVALID" })))
  }

  fn snapshot_id<'a>(&self, raw: Field<'a>) -> Result<&'a str, ApiError> {
    raw
      .as_str()
      .filter(|id| SNAPSHOT_ID.is_match(id))
      .ok_or_else(|| ApiError::bad_request_body(json!({ "code": "SNAPSHOT_INVALID" })))
  }

  /// Every object under `prefix`, with its size.
  async fn list_all(&self, prefix: &str) -> Result<Vec<(String, u64)>, ApiError> {
    let mut out = Vec::new();
    let mut token = None;
    loop {
      let page = self
        .store
        .list_objects_v2(&ListInput {
          prefix: Some(prefix.to_string()),
          max_keys: None,
          continuation_token: token.clone(),
          delimiter: None,
        })
        .await
        .map_err(store_error)?;
      out.extend(
        page
          .contents
          .into_iter()
          .map(|object| (object.key, object.size.unwrap_or(0))),
      );
      token = page.next_continuation_token;
      if token.is_none() {
        return Ok(out);
      }
    }
  }

  async fn copy_all(&self, pairs: Vec<(String, String)>) -> Result<(), ApiError> {
    for chunk in pairs.chunks(COPY_CONCURRENCY) {
      try_join_all(
        chunk
          .iter()
          .map(|(from, to)| self.store.copy_object(from, to)),
      )
      .await
      .map_err(store_error)?;
    }
    Ok(())
  }

  async fn delete_all(&self, keys: &[String]) -> Result<(), ApiError> {
    for chunk in keys.chunks(1000) {
      self
        .store
        .delete_objects(chunk)
        .await
        .map_err(store_error)?;
    }
    Ok(())
  }

  async fn read_snapshot(&self, key: &str) -> Option<Value> {
    let text = self.store.get_object_text(key).await.ok()?;
    if text.is_empty() {
      return None;
    }
    serde_json::from_str(&text).ok()
  }

  pub async fn list_snapshots(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let root = self.snapshot_root(body.field("profileRoot")?)?.to_string();
    Ok(json!({ "snapshots": self.snapshots_of(ctx, &root).await? }))
  }

  async fn snapshots_of(&self, ctx: &UserContext, root: &str) -> Result<Vec<Value>, ApiError> {
    let base = self.scope_str(ctx, &format!("snapshots/{root}"));
    self.validate_key_access(ctx, Some(&base))?;
    let manifest = self.scope_str(ctx, &format!("{root}manifest.json"));
    self.assert_reachable(ctx, Some(&manifest)).await?;
    let records: Vec<String> = self
      .list_all(&base)
      .await?
      .into_iter()
      .map(|(key, _)| key)
      .filter(|key| key.ends_with("/snapshot.json"))
      .collect();
    let read =
      futures_util::future::join_all(records.iter().map(|key| self.read_snapshot(key))).await;
    let mut snapshots: Vec<Value> = read.into_iter().flatten().collect();
    if snapshots.len() > 1 && snapshots.iter().any(|s| !s["id"].is_string()) {
      return Err(ApiError::Internal(
        "A restore point record has no id".to_string(),
      ));
    }
    snapshots.sort_by(|a, b| {
      b["id"]
        .as_str()
        .unwrap_or("")
        .cmp(a["id"].as_str().unwrap_or(""))
    });
    Ok(snapshots)
  }

  /// Copies a profile's files and manifest into a new restore point, inside
  /// the store, and keeps the newest few of each kind.
  pub async fn create_snapshot(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let root = self.snapshot_root(body.field("profileRoot")?)?.to_string();
    let kind = if body.field("kind")?.as_str() == Some("auto") {
      "auto"
    } else {
      "manual"
    };
    let live = self.scope_str(ctx, &root);
    let base = self.scope_str(ctx, &format!("snapshots/{root}"));
    self.validate_write_access(ctx, Some(&base))?;
    self.assert_group_write(ctx, Some(&live), None).await?;
    let objects: Vec<(String, u64)> = self
      .list_all(&live)
      .await?
      .into_iter()
      .filter(|(key, _)| {
        let relative = &key[live.len().min(key.len())..];
        relative == "manifest.json" || relative.starts_with("files/")
      })
      .collect();
    let manifest = format!("{live}manifest.json");
    if !objects.iter().any(|(key, _)| *key == manifest) {
      return Err(ApiError::bad_request_body(
        json!({ "code": "SNAPSHOT_NOTHING_TO_KEEP" }),
      ));
    }
    let now = time::now_ms();
    let id = format!(
      "{}-{}",
      time::compact_stamp(now),
      &uuid::Uuid::new_v4().simple().to_string()[..4]
    );
    let target = format!("{base}{id}/");
    self
      .copy_all(
        objects
          .iter()
          .map(|(key, _)| (key.clone(), format!("{target}{}", &key[live.len()..])))
          .collect(),
      )
      .await?;
    let files = objects.len() - 1;
    let bytes: u64 = objects.iter().map(|(_, size)| size).sum();
    let snapshot = json!({
      "id": id,
      "createdAt": time::iso_from_ms(now),
      "kind": kind,
      "files": files,
      "bytes": bytes,
    });
    self
      .store
      .put_object(
        &format!("{target}snapshot.json"),
        snapshot.to_string().into_bytes(),
        "application/json",
      )
      .await
      .map_err(store_error)?;
    self.prune_snapshots(ctx, &root, kind).await?;
    log::log(
      CONTEXT,
      &format!("Snapshot created kind={kind} files={files} bytes={bytes}"),
    );
    Ok(snapshot)
  }

  async fn prune_snapshots(
    &self,
    ctx: &UserContext,
    root: &str,
    kind: &str,
  ) -> Result<(), ApiError> {
    let snapshots = self.snapshots_of(ctx, root).await?;
    let old: Vec<String> = snapshots
      .iter()
      .filter(|s| s["kind"].as_str() == Some(kind))
      .skip(SNAPSHOTS_PER_KIND)
      .filter_map(|s| s["id"].as_str().map(str::to_string))
      .collect();
    for id in old {
      self.remove_snapshot(ctx, root, &id).await?;
    }
    Ok(())
  }

  async fn remove_snapshot(&self, ctx: &UserContext, root: &str, id: &str) -> Result<(), ApiError> {
    let prefix = self.scope_str(ctx, &format!("snapshots/{root}{id}/"));
    let keys: Vec<String> = self
      .list_all(&prefix)
      .await?
      .into_iter()
      .map(|(key, _)| key)
      .collect();
    self.delete_all(&keys).await
  }

  pub async fn delete_snapshot(&self, body: &Body, ctx: &UserContext) -> Result<Value, ApiError> {
    let root = self.snapshot_root(body.field("profileRoot")?)?.to_string();
    let id = self.snapshot_id(body.field("id")?)?.to_string();
    let base = self.scope_str(ctx, &format!("snapshots/{root}"));
    self.validate_write_access(ctx, Some(&base))?;
    let live = self.scope_str(ctx, &root);
    self.assert_group_write(ctx, Some(&live), None).await?;
    self.remove_snapshot(ctx, &root, &id).await?;
    Ok(json!({ "deleted": true }))
  }

  /// Puts a restore point's files back in place of the live ones. The
  /// manifest is the app's to write: it may be sealed, and the app must stamp
  /// it as the newest so every device takes the restored files.
  pub async fn restore_snapshot_files(
    &self,
    body: &Body,
    ctx: &UserContext,
  ) -> Result<Value, ApiError> {
    let root = self.snapshot_root(body.field("profileRoot")?)?.to_string();
    let id = self.snapshot_id(body.field("id")?)?.to_string();
    let live = self.scope_str(ctx, &root);
    let source = self.scope_str(ctx, &format!("snapshots/{root}{id}/"));
    self.validate_write_access(ctx, Some(&source))?;
    self.assert_group_write(ctx, Some(&live), None).await?;
    let kept: Vec<String> = self
      .list_all(&format!("{source}files/"))
      .await?
      .into_iter()
      .map(|(key, _)| key[source.len()..].to_string())
      .collect();
    if kept.is_empty()
      && !self
        .read_snapshot(&format!("{source}snapshot.json"))
        .await
        .is_some_and(|v| crate::jsval::truthy(&v))
    {
      return Err(ApiError::not_found_body(
        json!({ "code": "SNAPSHOT_NOT_FOUND" }),
      ));
    }
    let kept_set: HashSet<&str> = kept.iter().map(String::as_str).collect();
    let stale: Vec<String> = self
      .list_all(&format!("{live}files/"))
      .await?
      .into_iter()
      .map(|(key, _)| key)
      .filter(|key| !kept_set.contains(&key[live.len()..]))
      .collect();
    self
      .copy_all(
        kept
          .iter()
          .map(|relative| (format!("{source}{relative}"), format!("{live}{relative}")))
          .collect(),
      )
      .await?;
    self.delete_all(&stale).await?;
    self.bump_manifest(ctx, Some(&format!("{live}manifest.json")));
    log::log(
      CONTEXT,
      &format!(
        "Snapshot restored restored={} removed={}",
        kept.len(),
        stale.len()
      ),
    );
    Ok(json!({ "restored": kept.len(), "removed": stale.len() }))
  }

  // --- the backend's cleanup -------------------------------------------------

  pub async fn cleanup_excess_profiles(
    &self,
    user_id: &str,
    max_profiles: usize,
  ) -> Result<Value, ApiError> {
    let user_prefix = format!("users/{user_id}/");
    let profile_prefix = format!("{user_prefix}profiles/");

    let mut profiles: Vec<(String, i64)> = Vec::new();
    let mut token = None;
    loop {
      let page = self
        .store
        .list_objects_v2(&ListInput {
          prefix: Some(profile_prefix.clone()),
          max_keys: Some("1000".to_string()),
          continuation_token: token.clone(),
          delimiter: Some("/".to_string()),
        })
        .await
        .map_err(store_error)?;
      for common in &page.common_prefixes {
        let id = common
          .replacen(&profile_prefix, "", 1)
          .strip_suffix('/')
          .map(str::to_string)
          .unwrap_or_else(|| common.replacen(&profile_prefix, "", 1));
        // The profile's age is its first object's.
        let first = self
          .store
          .list_objects_v2(&ListInput {
            prefix: Some(common.clone()),
            max_keys: Some("1".to_string()),
            continuation_token: None,
            delimiter: None,
          })
          .await
          .map_err(store_error)?;
        let last_modified = first
          .contents
          .first()
          .and_then(|o| o.last_modified_ms)
          .unwrap_or(0);
        profiles.push((id, last_modified));
      }
      token = page.next_continuation_token;
      if token.is_none() {
        break;
      }
    }

    if profiles.len() <= max_profiles {
      return Ok(json!({ "deletedProfiles": [], "remaining": profiles.len() }));
    }

    // Newest first: the newest excess profiles go.
    profiles.sort_by_key(|profile| std::cmp::Reverse(profile.1));
    let excess = profiles.len() - max_profiles;
    let mut deleted = Vec::new();
    for (id, _) in profiles.iter().take(excess) {
      let prefix = format!("{profile_prefix}{id}/");
      let mut token = None;
      loop {
        let page = self
          .store
          .list_objects_v2(&ListInput {
            prefix: Some(prefix.clone()),
            max_keys: Some("1000".to_string()),
            continuation_token: token.clone(),
            delimiter: None,
          })
          .await
          .map_err(store_error)?;
        let keys: Vec<String> = page.contents.iter().map(|o| o.key.clone()).collect();
        if !keys.is_empty() {
          self
            .store
            .delete_objects(&keys)
            .await
            .map_err(store_error)?;
        }
        token = page.next_continuation_token;
        if token.is_none() {
          break;
        }
      }
      let record = json!({
        "prefix": format!("profiles/{id}/"),
        "deleted_at": time::iso_from_ms(time::now_ms()),
        "reason": "excess_profile_cleanup",
      });
      self
        .store
        .put_object(
          &format!("{user_prefix}tombstones/profiles/{id}"),
          record.to_string().into_bytes(),
          "application/json",
        )
        .await
        .map_err(store_error)?;
      deleted.push(id.clone());
      log::log(
        CONTEXT,
        &format!("Cleaned up excess profile {id} for user {user_id}"),
      );
    }

    let remaining = profiles.len() - deleted.len();
    match &self.backend {
      Some(backend) => {
        if let Err(e) = backend.report_profile_usage(user_id, remaining).await {
          log::warn(
            CONTEXT,
            &format!("Failed to report usage after cleanup: {e}"),
          );
        }
      }
      None => log::warn(
        CONTEXT,
        "Failed to report usage after cleanup: BACKEND_INTERNAL_URL is not set",
      ),
    }
    Ok(json!({ "deletedProfiles": deleted, "remaining": remaining }))
  }

  // --- the plan's profile limit ----------------------------------------------

  /// Refuses writes that would store more profiles than the plan allows. Only
  /// a new profile counts: a stored profile keeps syncing at the limit, and
  /// settings never count. Over the limit (after a downgrade), nothing under
  /// `profiles/` is written until profiles are removed.
  async fn check_profile_limit(
    &self,
    ctx: &UserContext,
    keys: &[Option<String>],
  ) -> Result<(), ApiError> {
    if ctx.mode != Mode::Cloud || ctx.profile_limit <= 0.0 || ctx.profile_limit.is_nan() {
      return Ok(());
    }
    let mut written = HashSet::new();
    for key in keys.iter().flatten() {
      if let Some(found) = COUNTED_PROFILE_KEY.captures(self.relative(ctx, key)) {
        written.insert(found[1].to_string());
      }
    }
    if written.is_empty() {
      return Ok(());
    }
    let stored = self.stored_profile_ids(ctx).await?;
    let total = stored.len() + written.iter().filter(|id| !stored.contains(*id)).count();
    if total as f64 > ctx.profile_limit {
      return Err(ApiError::forbidden(&format!(
        "Profile limit reached ({}). Upgrade your plan for more profiles.",
        crate::jsval::js_number(ctx.profile_limit)
      )));
    }
    Ok(())
  }

  async fn stored_profile_ids(&self, ctx: &UserContext) -> Result<HashSet<String>, ApiError> {
    stored_profile_ids(self.store.as_ref(), &ctx.prefix).await
  }

  /// Counts the namespace's profiles and reports them, in the background. The
  /// count is for the effective namespace: the team account, for a team.
  fn report_profile_usage_async(&self, ctx: &UserContext) {
    let Some(backend) = self.backend.clone() else {
      return;
    };
    let Some(user_id) = ctx
      .prefix
      .strip_prefix("users/")
      .and_then(|rest| rest.strip_suffix('/'))
      .filter(|id| !id.is_empty() && !id.contains('/'))
      .map(str::to_string)
    else {
      return;
    };
    let store = self.store.clone();
    let prefix = ctx.prefix.clone();
    tokio::spawn(async move {
      let outcome = match stored_profile_ids(store.as_ref(), &prefix).await {
        Ok(ids) => backend.report_profile_usage(&user_id, ids.len()).await,
        Err(e) => Err(e.describe()),
      };
      if let Err(e) = outcome {
        log::warn(CONTEXT, &format!("Failed to report profile usage: {e}"));
      }
    });
  }
}

async fn stored_profile_ids(store: &dyn Store, prefix: &str) -> Result<HashSet<String>, ApiError> {
  let profile_prefix = format!("{prefix}profiles/");
  let mut ids = HashSet::new();
  let mut token = None;
  loop {
    let page = store
      .list_objects_v2(&ListInput {
        prefix: Some(profile_prefix.clone()),
        max_keys: Some("1000".to_string()),
        continuation_token: token.clone(),
        delimiter: Some("/".to_string()),
      })
      .await
      .map_err(store_error)?;
    for common in page.common_prefixes {
      if let Some(id) = common
        .strip_prefix(&profile_prefix)
        .and_then(|rest| rest.strip_suffix('/'))
        .filter(|id| !id.is_empty())
      {
        ids.insert(id.to_string());
      }
    }
    token = page.next_continuation_token;
    if token.is_none() {
      return Ok(ids);
    }
  }
}

/// `value || new Date().toISOString()`.
fn or_now(field: Field) -> Value {
  match field {
    Field::Value(value) if crate::jsval::truthy(value) => value.clone(),
    _ => Value::String(time::iso_from_ms(time::now_ms())),
  }
}

fn stat_json(head: &HeadOutput) -> Value {
  let mut out = Map::new();
  out.insert("exists".to_string(), Value::Bool(true));
  if let Some(ms) = head.last_modified_ms {
    out.insert(
      "lastModified".to_string(),
      Value::String(time::iso_from_ms(ms)),
    );
  }
  if let Some(size) = head.content_length {
    out.insert("size".to_string(), json!(size));
  }
  // User metadata, lowercased, without `x-amz-meta-`: clients read
  // `updated-at` here to resolve conflicts without downloading the body.
  out.insert("metadata".to_string(), metadata_json(&head.metadata));
  Value::Object(out)
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
