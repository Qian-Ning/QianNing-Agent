use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::{
    capability_err, handle_request, parse_capability_query, parse_capability_target,
    peek_jsonrpc_id, provider_rpc_err, resolve_plan_workspace, resolve_tool_workspace,
    resolve_tool_workspace_for_call, scope_err, skill_err,
};
use crate::agent_capabilities::CapabilityLevel;
use crate::plans::{PlanResolveParams, PlanSubmitParams};
use crate::scheduled;
use crate::sessions;
use crate::state::AppState;

#[test]
fn capability_errors_keep_their_protocol_code() {
    let missing_project = parse_capability_query(&json!({ "level": "project" }))
        .expect_err("project queries require a project path");
    assert_eq!(
        missing_project.data.unwrap()["errorCode"],
        "CAPABILITY_INVALID"
    );

    let unknown_level = parse_capability_query(&json!({ "level": "workspace" }))
        .expect_err("unknown capability levels are invalid");
    assert_eq!(
        unknown_level.data.unwrap()["errorCode"],
        "CAPABILITY_INVALID"
    );
    assert_eq!(
        scope_err("CAPABILITY_INVALID: missing project")
            .data
            .unwrap()["errorCode"],
        "CAPABILITY_INVALID"
    );
    assert_eq!(
        skill_err("CAPABILITY_INVALID: missing project")
            .data
            .unwrap()["errorCode"],
        "CAPABILITY_INVALID"
    );
    assert_eq!(
        capability_err("missing project").data.unwrap()["errorCode"],
        "CAPABILITY_INVALID"
    );
}

#[test]
fn capability_target_requires_an_explicit_string_level() {
    // A missing or non-string level must not fall back to `global`: that
    // would write the capability into the wrong directory without telling
    // the caller.
    let missing = parse_capability_target(&json!({ "to": { "projectPath": "/p" } }), "to")
        .expect_err("a target without a level is invalid");
    assert_eq!(missing.code, 1002);
    assert_eq!(
        missing.data.as_ref().unwrap()["errorCode"],
        json!("INVALID_PARAMS")
    );

    let wrong_type = parse_capability_target(&json!({ "to": { "level": 5 } }), "to")
        .expect_err("a non-string level is invalid");
    assert_eq!(wrong_type.code, 1002);
    assert_eq!(
        wrong_type.data.as_ref().unwrap()["errorCode"],
        json!("INVALID_PARAMS")
    );

    let absent = parse_capability_target(&json!({}), "from")
        .expect_err("the named end of a move is required");
    assert_eq!(absent.code, 1002);

    let project = parse_capability_target(
        &json!({ "to": { "level": "project", "projectPath": "/p" } }),
        "to",
    )
    .unwrap();
    assert_eq!(project.level, CapabilityLevel::Project);
    let global = parse_capability_target(&json!({ "to": { "level": "global" } }), "to").unwrap();
    assert_eq!(global.level, CapabilityLevel::Global);
}

#[test]
fn peek_jsonrpc_id_reads_a_string_id_from_a_truncated_prefix() {
    let prefix = r#"{"jsonrpc":"2.0","id":"abc-123","method":"session.replaceMessages","params":{"#;
    assert_eq!(peek_jsonrpc_id(prefix), json!("abc-123"));
}

#[test]
fn peek_jsonrpc_id_reads_a_numeric_id() {
    assert_eq!(
        peek_jsonrpc_id(r#"{"jsonrpc":"2.0","id":7,"method":"x"}"#),
        json!(7)
    );
}

#[test]
fn peek_jsonrpc_id_is_null_when_the_prefix_has_no_id() {
    assert_eq!(peek_jsonrpc_id("not json"), Value::Null);
    assert_eq!(peek_jsonrpc_id(""), Value::Null);
}

#[test]
fn provider_alias_validation_keeps_a_stable_error_code() {
    let error = provider_rpc_err("MODEL_ALIAS_TOO_LONG: alias is too long");
    assert_eq!(error.code, 1002);
    assert_eq!(
        error.data.as_ref().and_then(|data| data.get("errorCode")),
        Some(&json!("MODEL_ALIAS_TOO_LONG"))
    );
}

#[tokio::test]
async fn a_computer_method_reaches_the_computer_layer() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    // Parameters are validated before any platform call runs, so an
    // unknown button is rejected the same way on every host. That makes
    // the code itself the assertion: the layer's own rejection is
    // `INVALID_PARAMS`, while a `computer.*` method the dispatcher does
    // not route falls through to the method-not-found arm instead.
    let error = handle_request(
        state,
        "computer.click",
        json!({ "x": 0, "y": 0, "button": "sausage" }),
        tx,
    )
    .await
    .expect_err("an unknown button is rejected");
    assert_eq!(error.code, -32602);
}

/// The listing and the execute gate have to agree. A model that was handed
/// the definition can still call the tool from context after the setting
/// flips mid-session, so the listing is convenience and the execute-time
/// check is the boundary — this pins the listing half.
#[tokio::test]
async fn computer_is_listed_only_while_control_is_switched_on() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    fn listed(value: &Value) -> bool {
        value["tools"]
            .as_array()
            .expect("a tool array")
            .iter()
            .any(|tool| tool["name"] == json!(crate::rpc::computer_tool::TOOL_NAME))
    }

    let off = handle_request(state.clone(), "tools.list", json!({}), tx.clone())
        .await
        .expect("the tool list answers");
    assert!(!listed(&off), "Computer is offered while control is off");

    {
        let st = state.lock().await;
        let mut settings = st
            .db
            .get_setting("app")
            .expect("read settings")
            .unwrap_or_else(|| json!({}));
        settings["computerControlEnabled"] = json!(true);
        st.db.set_setting("app", &settings).expect("write settings");
    }

    let on = handle_request(state, "tools.list", json!({}), tx)
        .await
        .expect("the tool list answers");
    assert!(listed(&on), "Computer is not offered while control is on");
}

#[tokio::test]
async fn project_create_returns_an_id_without_switching_workspace() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let path = data_dir.path().to_string_lossy().to_string();

    let result = handle_request(
        state.clone(),
        "projects.create",
        json!({ "path": path }),
        tx,
    )
    .await
    .unwrap();
    let project_id = result["project"]["id"].as_i64().unwrap();
    // A stored project path has one canonical spelling: resolved, with
    // forward slashes. Comparing against the raw platform spelling only
    // holds where the separator happens to be `/`.
    let canonical_path = crate::db::canonical_project_path(&path).expect("canonical project path");
    assert_eq!(result["project"]["path"], canonical_path.as_str());
    assert!(project_id > 0);

    let workspace = handle_request(
        state,
        "workspace.get",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(workspace["workspace"], Value::Null);
}

