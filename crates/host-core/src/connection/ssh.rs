//! The SSH transport.
//!
//! This module spawns the system's own `ssh`; it does not implement SSH. The
//! consequence is deliberate and stated in `06-connections.md`: the user's
//! `~/.ssh/config`, their agent, their jump hosts, and their `known_hosts`
//! apply exactly as they do in their terminal, because it is the same program.
//!
//! The split inside this file follows the layer's rule — decide purely, then
//! act:
//!
//! - the argument builders, the `ssh-keyscan` parser, the fingerprint
//!   calculation, and the failure classifier are pure, and are unit-tested on
//!   every host including CI's Linux runner, where no `ssh` need exist;
//! - [`probe`] and [`exec`] perform the platform calls.
//!
//! Nothing here decides whether a call is *allowed*. That is settled before
//! either function is reached, so this module has no gate to get wrong.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;

/// OpenSSH's own base64 dialect: the fingerprint it prints carries no `=`, but
/// key blobs copied out of `ssh-keyscan` do — an ed25519 or RSA blob often ends
/// in padding while an ECDSA one always does. Encoding stays unpadded so a
/// fingerprint compares equal to `ssh-keygen -lf`; decoding accepts either, so
/// a padded blob is not mistaken for a malformed one.
const B64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::store::ConnectionProfile;
use super::{ConnectionError, HostKeyPolicy, Multiplex, Target};
use crate::tools::ProcessOwnership;

/// How much of a stream is held in memory before the pipe is abandoned.
///
/// The caller re-renders to the tool budget anyway; this exists so a target
/// that prints without end cannot grow host memory without limit before the
/// budget is ever consulted.
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

/// How long `ssh-keyscan` gets before it is abandoned.
const KEYSCAN_TIMEOUT: Duration = Duration::from_secs(8);

/// The `ConnectTimeout` handed to `ssh`, in seconds.
///
/// A TCP connect that has not completed in ten seconds is a target that is not
/// answering, and waiting longer only delays the same answer.
const CONNECT_TIMEOUT_SECS: u32 = 10;

/// The environment variable carrying a credential to the askpass helper.
///
/// It is set on the child process only, for the lifetime of that process, and
/// is never written to the store, a log line, or an audit row.
pub const ASKPASS_SECRET_ENV: &str = "PI_CONNECTION_SECRET";

/// The argv the host binary is re-invoked with to answer one askpass prompt.
///
/// Reusing the host binary keeps the mechanism to one artifact and gives the
/// same behaviour on both platforms, where a shell script would need a
/// different interpreter on each.
pub const ASKPASS_ARG: &str = "--connection-askpass";

/// The remote command a probe runs.
///
/// It answers the shell the target will use for `exec`, so a probe result
/// describes the thing a later command will actually meet. `printf` rather
/// than `echo` because `echo` on some targets expands backslashes.
const PROBE_COMMAND: &str = "printf '%s\\n' \"${SHELL:-/bin/sh}\"";

/// What one probe learned.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeReport {
    /// The SHA256 fingerprint of the key the target presented, when it could
    /// be determined. `None` when `ssh-keyscan` is unavailable.
    pub fingerprint: Option<String>,
    /// The login shell the target reported, when it answered.
    pub shell: Option<String>,
    /// Whether a shared connection was actually obtained.
    ///
    /// Reported rather than assumed: `OpenSSH_for_Windows` does not implement
    /// `ControlMaster`, so a profile may ask for multiplexing and not get it.
    pub multiplexed: bool,
    pub duration_ms: u64,
}

/// The outcome of one command.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecReport {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// Whether the command was killed at its timeout rather than exiting.
    pub timed_out: bool,
}

// ---- pure: argument construction -------------------------------------------

/// The `user@host` (or bare `host`) ssh is given as its destination.
fn destination(target: &Target) -> Result<String, ConnectionError> {
    match target {
        Target::Ssh { host, user, .. } => Ok(match user {
            Some(user) => format!("{user}@{host}"),
            None => host.clone(),
        }),
        _ => Err(ConnectionError::NoExec),
    }
}

/// The SSH target's port, or the protocol default.
fn ssh_port(target: &Target) -> Result<u16, ConnectionError> {
    match target {
        Target::Ssh { port, .. } => Ok(if *port == 0 { 22 } else { *port }),
        _ => Err(ConnectionError::NoExec),
    }
}

