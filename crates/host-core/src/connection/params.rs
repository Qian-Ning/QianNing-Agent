//! Parameter validation shared by the RPC methods and the Agent tool.
//!
//! Both surfaces accept the same arguments and must reject the same shapes, so
//! the rules live here once. An over-long label, a port outside the range, a
//! baud rate that is not a real line speed, a `pinned` policy with no
//! fingerprint, or a host that would be read as a command-line option is
//! refused identically whichever door the request came through.
//!
//! Every function returns `Err(message)` rather than a typed error, because
//! the RPC layer reports failures as a JSON-RPC error object and the tool
//! layer reports them as a tool result. Neither envelope belongs here.

use serde_json::Value;

use super::{ConnKind, HostKeyPolicy, Limits, Multiplex, Target};

/// The wall-clock default for one command, in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// The shortest timeout a caller may ask for.
pub const MIN_TIMEOUT_MS: u64 = 1_000;
/// The longest timeout a profile may carry. A remote command is a step in a
/// turn, not a job: six hours is the local Bash ceiling and is reused here so
/// the two only have one number to remember.
pub const MAX_TIMEOUT_MS: u64 = 21_600_000;

/// The default stdout/stderr budget, in bytes, matching the local shell tool.
pub const DEFAULT_OUTPUT_BYTES: u64 = 262_144;
/// A profile may not raise the output budget past this.
pub const MAX_OUTPUT_BYTES: u64 = 4_194_304;

/// The default per-stream ring, in bytes.
pub const DEFAULT_STREAM_BYTES: u64 = 65_536;
/// A profile may not raise the stream ring past this.
pub const MAX_STREAM_BYTES: u64 = 1_048_576;

/// The longest a profile label may be.
pub const MAX_LABEL_CHARS: usize = 64;
/// The longest one remote command may be, in characters. The local tool has no
/// such bound because its shell is on the same machine; a remote command
/// travels through an argv, and a bound keeps one call from building a
/// command line no platform will accept.
pub const MAX_COMMAND_CHARS: usize = 32_768;
/// The longest host name accepted. The DNS limit is 253.
pub const MAX_HOST_CHARS: usize = 253;
/// The longest login name accepted.
pub const MAX_USER_CHARS: usize = 64;
/// The longest identity-file path accepted.
pub const MAX_IDENTITY_PATH_CHARS: usize = 1024;
/// The longest `ProxyJump` specification accepted.
pub const MAX_PROXY_JUMP_CHARS: usize = 512;
/// The longest device path accepted for a serial port.
pub const MAX_DEVICE_PATH_CHARS: usize = 256;

/// The baud rates a serial profile may use. A line speed that is not in this
/// set is a typo rather than an exotic device, and a typo that is stored is a
/// failure the user only finds later.
pub const BAUD_RATES: [u32; 13] = [
    300, 600, 1200, 2400, 4800, 9600, 14_400, 19_200, 38_400, 57_600, 115_200, 230_400, 460_800,
];

/// Data bits a serial profile may use.
pub const DATA_BITS: [u8; 4] = [5, 6, 7, 8];
/// Parity settings a serial profile may use.
pub const PARITY: [&str; 5] = ["none", "even", "odd", "mark", "space"];
/// Stop bits a serial profile may use.
pub const STOP_BITS: [u8; 2] = [1, 2];
/// Flow control settings a serial profile may use.
pub const FLOW_CONTROL: [&str; 3] = ["none", "software", "hardware"];

/// Validate a profile label: non-empty, bounded, and not nothing-but-space.
pub fn label(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("label must not be empty".into());
    }
    if trimmed.chars().count() > MAX_LABEL_CHARS {
        return Err(format!(
            "label must be at most {MAX_LABEL_CHARS} characters"
        ));
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return Err("label must not contain control characters".into());
    }
    Ok(trimmed.to_string())
}

/// A value that will be passed to `ssh` as a positional argument.
///
/// A leading `-` would be parsed as an option by the spawned program, which is
/// how a host name becomes `-o ProxyCommand=...`. The check is here rather
/// than at the spawn site so it is enforced on every host, including ones
/// where no `ssh` binary exists to fail for us.
fn positional(value: &str, field: &str, max_chars: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.starts_with('-') {
        return Err(format!("{field} must not start with '-'"));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{field} must be at most {max_chars} characters"));
    }
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(format!(
            "{field} must not contain whitespace or control characters"
        ));
    }
    Ok(())
}

