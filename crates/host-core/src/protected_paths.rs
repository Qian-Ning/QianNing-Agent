//! App-owned files no tool may touch, in any permission mode.
//!
//! The database, the transcript store, and the log directory sit outside the
//! workspace, so the ordinary external-path check applies to them — and under
//! `auto` that check returns `AllowOnce` without asking. An agent could read its
//! own credential records, other projects' conversations, or a whole channel's
//! message history, silently, while the user believes `auto` only removed
//! routine prompts.
//!
//! Deliberately narrow. The data directory also holds `scratch/`, which tools are
//! *supposed* to write, and a user may legitimately open the directory as a
//! project. Protecting the whole tree would break both, so only the names below
//! are refused. This is also not a general sensitive-path list: `~/.ssh` and
//! `~/.aws` need their own argument, their own false positives, and their own
//! decision about asking versus refusing.

use std::path::Path;

use crate::workspace;

/// Names under the data directory that hold app state rather than scratch space.
const PROTECTED_NAMES: &[&str] = &[
    "pi.sqlite",
    "pi.sqlite-wal",
    "pi.sqlite-shm",
    "sessions",
    "logs",
];

/// True when `path` (a tool argument) points at one of those names.
///
/// Relative arguments are resolved against the session workspace, because that is
/// what the tools do with them: `../.qianning-agent/pi.sqlite` must not slip past
/// a check that only understood absolute paths. Comparison is lexical, on
/// normalised paths, so `..` cannot walk out and back in — the same approach the
/// scratch-write shortcut uses, and for the same reason: this only decides
/// refusal, and execution still runs the symlink-aware resolver.
pub fn is_protected_app_path(data_dir: &Path, workspace_path: Option<&str>, path: &str) -> bool {
    let candidate = Path::new(path);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        let Some(workspace) = workspace_path else {
            return false;
        };
        Path::new(workspace).join(candidate)
    };
    let absolute = absolute.to_string_lossy();

    // An explicitly opened workspace wins. A user who selects the data directory
    // as their project has consented to working in it; refusing every tool there
    // would be a dead session, not a safeguard.
    if workspace_path
        .is_some_and(|workspace| workspace::lexically_inside(Path::new(workspace), &absolute))
    {
        return false;
    }
    if !workspace::lexically_inside(data_dir, &absolute) {
        return false;
    }
    let root = workspace::normalize_lexical(data_dir);
    let target = workspace::normalize_lexical(Path::new(absolute.as_ref()));
    let Ok(rest) = target.strip_prefix(&root) else {
        return false;
    };
    rest.components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
        .is_some_and(|name| PROTECTED_NAMES.contains(&name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn data_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\someone\AppData\Local\qianning-agent")
        } else {
            PathBuf::from("/home/someone/.qianning-agent")
        }
    }

    fn workspace() -> &'static str {
        if cfg!(windows) {
            r"C:\Users\someone\Desktop\project"
        } else {
            "/home/someone/project"
        }
    }

    fn inside(relative: &str) -> String {
        if cfg!(windows) {
            format!("{}\\{}", data_dir().display(), relative.replace('/', "\\"))
        } else {
            format!("{}/{}", data_dir().display(), relative)
        }
    }

    #[test]
    fn the_database_and_transcripts_are_refused() {
        for relative in [
            "pi.sqlite",
            "sessions/abc.jsonl",
            "logs/app.log",
            "pi.sqlite-wal",
        ] {
            assert!(
                is_protected_app_path(&data_dir(), Some(workspace()), &inside(relative)),
                "{relative} must be refused"
            );
        }
    }

    #[test]
    fn the_scratch_directory_stays_writable() {
        assert!(
            !is_protected_app_path(
                &data_dir(),
                Some(workspace()),
                &inside("scratch/s1/out.txt")
            ),
            "tools write scratch output on purpose"
        );
    }

    #[test]
    fn a_relative_argument_cannot_smuggle_the_path_in() {
        let escape = if cfg!(windows) {
            r"..\..\AppData\Local\qianning-agent\pi.sqlite"
        } else {
            "../.qianning-agent/pi.sqlite"
        };
        assert!(
            is_protected_app_path(&data_dir(), Some(workspace()), escape),
            "a walking relative path is still the database"
        );
    }

    #[test]
    fn an_opened_workspace_wins() {
        assert!(!is_protected_app_path(
            &data_dir(),
            Some(workspace()),
            workspace()
        ));
        let as_project = data_dir().to_string_lossy().into_owned();
        assert!(!is_protected_app_path(
            &data_dir(),
            Some(as_project.as_str()),
            &inside("pi.sqlite")
        ));
    }

    #[test]
    fn a_sibling_directory_with_a_shared_prefix_is_not_the_data_dir() {
        let sibling = if cfg!(windows) {
            r"C:\Users\someone\AppData\Local\qianning-agent-backup\pi.sqlite"
        } else {
            "/home/someone/.qianning-agent-backup/pi.sqlite"
        };
        assert!(
            !is_protected_app_path(&data_dir(), Some(workspace()), sibling),
            "a prefix match is not containment"
        );
    }

    #[test]
    fn a_relative_path_without_a_workspace_is_not_considered() {
        assert!(!is_protected_app_path(&data_dir(), None, "pi.sqlite"));
    }
}
