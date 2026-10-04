//! Host RPC methods for computer control.
//!
//! Each method is a thin translation: parse the parameters, hand the work to
//! [`crate::computer`], and turn a [`ComputerError`] into the code a caller can branch
//! on. The layer is stateless, so it takes no `AppState`.
//!
//! The write methods here inject real input. Nothing in this file gates them:
//! who may call them, and when, is a decision for the surfaces above — the
//! agent tool set and the desktop settings that feed it.

use super::{json, rpc_err, JsonRpcError, Value};
use crate::computer::{self, ComputerError, MouseButton, Point};

/// The host has no computer-control layer on this platform.
const COMPUTER_UNSUPPORTED: i64 = 1025;
/// The platform call failed; `data.code` carries the platform's own error if
/// it reported one.
const COMPUTER_FAILED: i64 = 1026;
/// The named window no longer exists, so nothing was sent. A caller can
/// re-list the windows and try again; the other two codes are terminal.
const COMPUTER_WINDOW_GONE: i64 = 1027;

/// The largest text a single `computer.typeText` may type, in characters.
///
/// A round of automation types a field, not a document, and a bound keeps one
/// call from building a keystroke array of unbounded size.
const MAX_TEXT_CHARS: usize = 4096;

/// The most clicks one `computer.click` may send. Three covers a double-click and
/// the triple-click that selects a line.
const MAX_CLICK_COUNT: i64 = 3;

/// The most wheel notches one `computer.scroll` may send per axis.
const MAX_SCROLL_NOTCHES: i64 = 20;

pub(super) fn handle(method: &str, params: Value) -> Result<Value, JsonRpcError> {
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
            computer::move_mouse(point).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.click" => {
            let point = require_point(&params)?;
            let button = require_button(&params)?;
            let count = require_click_count(&params)?;
            computer::click(point, button, count).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.scroll" => {
            let point = require_point(&params)?;
            let horizontal = require_notches(&params, "horizontal")?;
            let vertical = require_notches(&params, "vertical")?;
            computer::scroll(point, horizontal, vertical).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.typeText" => {
            let text = require_text(&params)?;
            computer::type_text(&text).map_err(computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "computer.activateWindow" => {
            let handle = require_handle(&params)?;
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

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(-32602, message.to_string(), "INVALID_PARAMS")
}

fn computer_err(error: ComputerError) -> JsonRpcError {
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

/// Every coordinate is a whole number of pixels. A float is rejected rather
/// than truncated: a caller that computed `1920.5` has a bug, and silently
/// dropping the fraction would hide it behind a click that nearly landed.
fn require_coordinate(params: &Value, key: &str) -> Result<i32, JsonRpcError> {
    let raw = params
        .get(key)
        .ok_or_else(|| invalid(&format!("{key} is required")))?;
    let value = raw
        .as_i64()
        .ok_or_else(|| invalid(&format!("{key} must be an integer")))?;
    i32::try_from(value).map_err(|_| invalid(&format!("{key} is out of range")))
}

fn require_point(params: &Value) -> Result<Point, JsonRpcError> {
    Ok(Point::new(
        require_coordinate(params, "x")?,
        require_coordinate(params, "y")?,
    ))
}

fn require_button(params: &Value) -> Result<MouseButton, JsonRpcError> {
    match params.get("button") {
        None | Some(Value::Null) => Ok(MouseButton::Left),
        Some(Value::String(name)) => match name.as_str() {
            "left" => Ok(MouseButton::Left),
            "right" => Ok(MouseButton::Right),
            "middle" => Ok(MouseButton::Middle),
            other => Err(invalid(&format!(
                "button must be left, right or middle, not {other}"
            ))),
        },
        Some(_) => Err(invalid("button must be a string")),
    }
}

fn require_click_count(params: &Value) -> Result<u8, JsonRpcError> {
    match params.get("count") {
        None | Some(Value::Null) => Ok(1),
        Some(raw) => {
            let count = raw
                .as_i64()
                .ok_or_else(|| invalid("count must be an integer"))?;
            if !(1..=MAX_CLICK_COUNT).contains(&count) {
                return Err(invalid(&format!(
                    "count must be between 1 and {MAX_CLICK_COUNT}"
                )));
            }
            Ok(count as u8)
        }
    }
}

/// Wheel notches on one axis; positive is right or up, as the caller sees it.
///
/// Out of range is an error rather than a clamp: a scroll of a thousand
/// notches is a caller that lost track of its own state, and clamping would
/// look like it worked.
fn require_notches(params: &Value, key: &str) -> Result<i32, JsonRpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(raw) => {
            let notches = raw
                .as_i64()
                .ok_or_else(|| invalid(&format!("{key} must be an integer")))?;
            if notches.abs() > MAX_SCROLL_NOTCHES {
                return Err(invalid(&format!(
                    "{key} must be between -{MAX_SCROLL_NOTCHES} and {MAX_SCROLL_NOTCHES}"
                )));
            }
            Ok(notches as i32)
        }
    }
}

fn require_text(params: &Value) -> Result<String, JsonRpcError> {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("text must be a string"))?;
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(invalid(&format!(
            "text must be at most {MAX_TEXT_CHARS} characters"
        )));
    }
    Ok(text.to_string())
}

