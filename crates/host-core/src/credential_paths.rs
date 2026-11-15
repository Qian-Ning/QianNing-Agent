//! Credential locations, for the permission decision.
//!
//! `auto` exists to stop asking about routine work. It does not mean "may read
//! my SSH keys": the agent reaching `~/.ssh/id_ed25519` and putting it in a
//! prompt is a leak that no later confirmation can undo.
//!
//! Two outcomes, because the cases are genuinely different:
//!
//! * **Ask** — directories that hold credentials but also have legitimate uses
//!   (`~/.ssh` also has `known_hosts` and `config`; `~/.docker` has build
//!   contexts). Downgrading them to "ask" keeps the workflow alive and makes the
//!   user the one who decides.
//! * **Never** — files whose only content is a private key. No tool has a reason
//!   to read one, and a prompt would invite a yes.
//!
//! Workspace files are never affected. A `.env` in the project is normal work,
//! and treating it as a credential would train people to click through cards.

use std::path::{Path, PathBuf};

use crate::workspace;

/// What the permission path should do with a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialZone {
    /// Not a credential location; the normal rules apply.
    Ordinary,
    /// A credential location: the user decides, whatever the mode says.
    AskAlways,
    /// Private key material: refuse outright, whatever the mode says.
    NeverRead,
}

/// Directories under the home directory whose contents are credentials.
const ASK_DIRECTORIES: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".netrc",
    "AppData/Roaming/gcloud",
    ".config/gcloud",
    ".config/gh",
    "AppData/Roaming/GitHub CLI",
];

/// File names (matched case-insensitively) that hold key material.
const NEVER_NAMES: &[&str] = &[
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_ecdsa_sk",
    "id_ed25519_sk",
];

/// Extensions that, in a credential directory, mean key material.
const NEVER_EXTENSIONS: &[&str] = &["key", "p12", "pfx", "pem"];

/// Classify a tool argument path.
///
/// `home` is the user's home directory; `workspace_path` resolves relative
/// arguments the way the tools do. Anything inside the workspace is `Ordinary` —
/// see the module note.
pub fn classify(home: Option<&Path>, workspace_path: Option<&str>, path: &str) -> CredentialZone {
    let Some(home) = home else {
        return CredentialZone::Ordinary;
    };
    let candidate = Path::new(path);
    let absolute: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        let Some(workspace) = workspace_path else {
            return CredentialZone::Ordinary;
        };
        Path::new(workspace).join(candidate)
    };
    let absolute = absolute.to_string_lossy();
    if workspace_path
        .is_some_and(|workspace| workspace::lexically_inside(Path::new(workspace), &absolute))
    {
        return CredentialZone::Ordinary;
    }

    let name = Path::new(absolute.as_ref())
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let extension = Path::new(absolute.as_ref())
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    for directory in ASK_DIRECTORIES {
        let full = home.join(directory.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !workspace::lexically_inside(&full, &absolute) {
            continue;
        }
        if NEVER_NAMES.contains(&name.as_str())
            || (NEVER_EXTENSIONS.contains(&extension.as_str()) && !name.ends_with(".pub"))
        {
            return CredentialZone::NeverRead;
        }
        return CredentialZone::AskAlways;
    }
    CredentialZone::Ordinary
}

/// Markers that, appearing in a shell command, mean it may be reaching for a
/// credential. Deliberately loose: a false positive costs one confirmation, a
/// false negative leaks a key.
const COMMAND_MARKERS: &[&str] = &[
    ".ssh",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    ".aws",
    ".gnupg",
    ".netrc",
    ".kube",
    ".docker/config.json",
    ".config/gh",
    "gcloud/credentials",
];

/// Does a shell command look like it reaches a credential?
///
/// Shell is not parsed here on purpose. The cheap version of this problem is a
/// marker scan: it cannot tell `cat ~/.ssh/id_rsa` from `grep -r id_rsa .`, and it
/// does not try. What it must not do is let a command reach a key silently under
/// `auto`, so the answer to "maybe" is a confirmation, not a pass.
///
/// Quoting, variables, and command substitution all defeat a marker scan, which
/// is why this raises the floor rather than closing the hole: `Bash` is still
/// unbounded, and the honest description is "harder to do by accident".
pub fn command_touches_credentials(command: &str) -> bool {
    let normalised = normalise_command(command);
    COMMAND_MARKERS
        .iter()
        .any(|marker| normalised.contains(marker))
}

