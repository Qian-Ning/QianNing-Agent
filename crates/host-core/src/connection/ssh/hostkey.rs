//! Reading a target's host keys, and naming their fingerprints.
//!
//! A host offers one key per algorithm, and which of them a connection negotiates
//! is not ours to choose. Everything here exists to obtain those keys without
//! trusting them first, to name them in the `SHA256:` form a person can compare
//! against what their own `ssh` prints, and to say what a recorded fingerprint
//! means against what the host offers.
//!
//! An empty answer is a result, not an absence of one: it means the keys could not
//! be read, and a caller that needs a key must treat it as such.

use super::*;

/// The fingerprints the target offers, one per key algorithm, in the order it
/// reported them.
///
/// `ssh` is asked first. It is the same program the connection itself will use, so
/// a build whose `ssh-keyscan` cannot negotiate with the target — which is what the
/// Windows build does against an older server — still reports its keys, and where
/// both work `ssh` is also the faster of the two. `ssh-keyscan` is the fallback for
/// a target that answers a scan but not a connection.
///
/// An empty answer is meaningful and stays empty: a caller that needs a key reads
/// it as "could not be read", never as "no key is required".
pub async fn scan_host_keys(target: &Target) -> Vec<String> {
    let announced = announced_host_keys(target).await;
    if !announced.is_empty() {
        return announced;
    }

    if let Some(program) = find_ssh_keyscan() {
        if let Ok(args) = keyscan_args(target) {
            if let Ok(captured) = run_captured(&program, &args, KEYSCAN_TIMEOUT, None).await {
                return parse_keyscan_fingerprints(&captured.stdout);
            }
        }
    }
    Vec::new()
}

/// The argv that has `ssh` report the target's keys into `known_hosts`.
///
/// Kept separate from the spawn so the two properties that matter can be asserted
/// without a network: every authentication method is refused, so the run cannot
/// offer a credential of ours or reach for a key file, and only the known-hosts
/// file named here is read afterwards.
pub fn announced_host_key_args(
    target: &Target,
    known_hosts: &std::path::Path,
) -> Result<Vec<String>, ConnectionError> {
    let mut args = base_options(false);
    args.push("-o".into());
    args.push(format!("UserKnownHostsFile={}", known_hosts.display()));
    args.push("-o".into());
    args.push("GlobalKnownHostsFile=none".into());
    args.push("-o".into());
    args.push("StrictHostKeyChecking=accept-new".into());
    args.push("-o".into());
    args.push("PreferredAuthentications=none".into());
    args.push("-p".into());
    args.push(ssh_port(target)?.to_string());
    args.push(destination(target)?);
    // The command is only here because `ssh` needs one; the connection refuses to
    // authenticate before it could ever run.
    args.push("true".into());
    Ok(args)
}

/// The target's keys, read by `ssh` itself.
///
/// The host key is exchanged before any credential is, so a connection that
/// refuses every authentication method still reports the key it was offered — and
/// it offers nothing of ours, because it has nothing to offer. What `ssh` learned
/// lands in a known-hosts file of our own inside a `0700` directory, which is read
/// and then removed with the directory.
async fn announced_host_keys(target: &Target) -> Vec<String> {
    let program = match find_ssh() {
        Ok(program) => program,
        Err(_) => return Vec::new(),
    };
    let staging = match StagingDir::create("hostkey") {
        Ok(staging) => staging,
        Err(_) => return Vec::new(),
    };
    let known_hosts = staging.path().join("known_hosts");
    let args = match announced_host_key_args(target, &known_hosts) {
        Ok(args) => args,
        Err(_) => return Vec::new(),
    };

    // A non-zero exit is expected and is not a failure here: authentication was
    // refused on purpose, and the key had already been exchanged by then.
    let _ = run_captured(&program, &args, KEYSCAN_TIMEOUT, None).await;
    match std::fs::read_to_string(&known_hosts) {
        Ok(text) => parse_keyscan_fingerprints(&text),
        Err(_) => Vec::new(),
    }
}

/// A `0700` directory under the platform temp directory, removed when it is dropped.
///
/// The mode is part of the creation call on unix and absent on Windows, where the
/// effective boundary is the same-user ACL either way.
struct StagingDir {
    dir: PathBuf,
}

impl StagingDir {
    fn create(tag: &str) -> Result<Self, ConnectionError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("pi-desktop-{tag}-{}-{nanos}", std::process::id()));

        #[cfg(unix)]
        let created = {
            use std::os::unix::fs::DirBuilderExt as _;
            std::fs::DirBuilder::new().mode(0o700).create(&dir)
        };
        #[cfg(not(unix))]
        let created = std::fs::DirBuilder::new().create(&dir);
        created.map_err(|err| ConnectionError::Unsupported(format!("staging directory: {err}")))?;

        Ok(Self { dir })
    }

    fn path(&self) -> &std::path::Path {
        &self.dir
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        // Best effort: a leaked file would still sit inside a `0700` directory,
        // and the OS temp directory reclaims it.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// What a pinned profile's recorded fingerprint means against what the host offers.
///
/// A host offers one key per algorithm and the recorded value may have been
/// learned from any of them — the fingerprint `ssh` announces while refusing is
/// whichever algorithm that connection negotiated, and a scan reports its own
/// order — so a pin holds when the recorded value is *among* the offered keys.
/// Comparing against a single entry is what turns an unchanged host into a
/// reported key change that no acceptance can clear.
pub enum PinOutcome {
    /// Nothing recorded, so there is no pin to enforce.
    NotEnforced,
    /// The recorded key is one of the keys the host offers.
    Holds,
    /// The host no longer offers the accepted key.
    Changed { fingerprint: String },
    /// The keys could not be read, so the pin cannot be checked at all.
    Unreadable,
}

pub fn pin_outcome(recorded: Option<&str>, observed: &[String]) -> PinOutcome {
    let recorded = match recorded {
        Some(recorded) => recorded,
        None => return PinOutcome::NotEnforced,
    };
    if observed.is_empty() {
        return PinOutcome::Unreadable;
    }
    if observed.iter().any(|seen| seen == recorded) {
        return PinOutcome::Holds;
    }
    let changed = match observed.first() {
        Some(fingerprint) => fingerprint.clone(),
        None => return PinOutcome::Unreadable,
    };
    PinOutcome::Changed {
        fingerprint: changed,
    }
}

/// Take the scan's answer if it is already there, and let it go if it is not.
///
/// Waiting for it is what this refuses to do: on a build whose `ssh` cannot reach
/// the target the scan spends its whole budget and comes back with nothing, and a
/// probe that waited would pay that on every call. The task is aborted rather than
/// detached, and `kill_on_drop` ends the child with it.
pub async fn collect_scan(scanning: Option<tokio::task::JoinHandle<Vec<String>>>) -> Vec<String> {
    match scanning {
        Some(handle) if handle.is_finished() => handle.await.unwrap_or_default(),
        Some(handle) => {
            handle.abort();
            Vec::new()
        }
        None => Vec::new(),
    }
}

/// Wait for the scan, bounded by the scan's own budget.
///
/// Used only where the answer is load-bearing: a refusal names the fingerprint a
/// person has to accept, and a report with no recorded fingerprint has no other
/// source for the one it publishes.
pub async fn await_scan(scanning: Option<tokio::task::JoinHandle<Vec<String>>>) -> Vec<String> {
    match scanning {
        Some(handle) => handle.await.unwrap_or_default(),
        None => Vec::new(),
    }
}