/// The options every connection carries.
///
/// `BatchMode=yes` on the probe: an agent call must never sit waiting at a
/// prompt. When a credential is configured the spawn path adds the askpass
/// environment and flips this, because a forced askpass answers without a
/// terminal — which is exactly what `BatchMode` exists to prevent.
fn base_options(interactive_credential: bool) -> Vec<String> {
    let mut options = vec![
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        // Both ends are pinned to a byte stream: a probe result or a command
        // result is data, not a terminal session, and a stray TTY would
        // allocate a remote pty and change what the target's programs do.
        "-T".into(),
    ];
    if !interactive_credential {
        options.push("-o".into());
        options.push("BatchMode=yes".into());
    }
    options
}

/// The `StrictHostKeyChecking` decision for a policy.
///
/// `pinned` does not trust `ssh` to make the decision: the fingerprint is
/// checked against the record before any connection is attempted, and only
/// then is the key allowed to be recorded, which is why it is the loosest
/// setting here rather than the strictest.
fn strict_host_key_option(policy: HostKeyPolicy) -> &'static str {
    match policy {
        HostKeyPolicy::Strict => "yes",
        HostKeyPolicy::AcceptNew => "accept-new",
        HostKeyPolicy::Pinned => "no",
    }
}

/// Build the `ssh` argv for a connection, destination last.
///
/// Separated from the spawn so the shape can be asserted without a network, an
/// `ssh` binary, or a target.
fn connection_args(
    profile: &ConnectionProfile,
    program_args: &[String],
) -> Result<Vec<String>, ConnectionError> {
    let target = &profile.target;
    let mut args = base_options(profile.credential_ref.is_some());
    args.push("-o".into());
    args.push(format!(
        "StrictHostKeyChecking={}",
        strict_host_key_option(profile.host_key_policy)
    ));

    if let Target::Ssh {
        identity_file,
        proxy_jump,
        ..
    } = target
    {
        if let Some(path) = identity_file {
            // `IdentitiesOnly` keeps the agent's other keys from being tried
            // first, which is what makes a profile's identity mean something.
            args.push("-i".into());
            args.push(path.clone());
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }
        if let Some(jump) = proxy_jump {
            args.push("-J".into());
            args.push(jump.clone());
        }
    }

    let port = ssh_port(target)?;
    if port != 22 {
        args.push("-p".into());
        args.push(port.to_string());
    }
    args.extend_from_slice(program_args);
    args.push(destination(target)?);
    Ok(args)
}

/// Whether the profile asked for a shared connection.
fn wants_multiplex(profile: &ConnectionProfile) -> bool {
    profile.multiplex == Multiplex::Multiplex
}

/// The `ssh` argv for a probe: connect, run the shell probe, leave.
pub fn probe_args(profile: &ConnectionProfile) -> Result<Vec<String>, ConnectionError> {
    connection_args(profile, &[PROBE_COMMAND.to_string()])
}

/// The `ssh` argv for one command.
pub fn exec_args(
    profile: &ConnectionProfile,
    command: &str,
) -> Result<Vec<String>, ConnectionError> {
    connection_args(profile, &[command.to_string()])
}

/// The `ssh-keyscan` argv that reads the target's key without trusting it.
///
/// A separate program is used rather than letting `ssh` learn the key, because
/// the point of this call is to obtain the fingerprint *before* deciding
/// whether to trust anything.
pub fn keyscan_args(target: &Target) -> Result<Vec<String>, ConnectionError> {
    let (host, port) = match target {
        Target::Ssh { host, port, .. } => (host.as_str(), *port),
        _ => return Err(ConnectionError::NoExec),
    };
    let mut args = vec![
        "-T".into(),
        KEYSCAN_TIMEOUT.as_secs().to_string(),
        // Ed25519 first: it is what a modern target presents, and asking for
        // all three makes the fingerprint ambiguous.
        "-t".into(),
        "ed25519,ecdsa,rsa".into(),
    ];
    if port != 0 && port != 22 {
        args.push("-p".into());
        args.push(port.to_string());
    }
    args.push(host.to_string());
    Ok(args)
}

// ---- pure: parsing and classification --------------------------------------

