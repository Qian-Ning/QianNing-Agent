use super::{
    bash_cancellation_requested, cancel_pending_permission, clear_bash_cancellation,
    command_shell_catalog, emit_notification, execute_plugin_tool,
    requires_external_path_permission, resolve_tool_workspace_for_call, shell_changed_result,
    shell_failure_result, wait_for_bash_cancellation,
};
use super::{computer_rpc, computer_tool, connection_rpc, connection_tool, scheduled_tools};
use super::{rpc_err, AppState, JsonRpcError};
use crate::permissions::PermissionDecision;
use crate::permissions::PermissionEvaluationParams;
use crate::permissions::PermissionManager;
use crate::tools::ToolsExecuteParams;
use crate::{artifacts, audit, review, scratch, sessions, tools, workspace};
use anyhow::Result;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

/// Handles the `tools*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    match method {
        "tools.list" => {
            let mut definitions = tools::builtin_tool_defs();
            if let Some(items) = definitions.as_array_mut() {
                items.extend(scheduled_tools::definitions());
                // Computer is offered only while the user has it switched on;
                // the same gate refuses the call at execute time.
                if computer_rpc::control_enabled(state).await {
                    items.extend(computer_tool::definitions());
                }
                // Connection is offered only while the user has outbound
                // connections switched on. The listing door and the execution
                // door read the same predicate (D659).
                if connection_rpc::switch_enabled(state).await {
                    items.extend(connection_tool::definitions());
                }
            }
            Ok(json!({ "tools": definitions }))
        }
        "tools.execute" => {
            let call_started = std::time::Instant::now();
            let p: ToolsExecuteParams = serde_json::from_value(params.clone())
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let execution_timeout_ms = tools::effective_timeout_ms(&p.tool_name, p.timeout_ms);

            let command_shell_id = if p.tool_name == "Bash" {
                let catalog = {
                    let st = state.lock().await;
                    command_shell_catalog(&st)?
                };
                let effective_id = catalog.effective.as_ref().map(|shell| shell.id.clone());
                let shell_id = effective_id
                    .clone()
                    .or_else(|| Some(catalog.configured_id.clone()));
                let Some(effective) = catalog.effective.as_ref() else {
                    let result = shell_failure_result(
                        &p,
                        "SHELL_NOT_FOUND",
                        tools::shell::SHELL_MISSING_GUIDANCE,
                        shell_id,
                        call_started,
                    );
                    return serde_json::to_value(result)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                };
                let Some(expected) = p.expected_command_shell_id.as_deref() else {
                    let result = shell_failure_result(
                        &p,
                        "COMMAND_SHELL_CHANGED",
                        "expectedCommandShellId is required for Bash execution",
                        Some(effective.id.clone()),
                        call_started,
                    );
                    return serde_json::to_value(result)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                };
                let expected_dialect = p.expected_command_shell_dialect.as_deref();
                if expected_dialect != Some(effective.dialect.as_str()) || expected != effective.id
                {
                    let result = shell_changed_result(
                        &p,
                        expected,
                        expected_dialect,
                        Some(effective.id.clone()),
                        Some(effective.dialect.as_str()),
                        call_started,
                    );
                    return serde_json::to_value(result)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                }
                effective_id
            } else {
                None
            };

            let durable_mode = {
                let st = state.lock().await;
                if st.shutting_down {
                    return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
                }
                sessions::session_mode(&st.db, &p.session_id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                    .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?
            };

            // Register before permission evaluation so tools.abort can cancel
            // an approval wait as well as an already-spawned process.
            let cancellation_receiver = if matches!(
                p.tool_name.as_str(),
                "Bash" | "GenerateImages" | "GenerateVideos"
            ) {
                let mut st = state.lock().await;
                match st.register_bash_cancellation(&p.session_id, &p.tool_call_id) {
                    Ok(receiver) => Some(receiver),
                    Err(error_code) => {
                        let result = shell_failure_result(
                            &p,
                            &error_code,
                            "another Bash call is already active for this tool call ID",
                            command_shell_id.clone(),
                            call_started,
                        );
                        return serde_json::to_value(result)
                            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                    }
                }
            } else {
                None
            };

            let outcome: Result<Value, JsonRpcError> = async {
                let (
                    auto_decision,
                    workspace_path,
                    scratch_path,
                    external_path_permission,
                    pending_rx,
                    request_opt,
                    permission_shell_id,
                ) = {
                    let mut st = state.lock().await;
                    if st.shutting_down {
                        return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
                    }
                    st.permissions.expire_stale();
                    // Effective permission mode (D115): per-session override
                    // unless it is `inherit`, then the global settings default,
                    // then `ask`. A subagent's tool call carries its own scope
                    // (ADR 0089), which resolves the call under that mode
                    // instead; external-path gating and the contract modes'
                    // hard deny are untouched by the override.
                    let session_pm = sessions::session_permission_mode(&st.db, &p.session_id)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                        .filter(|m| m != "inherit");
                    let effective_pm = match session_pm {
                        Some(m) => m,
                        None => st
                            .db
                            .get_setting("app")
                            .ok()
                            .flatten()
                            .and_then(|s| {
                                s.get("defaultPermissionMode")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                            })
                            .filter(|m| sessions::is_valid_permission_mode(m) && m != "inherit")
                            .unwrap_or_else(|| "ask".to_string()),
                    };
                    let effective_pm = match p.permission_scope.as_deref() {
                        Some(scope)
                            if sessions::is_valid_permission_mode(scope) && scope != "inherit" =>
                        {
                            scope.to_string()
                        }
                        _ => effective_pm,
                    };
                    // Resolve the tool root from the persisted session instead of
                    // the mutable global workspace. This keeps background turns
                    // isolated when the renderer switches between project tabs.
                    // The session's project remains the containment root for all
                    // known sessions.
                    let ws = resolve_tool_workspace_for_call(&st, &p.session_id, &p.args)?;
                    let scratch = scratch::session_dir(&st.data_dir, &p.session_id);
                    let external_path_permission = requires_external_path_permission(
                        ws.as_deref(),
                        scratch.as_deref(),
                        &p.tool_name,
                        &p.args,
                    );
                    let mut auto = st
                        .permissions
                        .evaluate_auto_with_permission_mode_and_risk_and_path(
                            PermissionEvaluationParams {
                                session_id: &p.session_id,
                                tool_name: &p.tool_name,
                                mode: &durable_mode,
                                permission_mode: &effective_pm,
                                session_grants: &st.session_grants,
                                declared_risk: p.declared_risk.as_deref(),
                                requires_external_path_permission: external_path_permission,
                                plan_safe_actions: p.plan_safe_actions.as_deref(),
                            },
                        );
                    // Write/Edit targeting the session scratch dir never touch
                    // the user's project — skip the prompt (D114). The lexical
                    // pre-check only decides prompting; execution still goes
                    // through the symlink-aware resolver, so it cannot be used
                    // to escape containment. A contract mode's hard deny is
                    // never bypassed.
                    if !sessions::is_contract_mode(&durable_mode)
                        && auto.is_none()
                        && matches!(p.tool_name.as_str(), "Write" | "Edit")
                    {
                        if let (Some(scratch_dir), Some(path)) = (
                            scratch.as_deref(),
                            p.args.get("path").and_then(|v| v.as_str()),
                        ) {
                            if workspace::lexically_inside(scratch_dir, path) {
                                auto = Some(PermissionDecision::AllowOnce);
                            }
                        }
                    }
                    if let Some(decision) = auto {
                        (
                            Some(decision),
                            ws,
                            scratch,
                            external_path_permission,
                            None,
                            None,
                            command_shell_id.clone(),
                        )
                    } else {
                        let reason = if external_path_permission {
                            "Accesses a path outside the session workspace"
                        } else {
                            match p.tool_name.as_str() {
                                "Write" | "Edit" => "Modifies files in your workspace",
                                "Bash" => "Runs a shell command in your workspace",
                                name if name.starts_with("mcp_") => {
                                    "MCP server tool requires approval"
                                }
                                name if name.starts_with("plugin_") => {
                                    "Plugin-provided tool requires approval"
                                }
                                _ => "High-risk tool requires approval",
                            }
                        };
                        let (req, rx) = st.permissions.create_request_with_risk_and_shell(
                            crate::permissions::PermissionRequestParams {
                                session_id: &p.session_id,
                                tool_call_id: &p.tool_call_id,
                                tool_name: &p.tool_name,
                                args_preview: p.args.clone(),
                                reason,
                                declared_risk: p.declared_risk.as_deref(),
                                command_shell_id: command_shell_id.as_deref(),
                            },
                        );
                        st.register_pending_permission(
                            &req.request_id,
                            &req.session_id,
                            &req.tool_call_id,
                        );
                        (
                            None,
                            ws,
                            scratch,
                            external_path_permission,
                            Some(rx),
                            Some(req),
                            command_shell_id.clone(),
                        )
                    }
                };

                let prompted = request_opt.is_some();
                let mut permission_cancellation = cancellation_receiver.clone();
                let mut cancelled = bash_cancellation_requested(&permission_cancellation);
                if cancelled {
                    let _ = cancel_pending_permission(state, &p).await;
                }
                if !cancelled {
                    if let Some(req) = request_opt {
                        let mut permission_params = json!({
                            "requestId": req.request_id,
                            "sessionId": req.session_id,
                            "toolCallId": req.tool_call_id,
                            "toolName": req.tool_name,
                            "risk": req.risk,
                            "argsPreview": req.args_preview,
                            "reason": req.reason,
                            "timeoutMs": req.timeout_ms
                        });
                        if let Some(shell_id) = req.command_shell_id.as_deref() {
                            permission_params["commandShellId"] = json!(shell_id);
                        }
                        emit_notification(&tx, "permissions.request", permission_params).await;
                        tracing::info!(
                            request_id = %req.request_id,
                            tool = %req.tool_name,
                            command_shell_id = permission_shell_id.as_deref(),
                            "permission required"
                        );
                    }
                }

                let final_decision = if cancelled {
                    PermissionDecision::Deny
                } else if let Some(d) = auto_decision {
                    cancelled = bash_cancellation_requested(&permission_cancellation);
                    if cancelled {
                        let _ = cancel_pending_permission(state, &p).await;
                        PermissionDecision::Deny
                    } else {
                        d
                    }
                } else if let Some(rx) = pending_rx {
                    let permission_wait = tokio::time::timeout(
                        std::time::Duration::from_millis(crate::permissions::PERMISSION_TIMEOUT_MS),
                        rx,
                    );
                    tokio::pin!(permission_wait);
                    tokio::select! {
                        outcome = &mut permission_wait => match outcome {
                            Ok(Ok(d)) => d,
                            _ => PermissionDecision::Deny,
                        },
                        _ = wait_for_bash_cancellation(&mut permission_cancellation) => {
                            let _ = cancel_pending_permission(state, &p).await;
                            cancelled = true;
                            PermissionDecision::Deny
                        },
                    }
                } else {
                    PermissionDecision::Deny
                };
                cancelled = cancelled || bash_cancellation_requested(&permission_cancellation);
                if cancelled {
                    let _ = cancel_pending_permission(state, &p).await;
                }
                // Everything up to here is approval: the auto-decision path costs
                // microseconds, the prompt path costs however long the user took.
                let permission_wait_ms = call_started.elapsed().as_millis() as u64;

                if matches!(final_decision, PermissionDecision::Deny) {
                    let _ = cancel_pending_permission(state, &p).await;
                    let st = state.lock().await;
                    let mut denied_audit = json!({
                        "toolName": p.tool_name,
                        "toolCallId": p.tool_call_id,
                        "mode": durable_mode,
                        "externalPathPermission": external_path_permission,
                        "prompted": prompted,
                        "permissionWaitMs": permission_wait_ms,
                        "totalMs": call_started.elapsed().as_millis() as u64
                    });
                    if let Some(shell_id) = permission_shell_id.as_deref() {
                        denied_audit["commandShellId"] = json!(shell_id);
                    }
                    let _ = audit::append(
                        &st.db,
                        if cancelled {
                            "tool_aborted"
                        } else {
                            "tool_denied"
                        },
                        Some(&p.session_id),
                        denied_audit,
                    );
                    let error_code = if cancelled {
                        "TOOL_ABORTED"
                    } else if sessions::is_contract_mode(&durable_mode)
                        && !PermissionManager::plan_mode_allows(&p.tool_name)
                    {
                        match p.tool_name.as_str() {
                            "Write" => "WRITE_DISABLED_IN_PLAN",
                            "Edit" => "EDIT_DISABLED_IN_PLAN",
                            name if name.starts_with("plugin_") => "PLUGIN_DISABLED_IN_PLAN",
                            _ => "TOOL_DISABLED_IN_PLAN",
                        }
                    } else {
                        "TOOL_DENIED"
                    };
                    let mut denied_result = json!({
                        "toolCallId": p.tool_call_id,
                        "ok": false,
                        "isError": true,
                        "content": {
                            "error": if cancelled { "tool aborted" } else { "permission denied" },
                            "code": error_code
                        },
                        "durationMs": 0,
                        "denied": !cancelled,
                        "errorCode": error_code
                    });
                    if let Some(shell_id) = permission_shell_id.as_deref() {
                        denied_result["commandShellId"] = json!(shell_id);
                    }
                    return Ok(denied_result);
                }

                if matches!(final_decision, PermissionDecision::AllowSession) {
                    let mut st = state.lock().await;
                    st.session_grants
                        .entry(p.session_id.clone())
                        .or_default()
                        .push(p.tool_name.clone());
                }

                // Admission follows permission so approval waits do not occupy
                // execution capacity. Keep this permit through review, the
                // runner, and bookkeeping so every accepted call is bounded.
                let tool_budget = {
                    let st = state.lock().await;
                    st.tool_budget.clone()
                };
                let _tool_permit = match tool_budget.acquire(&p.session_id, &p.tool_name).await {
                    Ok(permit) => permit,
                    Err(error) => {
                        tracing::warn!(
                            tool = %p.tool_name,
                            session_id = %p.session_id,
                            error_code = error.code(),
                            "tool admission rejected"
                        );
                        let mut result = json!({
                            "toolCallId": p.tool_call_id,
                            "ok": false,
                            "isError": true,
                            "content": {
                                "error": error.message(),
                                "code": error.code()
                            },
                            "durationMs": call_started.elapsed().as_millis() as u64,
                            "denied": false,
                            "errorCode": error.code()
                        });
                        if let Some(shell_id) = permission_shell_id.as_deref() {
                            result["commandShellId"] = json!(shell_id);
                        }
                        return Ok(result);
                    }
                };

                let ws_path = workspace_path.map(PathBuf::from);
                let (data_dir, hashline_store) = {
                    let st = state.lock().await;
                    (st.data_dir.clone(), st.hashline.clone())
                };
                let hashline_ctx = tools::HashlineContext {
                    session_id: p.session_id.as_str(),
                    store: &hashline_store,
                };
                let pending_review = review::prepare_change(
                    &data_dir,
                    &p.session_id,
                    &p.tool_call_id,
                    ws_path.as_deref(),
                    scratch_path.as_deref(),
                    &p.tool_name,
                    &p.args,
                )
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        session_id = %p.session_id,
                        tool_call_id = %p.tool_call_id,
                        error = %error,
                        "review snapshot preparation failed"
                    );
                    None
                });
                let mut bash_options = None;
                if p.tool_name == "Bash" {
                    let (shell_id, cancellation) = {
                        let st = state.lock().await;
                        let catalog = command_shell_catalog(&st)?;
                        let Some(effective) = catalog.effective.as_ref() else {
                            let result = shell_failure_result(
                                &p,
                                "SHELL_NOT_FOUND",
                                tools::shell::SHELL_MISSING_GUIDANCE,
                                Some(catalog.configured_id.clone()),
                                call_started,
                            );
                            return serde_json::to_value(result)
                                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                        };
                        let Some(expected) = p.expected_command_shell_id.as_deref() else {
                            let result = shell_failure_result(
                                &p,
                                "COMMAND_SHELL_CHANGED",
                                "expectedCommandShellId is required for Bash execution",
                                Some(effective.id.clone()),
                                call_started,
                            );
                            return serde_json::to_value(result)
                                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                        };
                        let expected_dialect = p.expected_command_shell_dialect.as_deref();
                        if expected_dialect != Some(effective.dialect.as_str())
                            || expected != effective.id
                        {
                            let result = shell_changed_result(
                                &p,
                                expected,
                                expected_dialect,
                                Some(effective.id.clone()),
                                Some(effective.dialect.as_str()),
                                call_started,
                            );
                            return serde_json::to_value(result)
                                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"));
                        }
                        (effective.id.clone(), cancellation_receiver.clone())
                    };
                    bash_options = Some(tools::BashExecutionOptions {
                        session_id: p.session_id.clone(),
                        tool_call_id: p.tool_call_id.clone(),
                        command_shell_id: shell_id,
                        timeout_ms: execution_timeout_ms,
                        cancellation,
                        output_tx: Some(tx.clone()),
                    });
                }

                let mut result = if tools::is_desktop_dispatched(&p.tool_name) {
                    // Plugin and MCP dispatch has its own bounded default, sized
                    // to outlast Electron's budgets; command-shell timeout
                    // semantics apply only to Bash.
                    execute_plugin_tool(
                        state,
                        &tx,
                        &p,
                        tools::desktop_dispatch_timeout_ms(p.timeout_ms),
                        &durable_mode,
                    )
                    .await
                } else if connection_tool::recognizes(&p.tool_name) {
                    // The connection tool awaits inside, so it takes the state
                    // lock itself rather than being handed a held guard.
                    connection_tool::execute(state, &p).await
                } else if computer_tool::recognizes(&p.tool_name) {
                    let st = state.lock().await;
                    computer_tool::execute(&st, &p)
                } else if scheduled_tools::recognizes(&p.tool_name) {
                    let st = state.lock().await;
                    scheduled_tools::execute(&st, &p)
                } else {
                    tools::execute_tool_with_path_access(
                        ws_path.as_deref(),
                        scratch_path.as_deref(),
                        &p.tool_name,
                        &p.args,
                        tools::ToolExecutionOptions {
                            timeout_ms: execution_timeout_ms,
                            bash_options,
                            allow_external_paths: external_path_permission,
                            hashline: Some(hashline_ctx),
                        },
                    )
                    .await
                };
                result.tool_call_id = p.tool_call_id.clone();

                if let Some(pending) = pending_review {
                    if result.ok {
                        match review::finalize_change(&pending) {
                            Ok(change) => {
                                if let Some(object) = result.content.as_object_mut() {
                                    object.insert(
                                        "review".to_string(),
                                        serde_json::to_value(change).map_err(|error| {
                                            rpc_err(1000, error.to_string(), "INTERNAL")
                                        })?,
                                    );
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    session_id = %p.session_id,
                                    tool_call_id = %p.tool_call_id,
                                    error = %error,
                                    "review snapshot finalization failed"
                                );
                                review::discard_change(pending);
                            }
                        }
                    } else {
                        review::discard_change(pending);
                    }
                }

                let st = state.lock().await;
                // Scratch files are temp by definition: keep them out of the
                // artifacts table so the work panel file list only shows
                // workspace deliverables (D114).
                let result_root = result.content.get("root").and_then(|v| v.as_str());
                if result.ok
                    && result_root == Some("workspace")
                    && matches!(p.tool_name.as_str(), "Write" | "Edit")
                {
                    if let Some(rel) = result.content.get("path").and_then(|v| v.as_str()) {
                        let abs = match ws_path.as_deref() {
                            Some(root) => root.join(rel).to_string_lossy().to_string(),
                            None => rel.to_string(),
                        };
                        let op = if p.tool_name == "Write" {
                            "write"
                        } else {
                            "edit"
                        };
                        let _ = artifacts::record(
                            &st.db,
                            &p.session_id,
                            &abs,
                            op,
                            p.turn_id.as_deref(),
                        );
                    }
                }
                // `overhead_ms` is the host's own share outside approval and the
                // tool body: workspace resolution, the state lock, artifacts and
                // audit writes. It should stay near zero; if it does not, the
                // bottleneck is host-core itself rather than the user or the model.
                let total_ms = call_started.elapsed().as_millis() as u64;
                let overhead_ms =
                    total_ms.saturating_sub(permission_wait_ms.saturating_add(result.duration_ms));
                let mut execute_audit = json!({
                    "toolName": p.tool_name,
                    "toolCallId": p.tool_call_id,
                    "externalPathPermission": external_path_permission,
                    "ok": result.ok,
                    "durationMs": result.duration_ms,
                    "errorCode": result.error_code,
                    "prompted": prompted,
                    "permissionWaitMs": permission_wait_ms,
                    "overheadMs": overhead_ms,
                    "totalMs": total_ms
                });
                if let Some(shell_id) = result.command_shell_id.as_deref() {
                    execute_audit["commandShellId"] = json!(shell_id);
                }
                let _ = audit::append(&st.db, "tool_execute", Some(&p.session_id), execute_audit);

                serde_json::to_value(result).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
            }
            .await;
            clear_bash_cancellation(state, &p).await;
            outcome
        }

        "tools.abort" => {
            let session_id = params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let tool_call_id = params
                .get("toolCallId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "toolCallId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let permission_found = st.cancel_pending_permission(session_id, tool_call_id);
            let (process_found, queued) = st.abort_or_queue_bash(session_id, tool_call_id);
            let found = process_found || permission_found;
            Ok(json!({
                "ok": true,
                "found": found,
                "queued": queued,
                "aborted": found || queued
            }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
