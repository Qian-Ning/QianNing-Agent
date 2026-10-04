//! Connections: outbound, user-owned targets the Agent can run against.
//!
//! The layer is a host-core module alongside [`crate::computer`], and it is
//! split the same way. [`params`] and the validation in this file are pure, so
//! they run and are unit-tested on every build host including CI's Linux
//! runner. [`ssh`] performs the platform calls and decides nothing: it spawns
//! the system's own `ssh` and executes what the pure half planned. [`store`]
//! owns the persisted record.
//!
//! Three things this module deliberately does **not** do:
//!
//! - It does not implement a protocol. `ssh` is the system's OpenSSH program,
//!   so the user's `~/.ssh/config`, agent, jump hosts, and `known_hosts` apply
//!   exactly as they do in their terminal.
//! - It does not manage profiles. No function here creates, edits, enables, or
//!   deletes a target on behalf of a caller; the Agent-facing surface has no
//!   method that could, which is what makes "the Agent cannot widen its own
//!   reach" true by construction rather than by inspection.
//! - It does not hold a credential value. A profile holds a *reference* into
//!   the existing secret store, and the value is read only at spawn time.

pub mod params;
pub mod ssh;
pub mod store;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The prefix a profile's secret-store reference carries.
///
/// The reference is returned to the user-facing surface so the interface can
/// say a credential is configured. It is never returned to the Agent surface
/// and never enters an audit row; only [`store`] and [`ssh`] ever resolve it.
pub const CREDENTIAL_REF_PREFIX: &str = "conn:";

/// The secret-store reference for a profile id.
pub fn credential_ref_for(profile_id: &str) -> String {
    format!("{CREDENTIAL_REF_PREFIX}{profile_id}")
}

/// Which outbound transport a profile uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnKind {
    Ssh,
    Serial,
    Telnet,
    /// A raw TCP socket: bytes in, bytes out, no protocol of any kind.
    RawTcp,
}

impl ConnKind {
    /// The kind as it appears on the wire and in the store.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Serial => "serial",
            Self::Telnet => "telnet",
            Self::RawTcp => "raw-tcp",
        }
    }

    /// Every kind, for validation messages and exhaustive tests.
    pub const ALL: [Self; 4] = [Self::Ssh, Self::Serial, Self::Telnet, Self::RawTcp];

    pub fn parse(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| {
                format!("kind must be one of ssh, serial, telnet or raw-tcp, not {value}")
            })
    }
}

/// What a transport can be asked to do. A method a transport cannot serve is
/// refused by name *before* a connection is attempted, so a caller is never
/// left reading an obscure failure as an empty result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Run one command and get an exit code back.
    pub exec: bool,
    /// Move a file in either direction (milestone R2).
    pub transfer: bool,
    /// Hold a byte stream open (milestone R4).
    pub stream: bool,
}

/// The capabilities of a transport kind.
///
/// Only SSH has a command boundary; serial, telnet, and raw TCP are byte
/// streams with no exit code. That difference is what the whole `Console` /
/// `Connection` split exists for.
pub fn capabilities_for(kind: ConnKind) -> Capabilities {
    match kind {
        ConnKind::Ssh => Capabilities {
            exec: true,
            transfer: true,
            stream: true,
        },
        ConnKind::Serial | ConnKind::Telnet | ConnKind::RawTcp => Capabilities {
            exec: false,
            transfer: false,
            stream: true,
        },
    }
}

/// How a profile treats the far side's host key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyPolicy {
    /// An unknown key is refused with its fingerprint for the user to accept.
    Strict,
    /// An unknown key is accepted once and recorded; strict from then on.
    AcceptNew,
    /// The key must match a fingerprint the record already holds.
    Pinned,
}

impl HostKeyPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Strict => "strict",
            Self::AcceptNew => "accept-new",
            Self::Pinned => "pinned",
        }
    }

    pub const ALL: [Self; 3] = [Self::Strict, Self::AcceptNew, Self::Pinned];

    pub fn parse(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|policy| policy.as_str() == value)
            .ok_or_else(|| {
                format!("hostKeyPolicy must be strict, accept-new or pinned, not {value}")
            })
    }
}

