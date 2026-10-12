use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `secrets*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "secrets.set" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "value required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let backend = st
                .secrets
                .set(secret_ref, value)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "backend": backend }))
        }
        "secrets.delete" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            st.secrets
                .delete(secret_ref)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "secrets.has" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            Ok(json!({ "has": st.secrets.has(secret_ref) }))
        }
        "secrets.getForRuntime" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let value = st
                .secrets
                .get(secret_ref)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "value": value }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