#[tokio::test]
async fn project_group_update_rpc_adjusts_folders() {
    let data_dir = tempfile::tempdir().unwrap();
    let primary = data_dir.path().join("primary");
    let extra = data_dir.path().join("extra");
    fs::create_dir_all(&primary).unwrap();
    fs::create_dir_all(&extra).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let created = handle_request(
        state.clone(),
        "project.group.create",
        json!({ "name": "Editable", "folders": [primary] }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let group_id = created["group"]["id"].as_str().unwrap();
    let updated = handle_request(
        state,
        "project.group.update",
        json!({
            "groupId": group_id,
            "name": "Adjusted",
            "folders": [created["group"]["primaryPath"], extra]
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(updated["group"]["name"], "Adjusted");
    assert_eq!(updated["group"]["roots"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn project_group_update_rpc_switches_the_primary_folder() {
    let data_dir = tempfile::tempdir().unwrap();
    let primary = data_dir.path().join("primary");
    let extra = data_dir.path().join("extra");
    fs::create_dir_all(&primary).unwrap();
    fs::create_dir_all(&extra).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let created = handle_request(
        state.clone(),
        "project.group.create",
        json!({ "name": "Switchable", "folders": [primary, extra] }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let group_id = created["group"]["id"].as_str().unwrap().to_string();
    let primary_path = created["group"]["primaryPath"]
        .as_str()
        .unwrap()
        .to_string();
    let extra_path = created["group"]["roots"][1]["path"]
        .as_str()
        .unwrap()
        .to_string();

    let switched = handle_request(
        state.clone(),
        "project.group.update",
        json!({
            "groupId": group_id,
            "name": "Switchable",
            "folders": [primary_path, extra_path],
            "primary": extra_path,
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .expect("a member folder can be promoted to primary");
    assert_eq!(switched["group"]["primaryPath"], json!(extra_path));
    assert_eq!(switched["group"]["roots"][0]["path"], json!(extra_path));
    assert_eq!(switched["group"]["roots"][1]["path"], json!(primary_path));

    // The stored record keeps the promoted folder as primary.
    let listed = handle_request(
        state.clone(),
        "project.groups.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        listed["groups"][0]["primaryPath"],
        json!(switched["group"]["primaryPath"])
    );
}

#[tokio::test]
async fn project_group_rpc_roundtrips_context_and_roots() {
    let data_dir = tempfile::tempdir().unwrap();
    let primary = data_dir.path().join("primary");
    let member = data_dir.path().join("member");
    fs::create_dir_all(&primary).unwrap();
    fs::create_dir_all(&member).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let created = handle_request(
        state.clone(),
        "project.group.create",
        json!({
            "name": "A named project",
            "folders": [primary, member]
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let group_id = created["group"]["id"].as_str().unwrap();
    assert_eq!(created["group"]["roots"].as_array().unwrap().len(), 2);

    let context = handle_request(
        state,
        "project.group.context",
        json!({ "path": created["group"]["primaryPath"] }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(context["context"]["groupId"], group_id);
    assert_eq!(context["context"]["roots"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn project_memory_rpc_roundtrips_without_switching_workspace() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let path = data_dir.path().to_string_lossy().to_string();

    let saved = handle_request(
        state.clone(),
        "project.memory.set",
        json!({ "path": path, "content": "Use the staging database." }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(saved["memory"]["content"], "Use the staging database.");

    let loaded = handle_request(
        state.clone(),
        "project.memory.get",
        json!({ "path": data_dir.path() }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(loaded["memory"]["content"], "Use the staging database.");

    let structured = handle_request(
        state,
        "project.memory.set",
        json!({
            "path": path,
            "entries": [{
                "id": "deployment",
                "title": "Deployment",
                "content": "Use the staging database."
            }]
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        structured["memory"]["content"],
        "## Deployment\n\nUse the staging database."
    );
    assert_eq!(structured["memory"]["entries"][0]["id"], "deployment");
}

/// Append a user message through the RPC so the session's transcript file
/// exists on disk, mirroring a renderer outbox append.
async fn append_test_message(state: Arc<Mutex<AppState>>, session_id: &str, message_id: &str) {
    handle_request(
        state,
        "session.appendMessage",
        json!({
            "sessionId": session_id,
            "message": {
                "id": message_id,
                "role": "user",
                "content": "hello",
                "createdAt": "2025-05-01T00:00:00Z"
            }
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn projects_remove_deletes_project_sessions_and_transcripts() {
    let data_dir = tempfile::tempdir().unwrap();
    let project_dir = data_dir.path().join("project");
    fs::create_dir_all(&project_dir).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let project_path = project_dir.to_string_lossy().to_string();
    let first = sessions::create_session_with_options(
        &app_state.db,
        sessions::SessionCreateOptions {
            project_path: Some(project_path.clone()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let second = sessions::create_session_with_options(
        &app_state.db,
        sessions::SessionCreateOptions {
            project_path: Some(project_path.clone()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let state = Arc::new(Mutex::new(app_state));

    let mut transcripts = Vec::new();
    for (index, id) in [&first, &second].into_iter().enumerate() {
        append_test_message(state.clone(), id, &format!("message-{index}")).await;
        let transcript = crate::transcripts::transcript_path(data_dir.path(), id).unwrap();
        assert!(transcript.exists());
        transcripts.push(transcript);
    }

    let saved_memory = handle_request(
        state.clone(),
        "project.memory.set",
        json!({ "path": project_path, "content": "Use the staging database." }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        saved_memory["memory"]["content"],
        "Use the staging database."
    );

    let result = handle_request(
        state.clone(),
        "projects.remove",
        json!({ "path": project_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(result["removed"], json!(true));
    assert_eq!(result["sessionsRemoved"], json!(2));

    let canonical =
        crate::db::canonical_project_path(&project_path).expect("canonical project path");
    let projects = handle_request(
        state.clone(),
        "projects.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .all(|project| project["path"].as_str() != Some(canonical.as_str())));

    let listed = handle_request(
        state.clone(),
        "session.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    for id in [&first, &second] {
        assert!(listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|session| session["id"].as_str() != Some(id.as_str())));
    }

    let memory = handle_request(
        state,
        "project.memory.get",
        json!({ "path": project_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(memory["memory"]["content"], "");

    for transcript in transcripts {
        assert!(!transcript.exists());
    }
    assert!(project_dir.exists());
}

#[tokio::test]
async fn projects_remove_keeps_sessions_of_other_projects() {
    let data_dir = tempfile::tempdir().unwrap();
    let removed_dir = data_dir.path().join("removed-project");
    let kept_dir = data_dir.path().join("kept-project");
    fs::create_dir_all(&removed_dir).unwrap();
    fs::create_dir_all(&kept_dir).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let removed_path = removed_dir.to_string_lossy().to_string();
    let kept_path = kept_dir.to_string_lossy().to_string();
    let removed_session = sessions::create_session_with_options(
        &app_state.db,
        sessions::SessionCreateOptions {
            project_path: Some(removed_path.clone()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let kept_session = sessions::create_session_with_options(
        &app_state.db,
        sessions::SessionCreateOptions {
            project_path: Some(kept_path.clone()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let state = Arc::new(Mutex::new(app_state));

    append_test_message(state.clone(), &removed_session, "removed-message").await;
    append_test_message(state.clone(), &kept_session, "kept-message").await;
    let kept_transcript =
        crate::transcripts::transcript_path(data_dir.path(), &kept_session).unwrap();
    assert!(kept_transcript.exists());

    let result = handle_request(
        state.clone(),
        "projects.remove",
        json!({ "path": removed_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(result["removed"], json!(true));
    assert_eq!(result["sessionsRemoved"], json!(1));

    let listed = handle_request(
        state.clone(),
        "session.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let listed_sessions = listed["sessions"].as_array().unwrap();
    assert!(listed_sessions
        .iter()
        .any(|session| session["id"].as_str() == Some(kept_session.as_str())));
    assert!(!listed_sessions
        .iter()
        .any(|session| session["id"].as_str() == Some(removed_session.as_str())));
    assert!(kept_transcript.exists());

    let canonical_kept =
        crate::db::canonical_project_path(&kept_path).expect("canonical project path");
    let projects = handle_request(
        state,
        "projects.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|project| project["path"].as_str() == Some(canonical_kept.as_str())));
}

#[tokio::test]
async fn projects_remove_unknown_path_is_idempotent() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));

    let blank = handle_request(
        state.clone(),
        "projects.remove",
        json!({ "path": "   " }),
        mpsc::unbounded_channel().0,
    )
    .await
    .expect_err("a blank project path is invalid");
    assert_eq!(blank.code, 1002);
    assert_eq!(
        blank.data.as_ref().and_then(|data| data.get("errorCode")),
        Some(&json!("INVALID_PARAMS"))
    );

    let missing = data_dir
        .path()
        .join("missing")
        .to_string_lossy()
        .to_string();
    let result = handle_request(
        state,
        "projects.remove",
        json!({ "path": missing }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(result["removed"], json!(false));
    assert_eq!(result["sessionsRemoved"], json!(0));
}

#[tokio::test]
async fn projects_remove_refuses_stored_group_root() {
    let data_dir = tempfile::tempdir().unwrap();
    let grouped_dir = data_dir.path().join("grouped");
    let extra_dir = data_dir.path().join("extra");
    fs::create_dir_all(&grouped_dir).unwrap();
    fs::create_dir_all(&extra_dir).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let grouped_path = grouped_dir.to_string_lossy().to_string();
    app_state
        .db
        .create_project_group(
            "Grouped",
            &[
                grouped_path.clone(),
                extra_dir.to_string_lossy().to_string(),
            ],
        )
        .unwrap();
    let state = Arc::new(Mutex::new(app_state));

    let error = handle_request(
        state.clone(),
        "projects.remove",
        json!({ "path": grouped_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .expect_err("a stored project group root must not be removed");
    assert_eq!(error.code, 1002);
    assert_eq!(
        error.data.as_ref().and_then(|data| data.get("errorCode")),
        Some(&json!("INVALID_PARAMS"))
    );

    let canonical =
        crate::db::canonical_project_path(&grouped_path).expect("canonical project path");
    let projects = handle_request(
        state,
        "projects.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|project| project["path"].as_str() == Some(canonical.as_str())));
}

/// A single-folder stored project group is just a wrapper around one
/// project. Removing that project must succeed and delete the now-empty
/// group record instead of locking the project in place (issue #572).
#[tokio::test]
async fn projects_remove_deletes_single_folder_stored_group() {
    let data_dir = tempfile::tempdir().unwrap();
    let solo_dir = data_dir.path().join("solo");
    fs::create_dir_all(&solo_dir).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let solo_path = solo_dir.to_string_lossy().to_string();
    let group = app_state
        .db
        .create_project_group("Solo", std::slice::from_ref(&solo_path))
        .unwrap();
    assert!(!group.legacy);
    assert_eq!(group.roots.len(), 1);
    let state = Arc::new(Mutex::new(app_state));

    let result = handle_request(
        state.clone(),
        "projects.remove",
        json!({ "path": solo_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .expect("a single-folder stored group must be removable");
    assert_eq!(result["removed"], json!(true));

    let canonical = crate::db::canonical_project_path(&solo_path).expect("canonical project path");
    let st = state.lock().await;
    assert!(st
        .db
        .stored_project_group_for_path(&canonical)
        .unwrap()
        .is_none());
    assert!(st
        .db
        .list_projects()
        .unwrap()
        .iter()
        .all(|project| project.path != canonical));
}

/// A running turn owns its session's tools, working directory, and
/// transcript writes, so the bulk delete waits until the project is idle.
#[tokio::test]
async fn projects_remove_refuses_while_a_session_is_running() {
    let data_dir = tempfile::tempdir().unwrap();
    let project_dir = data_dir.path().join("busy-project");
    fs::create_dir_all(&project_dir).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let project_path = project_dir.to_string_lossy().to_string();
    let session_id = sessions::create_session_with_options(
        &app_state.db,
        sessions::SessionCreateOptions {
            project_path: Some(project_path.clone()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let state = Arc::new(Mutex::new(app_state));

    let started = handle_request(
        state.clone(),
        "session.beginTurn",
        json!({ "sessionId": session_id }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let turn_id = started["turnId"].as_str().unwrap().to_string();

    let error = handle_request(
        state.clone(),
        "projects.remove",
        json!({ "path": project_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .expect_err("a running turn blocks the project delete");
    assert_eq!(error.code, 1008);
    assert_eq!(
        error.data.as_ref().and_then(|data| data.get("errorCode")),
        Some(&json!("CONFLICT"))
    );

    let canonical =
        crate::db::canonical_project_path(&project_path).expect("canonical project path");
    let projects = handle_request(
        state.clone(),
        "projects.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .any(|project| project["path"].as_str() == Some(canonical.as_str())));
    let listed = handle_request(
        state.clone(),
        "session.list",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|session| session["id"].as_str() == Some(session_id.as_str())));

    handle_request(
        state.clone(),
        "session.endTurn",
        json!({ "turnId": turn_id, "status": "completed" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let removed = handle_request(
        state,
        "projects.remove",
        json!({ "path": project_path }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(removed["removed"], json!(true));
    assert_eq!(removed["sessionsRemoved"], json!(1));
}

#[tokio::test]
async fn session_create_rpc_inherits_optional_permission_mode() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let parent_id = sessions::create_session_with_options(
        &app_state.db,
        sessions::SessionCreateOptions {
            permission_mode: Some("ask".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    let explicit = handle_request(
        state.clone(),
        "session.create",
        json!({
            "mode": "agent",
            "thinkingLevel": "high",
            "inheritPermissionFromSessionId": parent_id
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(explicit["session"]["thinkingLevel"], "high");
    assert_eq!(explicit["session"]["permissionMode"], "ask");

    let legacy = handle_request(
        state.clone(),
        "session.create",
        json!({ "mode": "agent" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(legacy["session"]["permissionMode"], "inherit");

    let arbitrary_permission = handle_request(
        state.clone(),
        "session.create",
        json!({ "mode": "agent", "permissionMode": "auto" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(arbitrary_permission["session"]["permissionMode"], "inherit");

    let invalid = handle_request(
        state.clone(),
        "session.create",
        json!({ "inheritPermissionFromSessionId": true }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.data.unwrap()["errorCode"], "INVALID_PARAMS");

    let malformed = handle_request(
        state,
        "session.create",
        json!({ "inheritPermissionFromSessionId": "" }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(malformed.data.unwrap()["errorCode"], "INVALID_PARAMS");
}

#[tokio::test]
async fn plugin_session_rpc_routes_the_full_p0_p1_surface() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let item = |external_id: &str| {
        json!({
            "externalId": external_id,
            "title": "Imported",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:01Z",
            "messages": [{
                "role": "user",
                "content": "hello",
                "createdAt": "2026-01-01T00:00:00Z"
            }]
        })
    };

    let imported = handle_request(
        state.clone(),
        "plugin.session.import",
        json!({
            "pluginId": "plugin.one",
            "source": "legacy",
            "sourceLabel": "Legacy",
            "externalId": "one",
            "title": "Imported",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:01Z",
            "messages": [{
                "role": "user",
                "content": "hello",
                "createdAt": "2026-01-01T00:00:00Z"
            }]
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    let session_id = imported["sessionId"].as_str().unwrap().to_string();

    let batch = handle_request(
        state.clone(),
        "plugin.session.importBatch",
        json!({
            "pluginId": "plugin.one",
            "source": "legacy",
            "sessions": [item("two"), item("three")]
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(batch["imported"], 2);

    let listed = handle_request(
        state.clone(),
        "plugin.session.list",
        json!({ "pluginId": "plugin.one", "source": "legacy" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 3);

    let detail = handle_request(
        state.clone(),
        "plugin.session.get",
        json!({ "pluginId": "plugin.one", "sessionId": session_id }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(detail["originKind"], "imported");

    let messages = handle_request(
        state.clone(),
        "plugin.session.listMessages",
        json!({ "pluginId": "plugin.one", "sessionId": session_id }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(messages["items"][0]["origin"], "external");

    handle_request(
        state.clone(),
        "plugin.session.rename",
        json!({ "pluginId": "plugin.one", "sessionId": session_id, "title": "Renamed" }),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "plugin.session.delete",
        json!({ "pluginId": "plugin.one", "sessionId": session_id, "mode": "trash" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let denied = handle_request(
        state.clone(),
        "plugin.session.get",
        json!({ "pluginId": "plugin.two", "sessionId": session_id }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, 1007);
    handle_request(
        state,
        "plugin.session.delete",
        json!({ "pluginId": "plugin.one", "sessionId": session_id, "mode": "purge" }),
        tx,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn plugin_usage_rpc_serves_read_only_fact_rows() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    // Three completed turns across two sessions: t2 carries all three
    // usage_json token kinds, t1 carries none (zeros), and t4 belongs to a
    // soft-deleted session so it must never appear. Different ended_at
    // values make the ASC ordering and the cursor page observable.
    let now = chrono::Utc::now().timestamp_millis();
    {
        let st = state.lock().await;
        let conn = st.db.conn();
        for (project_id, path, name) in [(1, "/tmp/p1", "P1"), (2, "/tmp/p2", "P2")] {
            conn.execute(
                "INSERT INTO projects (id, path, name, created_at, last_opened_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![project_id, path, name, now],
            )
            .unwrap();
        }
        for (id, title, project) in [("s1", "", 1), ("s2", "Big", 2), ("s3", "Trashed", 1)] {
            conn.execute(
                "INSERT INTO sessions (id, title, project_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![id, title, project, now],
            )
            .unwrap();
        }
        conn.execute(
            "UPDATE sessions SET deleted_at = ?1 WHERE id = 's3'",
            rusqlite::params![now],
        )
        .unwrap();
        // (id, session, ended, input, output, usage_json)
        let turn = |id: &str, session: &str, ended: i64, usage: Option<&str>| {
            conn.execute(
                "INSERT INTO turns (id, session_id, status, provider_id, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at)
                 VALUES (?1, ?2, 'completed', 'prov', 'model-a', ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![id, session, 100, 200, usage, ended - 1_000, ended],
            )
            .unwrap();
        };
        turn("t1", "s1", now - 3_000, None);
        turn(
            "t2",
            "s2",
            now - 2_000,
            Some(
                serde_json::json!({
                    "cacheReadTokens": 300,
                    "cacheWriteTokens": 400,
                    "reasoningTokens": 500
                })
                .to_string(),
            )
            .as_deref(),
        );
        turn(
            "t3",
            "s2",
            now - 1_000,
            Some(r#"{"cacheReadTokens":"bad"}"#),
        );
        turn("t4", "s3", now - 500, None);
    }

    const METHOD: &str = "plugin.usage.listTurns";

    // Missing pluginId is a client error, same as the session domain.
    let missing = handle_request(state.clone(), METHOD, json!({}), tx.clone())
        .await
        .unwrap_err();
    assert_eq!(missing.code, 1002);
    assert_eq!(missing.data.unwrap()["errorCode"], "INVALID_PARAMS");

    // Default window covers every turn; ordering is ended_at ASC and the
    // soft-deleted session's turn is absent.
    let page = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let turns = page["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 3, "t4 belongs to a trashed session");
    assert_eq!(turns[0]["turnId"], "t1");
    assert_eq!(turns[1]["turnId"], "t2");
    assert_eq!(turns[2]["turnId"], "t3");
    assert!(page["nextCursor"].is_null(), "no more rows, no cursor");
    // Row shape: counters and titles only, camelCase, no message fields.
    assert!(
        turns[0]["sessionTitle"].is_null(),
        "empty title maps to null"
    );
    assert_eq!(turns[1]["sessionTitle"], "Big");
    assert_eq!(turns[1]["sessionId"], "s2");
    assert_eq!(turns[1]["projectId"], 2);
    assert_eq!(turns[1]["providerId"], "prov");
    assert_eq!(turns[1]["modelId"], "model-a");
    assert_eq!(turns[1]["inputTokens"], 100);
    assert_eq!(turns[1]["outputTokens"], 200);
    assert_eq!(turns[1]["cacheReadTokens"], 300);
    assert_eq!(turns[1]["cacheWriteTokens"], 400);
    assert_eq!(turns[1]["reasoningTokens"], 500);
    // Missing usage_json yields zeros; a malformed one also yields zeros.
    assert_eq!(turns[0]["cacheReadTokens"], 0);
    assert_eq!(turns[0]["reasoningTokens"], 0);
    assert_eq!(turns[2]["cacheReadTokens"], 0);
    assert!(turns[0].get("content").is_none());
    assert!(turns[0].get("messages").is_none());

    // limit truncates and the returned cursor fetches exactly the rest.
    let page1 = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one", "limit": 2 }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(page1["turns"].as_array().unwrap().len(), 2);
    let cursor1 = page1["nextCursor"].as_str().unwrap();
    let page2 = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one", "limit": 2, "cursor": cursor1 }),
        tx.clone(),
    )
    .await
    .unwrap();
    let rest = page2["turns"].as_array().unwrap();
    assert_eq!(rest.len(), 1, "exactly the remaining row");
    assert_eq!(rest[0]["turnId"], "t3");
    assert!(page2["nextCursor"].is_null());

    // Filtering: sessionId and projectId narrow the facts.
    let only_s2 = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one", "sessionId": "s2" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let s2_turns = only_s2["turns"].as_array().unwrap();
    assert_eq!(s2_turns.len(), 2);
    assert!(s2_turns.iter().all(|t| t["sessionId"] == "s2"));

    let only_p1 = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one", "projectId": 1 }),
        tx.clone(),
    )
    .await
    .unwrap();
    let p1_turns = only_p1["turns"].as_array().unwrap();
    assert_eq!(p1_turns.len(), 1);
    assert_eq!(p1_turns[0]["sessionId"], "s1");

    // Explicit bounds exclude out-of-window turns.
    let windowed = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one", "fromMs": now - 1_500, "toMs": now }),
        tx.clone(),
    )
    .await
    .unwrap();
    let w = windowed["turns"].as_array().unwrap();
    assert_eq!(w.len(), 1, "only t3 ended inside the window");
    assert_eq!(w[0]["turnId"], "t3");

    // Client errors the host must reject: bad cursor, bad limit, bad
    // window, wrong types.
    for bad in [
        json!({ "pluginId": "p", "cursor": "not-a-cursor" }),
        json!({ "pluginId": "p", "limit": 0 }),
        json!({ "pluginId": "p", "limit": 501 }),
        json!({ "pluginId": "p", "limit": "ten" }),
        json!({ "pluginId": "p", "fromMs": -1 }),
        json!({ "pluginId": "p", "toMs": "now" }),
        json!({ "pluginId": "p", "fromMs": now, "toMs": now - 1_000 }),
        json!({
            "pluginId": "p",
            "fromMs": now - 366 * 24 * 3600 * 1000,
            "toMs": now
        }),
        json!({ "pluginId": "p", "fromMs": 0 }),
        json!({ "pluginId": "p", "sessionId": 7 }),
        json!({ "pluginId": "p", "sessionId": "" }),
        json!({ "pluginId": "p", "projectId": "seven" }),
    ] {
        let error = handle_request(state.clone(), METHOD, bad.clone(), tx.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, 1002, "{bad}");
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS", "{bad}");
    }

    // Null bounds match omitted bounds; the 365-day window edge is accepted.
    let null_bounds = handle_request(
        state.clone(),
        METHOD,
        json!({ "pluginId": "plugin.one", "fromMs": null, "toMs": null }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(null_bounds["turns"].as_array().unwrap().len(), 3);
    let edge = handle_request(
        state.clone(),
        METHOD,
        json!({
            "pluginId": "plugin.one",
            "fromMs": now - 365 * 24 * 3600 * 1000,
            "toMs": now
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(edge["turns"].as_array().unwrap().len(), 3);
}

fn available_test_shell_id() -> Option<String> {
    crate::tools::shell::catalog(None)
        .effective
        .map(|shell| shell.id)
}

fn alternate_available_test_shell_id(current: &str) -> Option<String> {
    crate::tools::shell::catalog(None)
        .choices
        .into_iter()
        .find(|shell| shell.available && shell.id != current)
        .map(|shell| shell.id)
}

#[cfg(windows)]
fn sleeping_bash_command() -> &'static str {
    "Start-Sleep -Seconds 30"
}

#[cfg(not(windows))]
fn sleeping_bash_command() -> &'static str {
    "sleep 30"
}

#[cfg(windows)]
fn descendant_marker_bash_command(started: &Path, late: &Path) -> String {
    format!(
        "$null = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-Command',\"Start-Sleep -Milliseconds 1000; [IO.File]::WriteAllText('{}', 'late')\") -WindowStyle Hidden; [IO.File]::WriteAllText('{}', 'started'); Start-Sleep -Seconds 30",
        late.display(),
        started.display()
    )
}

#[cfg(not(windows))]
fn descendant_marker_bash_command(started: &Path, late: &Path) -> String {
    format!(
        "(sleep 1; printf late > '{}') & printf started > '{}'; sleep 30",
        late.display(),
        started.display()
    )
}

#[cfg(windows)]
fn output_bash_command() -> &'static str {
    "[Console]::Out.Write('out-π'); [Console]::Error.Write('err-π')"
}

#[cfg(not(windows))]
fn output_bash_command() -> &'static str {
    "printf 'out-π'; printf 'err-π' >&2"
}

async fn wait_for_bash_registration(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    tool_call_id: &str,
) {
    for _ in 0..500 {
        if state
            .lock()
            .await
            .active_bash_cancellations
            .contains_key(&(session_id.to_string(), tool_call_id.to_string()))
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("Bash cancellation was not registered");
}

async fn assert_bash_registry_empty(state: &Arc<Mutex<AppState>>) {
    assert!(state.lock().await.active_bash_cancellations.is_empty());
}

#[test]
fn control_stdio_treats_os_resource_pressure_as_transient() {
    assert!(super::is_transient_io_error(&io::Error::from(
        io::ErrorKind::WouldBlock
    )));
    assert!(super::is_transient_io_error(&io::Error::from(
        io::ErrorKind::Interrupted
    )));
    assert!(super::is_transient_io_error(&io::Error::from_raw_os_error(
        11
    )));
    assert!(super::is_transient_io_error(&io::Error::from_raw_os_error(
        35
    )));
    assert!(!super::is_transient_io_error(&io::Error::from(
        io::ErrorKind::BrokenPipe
    )));
}

#[test]
fn stdout_message_retries_partial_writes_without_duplication() {
    struct PartialWriter {
        bytes: Vec<u8>,
        blocked: bool,
    }

    impl Write for PartialWriter {
        fn write(&mut self, input: &[u8]) -> io::Result<usize> {
            if self.blocked {
                self.blocked = false;
                return Err(io::Error::from(io::ErrorKind::WouldBlock));
            }
            let written = input.len().min(2);
            self.bytes.extend_from_slice(&input[..written]);
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let mut writer = PartialWriter {
        bytes: Vec::new(),
        blocked: true,
    };
    assert!(super::write_stdout_message(&mut writer, "hello").is_ok());
    assert_eq!(writer.bytes, b"hello");
}

#[test]
fn tool_workspace_follows_the_persisted_session_project() {
    let data_dir = tempfile::tempdir().unwrap();
    let project_a = data_dir.path().join("project-a");
    let project_b = data_dir.path().join("project-b");
    fs::create_dir_all(&project_a).unwrap();
    fs::create_dir_all(&project_b).unwrap();
    let mut state = AppState::open(data_dir.path()).unwrap();
    state.workspace.set(&project_b);
    let session = sessions::create_session(
        &state.db,
        Some("Project A".into()),
        Some("agent".into()),
        None,
        None,
        Some(project_a.to_string_lossy().into_owned()),
    )
    .unwrap();

    let resolved = PathBuf::from(
        resolve_tool_workspace(&state, &session.id)
            .unwrap()
            .unwrap(),
    );

    assert_eq!(
        crate::workspace::simple_canonicalize(&resolved).unwrap(),
        crate::workspace::simple_canonicalize(&project_a).unwrap()
    );
}

#[test]
fn group_member_absolute_paths_use_only_registered_group_roots() {
    let data_dir = tempfile::tempdir().unwrap();
    let primary = data_dir.path().join("primary");
    let member = data_dir.path().join("member");
    fs::create_dir_all(&primary).unwrap();
    fs::create_dir_all(&member).unwrap();
    let state = AppState::open(data_dir.path()).unwrap();
    let group = state
        .db
        .create_project_group(
            "Grouped project",
            &[
                primary.to_string_lossy().into(),
                member.to_string_lossy().into(),
            ],
        )
        .unwrap();
    let session = sessions::create_session(
        &state.db,
        Some("Grouped task".into()),
        Some("agent".into()),
        None,
        None,
        Some(primary.to_string_lossy().into_owned()),
    )
    .unwrap();

    let member_file = member.join("README.md");
    let resolved =
        resolve_tool_workspace_for_call(&state, &session.id, &json!({ "path": member_file }))
            .unwrap()
            .unwrap();
    assert_eq!(
        crate::workspace::simple_canonicalize(Path::new(&resolved)).unwrap(),
        crate::workspace::simple_canonicalize(&member).unwrap()
    );
    assert_eq!(
        state
            .db
            .project_group_for_path(&resolved)
            .unwrap()
            .unwrap()
            .id,
        group.id
    );

    let outside = data_dir.path().join("outside").join("file.txt");
    let fallback =
        resolve_tool_workspace_for_call(&state, &session.id, &json!({ "path": outside }))
            .unwrap()
            .unwrap();
    assert_eq!(
        crate::workspace::simple_canonicalize(Path::new(&fallback)).unwrap(),
        crate::workspace::simple_canonicalize(&primary).unwrap()
    );
}

#[test]
fn temporary_session_uses_its_own_scratch_workspace() {
    let data_dir = tempfile::tempdir().unwrap();
    let active_project = data_dir.path().join("active-project");
    fs::create_dir_all(&active_project).unwrap();
    let mut state = AppState::open(data_dir.path()).unwrap();
    state.workspace.set(&active_project);
    let session = sessions::create_session(
        &state.db,
        Some("Temporary".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();

    let resolved = PathBuf::from(
        resolve_tool_workspace(&state, &session.id)
            .unwrap()
            .unwrap(),
    );
    let expected = data_dir.path().join("scratch").join(&session.id);
    assert_eq!(resolved, expected);
    assert!(resolved.is_dir());
    assert_ne!(resolved, active_project);
    assert_eq!(
        resolve_plan_workspace(&state, &session.id)
            .expect_err("temporary sessions must not enter Plan/Goal workspaces")
            .data
            .unwrap()["errorCode"],
        "PLAN_WORKSPACE_REQUIRED"
    );
    assert_eq!(
        resolve_tool_workspace(&state, "legacy-missing-session")
            .expect_err("unknown sessions must not inherit the global workspace")
            .data
            .unwrap()["errorCode"],
        "SESSION_NOT_FOUND"
    );
}

#[tokio::test]
async fn temporary_session_reads_and_writes_inside_its_scratch_workspace() {
    let data_dir = tempfile::tempdir().unwrap();
    let active_project = data_dir.path().join("active-project");
    fs::create_dir_all(&active_project).unwrap();
    let mut state = AppState::open(data_dir.path()).unwrap();
    state.workspace.set(&active_project);
    let session = sessions::create_session(
        &state.db,
        Some("Temporary".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let root = PathBuf::from(
        resolve_tool_workspace(&state, &session.id)
            .unwrap()
            .unwrap(),
    );
    let scratch = crate::scratch::session_dir(data_dir.path(), &session.id).unwrap();

    let written = crate::tools::execute_tool_with_path_access(
        Some(&root),
        Some(&scratch),
        "Write",
        &json!({ "path": "notes.txt", "content": "temporary" }),
        crate::tools::ToolExecutionOptions {
            timeout_ms: None,
            bash_options: None,
            allow_external_paths: false,
            hashline: None,
        },
    )
    .await;
    assert!(written.ok);
    assert_eq!(written.content["root"], "workspace");
    assert_eq!(
        fs::read_to_string(root.join("notes.txt")).unwrap(),
        "temporary"
    );

    let read = crate::tools::execute_tool_with_path_access(
        Some(&root),
        Some(&scratch),
        "Read",
        &json!({ "path": "notes.txt" }),
        crate::tools::ToolExecutionOptions {
            timeout_ms: None,
            bash_options: None,
            allow_external_paths: false,
            hashline: None,
        },
    )
    .await;
    assert!(read.ok);
    let content = read.content["content"].as_str().unwrap();
    assert!(content.contains("temporary"), "{content}");
    assert_eq!(read.content["tag"].as_str().unwrap().len(), 4);
    assert!(!active_project.join("notes.txt").exists());
}

#[tokio::test]
async fn command_shell_settings_and_catalog_roundtrip() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        settings["defaultCommandShell"],
        crate::tools::shell::default_shell_id()
    );
    assert_eq!(settings["largePasteThreshold"], 600);

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "largePasteThreshold": 801 }),
        tx.clone(),
    )
    .await
    .unwrap();
    let updated = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(updated["largePasteThreshold"], 801);

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "infiniteProviderRetry": true }),
        tx.clone(),
    )
    .await
    .unwrap();
    let retry_settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(retry_settings["infiniteProviderRetry"], true);

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "keepAwakeWhileRunning": true }),
        tx.clone(),
    )
    .await
    .unwrap();
    let power_settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(power_settings["keepAwakeWhileRunning"], true);

    let invalid_power = handle_request(
        state.clone(),
        "settings.set",
        json!({ "keepAwakeWhileRunning": "yes" }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid_power.data.unwrap()["errorCode"], "INVALID_PARAMS");

    let invalid_retry = handle_request(
        state.clone(),
        "settings.set",
        json!({ "infiniteProviderRetry": "yes" }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid_retry.data.unwrap()["errorCode"], "INVALID_PARAMS");

    let invalid_threshold = handle_request(
        state.clone(),
        "settings.set",
        json!({ "largePasteThreshold": 0 }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        invalid_threshold.data.unwrap()["errorCode"],
        "INVALID_PARAMS"
    );

    let invalid = handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": "not-a-shell" }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.data.unwrap()["errorCode"], "COMMAND_SHELL_INVALID");

    let catalog = handle_request(state.clone(), "commandShells.list", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(
        catalog["configuredId"],
        crate::tools::shell::default_shell_id()
    );
    assert!(catalog["choices"].is_array());
    assert!(catalog["effective"].is_object() || catalog["effective"].is_null());
}

#[tokio::test]
async fn settings_set_round_trips_an_explicitly_disabled_shortcut() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "keybindings": { "openSearch": null } }),
        tx.clone(),
    )
    .await
    .unwrap();
    let disabled = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(disabled["keybindings"]["openSearch"], Value::Null);

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "theme": "light" }),
        tx.clone(),
    )
    .await
    .unwrap();
    let preserved = handle_request(state, "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(preserved["keybindings"]["openSearch"], Value::Null);
}

#[tokio::test]
async fn settings_set_preserves_stored_shell_when_shell_is_omitted() {
    let Some(current_shell) = available_test_shell_id() else {
        return;
    };
    let Some(stored_shell) = alternate_available_test_shell_id(&current_shell) else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": stored_shell.clone() }),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "settings.set",
        json!({ "theme": "light" }),
        tx.clone(),
    )
    .await
    .unwrap();

    let settings = handle_request(state, "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(settings["defaultCommandShell"], stored_shell);
    assert_eq!(settings["theme"], "light");
}

/// Creates a provider row through the RPC surface the shell uses.
async fn create_test_provider(
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
) -> String {
    let created = handle_request(
        state,
        "providers.create",
        json!({
            "name": "Image service",
            "baseUrl": "http://localhost:8080/v1",
            "authKind": "none",
            "defaultModelId": "gpt-image-2.5"
        }),
        tx,
    )
    .await
    .unwrap();
    created["provider"]["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn settings_set_drops_image_bindings_whose_provider_is_gone() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let provider_id = create_test_provider(state.clone(), tx.clone()).await;

    // The shell writes whole snapshots back, so a binding for a row that no
    // longer exists can arrive through an ordinary settings write.
    handle_request(
        state.clone(),
        "settings.set",
        json!({
            "imageGeneration": { "providerId": provider_id, "modelId": "gpt-image-2.5" },
            "imageGenerationModels": [
                { "providerId": provider_id, "modelId": "gpt-image-2.5" },
                { "providerId": "removed-service", "modelId": "gpt-image-2.5" }
            ]
        }),
        tx.clone(),
    )
    .await
    .unwrap();

    let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        settings["imageGeneration"],
        json!({ "providerId": provider_id, "modelId": "gpt-image-2.5" })
    );
    assert_eq!(
        settings["imageGenerationModels"],
        json!([{ "providerId": provider_id, "modelId": "gpt-image-2.5" }])
    );

    let stored = state.lock().await.db.get_setting("app").unwrap().unwrap();
    assert_eq!(stored["imageGenerationModels"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn settings_get_starts_a_fresh_install_on_the_system_theme() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    // Nothing is stored yet, so this is what a brand-new install reads. It
    // must ask for the OS preference rather than assume the dark palette:
    // a light desktop that opens dark is the first thing anyone notices.
    let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(settings["theme"], json!("system"));
}

#[tokio::test]
async fn settings_get_repairs_a_binding_left_by_a_deleted_provider() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let provider_id = create_test_provider(state.clone(), tx.clone()).await;

    handle_request(
        state.clone(),
        "settings.set",
        json!({
            "imageGeneration": { "providerId": provider_id, "modelId": "gpt-image-2.5" },
            "imageGenerationModels": [
                { "providerId": provider_id, "modelId": "gpt-image-2.5" }
            ]
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    let deleted = handle_request(
        state.clone(),
        "providers.delete",
        json!({ "id": provider_id }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(deleted["ok"], true);

    // Reading the settings repairs what the deletion left behind, so a
    // binding the runtime would reject never reaches the shell again.
    let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert!(settings["imageGeneration"].is_null());
    assert_eq!(settings["imageGenerationModels"], json!([]));

    let stored = state.lock().await.db.get_setting("app").unwrap().unwrap();
    assert!(stored["imageGeneration"].is_null());
    assert_eq!(stored["imageGenerationModels"], json!([]));
}

#[tokio::test]
async fn settings_keep_image_bindings_for_a_disabled_provider() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let provider_id = create_test_provider(state.clone(), tx.clone()).await;
    let disabled = handle_request(
        state.clone(),
        "providers.update",
        json!({ "id": provider_id, "enabled": false }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(disabled["provider"]["enabled"], false);

    // A row that still exists keeps its binding: an unavailable but
    // present provider is a state the user repairs in Settings, and
    // pruning it would silently discard the user's choice.
    handle_request(
        state.clone(),
        "settings.set",
        json!({
            "imageGeneration": { "providerId": provider_id, "modelId": "gpt-image-2.5" }
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    let settings = handle_request(state, "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(
        settings["imageGeneration"],
        json!({ "providerId": provider_id, "modelId": "gpt-image-2.5" })
    );
}

#[tokio::test]
async fn settings_set_same_shell_is_idempotent_during_an_active_turn() {
    let Some(current_shell) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Active settings".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;
    let full_settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    let turn_id = {
        let st = state.lock().await;
        sessions::begin_turn(&st.db, &session.id, None, None).unwrap()
    };

    let mut idempotent = full_settings;
    idempotent["defaultCommandShell"] = json!(current_shell.clone());
    idempotent["theme"] = json!("light");
    handle_request(state.clone(), "settings.set", idempotent, tx.clone())
        .await
        .unwrap();

    let settings = handle_request(state.clone(), "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(settings["defaultCommandShell"], current_shell);
    assert_eq!(settings["theme"], "light");

    let st = state.lock().await;
    sessions::end_turn(&st.db, &turn_id, "completed", None, None, false).unwrap();
}

#[tokio::test]
async fn settings_set_rejects_a_genuine_shell_change_during_an_active_turn() {
    let Some(current_shell) = available_test_shell_id() else {
        return;
    };
    let Some(changed_shell) = alternate_available_test_shell_id(&current_shell) else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Shell settings".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;
    handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": current_shell }),
        tx.clone(),
    )
    .await
    .unwrap();
    let turn_id = {
        let st = state.lock().await;
        sessions::begin_turn(&st.db, &session.id, None, None).unwrap()
    };

    let error = handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": changed_shell }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );

    let st = state.lock().await;
    sessions::end_turn(&st.db, &turn_id, "completed", None, None, false).unwrap();
}

#[tokio::test]
async fn settings_set_allows_a_genuine_shell_change_when_idle() {
    let Some(current_shell) = available_test_shell_id() else {
        return;
    };
    let Some(changed_shell) = alternate_available_test_shell_id(&current_shell) else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;

    handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": current_shell }),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": changed_shell.clone() }),
        tx.clone(),
    )
    .await
    .unwrap();

    let settings = handle_request(state, "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(settings["defaultCommandShell"], changed_shell);
}

#[tokio::test]
async fn settings_rejects_unavailable_or_cross_platform_shell() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let shell_id = crate::tools::shell::catalog(None)
        .choices
        .into_iter()
        .find(|choice| !choice.available)
        .map(|choice| choice.id)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                crate::tools::shell::BASH_ID.into()
            } else {
                crate::tools::shell::WINDOWS_POWERSHELL_ID.into()
            }
        });

    let error = handle_request(
        state,
        "settings.set",
        json!({ "defaultCommandShell": shell_id }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "COMMAND_SHELL_INVALID");
}

#[tokio::test]
async fn default_shell_setting_is_idle_only_across_turn_and_plan_work() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let agent = sessions::create_session(
        &app_state.db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let active_turn = sessions::begin_turn(&app_state.db, &agent.id, None, None).unwrap();
    let Some(current_shell) = available_test_shell_id() else {
        return;
    };
    let Some(changed_shell) = alternate_available_test_shell_id(&current_shell) else {
        return;
    };
    let state = Arc::new(Mutex::new(app_state));

    let active_error = handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": changed_shell.clone() }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(
        active_error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );

    {
        let st = state.lock().await;
        sessions::end_turn(&st.db, &active_turn, "completed", None, None, false).unwrap();
    }
    handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": changed_shell.clone() }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();

    let plan = {
        let st = state.lock().await;
        let plan_session = sessions::create_session(
            &st.db,
            Some("Plan".into()),
            Some("plan".into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let turn = sessions::begin_turn(&st.db, &plan_session.id, None, None).unwrap();
        let proposal = st
            .plans
            .submit(
                &st.db,
                PlanSubmitParams {
                    workspace_root: &project,
                    session_id: &plan_session.id,
                    turn_id: &turn,
                    tool_call_id: "submit-shell-gate",
                    kind: crate::plans::KIND_PLAN,
                    title: "Plan",
                    markdown: "# Plan",
                    question: "Proceed?",
                },
            )
            .unwrap();
        (plan_session.id, turn, proposal)
    };

    let pending_error = handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": current_shell.clone() }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(
        pending_error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );

    let execution_id = {
        let st = state.lock().await;
        sessions::end_turn(&st.db, &plan.1, "completed", None, None, false).unwrap();
        let resolution = st
            .plans
            .resolve(
                &st.db,
                PlanResolveParams {
                    workspace_root: Some(&project),
                    proposal_id: &plan.2.id,
                    session_id: &plan.0,
                    turn_id: &plan.1,
                    tool_call_id: &plan.2.tool_call_id,
                    version: Some(plan.2.version),
                    action: "approve",
                    target_permission_mode: Some("ask"),
                },
            )
            .unwrap();
        resolution.execution.unwrap().id
    };

    let queued_error = handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": current_shell.clone() }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(
        queued_error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );

    {
        let st = state.lock().await;
        st.plans.claim_execution(&st.db, &execution_id).unwrap();
    }
    let running_error = handle_request(
        state.clone(),
        "settings.set",
        json!({ "defaultCommandShell": current_shell.clone() }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(
        running_error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );

    {
        let st = state.lock().await;
        st.plans
            .finish_execution(&st.db, &execution_id, "completed", None)
            .unwrap();
    }
    handle_request(
        state,
        "settings.set",
        json!({ "defaultCommandShell": current_shell }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn bash_rejects_a_changed_shell_before_running_the_command() {
    let Some(current_shell_id) = available_test_shell_id() else {
        return;
    };
    let expected_shell_id = [
        crate::tools::shell::WINDOWS_POWERSHELL_ID,
        crate::tools::shell::CMD_ID,
        crate::tools::shell::GIT_BASH_ID,
        crate::tools::shell::BASH_ID,
    ]
    .into_iter()
    .find(|shell_id| *shell_id != current_shell_id)
    .unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let marker = project.join("must-not-run.txt");
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Shell mismatch".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    #[cfg(windows)]
    let command = format!("[IO.File]::WriteAllText('{}', 'ran')", marker.display());
    #[cfg(not(windows))]
    let command = format!("touch '{}'", marker.display());

    let result = handle_request(
        state,
        "tools.execute",
        json!({
            "sessionId": session.id,
            "toolCallId": "mismatch-call",
            "toolName": "Bash",
            "args": { "command": command },
            "expectedCommandShellId": expected_shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(expected_shell_id),
            "mode": "agent"
        }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
    assert_eq!(result["commandShellId"], current_shell_id);
    assert!(!marker.exists());
}

#[tokio::test]
async fn bash_rejects_a_stale_shell_dialect_before_permission_or_spawn() {
    let Some(current_shell_id) = available_test_shell_id() else {
        return;
    };
    let current_dialect = crate::tools::shell::dialect_for_id(&current_shell_id).unwrap();
    let stale_dialect = if current_dialect == "posix" {
        "powershell"
    } else {
        "posix"
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let marker = project.join("must-not-run-dialect.txt");
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Shell dialect mismatch".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let command = if cfg!(windows) {
        format!("[IO.File]::WriteAllText('{}', 'ran')", marker.display())
    } else {
        format!("touch '{}'", marker.display())
    };

    let result = handle_request(
        state,
        "tools.execute",
        json!({
            "sessionId": session.id,
            "toolCallId": "dialect-mismatch",
            "toolName": "Bash",
            "args": { "command": command },
            "expectedCommandShellId": current_shell_id,
            "expectedCommandShellDialect": stale_dialect,
            "mode": "agent"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
    assert_eq!(
        result["content"]["expectedCommandShellDialect"],
        stale_dialect
    );
    assert_eq!(result["content"]["commandShellDialect"], current_dialect);
    assert!(!marker.exists());
}

#[tokio::test]
async fn tools_abort_before_approval_cleans_the_cancellation_registry() {
    let Some(shell_id) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Abort before approval".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let session_id = session.id.clone();
    let pending_state = state.clone();
    let pending_task = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "abort-before-approval",
                "toolName": "Bash",
                "args": { "command": sleeping_bash_command() },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
    });
    wait_for_bash_registration(&state, &session.id, "abort-before-approval").await;

    let aborted = handle_request(
        state.clone(),
        "tools.abort",
        json!({
            "sessionId": session.id,
            "toolCallId": "abort-before-approval"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(aborted["found"], true);
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), pending_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    assert_eq!(result["content"]["code"], "TOOL_ABORTED");
    assert_bash_registry_empty(&state).await;

    let second = handle_request(
        state,
        "tools.abort",
        json!({
            "sessionId": session.id,
            "toolCallId": "abort-before-approval"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(second["found"], false);
}

#[tokio::test]
async fn permissions_pending_lists_the_open_request_until_resolved() {
    let Some(shell_id) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Pending permission read".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session_id = session.id.clone();
    let pending_state = state.clone();
    let pending_task = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "pending-read",
                "toolName": "Bash",
                "args": { "command": sleeping_bash_command() },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
    });
    let permission = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let permission: Value = serde_json::from_str(&permission).unwrap();
    assert_eq!(permission["method"], "permissions.request");
    let request_id = permission["params"]["requestId"]
        .as_str()
        .unwrap()
        .to_string();

    let listed = handle_request(
        state.clone(),
        "permissions.pending",
        json!({ "sessionId": session.id }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let requests = listed["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["requestId"], request_id);
    assert_eq!(requests[0]["sessionId"], session.id);
    assert_eq!(requests[0]["toolName"], "Bash");
    assert_eq!(requests[0]["timeoutMs"], 120000);
    assert!(
        requests[0]["expiresAt"].as_str().unwrap() > requests[0]["createdAt"].as_str().unwrap()
    );
    assert!(requests[0]["remainingMs"].as_u64().unwrap() <= 120000);

    let other = handle_request(
        state.clone(),
        "permissions.pending",
        json!({ "sessionId": "another-session" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(other["requests"].as_array().unwrap().is_empty());

    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "deny" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let result = pending_task.await.unwrap().unwrap();
    assert_eq!(result["errorCode"], "TOOL_DENIED");

    let after = handle_request(
        state.clone(),
        "permissions.pending",
        json!({}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert!(after["requests"].as_array().unwrap().is_empty());
    assert_bash_registry_empty(&state).await;
}

#[tokio::test]
async fn tools_abort_during_permission_removes_the_pending_request() {
    let Some(shell_id) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Abort during approval".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session_id = session.id.clone();
    let pending_state = state.clone();
    let pending_task = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "abort-during-approval",
                "toolName": "Bash",
                "args": { "command": sleeping_bash_command() },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
    });
    let permission = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let permission: Value = serde_json::from_str(&permission).unwrap();
    assert_eq!(permission["method"], "permissions.request");
    assert_eq!(
        permission["params"]["commandShellId"],
        crate::tools::shell::catalog(None).effective.unwrap().id
    );
    let request_id = permission["params"]["requestId"]
        .as_str()
        .unwrap()
        .to_string();

    let aborted = handle_request(
        state.clone(),
        "tools.abort",
        json!({
            "sessionId": session.id,
            "toolCallId": "abort-during-approval"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(aborted["aborted"], true);
    let result = pending_task.await.unwrap().unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");

    let late_resolution = handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "allow-once" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(late_resolution.data.unwrap()["errorCode"], "NOT_FOUND");
    assert_bash_registry_empty(&state).await;
}

#[tokio::test]
async fn tools_abort_during_execution_kills_bash_and_cleans_registry() {
    let Some(shell_id) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let started_marker = project.join("started.txt");
    let late_marker = project.join("late.txt");
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Abort execution".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let started_command = descendant_marker_bash_command(&started_marker, &late_marker);
    let session_id = session.id.clone();
    let pending_state = state.clone();
    let pending_task = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "abort-during-execution",
                "toolName": "Bash",
                "args": { "command": started_command },
                "expectedCommandShellId": shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
                "mode": "agent"
            }),
            tx,
        )
        .await
    });
    wait_for_bash_registration(&state, &session.id, "abort-during-execution").await;
    // The Bash process must reach its "started" state before we abort;
    // otherwise the abort races an unspawned process and the test proves
    // nothing. PowerShell bootstrap plus Start-Process routinely costs
    // well over a second on a loaded Windows host, so poll for the
    // definite state with a generous deadline instead of a short fixed
    // budget (a 1s window flaked at ~1.7s here).
    let start_deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !started_marker.exists() && std::time::Instant::now() < start_deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        started_marker.exists(),
        "the command should have started before abort"
    );

    let aborted = handle_request(
        state.clone(),
        "tools.abort",
        json!({
            "sessionId": session.id,
            "toolCallId": "abort-during-execution"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(aborted["found"], true);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), pending_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result["errorCode"], "TOOL_ABORTED");
    // The spawned descendant would write `late` ~1s after it starts (i.e.
    // shortly after `started`), so wait past that deadline and confirm it
    // never appears. Poll (rather than a single fixed sleep) so a genuine
    // leak fails promptly instead of relying on a timing coincidence.
    let late_deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < late_deadline {
        assert!(
            !late_marker.exists(),
            "aborted descendants must not write later"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        !late_marker.exists(),
        "aborted descendants must not write later"
    );
    assert_bash_registry_empty(&state).await;
}

#[tokio::test]
async fn bash_timeout_and_early_session_error_clean_the_registry() {
    let Some(shell_id) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Timeout".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let timeout_started = project.join("timeout-started.txt");
    let timeout_late = project.join("timeout-late.txt");
    let timeout_command = descendant_marker_bash_command(&timeout_started, &timeout_late);
    let timeout_result = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session.id,
            "toolCallId": "timeout-call",
            "toolName": "Bash",
            "args": { "command": timeout_command },
            "expectedCommandShellId": shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
            "timeoutMs": 1000,
            "mode": "agent"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(timeout_result["errorCode"], "TOOL_TIMEOUT");
    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    assert!(
        !timeout_late.exists(),
        "timed-out descendants must not write later"
    );
    assert_bash_registry_empty(&state).await;

    let early = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": "missing-session",
            "toolCallId": "early-error",
            "toolName": "Bash",
            "args": { "command": sleeping_bash_command() },
            "expectedCommandShellId": shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
            "mode": "agent"
        }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(early.data.unwrap()["errorCode"], "SESSION_NOT_FOUND");
    assert_bash_registry_empty(&state).await;
}

#[tokio::test]
async fn bash_output_is_streamed_with_shell_identity_and_unicode() {
    let Some(shell_id) = available_test_shell_id() else {
        return;
    };
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Output".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let result = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session.id,
            "toolCallId": "output-call",
            "toolName": "Bash",
            "args": { "command": output_bash_command() },
            "expectedCommandShellId": shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(&shell_id),
            "mode": "agent"
        }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["commandShellId"], shell_id);
    assert!(result["content"]["stdout"]
        .as_str()
        .unwrap()
        .contains("out-π"));
    assert!(result["content"]["stderr"]
        .as_str()
        .unwrap()
        .contains("err-π"));

    let mut streams = Vec::new();
    while let Ok(raw) = rx.try_recv() {
        let notification: Value = serde_json::from_str(&raw).unwrap();
        if notification["method"] == "tools.output" {
            assert_eq!(notification["params"]["commandShellId"], shell_id);
            streams.push(notification["params"]["stream"].clone());
        }
    }
    assert!(streams.iter().any(|stream| stream == "stdout"));
    assert!(streams.iter().any(|stream| stream == "stderr"));
    assert_bash_registry_empty(&state).await;
}

#[tokio::test]
async fn bash_mismatch_does_not_register_a_cancellation() {
    let Some(current_shell_id) = available_test_shell_id() else {
        return;
    };
    let expected_shell_id = if current_shell_id == crate::tools::shell::BASH_ID {
        crate::tools::shell::CMD_ID
    } else {
        crate::tools::shell::BASH_ID
    };
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let result = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": "missing-session",
            "toolCallId": "mismatch-no-register",
            "toolName": "Bash",
            "args": { "command": "should-not-run" },
            "expectedCommandShellId": expected_shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(expected_shell_id),
            "mode": "agent"
        }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(result["errorCode"], "COMMAND_SHELL_CHANGED");
    assert_bash_registry_empty(&state).await;
}

#[tokio::test]
async fn plan_rpc_submits_immediately_and_roundtrips_execution_outbox() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    app_state.workspace.set(data_dir.path().join("other"));
    let session = sessions::create_session(
        &app_state.db,
        Some("Plan".into()),
        Some("plan".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn_id = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, mut notifications) = mpsc::unbounded_channel();
    let markdown = "  # Plan\n- implement  \n";

    let submitted = handle_request(
        state.clone(),
        "plans.submit",
        json!({
            "sessionId": session.id,
            "turnId": turn_id,
            "toolCallId": "submit-call",
            "title": "Build API",
            "markdown": markdown,
            "question": "Proceed?"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(submitted["status"], "pending");
    assert_eq!(submitted["proposal"]["title"], "Build API");
    assert_eq!(submitted["proposal"]["markdown"], markdown);
    assert_eq!(submitted["proposal"]["plan"], markdown);
    assert_eq!(submitted["proposal"]["question"], "Proceed?");
    assert_eq!(
        submitted["proposal"]["artifact"]["sizeBytes"],
        json!(markdown.len())
    );
    let artifact_path = submitted["proposal"]["artifact"]["relativePath"]
        .as_str()
        .unwrap();
    assert_eq!(
        fs::read(project.join(artifact_path)).unwrap(),
        markdown.as_bytes()
    );
    assert!(submitted["proposal"].get("expiresAt").is_some());
    let _submit_event: Value = serde_json::from_str(&notifications.recv().await.unwrap()).unwrap();
    let proposal_id = submitted["proposal"]["id"].as_str().unwrap();
    let version = submitted["proposal"]["version"].as_i64().unwrap();

    let configure_error = handle_request(
        state.clone(),
        "session.configure",
        json!({
            "id": session.id,
            "mode": "agent",
            "permissionMode": "auto"
        }),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        configure_error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );

    let pending = handle_request(
        state.clone(),
        "plans.pending",
        json!({ "sessionId": session.id }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pending["plans"].as_array().unwrap().len(), 1);

    let resolved = handle_request(
        state.clone(),
        "plans.resolve",
        json!({
            "proposalId": proposal_id,
            "sessionId": session.id,
            "turnId": turn_id,
            "toolCallId": "submit-call",
            "version": version,
            "action": "approve",
            "targetPermissionMode": "auto"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(resolved["proposal"]["status"], "approved");
    assert_eq!(resolved["execution"]["state"], "queued");
    let execution_id = resolved["execution"]["id"].as_str().unwrap();

    let queued = handle_request(
        state.clone(),
        "plans.queuedExecutions",
        json!({}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(queued["executions"].as_array().unwrap().len(), 1);
    let claimed = handle_request(
        state.clone(),
        "plans.claimExecution",
        json!({ "executionId": execution_id }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(claimed["execution"]["state"], "running");
    let finished = handle_request(
        state,
        "plans.finishExecution",
        json!({ "executionId": execution_id, "status": "completed" }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(finished["execution"]["state"], "completed");
}

#[tokio::test]
async fn plan_enter_rpc_accepts_the_active_agent_turn() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let turn_id = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app_state));

    let entered = handle_request(
        state.clone(),
        "plans.enter",
        json!({
            "sessionId": session.id,
            "turnId": turn_id,
            "toolCallId": "enter-call"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(entered["state"], "planning");
    assert_eq!(
        sessions::session_mode(&state.lock().await.db, &session.id)
            .unwrap()
            .as_deref(),
        Some("plan")
    );
}

#[tokio::test]
async fn scheduled_run_rejects_contract_modes_before_creating_session_or_run() {
    // Plan and Goal both need a human to approve their proposal (D198), so
    // neither can be launched by the scheduler.
    for mode in ["plan", "goal"] {
        let data_dir = tempfile::tempdir().unwrap();
        let mut app_state = AppState::open(data_dir.path()).unwrap();
        app_state.handshook = true;
        let task = scheduled::create_task(
            &app_state.db,
            &json!({
                "title": format!("{mode} schedule"),
                "prompt": "run this",
                "mode": mode
            }),
        )
        .unwrap();
        assert_eq!(task.mode, mode);
        app_state
            .db
            .set_setting("app", &json!({ "defaultMode": "agent" }))
            .unwrap();
        let state = Arc::new(Mutex::new(app_state));
        let (tx, _rx) = mpsc::unbounded_channel();

        let error = handle_request(state.clone(), "scheduled.run", json!({ "id": task.id }), tx)
            .await
            .unwrap_err();
        assert_eq!(
            error.data.unwrap()["errorCode"],
            "PLAN_REQUIRES_INTERACTIVE_SESSION",
            "{mode}"
        );

        let st = state.lock().await;
        let session_count: i64 = st
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        let run_count: i64 = st
            .db
            .conn()
            .query_row("SELECT COUNT(*) FROM task_runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(session_count, 0, "{mode}");
        assert_eq!(run_count, 0, "{mode}");
    }
}

#[tokio::test]
async fn scheduled_agent_task_ignores_global_plan_default() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let task = scheduled::create_task(
        &app_state.db,
        &json!({ "title": "Agent schedule", "prompt": "run this" }),
    )
    .unwrap();
    app_state
        .db
        .set_setting("app", &json!({ "defaultMode": "plan" }))
        .unwrap();
    let state = Arc::new(Mutex::new(app_state));

    let result = handle_request(
        state.clone(),
        "scheduled.run",
        json!({ "id": task.id }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(result["task"]["mode"], "agent");
    let st = state.lock().await;
    let mode = sessions::session_mode(&st.db, result["sessionId"].as_str().unwrap()).unwrap();
    assert_eq!(mode.as_deref(), Some("agent"));
    assert!(result["runId"].as_str().is_some());
}

#[tokio::test]
async fn begin_turn_reports_agent_busy_without_creating_a_duplicate() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Busy".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let first = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app_state));

    let (tx, _rx) = mpsc::unbounded_channel();
    let error = handle_request(
        state.clone(),
        "session.beginTurn",
        json!({ "sessionId": session.id }),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "AGENT_BUSY");

    let st = state.lock().await;
    let running: i64 = st
        .db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM turns
             WHERE session_id = ?1 AND status = 'running'",
            [&session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(running, 1);
    drop(st);
    let st = state.lock().await;
    sessions::end_turn(&st.db, &first, "aborted", None, None, false).unwrap();
}

#[tokio::test]
async fn truncate_from_rpc_cuts_without_shipping_the_kept_prefix() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Large".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let turn = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    let prefix: sessions::UiMessage = serde_json::from_value(json!({
        "id": "u0",
        "role": "user",
        "content": "earlier",
        "createdAt": "2025-05-01T00:00:00Z"
    }))
    .unwrap();
    let root: sessions::UiMessage = serde_json::from_value(json!({
        "id": "u1",
        "role": "user",
        "content": "retry me",
        "createdAt": "2025-05-01T00:00:01Z"
    }))
    .unwrap();
    sessions::append_message(&app_state.db, &session.id, &prefix, Some(&turn)).unwrap();
    sessions::append_message(&app_state.db, &session.id, &root, Some(&turn)).unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    let result = handle_request(
        state.clone(),
        "session.truncateFrom",
        json!({ "sessionId": session.id, "fromMessageId": "u1" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["keptCount"], json!(1));
    assert_eq!(result["discardedCount"], json!(1));
    assert_eq!(result["abortedTurnId"], json!(turn));

    let detail = handle_request(
        state.clone(),
        "session.get",
        json!({ "id": session.id, "messageLimit": 10 }),
        tx,
    )
    .await
    .unwrap();
    let messages = detail["session"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], json!("u0"));

    let missing = handle_request(
        state,
        "session.truncateFrom",
        json!({ "sessionId": session.id, "fromMessageId": "gone" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(missing.data.unwrap()["errorCode"], "NOT_FOUND");
}

/// D137: the audit row for a tool call must carry the three segments
/// separately, so "the tool was slow" can be told apart from "the user
/// took 20s to approve it".
#[tokio::test]
async fn tool_execute_audit_records_segmented_timing() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("note.txt"), "hello").unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Timing".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    // Read is low risk, so it auto-allows and never prompts — the run
    // therefore has a zero approval segment by construction.
    let result = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session.id,
            "toolCallId": "tc-1",
            "toolName": "Read",
            "args": { "path": "note.txt" },
            "mode": "agent"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], json!(true), "read succeeded: {result}");

    let st = state.lock().await;
    let payload: String = st
        .db
        .conn()
        .query_row(
            "SELECT payload_json FROM audit_log WHERE kind = 'tool_execute' ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["toolName"], json!("Read"));
    assert_eq!(payload["prompted"], json!(false));
    // Auto-allowed, so the approval segment is bookkeeping only: assert it
    // is negligible rather than exactly zero, since a loaded test runner
    // can still spend a millisecond there.
    let permission_wait_ms = payload["permissionWaitMs"].as_u64().unwrap();
    assert!(
        permission_wait_ms < 100,
        "auto-allow does not wait: {permission_wait_ms}ms"
    );
    let execute_ms = payload["durationMs"].as_u64().unwrap();
    let overhead_ms = payload["overheadMs"].as_u64().unwrap();
    let total_ms = payload["totalMs"].as_u64().unwrap();
    assert!(
        total_ms >= execute_ms,
        "total {total_ms} covers execution {execute_ms}"
    );
    assert_eq!(
        overhead_ms,
        total_ms - execute_ms - permission_wait_ms,
        "segments add up to the total"
    );
}

#[tokio::test]
async fn outside_paths_prompt_in_plan_and_auto_allows_after_mode_switch() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    let outside = data_dir.path().join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let outside_file = outside.join("note.txt");
    fs::write(&outside_file, "outside content").unwrap();

    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("External path permission".into()),
        Some("plan".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "plan",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let request_state = state.clone();
    let session_id = session.id.clone();
    let path = outside_file.to_string_lossy().into_owned();
    let path_for_request = path.clone();
    let pending = tokio::spawn(async move {
        handle_request(
            request_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "outside-plan-read",
                "toolName": "Read",
                "args": { "path": path_for_request },
                "mode": "agent"
            }),
            notify_tx,
        )
        .await
    });

    let notification = notify_rx.recv().await.unwrap();
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    assert_eq!(
        notification["params"]["reason"],
        "Accesses a path outside the session workspace"
    );
    assert_eq!(notification["params"]["argsPreview"]["path"], path);
    let request_id = notification["params"]["requestId"].as_str().unwrap();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "deny" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let denied = pending.await.unwrap().unwrap();
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["errorCode"], "TOOL_DENIED");

    let request_state = state.clone();
    let session_id = session.id.clone();
    let path_for_request = path.clone();
    let (notify_tx2, mut notify_rx2) = mpsc::unbounded_channel();
    let allowed_pending = tokio::spawn(async move {
        handle_request(
            request_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "outside-plan-read-allowed",
                "toolName": "Read",
                "args": { "path": path_for_request },
                "mode": "agent"
            }),
            notify_tx2,
        )
        .await
    });
    let notification = notify_rx2.recv().await.unwrap();
    let notification: Value = serde_json::from_str(&notification).unwrap();
    let request_id = notification["params"]["requestId"].as_str().unwrap();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "allow-once" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let allowed = allowed_pending.await.unwrap().unwrap();
    assert_eq!(allowed["ok"], true);
    assert_eq!(allowed["content"]["root"], "external");
    let allowed_content = allowed["content"]["content"].as_str().unwrap();
    assert!(
        allowed_content.contains("outside content"),
        "{allowed_content}"
    );
    assert_eq!(allowed["content"]["tag"].as_str().unwrap().len(), 4);

    sessions::configure_session_with_thinking(
        &state.lock().await.db,
        &session.id,
        "plan",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let auto = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session.id,
            "toolCallId": "outside-plan-auto-read",
            "toolName": "Read",
            "args": { "path": outside_file.to_string_lossy() },
            "mode": "agent"
        }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(auto["ok"], true);
    assert_eq!(auto["content"]["root"], "external");
}

#[tokio::test]
async fn delegate_permission_scope_overrides_session_mode_without_opening_external_paths() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    let outside = data_dir.path().join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Delegate scope".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    // Session mode is `ask`: without a scope, Write prompts (ADR 0089).
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let session_id = session.id.clone();
    let outside_path = outside.join("note.txt").to_string_lossy().into_owned();

    // 1. In-workspace Write under `permissionScope: accept-edits` resolves
    //    without a permission request, despite the session being in `ask`.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let allowed = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session_id.clone(),
            "toolCallId": "delegate-write-scoped",
            "toolName": "Write",
            "args": { "path": "file.txt", "content": "delegated" },
            "mode": "agent",
            "permissionScope": "accept-edits"
        }),
        notify_tx,
    )
    .await
    .unwrap();
    assert_eq!(allowed["ok"], true);
    assert_eq!(allowed["content"]["root"], "workspace");
    // No permission request may arrive: the scope auto-allowed the write.
    // The channel is dropped with the request, so Ok(None) counts as clean.
    let stray = tokio::time::timeout(std::time::Duration::from_millis(100), notify_rx.recv()).await;
    match stray {
        Err(_) | Ok(None) => {}
        Ok(Some(text)) => {
            panic!("scoped in-workspace Write raised an unexpected notification: {text}")
        }
    }

    // 2. The same call without a scope prompts under the session's `ask`.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let pending_state = state.clone();
    let pending_session_id = session_id.clone();
    let pending = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": pending_session_id,
                "toolCallId": "delegate-write-unscoped",
                "toolName": "Write",
                "args": { "path": "file2.txt", "content": "delegated" },
                "mode": "agent"
            }),
            notify_tx,
        )
        .await
    });
    let notification = notify_rx.recv().await.unwrap();
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    assert_eq!(
        notification["params"]["reason"],
        "Modifies files in your workspace"
    );
    let request_id = notification["params"]["requestId"].as_str().unwrap();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "allow-once" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["ok"], true);

    // 3. An external-path Write keeps prompting even under the scope: the
    //    scope only relaxes the session mode, never the path gate.
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let pending_state = state.clone();
    let pending_session_id = session_id.clone();
    let pending_outside_path = outside_path.clone();
    let pending = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": pending_session_id,
                "toolCallId": "delegate-write-external",
                "toolName": "Write",
                "args": { "path": pending_outside_path, "content": "delegated" },
                "mode": "agent",
                "permissionScope": "accept-edits"
            }),
            notify_tx,
        )
        .await
    });
    let notification = notify_rx.recv().await.unwrap();
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    assert_eq!(
        notification["params"]["reason"],
        "Accesses a path outside the session workspace"
    );
    let request_id = notification["params"]["requestId"].as_str().unwrap();
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "allow-once" }),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let allowed = pending.await.unwrap().unwrap();
    assert_eq!(allowed["ok"], true);
    assert_eq!(allowed["content"]["root"], "external");
}

#[tokio::test]
async fn builtin_delegate_without_permission_scope_inherits_auto_for_external_glob() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    let outside = data_dir.path().join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let outside_file = outside.join("delegate-note.txt");
    fs::write(&outside_file, "outside content").unwrap();

    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Auto delegate external glob".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let session_id = session.id.clone();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session_id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let outside_path = outside.to_string_lossy().into_owned();

    // A builtin fixer inherits the parent mode, so the same external Glob
    // that triggered the reported card is allowed in auto without a scope.
    let result = handle_request(
        state,
        "tools.execute",
        json!({
            "sessionId": session_id,
            "toolCallId": "delegate-external-glob-auto",
            "toolName": "Glob",
            "args": { "path": outside_path, "pattern": "**/*", "limit": 10 },
            "mode": "agent"
        }),
        notify_tx,
    )
    .await
    .unwrap();
    assert_eq!(result["ok"], true, "external auto Glob failed: {result}");
    // External Glob results are absolute rather than carrying a root field.
    let canonical_outside_file = crate::workspace::simple_canonicalize(&outside_file).unwrap();
    assert_eq!(
        result["content"]["matches"][0],
        json!(canonical_outside_file.to_string_lossy()),
    );

    let stray = tokio::time::timeout(std::time::Duration::from_millis(100), notify_rx.recv()).await;
    match stray {
        Err(_) | Ok(None) => {}
        Ok(Some(text)) => {
            panic!("auto external Glob raised an unexpected notification: {text}")
        }
    }
}

#[tokio::test]
async fn plan_authorization_uses_durable_mode_and_keeps_bash_permission_semantics() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Plan".into()),
        Some("plan".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let session_id = session.id.clone();
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session_id,
        "plan",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();
    let command_shell_id = crate::tools::shell::default_shell_id();
    #[cfg(windows)]
    let plan_bash_command = "[Console]::Out.Write('plan-bash')";
    #[cfg(not(windows))]
    let plan_bash_command = "printf plan-bash";

    for (tool_name, args, expected) in [
        (
            "Write",
            json!({ "path": "ignored.txt", "content": "no" }),
            "WRITE_DISABLED_IN_PLAN",
        ),
        (
            "Edit",
            json!({ "path": "ignored.txt", "tag": "ABCD", "ops": "PUT 1.=1:\n+b\n" }),
            "EDIT_DISABLED_IN_PLAN",
        ),
        ("plugin_demo_run", json!({}), "PLUGIN_DISABLED_IN_PLAN"),
        ("UnknownTool", json!({}), "TOOL_DISABLED_IN_PLAN"),
    ] {
        let result = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": format!("{tool_name}-call"),
                "toolName": tool_name,
                "args": args,
                "mode": "agent"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], expected, "{tool_name}");
        assert_eq!(result["ok"], false);
    }

    let bash = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session_id,
            "toolCallId": "bash-auto",
            "toolName": "Bash",
            "args": { "command": plan_bash_command },
            "expectedCommandShellId": command_shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(command_shell_id),
            "mode": "agent"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(bash["ok"], true);
    assert_eq!(bash["content"]["stdout"], "plan-bash");

    sessions::configure_session_with_thinking(
        &state.lock().await.db,
        &session_id,
        "plan",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    #[cfg(windows)]
    let ask_bash_command = "[Console]::Out.Write('ask-bash')";
    #[cfg(not(windows))]
    let ask_bash_command = "printf ask-bash";
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    let pending_state = state.clone();
    let pending_task = tokio::spawn(async move {
        handle_request(
            pending_state,
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": "bash-ask",
                "toolName": "Bash",
                "args": { "command": ask_bash_command },
                "expectedCommandShellId": command_shell_id,
                "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(command_shell_id),
                "mode": "agent"
            }),
            notify_tx,
        )
        .await
    });
    let notification = notify_rx.recv().await.unwrap();
    let notification: Value = serde_json::from_str(&notification).unwrap();
    assert_eq!(notification["method"], "permissions.request");
    let request_id = notification["params"]["requestId"].as_str().unwrap();
    handle_request(
        state,
        "permissions.resolve",
        json!({ "requestId": request_id, "decision": "allow-once" }),
        tx,
    )
    .await
    .unwrap();
    let pending_result = pending_task.await.unwrap().unwrap();
    assert_eq!(pending_result["ok"], true);
}

#[tokio::test]
async fn goal_authorization_reuses_the_durable_contract_mode_hard_deny() {
    let data_dir = tempfile::tempdir().unwrap();
    let project = data_dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("Goal".into()),
        Some("goal".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let session_id = session.id.clone();
    // `auto` is the strongest permission mode; the deny must still win.
    sessions::configure_session_with_thinking(
        &app_state.db,
        &session_id,
        "goal",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    for (tool_name, args, expected) in [
        (
            "Write",
            json!({ "path": "ignored.txt", "content": "no" }),
            "WRITE_DISABLED_IN_PLAN",
        ),
        (
            "Edit",
            json!({ "path": "ignored.txt", "tag": "ABCD", "ops": "PUT 1.=1:\n+b\n" }),
            "EDIT_DISABLED_IN_PLAN",
        ),
        ("plugin_demo_run", json!({}), "PLUGIN_DISABLED_IN_PLAN"),
        ("UnknownTool", json!({}), "TOOL_DISABLED_IN_PLAN"),
    ] {
        let result = handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId": session_id,
                "toolCallId": format!("goal-{tool_name}-call"),
                "toolName": tool_name,
                "args": args,
                // A sidecar claiming Agent cannot widen the durable mode.
                "mode": "agent"
            }),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], expected, "{tool_name}");
        assert_eq!(result["ok"], false);
    }

    // Bash still follows the permission mode rather than the allowlist.
    #[cfg(windows)]
    let goal_bash_command = "[Console]::Out.Write('goal-bash')";
    #[cfg(not(windows))]
    let goal_bash_command = "printf goal-bash";
    let command_shell_id = crate::tools::shell::default_shell_id();
    let bash = handle_request(
        state.clone(),
        "tools.execute",
        json!({
            "sessionId": session_id,
            "toolCallId": "goal-bash-auto",
            "toolName": "Bash",
            "args": { "command": goal_bash_command },
            "expectedCommandShellId": command_shell_id,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(command_shell_id),
            "mode": "agent"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(bash["ok"], true);
    assert_eq!(bash["content"]["stdout"], "goal-bash");
}

#[tokio::test]
async fn provider_model_cache_roundtrips_through_rpc() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    let created = handle_request(
        state.clone(),
        "providers.create",
        json!({
            "name": "Local catalog",
            "baseUrl": "http://localhost:11434/v1",
            "authKind": "none",
            "defaultModelId": "model-a"
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    let provider_id = created["provider"]["id"].as_str().unwrap();

    let cached = handle_request(
        state.clone(),
        "providers.cacheModels",
        json!({
            "providerId": provider_id,
            "models": [
                {
                    "modelId": "model-a",
                    "displayName": "Model A",
                    "capabilities": ["text"]
                },
                {
                    "modelId": "model-b",
                    "displayName": "Model B",
                    "capabilities": ["text", "reasoning"]
                }
            ]
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(cached["cached"], 2);

    let listed = handle_request(
        state,
        "providers.listModels",
        json!({ "providerId": provider_id }),
        tx,
    )
    .await
    .unwrap();
    assert_eq!(listed["models"].as_array().unwrap().len(), 2);
    assert_eq!(listed["models"][1]["modelId"], "model-b");
    assert_eq!(listed["models"][1]["capabilities"][1], "reasoning");
}

#[tokio::test]
async fn inflight_checkpoint_rpc_lifecycle() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(&app_state.db, None, None, None, None, None).unwrap();
    let turn = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    let saved = handle_request(
        state.clone(),
        "session.saveInflightMessage",
        json!({
            "sessionId": session.id,
            "turnId": turn,
            "message": {
                "id": "a1",
                "role": "assistant",
                "content": "partial reply",
                "createdAt": "2026-09-04T00:00:00.000Z",
                "status": "streaming"
            }
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(saved, json!({ "ok": true, "saved": true }));

    // The sidecar is gone: the turn end promotes the checkpoint.
    let ended = handle_request(
        state.clone(),
        "session.endTurn",
        json!({
            "turnId": turn,
            "status": "aborted",
            "errorCode": "TURN_ABORTED",
            "createNotification": false,
            "recoverInflight": true
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(ended["ok"], json!(true));
    assert_eq!(ended["recovered"]["id"], json!("a1"));
    assert_eq!(ended["recovered"]["status"], json!("aborted"));
    assert_eq!(ended["recovered"]["content"], json!("partial reply"));

    let detail = handle_request(
        state.clone(),
        "session.get",
        json!({ "id": session.id }),
        tx.clone(),
    )
    .await
    .unwrap();
    let messages = detail["session"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["status"], json!("aborted"));
}

#[tokio::test]
async fn notification_rpc_lifecycle() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let session = sessions::create_session(
        &app_state.db,
        Some("RPC task".into()),
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let turn = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    sessions::end_turn(&app_state.db, &turn, "completed", None, None, true).unwrap();
    let visible_turn = sessions::begin_turn(&app_state.db, &session.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app_state));
    let (tx, _rx) = mpsc::unbounded_channel();

    let ended_visible = handle_request(
        state.clone(),
        "session.endTurn",
        json!({
            "turnId": visible_turn,
            "status": "completed",
            "createNotification": false
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(ended_visible, json!({ "ok": true }));

    let listed = handle_request(
        state.clone(),
        "notification.list",
        json!({ "unreadOnly": true, "limit": 10 }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(listed["unreadCount"], 1);
    assert_eq!(listed["notifications"][0]["kind"], "task.completed");
    assert_eq!(listed["notifications"][0]["sessionTitle"], "RPC task");
    let id = listed["notifications"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let marked = handle_request(
        state.clone(),
        "notification.markRead",
        json!({ "id": id }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(marked, json!({ "ok": true }));
    let marked_all = handle_request(
        state.clone(),
        "notification.markAllRead",
        json!({}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(marked_all, json!({ "ok": true }));
    let cleared = handle_request(state.clone(), "notification.clear", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(cleared, json!({ "ok": true }));

    let remaining: i64 = state
        .lock()
        .await
        .db
        .conn()
        .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
        .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn plugin_labels_follow_the_pushed_app_language() {
    let data_dir = tempfile::tempdir().unwrap();
    let mut app_state = AppState::open(data_dir.path()).unwrap();
    app_state.handshook = true;
    let state = Arc::new(Mutex::new(app_state));
    let tx = mpsc::unbounded_channel().0;

    // A concrete app language in settings pins the locale even before the
    // shell pushes one.
    handle_request(
        state.clone(),
        "settings.set",
        json!({ "language": "zh-CN" }),
        tx.clone(),
    )
    .await
    .unwrap();
    {
        let st = state.lock().await;
        assert_eq!(st.plugins.locale(), "zh-CN");
    }

    // `auto` is a setting, not a locale: the shell resolves it, and the
    // host must not start reading `zh-CN` off the raw value.
    handle_request(
        state.clone(),
        "settings.set",
        json!({ "language": "auto" }),
        tx.clone(),
    )
    .await
    .unwrap();
    {
        let st = state.lock().await;
        assert_eq!(st.plugins.locale(), "zh-CN");
    }

    let pushed = handle_request(
        state.clone(),
        "plugins.setLocale",
        json!({ "locale": "en-US" }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(pushed["locale"], "en-US");
    {
        let st = state.lock().await;
        assert_eq!(st.plugins.locale(), "en-US");
    }

    // Neither an empty value nor `auto` overwrites the resolved locale.
    for value in [
        json!({ "locale": "" }),
        json!({ "locale": "auto" }),
        json!({}),
    ] {
        handle_request(state.clone(), "plugins.setLocale", value, tx.clone())
            .await
            .unwrap();
    }
    let st = state.lock().await;
    assert_eq!(st.plugins.locale(), "en-US");
}
