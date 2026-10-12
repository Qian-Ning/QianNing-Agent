use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::{plugin_err, rpc_err, send_notification, AppState, JsonRpcError};

/// Reports install progress to the renderer, and reads the cancel flag.
///
/// Throttled on purpose: an install reports every chunk of bytes it sees, and
/// an interface needs a few of those per second rather than thousands. A phase
/// change and the terminal report always go through, so a dialog never misses
/// the transition it is displaying.
struct RpcInstallObserver {
    tx: mpsc::UnboundedSender<String>,
    cancel: crate::plugins::CancelToken,
    last: Option<std::time::Instant>,
    last_phase: Option<crate::plugins::InstallPhase>,
}

impl crate::plugins::InstallObserver for RpcInstallObserver {
    fn progress(&mut self, event: crate::plugins::InstallProgress) {
        const MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
        let phase_changed = self.last_phase != Some(event.phase);
        let terminal = event.error.is_some();
        let due = self
            .last
            .map(|at| at.elapsed() >= MIN_INTERVAL)
            .unwrap_or(true);
        if !phase_changed && !terminal && !due {
            return;
        }
        self.last = Some(std::time::Instant::now());
        self.last_phase = Some(event.phase);
        let tried: Vec<Value> = event
            .tried
            .iter()
            .map(|mirror| {
                json!({
                    "source": mirror.source,
                    "url": mirror.url,
                    "error": mirror.error,
                })
            })
            .collect();
        send_notification(
            &self.tx,
            "plugin.installProgress",
            json!({
                "pluginId": event.plugin_id,
                "version": event.version,
                "phase": event.phase.as_str(),
                "source": event.source,
                "attempt": event.attempt,
                "attempts": event.attempts,
                "receivedBytes": event.received_bytes,
                "totalBytes": event.total_bytes,
                "tried": tried,
                "error": event.error,
            }),
        );
    }

    fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

/// Handles the `market.*` family. `tx` carries install progress notifications
/// to the renderer.
///
/// Most arms take the state lock themselves; `market.cancelInstall` must not,
/// because the install it cancels holds that lock while bytes arrive. That is
/// why this takes the `&Arc<Mutex<AppState>>` form rather than an already-locked
/// guard.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    match method {
        "market.refresh" => {
            let force = params
                .get("force")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let st = state.lock().await;
            let meta = st.plugins.refresh_market(force).map_err(plugin_err)?;
            Ok(meta)
        }
        "market.search" => {
            let query = params.get("query").and_then(|v| v.as_str());
            let category = params.get("category").and_then(|v| v.as_str());
            let st = state.lock().await;
            let plugins = st
                .plugins
                .market_search(query, category)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "plugins": plugins,
                "providerId": "official",
                "sourceUrl": st.plugins.market_source_url(),
            }))
        }
        "market.getDetail" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let plugin = st.plugins.market_get(id).map_err(plugin_err)?;
            Ok(json!({ "plugin": plugin }))
        }
        "market.install" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let version = params.get("version").and_then(|v| v.as_str());
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let auto_update = params
                .get("autoUpdate")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            // An install outlives one request from the interface's point of
            // view: it resolves where the package is, downloads it from one
            // mirror after another, verifies it and registers it. Every one of
            // those steps is worth showing, which is what the observer does,
            // and the token is what the cancel channel flips.
            let cancel = crate::plugins::CancelToken::default();
            // Armed outside AppState: cancelInstall must flip this flag while
            // install still holds the state lock for the download.
            crate::plugins::progress::arm_active_cancel(&cancel);
            let mut observer = RpcInstallObserver {
                tx: tx.clone(),
                cancel: cancel.clone(),
                last: None,
                last_phase: None,
            };
            let mut st = state.lock().await;
            st.plugins.set_install_cancel(Some(cancel));
            let outcome = st.plugins.install_from_market_observed(
                id,
                version,
                enable,
                auto_update,
                granted,
                &mut observer,
            );
            // Whatever happened, nothing is cancellable any more: a token left
            // in place would answer the next cancel for an install that is
            // already over.
            st.plugins.set_install_cancel(None);
            let result = outcome.map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "market.cancelInstall" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            // Do not take AppState: the install holds that lock while bytes
            // arrive, and waiting on it would make cancel a no-op.
            let cancelled = crate::plugins::progress::cancel_active_install();
            Ok(json!({ "cancelled": cancelled, "id": id }))
        }
        "market.checkUpdates" => {
            let refresh_remote = params
                .get("refreshRemote")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let mut st = state.lock().await;
            let updates = st
                .plugins
                .check_updates(refresh_remote)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "updates": updates, "plugins": st.plugins.list() }))
        }
        "market.applyUpdates" => {
            let only_auto = params
                .get("onlyAuto")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let mut st = state.lock().await;
            let results = st.plugins.apply_updates(only_auto).map_err(plugin_err)?;
            Ok(json!({ "results": results, "plugins": st.plugins.list() }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
