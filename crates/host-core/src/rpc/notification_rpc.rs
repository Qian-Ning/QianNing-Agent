use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::notifications;

/// Handles the `notification*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "notification.list" => {
            let unread_only = params
                .get("unreadOnly")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let limit = params
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(crate::db::NOTIFICATION_KEEP);
            let st = state.lock().await;
            let (notifications, unread_count) = notifications::list(&st.db, unread_only, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "notifications": notifications,
                "unreadCount": unread_count
            }))
        }
        "notification.markRead" => {
            let id = params
                .get("id")
                .and_then(|value| value.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = notifications::mark_read(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "notification.markAllRead" => {
            let st = state.lock().await;
            notifications::mark_all_read(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "notification.clear" => {
            let st = state.lock().await;
            notifications::clear(&st.db).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
