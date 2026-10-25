use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};
use crate::inline_viz;
use crate::inline_viz::{MAX_CONTENT_BYTES, MAX_TITLE_CHARS};

/// Whether the user has switched inline visualizations on (default off).
/// Mirrors `computer_rpc::control_enabled` for the tools.list offer gate.
pub(crate) async fn enabled(state: &Arc<Mutex<AppState>>) -> bool {
    let st = state.lock().await;
    inline_viz::enabled(&st.db)
}

/// Handles the `inlineViz*` family (ADR 0327): the renderer's read window into
/// the visualizations written to a session, plus (ADR 0328) the renderer-side
/// write the transcript's "save as visualization" affordance drives. The write
/// is deliberately narrow: the artifact must target an existing session, the
/// title/kind/content must pass the same bounds the agent tool enforces, and
/// every accepted write records a `tool_execute`-shaped audit row so the
/// security-relevant state change lands in the audit log like its agent-side
/// counterpart. A renderer compromise can therefore write at most a bounded
/// artifact into an existing session — visible in the audit log — and nothing
/// outside the visualization root.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "inlineViz.list" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let visualizations = inline_viz::list(&st.data_dir, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "visualizations": visualizations }))
        }
        "inlineViz.read" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let visualization_id = params
                .get("visualizationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "visualizationId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let artifact = inline_viz::read(&st.data_dir, session_id, visualization_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "visualization not found", "NOT_FOUND"))?;
            Ok(json!({ "visualization": artifact }))
        }
        "inlineViz.write" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let title = params
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "title required", "INVALID_PARAMS"))?;
            let kind = params
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| inline_viz::is_valid_kind(kind))
                .ok_or_else(|| {
                    rpc_err(
                        1002,
                        format!("kind must be one of: {}", inline_viz::KINDS.join(", ")),
                        "INVALID_PARAMS",
                    )
                })?;
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "content required", "INVALID_PARAMS"))?;
            if title.chars().count() > MAX_TITLE_CHARS {
                return Err(rpc_err(
                    1002,
                    format!("title must be at most {MAX_TITLE_CHARS} characters"),
                    "INVALID_PARAMS",
                ));
            }
            if content.len() > MAX_CONTENT_BYTES {
                return Err(rpc_err(
                    1002,
                    format!("content exceeds the {MAX_CONTENT_BYTES}-byte limit"),
                    "INVALID_PARAMS",
                ));
            }
            let st = state.lock().await;
            // The session must exist: a write into a session root that was
            // swept or never created would strand an orphan artifact. The
            // summary projection is the existing lightweight existence probe;
            // the full transcript is not needed for a write.
            if crate::sessions::get_session(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .is_none()
            {
                return Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND"));
            }
            let meta = inline_viz::write(&st.data_dir, session_id, title, kind, content)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // Audit after the write commits, shaped like the tool path's row so
            // one query covers both writers.
            let _ = crate::audit::append(
                &st.db,
                "tool_execute",
                Some(session_id),
                json!({
                    "tool": "WriteInlineVisualization",
                    "source": "renderer",
                    "visualizationId": meta.id,
                    "kind": kind,
                    "bytes": content.len(),
                }),
            );
            Ok(json!({ "visualization": meta }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use serde_json::json;
    use std::sync::Arc;
    use tempfile::tempdir;

    /// A live host state on a throwaway data directory, with one session.
    fn state_with_session() -> (Arc<Mutex<AppState>>, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let st = AppState::open(dir.path()).unwrap();
        let session =
            crate::sessions::create_session(&st.db, Some("Test".into()), None, None, None, None)
                .unwrap();
        (Arc::new(Mutex::new(st)), session.id, dir)
    }

    #[tokio::test]
    async fn write_persists_into_the_named_session() {
        let (state, session_id, _dir) = state_with_session();
        let result = handle(
            &state,
            "inlineViz.write",
            json!({
                "sessionId": session_id,
                "title": "Usage",
                "kind": "text",
                "content": "# Usage\n42 calls",
            }),
        )
        .await
        .expect("write succeeds");
        let meta = &result["visualization"];
        assert_eq!(meta["title"], "Usage");
        assert_eq!(meta["kind"], "text");
        assert_eq!(meta["sessionId"], session_id);

        // The artifact is readable back through the same channel family.
        let read = handle(
            &state,
            "inlineViz.read",
            json!({
                "sessionId": session_id,
                "visualizationId": meta["id"],
            }),
        )
        .await
        .expect("read succeeds");
        assert_eq!(read["visualization"]["content"], "# Usage\n42 calls");
    }

    #[tokio::test]
    async fn write_refuses_a_session_that_does_not_exist() {
        let (state, _session_id, _dir) = state_with_session();
        let error = handle(
            &state,
            "inlineViz.write",
            json!({
                "sessionId": "no-such-session",
                "title": "Orphan",
                "kind": "text",
                "content": "x",
            }),
        )
        .await
        .expect_err("an unknown session must be refused");
        assert_eq!(
            error.data.unwrap()["errorCode"],
            json!("SESSION_NOT_FOUND"),
            "an orphan write must not create a directory"
        );
    }

    #[tokio::test]
    async fn write_enforces_the_same_bounds_as_the_agent_tool() {
        let (state, session_id, _dir) = state_with_session();
        // Unknown kind.
        let error = handle(
            &state,
            "inlineViz.write",
            json!({
                "sessionId": session_id,
                "title": "T",
                "kind": "pdf",
                "content": "x",
            }),
        )
        .await
        .expect_err("unknown kinds are refused");
        assert_eq!(error.data.unwrap()["errorCode"], json!("INVALID_PARAMS"));

        // Over-long title.
        let error = handle(
            &state,
            "inlineViz.write",
            json!({
                "sessionId": session_id,
                "title": "x".repeat(MAX_TITLE_CHARS + 1),
                "kind": "text",
                "content": "x",
            }),
        )
        .await
        .expect_err("over-long titles are refused");
        assert_eq!(error.data.unwrap()["errorCode"], json!("INVALID_PARAMS"));

        // Over-large content.
        let error = handle(
            &state,
            "inlineViz.write",
            json!({
                "sessionId": session_id,
                "title": "T",
                "kind": "text",
                "content": "x".repeat(MAX_CONTENT_BYTES + 1),
            }),
        )
        .await
        .expect_err("over-large content is refused");
        assert_eq!(error.data.unwrap()["errorCode"], json!("INVALID_PARAMS"));

        // Nothing was written: the session's list is still empty.
        let listed = handle(&state, "inlineViz.list", json!({ "sessionId": session_id }))
            .await
            .expect("list succeeds");
        assert_eq!(listed["visualizations"], json!([]));
    }

    #[tokio::test]
    async fn a_renderer_write_is_audited_and_marked_as_renderer_sourced() {
        let (state, session_id, _dir) = state_with_session();
        let written = handle(
            &state,
            "inlineViz.write",
            json!({
                "sessionId": session_id,
                "title": "Kept answer",
                "kind": "text",
                "content": "kept",
            }),
        )
        .await
        .expect("write succeeds");
        let viz_id = written["visualization"]["id"].as_str().unwrap().to_string();

        let st = state.lock().await;
        let payload: String = st
            .db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log \
                 WHERE kind = 'tool_execute' AND session_id = ?1 \
                 ORDER BY id DESC LIMIT 1",
                [&session_id],
                |r| r.get(0),
            )
            .expect("the renderer write must leave an audit row");
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["visualizationId"], json!(viz_id));
        assert_eq!(payload["source"], json!("renderer"));
        assert_eq!(payload["tool"], json!("WriteInlineVisualization"));
    }
}