fn port(value: u16) -> Result<u16, String> {
    if value == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    Ok(value)
}

/// Validate a target against its kind, and against the profile's own kind.
///
/// `kind` is the profile's declared kind; `target.kind()` is what the target
/// encodes. The two are written together, so a disagreement is a bug in the
/// caller rather than a state the store should be able to hold.
pub fn validate_target(kind: ConnKind, target: &Target) -> Result<(), String> {
    if target.kind() != kind {
        return Err(format!(
            "target encodes kind {} but the profile declares {}",
            target.kind().as_str(),
            kind.as_str()
        ));
    }
    match target {
        Target::Ssh {
            host,
            port: ssh_port,
            user,
            identity_file,
            proxy_jump,
        } => {
            positional(host, "target.host", MAX_HOST_CHARS)?;
            port(*ssh_port)?;
            if let Some(user) = user {
                positional(user, "target.user", MAX_USER_CHARS)?;
            }
            if let Some(path) = identity_file {
                if path.trim().is_empty() {
                    return Err("target.identityFile must not be blank".into());
                }
                if path.chars().count() > MAX_IDENTITY_PATH_CHARS {
                    return Err(format!(
                        "target.identityFile must be at most {MAX_IDENTITY_PATH_CHARS} characters"
                    ));
                }
                if path.contains('\0') {
                    return Err("target.identityFile must not contain a NUL".into());
                }
            }
            if let Some(jump) = proxy_jump {
                positional(jump, "target.proxyJump", MAX_PROXY_JUMP_CHARS)?;
            }
        }
        Target::Serial {
            port: device,
            baud,
            data_bits,
            parity,
            stop_bits,
            flow,
        } => {
            if device.trim().is_empty() {
                return Err("target.port must not be empty".into());
            }
            if device.chars().count() > MAX_DEVICE_PATH_CHARS {
                return Err(format!(
                    "target.port must be at most {MAX_DEVICE_PATH_CHARS} characters"
                ));
            }
            if device.contains('\0') {
                return Err("target.port must not contain a NUL".into());
            }
            if !BAUD_RATES.contains(baud) {
                return Err(format!(
                    "target.baud must be one of {}",
                    BAUD_RATES
                        .iter()
                        .map(|rate| rate.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if !DATA_BITS.contains(data_bits) {
                return Err("target.dataBits must be 5, 6, 7 or 8".into());
            }
            if !PARITY.contains(&parity.as_str()) {
                return Err(format!(
                    "target.parity must be one of {}, not {parity}",
                    PARITY.join(", ")
                ));
            }
            if !STOP_BITS.contains(stop_bits) {
                return Err("target.stopBits must be 1 or 2".into());
            }
            if !FLOW_CONTROL.contains(&flow.as_str()) {
                return Err(format!(
                    "target.flow must be one of {}, not {flow}",
                    FLOW_CONTROL.join(", ")
                ));
            }
        }
        Target::Telnet { host, port: p } | Target::RawTcp { host, port: p } => {
            positional(host, "target.host", MAX_HOST_CHARS)?;
            port(*p)?;
        }
    }
    Ok(())
}

/// The `hostKeyPolicy`/fingerprint pairing.
///
/// A `pinned` policy with no fingerprint is refused here rather than stored,
/// because a record that fails later fails at the moment the user is trying to
/// use the machine rather than at the moment they made the mistake.
pub fn validate_host_key(policy: HostKeyPolicy, fingerprint: Option<&str>) -> Result<(), String> {
    match (policy, fingerprint) {
        (HostKeyPolicy::Pinned, None) | (HostKeyPolicy::Pinned, Some("")) => {
            Err("hostKeyFingerprint is required when hostKeyPolicy is pinned".into())
        }
        (HostKeyPolicy::Pinned, Some(value)) => {
            if value.trim().is_empty() {
                return Err("hostKeyFingerprint must not be blank".into());
            }
            if value.chars().any(char::is_whitespace) {
                return Err("hostKeyFingerprint must not contain whitespace".into());
            }
            Ok(())
        }
        // A fingerprint left over from a previous `pinned` choice is dropped
        // rather than rejected: switching back to a looser policy is a normal
        // edit, and refusing it would make the record uneditable.
        (_, _) => Ok(()),
    }
}

/// Read and bound the per-profile limits. Absent fields take their default.
pub fn limits(params: &Value) -> Result<Limits, String> {
    let Some(raw) = params.get("limits") else {
        return Ok(Limits::default());
    };
    if raw.is_null() {
        return Ok(Limits::default());
    }
    let defaults = Limits::default();

    let timeout_ms = match raw.get("timeoutMs") {
        None | Some(Value::Null) => defaults.timeout_ms,
        Some(value) => {
            let parsed = value
                .as_u64()
                .ok_or_else(|| "limits.timeoutMs must be a non-negative integer".to_string())?;
            if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&parsed) {
                return Err(format!(
                    "limits.timeoutMs must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}"
                ));
            }
            parsed
        }
    };
    let output_bytes = match raw.get("outputBytes") {
        None | Some(Value::Null) => defaults.output_bytes,
        Some(value) => {
            let parsed = value
                .as_u64()
                .ok_or_else(|| "limits.outputBytes must be a non-negative integer".to_string())?;
            if parsed == 0 || parsed > MAX_OUTPUT_BYTES {
                return Err(format!(
                    "limits.outputBytes must be between 1 and {MAX_OUTPUT_BYTES}"
                ));
            }
            parsed
        }
    };
    let stream_bytes = match raw.get("streamBytes") {
        None | Some(Value::Null) => defaults.stream_bytes,
        Some(value) => {
            let parsed = value
                .as_u64()
                .ok_or_else(|| "limits.streamBytes must be a non-negative integer".to_string())?;
            if parsed == 0 || parsed > MAX_STREAM_BYTES {
                return Err(format!(
                    "limits.streamBytes must be between 1 and {MAX_STREAM_BYTES}"
                ));
            }
            parsed
        }
    };

    Ok(Limits {
        timeout_ms,
        output_bytes,
        stream_bytes,
    })
}

/// The timeout a call actually gets: what it asked for, clamped to the
/// profile's limit and to the host maximum.
///
/// Clamping rather than refusing because a caller asking for longer than the
/// profile allows is a caller with a stale idea of the limit, not a caller
/// doing something wrong — and the result reports the effective value when it
/// differs, so nothing is silently shortened.
pub fn effective_timeout_ms(profile: &Limits, requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(profile.timeout_ms)
        .min(profile.timeout_ms)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// The effective stdout budget.
///
/// The profile's own value may lower the host maximum and never raise it, and
/// the host maximum is the budget the local command tool renders with — so the
/// same marker and the same spill path apply on both sides
/// (`03-runtime/23-connections-protocol.md` §11).
pub fn effective_output_bytes(profile: &Limits) -> usize {
    (profile.output_bytes as usize).min(crate::tools::BUDGET_SHELL.max_bytes)
}

/// Whether the effective budget is below the host maximum, so a result can say
/// so rather than leaving a caller to wonder where the rest went.
pub fn budget_is_reduced(profile: &Limits) -> bool {
    effective_output_bytes(profile) < crate::tools::BUDGET_SHELL.max_bytes
}

// ---- argument readers, shared by the RPC methods and the tool ---------------

/// The `profileId` every profile-addressed method takes.
pub fn profile_id(params: &Value) -> Result<String, String> {
    let value = params
        .get("profileId")
        .or_else(|| params.get("profile"))
        .and_then(Value::as_str)
        .ok_or_else(|| "profileId must be a string".to_string())?;
    if value.trim().is_empty() {
        return Err("profileId must not be empty".into());
    }
    Ok(value.to_string())
}

/// The `command` an `exec` takes.
pub fn command(params: &Value) -> Result<String, String> {
    let value = params
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "command must be a string".to_string())?;
    if value.trim().is_empty() {
        return Err("command must not be empty".into());
    }
    if value.contains('\0') {
        return Err("command must not contain a NUL".into());
    }
    if value.chars().count() > MAX_COMMAND_CHARS {
        return Err(format!(
            "command must be at most {MAX_COMMAND_CHARS} characters"
        ));
    }
    Ok(value.to_string())
}

/// A caller-supplied `timeoutMs`, before clamping.
pub fn requested_timeout_ms(params: &Value) -> Result<Option<u64>, String> {
    match params.get("timeoutMs") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let parsed = value
                .as_u64()
                .ok_or_else(|| "timeoutMs must be a non-negative integer".to_string())?;
            if parsed < MIN_TIMEOUT_MS {
                return Err(format!("timeoutMs must be at least {MIN_TIMEOUT_MS}"));
            }
            Ok(Some(parsed))
        }
    }
}

/// A boolean switch, defaulting to absent.
pub fn bool_field(params: &Value, key: &str) -> Result<Option<bool>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("{key} must be a boolean")),
    }
}