/// Reduce a command to the form the markers are written in.
///
/// The three trivial evasions were a quoting habit, not an attack: `cat
/// "$HOME"/.ssh/id_rsa` and `cat ${HOME}/.ssh/id_rsa` reach the same file as the
/// plain form, and a scan that only knew the plain form let both through. This
/// expands the home variables we know, drops quotes and line continuations, and
/// folds backslashes to slashes, so all four spellings normalise to one string.
///
/// It is still not a parser. Anything that computes the path at runtime —
/// `K=~/.ssh; cat $K/id_rsa`, `printf` piped into a shell, a base64 payload — is
/// invisible here. The honest claim stays "an accidental reach asks first".
fn normalise_command(command: &str) -> String {
    let mut text = command.to_lowercase();

    // Home and profile variables, in both shell and PowerShell spellings.
    for token in [
        "${home}",
        "$env:userprofile",
        "$env:appdata",
        "%userprofile%",
        "%appdata%",
        "$userprofile",
        "$home",
        "~",
    ] {
        text = text.replace(token, "/home/user");
    }

    let mut out = String::with_capacity(text.len());
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        let code = character as u32;
        // 0x22 quote, 0x27 apostrophe: they only hide the path from a naive scan.
        if code == 0x22 || code == 0x27 {
            continue;
        }
        // 0x5c backslash: escapes the next character, or continues the line.
        if code == 0x5c {
            if let Some(next) = characters.next() {
                let next_code = next as u32;
                if next_code == 0x6e || next_code == 0x72 {
                    out.push(' ');
                } else {
                    out.push(next);
                }
            }
            continue;
        }
        out.push(character);
    }
    out.replace(char::from(0x5c), "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\someone")
        } else {
            PathBuf::from("/home/someone")
        }
    }

    fn workspace() -> &'static str {
        if cfg!(windows) {
            r"C:\Users\someone\Desktop\project"
        } else {
            "/home/someone/project"
        }
    }

    fn under_home(relative: &str) -> String {
        let separator = std::path::MAIN_SEPARATOR_STR;
        format!(
            "{}{separator}{}",
            home().display(),
            relative.replace('/', separator)
        )
    }

    #[test]
    fn private_keys_are_never_read() {
        for relative in [
            ".ssh/id_rsa",
            ".ssh/id_ed25519",
            ".ssh/deploy.pem",
            ".aws/private.key",
        ] {
            assert_eq!(
                classify(Some(&home()), Some(workspace()), &under_home(relative)),
                CredentialZone::NeverRead,
                "{relative}"
            );
        }
    }

    #[test]
    fn credential_directories_ask_rather_than_refuse() {
        for relative in [
            ".ssh/known_hosts",
            ".ssh/config",
            ".aws/credentials",
            ".docker/config.json",
        ] {
            assert_eq!(
                classify(Some(&home()), Some(workspace()), &under_home(relative)),
                CredentialZone::AskAlways,
                "{relative}"
            );
        }
    }

    #[test]
    fn public_keys_are_not_private_keys() {
        assert_eq!(
            classify(
                Some(&home()),
                Some(workspace()),
                &under_home(".ssh/id_rsa.pub")
            ),
            CredentialZone::AskAlways
        );
    }

    #[test]
    fn the_workspace_wins_over_the_home_directory() {
        let inside = if cfg!(windows) {
            r"C:\Users\someone\.ssh-practice\key.txt"
        } else {
            "/home/someone/.ssh-practice/key.txt"
        };
        assert_eq!(
            classify(
                Some(&home()),
                Some(if cfg!(windows) {
                    r"C:\Users\someone\.ssh-practice"
                } else {
                    "/home/someone/.ssh-practice"
                }),
                inside
            ),
            CredentialZone::Ordinary,
            "a project that happens to live under the home directory is still a project"
        );
    }

    #[test]
    fn ordinary_files_outside_any_credential_directory_are_untouched() {
        assert_eq!(
            classify(
                Some(&home()),
                Some(workspace()),
                &under_home("Documents/notes.txt")
            ),
            CredentialZone::Ordinary
        );
    }

    #[test]
    fn a_shell_command_naming_a_key_is_flagged() {
        for command in [
            "cat ~/.ssh/id_rsa",
            "scp -i /home/me/.ssh/id_ed25519 host:/tmp",
            r"Get-Content C:\\Users\\me\\.ssh\\id_rsa",
            "tar czf /tmp/x.tgz ~/.aws",
            "cat ~/.config/gh/hosts.yml",
        ] {
            assert!(command_touches_credentials(command), "{command}");
        }
    }

    #[test]
    fn quoting_and_variables_do_not_hide_the_path() {
        // The three spellings that used to slip past a plain marker scan.
        for command in [
            "cat \"$HOME\"/.ssh/id_rsa",
            "cat ${HOME}/.ssh/id_rsa",
            "cat ~/.ssh/id_ed25519",
            "python -c \"open('$HOME/.ssh/id_rsa').read()\"",
            "awk '{print}' $HOME/.ssh/id_rsa",
            "grep -r . \"${HOME}/.aws/credentials\"",
        ] {
            assert!(command_touches_credentials(command), "{command}");
        }
    }

    #[test]
    fn windows_spellings_are_seen_too() {
        for command in [
            r"type %USERPROFILE%\.ssh\id_rsa",
            r"Get-Content $env:USERPROFILE\.ssh\id_rsa",
        ] {
            assert!(command_touches_credentials(command), "{command}");
        }
    }

    #[test]
    fn ordinary_commands_are_not_flagged() {
        for command in [
            "ls -la",
            "cargo test -p host-core",
            "git status --short",
            "npm run build",
        ] {
            assert!(!command_touches_credentials(command), "{command}");
        }
    }

    #[test]
    fn without_a_home_directory_nothing_is_classified() {
        assert_eq!(
            classify(None, Some(workspace()), "/whatever/id_rsa"),
            CredentialZone::Ordinary
        );
    }
}