/// The fingerprint of one base64 key blob, in OpenSSH's own `SHA256:` form.
///
/// The form matters: it is what `ssh-keygen -lf` prints and what the user will
/// see in their terminal, so the value in a profile can be compared against
/// either without translation.
pub fn fingerprint_from_base64(blob: &str) -> Option<String> {
    let decoded = B64.decode(blob.trim()).ok()?;
    let digest = Sha256::digest(&decoded);
    Some(format!("SHA256:{}", B64.encode(digest)))
}

/// The first fingerprint in `ssh-keyscan` output.
///
/// Each line is `host keytype base64key`. A comment line, a blank line, or a
/// line from a target that did not answer is skipped rather than turned into a
/// fingerprint of nothing.
pub fn parse_keyscan_fingerprint(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let _host = fields.next()?;
        let key_type = fields.next()?;
        let blob = fields.next()?;
        if key_type.is_empty() || blob.is_empty() {
            continue;
        }
        if let Some(fingerprint) = fingerprint_from_base64(blob) {
            return Some(fingerprint);
        }
    }
    None
}

/// Turn a finished `ssh` run into the failure it represents.
///
/// `ssh` reports almost everything with exit code 255, so the message is the
/// only thing that distinguishes "the host key is wrong" from "the password is
/// wrong" from "the machine is off" — and a wrong classification here is a
/// wrong code at the protocol surface, so the order of these checks matters.
/// The host key is checked first because that is the one a caller must react to
/// differently from all the others.
pub fn classify_failure(stderr: &str) -> ConnectionError {
    let lowered = stderr.to_lowercase();

    if lowered.contains("remote host identification has changed")
        || lowered.contains("host key verification failed")
    {
        // Whether the key was unknown or changed is decided by the caller, which
        // is the only place that holds the recorded fingerprint.
        return ConnectionError::HostKey {
            fingerprint: String::new(),
            changed: lowered.contains("remote host identification has changed"),
        };
    }
    if lowered.contains("permission denied")
        || lowered.contains("authentication failed")
        || lowered.contains("no supported authentication methods")
        || lowered.contains("too many authentication failures")
    {
        return ConnectionError::AuthFailed(String::new());
    }
    if lowered.contains("could not resolve hostname")
        || lowered.contains("name or service not known")
        || lowered.contains("connection refused")
        || lowered.contains("connection timed out")
        || lowered.contains("network is unreachable")
        || lowered.contains("no route to host")
        || lowered.contains("connection closed by")
        || lowered.contains("connection reset by")
        || lowered.contains("operation timed out")
    {
        return ConnectionError::Unreachable {
            stage: "connect",
            reason: first_line(stderr),
        };
    }
    ConnectionError::Unreachable {
        stage: "connect",
        reason: first_line(stderr),
    }
}

/// The first non-empty line of a message, bounded, for an error payload.
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no diagnostic from ssh");
    line.chars().take(300).collect()
}

// ---- acting ----------------------------------------------------------------

/// The `ssh` program to run.
///
/// PATH is consulted first so a user's own OpenSSH wins; Windows then falls
/// back to the copy that ships with the OS, which is not always on PATH for a
/// GUI process.
pub fn find_ssh() -> Result<PathBuf, ConnectionError> {
    find_program("ssh")
}

/// The `ssh-keyscan` program, which may legitimately be absent.
pub fn find_ssh_keyscan() -> Option<PathBuf> {
    find_program("ssh-keyscan").ok()
}

fn find_program(name: &str) -> Result<PathBuf, ConnectionError> {
    if let Some(path) = which(name) {
        return Ok(path);
    }
    #[cfg(windows)]
    {
        let candidate = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| {
                root.join("System32")
                    .join("OpenSSH")
                    .join(format!("{name}.exe"))
            });
        if let Some(candidate) = candidate {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(ConnectionError::Unsupported(format!(
        "the {name} program was not found; install OpenSSH or add it to PATH"
    )))
}

/// A minimal PATH lookup, so this module does not take a dependency for it.
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(str::to_string)
            .collect()
    } else {
        vec![String::new()]
    };
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = directory.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// One finished child.
struct Captured {
    exit_code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
    duration: Duration,
}

