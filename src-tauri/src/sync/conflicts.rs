//! A download that replaces a local edit this device never uploaded.
//!
//! Sync keeps the newer copy by `updated_at`. That is right, but when the
//! local copy was edited after its last sync and the remote copy is newer
//! still, the local edit is gone, and the person should hear about it.

/// The local copy changed after its last sync, and the remote copy replacing
/// it is newer than that change. A copy never synced from this device has no
/// unsent edit to lose.
pub(super) fn replaces_unsent_edit(
  local_updated_at: u64,
  last_sync: Option<u64>,
  remote_updated_at: u64,
) -> bool {
  let Some(last_sync) = last_sync else {
    return false;
  };
  local_updated_at > last_sync && remote_updated_at > local_updated_at
}

/// Tell the app, when this download replaces an unsent edit. Called just
/// before the download, with what the reconcile compared.
pub(super) fn note_download(
  read_only: bool,
  entity: &str,
  id: &str,
  name: Option<impl AsRef<str>>,
  local_updated_at: u64,
  last_sync: Option<u64>,
  remote_updated_at: u64,
) {
  // A launcher seat never keeps a local edit: there is no choice to report.
  if read_only || !replaces_unsent_edit(local_updated_at, last_sync, remote_updated_at) {
    return;
  }
  log::info!(
    "Sync conflict, newer remote copy kept entity={entity} id={id} local_updated_at={local_updated_at} remote_updated_at={remote_updated_at}"
  );
  let payload = serde_json::json!({
    "entity": entity,
    "id": id,
    "name": name.as_ref().map(|name| name.as_ref()),
    "kept": "remote",
    "at": crate::proxy_manager::now_secs(),
  });
  if let Err(e) = crate::events::emit("sync-conflict", payload) {
    log::warn!("Event emit failed event=sync-conflict err=\"{e}\"");
  }
}

/// `last_sync` for a copy just downloaded: never behind the copy's own edit
/// time. A clock ahead on the other device would otherwise leave
/// `updated_at > last_sync`, and the next download would look like it
/// replaced an unsent edit.
pub(super) fn synced_at(updated_at: Option<u64>) -> u64 {
  crate::proxy_manager::now_secs().max(updated_at.unwrap_or(0))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_newer_remote_over_an_unsent_edit_is_a_conflict() {
    // Synced at 100, edited here at 150, edited elsewhere at 200.
    assert!(replaces_unsent_edit(150, Some(100), 200));
  }

  #[test]
  fn a_newer_remote_over_a_synced_copy_is_not() {
    // Nothing changed here since the last sync.
    assert!(!replaces_unsent_edit(90, Some(100), 200));
    assert!(!replaces_unsent_edit(100, Some(100), 200));
  }

  #[test]
  fn an_older_remote_never_replaces_anything() {
    assert!(!replaces_unsent_edit(150, Some(100), 120));
    assert!(!replaces_unsent_edit(150, Some(100), 150));
  }

  #[test]
  fn a_copy_never_synced_here_has_no_unsent_edit() {
    assert!(!replaces_unsent_edit(150, None, 200));
  }

  #[test]
  fn a_download_from_a_clock_ahead_does_not_look_like_an_edit_later() {
    let ahead = crate::proxy_manager::now_secs() + 600;
    let last_sync = synced_at(Some(ahead));
    assert!(last_sync >= ahead);
    assert!(!replaces_unsent_edit(ahead, Some(last_sync), ahead + 10));
  }
}
