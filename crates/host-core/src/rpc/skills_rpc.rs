use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{
    parse_capability_query, parse_capability_target, parse_scope, require_id, rpc_err, skill_err,
    AppState, CapabilityLevel, JsonRpcError,
};
use crate::user_skills::UserSkillInput;

/// Read the create/import/update payload for a user skill. Absent fields stay
/// absent so `update` can distinguish "unchanged" from "cleared".
fn parse_skill_input(params: &Value) -> Result<UserSkillInput, JsonRpcError> {
    let raw = params
        .get("skill")
        .cloned()
        .unwrap_or_else(|| params.clone());
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

/// The `skills.*` method family, moved out of `rpc::handle_request`.
///
/// Every arm locks the state itself, so the caller passes the `Arc` rather than
/// a guard, exactly like `computer_rpc::handle` and `providers_rpc::handle`. The
/// arm bodies are unchanged. `parse_skill_input` comes along because nothing
/// outside this family used it; `skill_err` stays in `rpc` because the
/// integration tests import it from there.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "skills.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let skills = st
                .user_skills
                .list(level, project_path.as_deref())
                .map_err(skill_err)?;
            Ok(json!({ "skills": skills }))
        }
        "skills.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let skills = st.user_skills.active_for(project_path).map_err(skill_err)?;
            Ok(json!({ "skills": skills }))
        }
        "skills.create" => {
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.create(input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.import" => {
            let source = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?
                .to_string();
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.import(&source, input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.update" => {
            let id = require_id(&params)?;
            let input = parse_skill_input(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.update(&id, input).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.read" => {
            let id = require_id(&params)?;
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .map(|value| CapabilityLevel::parse(Some(value)))
                .transpose()
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            match st
                .user_skills
                .read(&id, level, project_path)
                .map_err(skill_err)?
            {
                Some((skill, body)) => Ok(json!({ "skill": skill, "body": body })),
                None => Ok(json!({ "skill": null, "body": null })),
            }
        }
        "skills.remove" => {
            let id = require_id(&params)?;
            let level = params
                .get("level")
                .and_then(Value::as_str)
                .map(|value| CapabilityLevel::parse(Some(value)))
                .transpose()
                .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let ok = st
                .user_skills
                .remove(&id, level, project_path)
                .map_err(skill_err)?;
            Ok(json!({ "ok": ok }))
        }
        "skills.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let skill = st
                .user_skills
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let skill = st.user_skills.set_scope(&id, scope).map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }
        "skills.transfer" => {
            let id = require_id(&params)?;
            let from = parse_capability_target(&params, "from")?;
            let to = parse_capability_target(&params, "to")?;
            let mut st = state.lock().await;
            let skill = st
                .user_skills
                .transfer(&id, &from, &to)
                .map_err(skill_err)?;
            Ok(json!({ "skill": skill }))
        }

        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
