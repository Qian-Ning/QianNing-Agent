use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use super::command_shell_catalog;
use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `commandShells*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    _params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "commandShells.list" => {
            let st = state.lock().await;
            let catalog = command_shell_catalog(&st)?;
            serde_json::to_value(catalog).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
