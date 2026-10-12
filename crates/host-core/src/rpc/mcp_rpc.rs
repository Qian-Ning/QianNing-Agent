use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{parse_capability_query, parse_capability_target, parse_scope, require_id, scope_err};
use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `mcp*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "mcp.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let servers = st
                .mcp_servers
                .list(level, project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let servers = st.mcp_servers.active_for(project_path).map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.upsert" => {
            let input: crate::mcp_servers::McpServerInput =
                serde_json::from_value(params.get("server").cloned().unwrap_or(params.clone()))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.upsert(input).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.remove" => {
            let id = require_id(&params)?;
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let ok = st
                .mcp_servers
                .remove(&id, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "ok": ok }))
        }
        "mcp.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.set_scope(&id, scope).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.transfer" => {
            let id = require_id(&params)?;
            let from = parse_capability_target(&params, "from")?;
            let to = parse_capability_target(&params, "to")?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .transfer(&id, &from, &to)
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
