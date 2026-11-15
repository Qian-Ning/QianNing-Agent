use super::{rpc_err, AppState, JsonRpcError};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `workspace*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "workspace.get" => {
            let st = state.lock().await;
            Ok(json!({ "workspace": st.workspace.get() }))
        }
        "workspace.set" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            st.hashline.drop_all();
            let ws = st.workspace.set(PathBuf::from(path));
            let pid = st
                .db
                .ensure_project(&ws.path, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            st.db
                .kv_set("app", "currentProjectId", &json!(pid))
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "workspace": ws }))
        }
        // File search for the composer picker. The walk is bounded inside
        // `workspace_search`, and it runs on a blocking worker so a large
        // repository cannot stall the async runtime every keystroke.
        //
        // A `root` may narrow the search to a subdirectory, but never widen it:
        // anything outside the open workspace is refused rather than silently
        // searched.
        "workspace.searchFiles" => {
            let query = params
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let requested_root = params
                .get("root")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let st = state.lock().await;
            let Some(workspace) = st.workspace.get() else {
                return Ok(json!({ "hits": [] }));
            };
            let root = match requested_root {
                Some(root) => {
                    if !crate::workspace::lexically_inside(
                        std::path::Path::new(&workspace.path),
                        &root,
                    ) {
                        return Err(rpc_err(
                            1002,
                            "root must be inside the open workspace",
                            "INVALID_PARAMS",
                        ));
                    }
                    PathBuf::from(root)
                }
                None => PathBuf::from(&workspace.path),
            };
            drop(st);
            let hits = tokio::task::spawn_blocking(move || {
                crate::workspace_search::search_files(&root, &query, limit)
            })
            .await
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            Ok(json!({
                "hits": hits
                    .into_iter()
                    .map(|hit| json!({ "path": hit.path, "score": hit.score }))
                    .collect::<Vec<_>>()
            }))
        }
        "workspace.clear" => {
            let mut st = state.lock().await;
            st.hashline.drop_all();
            st.workspace.clear();
            st.db
                .kv_delete("app", "currentProjectId")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
