//! The `Connection` tool: one tool the model calls to run work on a target.
//!
//! The definition lives in [`crate::connection`] next to the layer it
//! describes; this module owns the two decisions that belong to the tool
//! surface — when the tool is offered, and how a call is dispatched.
//!
//! # One implementation, two doors
//!
//! Dispatch does not re-implement anything. It maps the tool's `action`
//! vocabulary onto the `connection.*` method names and calls
//! [`super::connection_rpc::handle`], so the gate, the profile check, the
//! transport, the budget, and the audit row are literally the same code the
//! RPC door runs. D659's defect class is a listing door and an execution door
//! that drift apart; a second implementation here would be the way that drift
//! starts.
//!
//! Offered only while the switch is on, and refused at execute time when it is
//! off. Both halves matter: a model with the definition in context will
//! sometimes call it from memory after the user switches the setting off
//! mid-session, and the gate has to hold on the call, not just on the listing.

use std::sync::Arc;

use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError, Value};
use crate::tools::ToolsExecuteResult;

/// The one tool name this module answers to.
pub const TOOL_NAME: &str = "Connection";

pub fn recognizes(name: &str) -> bool {
    name == TOOL_NAME
}

/// The tool, as a one-element list so the caller appends it like the other
/// optional tool groups.
pub fn definitions() -> Vec<Value> {
    vec![crate::connection::tool_definition()]
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message.to_string(), "INVALID_PARAMS")
}

/// Translate one tool call into the method it names.
///
/// Only the three actions this milestone dispatches are accepted. An action the
/// definition does not advertise is an unknown action rather than a method
/// lookup, so a model that invents `upload` is told the vocabulary rather than
/// being handed the dispatcher's internal error.
fn forward(args: &Value, session_id: &str) -> Result<(&'static str, Value), JsonRpcError> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("action is required"))?;

    let profile = || {
        args.get("profile")
            .or_else(|| args.get("profileId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| invalid("profile is required"))
    };

    match action {
        "list" => Ok(("connection.list", serde_json::json!({}))),
        "probe" => Ok((
            "connection.probe",
            serde_json::json!({ "profileId": profile()? }),
        )),
        "exec" => {
            // The profile is checked first: without one there is nothing to
            // address, so that is the fact a caller needs to be told.
            let profile_id = profile()?;
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| invalid("command is required"))?;
            let mut forwarded = serde_json::json!({
                "profileId": profile_id,
                "command": command,
                // The spill file is read back by the local Read tool, so the
                // call carries the session that owns the scratch directory.
                "sessionId": session_id,
            });
            if let Some(timeout) = args.get("timeoutMs").filter(|value| !value.is_null()) {
                forwarded["timeoutMs"] = timeout.clone();
            }
            Ok(("connection.exec", forwarded))
        }
        other => Err(invalid(&format!(
            "action must be one of list, probe or exec, not {other}"
        ))),
    }
}

async fn dispatch(
    state: &Arc<Mutex<AppState>>,
    args: &Value,
    session_id: &str,
) -> Result<Value, JsonRpcError> {
    let (method, forwarded) = forward(args, session_id)?;
    super::connection_rpc::handle(state, method, forwarded).await
}

/// The code slug this door reports for a host error.
///
/// Every error the connection layer produces carries `data.errorCode`,
/// including the ones whose payload fields travel beside it — `fingerprint`
/// for a host key, `profile` for a missing target. This function reads only the
/// slug, which is why the payload rule is "add beside, never replace": a
/// payload that replaced the slug would make this door answer `INTERNAL` for a
/// failure the RPC method named.
fn result_code(error: &JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data["errorCode"].as_str())
        .unwrap_or("INTERNAL")
        .to_string()
}

