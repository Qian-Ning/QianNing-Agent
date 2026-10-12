use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::sessions;

/// Handles the `stats*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "stats.getTokenUsageHistory" => {
            let bucket = params
                .get("bucket")
                .and_then(|v| v.as_str())
                .unwrap_or("day");

            let st = state.lock().await;
            let history = sessions::get_token_usage_history(
                &st.db,
                params.get("startDate").and_then(|v| v.as_i64()),
                params.get("endDate").and_then(|v| v.as_i64()),
                bucket,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(history)
        }

        "stats.getUsageBreakdown" => {
            let st = state.lock().await;
            let breakdown = sessions::get_usage_breakdown(
                &st.db,
                params.get("startDate").and_then(|v| v.as_i64()),
                params.get("endDate").and_then(|v| v.as_i64()),
                params.get("providerId").and_then(|v| v.as_str()),
                params.get("modelId").and_then(|v| v.as_str()),
                params
                    .get("recentLimit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(100),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(breakdown)
        }

        "stats.getModelPricing" => {
            let st = state.lock().await;
            let pricing = crate::pricing::list_pricing(st.db.conn())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(pricing)
        }

        "stats.updateModelPricing" => {
            let st = state.lock().await;
            let pricing = crate::pricing::upsert_pricing(st.db.conn(), &params)
                .map_err(|e| rpc_err(1001, e.to_string(), "INVALID_ARGUMENT"))?;
            Ok(pricing)
        }

        "stats.deleteModelPricing" => {
            let model_id = params
                .get("modelId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1001, "modelId is required", "INVALID_ARGUMENT"))?;
            let st = state.lock().await;
            let pricing = crate::pricing::delete_pricing(st.db.conn(), model_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(pricing)
        }

        "stats.resetModelPricing" => {
            let st = state.lock().await;
            let pricing = crate::pricing::reset_defaults(st.db.conn())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(pricing)
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
