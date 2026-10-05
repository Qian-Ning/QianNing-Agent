use super::*;
use serde_json::json;

fn fresh_state() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let data_dir = tempfile::tempdir().expect("a data dir");
    let app_state = AppState::open(data_dir.path()).expect("opens");
    (data_dir, Arc::new(Mutex::new(app_state)))
}

fn write_setting(state: &Arc<Mutex<AppState>>, value: Value) {
    let st = state.try_lock().expect("uncontended");
    st.db.set_setting("app", &value).expect("writes");
}

fn switched_on() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
    let (dir, state) = fresh_state();
    write_setting(&state, json!({ REMOTE_CONTROL_SETTING: true }));
    (dir, state)
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    args: Value,
) -> Result<Value, JsonRpcError> {
    handle(state, method, args).await
}

fn code_of(result: Result<Value, JsonRpcError>) -> i64 {
    result.expect_err("an error").code
}

fn audit_rows(state: &Arc<Mutex<AppState>>) -> Vec<Value> {
    let st = state.try_lock().expect("uncontended");
    let mut statement = st
        .db
        .conn()
        .prepare("SELECT ts, payload_json FROM audit_log WHERE kind = ?1 ORDER BY id")
        .expect("prepares");
    statement
        .query_map(rusqlite::params![AUDIT_KIND], |row| {
            let ts: i64 = row.get(0)?;
            let raw: String = row.get(1)?;
            Ok((ts, raw))
        })
        .expect("queries")
        .filter_map(Result::ok)
        .map(|(_ts, raw)| serde_json::from_str::<Value>(&raw).expect("valid JSON"))
        .collect()
}

async fn create_profile(state: &Arc<Mutex<AppState>>, label: &str) -> String {
    let created = call(
        state,
        "connection.create",
        json!({
            "label": label,
            "kind": "ssh",
            "target": { "kind": "ssh", "host": "build-box", "port": 22, "user": "deploy" },
        }),
    )
    .await
    .expect("creates");
    created["id"].as_str().expect("an id").to_string()
}

async fn enable(state: &Arc<Mutex<AppState>>, id: &str) {
    call(
        state,
        "connection.setEnabled",
        json!({ "profileId": id, "enabled": true }),
    )
    .await
    .expect("enables");
}

#[test]
fn the_switch_defaults_to_off() {
    let (_dir, state) = fresh_state();
    let st = state.try_lock().expect("uncontended");
    assert!(
        !switch_enabled_in(&st),
        "a store that never touched the setting reads as off"
    );
}

#[test]
fn a_store_that_cannot_be_read_reads_as_off() {
    // The failure mode of an unavailable gate must be closed, never open.
    let (_dir, state) = fresh_state();
    {
        let st = state.try_lock().expect("uncontended");
        st.db
            .set_setting("app", &json!("not an object"))
            .expect("writes a broken document");
        assert!(!switch_enabled_in(&st));
        st.db
            .set_setting("app", &json!({ REMOTE_CONTROL_SETTING: "yes" }))
            .expect("writes");
        assert!(!switch_enabled_in(&st), "a non-boolean is not a yes");
        st.db
            .set_setting("app", &json!({ REMOTE_CONTROL_SETTING: false }))
            .expect("writes");
        assert!(!switch_enabled_in(&st));
    }
}

#[tokio::test]
async fn every_agent_facing_method_is_closed_while_the_switch_is_off() {
    // Acceptance criterion 2: with the switch off, no Agent-facing method
    // succeeds. The three share one predicate, so they share one code.
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    enable(&state, &id).await;

    write_setting(&state, json!({ REMOTE_CONTROL_SETTING: false }));
    for (method, args) in [
        ("connection.list", json!({})),
        ("connection.probe", json!({ "profileId": id.clone() })),
        (
            "connection.exec",
            json!({ "profileId": id.clone(), "command": "true" }),
        ),
    ] {
        assert_eq!(
            code_of(call(&state, method, args).await),
            1029,
            "{method} must be closed while the switch is off"
        );
    }
}

#[tokio::test]
async fn a_refused_call_still_leaves_an_audit_row() {
    // A security-relevant refusal is worth recording: the row is how the
    // user learns something tried.
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    enable(&state, &id).await;
    write_setting(&state, json!({ REMOTE_CONTROL_SETTING: false }));
    let _ = call(&state, "connection.probe", json!({ "profileId": id })).await;

    let refusals: Vec<Value> = audit_rows(&state)
        .into_iter()
        .filter(|row| row["outcome"] == json!("refused"))
        .collect();
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0]["action"], json!("probe"));
    assert_eq!(refusals[0]["errorCode"], json!("CONNECTION_DISABLED"));
    assert_eq!(refusals[0]["profileId"], json!(id));
}

