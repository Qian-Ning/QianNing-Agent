//! Host RPC methods for computer control.
//!
//! Each method is a thin translation: parse the parameters, hand the work to
//! [`crate::computer`], and turn a [`ComputerError`] into the code a caller can
//! branch on.
//!
//! The reads are ungated: learning where the pointer is, how big the desktop
//! is, or which windows are open changes nothing, and a caller that cannot see
//! the screen cannot decide where to click.
//!
//! The writes are gated by one setting, `computerControlEnabled`, which is off
//! until the user turns it on. The gate lives here rather than in each surface
//! above so that every caller — the agent tool set, a plugin, an external MCP
//! client, the renderer — meets the same answer, and a profile that never
//! opted in injects no input no matter who asks.

use std::sync::Arc;

use tokio::sync::Mutex;

use super::{json, rpc_err, JsonRpcError, Value};
use crate::computer::{self, ComputerError, MouseButton, Point};
use crate::state::AppState;

/// The host has no computer-control layer on this platform.
const COMPUTER_UNSUPPORTED: i64 = 1025;
/// The platform call failed; `data.code` carries the platform's own error if
/// it reported one.
const COMPUTER_FAILED: i64 = 1026;
/// The named window no longer exists, so nothing was sent. A caller can
/// re-list the windows and try again; a disabled host cannot be retried into
/// working, so the two are different codes.
const COMPUTER_WINDOW_GONE: i64 = 1027;
/// The user has not switched computer control on, so no input was injected.
/// Nothing about the request was wrong — the surface above has to ask the
/// user first.
const COMPUTER_DISABLED: i64 = 1028;

