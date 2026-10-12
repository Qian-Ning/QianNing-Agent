use super::{
    drop_session_side_data, permission_parent_param, plan_rpc_err, session_collaboration_rpc_err,
    thinking_level_param,
};
use super::{rpc_err, AppState, JsonRpcError};
use crate::sessions::UiMessage;
use crate::transcripts::CompactionRecord;
use crate::{scratch, sessions, turn_queue};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Handles the `session*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "session.list" => {
            let st = state.lock().await;
            let sessions = sessions::list_sessions(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "sessions": sessions }))
        }
        "session.create" => {
            let thinking_level = thinking_level_param(&params)?;
            let permission_parent = permission_parent_param(&params)?;
            let st = state.lock().await;
            let permission_mode = if let Some(parent_id) = permission_parent {
                Some(
                    sessions::session_permission_mode(&st.db, &parent_id)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                        .ok_or_else(|| rpc_err(1007, "parent session not found", "NOT_FOUND"))?,
                )
            } else {
                None
            };
            let session = sessions::create_session_with_options(
                &st.db,
                sessions::SessionCreateOptions {
                    title: params
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    mode: params
                        .get("mode")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    provider_id: params
                        .get("providerId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    model_id: params
                        .get("modelId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    project_path: params
                        .get("projectPath")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    thinking_level,
                    permission_mode,
                    system_prompt: params
                        .get("systemPrompt")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                },
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "session": session }))
        }
        "session.fork" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let title = params.get("title").and_then(|v| v.as_str());
            let through_message_id = params.get("throughMessageId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let session =
                match sessions::fork_session_through(&st.db, session_id, title, through_message_id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                {
                    sessions::ForkSessionResult::Created(session) => session,
                    sessions::ForkSessionResult::NotFound => {
                        return Err(rpc_err(1007, "session not found", "NOT_FOUND"))
                    }
                    sessions::ForkSessionResult::Busy => {
                        return Err(rpc_err(1008, "session is running", "CONFLICT"))
                    }
                };
            Ok(json!({ "session": session }))
        }
        "session.moveProject" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let project_path = params
                .get("projectPath")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| rpc_err(1002, "projectPath required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let session = match sessions::move_session_project(&st.db, session_id, project_path)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                sessions::MoveSessionProjectResult::Moved(session) => session,
                sessions::MoveSessionProjectResult::NotFound => {
                    return Err(rpc_err(1007, "session not found", "NOT_FOUND"))
                }
                sessions::MoveSessionProjectResult::Busy => {
                    return Err(rpc_err(1008, "session is running", "CONFLICT"))
                }
            };
            Ok(json!({ "session": session }))
        }
        "session.get" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let message_before = params.get("messageBefore").and_then(|v| v.as_i64());
            let message_around = params
                .get("messageAround")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let message_limit = params.get("messageLimit").and_then(|v| v.as_i64());
            if message_before.is_some_and(|value| value < 0)
                || message_limit.is_some_and(|value| value <= 0)
                || (message_around.is_some()
                    && (message_before.is_some() || message_limit.is_none()))
            {
                return Err(rpc_err(
                    1002,
                    "session read window must use non-negative messageBefore and positive messageLimit",
                    "INVALID_PARAMS",
                ));
            }
            let content_limit = params
                .get("contentLimit")
                .and_then(|v| v.as_u64())
                .map(|limit| limit.min(256 * 1024) as usize);
            if params
                .get("contentLimit")
                .and_then(|value| value.as_u64())
                .is_some_and(|value| value == 0)
            {
                return Err(rpc_err(
                    1002,
                    "session contentLimit must be positive",
                    "INVALID_PARAMS",
                ));
            }
            let st = state.lock().await;
            let session = sessions::get_session_with_options(
                &st.db,
                id,
                sessions::SessionReadOptions {
                    message_around,
                    message_before,
                    message_limit,
                    content_limit,
                },
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "session": session }))
        }
        "session.configure" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mode = params
                .get("mode")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "mode required", "INVALID_PARAMS"))?;
            let thinking_level = thinking_level_param(&params)?;
            let st = state.lock().await;
            let session = sessions::configure_session_with_thinking(
                &st.db,
                id,
                mode,
                params.get("providerId").and_then(|v| v.as_str()),
                params.get("modelId").and_then(|v| v.as_str()),
                thinking_level.as_deref(),
                params.get("permissionMode").and_then(|v| v.as_str()),
            )
            .map_err(|e| {
                let message = e.to_string();
                if message.starts_with("PLAN_") {
                    plan_rpc_err(message)
                } else {
                    rpc_err(1002, message, "INVALID_PARAMS")
                }
            })?
            .ok_or_else(|| rpc_err(1007, "session not found", "NOT_FOUND"))?;
            Ok(json!({ "session": session }))
        }
        "session.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = sessions::delete_session(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if ok {
                drop_session_side_data(&st, id);
            }
            Ok(json!({ "ok": ok }))
        }
        "session.rename" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "title required", "INVALID_PARAMS"))?;
            let title = sessions::normalize_session_title(title)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = sessions::rename_session(&st.db, id, &title)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "session.setSystemPrompt" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            // Present-but-null clears the override; a string sets it; a missing
            // field is a caller bug rather than a silent clear.
            let raw = params
                .get("systemPrompt")
                .ok_or_else(|| rpc_err(1002, "systemPrompt required", "INVALID_PARAMS"))?;
            let value = match raw {
                Value::Null => None,
                Value::String(text) => Some(text.as_str()),
                _ => {
                    return Err(rpc_err(
                        1002,
                        "systemPrompt must be a string or null",
                        "INVALID_PARAMS",
                    ))
                }
            };
            let st = state.lock().await;
            let session = sessions::set_session_system_prompt(&st.db, id, value)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let Some(session) = session else {
                return Err(rpc_err(1007, "session not found", "NOT_FOUND"));
            };
            Ok(json!({ "session": session }))
        }
        "session.appendMessage" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let message: UiMessage = serde_json::from_value(
                params
                    .get("message")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "message required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let st = state.lock().await;
            sessions::append_message(&st.db, session_id, &message, turn_id.as_deref())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "session.saveInflightMessage" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let message: UiMessage = serde_json::from_value(
                params
                    .get("message")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "message required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let st = state.lock().await;
            let saved =
                sessions::save_inflight_message(&st.db, session_id, turn_id.as_deref(), &message)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "saved": saved }))
        }
        "session.recoverInflightMessages" => {
            let st = state.lock().await;
            let recovered = sessions::recover_inflight_messages(&st.db, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "count": recovered.len() }))
        }
        "session.appendCompaction" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let compaction: CompactionRecord = serde_json::from_value(
                params
                    .get("compaction")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "compaction required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            sessions::append_compaction(&st.db, session_id, &compaction)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "session.replaceMessages" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let messages: Vec<UiMessage> = serde_json::from_value(
                params
                    .get("messages")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "messages required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            sessions::replace_messages(&st.db, session_id, &messages)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "session.truncateFrom" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let from_message_id = params
                .get("fromMessageId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|id| !id.is_empty());
            let truncate_before = params.get("truncateBefore").and_then(|v| v.as_i64());
            let st = state.lock().await;
            let truncated =
                sessions::truncate_from(&st.db, session_id, from_message_id, truncate_before)
                    .map_err(|e| {
                        let message = e.to_string();
                        if message.starts_with("NOT_FOUND") {
                            rpc_err(1007, message, "NOT_FOUND")
                        } else if message.starts_with("INVALID_PARAMS") {
                            rpc_err(1002, message, "INVALID_PARAMS")
                        } else {
                            rpc_err(1000, message, "INTERNAL")
                        }
                    })?;
            serde_json::to_value(truncated).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }

        "session.saveRevision" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let root_user_id = params
                .get("rootUserId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "rootUserId required", "INVALID_PARAMS"))?;
            let messages: Vec<UiMessage> = serde_json::from_value(
                params
                    .get("messages")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "messages required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let make_active = params
                .get("makeActive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let st = state.lock().await;
            // An explicit index refreshes that revision's payload in place
            // (the branch grew since it was archived); otherwise a new index.
            let revision = match params.get("revisionIndex").and_then(|v| v.as_i64()) {
                Some(revision_index) => sessions::refresh_message_revision(
                    &st.db,
                    session_id,
                    root_user_id,
                    revision_index,
                    &messages,
                ),
                None => sessions::save_message_revision(
                    &st.db,
                    session_id,
                    root_user_id,
                    &messages,
                    make_active,
                ),
            }
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "revision": revision }))
        }
        "session.saveActiveRevision" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let saved = sessions::save_active_branch_revision(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "saved": saved }))
        }
        "session.listRevisions" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let root_user_id = params
                .get("rootUserId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "rootUserId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let revisions = sessions::list_message_revisions(&st.db, session_id, root_user_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "revisions": revisions }))
        }
        "session.activateRevision" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let root_user_id = params
                .get("rootUserId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "rootUserId required", "INVALID_PARAMS"))?;
            let revision_index = params
                .get("revisionIndex")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| rpc_err(1002, "revisionIndex required", "INVALID_PARAMS"))?;
            let prefix: Vec<UiMessage> =
                serde_json::from_value(params.get("prefix").cloned().unwrap_or_else(|| json!([])))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let messages = sessions::activate_message_revision(
                &st.db,
                session_id,
                root_user_id,
                revision_index,
                &prefix,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "messages": messages }))
        }
        "session.getScratchPath" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let path = scratch::session_dir(&st.data_dir, session_id)
                .ok_or_else(|| rpc_err(1002, "invalid session id", "INVALID_PARAMS"))?;
            Ok(json!({ "path": path.to_string_lossy() }))
        }

        "session.import" => {
            let summary: sessions::SessionSummary = serde_json::from_value(
                params
                    .get("session")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "session required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let messages: Vec<UiMessage> = serde_json::from_value(
                params
                    .get("messages")
                    .cloned()
                    .ok_or_else(|| rpc_err(1002, "messages required", "INVALID_PARAMS"))?,
            )
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let imported = sessions::import_session(&st.db, &summary, &messages)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "imported": imported, "skipped": !imported }))
        }

        // Plugin sessions are a separate host-owned domain. Electron main is
        // the only caller that can supply pluginId; the plugin process never
        // receives a generic host RPC handle or SQLite access.
        "session.beginTurn" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let provider = params.get("providerId").and_then(Value::as_str);
            let model = params.get("modelId").and_then(Value::as_str);
            let turn_id = match params.get("sessionMessageId").and_then(Value::as_str) {
                Some(message_id) => crate::session_collaboration::begin_turn(
                    &st.db, session_id, message_id, provider, model,
                ),
                None => sessions::begin_turn(&st.db, session_id, provider, model),
            }
            .map_err(session_collaboration_rpc_err)?;
            Ok(json!({ "turnId": turn_id }))
        }
        "session.endTurn" => {
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            let st = state.lock().await;
            let result = sessions::end_turn_settling(
                &st.db,
                turn_id,
                status,
                params.get("errorCode").and_then(|v| v.as_str()),
                params.get("usage"),
                params
                    .get("createNotification")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                params
                    .get("recoverInflight")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let mut response = json!({ "ok": result.updated });
            if let Some(notification) = result.notification {
                response["notification"] = json!(notification);
            }
            if let Some(recovered) = result.recovered {
                response["recovered"] = json!(recovered);
            }
            Ok(response)
        }

        // The Host-owned turn queue (D375 / ADR 0213). Entries are durable so
        // a restart restores them in order; the Agent Host decides when one
        // starts, never the store.
        "session.queuePush" => {
            let input: turn_queue::QueuedTurnInput = serde_json::from_value(params.clone())
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let entry = turn_queue::push(&st.db, input).map_err(|e| {
                let message = e.to_string();
                if message == "QUEUE_FULL" {
                    rpc_err(1008, message, "AGENT_BUSY")
                } else if message == "IDEMPOTENCY_CONFLICT" {
                    rpc_err(1008, message, "IDEMPOTENCY_CONFLICT")
                } else if message.starts_with("session not found") {
                    rpc_err(1007, message, "SESSION_NOT_FOUND")
                } else {
                    rpc_err(1000, message, "INTERNAL")
                }
            })?;
            Ok(json!({ "entry": entry }))
        }
        "session.queueList" => {
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            let entries = turn_queue::list(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "entries": entries }))
        }
        "session.queueRemove" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let removed = turn_queue::remove(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "removed": removed }))
        }
        "session.queuePrioritize" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let entry = turn_queue::prioritize(&st.db, id)
                .map_err(|e| {
                    let message = e.to_string();
                    if message == "ALREADY_PRIORITIZED" {
                        rpc_err(1008, message, "CONFLICT")
                    } else {
                        rpc_err(1000, message, "INTERNAL")
                    }
                })?
                .ok_or_else(|| rpc_err(1007, "queue entry not found", "NOT_FOUND"))?;
            Ok(json!({ "entry": entry }))
        }
        "session.queueReorder" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let direction = params
                .get("direction")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "direction required", "INVALID_PARAMS"))?;
            let direction = match direction {
                "up" => turn_queue::ReorderDirection::Up,
                "down" => turn_queue::ReorderDirection::Down,
                other => {
                    return Err(rpc_err(
                        1002,
                        format!("unknown direction: {other}"),
                        "INVALID_PARAMS",
                    ))
                }
            };
            let st = state.lock().await;
            let moved = turn_queue::reorder(&st.db, id, direction)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "moved": moved }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
