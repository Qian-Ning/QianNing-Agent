//! The `Computer` tool: one tool the model can call to drive this machine.
//!
//! The definition lives in [`crate::computer`] next to the layer it describes;
//! this module owns the two decisions that belong to the tool surface — when
//! the tool is offered, and how a call is dispatched.
//!
//! Offered only while computer control is switched on, and refused at execute
//! time when it is off. Both halves matter: a model with the definition in
//! context will sometimes call it from memory after the user switches the
//! setting off mid-session, and the gate has to hold on the call, not just on
//! the listing.

use super::{rpc_err, AppState, JsonRpcError};
use crate::{
    computer::{self, params},
    tools::{ToolsExecuteParams, ToolsExecuteResult},
};
use serde_json::{json, Value};

/// The one tool name this module answers to.
pub const TOOL_NAME: &str = "Computer";

pub fn recognizes(name: &str) -> bool {
    name == TOOL_NAME
}

/// The tool, as a one-element list so the caller appends it like the other
/// optional tool groups.
pub fn definitions() -> Vec<Value> {
    vec![computer::tool_definition()]
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message.to_string(), "INVALID_PARAMS")
}

/// Serialize a layer result, mapping a platform failure to its error code.
fn encode<T: serde::Serialize>(
    result: Result<T, computer::ComputerError>,
) -> Result<Value, JsonRpcError> {
    let value = result.map_err(super::computer_rpc::computer_err)?;
    serde_json::to_value(value).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
}

