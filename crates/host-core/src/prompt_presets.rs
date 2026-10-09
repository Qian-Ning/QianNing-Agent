//! Saved prompt shelf.
//!
//! A reusable library of prompt *source text*: the user names the text they are
//! editing in a conversation's prompt editor and can later pick a saved prompt
//! to fill that editor — in the same conversation or in a new one.
//!
//! This is deliberately NOT a second persona scope. The shelf only stores text;
//! the persona a model receives is still exactly the conversation's own
//! `sessions.system_prompt` (ADR 0310). Applying a saved prompt copies its text
//! into one conversation's editor draft; nothing is auto-applied to any
//! conversation, and saving here never edits a session row.
//!
//! Storage reuses the existing key-value store rather than a new table: the
//! whole shelf is one JSON array under namespace `prompt_presets`, key `items`.
//! That keeps the schema version unchanged (no migration).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::db::{now_ms, Database};
use crate::sessions::MAX_SESSION_SYSTEM_PROMPT_CHARS;

/// Key-value namespace and key that hold the whole shelf as a JSON array.
pub const PROMPT_PRESETS_NS: &str = "prompt_presets";
pub const PROMPT_PRESETS_KEY: &str = "items";

/// Longest accepted preset name, in Unicode scalar values.
pub const MAX_PROMPT_PRESET_NAME_CHARS: usize = 80;

/// Upper bound on the serialized shelf blob, so one runaway text cannot grow
/// the key-value row without limit. Named in the error when it is exceeded.
pub const MAX_PROMPT_PRESETS_BLOB_BYTES: usize = 1_000_000;

/// One saved prompt. `text` is source text only; it is never applied to a
/// conversation without the user choosing to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptPreset {
    pub id: String,
    pub name: String,
    pub text: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
}

/// Read the whole shelf, newest first (`createdAtMs` descending; ties broken by
/// `id` so the order is stable across reads). A missing or malformed store reads
/// as empty rather than failing, so a bad row cannot lock the UI out.
pub fn list(db: &Database) -> Result<Vec<PromptPreset>> {
    let mut items = load(db)?;
    items.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(items)
}

/// Save one prompt under a name. The name is trimmed and must be non-empty and
/// at most [`MAX_PROMPT_PRESET_NAME_CHARS`] characters; the text is trimmed and
/// must be non-empty and at most [`MAX_SESSION_SYSTEM_PROMPT_CHARS`] characters
/// (the same bound a conversation prompt carries). A name already on the shelf
/// is refused case-insensitively. Returns the stored row.
pub fn save(db: &Database, name: &str, text: &str) -> Result<PromptPreset> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("prompt preset name must not be empty"));
    }
    if name.chars().count() > MAX_PROMPT_PRESET_NAME_CHARS {
        return Err(anyhow!(
            "prompt preset name exceeds {MAX_PROMPT_PRESET_NAME_CHARS} characters"
        ));
    }
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("prompt preset text must not be empty"));
    }
    if text.chars().count() > MAX_SESSION_SYSTEM_PROMPT_CHARS {
        return Err(anyhow!(
            "prompt preset text exceeds {MAX_SESSION_SYSTEM_PROMPT_CHARS} characters"
        ));
    }

    let mut items = load(db)?;
    // Duplicate names are refused case-insensitively so "Reviewer" and
    // "reviewer" do not silently become two rows the user cannot tell apart.
    if let Some(existing) = items
        .iter()
        .find(|item| item.name.eq_ignore_ascii_case(name))
    {
        return Err(anyhow!(
            "a prompt preset named \"{}\" already exists",
            existing.name
        ));
    }

    let preset = PromptPreset {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        text: text.to_string(),
        created_at_ms: now_ms(),
    };
    items.push(preset.clone());
    store(db, &items)?;
    Ok(preset)
}

/// Delete one preset by id. Returns true when a row was removed.
pub fn delete(db: &Database, id: &str) -> Result<bool> {
    let mut items = load(db)?;
    let before = items.len();
    items.retain(|item| item.id != id);
    if items.len() == before {
        return Ok(false);
    }
    store(db, &items)?;
    Ok(true)
}

