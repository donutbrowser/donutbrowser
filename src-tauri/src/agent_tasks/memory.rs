//! What the agent knows about each profile: short notes it wrote at the end of
//! its answers, or the person wrote, and whether it may read the profile's
//! history. Device only: one file per profile, sealed with this installation's
//! vault key, never synced and never sent anywhere except inside the prompt of
//! a task in the same profile.

use super::prompt::MAX_NOTE_CHARS;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const HEADER: &[u8; 5] = b"DBMEM";
/// Notes kept per profile; the oldest go first.
const MAX_NOTES: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
  pub id: String,
  pub text: String,
  /// Unix milliseconds of the last change.
  pub at: u64,
  /// The agent wrote it; else the person did.
  #[serde(default)]
  pub learnt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMemory {
  /// Newest first.
  #[serde(default)]
  pub notes: Vec<Note>,
  #[serde(default = "on")]
  pub use_history: bool,
}

fn on() -> bool {
  true
}

impl Default for ProfileMemory {
  fn default() -> Self {
    Self {
      notes: Vec::new(),
      use_history: true,
    }
  }
}

fn same(a: &str, b: &str) -> bool {
  a.trim().to_lowercase() == b.trim().to_lowercase()
}

impl ProfileMemory {
  /// Add facts not already known, newest first. Returns how many.
  pub fn absorb(&mut self, facts: &[String], now: u64) -> usize {
    let mut added = 0;
    for fact in facts {
      let text: String = fact.trim().chars().take(MAX_NOTE_CHARS).collect();
      if text.is_empty() || self.notes.iter().any(|note| same(&note.text, &text)) {
        continue;
      }
      self.notes.insert(
        0,
        Note {
          id: uuid::Uuid::new_v4().to_string(),
          text,
          at: now,
          learnt: true,
        },
      );
      added += 1;
    }
    self.notes.truncate(MAX_NOTES);
    added
  }

  /// Write a note: a new one with no `id`, else the one named.
  fn put(&mut self, id: Option<&str>, text: &str, now: u64) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
      return Err(crate::backend_error("AGENT_NOTE_EMPTY"));
    }
    if text.chars().count() > MAX_NOTE_CHARS {
      return Err(
        serde_json::json!({ "code": "AGENT_TEXT_TOO_LONG", "params": { "max": MAX_NOTE_CHARS.to_string() } })
          .to_string(),
      );
    }
    match id {
      Some(id) => {
        let index = self
          .notes
          .iter()
          .position(|note| note.id == id)
          .ok_or_else(|| crate::backend_error("AGENT_NOTE_NOT_FOUND"))?;
        let mut note = self.notes.remove(index);
        note.text = text.to_string();
        note.at = now;
        note.learnt = false;
        self.notes.insert(0, note);
      }
      None => {
        if self.notes.iter().any(|note| same(&note.text, text)) {
          return Ok(());
        }
        self.notes.insert(
          0,
          Note {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.to_string(),
            at: now,
            learnt: false,
          },
        );
        self.notes.truncate(MAX_NOTES);
      }
    }
    Ok(())
  }
}

fn magic() -> [u8; 6] {
  let mut magic = [0u8; 6];
  magic[..5].copy_from_slice(HEADER);
  magic[5] = 1;
  magic
}

fn file_for(profile_id: &str) -> Result<std::path::PathBuf, String> {
  // A UUID, so a crafted id never names a path outside the folder.
  let id =
    uuid::Uuid::parse_str(profile_id).map_err(|_| crate::backend_error("INVALID_PROFILE_ID"))?;
  Ok(
    crate::app_dirs::data_subdir()
      .join("agent_memory")
      .join(format!("{id}.dat")),
  )
}

/// One change at a time, so a note the agent adds never undoes one the
/// person made a moment before.
static WRITES: Mutex<()> = Mutex::new(());

pub fn read(profile_id: &str) -> Result<ProfileMemory, String> {
  match crate::vault::open(&file_for(profile_id)?, &magic())? {
    None => Ok(ProfileMemory::default()),
    Some(json) => serde_json::from_str(&json)
      .map_err(|e| crate::backend_error_with_detail("AGENT_MEMORY_UNREADABLE", e)),
  }
}

fn write(profile_id: &str, memory: &ProfileMemory) -> Result<(), String> {
  let file = file_for(profile_id)?;
  if memory == &ProfileMemory::default() {
    return match std::fs::remove_file(&file) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(crate::backend_error_with_detail(
        "AGENT_MEMORY_UNREADABLE",
        e,
      )),
    };
  }
  let json = serde_json::to_string(memory).map_err(|e| e.to_string())?;
  crate::vault::seal(&file, &magic(), &json)?;
  crate::app_dirs::restrict_to_owner(&file);
  Ok(())
}

fn change(
  profile_id: &str,
  edit: impl FnOnce(&mut ProfileMemory) -> Result<(), String>,
) -> Result<ProfileMemory, String> {
  let _guard = WRITES.lock().unwrap_or_else(|p| p.into_inner());
  let mut memory = read(profile_id)?;
  edit(&mut memory)?;
  write(profile_id, &memory)?;
  Ok(memory)
}

/// Facts from an answer in the profile. Runs off the async workers: sealing
/// derives a key.
pub fn learn(profile_id: &str, facts: Vec<String>) {
  if facts.is_empty() {
    return;
  }
  let profile_id = profile_id.to_string();
  tokio::task::spawn_blocking(move || {
    let mut added = 0;
    let outcome = change(&profile_id, |memory| {
      added = memory.absorb(&facts, super::now_ms());
      Ok(())
    });
    match outcome {
      Ok(_) if added > 0 => {
        log::info!("Agent memory learnt profile={profile_id} notes={added}");
        let _ = crate::events::emit(
          "agent-memory-changed",
          serde_json::json!({ "profileId": profile_id }),
        );
      }
      Ok(_) => {}
      Err(e) => log::warn!(
        "Agent memory not saved profile={profile_id} err={}",
        super::error_code(&e)
      ),
    }
  });
}

