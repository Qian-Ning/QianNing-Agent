//! The `WriteInlineVisualization` agent tool (ADR 0327).
//!
//! One tool the model can call to attach a static artifact — HTML, SVG, JSON,
//! CSV or plain text — to the session it is running in. The definition, the
//! offer gate (`tools.list` only lists it while the Settings switch is on)
//! and the dispatch all live here; the storage itself is
//! [`crate::inline_viz`]. Permission and audit need no parallel mechanism:
//! the call rides the normal `tools.execute` gate (risk table in
//! `permissions.rs`, `tool_execute` audit row in `tools_rpc.rs`) like every
//! other host tool.

use serde_json::{json, Value};

use super::{rpc_err, AppState, JsonRpcError};
use crate::{
    inline_viz,
    tools::{ToolsExecuteParams, ToolsExecuteResult},
};

/// The one tool name this module answers to.
pub const TOOL_NAME: &str = "WriteInlineVisualization";

/// Fields the tool accepts; anything else is rejected up front so a typo
/// cannot silently extend the contract.
const ALLOWED_FIELDS: &[&str] = &["sessionId", "title", "kind", "content"];

pub fn recognizes(name: &str) -> bool {
    name == TOOL_NAME
}

/// The tool, as a one-element list so the caller appends it like the other
/// optional tool groups.
pub fn definitions() -> Vec<Value> {
    vec![json!({
        "name": TOOL_NAME,
        "description": "Create an inline visualization attached to the current conversation: static HTML, an SVG document, JSON, CSV, or plain text. The transcript may render it inside a strict sandbox (scripts and same-origin access are disabled) when the user has inline visualizations switched on in Settings; the content itself is stored with the session and never executed. Use it for self-contained charts, diagrams, dashboards, tables or formatted output the user should see rendered rather than as raw text. Keep the content self-contained: it cannot load local files or network resources in the sandboxed preview.",
        "risk": "low",
        "parameters": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sessionId": { "type": "string", "description": "The session id to attach the visualization to (must match the current session)." },
                "title": { "type": "string", "minLength": 1, "maxLength": 120, "description": "Short title shown on the transcript card." },
                "kind": { "type": "string", "enum": inline_viz::KINDS, "description": "html: a full HTML document; svg: an <svg> document; json/csv/text: structured or plain data rendered as text." },
                "content": { "type": "string", "maxLength": inline_viz::MAX_CONTENT_BYTES, "description": "The artifact content. html/svg are rendered as documents; json/csv/text are shown verbatim. No scripts of any kind ever run." }
            },
            "required": ["sessionId", "title", "kind", "content"]
        }
    })]
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message.to_string(), "INVALID_PARAMS")
}

fn execute_inner(st: &AppState, p: &ToolsExecuteParams) -> Result<Value, JsonRpcError> {
    let args = p
        .args
        .as_object()
        .ok_or_else(|| invalid("arguments must be an object"))?;
    if args
        .keys()
        .any(|key| !ALLOWED_FIELDS.contains(&key.as_str()))
    {
        return Err(invalid("unsupported visualization field"));
    }
    // The execution session is authoritative; the model-facing sessionId
    // argument must agree with it, so a stale or forged id cannot redirect
    // the artifact into another session.
    let session_id = args
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| *id == p.session_id)
        .ok_or_else(|| invalid("sessionId must match the current session"))?;
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .ok_or_else(|| invalid("title required"))?;
    let kind = args
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| inline_viz::is_valid_kind(kind))
        .ok_or_else(|| {
            invalid(&format!(
                "kind must be one of: {}",
                inline_viz::KINDS.join(", ")
            ))
        })?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("content required"))?;
    let meta = inline_viz::write(&st.data_dir, session_id, title, kind, content)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    Ok(json!({ "visualization": meta }))
}

/// Execute after the normal permission gate has admitted the call; mirrors
/// `scheduled_tools::execute`'s wrapper shape so a validation error surfaces
/// as a failed tool result (with its code) rather than a transport error.
pub fn execute(st: &AppState, p: &ToolsExecuteParams) -> ToolsExecuteResult {
    let started = std::time::Instant::now();
    let result = execute_inner(st, p);
    let (ok, content, error_code) = match result {
        Ok(content) => (true, content, None),
        Err(error) => {
            let code = error
                .data
                .as_ref()
                .and_then(|data| data["errorCode"].as_str())
                .unwrap_or("INTERNAL")
                .to_string();
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