pub async fn execute(
    state: &Arc<Mutex<AppState>>,
    p: &crate::tools::ToolsExecuteParams,
) -> ToolsExecuteResult {
    let started = std::time::Instant::now();
    let result = dispatch(state, &p.args, &p.session_id).await;
    let (ok, content, error_code) = match result {
        Ok(content) => (true, content, None),
        Err(error) => {
            let code = result_code(&error);
            (
                false,
                serde_json::json!({ "error": error.message, "code": code }),
                Some(code),
            )
        }
    };
    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code,
        command_shell_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_advertised_actions_are_forwarded() {
        // The definition advertises list, probe and exec. An action the
        // definition does not carry must be an unknown action rather than a
        // method lookup, so a model that invents one is told the vocabulary.
        for action in ["list", "probe", "exec"] {
            assert!(matches!(action, "list" | "probe" | "exec"));
        }
        let error = forward(&json!({ "action": "upload" }), "s").expect_err("unknown");
        assert!(
            error.message.contains("list, probe or exec"),
            "{}",
            error.message
        );
    }

    #[test]
    fn an_action_is_required() {
        let error = forward(&json!({}), "s").expect_err("no action");
        assert_eq!(error.message, "action is required");
    }

    #[test]
    fn probe_and_exec_require_a_profile() {
        for action in ["probe", "exec"] {
            let error = forward(&json!({ "action": action }), "s").expect_err("no profile");
            assert_eq!(error.message, "profile is required", "action {action}");
        }
    }

    #[test]
    fn exec_requires_a_command() {
        let error =
            forward(&json!({ "action": "exec", "profile": "0f5c" }), "s").expect_err("no command");
        assert_eq!(error.message, "command is required");
    }

    #[test]
    fn the_profile_reads_from_either_spelling() {
        // The operator-facing method takes `profileId`; a model reading the
        // tool definition sees `profile`. Both are the same fact.
        let (_, by_profile) =
            forward(&json!({ "action": "probe", "profile": "a" }), "s").expect("forwards");
        assert_eq!(by_profile["profileId"], json!("a"));
        let (_, by_id) =
            forward(&json!({ "action": "probe", "profileId": "b" }), "s").expect("forwards");
        assert_eq!(by_id["profileId"], json!("b"));
    }

    #[test]
    fn list_forwards_nothing_and_exec_carries_the_session() {
        let (method, forwarded) = forward(&json!({ "action": "list" }), "s").expect("forwards");
        assert_eq!(method, "connection.list");
        assert_eq!(forwarded, json!({}));

        let (method, forwarded) = forward(
            &json!({ "action": "exec", "profile": "0f5c", "command": "uptime" }),
            "session-7",
        )
        .expect("forwards");
        assert_eq!(method, "connection.exec");
        assert_eq!(forwarded["profileId"], json!("0f5c"));
        assert_eq!(forwarded["command"], json!("uptime"));
        assert_eq!(
            forwarded["sessionId"],
            json!("session-7"),
            "the spill file needs the session that owns the scratch directory"
        );
        assert!(
            forwarded.get("timeoutMs").is_none(),
            "an absent timeout must not become a null"
        );
    }

    #[test]
    fn a_requested_timeout_is_carried_through() {
        let (_, forwarded) = forward(
            &json!({ "action": "exec", "profile": "a", "command": "x", "timeoutMs": 5000 }),
            "s",
        )
        .expect("forwards");
        assert_eq!(forwarded["timeoutMs"], json!(5000));
    }

    #[test]
    fn the_result_code_reads_the_slug_beside_any_payload() {
        // The payload rule under test: a field is added beside the slug, so
        // this reader keeps working for every error shape.
        let mut error = rpc_err(
            1033,
            "the host key changed".to_string(),
            "CONNECTION_HOST_KEY",
        );
        error.data = Some(json!({
            "errorCode": "CONNECTION_HOST_KEY",
            "fingerprint": "SHA256:abcdef",
            "kind": "changed",
        }));
        assert_eq!(result_code(&error), "CONNECTION_HOST_KEY");

        let bare = rpc_err(1029, "off".to_string(), "CONNECTION_DISABLED");
        assert_eq!(result_code(&bare), "CONNECTION_DISABLED");

        let malformed = JsonRpcError {
            code: 1000,
            message: "no data".into(),
            data: None,
        };
        assert_eq!(result_code(&malformed), "INTERNAL");
    }

    #[test]
    fn the_tool_recognizes_only_its_own_name() {
        // `Console` is a separate tool (R4) and must not be swallowed here.
        assert!(recognizes("Connection"));
        assert!(!recognizes("Console"));
        assert!(!recognizes("Computer"));
        assert!(!recognizes("connection"));
    }

    #[test]
    fn the_definition_is_the_layers_own() {
        let definitions = definitions();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0]["name"], json!("Connection"));
        assert_eq!(definitions[0]["risk"], json!("high"));
    }
}
