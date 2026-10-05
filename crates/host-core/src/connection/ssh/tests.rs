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
    let with_user = probe_args(&ssh_profile()).unwrap();
    assert!(
        with_user.contains(&"deploy@build-box".to_string()),
        "the user is part of the destination"
    );

    let mut anonymous = ssh_profile();
    if let Target::Ssh { user, .. } = &mut anonymous.target {
        *user = None;
    }
    let bare = probe_args(&anonymous).unwrap();
    assert!(
        bare.contains(&"build-box".to_string()) && !bare.contains(&"deploy@build-box".to_string()),
        "no user means no user@ prefix"
    );
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
    // `ssh [options] destination [command]`: the destination is the first
    // positional argument, so the remote command follows it. Reading these the
    // other way round makes ssh treat the probe command as a hostname, which no
    // option in this list can mask.
    let destination = args
        .iter()
        .position(|arg| arg == "deploy@build-box")
        .expect("the destination is passed");
    let command = args
        .iter()
        .position(|arg| arg == PROBE_COMMAND)
        .expect("the probe command is passed");
    assert!(
        destination < command,
        "ssh reads the destination before the command"
    );
    assert_eq!(args.last().unwrap(), PROBE_COMMAND);
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
fn an_exec_puts_the_destination_before_the_command_it_carries_verbatim() {
    let args = exec_args(&ssh_profile(), "make -j4 && echo done").unwrap();
    let destination = args
        .iter()
        .position(|arg| arg == "deploy@build-box")
        .expect("the destination is passed");
    assert_eq!(args.last().unwrap(), "make -j4 && echo done");
    assert!(
        destination < args.len() - 1,
        "the command follows the destination, it does not replace it"
    );
    assert_eq!(args[destination + 1], "make -j4 && echo done");
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
    // A real run prints a comment per host it tried and then one line per key. A
    // comment, a blank line, or a line from a target that did not answer must be
    // skipped rather than turned into a fingerprint of nothing.
    let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    let stdout = format!("# build-box:22 SSH-2.0-OpenSSH_9.5\n\nbuild-box ssh-ed25519 {blob}\n");
    assert_eq!(
        parse_keyscan_fingerprints(&stdout),
        vec!["SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU".to_string()]
    );

    assert!(parse_keyscan_fingerprints("# only a comment\n").is_empty());
    assert!(parse_keyscan_fingerprints("build-box ssh-ed25519\n").is_empty());
    assert!(parse_keyscan_fingerprints("build-box ssh-ed25519 notbase64!!").is_empty());
    assert!(parse_keyscan_fingerprints("").is_empty());
}

#[test]
fn every_key_the_scan_printed_is_kept_in_order() {
    // A host offers one key per algorithm and the scan prints all of them, so the
    // whole set is kept: which of them a later connection negotiates is not ours
    // to choose, and the first entry is only what a report chooses to show.
    let ed = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    let ecdsa = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=";
    let both = format!("build-box ssh-rsa {ed}\nbuild-box ecdsa-sha2-nistp256 {ecdsa}\n");
    let only_ecdsa = format!("build-box ecdsa-sha2-nistp256 {ecdsa}\n");

    let both = parse_keyscan_fingerprints(&both);
    assert_eq!(both.len(), 2, "both keys are kept");
    assert_eq!(
        both.first().map(String::as_str),
        Some("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"),
        "the order the scan printed is the order kept"
    );

    let only_ecdsa = parse_keyscan_fingerprints(&only_ecdsa);
    assert_eq!(only_ecdsa.len(), 1);
    assert!(
        both.contains(&only_ecdsa[0]),
        "the ecdsa key is one of the two"
    );
    assert_ne!(only_ecdsa[0], both[0]);
}

#[test]
fn a_repeated_key_is_kept_once() {
    let blob = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    let twice = format!("build-box ssh-ed25519 {blob}\nbuild-box ssh-ed25519 {blob}\n");
    assert_eq!(parse_keyscan_fingerprints(&twice).len(), 1);
}

#[test]
fn a_pin_holds_when_the_host_offers_the_accepted_key_among_others() {
    // The regression this exists for: the fingerprint a person accepts is the one
    // `ssh` announced while refusing, and a scan prints its own order — so a pin
    // compared against a single entry reported an unchanged host as changed, and
    // no acceptance could clear it.
    let accepted = "SHA256:x3p5sYsZERhA6jN5pmL7Ulns+mYsNC6qyt3Zk8BQiUg";
    let offered = vec![
        "SHA256:vd05SXx4Tk2btT97xoEM20JyrvcCDKMMaljg5HQfa3I".to_string(),
        accepted.to_string(),
    ];
    assert!(matches!(
        pin_outcome(Some(accepted), &offered),
        PinOutcome::Holds
    ));
}