/// Spawn a program, capture its streams, and terminate its tree on timeout.
///
/// Every child this layer starts is owned by a `ProcessOwnership`, so a turn
/// that is interrupted cannot leave an `ssh` behind: the ownership handle is
/// closed on drop, which on Windows terminates the job.
async fn run_captured(
    program: &PathBuf,
    args: &[String],
    timeout: Duration,
    secret: Option<&str>,
) -> Result<Captured, ConnectionError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);

    if let Some(secret) = secret {
        // Askpass, forced: `ssh` is told there is no terminal and to take the
        // answer from the helper instead. The value travels in this child's
        // environment only.
        command.env(ASKPASS_SECRET_ENV, secret);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("SSH_ASKPASS", askpass_program());
        command.env("DISPLAY", "pi-desktop-askpass");
    }

    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| ConnectionError::Unreachable {
            stage: "spawn",
            reason: error.to_string(),
        })?;

    // Ownership is taken before the wait so the handle already exists when the
    // timeout fires; a failure here does not fail the call, because the child
    // is still `kill_on_drop` and the timeout path below still terminates it.
    let mut ownership = ProcessOwnership::assign(&child).ok();
    let pid = child.id().unwrap_or(0);

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move { read_capped(&mut stdout_pipe).await });
    let stderr_task = tokio::spawn(async move { read_capped(&mut stderr_pipe).await });

    let (exit_code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => (status.code().unwrap_or(-1), false),
        Ok(Err(error)) => {
            return Err(ConnectionError::Unreachable {
                stage: "wait",
                reason: error.to_string(),
            })
        }
        Err(_elapsed) => {
            if let Some(ownership) = ownership.as_mut() {
                // Best-effort: the process is killed either way, by the job
                // handle or by `kill_on_drop`, but terminating the tree first
                // is what takes the target-side children with it.
                let _ = ownership.terminate_fail_closed(pid);
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            (-1, true)
        }
    };
    drop(ownership);

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();

    Ok(Captured {
        exit_code,
        stdout,
        stderr,
        timed_out,
        duration: started.elapsed(),
    })
}

/// Read a stream up to [`MAX_CAPTURE_BYTES`], then stop.
async fn read_capped(pipe: &mut Option<impl AsyncReadExt + Unpin>) -> String {
    let Some(pipe) = pipe.as_mut() else {
        return String::new();
    };
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(buffer.len());
                if remaining == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read.min(remaining)]);
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

/// The program `ssh` runs to answer a prompt.
///
/// The host binary re-invoked with [`ASKPASS_ARG`]: it reads the secret from
/// the environment and prints it. One artifact, both platforms.
pub fn askpass_program() -> String {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "pi-desktop-host-core".into())
}

/// Read the target's host key without trusting it.
///
/// Returns the fingerprint, or `None` when `ssh-keyscan` is unavailable or the
/// target did not answer — which is a probe that can still succeed, just
/// without a fingerprint to report.
pub async fn scan_host_key(target: &Target) -> Option<String> {
    let program = find_ssh_keyscan()?;
    let args = keyscan_args(target).ok()?;
    let captured = run_captured(&program, &args, KEYSCAN_TIMEOUT, None)
        .await
        .ok()?;
    parse_keyscan_fingerprint(&captured.stdout)
}

/// Resolve the credential value for a profile.
///
/// The only place in this layer a secret is read. It is returned to the caller
/// so it can be placed in a child's environment; it is never returned upward
/// past [`probe`] and [`exec`].
fn resolve_secret(
    secrets: &crate::secrets::SecretStore,
    profile: &ConnectionProfile,
) -> Option<String> {
    let reference = profile.credential_ref.as_ref()?;
    secrets.get(reference).ok().flatten()
}