/// A required string field.
pub fn required_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{key} must be a string"))
}

pub fn kind(params: &Value) -> Result<ConnKind, String> {
    let value = required_str(params, "kind")?;
    ConnKind::parse(&value)
}

pub fn host_key_policy(params: &Value) -> Result<HostKeyPolicy, String> {
    match params.get("hostKeyPolicy") {
        None | Some(Value::Null) => Ok(HostKeyPolicy::Strict),
        Some(value) => {
            let name = value
                .as_str()
                .ok_or_else(|| "hostKeyPolicy must be a string".to_string())?;
            HostKeyPolicy::parse(name)
        }
    }
}

pub fn multiplex(params: &Value) -> Result<Multiplex, String> {
    match params.get("multiplex") {
        None | Some(Value::Null) => Ok(Multiplex::PerCall),
        Some(value) => {
            let name = value
                .as_str()
                .ok_or_else(|| "multiplex must be a string".to_string())?;
            Multiplex::parse(name)
        }
    }
}

/// Decode a `target` object into its typed form.
///
/// serde does the field extraction; the error is restated as the plain
/// sentence this module's callers already expect.
pub fn target(params: &Value) -> Result<Target, String> {
    let raw = params
        .get("target")
        .ok_or_else(|| "target is required".to_string())?;
    serde_json::from_value(raw.clone()).map_err(|error| format!("target is invalid: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ssh_target() -> Target {
        Target::Ssh {
            host: "build-box".into(),
            port: 22,
            user: Some("deploy".into()),
            identity_file: None,
            proxy_jump: None,
        }
    }

    #[test]
    fn a_label_is_trimmed_and_bounded() {
        assert_eq!(label("  build-box  ").unwrap(), "build-box");
        assert!(label("   ").is_err());
        assert!(label("").is_err());
        assert!(label("a".repeat(MAX_LABEL_CHARS).as_str()).is_ok());
        assert!(label("a".repeat(MAX_LABEL_CHARS + 1).as_str()).is_err());
        assert!(label("two\nlines").is_err());
    }

    #[test]
    fn a_host_that_would_be_read_as_an_option_is_refused() {
        // `ssh -o ProxyCommand=...` is what a leading dash buys an attacker
        // who can get a profile written; the check is what stops it.
        let mut target = ssh_target();
        if let Target::Ssh { host, .. } = &mut target {
            *host = "-o".into();
        }
        let error = validate_target(ConnKind::Ssh, &target).expect_err("a leading dash is refused");
        assert!(error.contains("must not start with"), "{error}");

        let mut target = ssh_target();
        if let Target::Ssh {
            user: Some(user), ..
        } = &mut target
        {
            *user = "-oProxyCommand=x".into();
        }
        assert!(validate_target(ConnKind::Ssh, &target).is_err());
    }

    #[test]
    fn a_host_with_whitespace_is_refused() {
        let mut target = ssh_target();
        if let Target::Ssh { host, .. } = &mut target {
            *host = "build box".into();
        }
        assert!(validate_target(ConnKind::Ssh, &target).is_err());
    }

    #[test]
    fn a_target_whose_kind_disagrees_with_the_profile_is_refused() {
        // The two are written together, so this is a caller bug rather than a
        // state the store may hold.
        let error = validate_target(ConnKind::Telnet, &ssh_target())
            .expect_err("a mismatch must be refused");
        assert!(error.contains("encodes kind ssh"), "{error}");
        assert!(error.contains("declares telnet"), "{error}");
    }

    #[test]
    fn a_port_of_zero_is_refused() {
        let target = Target::RawTcp {
            host: "10.0.0.5".into(),
            port: 0,
        };
        assert!(validate_target(ConnKind::RawTcp, &target).is_err());
    }

    #[test]
    fn a_serial_profile_must_use_a_real_line_speed() {
        let good = Target::Serial {
            port: "COM3".into(),
            baud: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "none".into(),
        };
        assert!(validate_target(ConnKind::Serial, &good).is_ok());

        let mut bad = good.clone();
        if let Target::Serial { baud, .. } = &mut bad {
            *baud = 12_345;
        }
        let error = validate_target(ConnKind::Serial, &bad).expect_err("12345 is not a line speed");
        assert!(error.contains("target.baud"), "{error}");

        let mut bad = good.clone();
        if let Target::Serial { parity, .. } = &mut bad {
            *parity = "banana".into();
        }
        assert!(validate_target(ConnKind::Serial, &bad).is_err());

        let mut bad = good;
        if let Target::Serial { stop_bits, .. } = &mut bad {
            *stop_bits = 3;
        }
        assert!(validate_target(ConnKind::Serial, &bad).is_err());
    }

    #[test]
    fn a_pinned_policy_needs_a_fingerprint() {
        assert!(validate_host_key(HostKeyPolicy::Pinned, None).is_err());
        assert!(validate_host_key(HostKeyPolicy::Pinned, Some("")).is_err());
        assert!(validate_host_key(HostKeyPolicy::Pinned, Some("   ")).is_err());
        assert!(validate_host_key(HostKeyPolicy::Pinned, Some("SHA256:abc")).is_ok());

        // The looser policies do not need one, and keeping a stale fingerprint
        // around must not make the record uneditable.
        assert!(validate_host_key(HostKeyPolicy::Strict, None).is_ok());
        assert!(validate_host_key(HostKeyPolicy::AcceptNew, None).is_ok());
        assert!(validate_host_key(HostKeyPolicy::Strict, Some("SHA256:abc")).is_ok());
    }

    #[test]
    fn limits_default_and_are_bounded() {
        assert_eq!(limits(&json!({})).unwrap(), Limits::default());
        assert_eq!(
            limits(&json!({ "limits": null })).unwrap(),
            Limits::default()
        );

        let parsed =
            limits(&json!({ "limits": { "timeoutMs": 5000, "outputBytes": 1024 } })).unwrap();
        assert_eq!(parsed.timeout_ms, 5000);
        assert_eq!(parsed.output_bytes, 1024);
        assert_eq!(
            parsed.stream_bytes, DEFAULT_STREAM_BYTES,
            "an absent field keeps its default"
        );

        for bad in [
            json!({ "limits": { "timeoutMs": 10 } }),
            json!({ "limits": { "timeoutMs": MAX_TIMEOUT_MS + 1 } }),
            json!({ "limits": { "timeoutMs": "soon" } }),
            json!({ "limits": { "outputBytes": 0 } }),
            json!({ "limits": { "outputBytes": MAX_OUTPUT_BYTES + 1 } }),
            json!({ "limits": { "streamBytes": 0 } }),
            json!({ "limits": { "streamBytes": MAX_STREAM_BYTES + 1 } }),
        ] {
            assert!(limits(&bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn a_requested_timeout_is_clamped_to_the_profile_and_the_host_maximum() {
        let profile = Limits {
            timeout_ms: 30_000,
            ..Limits::default()
        };
        // Asking for longer than the profile allows gets the profile's limit,
        // not a refusal: a stale idea of the limit is not a mistake worth
        // failing a turn over.
        assert_eq!(effective_timeout_ms(&profile, Some(600_000)), 30_000);
        // Asking for less is honoured.
        assert_eq!(effective_timeout_ms(&profile, Some(5_000)), 5_000);
        // Absent means the profile's own limit.
        assert_eq!(effective_timeout_ms(&profile, None), 30_000);

        let generous = Limits {
            timeout_ms: MAX_TIMEOUT_MS + 1_000_000,
            ..Limits::default()
        };
        assert_eq!(
            effective_timeout_ms(&generous, Some(u64::MAX)),
            MAX_TIMEOUT_MS,
            "the host maximum still applies"
        );
    }

    #[test]
    fn an_output_budget_can_be_lowered_but_never_raised() {
        // The host maximum is the local command tool's stdout budget, so the
        // same marker and spill path apply on both sides.
        let host_max = crate::tools::BUDGET_SHELL.max_bytes;
        assert!(
            host_max < DEFAULT_OUTPUT_BYTES as usize,
            "the documented default is a stored ceiling, not the effective budget"
        );

        let lowered = Limits {
            output_bytes: 4096,
            ..Limits::default()
        };
        assert_eq!(effective_output_bytes(&lowered), 4096);
        assert!(budget_is_reduced(&lowered));

        // The documented default stores 262144 but is served at the host
        // maximum, which is the host default rather than a reduction.
        assert_eq!(effective_output_bytes(&Limits::default()), host_max);
        assert!(!budget_is_reduced(&Limits::default()));

        let raised = Limits {
            output_bytes: MAX_OUTPUT_BYTES + 1,
            ..Limits::default()
        };
        assert_eq!(effective_output_bytes(&raised), host_max);
    }

    #[test]
    fn a_command_is_bounded_and_must_not_be_empty() {
        assert_eq!(command(&json!({ "command": "uptime" })).unwrap(), "uptime");
        assert!(command(&json!({})).is_err());
        assert!(command(&json!({ "command": "" })).is_err());
        assert!(command(&json!({ "command": "   " })).is_err());
        assert!(command(&json!({ "command": 5 })).is_err());
        assert!(command(&json!({ "command": "a\0b" })).is_err());
        assert!(command(&json!({ "command": "a".repeat(MAX_COMMAND_CHARS + 1) })).is_err());
        assert!(command(&json!({ "command": "a".repeat(MAX_COMMAND_CHARS) })).is_ok());
    }

    #[test]
    fn a_profile_id_reads_from_either_spelling() {
        assert_eq!(profile_id(&json!({ "profileId": "a" })).unwrap(), "a");
        assert_eq!(profile_id(&json!({ "profile": "a" })).unwrap(), "a");
        assert!(profile_id(&json!({ "profileId": "" })).is_err());
        assert!(profile_id(&json!({})).is_err());
        assert!(profile_id(&json!({ "profileId": 7 })).is_err());
    }

    #[test]
    fn a_timeout_must_be_a_number_and_at_least_the_floor() {
        assert_eq!(requested_timeout_ms(&json!({})).unwrap(), None);
        assert_eq!(
            requested_timeout_ms(&json!({ "timeoutMs": 5_000 })).unwrap(),
            Some(5_000)
        );
        assert!(requested_timeout_ms(&json!({ "timeoutMs": 10 })).is_err());
        assert!(requested_timeout_ms(&json!({ "timeoutMs": "5s" })).is_err());
        assert!(requested_timeout_ms(&json!({ "timeoutMs": -1 })).is_err());
    }

    #[test]
    fn enum_fields_default_to_the_safe_choice() {
        assert_eq!(host_key_policy(&json!({})).unwrap(), HostKeyPolicy::Strict);
        assert_eq!(multiplex(&json!({})).unwrap(), Multiplex::PerCall);
        assert_eq!(
            host_key_policy(&json!({ "hostKeyPolicy": "accept-new" })).unwrap(),
            HostKeyPolicy::AcceptNew
        );
        assert!(host_key_policy(&json!({ "hostKeyPolicy": "trust" })).is_err());
        assert!(multiplex(&json!({ "multiplex": "shared" })).is_err());
    }

    #[test]
    fn a_boolean_field_is_absent_or_a_boolean() {
        assert_eq!(bool_field(&json!({}), "enabled").unwrap(), None);
        assert_eq!(
            bool_field(&json!({ "enabled": true }), "enabled").unwrap(),
            Some(true)
        );
        assert!(bool_field(&json!({ "enabled": "yes" }), "enabled").is_err());
    }

    #[test]
    fn a_target_decodes_or_says_why() {
        let decoded = target(&json!({ "target": {
            "kind": "ssh", "host": "box", "port": 22
        } }))
        .unwrap();
        assert_eq!(decoded.kind(), ConnKind::Ssh);

        assert!(target(&json!({})).is_err());
        assert!(target(&json!({ "target": { "kind": "ssh" } })).is_err());
        assert!(target(&json!({ "target": { "kind": "carrier-pigeon" } })).is_err());
    }
}
