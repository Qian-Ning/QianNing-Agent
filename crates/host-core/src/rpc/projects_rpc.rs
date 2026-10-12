use super::drop_session_side_data;
use super::{rpc_err, AppState, JsonRpcError};
use crate::sessions;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `projects*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "projects.list" => {
            let st = state.lock().await;
            let projects = st
                .db
                .list_projects()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "projects": projects }))
        }
        "projects.create" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let id = st
                .db
                .ensure_project(path, false)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let project = st
                .db
                .get_project(id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1000, "project disappeared after creation", "INTERNAL"))?;
            Ok(json!({ "project": project }))
        }

        "projects.remove" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let path = crate::db::canonical_project_path(path)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            if crate::scheduled::project::has_running_tasks(&st.db, &path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                return Err(rpc_err(
                    1008,
                    "project has running scheduled tasks",
                    "CONFLICT",
                ));
            }
            // A path that belongs to a multi-folder project group must stay put:
            // deleting one root would orphan the rest of the group, so callers
            // remove the folder from the group first. A single-folder stored
            // group is just a wrapper around one project, so removing that
            // project also removes the now-empty group record.
            if let Some(group) = st
                .db
                .stored_project_group_for_path(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                if group.roots.len() > 1 {
                    return Err(rpc_err(
                        1002,
                        "project belongs to a multi-folder project group; remove the folder from the group first",
                        "INVALID_PARAMS",
                    ));
                }
                st.db
                    .delete_project_group_record(&group.id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            let session_ids = st
                .db
                .project_session_ids(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // A running turn still owns its session's tools and working
            // directory and is still writing to that session's transcript, so
            // the bulk delete waits until every attached session is idle.
            for id in &session_ids {
                if sessions::session_has_running_turn(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                {
                    return Err(rpc_err(1008, "project has running sessions", "CONFLICT"));
                }
            }
            crate::scheduled::project::pause(&st.db, &path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let mut sessions_removed = 0;
            for id in &session_ids {
                if sessions::delete_session(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                {
                    drop_session_side_data(&st, id);
                    sessions_removed += 1;
                }
            }
            let removed = st
                .db
                .delete_project(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            st.db
                .delete_project_memory(&path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "removed": removed, "sessionsRemoved": sessions_removed }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
