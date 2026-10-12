use super::{rpc_err, AppState, JsonRpcError};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `project*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    _params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "project.groups.list" => {
            let st = state.lock().await;
            let groups = st
                .db
                .list_project_groups()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "groups": groups }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
