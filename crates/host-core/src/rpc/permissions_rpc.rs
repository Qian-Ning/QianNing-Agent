use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::requires_external_path_permission;
use super::resolve_tool_workspace_for_call;
use super::{rpc_err, AppState, JsonRpcError};
use crate::permissions::{PermissionDecision, PermissionEvaluationParams, PermissionManager};
use crate::scratch;
use crate::sessions;

/// Handles the `permissions*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "permissions.evaluate" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tool_name = params
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let declared_risk = params.get("declaredRisk").and_then(|v| v.as_str());
            let plan_safe_actions: Option<Vec<String>> = params
                .get("planSafeActions")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .filter(|items: &Vec<String>| !items.is_empty());
            let st = state.lock().await;
            let Some(mode) = sessions::session_mode(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            else {
                return Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND"));
            };
            let session_pm = sessions::session_permission_mode(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .filter(|value| value != "inherit");
            let effective_pm = session_pm
                .or_else(|| {
                    st.db
                        .get_setting("app")
                        .ok()
                        .flatten()
                        .and_then(|settings| {
                            settings
                                .get("defaultPermissionMode")
                                .and_then(|value| value.as_str())
                                .filter(|value| {
                                    sessions::is_valid_permission_mode(value) && *value != "inherit"
                                })
                                .map(str::to_string)
                        })
                })
                .unwrap_or_else(|| "ask".into());
            let args = params.get("args").cloned().unwrap_or_else(|| json!({}));
            let workspace_path = resolve_tool_workspace_for_call(&st, session_id, &args)?;
            let scratch_path = scratch::session_dir(&st.data_dir, session_id);
            let external_path_permission = requires_external_path_permission(
                workspace_path.as_deref(),
                scratch_path.as_deref(),
                tool_name,
                &args,
            );
            let decision = st
                .permissions
                .evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                    session_id,
                    tool_name,
                    mode: &mode,
                    permission_mode: &effective_pm,
                    session_grants: &st.session_grants,
                    declared_risk,
                    requires_external_path_permission: external_path_permission,
                    plan_safe_actions: plan_safe_actions.as_deref(),
                });
            Ok(json!({
                "decision": decision,
                "risk": PermissionManager::tool_risk_with_declared(tool_name, declared_risk),
                "externalPathPermission": external_path_permission
            }))
        }
        "permissions.resolve" => {
            let request_id = params
                .get("requestId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
            let decision_raw = params
                .get("decision")
                .and_then(|v| v.as_str())
                .unwrap_or("deny");
            let decision = match decision_raw {
                "allow-once" => PermissionDecision::AllowOnce,
                "allow-session" => PermissionDecision::AllowSession,
                _ => PermissionDecision::Deny,
            };
            let mut st = state.lock().await;
            st.resolve_permission(request_id, decision)
                .map_err(|code| {
                    let c = if code == "NOT_FOUND" { 1007 } else { 1000 };
                    rpc_err(c, code.clone(), &code)
                })?;
            Ok(json!({ "ok": true }))
        }
        "permissions.listSessionGrants" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let st = state.lock().await;
            Ok(json!({
                "grants": st.session_grants.get(session_id).cloned().unwrap_or_default()
            }))
        }
        "permissions.clearSessionGrants" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut st = state.lock().await;
            st.session_grants.remove(session_id);
            Ok(json!({ "ok": true }))
        }
        "permissions.pending" => {
            // Pending requests are Host state (D374/D375): a client that
            // attaches after `permissions.request` was emitted reads the open
            // set here and answers through the unchanged `permissions.resolve`.
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            Ok(json!({ "requests": st.permissions.pending_requests(session_id) }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
