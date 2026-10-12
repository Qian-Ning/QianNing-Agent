use super::{rpc_err, AppState, JsonRpcError};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `project.group*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "project.group.create" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let folders = params
                .get("folders")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_err(1002, "folders required", "INVALID_PARAMS"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let st = state.lock().await;
            let group = st
                .db
                .create_project_group(name, &folders)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.update" => {
            let group_id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let folders = params
                .get("folders")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_err(1002, "folders required", "INVALID_PARAMS"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let st = state.lock().await;
            let group = st
                .db
                .update_project_group(group_id, name, &folders)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.rename" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let group = st
                .db
                .rename_project_group(id, name)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.memory.get" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .get_project_group_memory(id)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.group.memory.set" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let entries = params
                .get("entries")
                .ok_or_else(|| rpc_err(1002, "entries required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .set_project_group_memory(id, entries)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.group.context" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let context = st
                .db
                .project_group_context_for_path(path)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "context": context }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