#[tokio::test]
async fn a_disabled_profile_is_refused_with_its_own_code_and_others_still_work() {
    // Acceptance criterion 3.
    let (_dir, state) = switched_on();
    let enabled = create_profile(&state, "alpha").await;
    let disabled = create_profile(&state, "beta").await;
    enable(&state, &enabled).await;

    let listing = call(&state, "connection.list", json!({}))
        .await
        .expect("lists");
    let profiles = listing["profiles"].as_array().expect("an array");
    assert_eq!(profiles.len(), 1, "only the enabled profile is listed");
    assert_eq!(profiles[0]["id"], json!(enabled));

    assert_eq!(
        code_of(
            call(
                &state,
                "connection.exec",
                json!({ "profileId": disabled, "command": "true" })
            )
            .await
        ),
        1031
    );
}

#[tokio::test]
async fn an_unknown_profile_id_is_not_found_rather_than_disabled() {
    // The two remedies differ, so the two codes differ.
    let (_dir, state) = switched_on();
    assert_eq!(
        code_of(call(&state, "connection.probe", json!({ "profileId": "nope" })).await),
        1030
    );
}

#[tokio::test]
async fn exec_against_a_streaming_transport_is_refused_before_dialling() {
    // Acceptance criterion 9: refused by name, without a connection.
    let (_dir, state) = switched_on();
    let created = call(
        &state,
        "connection.create",
        json!({
            "label": "console",
            "kind": "raw-tcp",
            "target": { "kind": "raw-tcp", "host": "10.0.0.5", "port": 9000 },
        }),
    )
    .await
    .expect("creates");
    let id = created["id"].as_str().expect("an id").to_string();
    enable(&state, &id).await;

    assert_eq!(
        code_of(
            call(
                &state,
                "connection.exec",
                json!({ "profileId": id, "command": "ls" })
            )
            .await
        ),
        1037
    );
}

#[tokio::test]
async fn a_created_profile_is_disabled_and_the_agent_view_hides_the_target() {
    // Acceptance criteria 4 and 8, from the shape of the two views.
    let (_dir, state) = switched_on();
    let created = call(
        &state,
        "connection.create",
        json!({
            "label": "build-box",
            "kind": "ssh",
            "target": { "kind": "ssh", "host": "secret.internal", "port": 22 },
        }),
    )
    .await
    .expect("creates");

    assert_eq!(
        created["enabled"],
        json!(false),
        "a new target is not reachable"
    );
    assert_eq!(created["credentialConfigured"], json!(false));
    assert_eq!(created["hostKeyPolicy"], json!("strict"));
    assert_eq!(created["multiplex"], json!("per-call"));
    // The user view carries the address; the agent view does not.
    assert_eq!(created["target"]["host"], json!("secret.internal"));

    let id = created["id"].as_str().expect("an id");
    enable(&state, id).await;
    let listing = call(&state, "connection.list", json!({}))
        .await
        .expect("lists");
    let agent_view = &listing["profiles"][0];
    assert!(
        agent_view.get("target").is_none(),
        "the agent view must not publish the address"
    );
    assert!(agent_view.get("credentialRef").is_none());
    assert!(agent_view.get("limits").is_none());
    assert!(!listing.to_string().contains("secret.internal"));
}

#[tokio::test]
async fn a_duplicate_label_is_refused_case_insensitively() {
    let (_dir, state) = switched_on();
    create_profile(&state, "Build-Box").await;
    let second = call(
        &state,
        "connection.create",
        json!({
            "label": "build-box",
            "kind": "ssh",
            "target": { "kind": "ssh", "host": "other", "port": 22 },
        }),
    )
    .await;
    assert_eq!(code_of(second), -32602);
}

#[tokio::test]
async fn a_pinned_policy_without_a_fingerprint_is_refused_at_write_time() {
    // Refused where the mistake is made, not later when the user is trying
    // to reach the machine.
    let (_dir, state) = switched_on();
    let refused = call(
        &state,
        "connection.create",
        json!({
            "label": "pinned-box",
            "kind": "ssh",
            "hostKeyPolicy": "pinned",
            "target": { "kind": "ssh", "host": "box", "port": 22 },
        }),
    )
    .await;
    assert_eq!(code_of(refused), -32602);

    let accepted = call(
        &state,
        "connection.create",
        json!({
            "label": "pinned-box",
            "kind": "ssh",
            "hostKeyPolicy": "pinned",
            "hostKeyFingerprint": "SHA256:abc",
            "target": { "kind": "ssh", "host": "box", "port": 22 },
        }),
    )
    .await
    .expect("creates");
    assert_eq!(accepted["hostKeyPolicy"], json!("pinned"));
    assert_eq!(accepted["hostKeyFingerprint"], json!("SHA256:abc"));
}