/// How a profile wants connections shared.
///
/// `PerCall` is the default and the only behaviour that can be promised
/// everywhere: `OpenSSH_for_Windows` does not implement `ControlMaster`. A
/// profile may ask for `Multiplex`, and a probe reports whether a shared
/// connection was *actually* obtained rather than assuming one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Multiplex {
    PerCall,
    Multiplex,
}

impl Multiplex {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PerCall => "per-call",
            Self::Multiplex => "multiplex",
        }
    }

    pub const ALL: [Self; 2] = [Self::PerCall, Self::Multiplex];

    pub fn parse(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|mode| mode.as_str() == value)
            .ok_or_else(|| format!("multiplex must be per-call or multiplex, not {value}"))
    }
}

/// Per-profile bounds. Each may lower the host maximum; none can raise it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub timeout_ms: u64,
    pub output_bytes: u64,
    pub stream_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout_ms: params::DEFAULT_TIMEOUT_MS,
            output_bytes: params::DEFAULT_OUTPUT_BYTES,
            stream_bytes: params::DEFAULT_STREAM_BYTES,
        }
    }
}

/// A profile's address, whose shape is fixed by the profile's kind.
///
/// The `kind` field is carried inside the target so a persisted record is
/// self-describing, and [`params::validate_target`] refuses a target whose
/// kind disagrees with the profile's own — the two are written together and
/// must not be able to drift apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Target {
    Ssh {
        host: String,
        port: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        user: Option<String>,
        #[serde(rename = "identityFile", skip_serializing_if = "Option::is_none")]
        identity_file: Option<String>,
        #[serde(rename = "proxyJump", skip_serializing_if = "Option::is_none")]
        proxy_jump: Option<String>,
    },
    Serial {
        port: String,
        baud: u32,
        #[serde(rename = "dataBits")]
        data_bits: u8,
        parity: String,
        #[serde(rename = "stopBits")]
        stop_bits: u8,
        flow: String,
    },
    Telnet {
        host: String,
        port: u16,
    },
    RawTcp {
        host: String,
        port: u16,
    },
}

impl Target {
    pub fn kind(&self) -> ConnKind {
        match self {
            Self::Ssh { .. } => ConnKind::Ssh,
            Self::Serial { .. } => ConnKind::Serial,
            Self::Telnet { .. } => ConnKind::Telnet,
            Self::RawTcp { .. } => ConnKind::RawTcp,
        }
    }
}

/// The persisted summary of the most recent probe, success or failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastProbe {
    pub ok: bool,
    /// RFC3339, UTC.
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Why a connection call could not be carried out.
///
/// Every variant maps to one code in `03-runtime/23-connections-protocol.md`
/// §9. A non-zero remote exit code is deliberately absent: that is result
/// data, not a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionError {
    /// The global switch is off, so nothing was sent. A user decision, not a
    /// platform limit: the same call succeeds once the switch is on.
    Disabled,
    /// No profile has that id. Distinct from a disabled profile, because the
    /// remedies differ.
    NotFound(String),
    /// This profile's own switch is off; the global switch is on, so other
    /// profiles still work.
    ProfileDisabled(String),
    /// The target could not be reached. `stage` names where it failed.
    Unreachable { stage: &'static str, reason: String },
    /// The host key is unknown or changed. A changed key is refused on every
    /// policy and requires a person in the Connections destination.
    HostKey { fingerprint: String, changed: bool },
    /// The target rejected the credential. Carries nothing about the
    /// credential, so it cannot be used to probe the stored secret's shape.
    AuthFailed(String),
    /// The operation exceeded its timeout; the spawned tree is already
    /// terminated by the time this is returned.
    Timeout,
    /// This transport kind has no implementation here, or the program it
    /// needs is absent. Reported rather than returning an empty success.
    Unsupported(String),
    /// The transport has no command channel. Decided before any connection is
    /// attempted.
    NoExec,
}

impl ConnectionError {
    /// The numeric code a caller branches on.
    pub fn code(&self) -> i64 {
        match self {
            Self::Disabled => 1029,
            Self::NotFound(_) => 1030,
            Self::ProfileDisabled(_) => 1031,
            Self::Unreachable { .. } => 1032,
            Self::HostKey { .. } => 1033,
            Self::AuthFailed(_) => 1034,
            Self::Timeout => 1035,
            Self::Unsupported(_) => 1036,
            Self::NoExec => 1037,
        }
    }

