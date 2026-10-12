use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use super::emit_notification;
use super::plan_rpc_err;
use super::resolve_plan_workspace;
use super::resolve_plan_workspace_if_available;
use super::{rpc_err, AppState, JsonRpcError};
use crate::plans;

/// Handles the `plans*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    match method {
        "plans.pending" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let (pending, planning_state, kind) = {
                let crate::state::AppState { db, plans, .. } = &*st;
                let pending = plans
                    .pending_for_session(db, session_id)
                    .map_err(plan_rpc_err)?;
                let planning_state = session_id
                    .map(|id| plans.state_for_session(db, id))
                    .transpose()
                    .map_err(plan_rpc_err)?;
                // The session's own mode names the contract being authored even
                // when no proposal exists yet (Plan/Goal `planning`).
                let kind = session_id
                    .map(|id| plans.active_kind(db, id))
                    .transpose()
                    .map_err(plan_rpc_err)?
                    .flatten();
                (pending, planning_state, kind)
            };
            Ok(json!({ "plans": pending, "state": planning_state, "kind": kind }))
        }
        "plans.enter" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|id| id.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|id| id.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            // Older sidecars only knew Plan; absent means Plan (D198).
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or(plans::KIND_PLAN);
            let kind = plans::normalize_kind(kind)
                .ok_or_else(|| rpc_err(1002, "kind must be 'plan' or 'goal'", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let planning_state = {
                let crate::state::AppState { db, plans, .. } = &*st;
                plans
                    .enter(db, session_id, turn_id, tool_call_id, kind)
                    .map_err(plan_rpc_err)?;
                plans
                    .state_for_session(db, session_id)
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": session_id,
                    "state": planning_state,
                    "kind": kind,
                }),
            )
            .await;
            Ok(json!({ "ok": true, "state": planning_state, "kind": kind }))
        }
        "plans.submit" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "title required", "INVALID_PARAMS"))?;
            let markdown = params
                .get("markdown")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "markdown required", "INVALID_PARAMS"))?;
            let question = params
                .get("question")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "question required", "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or(plans::KIND_PLAN);
            let kind = plans::normalize_kind(kind)
                .ok_or_else(|| rpc_err(1002, "kind must be 'plan' or 'goal'", "INVALID_PARAMS"))?;
            let proposal = {
                let guard = state.lock().await;
                let st = &*guard;
                let workspace = resolve_plan_workspace(st, session_id)?;
                st.plans
                    .submit(
                        &st.db,
                        crate::plans::PlanSubmitParams {
                            workspace_root: &workspace,
                            session_id,
                            turn_id,
                            tool_call_id,
                            kind,
                            title,
                            markdown,
                            question,
                        },
                    )
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": session_id,
                    "state": "awaiting_approval",
                    "kind": proposal.kind,
                    "proposalId": proposal.id,
                    "proposal": proposal
                }),
            )
            .await;
            Ok(json!({ "status": "pending", "proposal": proposal }))
        }
        "plans.resolve" => {
            let proposal_id = params
                .get("proposalId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "proposalId required", "INVALID_PARAMS"))?;
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let version = params.get("version").and_then(|v| v.as_i64());
            let target = params.get("targetPermissionMode").and_then(|v| v.as_str());
            let resolution = {
                let guard = state.lock().await;
                let st = &*guard;
                let workspace = if action == "approve" {
                    resolve_plan_workspace_if_available(st, session_id)?
                } else {
                    None
                };
                st.plans
                    .resolve(
                        &st.db,
                        crate::plans::PlanResolveParams {
                            workspace_root: workspace.as_deref(),
                            proposal_id,
                            session_id,
                            turn_id,
                            tool_call_id,
                            version,
                            action,
                            target_permission_mode: target,
                        },
                    )
                    .map_err(plan_rpc_err)?
            };
            let state_name = if resolution.status == plans::STATUS_APPROVED {
                "inactive"
            } else {
                "planning"
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": resolution.proposal.session_id,
                    "state": state_name,
                    "kind": resolution.proposal.kind,
                    "proposalId": resolution.proposal.id,
                    "proposal": resolution.proposal,
                    "action": resolution.action,
                    "targetPermissionMode": resolution.target_permission_mode,
                    "execution": resolution.execution
                }),
            )
            .await;
            Ok(json!({
                "ok": true,
                "proposal": resolution.proposal,
                "state": state_name,
                "action": resolution.action,
                "targetPermissionMode": resolution.target_permission_mode,
                "execution": resolution.execution
            }))
        }
        "plans.queuedExecutions" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let executions = st
                .plans
                .queued_executions(&st.db, session_id)
                .map_err(plan_rpc_err)?;
            Ok(json!({ "executions": executions }))
        }
        "plans.claimExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let execution = {
                let st = state.lock().await;
                st.plans
                    .claim_execution(&st.db, execution_id)
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": execution.session_id,
                    "proposalId": execution.proposal_id,
                    "state": "inactive",
                    "kind": execution.kind,
                    "execution": execution,
                }),
            )
            .await;
            Ok(json!({ "execution": execution }))
        }
        "plans.finishExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "status required", "INVALID_PARAMS"))?;
            let execution = {
                let st = state.lock().await;
                st.plans
                    .finish_execution(
                        &st.db,
                        execution_id,
                        status,
                        params.get("errorCode").and_then(|v| v.as_str()),
                    )
                    .map_err(plan_rpc_err)?
            };
            emit_notification(
                &tx,
                "plans.changed",
                json!({
                    "sessionId": execution.session_id,
                    "proposalId": execution.proposal_id,
                    "state": "inactive",
                    "kind": execution.kind,
                    "execution": execution,
                }),
            )
            .await;
            Ok(json!({ "execution": execution }))
        }
        "plans.abort" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let (changed, kind) = {
                let st = state.lock().await;
                let changed = st
                    .plans
                    .abort_session(&st.db, session_id)
                    .map_err(plan_rpc_err)?;
                // Only a session that still exists can name the contract it
                // returns to, and only such a session can have changed here.
                let kind = if changed {
                    st.plans
                        .active_kind(&st.db, session_id)
                        .map_err(plan_rpc_err)?
                } else {
                    None
                };
                (changed, kind)
            };
            if changed {
                emit_notification(
                    &tx,
                    "plans.changed",
                    json!({ "sessionId": session_id, "state": "planning", "kind": kind }),
                )
                .await;
            }
            Ok(json!({ "ok": true, "changed": changed }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
