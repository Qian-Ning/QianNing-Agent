use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::sessions;

/// Handles the `search*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "search.sessions" => {
            let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if query.chars().count() > 500 {
                return Err(rpc_err(
                    1001,
                    "query exceeds 500 characters",
                    "INVALID_ARGUMENT",
                ));
            }
            let offset = params.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);
            let st = state.lock().await;
            let page = crate::session_search::search(&st.db, query, offset)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!(page))
        }
        "search.context" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let message_id = params
                .get("messageId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let direction = params
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("around");
            if session_id.is_empty()
                || message_id.is_empty()
                || query.chars().count() > 500
                || !matches!(direction, "around" | "before" | "after")
            {
                return Err(rpc_err(1001, "invalid search context", "INVALID_ARGUMENT"));
            }
            let st = state.lock().await;
            let context =
                crate::session_search::context(&st.db, session_id, message_id, direction, query)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                    .ok_or_else(|| rpc_err(1007, "message not found", "NOT_FOUND"))?;
            Ok(json!(context))
        }

        "search.query" => {
            let query = params
                .get("query")
                .or_else(|| params.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(20);
            let st = state.lock().await;
            let hits = sessions::search_messages(&st.db, query, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "hits": hits }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