#[cfg(test)]
use crate::computer::params::MAX_TEXT_CHARS;

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "computer.getScreen" => Ok(
            serde_json::to_value(computer::screen().map_err(computer_err)?)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?,
        ),
        "computer.getCursor" => Ok(
            serde_json::to_value(computer::cursor().map_err(computer_err)?)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?,
        ),
        "computer.listWindows" => {
            Ok(json!({ "windows": computer::report_windows().map_err(computer_err)? }))
        }
        "computer.windowAt" => {
            let point = require_point(&params)?;
            let windows = computer::list_windows().map_err(computer_err)?;
            Ok(json!({ "window": computer::window_at(&windows, point) }))
        }
        "computer.moveMouse" => {
            let point = require_point(&params)?;
            require_enabled(state).await?;
            computer::move_mouse(point).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.click" => {
            let point = require_point(&params)?;
            let button = require_button(&params)?;
            let count = require_click_count(&params)?;
            require_enabled(state).await?;
            computer::click(point, button, count).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.scroll" => {
            let point = require_point(&params)?;
            let horizontal = require_notches(&params, "horizontal")?;
            let vertical = require_notches(&params, "vertical")?;
            require_enabled(state).await?;
            computer::scroll(point, horizontal, vertical).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.typeText" => {
            let text = require_text(&params)?;
            require_enabled(state).await?;
            computer::type_text(&text).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.activateWindow" => {
            let handle = require_handle(&params)?;
            require_enabled(state).await?;
            computer::activate_window(&handle).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// Whether the user has switched computer control on.
///
/// Default-off, so a profile that never touched the setting injects no input.
/// A store that cannot be read also reads as off: the failure mode of an
/// unavailable gate must be closed, never open.
pub(crate) async fn control_enabled(state: &Arc<Mutex<AppState>>) -> bool {
    let st = state.lock().await;
    control_enabled_in(&st)
}

/// The same answer, for a caller that already holds the state lock.
pub(crate) fn control_enabled_in(st: &AppState) -> bool {
    st.db
        .get_setting("app")
        .ok()
        .flatten()
        .and_then(|settings| {
            settings
                .get("computerControlEnabled")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

/// Refuse a write while the setting is off, before any platform call.
async fn require_enabled(state: &Arc<Mutex<AppState>>) -> Result<(), JsonRpcError> {
    if control_enabled(state).await {
        return Ok(());
    }
    Err(disabled_err())
}

/// The refusal a write gets while the setting is off.
pub(super) fn disabled_err() -> JsonRpcError {
    rpc_err(
        COMPUTER_DISABLED,
        "computer control is switched off; turn it on in Settings before sending input",
        "COMPUTER_DISABLED",
    )
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(-32602, message.to_string(), "INVALID_PARAMS")
}

pub(super) fn computer_err(error: ComputerError) -> JsonRpcError {
    let message = error.to_string();
    match error {
        ComputerError::Unsupported => {
            rpc_err(COMPUTER_UNSUPPORTED, message, "COMPUTER_UNSUPPORTED")
        }
        ComputerError::WindowGone(handle) => {
            let mut reply = rpc_err(COMPUTER_WINDOW_GONE, message, "COMPUTER_WINDOW_GONE");
            // The handle lets a caller match the failure to the window it
            // asked about without parsing the message text.
            reply.data = Some(json!({ "handle": handle }));
            reply
        }
        ComputerError::Platform { code, .. } => {
            let mut reply = rpc_err(COMPUTER_FAILED, message, "COMPUTER_FAILED");
            // `code` is the platform's own error value, which is what
            // distinguishes a refused input stream from a missing window.
            reply.data = Some(json!({ "code": code }));
            reply
        }
    }
}

// The rules themselves live in [`computer::params`], shared with the agent
// tool so both doors reject the same shapes. These wrappers only restate the
// message as the JSON-RPC error object this layer answers with.
fn require_point(params: &Value) -> Result<Point, JsonRpcError> {
    computer::params::point(params).map_err(|message| invalid(&message))
}

fn require_button(params: &Value) -> Result<MouseButton, JsonRpcError> {
    computer::params::button(params).map_err(|message| invalid(&message))
}

fn require_click_count(params: &Value) -> Result<u8, JsonRpcError> {
    computer::params::click_count(params).map_err(|message| invalid(&message))
}

fn require_notches(params: &Value, key: &str) -> Result<i32, JsonRpcError> {
    computer::params::notches(params, key).map_err(|message| invalid(&message))
}

fn require_text(params: &Value) -> Result<String, JsonRpcError> {
    computer::params::text(params).map_err(|message| invalid(&message))
}

fn require_handle(params: &Value) -> Result<String, JsonRpcError> {
    computer::params::handle(params).map_err(|message| invalid(&message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The numeric code of an error reply, which is what a caller branches on.
    fn code_of(result: Result<Value, JsonRpcError>) -> i64 {
        let error = result.expect_err("an error");
        error.code
    }

    /// A host whose store has no settings document yet — the state of a
    /// profile that has never opened Settings.
    fn fresh_state() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
        let data_dir = tempfile::tempdir().expect("a data dir");
        let app_state = AppState::open(data_dir.path()).expect("opens");
        (data_dir, Arc::new(Mutex::new(app_state)))
    }

    fn write_setting(state: &Arc<Mutex<AppState>>, value: Value) {
        let st = state.try_lock().expect("uncontended");
        st.db
            .set_setting("app", &value)
            .expect("writes the setting");
    }

    /// A host with computer control switched on.
    fn enabled_state() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
        let (dir, state) = fresh_state();
        write_setting(&state, json!({ "computerControlEnabled": true }));
        (dir, state)
    }

    async fn call(
        state: &Arc<Mutex<AppState>>,
        method: &str,
        params: Value,
    ) -> Result<Value, JsonRpcError> {
        handle(state, method, params).await
    }

    #[tokio::test]
    async fn a_point_needs_both_coordinates() {
        let (_dir, state) = enabled_state();
        assert_eq!(
            code_of(call(&state, "computer.moveMouse", json!({ "x": 10 })).await),
            -32602
        );
        assert_eq!(
            code_of(call(&state, "computer.moveMouse", json!({ "y": 10 })).await),
            -32602
        );
        assert_eq!(
            code_of(call(&state, "computer.moveMouse", json!({})).await),
            -32602
        );
    }

    #[tokio::test]
    async fn a_fractional_coordinate_is_rejected_rather_than_truncated() {
        let (_dir, state) = enabled_state();
        assert_eq!(
            code_of(call(&state, "computer.click", json!({ "x": 1.5, "y": 10 })).await),
            -32602
        );
        assert_eq!(
            code_of(call(&state, "computer.click", json!({ "x": "10", "y": 10 })).await),
            -32602
        );
    }

    #[tokio::test]
    async fn a_coordinate_outside_the_integer_range_is_rejected() {
        let (_dir, state) = enabled_state();
        // JavaScript can express this; the pixel grid cannot.
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.click",
                    json!({ "x": 3_000_000_000i64, "y": 0 })
                )
                .await
            ),
            -32602
        );
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.click",
                    json!({ "x": -3_000_000_000i64, "y": 0 })
                )
                .await
            ),
            -32602
        );
    }

    #[tokio::test]
    async fn a_button_must_be_one_of_the_three() {
        let (_dir, state) = enabled_state();
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.click",
                    json!({ "x": 0, "y": 0, "button": "back" })
                )
                .await
            ),
            -32602
        );
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.click",
                    json!({ "x": 0, "y": 0, "button": 1 })
                )
                .await
            ),
            -32602
        );
    }

    #[tokio::test]
    async fn a_click_count_is_bounded() {
        let (_dir, state) = enabled_state();
        for bad in [0, -1, 4, 1000] {
            assert_eq!(
                code_of(
                    call(
                        &state,
                        "computer.click",
                        json!({ "x": 0, "y": 0, "count": bad })
                    )
                    .await
                ),
                -32602,
                "count {bad} was accepted"
            );
        }
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.click",
                    json!({ "x": 0, "y": 0, "count": 1.5 })
                )
                .await
            ),
            -32602
        );
    }

    #[tokio::test]
    async fn a_scroll_beyond_the_notch_bound_is_rejected_not_clamped() {
        let (_dir, state) = enabled_state();
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.scroll",
                    json!({ "x": 0, "y": 0, "vertical": 10_000 })
                )
                .await
            ),
            -32602
        );
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.scroll",
                    json!({ "x": 0, "y": 0, "horizontal": -21 })
                )
                .await
            ),
            -32602
        );
        assert_eq!(
            code_of(
                call(
                    &state,
                    "computer.scroll",
                    json!({ "x": 0, "y": 0, "vertical": "up" })
                )
                .await
            ),
            -32602
        );
    }

    #[tokio::test]
    async fn text_must_be_a_string_and_bounded() {
        let (_dir, state) = enabled_state();
        assert_eq!(
            code_of(call(&state, "computer.typeText", json!({})).await),
            -32602
        );
        assert_eq!(
            code_of(call(&state, "computer.typeText", json!({ "text": 5 })).await),
            -32602
        );
        let too_long = "a".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            code_of(call(&state, "computer.typeText", json!({ "text": too_long })).await),
            -32602
        );
    }

    #[test]
    fn the_text_bound_counts_characters_rather_than_bytes() {
        // The validator is called directly: on Windows the method would really
        // type, and a test that moves the pointer of whoever is at the machine
        // is not a test anyone can run twice.
        let multi_byte = "é".repeat(MAX_TEXT_CHARS);
        assert!(
            multi_byte.len() > MAX_TEXT_CHARS,
            "the case only means something if the byte length exceeds the bound"
        );
        assert!(require_text(&json!({ "text": multi_byte })).is_ok());

        let over = "é".repeat(MAX_TEXT_CHARS + 1);
        assert!(require_text(&json!({ "text": over })).is_err());
    }

    #[tokio::test]
    async fn a_window_handle_must_be_a_decimal_number() {
        let (_dir, state) = enabled_state();
        for bad in ["", "0x1f", "-1", "twelve", "1.5"] {
            assert_eq!(
                code_of(call(&state, "computer.activateWindow", json!({ "handle": bad })).await),
                -32602,
                "handle {bad} was accepted"
            );
        }
        assert_eq!(
            code_of(call(&state, "computer.activateWindow", json!({ "handle": 42 })).await),
            -32602
        );
        assert_eq!(
            code_of(call(&state, "computer.activateWindow", json!({})).await),
            -32602
        );
    }

    #[tokio::test]
    async fn an_unknown_computer_method_is_not_found() {
        let (_dir, state) = enabled_state();
        assert_eq!(
            code_of(call(&state, "computer.teleport", json!({})).await),
            -32601
        );
    }

    #[tokio::test]
    async fn every_write_is_refused_until_the_user_switches_control_on() {
        // Nothing here reaches the platform: the gate answers first, which is
        // the one thing that must hold on a host that really does inject
        // input. A default profile has no settings document at all.
        let (_dir, state) = fresh_state();
        for (method, params) in [
            ("computer.moveMouse", json!({ "x": 1, "y": 1 })),
            ("computer.click", json!({ "x": 1, "y": 1 })),
            ("computer.scroll", json!({ "x": 1, "y": 1, "vertical": 1 })),
            ("computer.typeText", json!({ "text": "x" })),
            ("computer.activateWindow", json!({ "handle": "42" })),
        ] {
            assert_eq!(
                code_of(call(&state, method, params).await),
                COMPUTER_DISABLED,
                "{method} was not refused by the gate"
            );
        }
    }

    #[tokio::test]
    async fn switching_control_off_refuses_the_writes_again() {
        let (_dir, state) = fresh_state();
        write_setting(&state, json!({ "computerControlEnabled": true }));
        assert!(control_enabled(&state).await);

        write_setting(&state, json!({ "computerControlEnabled": false }));
        assert!(!control_enabled(&state).await);
        assert_eq!(
            code_of(call(&state, "computer.typeText", json!({ "text": "x" })).await),
            COMPUTER_DISABLED
        );
    }

    #[tokio::test]
    async fn an_unreadable_setting_reads_as_off() {
        // Closed-by-default is the whole point of the gate; a store that
        // cannot answer must not open it.
        let (_dir, state) = fresh_state();
        assert!(!control_enabled(&state).await);
    }

    #[tokio::test]
    async fn the_reads_are_ungated_and_report_what_the_host_can_do() {
        // Reads change nothing, so they must answer even before the user has
        // switched anything on: a caller has to see the screen before it can
        // ask to click it. On Windows the desktop has a measurable size; on
        // any other host the caller is told plainly that this host cannot
        // drive a pointer.
        let (_dir, state) = fresh_state();
        if cfg!(windows) {
            let screen = call(&state, "computer.getScreen", json!({}))
                .await
                .expect("a screen");
            assert!(
                screen["bounds"]["right"].as_i64().unwrap_or(0)
                    > screen["bounds"]["left"].as_i64().unwrap_or(0)
            );
            let cursor = call(&state, "computer.getCursor", json!({}))
                .await
                .expect("a cursor");
            assert!(cursor["x"].is_i64());
            let windows = call(&state, "computer.listWindows", json!({}))
                .await
                .expect("windows");
            assert!(windows["windows"].is_array());
        } else {
            for method in [
                "computer.getScreen",
                "computer.getCursor",
                "computer.listWindows",
            ] {
                assert_eq!(
                    code_of(call(&state, method, json!({})).await),
                    COMPUTER_UNSUPPORTED
                );
            }
        }
    }

    #[tokio::test]
    async fn an_enabled_write_reaches_the_platform_layer() {
        if cfg!(windows) {
            // This would move the pointer of whoever is at the machine, so on
            // Windows the case stops before the platform call.
            return;
        }
        let (_dir, state) = enabled_state();
        for (method, params) in [
            ("computer.moveMouse", json!({ "x": 1, "y": 1 })),
            ("computer.click", json!({ "x": 1, "y": 1 })),
            ("computer.scroll", json!({ "x": 1, "y": 1, "vertical": 1 })),
            ("computer.typeText", json!({ "text": "x" })),
            ("computer.activateWindow", json!({ "handle": "42" })),
        ] {
            assert_eq!(
                code_of(call(&state, method, params).await),
                COMPUTER_UNSUPPORTED,
                "{method} did not reach the platform layer"
            );
        }
    }
}
