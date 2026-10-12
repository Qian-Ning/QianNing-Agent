use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::plugin_session_rpc_err;
use super::{rpc_err, AppState, JsonRpcError};
use crate::plugin_sessions;
use crate::plugin_usage;

/// Handles the `plugin*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "plugin.session.import" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            if !st.allow_plugin_import(plugin_id, false) {
                return Err(rpc_err(1006, "plugin import rate exceeded", "RATE_LIMITED"));
            }
            let result = plugin_sessions::import(&st.db, plugin_id, &params)
                .map_err(plugin_session_rpc_err)?;
            Ok(result)
        }
        "plugin.session.importBatch" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            if !st.allow_plugin_import(plugin_id, true) {
                return Err(rpc_err(
                    1006,
                    "plugin batch import rate exceeded",
                    "RATE_LIMITED",
                ));
            }
            let result = plugin_sessions::import_batch(&st.db, plugin_id, &params)
                .map_err(plugin_session_rpc_err)?;
            Ok(result)
        }
        "plugin.session.list" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::list(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }
        "plugin.session.get" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::get(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }
        "plugin.session.listMessages" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::list_messages(&st.db, plugin_id, &params)
                .map_err(plugin_session_rpc_err)
        }
        "plugin.session.rename" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::rename(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }
        "plugin.session.delete" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            if !st.allow_plugin_delete(plugin_id) {
                return Err(rpc_err(1006, "plugin delete rate exceeded", "RATE_LIMITED"));
            }
            plugin_sessions::delete(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }

        // Plugin usage is a read-only facts domain: a keyset page of completed
        // turns from non-deleted sessions, served to plugins that hold
        // `usage.read` (checked in Electron main before dispatch). The payload
        // carries counters and titles — never a message body — and Electron
        // main remains the only caller that can supply pluginId.
        "plugin.usage.listTurns" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let page =
                plugin_usage::list_turns_page(&st.db, &params).map_err(plugin_session_rpc_err)?;
            tracing::debug!(
                method = "plugin.usage.listTurns",
                plugin_id,
                count = page["turns"].as_array().map(Vec::len).unwrap_or(0),
                "plugin usage rpc served"
            );
            Ok(page)
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
