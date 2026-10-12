use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::audit;

/// Handles the `audit*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "audit.append" => {
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("custom");
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let payload = params.get("payload").cloned().unwrap_or(json!({}));
            let st = state.lock().await;
            audit::append(&st.db, kind, session_id, payload)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }

        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
