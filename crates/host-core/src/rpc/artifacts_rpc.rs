use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::artifacts;

/// Handles the `artifacts*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "artifacts.list" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(200);
            let st = state.lock().await;
            let artifacts = artifacts::list(&st.db, session_id, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "artifacts": artifacts }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
