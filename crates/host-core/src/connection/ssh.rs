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
mod tests;