    /// The stable slug, which travels beside any payload field rather than
    /// being replaced by it (protocol §9.1).
    pub fn slug(&self) -> &'static str {
        match self {
            Self::Disabled => "CONNECTION_DISABLED",
            Self::NotFound(_) => "CONNECTION_NOT_FOUND",
            Self::ProfileDisabled(_) => "CONNECTION_PROFILE_DISABLED",
            Self::Unreachable { .. } => "CONNECTION_UNREACHABLE",
            Self::HostKey { .. } => "CONNECTION_HOST_KEY",
            Self::AuthFailed(_) => "CONNECTION_AUTH_FAILED",
            Self::Timeout => "CONNECTION_TIMEOUT",
            Self::Unsupported(_) => "CONNECTION_UNSUPPORTED",
            Self::NoExec => "CONNECTION_NO_EXEC",
        }
    }

    /// The payload fields this error carries, if any.
    ///
    /// Returned as a list rather than written into the reply so the caller can
    /// place them beside the slug in whichever envelope it owns.
    pub fn details(&self) -> Vec<(&'static str, Value)> {
        match self {
            Self::NotFound(profile)
            | Self::ProfileDisabled(profile)
            | Self::AuthFailed(profile) => {
                vec![("profile", serde_json::json!(profile))]
            }
            Self::Unreachable { stage, reason } => vec![
                ("reason", serde_json::json!(reason)),
                ("stage", serde_json::json!(stage)),
            ],
            Self::HostKey {
                fingerprint,
                changed,
            } => vec![
                ("fingerprint", serde_json::json!(fingerprint)),
                (
                    "kind",
                    serde_json::json!(if *changed { "changed" } else { "unknown" }),
                ),
            ],
            _ => Vec::new(),
        }
    }
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(
                formatter,
                "connections are switched off; turn them on in Settings before reaching a target"
            ),
            Self::NotFound(profile) => write!(formatter, "no connection profile has id {profile}"),
            Self::ProfileDisabled(profile) => write!(
                formatter,
                "connection profile {profile} is switched off; enable it in the Connections destination"
            ),
            Self::Unreachable { stage, reason } => {
                write!(formatter, "the target could not be reached ({stage}): {reason}")
            }
            Self::HostKey {
                fingerprint,
                changed,
            } => {
                if *changed {
                    write!(
                        formatter,
                        "the host key changed (now {fingerprint}); accepting a changed key requires a person in the Connections destination"
                    )
                } else {
                    write!(formatter, "the host key is unknown ({fingerprint})")
                }
            }
            Self::AuthFailed(profile) => write!(
                formatter,
                "the target rejected the credential for profile {profile}"
            ),
            Self::Timeout => write!(formatter, "the operation exceeded its timeout"),
            Self::Unsupported(reason) => write!(formatter, "this host cannot serve the target: {reason}"),
            Self::NoExec => write!(
                formatter,
                "this transport has no command channel; use Console against a byte stream"
            ),
        }
    }
}

impl std::error::Error for ConnectionError {}

