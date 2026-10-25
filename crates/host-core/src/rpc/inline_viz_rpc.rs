use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::inline_viz;

/// Whether the user has switched inline visualizations on (default off).
/// Mirrors `computer_rpc::control_enabled` for the tools.list offer gate.
pub(crate) async fn enabled(state: &Arc<Mutex<AppState>>) -> bool {
    let st = state.lock().await;
    inline_viz::enabled(&st.db)
}

/// Handles the `inlineViz*` family (ADR 0327): the renderer's read-only
/// window into the visualizations an agent turn wrote to a session. There is
/// deliberately no write method here — artifacts are written only by the
/// agent runtime through `tools.execute` (`WriteInlineVisualization`), so a
/// renderer compromise cannot plant content.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "inlineViz.list" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let visualizations = inline_viz::list(&st.data_dir, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "visualizations": visualizations }))
        }
        "inlineViz.read" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let visualization_id = params
                .get("visualizationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "visualizationId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let artifact = inline_viz::read(&st.data_dir, session_id, visualization_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "visualization not found", "NOT_FOUND"))?;
            Ok(json!({ "visualization": artifact }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
