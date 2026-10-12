use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{parse_scope, parse_subagent_input, require_id, subagent_err};
use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `agents*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "agents.list" => {
            let mut st = state.lock().await;
            Ok(json!({ "subagents": st.user_subagents.list().map_err(subagent_err)? }))
        }
        "agents.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            Ok(
                json!({ "subagents": st.user_subagents.active_for(project_path).map_err(subagent_err)? }),
            )
        }
        "agents.create" => {
            let input = parse_subagent_input(&params)?;
            let mut st = state.lock().await;
            let subagent = st.user_subagents.create(input).map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.update" => {
            let id = require_id(&params)?;
            let input = parse_subagent_input(&params)?;
            let mut st = state.lock().await;
            let subagent = st.user_subagents.update(&id, input).map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.read" => {
            let id = require_id(&params)?;
            let mut st = state.lock().await;
            match st.user_subagents.read(&id).map_err(subagent_err)? {
                Some((subagent, body)) => Ok(json!({ "subagent": subagent, "body": body })),
                None => Ok(json!({ "subagent": null, "body": null })),
            }
        }
        "agents.remove" => {
            let id = require_id(&params)?;
            let mut st = state.lock().await;
            let ok = st.user_subagents.remove(&id).map_err(subagent_err)?;
            Ok(json!({ "ok": ok }))
        }
        "agents.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut st = state.lock().await;
            let subagent = st
                .user_subagents
                .set_enabled(&id, enabled)
                .map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let subagent = st
                .user_subagents
                .set_scope(&id, scope)
                .map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.disabledBuiltins" => {
            let st = state.lock().await;
            Ok(json!({ "disabled": st.user_subagents.disabled_builtins() }))
        }
        "agents.setBuiltinEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut st = state.lock().await;
            let id = st
                .user_subagents
                .set_builtin_enabled(&id, enabled)
                .map_err(subagent_err)?;
            Ok(json!({ "id": id, "enabled": enabled }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