#[tokio::test]
async fn a_target_that_would_be_read_as_an_option_is_refused() {
    // `ssh -o ProxyCommand=…` is what a leading dash buys a caller who can
    // get a profile written.
    let (_dir, state) = switched_on();
    let refused = call(
        &state,
        "connection.create",
        json!({
            "label": "hostile",
            "kind": "ssh",
            "target": { "kind": "ssh", "host": "-oProxyCommand=calc", "port": 22 },
        }),
    )
    .await;
    assert_eq!(code_of(refused), -32602);
}

#[tokio::test]
async fn an_edit_leaves_the_enabled_switch_and_the_credential_alone() {
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    enable(&state, &id).await;
    call(
        &state,
        "connection.setCredential",
        json!({ "profileId": id, "secret": "hunter2" }),
    )
    .await
    .expect("sets a credential");

    let edited = call(
        &state,
        "connection.update",
        json!({
            "profileId": id,
            "label": "build-box",
            "kind": "ssh",
            "target": { "kind": "ssh", "host": "renamed", "port": 2222 },
        }),
    )
    .await
    .expect("edits");
    assert_eq!(edited["target"]["host"], json!("renamed"));
    assert_eq!(edited["enabled"], json!(true), "an edit is not a disable");
    assert_eq!(edited["credentialConfigured"], json!(true));
}

#[tokio::test]
async fn a_credential_value_is_never_returned() {
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    call(
        &state,
        "connection.setCredential",
        json!({ "profileId": id, "secret": "hunter2" }),
    )
    .await
    .expect("sets");

    let listing = call(&state, "connection.profiles", json!({}))
        .await
        .expect("lists");
    let rendered = listing.to_string();
    assert!(!rendered.contains("hunter2"));
    assert!(!rendered.contains(&connection::credential_ref_for(&id)));
    assert_eq!(listing["profiles"][0]["credentialConfigured"], json!(true));
}

#[tokio::test]
async fn deleting_a_profile_removes_its_secret() {
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    call(
        &state,
        "connection.setCredential",
        json!({ "profileId": id, "secret": "hunter2" }),
    )
    .await
    .expect("sets");
    let reference = connection::credential_ref_for(&id);
    {
        let st = state.try_lock().expect("uncontended");
        assert!(st.secrets.has(&reference), "the secret is stored");
    }

    call(&state, "connection.delete", json!({ "profileId": id }))
        .await
        .expect("deletes");
    let st = state.try_lock().expect("uncontended");
    assert!(
        !st.secrets.has(&reference),
        "a deleted profile must not leave a credential behind"
    );
}

#[tokio::test]
async fn clearing_a_credential_leaves_the_profile_in_place() {
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    call(
        &state,
        "connection.setCredential",
        json!({ "profileId": id, "secret": "hunter2" }),
    )
    .await
    .expect("sets");
    let cleared = call(
        &state,
        "connection.clearCredential",
        json!({ "profileId": id }),
    )
    .await
    .expect("clears");
    assert_eq!(cleared["credentialConfigured"], json!(false));

    let listing = call(&state, "connection.profiles", json!({}))
        .await
        .expect("lists");
    assert_eq!(listing["profiles"].as_array().expect("an array").len(), 1);
}

#[tokio::test]
async fn every_profile_mutation_writes_an_audit_row() {
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    enable(&state, &id).await;
    call(
        &state,
        "connection.setCredential",
        json!({ "profileId": id, "secret": "hunter2" }),
    )
    .await
    .expect("sets");
    call(&state, "connection.delete", json!({ "profileId": id }))
        .await
        .expect("deletes");

    let actions: Vec<String> = audit_rows(&state)
        .into_iter()
        .filter_map(|row| row["action"].as_str().map(str::to_string))
        .collect();
    for expected in [
        "profile.create",
        "profile.enable",
        "credential.set",
        "profile.delete",
    ] {
        assert!(actions.contains(&expected.to_string()), "{actions:?}");
    }
}