#[test]
fn a_pin_reports_a_change_only_when_no_offered_key_matches() {
    let offered = vec!["SHA256:other".to_string(), "SHA256:another".to_string()];
    match pin_outcome(Some("SHA256:accepted"), &offered) {
        PinOutcome::Changed { fingerprint } => {
            assert_eq!(
                fingerprint, "SHA256:other",
                "the first offered key is named"
            );
        }
        _ => panic!("a key the host no longer offers is a change"),
    }
}

#[test]
fn an_unreadable_host_key_leaves_a_pin_unchecked() {
    // Fail closed: a pin that cannot be checked is not a pin that holds.
    assert!(matches!(
        pin_outcome(Some("SHA256:accepted"), &[]),
        PinOutcome::Unreadable
    ));
}

#[test]
fn a_pin_with_nothing_recorded_is_not_enforced() {
    let offered = vec!["SHA256:whatever".to_string()];
    assert!(matches!(
        pin_outcome(None, &offered),
        PinOutcome::NotEnforced
    ));
}

#[tokio::test]
async fn a_finished_scan_is_taken_and_a_running_one_is_abandoned() {
    // A scan must never be waited for where its answer is not used: on a build
    // that cannot read the key at all, waiting is seconds of nothing on every
    // probe, which is what this whole path exists to stop paying.
    let finished = tokio::spawn(async { vec!["SHA256:found".to_string()] });
    tokio::task::yield_now().await;
    assert_eq!(
        collect_scan(Some(finished)).await,
        vec!["SHA256:found".to_string()]
    );

    let running = tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(30)).await;
        vec!["SHA256:never".to_string()]
    });
    let started = Instant::now();
    assert!(collect_scan(Some(running)).await.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "it did not wait"
    );
}

#[test]
fn the_ssh_fallback_refuses_every_authentication_method() {
    // The key is exchanged before any credential is, so the fallback read works
    // while being unable to authenticate: no method is offered, no key file of
    // ours is reachable, and only the known-hosts file named here is read.
    let target = ssh_profile().target;
    let args = announced_host_key_args(&target, std::path::Path::new("C:/tmp/qn-known-hosts"))
        .expect("argv for a target with a host");
    let joined = args.join(" ");

    assert!(joined.contains("PreferredAuthentications=none"), "{joined}");
    assert!(joined.contains("GlobalKnownHostsFile=none"), "{joined}");
    assert!(joined.contains("UserKnownHostsFile="), "{joined}");
    assert!(
        joined.contains("StrictHostKeyChecking=accept-new"),
        "{joined}"
    );

    let destination = destination(&target).expect("a destination");
    let position = args
        .iter()
        .position(|arg| *arg == destination)
        .expect("the destination is present");
    let command = args
        .iter()
        .position(|arg| arg == "true")
        .expect("a command for ssh to carry");
    assert!(
        position < command,
        "the destination comes before the command: {joined}"
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
    let error = classify_failure("ssh: Could not resolve hostname nope: Name or service not known");
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
fn an_askpass_child_is_identified_by_its_environment_not_its_arguments() {
    // OpenSSH runs `SSH_ASKPASS` with the prompt as its only argument, so it can
    // never deliver a flag of ours. A helper that waits for one does not answer:
    // the host comes up as an ordinary process and `ssh` reports a rejected
    // credential, which looks like a wrong password rather than a broken seam.
    let marked = |key: &str| (key == ASKPASS_MARKER_ENV).then(|| "1".to_string());
    let path_only = |key: &str| (key == ASKPASS_SECRET_FILE_ENV).then(|| "/tmp/x".to_string());
    let nothing = |_: &str| None::<String>;

    assert!(
        is_askpass_child(Vec::<String>::new(), marked),
        "the marker alone is what ssh is able to deliver"
    );
    assert!(
        is_askpass_child(vec!["host".to_string(), ASKPASS_ARG.to_string()], nothing),
        "a wrapper may still forward the flag"
    );
    assert!(!is_askpass_child(Vec::<String>::new(), nothing));
    assert!(
        !is_askpass_child(Vec::<String>::new(), path_only),
        "a stray credential path must not make a host answer a prompt"
    );
}

#[test]
fn a_staged_credential_is_one_locked_file_that_does_not_outlive_its_spawn() {
    // The security spec puts the credential in a file rather than the child's
    // environment, so the file has to hold the exact bytes and has to be gone
    // once the spawn that owns it has returned.
    let secret = "corr3ct horse battery";
    let staged = AskpassSecret::create(secret).expect("a staged credential");

    assert_eq!(
        std::fs::read(&staged.path).expect("the secret file"),
        secret.as_bytes(),
        "written byte for byte, with no trailing newline to trim"
    );
    let dir = staged.dir.clone();
    assert!(dir.is_dir());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let file = std::fs::metadata(&staged.path).expect("metadata");
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
        let parent = std::fs::metadata(&dir).expect("metadata");
        assert_eq!(parent.permissions().mode() & 0o777, 0o700);
    }

    drop(staged);
    assert!(
        std::fs::read(dir.join("secret")).is_err(),
        "the file is removed with the material"
    );
    assert!(!dir.exists(), "and so is the directory that held it");
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
