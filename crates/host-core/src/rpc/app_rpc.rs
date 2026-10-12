use super::{rpc_err, AppState, JsonRpcError};
use crate::state::HOST_VERSION;
use crate::state::PROTOCOL_VERSION;
use crate::{providers, sessions};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `app*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "app.handshake" => {
            let client_version = params
                .get("protocolVersion")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            if client_version != PROTOCOL_VERSION {
                return Err(rpc_err(
                    1011,
                    format!("protocol mismatch: client={client_version} host={PROTOCOL_VERSION}"),
                    "PROTOCOL_MISMATCH",
                ));
            }
            let mut st = state.lock().await;
            st.handshook = true;
            // Restore the current workspace from kv → projects.
            if let Ok(Some(pid)) = st.db.kv_get("app", "currentProjectId") {
                let pid = pid
                    .as_i64()
                    .or_else(|| pid.as_str().and_then(|s| s.parse::<i64>().ok()));
                if let Some(pid) = pid {
                    if let Ok(Some(path)) = st.db.project_path(pid) {
                        if !path.is_empty() {
                            st.workspace.set(PathBuf::from(path));
                        }
                    }
                }
            }
            Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "version": HOST_VERSION,
                "capabilities": [
                    "tools", "sessions", "providers", "secrets", "plugins", "permissions",
                    "scheduled", "artifacts", "plans", "search", "turns", "notifications"
                ]
            }))
        }
        "app.health" => {
            let st = state.lock().await;
            let budget = st.tool_budget.snapshot();
            Ok(json!({
                "ok": true,
                "protocolVersion": PROTOCOL_VERSION,
                "version": HOST_VERSION,
                "uptimeMs": st.uptime_ms(),
                "toolBudget": {
                    "active": budget.active,
                    "queued": budget.queued,
                    "total": budget.total,
                    "shell": budget.shell,
                    "reads": budget.reads,
                    "mutations": budget.mutations,
                    "plugins": budget.plugins
                }
            }))
        }
        "app.getVersion" => Ok(json!({
            "name": "pi-desktop-host-core",
            "version": HOST_VERSION,
            "protocolVersion": PROTOCOL_VERSION
        })),

        "app.getOnboarding" => {
            let st = state.lock().await;
            let settings = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or_else(|| json!({}));
            let dismissed = settings
                .get("onboardingDismissed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let providers = providers::list_providers(&st.db, &st.secrets, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let has_provider = !providers.is_empty();
            let has_secret = providers.iter().any(|p| p.has_secret);
            let has_project = st.workspace.get().is_some();
            let session_count = sessions::session_count(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let has_session = session_count > 0;
            let steps = vec![
                json!({"id":"provider","title":"Add a model provider","done": has_provider, "action":"settings.providers"}),
                json!({"id":"secret","title":"Save your API key","done": has_secret, "action":"settings.providers"}),
                json!({"id":"project","title":"Open a project folder","done": has_project, "action":"project.open"}),
                json!({"id":"prompt","title":"Send your first prompt","done": has_session, "action":"chat.focus"}),
                json!({"id":"plugin","title":"Load a development plugin (optional)","done": !st.plugins.list().is_empty(), "action":"plugins.open"}),
            ];
            let critical_incomplete = !has_provider || !has_secret || !has_session;
            Ok(json!({
                "showChecklist": critical_incomplete && !dismissed,
                "steps": steps
            }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