/// Load the array, tolerating a missing key (empty shelf).
fn load(db: &Database) -> Result<Vec<PromptPreset>> {
    let Some(value) = db.kv_get(PROMPT_PRESETS_NS, PROMPT_PRESETS_KEY)? else {
        return Ok(Vec::new());
    };
    // A store we cannot parse reads as empty rather than erroring: the shelf is
    // convenience data, and failing here would break the whole dialog.
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// Serialize and persist the shelf, enforcing the blob bound.
fn store(db: &Database, items: &[PromptPreset]) -> Result<()> {
    let value = json!(items);
    let blob = value.to_string();
    if blob.len() > MAX_PROMPT_PRESETS_BLOB_BYTES {
        return Err(anyhow!(
            "saved prompts exceed the {MAX_PROMPT_PRESETS_BLOB_BYTES}-byte storage limit"
        ));
    }
    db.kv_set(PROMPT_PRESETS_NS, PROMPT_PRESETS_KEY, &value)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn prompt_preset_round_trips_and_deletes() {
        let db = test_db();
        assert!(list(&db).unwrap().is_empty());

        let saved = save(&db, "  Reviewer  ", "  You are a terse reviewer.  ").unwrap();
        assert_eq!(saved.name, "Reviewer");
        assert_eq!(saved.text, "You are a terse reviewer.");
        assert!(!saved.id.is_empty());

        let listed = list(&db).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, saved.id);
        assert_eq!(listed[0].text, "You are a terse reviewer.");

        assert!(delete(&db, &saved.id).unwrap());
        assert!(list(&db).unwrap().is_empty());
        // Deleting a row that is not there is not an error, it just reports false.
        assert!(!delete(&db, &saved.id).unwrap());
    }

    #[test]
    fn prompt_preset_refuses_duplicate_names_case_insensitively() {
        let db = test_db();
        save(&db, "Reviewer", "one").unwrap();
        let err = save(&db, "reviewer", "two").unwrap_err();
        // The refusal names the stored preset so the user can tell which it is.
        assert!(err.to_string().contains("Reviewer"));
        assert_eq!(list(&db).unwrap().len(), 1);
    }

    #[test]
    fn prompt_preset_refuses_blank_and_oversize_input() {
        let db = test_db();
        assert!(save(&db, "   ", "text").is_err());
        assert!(save(&db, "name", "   ").is_err());
        let long_name = "n".repeat(MAX_PROMPT_PRESET_NAME_CHARS + 1);
        assert!(save(&db, &long_name, "text").is_err());
        let long_text = "x".repeat(MAX_SESSION_SYSTEM_PROMPT_CHARS + 1);
        assert!(save(&db, "name", &long_text).is_err());
        assert!(list(&db).unwrap().is_empty());
    }

    #[test]
    fn prompt_presets_list_newest_first_and_enforce_the_blob_bound() {
        let db = test_db();
        let first = save(&db, "First", "one").unwrap();
        // now_ms() can return the same millisecond; nudge the stored row so the
        // ordering assertion is deterministic instead of racy.
        let mut items = load(&db).unwrap();
        for item in items.iter_mut() {
            if item.id == first.id {
                item.created_at_ms = first.created_at_ms - 10;
            }
        }
        store(&db, &items).unwrap();
        let second = save(&db, "Second", "two").unwrap();

        let listed = list(&db).unwrap();
        assert_eq!(listed[0].id, second.id, "newest first");
        assert_eq!(listed[1].id, first.id);

        // A shelf that would exceed the byte bound is refused, and the refusal
        // does not partially write: the previous shelf survives.
        let big = "x".repeat(40);
        let chunk = "y".repeat(MAX_SESSION_SYSTEM_PROMPT_CHARS);
        let mut count = 0;
        loop {
            match save(&db, &format!("{big}-{count}"), &chunk) {
                Ok(_) => count += 1,
                Err(_) => break,
            }
            if count > 20 {
                panic!("blob bound never triggered");
            }
        }
        let err = save(&db, &format!("{big}-overflow"), &chunk).unwrap_err();
        assert!(err.to_string().contains("storage limit"));
        // Nothing stored is larger than the bound.
        let blob = json!(list(&db).unwrap()).to_string();
        assert!(blob.len() <= MAX_PROMPT_PRESETS_BLOB_BYTES);
    }
}
