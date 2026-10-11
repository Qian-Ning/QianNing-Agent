use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{provider_rpc_err, rpc_err, AppState, JsonRpcError};
use crate::providers::{self, DiscoveredModelInput, ProviderCreateInput, ProviderUpdateInput};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheModelsParams {
    provider_id: String,
    models: Vec<DiscoveredModelInput>,
}

/// The `providers.*` method family, moved out of `rpc::handle_request`.
///
/// Every arm locks the state itself, so the caller passes the `Arc` rather than
/// a guard, exactly like `computer_rpc::handle`. The arm bodies are unchanged.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "providers.list" => {
            let include_disabled = params
                .get("includeDisabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let st = state.lock().await;
            let list = providers::list_providers(&st.db, &st.secrets, include_disabled)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "providers": list }))
        }
        "providers.reorder" => {
            let input: providers::ProviderReorderInput = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let moved = providers::reorder_providers(&st.db, &st.secrets, input)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if !moved {
                return Err(rpc_err(
                    1002,
                    "provider or reorder target not found",
                    "INVALID_PARAMS",
                ));
            }
            Ok(json!({ "ok": true }))
        }
        "providers.create" => {
            let input: ProviderCreateInput = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider =
                providers::create_provider(&st.db, &st.secrets, input).map_err(provider_rpc_err)?;
            Ok(json!({ "provider": provider }))
        }
        "providers.update" => {
            let input: ProviderUpdateInput = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider =
                providers::update_provider(&st.db, &st.secrets, input).map_err(provider_rpc_err)?;
            Ok(json!({ "provider": provider }))
        }
        "providers.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = providers::delete_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "providers.get" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = providers::get_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "provider": provider }))
        }
        "providers.getSecret" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let value = providers::get_secret_for_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "value": value }))
        }
        // The credential of a plugin-declared provider. `providers.update`
        // refuses that row, so this is the one path that writes the key the
        // declaration asks for without touching the declaration's own fields.
        "providers.setSecret" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let secret_value = params.get("secretValue").and_then(|v| v.as_str());
            let st = state.lock().await;
            let provider = providers::set_provider_secret(&st.db, &st.secrets, id, secret_value)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "provider": provider }))
        }
        "providers.listModels" => {
            let provider_id = params.get("providerId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let models = providers::list_models(&st.db, provider_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "models": models }))
        }
        "providers.cacheModels" => {
            let input: CacheModelsParams = serde_json::from_value(params)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let cached =
                providers::cache_discovered_models(&st.db, &input.provider_id, &input.models)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let models = providers::list_models(&st.db, Some(&input.provider_id))
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "cached": cached, "models": models }))
        }
        "providers.testConnection" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = providers::get_provider(&st.db, &st.secrets, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "provider not found", "NOT_FOUND"))?;
            Ok(json!({
                "ok": provider.has_secret || provider.auth_kind == "none",
                "provider": provider
            }))
        }

        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