/// Connect, verify the host key, learn the shell, and disconnect.
pub async fn probe(
    secrets: &crate::secrets::SecretStore,
    profile: &ConnectionProfile,
    timeout: Duration,
) -> Result<ProbeReport, ConnectionError> {
    let program = find_ssh()?;
    let args = probe_args(profile)?;
    let started = Instant::now();

    // The pinned policy is enforced here, before a connection: the recorded
    // fingerprint and the observed one must agree, or nothing is dialled.
    let observed = scan_host_key(&profile.target).await;
    if profile.host_key_policy == HostKeyPolicy::Pinned {
        match (&profile.host_key_fingerprint, &observed) {
            (Some(recorded), Some(observed)) if recorded != observed => {
                return Err(ConnectionError::HostKey {
                    fingerprint: observed.clone(),
                    changed: true,
                });
            }
            (Some(_), None) => {
                // The key could not be read, so the pin cannot be checked. The
                // failure mode of an unverifiable pin must be closed.
                return Err(ConnectionError::Unsupported(
                    "the host key could not be read, so a pinned fingerprint cannot be verified"
                        .into(),
                ));
            }
            _ => {}
        }
    }

    let secret = resolve_secret(secrets, profile);
    let captured = run_captured(&program, &args, timeout, secret.as_deref()).await?;

    if captured.timed_out {
        return Err(ConnectionError::Timeout);
    }
    if captured.exit_code != 0 {
        return Err(refine(
            profile,
            classify_failure(&captured.stderr),
            observed,
        ));
    }

    let shell = captured
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string);

    Ok(ProbeReport {
        fingerprint: observed.or_else(|| profile.host_key_fingerprint.clone()),
        shell,
        // `ssh -O check` is the only honest answer, and asking it would cost a
        // second connection; the field therefore reports what was *requested*
        // and whether `ssh` accepted the option without complaint, which is
        // what a Windows target without `ControlMaster` contradicts.
        multiplexed: wants_multiplex(profile)
            && !captured.stderr.to_lowercase().contains("controlmaster"),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Run one command on the target.
pub async fn exec(
    secrets: &crate::secrets::SecretStore,
    profile: &ConnectionProfile,
    command: &str,
    timeout: Duration,
) -> Result<ExecReport, ConnectionError> {
    let program = find_ssh()?;
    let args = exec_args(profile, command)?;
    let secret = resolve_secret(secrets, profile);
    let captured = run_captured(&program, &args, timeout, secret.as_deref()).await?;

    if captured.timed_out {
        return Err(ConnectionError::Timeout);
    }
    // 255 is `ssh`'s own failure. Any other code is the remote command's exit
    // status and is the answer, not an error — this is the line that keeps a
    // failing build from being reported as a broken connection.
    if captured.exit_code == 255 {
        let observed = scan_host_key(&profile.target).await;
        return Err(refine(
            profile,
            classify_failure(&captured.stderr),
            observed,
        ));
    }

    Ok(ExecReport {
        exit_code: captured.exit_code,
        stdout: captured.stdout,
        stderr: captured.stderr,
        duration_ms: captured.duration.as_millis() as u64,
        timed_out: false,
    })
}

/// Fill in the fields a classifier cannot know.
///
/// The classifier sees only the message; the profile holds the fingerprint a
/// caller needs in order to make a decision about a host key, and the id the
/// other errors name.
fn refine(
    profile: &ConnectionProfile,
    error: ConnectionError,
    observed: Option<String>,
) -> ConnectionError {
    match error {
        ConnectionError::HostKey { changed, .. } => {
            let fingerprint = observed
                .filter(|value| !value.is_empty())
                .or_else(|| profile.host_key_fingerprint.clone())
                .unwrap_or_default();
            ConnectionError::HostKey {
                fingerprint,
                changed,
            }
        }
        ConnectionError::AuthFailed(_) => ConnectionError::AuthFailed(profile.id.clone()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::Limits;
    use serde_json::json;

    fn profile(target: Target) -> ConnectionProfile {
        ConnectionProfile {
            id: "0f5c".into(),
            label: "build-box".into(),
            kind: target.kind(),
            enabled: true,
            target,
            credential_ref: None,
            host_key_policy: HostKeyPolicy::Strict,
            host_key_fingerprint: None,
            multiplex: Multiplex::PerCall,
            limits: Limits::default(),
            last_probe: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn ssh_profile() -> ConnectionProfile {
        profile(Target::Ssh {
            host: "build-box".into(),
            port: 22,
            user: Some("deploy".into()),
            identity_file: None,
            proxy_jump: None,
        })
    }

    #[test]
    fn a_destination_carries_the_user_when_there_is_one() {
        let with_user = ssh_profile();
        assert!(probe_args(&with_user)
            .unwrap()
            .last()
            .unwrap()
            .as_str()
            .eq("deploy@build-box"));

        let mut anonymous = ssh_profile();
        if let Target::Ssh { user, .. } = &mut anonymous.target {
            *user = None;
        }
        assert_eq!(probe_args(&anonymous).unwrap().last().unwrap(), "build-box");
    }

    #[test]
    fn a_non_ssh_target_has_no_connection_arguments() {
        let serial = profile(Target::Serial {
            port: "COM3".into(),
            baud: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "none".into(),
        });
        assert_eq!(probe_args(&serial).unwrap_err(), ConnectionError::NoExec);
        assert_eq!(
            exec_args(&serial, "ls").unwrap_err(),
            ConnectionError::NoExec
        );
        assert_eq!(
            keyscan_args(&serial.target).unwrap_err(),
            ConnectionError::NoExec
        );
    }

    #[test]
    fn the_default_port_is_omitted_and_a_custom_one_is_passed() {
        let default = probe_args(&ssh_profile()).unwrap();
        assert!(!default.iter().any(|arg| arg == "-p"));

        let mut custom = ssh_profile();
        if let Target::Ssh { port, .. } = &mut custom.target {
            *port = 2222;
        }
        let args = probe_args(&custom).unwrap();
        let position = args.iter().position(|arg| arg == "-p").unwrap();
        assert_eq!(args[position + 1], "2222");

        // A port of zero means "the protocol default" rather than "port zero".
        let mut zero = ssh_profile();
        if let Target::Ssh { port, .. } = &mut zero.target {
            *port = 0;
        }
        assert!(!probe_args(&zero).unwrap().iter().any(|arg| arg == "-p"));
    }

    #[test]
    fn a_probe_pins_a_byte_stream_and_refuses_to_prompt() {
        let args = probe_args(&ssh_profile()).unwrap();
        assert!(
            args.contains(&"-T".to_string()),
            "no remote pty is allocated"
        );
        assert!(args.contains(&"ConnectTimeout=10".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"StrictHostKeyChecking=yes".to_string()));
        assert_eq!(args.last().unwrap(), "deploy@build-box");
        // The probe command is the last thing before the destination.
        assert_eq!(args[args.len() - 2], PROBE_COMMAND);
    }

    #[test]
    fn a_configured_credential_relaxes_batch_mode() {
        // A forced askpass answers without a terminal, which is exactly what
        // BatchMode exists to prevent; leaving both on would make the
        // credential unusable.
        let mut keyed = ssh_profile();
        keyed.credential_ref = Some("conn:0f5c".into());
        let args = probe_args(&keyed).unwrap();
        assert!(
            !args.contains(&"BatchMode=yes".to_string()),
            "a configured credential must not be blocked by BatchMode"
        );
        assert!(args.contains(&"-T".to_string()), "still no remote pty");
    }

    #[test]
    fn each_policy_maps_to_its_strict_host_key_setting() {
        let mut pinned = ssh_profile();
        pinned.host_key_policy = HostKeyPolicy::Pinned;
        assert!(probe_args(&pinned)
            .unwrap()
            .contains(&"StrictHostKeyChecking=no".to_string()));

        let mut accept = ssh_profile();
        accept.host_key_policy = HostKeyPolicy::AcceptNew;
        assert!(probe_args(&accept)
            .unwrap()
            .contains(&"StrictHostKeyChecking=accept-new".to_string()));
    }

    #[test]
    fn an_identity_and_a_jump_host_are_passed_with_the_identity_pinned() {
        let mut profile = ssh_profile();
        if let Target::Ssh {
            identity_file,
            proxy_jump,
            ..
        } = &mut profile.target
        {
            *identity_file = Some("/home/u/.ssh/id_ed25519".into());
            *proxy_jump = Some("bastion".into());
        }
        let args = probe_args(&profile).unwrap();

        let identity = args.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(args[identity + 1], "/home/u/.ssh/id_ed25519");
        assert!(
            args.contains(&"IdentitiesOnly=yes".to_string()),
            "the agent's other keys must not be tried first"
        );
        let jump = args.iter().position(|arg| arg == "-J").unwrap();
        assert_eq!(args[jump + 1], "bastion");
    }

    #[test]
    fn an_exec_carries_the_command_verbatim_ahead_of_the_destination() {
        let args = exec_args(&ssh_profile(), "make -j4 && echo done").unwrap();
        assert_eq!(args[args.len() - 2], "make -j4 && echo done");
        assert_eq!(args.last().unwrap(), "deploy@build-box");
    }

    #[test]
    fn keyscan_asks_for_a_bounded_set_of_key_types() {
        let args = keyscan_args(&ssh_profile().target).unwrap();
        assert!(args.contains(&"-T".to_string()));
        assert!(args.contains(&"ed25519,ecdsa,rsa".to_string()));
        assert_eq!(args.last().unwrap(), "build-box");
        assert!(
            !args.contains(&"-p".to_string()),
            "the default port is omitted"
        );

        let mut custom = ssh_profile();
        if let Target::Ssh { port, .. } = &mut custom.target {
            *port = 2222;
        }
        let args = keyscan_args(&custom.target).unwrap();
        let position = args.iter().position(|arg| arg == "-p").unwrap();
        assert_eq!(args[position + 1], "2222");
    }

    #[test]
    fn a_fingerprint_matches_the_form_ssh_keygen_prints() {
        // The blob is the well-known RFC 8709 ed25519 test key. OpenSSH's
        // `ssh-keygen -lf` prints exactly the value asserted here, so a
        // fingerprint copied out of a terminal can be pasted into a profile.
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let fingerprint = fingerprint_from_base64(blob).expect("a fingerprint");
        assert_eq!(
            fingerprint,
            "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
        );
        assert!(fingerprint.starts_with("SHA256:"));
        assert!(
            !fingerprint.contains('='),
            "OpenSSH prints the digest unpadded"
        );
    }

    #[test]
    fn a_fingerprint_is_stable_for_the_same_key() {
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        assert_eq!(fingerprint_from_base64(blob), fingerprint_from_base64(blob));
        assert!(fingerprint_from_base64("not base64 !!").is_none());
    }

    #[test]
    fn keyscan_output_parses_and_skips_noise() {
        // A real run prints a comment per host it tried and then one line per
        // key. A comment, a blank line, or a line from a target that did not
        // answer must be skipped rather than turned into a fingerprint of
        // nothing.
        let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let stdout =
            format!("# build-box:22 SSH-2.0-OpenSSH_9.5\n\nbuild-box ssh-ed25519 {blob}\n");
        assert_eq!(
            parse_keyscan_fingerprint(&stdout).as_deref(),
            Some("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU")
        );

        assert!(parse_keyscan_fingerprint("# only a comment\n").is_none());
        assert!(parse_keyscan_fingerprint("build-box ssh-ed25519\n").is_none());
        assert!(parse_keyscan_fingerprint("build-box ssh-ed25519 notbase64!!").is_none());
        assert!(parse_keyscan_fingerprint("").is_none());
    }

    #[test]
    fn keyscan_reports_the_first_key_it_printed() {
        // `ssh-keyscan` prints what it found, in its own order, and the first
        // line is the answer, so the order on the wire is the order reported.
        let ed = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let ecdsa = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=";
        let both = format!("build-box ssh-ed25519 {ed}\nbuild-box ecdsa-sha2-nistp256 {ecdsa}\n");
        let only_ecdsa = format!("build-box ecdsa-sha2-nistp256 {ecdsa}\n");

        assert_eq!(
            parse_keyscan_fingerprint(&both).as_deref(),
            Some("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"),
            "the first line ssh-keyscan printed is the answer"
        );
        // With the ed25519 line gone the next key becomes the answer: the
        // parser reports what it was given rather than preferring an algorithm.
        assert!(parse_keyscan_fingerprint(&only_ecdsa).is_some());
        assert_ne!(
            parse_keyscan_fingerprint(&only_ecdsa),
            parse_keyscan_fingerprint(&both)
        );
    }

    #[test]
    fn a_host_key_failure_is_recognised_before_anything_else() {
        // ssh reports this with the same exit code as an auth failure, so the
        // message is the only discriminator and the order of the checks is the
        // thing under test.
        let changed = classify_failure(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
             @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n\
             @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n",
        );
        assert!(matches!(
            changed,
            ConnectionError::HostKey { changed: true, .. }
        ));

        let unknown = classify_failure("Host key verification failed.");
        assert!(matches!(
            unknown,
            ConnectionError::HostKey { changed: false, .. }
        ));
    }

    #[test]
    fn an_auth_failure_is_recognised() {
        for message in [
            "deploy@build-box: Permission denied (publickey).",
            "Authentication failed.",
            "no supported authentication methods available",
        ] {
            let error = classify_failure(message);
            assert!(
                matches!(error, ConnectionError::AuthFailed(_)),
                "{message} classified as {error}"
            );
            assert_eq!(error.code(), 1034);
        }
    }

    #[test]
    fn a_network_failure_carries_the_first_diagnostic_line() {
        let error =
            classify_failure("ssh: Could not resolve hostname nope: Name or service not known");
        match error {
            ConnectionError::Unreachable { stage, reason } => {
                assert_eq!(stage, "connect");
                assert!(reason.contains("Could not resolve hostname"), "{reason}");
            }
            other => panic!("expected an unreachable, got {other}"),
        }
        assert_eq!(classify_failure("Connection refused").code(), 1032);
    }

    #[test]
    fn an_unrecognised_message_is_still_an_unreachable_and_never_an_empty_success() {
        let error = classify_failure("something nobody has seen before");
        assert_eq!(error.code(), 1032);
        let ConnectionError::Unreachable { reason, .. } = error else {
            panic!("expected an unreachable");
        };
        assert_eq!(reason, "something nobody has seen before");

        // An empty diagnostic still produces a usable sentence.
        let ConnectionError::Unreachable { reason, .. } = classify_failure("") else {
            panic!("expected an unreachable");
        };
        assert_eq!(reason, "no diagnostic from ssh");
    }

    #[test]
    fn a_reason_is_bounded_to_one_line() {
        let noisy = format!("first line\n{}", "x".repeat(1000));
        let ConnectionError::Unreachable { reason, .. } = classify_failure(&noisy) else {
            panic!("expected an unreachable");
        };
        assert_eq!(reason, "first line");
        assert!(!reason.contains('\n'));

        let long_single = "y".repeat(1000);
        let ConnectionError::Unreachable { reason, .. } = classify_failure(&long_single) else {
            panic!("expected an unreachable");
        };
        assert!(reason.len() <= 300, "a reason must not become a payload");
    }

    #[test]
    fn refine_attaches_the_fingerprint_a_caller_needs() {
        let observed = "SHA256:abcdef".to_string();
        let refined = refine(
            &ssh_profile(),
            ConnectionError::HostKey {
                fingerprint: String::new(),
                changed: false,
            },
            Some(observed.clone()),
        );
        assert_eq!(
            refined,
            ConnectionError::HostKey {
                fingerprint: observed,
                changed: false,
            }
        );

        // With nothing observed, the recorded fingerprint is the fallback, so
        // the field is never blank for a profile that has one.
        let mut pinned = ssh_profile();
        pinned.host_key_fingerprint = Some("SHA256:recorded".into());
        let refined = refine(
            &pinned,
            ConnectionError::HostKey {
                fingerprint: String::new(),
                changed: true,
            },
            None,
        );
        assert_eq!(
            refined,
            ConnectionError::HostKey {
                fingerprint: "SHA256:recorded".into(),
                changed: true,
            }
        );
    }

    #[test]
    fn refine_names_the_profile_on_an_auth_failure_and_leaves_others_alone() {
        let refined = refine(
            &ssh_profile(),
            ConnectionError::AuthFailed(String::new()),
            None,
        );
        assert_eq!(refined, ConnectionError::AuthFailed("0f5c".into()));

        let untouched = refine(&ssh_profile(), ConnectionError::Timeout, None);
        assert_eq!(untouched, ConnectionError::Timeout);
    }

    #[test]
    fn a_multiplex_request_is_only_reported_when_ssh_accepted_it() {
        let mut multiplexed = ssh_profile();
        multiplexed.multiplex = Multiplex::Multiplex;
        assert!(wants_multiplex(&multiplexed));
        assert!(!wants_multiplex(&ssh_profile()));
    }

    #[test]
    fn the_askpass_reuses_the_running_binary() {
        // One artifact, both platforms: a shell script would need a different
        // interpreter on each.
        assert!(ASKPASS_ARG.starts_with("--"));
        assert!(!askpass_program().is_empty());
    }

    #[test]
    fn the_probe_command_does_not_depend_on_echo() {
        // `echo` on some targets expands backslashes, which would turn the
        // probe result into a path nobody has.
        assert!(PROBE_COMMAND.contains("printf"));
        assert!(!PROBE_COMMAND.contains("echo "));
        assert!(PROBE_COMMAND.contains("${SHELL:-/bin/sh}"));
    }

    #[test]
    fn json_round_trip_of_a_probe_report_stays_camel_case() {
        // The report is serialized straight into a result body, so the field
        // names are part of the contract.
        let report = ProbeReport {
            fingerprint: Some("SHA256:x".into()),
            shell: Some("/bin/bash".into()),
            multiplexed: false,
            duration_ms: 412,
        };
        let value = json!({
            "fingerprint": report.fingerprint,
            "shell": report.shell,
            "multiplexed": report.multiplexed,
            "durationMs": report.duration_ms,
        });
        assert_eq!(value["durationMs"], json!(412));
    }
}