fn require_handle(params: &Value) -> Result<String, JsonRpcError> {
    let handle = params
        .get("handle")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("handle must be a string"))?;
    // Parse before touching the platform so a malformed handle is reported the
    // same way on every host, rather than only where the platform layer runs.
    computer::parse_handle(handle).map_err(|_| invalid("handle must be a decimal number"))?;
    Ok(handle.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The numeric code of an error reply, which is what a caller branches on.
    fn code_of(result: Result<Value, JsonRpcError>) -> i64 {
        let error = result.expect_err("an error");
        error.code
    }

    #[test]
    fn a_point_needs_both_coordinates() {
        assert_eq!(
            code_of(handle("computer.moveMouse", json!({ "x": 10 }))),
            -32602
        );
        assert_eq!(
            code_of(handle("computer.moveMouse", json!({ "y": 10 }))),
            -32602
        );
        assert_eq!(code_of(handle("computer.moveMouse", json!({}))), -32602);
    }

    #[test]
    fn a_fractional_coordinate_is_rejected_rather_than_truncated() {
        assert_eq!(
            code_of(handle("computer.click", json!({ "x": 1.5, "y": 10 }))),
            -32602
        );
        assert_eq!(
            code_of(handle("computer.click", json!({ "x": "10", "y": 10 }))),
            -32602
        );
    }

    #[test]
    fn a_coordinate_outside_the_integer_range_is_rejected() {
        // JavaScript can express this; the pixel grid cannot.
        assert_eq!(
            code_of(handle(
                "computer.click",
                json!({ "x": 3_000_000_000i64, "y": 0 })
            )),
            -32602
        );
        assert_eq!(
            code_of(handle(
                "computer.click",
                json!({ "x": -3_000_000_000i64, "y": 0 })
            )),
            -32602
        );
    }

    #[test]
    fn a_button_must_be_one_of_the_three() {
        assert_eq!(
            code_of(handle(
                "computer.click",
                json!({ "x": 0, "y": 0, "button": "back" })
            )),
            -32602
        );
        assert_eq!(
            code_of(handle(
                "computer.click",
                json!({ "x": 0, "y": 0, "button": 1 })
            )),
            -32602
        );
    }

    #[test]
    fn a_click_count_is_bounded() {
        for bad in [0, -1, 4, 1000] {
            assert_eq!(
                code_of(handle(
                    "computer.click",
                    json!({ "x": 0, "y": 0, "count": bad })
                )),
                -32602,
                "count {bad} was accepted"
            );
        }
        assert_eq!(
            code_of(handle(
                "computer.click",
                json!({ "x": 0, "y": 0, "count": 1.5 })
            )),
            -32602
        );
    }

    #[test]
    fn a_scroll_beyond_the_notch_bound_is_rejected_not_clamped() {
        assert_eq!(
            code_of(handle(
                "computer.scroll",
                json!({ "x": 0, "y": 0, "vertical": 10_000 })
            )),
            -32602
        );
        assert_eq!(
            code_of(handle(
                "computer.scroll",
                json!({ "x": 0, "y": 0, "horizontal": -21 })
            )),
            -32602
        );
        assert_eq!(
            code_of(handle(
                "computer.scroll",
                json!({ "x": 0, "y": 0, "vertical": "up" })
            )),
            -32602
        );
    }

    #[test]
    fn text_must_be_a_string_and_bounded() {
        assert_eq!(code_of(handle("computer.typeText", json!({}))), -32602);
        assert_eq!(
            code_of(handle("computer.typeText", json!({ "text": 5 }))),
            -32602
        );
        let too_long = "a".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            code_of(handle("computer.typeText", json!({ "text": too_long }))),
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

    #[test]
    fn a_window_handle_must_be_a_decimal_number() {
        for bad in ["", "0x1f", "-1", "twelve", "1.5"] {
            assert_eq!(
                code_of(handle("computer.activateWindow", json!({ "handle": bad }))),
                -32602,
                "handle {bad} was accepted"
            );
        }
        assert_eq!(
            code_of(handle("computer.activateWindow", json!({ "handle": 42 }))),
            -32602
        );
        assert_eq!(
            code_of(handle("computer.activateWindow", json!({}))),
            -32602
        );
    }

    #[test]
    fn an_unknown_computer_method_is_not_found() {
        assert_eq!(code_of(handle("computer.teleport", json!({}))), -32601);
    }

    #[test]
    fn reading_the_computer_reports_what_the_host_can_do() {
        // Both reads are harmless wherever they run, so this asserts on the
        // real answer rather than on a mock: on Windows the desktop has a
        // measurable size, and anywhere else the caller is told plainly that
        // this host cannot drive a pointer.
        if cfg!(windows) {
            let screen = handle("computer.getScreen", json!({})).expect("a screen");
            assert!(
                screen["bounds"]["right"].as_i64().unwrap_or(0)
                    > screen["bounds"]["left"].as_i64().unwrap_or(0)
            );
            let cursor = handle("computer.getCursor", json!({})).expect("a cursor");
            assert!(cursor["x"].is_i64());
            let windows = handle("computer.listWindows", json!({})).expect("windows");
            assert!(windows["windows"].is_array());
        } else {
            for method in [
                "computer.getScreen",
                "computer.getCursor",
                "computer.listWindows",
            ] {
                assert_eq!(code_of(handle(method, json!({}))), COMPUTER_UNSUPPORTED);
            }
        }
    }

    #[test]
    fn a_write_on_a_host_without_computer_control_is_refused_not_ignored() {
        if cfg!(windows) {
            // Sending real input from a test would move the pointer of whoever
            // is at the machine, so on Windows this case is not exercised here.
            return;
        }
        for (method, params) in [
            ("computer.moveMouse", json!({ "x": 1, "y": 1 })),
            ("computer.click", json!({ "x": 1, "y": 1 })),
            ("computer.scroll", json!({ "x": 1, "y": 1, "vertical": 1 })),
            ("computer.typeText", json!({ "text": "x" })),
            ("computer.activateWindow", json!({ "handle": "42" })),
        ] {
            assert_eq!(
                code_of(handle(method, params)),
                COMPUTER_UNSUPPORTED,
                "{method} did not report the platform"
            );
        }
    }
}
