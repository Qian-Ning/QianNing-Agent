//! Session-owned inline visualizations (ADR 0327).
//!
//! An agent turn writes a static artifact — HTML, SVG, JSON, CSV or plain
//! text — through the `WriteInlineVisualization` tool. Each artifact lands in
//! a directory host-core owns under the session data area:
//!
//! ```text
//! <data_dir>/inline-viz/<session_id>/<viz_id>.json
//! ```
//!
//! One JSON file per artifact carries its meta (`{ id, sessionId, title,
//! kind, createdAt }`) together with the raw `content`, written atomically
//! (temp file + rename) so a crash never leaves a half-written artifact that
//! list/read would otherwise surface. Lifecycle mirrors scratch and review:
//! removed with the session (`remove_session`, wired into
//! `rpc::drop_session_side_data`) and swept at startup for orphans
//! (`sweep`). Content never executes: the renderer shows it in a no-script
//! sandbox iframe, and the renderer only ever *reads* through the
//! `inlineViz.list` / `inlineViz.read` IPC channels.

use crate::db::{ms_to_ts, now_ms, Database};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Directory name under `data_dir`; mirrors the scratch/review layout.
pub const DIR_NAME: &str = "inline-viz";

/// Accepted kinds, kept in sync with `packages/shared/src/inline-viz.ts`.
pub const KINDS: &[&str] = &["html", "svg", "json", "csv", "text"];

/// Byte ceiling on one artifact's content; mirrors
/// `MAX_INLINE_VIZ_CONTENT_BYTES` in `packages/shared/src/inline-viz.ts`.
pub const MAX_CONTENT_BYTES: usize = 512 * 1024;

/// Title bound; mirrors `MAX_INLINE_VIZ_TITLE_CHARS` in shared.
pub const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InlineVisualizationMeta {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub kind: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InlineVisualizationArtifact {
    #[serde(flatten)]
    pub meta: InlineVisualizationMeta,
    pub content: String,
}

pub fn is_valid_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

/// Session ids come from our own DB (UUIDs), but stay defensive: an id that
/// could traverse out of the base gets no directory at all.
fn safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Artifact ids are host-generated UUIDs; the same containment rule applies.
fn safe_viz_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn base_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

/// Absolute visualization directory for a session, or None for unsafe ids.
pub fn session_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !safe_session_id(session_id) {
        return None;
    }
    Some(base_dir(data_dir).join(session_id))
}

fn artifact_path(data_dir: &Path, session_id: &str, viz_id: &str) -> Option<PathBuf> {
    if !safe_viz_id(viz_id) {
        return None;
    }
    session_dir(data_dir, session_id).map(|dir| dir.join(format!("{viz_id}.json")))
}