/// With the profile itself: what the agent knew about it goes too.
pub fn forget_profile(profile_id: &str) {
  if let Ok(file) = file_for(profile_id) {
    match std::fs::remove_file(&file) {
      Ok(()) => log::info!("Agent memory erased profile={profile_id}"),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => log::warn!("Agent memory not erased profile={profile_id} err=\"{e}\""),
    }
  }
}

fn ensure_profile(profile_id: &str) -> Result<crate::profile::BrowserProfile, String> {
  super::load_profile(profile_id)
}

#[tauri::command]
pub async fn get_agent_profile_memory(profile_id: String) -> Result<ProfileMemory, String> {
  super::ensure_entitled().await?;
  ensure_profile(&profile_id)?;
  tokio::task::spawn_blocking(move || read(&profile_id))
    .await
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
}

async fn changed_by_person(
  profile_id: String,
  edit: impl FnOnce(&mut ProfileMemory) -> Result<(), String> + Send + 'static,
) -> Result<ProfileMemory, String> {
  super::ensure_entitled().await?;
  ensure_profile(&profile_id)?;
  tokio::task::spawn_blocking(move || change(&profile_id, edit))
    .await
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?
}

#[tauri::command]
pub async fn save_agent_memory_note(
  profile_id: String,
  note_id: Option<String>,
  text: String,
) -> Result<ProfileMemory, String> {
  changed_by_person(profile_id, move |memory| {
    memory.put(note_id.as_deref(), &text, super::now_ms())
  })
  .await
}

#[tauri::command]
pub async fn delete_agent_memory_note(
  profile_id: String,
  note_id: String,
) -> Result<ProfileMemory, String> {
  changed_by_person(profile_id, move |memory| {
    let before = memory.notes.len();
    memory.notes.retain(|note| note.id != note_id);
    if memory.notes.len() == before {
      return Err(crate::backend_error("AGENT_NOTE_NOT_FOUND"));
    }
    Ok(())
  })
  .await
}

#[tauri::command]
pub async fn set_agent_history_use(
  profile_id: String,
  enabled: bool,
) -> Result<ProfileMemory, String> {
  changed_by_person(profile_id, move |memory| {
    memory.use_history = enabled;
    Ok(())
  })
  .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteView {
  host: String,
  visits: u64,
}

/// The sites a task in the profile is told about, for the person to see.
#[tauri::command]
pub async fn get_agent_profile_sites(profile_id: String) -> Result<Vec<SiteView>, String> {
  super::ensure_entitled().await?;
  let profile = ensure_profile(&profile_id)?;
  let sites = tokio::task::spawn_blocking(move || super::history::recent_sites(&profile))
    .await
    .map_err(|e| crate::backend_error_with_detail("INTERNAL_ERROR", e))?;
  Ok(
    sites
      .into_iter()
      .map(|site| SiteView {
        host: site.host,
        visits: site.visits,
      })
      .collect(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn facts_are_added_once_newest_first_and_capped() {
    let mut memory = ProfileMemory::default();
    assert!(memory.use_history, "history is on until switched off");
    assert_eq!(
      memory.absorb(&["Uses the EU store".into(), " ".into()], 1),
      1
    );
    assert_eq!(
      memory.absorb(&["uses the eu store ".into(), "Window seats".into()], 2),
      1,
      "a fact known in other case is not added again"
    );
    assert_eq!(memory.notes[0].text, "Window seats");
    assert!(memory.notes[0].learnt);
    let many: Vec<String> = (0..80).map(|i| format!("fact {i}")).collect();
    memory.absorb(&many, 3);
    assert_eq!(memory.notes.len(), MAX_NOTES);
    assert_eq!(memory.notes[0].text, "fact 79");
  }

  #[test]
  fn the_person_writes_edits_and_bounds_notes() {
    let mut memory = ProfileMemory::default();
    memory.put(None, " Ships to Tirana ", 1).unwrap();
    memory.put(None, "ships to tirana", 2).unwrap();
    assert_eq!(memory.notes.len(), 1);
    assert!(!memory.notes[0].learnt);
    let id = memory.notes[0].id.clone();
    memory.absorb(&["Newer fact".into()], 3);
    memory.put(Some(&id), "Ships to Durrës", 4).unwrap();
    assert_eq!(memory.notes[0].text, "Ships to Durrës", "an edit is newest");
    assert!(memory
      .put(Some("missing"), "x", 5)
      .unwrap_err()
      .contains("AGENT_NOTE_NOT_FOUND"));
    assert!(memory
      .put(None, "  ", 5)
      .unwrap_err()
      .contains("AGENT_NOTE_EMPTY"));
    assert!(memory
      .put(None, &"x".repeat(MAX_NOTE_CHARS + 1), 5)
      .unwrap_err()
      .contains("AGENT_TEXT_TOO_LONG"));
  }

  #[test]
  fn an_old_file_without_the_switch_reads_with_history_on() {
    let memory: ProfileMemory =
      serde_json::from_str(r#"{"notes":[{"id":"a","text":"x","at":1}]}"#).unwrap();
    assert!(memory.use_history);
    assert!(!memory.notes[0].learnt);
  }

  #[test]
  fn a_profile_id_never_names_another_path() {
    assert!(file_for("../x").unwrap_err().contains("INVALID_PROFILE_ID"));
  }
}