#[tokio::test]
async fn an_audit_row_never_carries_the_credential() {
    let (_dir, state) = switched_on();
    let id = create_profile(&state, "build-box").await;
    call(
        &state,
        "connection.setCredential",
        json!({ "profileId": id, "secret": "hunter2" }),
    )
    .await
    .expect("sets");

    let rows = audit_rows(&state);
    assert!(!rows.is_empty());
    for row in rows {
        let rendered = row.to_string();
        assert!(!rendered.contains("hunter2"), "{rendered}");
        assert!(
            !rendered.contains(&connection::credential_ref_for(&id)),
            "the handle is not a credential, but it is not needed here either: {rendered}"
        );
    }
}

#[tokio::test]
async fn activity_reads_back_the_rows_for_one_profile_only() {
    let (_dir, state) = switched_on();
    let first = create_profile(&state, "alpha").await;
    let second = create_profile(&state, "beta").await;
    enable(&state, &first).await;

    let activity = call(&state, "connection.activity", json!({ "profileId": first }))
        .await
        .expect("reads");
    let rows = activity["activity"].as_array().expect("an array");
    assert_eq!(
        rows.len(),
        2,
        "create and enable, for the first profile only"
    );
    for row in rows {
        assert_eq!(row["profileId"], json!(first));
        assert!(row.get("ts").is_some(), "each row carries its timestamp");
    }
    assert!(!rows.iter().any(|row| row["profileId"] == json!(second)));
}

#[tokio::test]
async fn an_unknown_method_is_reported_as_not_found() {
    // R2's methods are absent from the table entirely, so a caller gets the
    // dispatcher's unknown-method error and does not learn a method that
    // does not exist yet.
    let (_dir, state) = switched_on();
    assert_eq!(
        code_of(call(&state, "connection.read", json!({})).await),
        -32601
    );
}

#[test]
fn the_documented_codes_are_the_ones_this_layer_emits() {
    // The nine codes are a contract; this asserts the constants and the
    // error type agree, so neither can drift alone.
    // The numbers and slugs are written here as literals on purpose: a test
    // that read the same constants the implementation reads would agree
    // with a wrong implementation.
    let table = [
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
    let mut seen = Vec::new();
    for (error, code, slug) in table {
        assert_eq!(error.code(), code, "{error}");
        assert_eq!(error.slug(), slug, "{error}");
        let reply = connection_err(error);
        assert_eq!(reply.code, code);
        assert_eq!(
            reply.data.as_ref().expect("data")["errorCode"],
            json!(slug),
            "the slug travels in data.errorCode"
        );
        seen.push(code);
    }
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 9, "the nine codes must be distinct");
}

#[tokio::test]
async fn a_payload_field_is_added_beside_the_code_slug_not_instead_of_it() {
    // The seam PR #27 fixed: a payload that replaced the slug made the agent
    // tool answer INTERNAL for a failure this door named `1027`.
    let reply = connection_err(ConnectionError::HostKey {
        fingerprint: "SHA256:abcdef".into(),
        changed: true,
    });
    let data = reply.data.as_ref().expect("data");
    assert_eq!(data["errorCode"], json!("CONNECTION_HOST_KEY"));
    assert_eq!(data["fingerprint"], json!("SHA256:abcdef"));
    assert_eq!(data["kind"], json!("changed"));
}

#[tokio::test]
async fn exec_requires_a_command_and_a_profile() {
    let (_dir, state) = switched_on();
    // The profile id is checked first: without one there is nothing to
    // address, and a caller that names nothing learns that rather than
    // learning which of its other parameters was wrong.
    assert_eq!(
        code_of(call(&state, "connection.exec", json!({ "command": "ls" })).await),
        -32602
    );

    let id = create_profile(&state, "build-box").await;
    enable(&state, &id).await;
    assert_eq!(
        code_of(call(&state, "connection.exec", json!({ "profileId": id })).await),
        -32602,
        "a named profile with no command is a parameter error"
    );
    assert_eq!(
        code_of(
            call(
                &state,
                "connection.exec",
                json!({ "profileId": id, "command": "   " })
            )
            .await
        ),
        -32602,
        "a blank command is not a command"
    );
}

#[test]
fn a_reduced_output_budget_is_detectable() {
    // A caller that got less than it expected is told the budget it got.
    assert!(!params::budget_is_reduced(&connection::Limits::default()));
    assert!(params::budget_is_reduced(&connection::Limits {
        output_bytes: 4096,
        ..Default::default()
    }));
}
