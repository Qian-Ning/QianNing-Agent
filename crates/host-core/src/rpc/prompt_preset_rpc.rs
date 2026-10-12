use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::prompt_presets;

/// Handles the `promptPreset*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "promptPreset.list" => {
            let st = state.lock().await;
            let presets = prompt_presets::list(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "presets": presets }))
        }
        "promptPreset.save" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let text = params
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "text required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let preset = prompt_presets::save(&st.db, name, text)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "preset": preset }))
        }
        "promptPreset.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let deleted = prompt_presets::delete(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": deleted }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
