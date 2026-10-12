use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::parse_scope;
use super::plugin_err;
use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `plugins*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "plugins.setLocale" => {
            // The desktop shell owns the app language — `settings.language`, or
            // the OS locale while that is `auto` — so it pushes the resolved
            // locale here whenever it changes. Rows then read their display
            // strings from the matching `i18n` entry, and a locale change needs
            // no registry rewrite.
            let locale = params.get("locale").and_then(Value::as_str).unwrap_or("");
            let mut st = state.lock().await;
            st.plugins.set_locale(locale);
            Ok(json!({ "ok": true, "locale": st.plugins.locale() }))
        }

        "plugins.list" => {
            let st = state.lock().await;
            Ok(json!({ "plugins": st.plugins.list() }))
        }
        "plugins.resolveExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let sender = {
                let mut st = state.lock().await;
                st.plugin_execs.remove(execution_id)
            };
            match sender {
                Some(sender) => {
                    let _ = sender.send(params.clone());
                    Ok(json!({ "ok": true }))
                }
                None => Err(rpc_err(1003, "unknown executionId", "NOT_FOUND")),
            }
        }
        "plugins.loadDev" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st.plugins.load_dev(path).map_err(|e| {
                let msg = e.to_string();
                if msg.contains("PLUGIN_INVALID") {
                    rpc_err(1009, msg, "PLUGIN_INVALID")
                } else {
                    rpc_err(1010, msg, "PLUGIN_LOAD_FAILED")
                }
            })?;
            // A development plugin owns its declared provider rows the same way
            // an installed one does.
            if let Err(error) =
                crate::plugins::reconcile_plugin(&st.db, &st.secrets, &st.plugins, &plugin.id, true)
            {
                tracing::warn!(plugin = %plugin.id, %error, "plugin provider sync failed");
            }
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.enable" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_enabled(id, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if let Some(current) = plugin.as_ref() {
                if let Err(error) = crate::plugins::reconcile_plugin(
                    &st.db,
                    &st.secrets,
                    &st.plugins,
                    &current.id,
                    true,
                ) {
                    tracing::warn!(plugin = %current.id, %error, "plugin provider sync failed");
                }
            }
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.disable" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_enabled(id, false)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // The declaration still exists, so the rows stay and are turned
            // off: a re-enable restores the credential the user already gave.
            if plugin.is_some() {
                if let Err(error) = crate::plugins::set_plugin_providers_enabled(&st.db, id, false)
                {
                    tracing::warn!(plugin = id, %error, "plugin provider disable failed");
                }
            }
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.uninstall" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let ok = st
                .plugins
                .uninstall(id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if ok {
                if let Err(error) = crate::plugins::remove_plugin_providers(&st.db, &st.secrets, id)
                {
                    tracing::warn!(plugin = id, %error, "plugin provider removal failed");
                }
            }
            Ok(json!({ "ok": ok }))
        }
        "plugins.getPermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let plugin = st.plugins.list().into_iter().find(|p| p.id == id);
            Ok(json!({
                "permissions": plugin.map(|p| p.permissions).unwrap_or_default()
            }))
        }
        "plugins.installFromPath" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_path(
                    path,
                    crate::plugins::InstallOptions {
                        source: "installed".into(),
                        enable,
                        marketplace: None,
                        expected_shasum: None,
                        auto_update: false,
                        granted_permissions: granted,
                    },
                )
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "plugins.installFromPackage" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let expected_shasum = params
                .get("expectedShasum")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_package(
                    path,
                    crate::plugins::InstallOptions {
                        source: "installed".into(),
                        enable,
                        marketplace: None,
                        expected_shasum,
                        auto_update: false,
                        granted_permissions: granted,
                    },
                )
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "plugins.grantPermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let permissions = params
                .get("permissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .grant_permissions(id, permissions)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.revokePermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let permissions = params
                .get("permissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .revoke_permissions(id, permissions)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.setAutoUpdate" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let enabled = params
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_auto_update(id, enabled)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.setScope" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_scope(id, scope)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
