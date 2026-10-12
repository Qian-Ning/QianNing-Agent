use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{
    effective_command_shell_id, gate_default_command_shell_setting, merge_settings_value,
    normalize_settings_value, prune_unresolvable_generation_bindings, validate_settings_value,
    DEFAULT_LARGE_PASTE_THRESHOLD, IMAGE_GENERATION_SETTING_KEYS, VIDEO_GENERATION_SETTING_KEYS,
};
use super::{rpc_err, AppState, JsonRpcError};
use crate::tools;

/// Handles the `settings*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "settings.get" => {
            let st = state.lock().await;
            let stored = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // A brand-new install follows the OS theme. Dark is still the
            // palette the shell is designed around, but a fresh install on a
            // light desktop must not open dark: "system" resolves against the
            // OS at paint time (useAppShellRuntime), so the first launch
            // matches the machine it was installed on.
            let mut settings = normalize_settings_value(stored.unwrap_or_else(|| {
                json!({
                    "defaultMode": "agent",
                    "defaultCommandShell": tools::shell::default_shell_id(),
                    "theme": "system",
                    "enterToSend": true,
                    "largePasteThreshold": DEFAULT_LARGE_PASTE_THRESHOLD,
                    "contextCompaction": {
                        "enabled": true,
                        "reserveTokens": 16384,
                        "keepRecentTokens": 20000
                    },
                    "onboardingDismissed": false
                })
            }));
            // Repair on read: a binding whose provider row is already gone —
            // deleted by a build that did not prune, an uninstalled plugin, or
            // synced bundle — is dropped here and the store is corrected, so
            // the shell never presents a default the runtime must reject.
            let pruned_images = prune_unresolvable_generation_bindings(
                &st.db,
                &mut settings,
                IMAGE_GENERATION_SETTING_KEYS,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let pruned_videos = prune_unresolvable_generation_bindings(
                &st.db,
                &mut settings,
                VIDEO_GENERATION_SETTING_KEYS,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if pruned_images || pruned_videos {
                st.db
                    .set_setting("app", &settings)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            Ok(settings)
        }
        "settings.set" => {
            validate_settings_value(&params)?;
            let mut st = state.lock().await;
            let stored = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let incoming_shell = params.get("defaultCommandShell").and_then(Value::as_str);
            let current_effective_shell = effective_command_shell_id(stored.as_ref());
            if incoming_shell.is_some_and(|shell| current_effective_shell.as_deref() != Some(shell))
            {
                gate_default_command_shell_setting(&st)?;
            }
            let mut settings = normalize_settings_value(merge_settings_value(stored, params));
            for keys in [IMAGE_GENERATION_SETTING_KEYS, VIDEO_GENERATION_SETTING_KEYS] {
                prune_unresolvable_generation_bindings(&st.db, &mut settings, keys)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            st.db
                .set_setting("app", &settings)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // Re-pin the marketplace channel in memory. Fetching here would hold
            // the state lock behind a remote timeout, so the renderer triggers
            // `market.refresh` after switching channels.
            let (channel, custom_url) =
                crate::plugins::market_channel_from_settings(Some(&settings));
            st.plugins.set_market_channel(channel, custom_url);
            // A concrete app language pins the plugin display locale here, so a
            // shell that only writes settings still gets localized plugin rows.
            // `auto` is resolved by the shell and pushed through
            // `plugins.setLocale`.
            if let Some(language) = settings.get("language").and_then(Value::as_str) {
                if language != "auto" {
                    st.plugins.set_locale(language);
                }
            }
            crate::network_proxy::apply_from_settings(Some(&settings));
            crate::network_policy::apply_from_settings(Some(&settings));
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
