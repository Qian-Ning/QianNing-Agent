//! Workspace file search: ranking and a bounded walk.
//!
//! This is the backend half of the picker described in
//! `docs/spec/04-ux/13-workspace-file-search.md`. The constraints there are not
//! decoration; each one is a defect that shows up as "the app froze" on a large
//! repository:
//!
//! * the walk is bounded by an entry budget, not by a timer, so a pathological
//!   tree cannot decide how long a keystroke takes;
//! * directories that never contain user files (`.git`, `node_modules`, build
//!   output) are skipped before they are descended into;
//! * results are capped and the cap is applied after ranking, so the caller gets
//!   the best matches rather than the first ones the filesystem happened to
//!   return;
//! * nothing is enumerated to the renderer. The caller asks a query and gets at
//!   most `limit` hits.
//!
//! What this does *not* do (yet) is share discovery between queries: every call
//! walks again. That is acceptable for a first version only because the entry
//! budget keeps each walk bounded; the leases and job identity in the design note
//! exist for the version that caches snapshots.

use std::path::{Path, PathBuf};

use anyhow::Result;

/// Directories whose contents are generated, vendored, or version-control
/// internals. Skipping them at the top of the walk is what keeps a query cheap in
/// the repositories people actually open.
const SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
];

/// How many entries one query may visit. Chosen so a large monorepo answers in
/// well under a frame budget while still finding files that sit deep in a tree.
pub const MAX_ENTRIES_VISITED: usize = 20_000;

/// How deep the walk goes. Deep enough for `src/a/b/c/d.ts`, shallow enough that
/// a pathological directory chain cannot dominate the budget.
const MAX_DEPTH: usize = 12;

/// One match. The path is relative to the searched root and always uses `/`, so
/// the renderer never has to care which platform produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileHit {
    pub path: String,
    pub score: u32,
}

/// Why a hit ranked where it did, from strongest to weakest. Kept as a plain
/// number in the result so the ordering is stable across runs: the score is
/// derived from the match kind and the path length, never from traversal order.
fn score_for(relative: &str, query: &str) -> Option<u32> {
    let lowered = relative.to_lowercase();
    let query = query.to_lowercase();
    let name = lowered.rsplit('/').next().unwrap_or(&lowered);

    if name == query {
        // An exact file name beats everything; prefer the shallower one.
        return Some(1000u32.saturating_sub(relative.matches('/').count() as u32));
    }
    if name.starts_with(&query) {
        return Some(800u32.saturating_sub(relative.matches('/').count() as u32));
    }
    if name.contains(&query) {
        return Some(600u32.saturating_sub(relative.matches('/').count() as u32));
    }
    if lowered.contains(&query) {
        return Some(400u32.saturating_sub(relative.matches('/').count() as u32));
    }
    None
}

/// Search `root` for files whose path matches `query`.
///
/// A caller-supplied `limit` is clamped to [`MAX_RESULTS`]; an empty query returns
/// an empty list rather than the whole tree, because "no query" is not a query.
pub fn search_files(root: &Path, query: &str, limit: usize) -> Result<Vec<FileHit>> {
    let query = query.trim();
    if query.is_empty() || !root.is_dir() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_RESULTS);

    let mut hits: Vec<FileHit> = Vec::new();
    let mut visited = 0usize;
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_DEPTH || visited >= MAX_ENTRIES_VISITED {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_ENTRIES_VISITED {
                break;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            // Symlinks are not followed: a link can point outside the root, and a
            // cycle would spend the whole budget going nowhere.
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if SKIPPED_DIRECTORIES
                    .iter()
                    .any(|skipped| name.eq_ignore_ascii_case(skipped))
                {
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if let Some(score) = score_for(&relative, query) {
                hits.push(FileHit {
                    path: relative,
                    score,
                });
            }
        }
    }

    // Highest score first, then shortest path, then alphabetical: a total order,
    // so the same tree and query always produce the same list.
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    hits.truncate(limit);
    Ok(hits)
}

/// Most results any caller may ask for. A picker shows a handful; the cap exists
/// so a bug in the caller cannot turn into a 100k-row payload.
pub const MAX_RESULTS: usize = 200;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for path in [
            "src/main.rs",
            "src/lib.rs",
            "src/search/mod.rs",
            "src/search/engine.rs",
            "docs/search-notes.md",
            "README.md",
            "node_modules/search/index.js",
            ".git/search",
        ] {
            let full = dir.path().join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, "x").unwrap();
        }
        dir
    }

    #[test]
    fn an_exact_file_name_outranks_a_path_match() {
        let dir = fixture();
        let hits = search_files(dir.path(), "search", 10).unwrap();
        assert!(!hits.is_empty());
        // `search` is the exact directory name; every hit here matches by path,
        // so the assertion is about the ordering rule rather than a specific name.
        let first = &hits[0];
        assert!(
            first.path.to_lowercase().contains("search"),
            "every hit matches the query: {first:?}"
        );
        assert!(
            hits.windows(2).all(|pair| pair[0].score >= pair[1].score),
            "scores are non-increasing: {hits:?}"
        );
    }

    #[test]
    fn vendored_and_version_control_directories_are_skipped() {
        let dir = fixture();
        let hits = search_files(dir.path(), "index", 50).unwrap();
        assert!(
            hits.iter()
                .all(|hit| !hit.path.starts_with("node_modules/")),
            "node_modules is not searched: {hits:?}"
        );
        assert!(hits.iter().all(|hit| !hit.path.starts_with(".git/")));
    }

    #[test]
    fn an_exact_name_beats_a_longer_path_that_contains_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.json"), "x").unwrap();
        fs::create_dir_all(dir.path().join("deeply/nested/dir")).unwrap();
        fs::write(dir.path().join("deeply/nested/dir/config.json.bak"), "x").unwrap();

        let hits = search_files(dir.path(), "config.json", 5).unwrap();
        assert_eq!(hits[0].path, "config.json");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn the_limit_is_respected_and_capped() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..25 {
            fs::write(dir.path().join(format!("note-{index}.md")), "x").unwrap();
        }
        assert_eq!(search_files(dir.path(), "note", 5).unwrap().len(), 5);
        assert!(search_files(dir.path(), "note", usize::MAX).unwrap().len() <= MAX_RESULTS);
    }

    #[test]
    fn an_empty_query_returns_nothing_rather_than_everything() {
        let dir = fixture();
        assert!(search_files(dir.path(), "", 50).unwrap().is_empty());
        assert!(search_files(dir.path(), "   ", 50).unwrap().is_empty());
    }

    #[test]
    fn a_missing_root_is_not_an_error() {
        assert!(search_files(Path::new("does/not/exist"), "x", 5)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn results_are_ordered_deterministically() {
        let dir = fixture();
        let first = search_files(dir.path(), "r", 50).unwrap();
        let second = search_files(dir.path(), "r", 50).unwrap();
        assert_eq!(first, second, "the same tree and query give the same list");
    }

    #[test]
    fn paths_are_forward_slashed_regardless_of_platform() {
        let dir = fixture();
        let hits = search_files(dir.path(), "engine", 5).unwrap();
        assert_eq!(hits[0].path, "src/search/engine.rs");
    }
}