fn dispatch(st: &AppState, args: &Value) -> Result<Value, JsonRpcError> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("action is required"))?;

    // The read actions answer whether or not the setting is on: seeing the
    // screen is not the part that needs consent, and a model asked to explain
    // the current state should not be blocked from looking.
    match action {
        "screen" => encode(computer::screen()),
        "cursor" => encode(computer::cursor()),
        "windows" => Ok(json!({ "windows": computer::report_windows().map_err(super::computer_rpc::computer_err)? })),
        "windowAt" => {
            let point = params::point(args).map_err(|message| invalid(&message))?;
            let windows = computer::list_windows().map_err(super::computer_rpc::computer_err)?;
            Ok(json!({ "window": computer::window_at(&windows, point) }))
        }
        "moveMouse" => {
            let point = params::point(args).map_err(|message| invalid(&message))?;
            require_enabled(st)?;
            computer::move_mouse(point).map_err(super::computer_rpc::computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "click" => {
            let point = params::point(args).map_err(|message| invalid(&message))?;
            let button = params::button(args).map_err(|message| invalid(&message))?;
            let count = params::click_count(args).map_err(|message| invalid(&message))?;
            require_enabled(st)?;
            computer::click(point, button, count).map_err(super::computer_rpc::computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "scroll" => {
            let point = params::point(args).map_err(|message| invalid(&message))?;
            let horizontal = params::notches(args, "horizontal").map_err(|message| invalid(&message))?;
            let vertical = params::notches(args, "vertical").map_err(|message| invalid(&message))?;
            require_enabled(st)?;
            computer::scroll(point, horizontal, vertical).map_err(super::computer_rpc::computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "typeText" => {
            let text = params::text(args).map_err(|message| invalid(&message))?;
            require_enabled(st)?;
            computer::type_text(&text).map_err(super::computer_rpc::computer_err)?;
            Ok(json!({ "ok": true }))
        }
        "activateWindow" => {
            let handle = params::handle(args).map_err(|message| invalid(&message))?;
            require_enabled(st)?;
            computer::activate_window(&handle).map_err(super::computer_rpc::computer_err)?;
            Ok(json!({ "ok": true }))
        }
        other => Err(invalid(&format!(
            "action must be one of screen, cursor, windows, windowAt, moveMouse, click, scroll, typeText or activateWindow, not {other}"
        ))),
    }
}

fn require_enabled(st: &AppState) -> Result<(), JsonRpcError> {
    if super::computer_rpc::control_enabled_in(st) {
        return Ok(());
    }
    Err(super::computer_rpc::disabled_err())
}

pub fn execute(st: &AppState, p: &ToolsExecuteParams) -> ToolsExecuteResult {
    let started = std::time::Instant::now();
    let result = dispatch(st, &p.args);
    let (ok, content, error_code) = match result {
        Ok(content) => (true, content, None),
        Err(error) => {
            let code = result_code(&error);
            (
                false,
                json!({ "error": error.message, "code": code }),
                Some(code),
            )
        }
    };
    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code,
        command_shell_id: None,
    }
}

/// The code slug this door reports for a host error.
///
/// Every error the computer layer produces carries `data.errorCode`, including
/// the two whose payload field travels beside it — `handle` for a vanished
/// window and `code` for a refused platform call. That is not incidental: this
/// function reads only the slug, so a payload that replaced the slug instead of
/// extending it made a vanished window report `INTERNAL` here while the RPC
/// method reported `1027`.
fn result_code(error: &JsonRpcError) -> String {
    error
        .data
        .as_ref()
        .and_then(|data| data["errorCode"].as_str())
        .unwrap_or("INTERNAL")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    const WRITE_ACTIONS: [&str; 5] = ["moveMouse", "click", "scroll", "typeText", "activateWindow"];
    const READ_ACTIONS: [&str; 4] = ["screen", "cursor", "windows", "windowAt"];

    /// A state backed by a throwaway data directory, plus the directory guard
    /// that keeps it alive for the length of the test.
    fn fixture() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().expect("temp dir");
        let state = AppState::open(dir.path()).expect("open state");
        (dir, state)
    }

    /// Only the off-Windows write test needs this: on Windows switching the
    /// setting on would really let a write through to the desktop.
    #[cfg(not(windows))]
    fn switch_control_on(state: &AppState) {
        let mut settings = state
            .db
            .get_setting("app")
            .expect("read settings")
            .unwrap_or_else(|| json!({}));
        settings["computerControlEnabled"] = json!(true);
        state
            .db
            .set_setting("app", &settings)
            .expect("write settings");
    }

    fn error_code(error: &JsonRpcError) -> &str {
        error
            .data
            .as_ref()
            .and_then(|data| data["errorCode"].as_str())
            .unwrap_or("")
    }

    /// Arguments that satisfy each action's parameter rules, so a test that
    /// means to exercise the gate is not stopped by validation first.
    fn valid_args(action: &str) -> Value {
        match action {
            "screen" | "cursor" | "windows" => json!({ "action": action }),
            "windowAt" | "moveMouse" | "click" | "scroll" => {
                json!({ "action": action, "x": 10, "y": 20 })
            }
            "typeText" => json!({ "action": action, "text": "hello" }),
            "activateWindow" => json!({ "action": action, "handle": "140234567" }),
            other => panic!("no arguments defined for {other}"),
        }
    }

    #[test]
    fn every_write_is_refused_while_control_is_off() {
        let (_dir, state) = fixture();
        for action in WRITE_ACTIONS {
            let error = dispatch(&state, &valid_args(action))
                .expect_err(&format!("{action} must be refused while control is off"));
            assert_eq!(error_code(&error), "COMPUTER_DISABLED", "action {action}");
        }
    }

    /// Off Windows only. On Windows a successful write really moves the mouse
    /// and types, so the gate-open behaviour is proven on the platforms where
    /// the platform layer is a stub that answers without touching the desktop.
    #[cfg(not(windows))]
    #[test]
    fn a_write_is_admitted_once_control_is_switched_on() {
        let (_dir, state) = fixture();
        switch_control_on(&state);
        // The platform layer answers COMPUTER_UNSUPPORTED here; the assertion
        // is that the refusal is no longer the gate's, which is what proves
        // the switch is what stands between a caller and the platform.
        for action in WRITE_ACTIONS {
            let error = dispatch(&state, &valid_args(action))
                .expect_err("the stub platform layer refuses every write");
            assert_eq!(
                error_code(&error),
                "COMPUTER_UNSUPPORTED",
                "action {action}"
            );
        }
    }

    /// On Windows the read really answers, and not needing consent is the
    /// whole assertion: the gate must never stand in the way of looking.
    #[cfg(windows)]
    #[test]
    fn a_read_is_answered_while_control_is_off() {
        let (_dir, state) = fixture();
        for action in READ_ACTIONS {
            let value = dispatch(&state, &valid_args(action))
                .unwrap_or_else(|error| panic!("{action} must read: {}", error.message));
            assert!(value.is_object(), "{action} answered with {value}");
        }
    }

    /// Off Windows every read reaches the stub platform layer, which refuses
    /// without answering — the assertion is that the refusal is not the gate's.
    #[cfg(not(windows))]
    #[test]
    fn a_read_reaches_the_platform_layer_while_control_is_off() {
        let (_dir, state) = fixture();
        for action in READ_ACTIONS {
            let error = dispatch(&state, &valid_args(action))
                .expect_err("the stub platform layer refuses every read too");
            assert_eq!(
                error_code(&error),
                "COMPUTER_UNSUPPORTED",
                "action {action}"
            );
        }
    }

    #[test]
    fn a_malformed_argument_is_rejected_before_the_gate() {
        let (_dir, state) = fixture();
        let error = dispatch(&state, &json!({ "action": "click", "x": 1.5, "y": 0 }))
            .expect_err("a fractional coordinate must be refused");
        assert_eq!(error_code(&error), "INVALID_PARAMS");
    }

    #[test]
    fn an_unknown_action_is_rejected() {
        let (_dir, state) = fixture();
        let error = dispatch(&state, &json!({ "action": "screenshot" }))
            .expect_err("an unknown action must be refused");
        assert_eq!(error_code(&error), "INVALID_PARAMS");
        assert!(error.message.contains("screenshot"), "{}", error.message);
    }

    #[test]
    fn a_missing_action_is_rejected() {
        let (_dir, state) = fixture();
        let error = dispatch(&state, &json!({})).expect_err("action is required");
        assert_eq!(error_code(&error), "INVALID_PARAMS");
    }

    /// The definition is the contract the model reads, so the action list it
    /// advertises and the actions the dispatcher answers must be the same set —
    /// an action named in neither is a typo the model would only discover by
    /// calling it.
    #[test]
    fn the_definition_advertises_exactly_the_actions_that_are_dispatched() {
        let definition = computer::tool_definition();
        assert_eq!(definition["name"], json!(TOOL_NAME));
        assert!(
            recognizes(TOOL_NAME),
            "the dispatcher must recognize the name the definition advertises"
        );

        let advertised: Vec<String> = definition["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .expect("the action enum")
            .iter()
            .map(|value| value.as_str().expect("a string action").to_string())
            .collect();
        let mut expected: Vec<String> = READ_ACTIONS
            .iter()
            .chain(WRITE_ACTIONS.iter())
            .map(|name| name.to_string())
            .collect();
        expected.sort();
        let mut advertised_sorted = advertised.clone();
        advertised_sorted.sort();
        assert_eq!(advertised_sorted, expected, "the advertised action set");

        // Every advertised action must survive parameter binding and reach its
        // own branch, so none of them falls through to the unknown-action arm.
        let (_dir, state) = fixture();
        for action in &advertised {
            #[cfg(windows)]
            if WRITE_ACTIONS.contains(&action.as_str()) {
                // Dispatching a write on Windows moves the real pointer, and
                // reaching the branch is already proven by the source below.
                continue;
            }
            // On Windows the read actions really answer, which is its own proof
            // that the action reached a branch; off Windows every action is an
            // error from the stub. Either way, INVALID_PARAMS would mean the
            // action was not recognized at all.
            if let Err(error) = dispatch(&state, &valid_args(action)) {
                assert_ne!(
                    error_code(&error),
                    "INVALID_PARAMS",
                    "{action} did not reach its own branch: {}",
                    error.message
                );
            }
        }
    }

    /// The tool door reports the same code the RPC method does.
    ///
    /// This is the half that made the two doors disagree: the result code comes
    /// from `data.errorCode`, and the payload arms of `computer_err` used to
    /// replace that field with their own, so a vanished window answered
    /// `INTERNAL` here and `1027` there.
    #[test]
    fn a_payload_error_reports_its_code_rather_than_internal() {
        let gone = super::super::computer_rpc::computer_err(computer::ComputerError::WindowGone(
            "42".to_string(),
        ));
        assert_eq!(gone.code, 1027);
        assert_eq!(result_code(&gone), "COMPUTER_WINDOW_GONE");

        let failed = super::super::computer_rpc::computer_err(computer::ComputerError::Platform {
            operation: "testCall",
            code: Some(5),
        });
        assert_eq!(result_code(&failed), "COMPUTER_FAILED");

        // An error that carries no slug at all still has to answer something.
        let bare = JsonRpcError {
            code: 1000,
            message: "no data".to_string(),
            data: None,
        };
        assert_eq!(result_code(&bare), "INTERNAL");
    }
}