/// The `Connection` tool, as the model sees it.
///
/// One tool with an `action` vocabulary, following the `Computer` precedent.
/// The `Console` half is a separate tool because the two share no handle: this
/// one is a request/response call against a profile, that one is a stateful
/// byte stream. Folding them together would make an action vocabulary in which
/// half the entries are unavailable depending on the target — which is exactly
/// what a model gets wrong.
///
/// Only the actions this milestone dispatches are advertised. A model told
/// about `upload` before it exists would call it and learn nothing.
pub fn tool_definition() -> Value {
    serde_json::json!({
        "name": "Connection",
        "description": "Run work on a target machine or device the user registered in the Connections destination. \
             Answers 'run this on that machine'; it is not a remote desktop and not a way to drive this one. \
             `list` shows the targets the user has enabled, `probe` connects, verifies the host key and reports the fingerprint, and `exec` runs one command and returns its exit code, stdout and stderr. \
             Only available while outbound connections are switched on in Settings, and only for a target the user has enabled; a target that is off is refused by name. \
             `exec` needs an SSH target: a serial, telnet or raw TCP target has no command channel and is refused before anything is dialled. \
             A non-zero exit code is the answer, not an error — read it and decide. \
             Output is capped on the same budget as the local Bash tool and spills to a file you can Read when it overflows.",
        "risk": "high",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "probe", "exec"],
                    "description": "What to do. `list` changes nothing; `probe` opens and closes a connection; `exec` runs a command."
                },
                "profile": {
                    "type": "string",
                    "description": "The target's id, from `list`. Required by probe and exec."
                },
                "command": {
                    "type": "string",
                    "description": format!(
                        "exec only; at most {} characters. Runs in the target's own login shell.",
                        params::MAX_COMMAND_CHARS
                    )
                },
                "timeoutMs": {
                    "type": "integer",
                    "minimum": params::MIN_TIMEOUT_MS,
                    "maximum": params::MAX_TIMEOUT_MS,
                    "description": "exec only; clamped to the profile's own limit. A timeout is a refusal, not an exit code."
                }
            },
            "required": ["action"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_parses_and_round_trips() {
        for kind in ConnKind::ALL {
            assert_eq!(ConnKind::parse(kind.as_str()).unwrap(), kind);
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::json!(kind.as_str())
            );
        }
        for bad in ["SSH", "rawtcp", "http", ""] {
            assert!(ConnKind::parse(bad).is_err(), "kind {bad}");
        }
    }

    #[test]
    fn only_ssh_can_execute() {
        let ssh = capabilities_for(ConnKind::Ssh);
        assert!(ssh.exec && ssh.transfer && ssh.stream);

        for kind in [ConnKind::Serial, ConnKind::Telnet, ConnKind::RawTcp] {
            let capabilities = capabilities_for(kind);
            assert!(
                !capabilities.exec,
                "{} must not advertise a command channel",
                kind.as_str()
            );
            assert!(capabilities.stream, "{} is a byte stream", kind.as_str());
        }
    }

    #[test]
    fn a_target_reports_the_kind_it_encodes() {
        let ssh = Target::Ssh {
            host: "build-box".into(),
            port: 22,
            user: None,
            identity_file: None,
            proxy_jump: None,
        };
        assert_eq!(ssh.kind(), ConnKind::Ssh);

        let serial = Target::Serial {
            port: "COM3".into(),
            baud: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "none".into(),
        };
        assert_eq!(serial.kind(), ConnKind::Serial);
    }

    #[test]
    fn a_target_serializes_its_kind_and_camel_case_fields() {
        let target = Target::Ssh {
            host: "build-box".into(),
            port: 22,
            user: Some("deploy".into()),
            identity_file: Some("~/.ssh/id_ed25519".into()),
            proxy_jump: Some("bastion".into()),
        };
        let value = serde_json::to_value(&target).unwrap();
        assert_eq!(value["kind"], serde_json::json!("ssh"));
        assert_eq!(
            value["identityFile"],
            serde_json::json!("~/.ssh/id_ed25519")
        );
        assert_eq!(value["proxyJump"], serde_json::json!("bastion"));

        // A raw TCP target keeps the kebab-case wire name.
        let raw = Target::RawTcp {
            host: "10.0.0.5".into(),
            port: 9000,
        };
        assert_eq!(serde_json::to_value(&raw).unwrap()["kind"], "raw-tcp");
    }

    #[test]
    fn an_optional_ssh_field_is_absent_rather_than_null() {
        // A null would have to be distinguished from "not set" by every
        // consumer; an absent key is the same thing everywhere.
        let target = Target::Ssh {
            host: "box".into(),
            port: 22,
            user: None,
            identity_file: None,
            proxy_jump: None,
        };
        let value = serde_json::to_value(&target).unwrap();
        assert!(value.get("user").is_none());
        assert!(value.get("identityFile").is_none());
        assert!(value.get("proxyJump").is_none());
    }

    #[test]
    fn each_error_maps_to_its_own_code_and_slug() {
        let table: [(ConnectionError, i64, &str); 9] = [
            (ConnectionError::Disabled, 1029, "CONNECTION_DISABLED"),
            (
                ConnectionError::NotFound("a".into()),
                1030,
                "CONNECTION_NOT_FOUND",
            ),
            (
                ConnectionError::ProfileDisabled("a".into()),
                1031,
                "CONNECTION_PROFILE_DISABLED",
            ),
            (
                ConnectionError::Unreachable {
                    stage: "connect",
                    reason: "refused".into(),
                },
                1032,
                "CONNECTION_UNREACHABLE",
            ),
            (
                ConnectionError::HostKey {
                    fingerprint: "SHA256:x".into(),
                    changed: false,
                },
                1033,
                "CONNECTION_HOST_KEY",
            ),
            (
                ConnectionError::AuthFailed("a".into()),
                1034,
                "CONNECTION_AUTH_FAILED",
            ),
            (ConnectionError::Timeout, 1035, "CONNECTION_TIMEOUT"),
            (
                ConnectionError::Unsupported("no ssh".into()),
                1036,
                "CONNECTION_UNSUPPORTED",
            ),
            (ConnectionError::NoExec, 1037, "CONNECTION_NO_EXEC"),
        ];
        let mut codes: Vec<i64> = table
            .iter()
            .map(|(error, code, slug)| {
                assert_eq!(error.code(), *code, "{error}");
                assert_eq!(error.slug(), *slug, "{error}");
                error.code()
            })
            .collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 9, "the nine codes must be distinct");
    }

    #[test]
    fn a_host_key_error_says_whether_the_key_was_unknown_or_changed() {
        let unknown = ConnectionError::HostKey {
            fingerprint: "SHA256:a".into(),
            changed: false,
        };
        assert_eq!(
            unknown.details(),
            vec![
                ("fingerprint", serde_json::json!("SHA256:a")),
                ("kind", serde_json::json!("unknown")),
            ]
        );

        let changed = ConnectionError::HostKey {
            fingerprint: "SHA256:b".into(),
            changed: true,
        };
        assert_eq!(
            changed.details(),
            vec![
                ("fingerprint", serde_json::json!("SHA256:b")),
                ("kind", serde_json::json!("changed")),
            ]
        );
    }

    #[test]
    fn an_auth_failure_carries_nothing_about_the_credential() {
        // The error surface must not become an oracle for the stored secret's
        // shape, so the only thing it names is the profile.
        let error = ConnectionError::AuthFailed("0f5c".into());
        assert_eq!(
            error.details(),
            vec![("profile", serde_json::json!("0f5c"))]
        );
        let rendered = error.to_string();
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("passphrase"));
        assert!(!rendered.contains("key"));
    }

    #[test]
    fn errors_that_carry_no_payload_leave_details_empty() {
        for error in [
            ConnectionError::Disabled,
            ConnectionError::Timeout,
            ConnectionError::NoExec,
        ] {
            assert!(error.details().is_empty(), "{error}");
        }
    }

    #[test]
    fn a_credential_reference_is_namespaced_by_profile_id() {
        assert_eq!(credential_ref_for("0f5c"), "conn:0f5c");
        assert!(credential_ref_for("0f5c").starts_with(CREDENTIAL_REF_PREFIX));
    }

    #[test]
    fn the_definition_advertises_the_actions_this_milestone_dispatches() {
        let definition = tool_definition();
        assert_eq!(definition["name"], serde_json::json!("Connection"));
        assert_eq!(definition["risk"], serde_json::json!("high"));
        let advertised: Vec<&str> = definition["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("the action enum")
            .iter()
            .map(|value| value.as_str().expect("a string action"))
            .collect();
        // R1 dispatches exactly these three. R2 adds read/write/upload/
        // download/stat and R4 adds Console; until then a model must not be
        // told about an action that would only ever answer "unknown".
        assert_eq!(advertised, ["list", "probe", "exec"]);
    }

    #[test]
    fn the_tool_description_states_the_execution_limits() {
        let description = tool_definition()["description"]
            .as_str()
            .expect("a description")
            .to_string();
        // A model that does not know these writes the naive thing and then
        // wonders why the result looked empty.
        assert!(description.contains("non-zero exit code"));
        assert!(description.contains("no command channel"));
        assert!(description.contains("switched on in Settings"));
    }

    #[test]
    fn limits_default_to_the_documented_bounds() {
        let limits = Limits::default();
        assert_eq!(limits.timeout_ms, 60_000);
        assert_eq!(limits.output_bytes, 262_144);
        assert_eq!(limits.stream_bytes, 65_536);
    }
}
