use super::{rpc_err, AppState, JsonRpcError};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `project.memory*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "project.memory.get" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .get_project_memory(path)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.memory.set" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            if let Some(entries) = params.get("entries") {
                let memory = st
                    .db
                    .set_project_memory_entries(path, entries)
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
                return Ok(json!({ "memory": memory }));
            }
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "content required", "INVALID_PARAMS"))?;
            let memory = st
                .db
                .set_project_memory(path, content)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