/// Whether inline visualizations are switched on (Settings, default off).
///
/// Default-off, and a store that cannot be read also reads as off: the
/// failure mode of an unavailable gate must be closed, never open.
pub fn enabled(db: &Database) -> bool {
    db.get_setting("app")
        .ok()
        .flatten()
        .and_then(|settings| {
            settings
                .get("inlineVisualizations")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

/// Write one artifact and return its meta. `title`/`kind`/`content` must
/// already be validated by the tool layer; this stays defensive anyway.
pub fn write(
    data_dir: &Path,
    session_id: &str,
    title: &str,
    kind: &str,
    content: &str,
) -> Result<InlineVisualizationMeta> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(anyhow!("title must be 1..={MAX_TITLE_CHARS} characters"));
    }
    if !is_valid_kind(kind) {
        return Err(anyhow!("kind must be one of: {}", KINDS.join(", ")));
    }
    if content.len() > MAX_CONTENT_BYTES {
        return Err(anyhow!(
            "content exceeds the {MAX_CONTENT_BYTES}-byte limit"
        ));
    }
    let dir = session_dir(data_dir, session_id).ok_or_else(|| anyhow!("invalid session id"))?;
    std::fs::create_dir_all(&dir).map_err(|e| anyhow!("mkdir failed: {e}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let meta = InlineVisualizationMeta {
        id: id.clone(),
        session_id: session_id.to_string(),
        title: title.to_string(),
        kind: kind.to_string(),
        created_at: ms_to_ts(now_ms()),
    };
    let artifact = InlineVisualizationArtifact {
        meta: meta.clone(),
        content: content.to_string(),
    };
    let bytes = serde_json::to_vec(&artifact).map_err(|e| anyhow!("encode failed: {e}"))?;
    let path = artifact_path(data_dir, session_id, &id).expect("id is safe");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| anyhow!("write failed: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| anyhow!("finalize failed: {e}"))?;
    Ok(meta)
}

/// Read one artifact from disk; `Ok(None)` for an unknown id, an id that does
/// not belong to the session, or an unreadable/corrupt file (fail closed).
fn read_artifact(
    data_dir: &Path,
    session_id: &str,
    viz_id: &str,
) -> Result<Option<InlineVisualizationArtifact>> {
    let Some(path) = artifact_path(data_dir, session_id, viz_id) else {
        return Ok(None);
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(anyhow!("read failed: {error}")),
    };
    match serde_json::from_slice::<InlineVisualizationArtifact>(&bytes) {
        Ok(artifact) if artifact.meta.session_id == session_id => Ok(Some(artifact)),
        _ => Ok(None),
    }
}

/// Newest first, like the artifacts table. A corrupt or half-written file is
/// skipped rather than failing the whole list.
pub fn list(data_dir: &Path, session_id: &str) -> Result<Vec<InlineVisualizationMeta>> {
    let Some(dir) = session_dir(data_dir, session_id) else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut metas: Vec<InlineVisualizationMeta> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let viz_id = name.trim_end_matches(".json").to_string();
        let Ok(Some(artifact)) = read_artifact(data_dir, session_id, &viz_id) else {
            continue;
        };
        metas.push(artifact.meta);
    }
    metas.sort_by(|a, b| {
        crate::db::ts_to_ms(&b.created_at)
            .cmp(&crate::db::ts_to_ms(&a.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(metas)
}

/// Read one artifact; `Ok(None)` when the id is unknown or unreadable.
pub fn read(
    data_dir: &Path,
    session_id: &str,
    viz_id: &str,
) -> Result<Option<InlineVisualizationArtifact>> {
    read_artifact(data_dir, session_id, viz_id)
}

/// Remove a session's visualization directory (idempotent, best-effort).
pub fn remove_session(data_dir: &Path, session_id: &str) {
    if let Some(dir) = session_dir(data_dir, session_id) {
        if dir.exists() {
            if let Err(error) = std::fs::remove_dir_all(&dir) {
                tracing::warn!(path = %dir.display(), %error, "inline-viz cleanup failed");
            }
        }
    }
}

/// Startup sweep: drop visualization dirs whose session no longer exists.
/// Unlike scratch there is no age cut-off — the content is the session's
/// own deliverable and dies exactly with the session.
pub fn sweep(data_dir: &Path, live_session_ids: &HashSet<String>) {
    let base = base_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if live_session_ids.contains(&name) {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&path) {
            tracing::warn!(path = %path.display(), %error, "inline-viz sweep failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_unsafe_session_and_viz_ids() {
        let dir = tempdir().unwrap();
        assert!(session_dir(dir.path(), "../evil").is_none());
        assert!(session_dir(dir.path(), "a/b").is_none());
        assert!(session_dir(dir.path(), "").is_none());
        assert!(session_dir(dir.path(), "0b0e9a52-1_ok").is_some());
        assert!(artifact_path(dir.path(), "s1", "../evil").is_none());
        assert!(artifact_path(dir.path(), "s1", "a b").is_none());
        assert!(artifact_path(dir.path(), "s1", "0b0e9a52-1234").is_some());
    }

    #[test]
    fn write_list_read_roundtrip() {
        let dir = tempdir().unwrap();
        let meta = write(dir.path(), "s1", "  Chart  ", "svg", "<svg/>").unwrap();
        assert_eq!(meta.title, "Chart");
        assert_eq!(meta.session_id, "s1");
        assert_eq!(meta.kind, "svg");
        let artifact = read(dir.path(), "s1", &meta.id).unwrap().expect("artifact");
        assert_eq!(artifact.content, "<svg/>");
        assert_eq!(artifact.meta, meta);

        // Newest first.
        let second = write(dir.path(), "s1", "Notes", "text", "hello").unwrap();
        let listed = list(dir.path(), "s1").unwrap();
        assert_eq!(
            listed.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            [second.id.as_str(), meta.id.as_str()]
        );
    }

    #[test]
    fn writes_are_session_isolated() {
        let dir = tempdir().unwrap();
        let meta = write(dir.path(), "s1", "Only in s1", "text", "x").unwrap();
        assert!(list(dir.path(), "s2").unwrap().is_empty());
        assert!(read(dir.path(), "s2", &meta.id).unwrap().is_none());
        // A forged id pointing at another session's file never resolves.
        assert!(read(dir.path(), "s2", &meta.id).unwrap().is_none());
    }

    #[test]
    fn validation_bounds_title_kind_and_content() {
        let dir = tempdir().unwrap();
        assert!(write(dir.path(), "s1", " ", "text", "x").is_err());
        assert!(write(dir.path(), "s1", &"t".repeat(121), "text", "x").is_err());
        assert!(write(dir.path(), "s1", "ok", "xml", "x").is_err());
        let oversized = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert!(write(dir.path(), "s1", "ok", "text", &oversized).is_err());
        assert_eq!(list(dir.path(), "s1").unwrap().len(), 0);
    }

    #[test]
    fn remove_session_and_sweep_cleanup_orphans() {
        let dir = tempdir().unwrap();
        let meta = write(dir.path(), "live", "Keep", "text", "x").unwrap();
        write(dir.path(), "orphan", "Drop", "text", "y").unwrap();
        let mut live = HashSet::new();
        live.insert("live".to_string());
        sweep(dir.path(), &live);
        assert!(read(dir.path(), "live", &meta.id).unwrap().is_some());
        assert!(list(dir.path(), "orphan").unwrap().is_empty());
        remove_session(dir.path(), "live");
        assert!(list(dir.path(), "live").unwrap().is_empty());
        remove_session(dir.path(), "live"); // idempotent
    }

    #[test]
    fn enabled_defaults_off_and_reads_the_setting() {
        let dir = tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        assert!(!enabled(&db));
        db.set_setting("app", &serde_json::json!({ "inlineVisualizations": true }))
            .unwrap();
        assert!(enabled(&db));
    }
}
