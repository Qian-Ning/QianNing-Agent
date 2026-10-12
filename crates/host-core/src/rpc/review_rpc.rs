use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::resolve_tool_workspace;
use super::{rpc_err, AppState, JsonRpcError};
use crate::review;
use crate::sessions;

/// Handles the `review*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "review.rollback" => {
            let session_id = params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let snapshot_id = params
                .get("snapshotId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "snapshotId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let workspace_root = resolve_tool_workspace(&st, session_id)?;
            let outcome = review::rollback_change(
                &st.data_dir,
                session_id,
                snapshot_id,
                workspace_root.as_deref().map(std::path::Path::new),
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            if matches!(outcome.status, "rolledBack" | "alreadyRolledBack") {
                if let Some(root) = workspace_root.as_deref() {
                    let resolved = std::path::Path::new(root).join(&outcome.path);
                    st.hashline.invalidate_path(
                        session_id,
                        &crate::tools::hashline::canonical_key(&resolved),
                    );
                }
                sessions::update_tool_review_state(
                    &st.db,
                    session_id,
                    &outcome.message_id,
                    snapshot_id,
                    "rolledBack",
                )
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            }
            Ok(serde_json::to_value(outcome)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
