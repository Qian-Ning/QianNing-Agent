mod artifacts_rpc;
mod command_shells_rpc;
mod computer_rpc;
mod computer_tool;
mod config_sync_rpc;
mod connection_rpc;
mod connection_tool;
mod keyboard_rpc;
mod market_rpc;
mod prompt_preset_rpc;
mod providers_rpc;
mod scheduled_rpc;
mod scheduled_tools;
mod skills_rpc;

use std::io::{self, BufRead, BufReader as StdBufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};

use crate::agent_capabilities::CapabilityLevel;
use crate::artifacts;
use crate::audit;
use crate::notifications;
use crate::permissions::{PermissionDecision, PermissionEvaluationParams, PermissionManager};
use crate::plans;
use crate::plugin_sessions;
use crate::plugin_usage;
use crate::providers;
use crate::review;
use crate::scratch;
use crate::sessions::{self, UiMessage};
use crate::state::{AppState, HOST_VERSION, PROTOCOL_VERSION};
use crate::tools::{self, ToolsExecuteParams};
use crate::transcripts::CompactionRecord;
use crate::turn_queue;
use crate::workspace;

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification {
    jsonrpc: &'static str,
    method: String,
    params: Value,
}

#[derive(Debug)]
enum StdinEvent {
    Line(String),
    Oversize { id: Value },
    Error(String),
}

/// Best-effort JSON-RPC id from a possibly truncated NDJSON prefix.
///
/// Electron matches host replies by id. A `LIMIT_EXCEEDED` reply with a null
/// id is treated as a notification and the caller waits out the 130 s deadline.
fn peek_jsonrpc_id(prefix: &str) -> Value {
    let window = prefix.get(..prefix.len().min(2048)).unwrap_or(prefix);
    if let Ok(value) = serde_json::from_str::<Value>(window) {
        return value.get("id").cloned().unwrap_or(Value::Null);
    }
    let bytes = window.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if &bytes[i..i + 4] != b"\"id\"" {
            i += 1;
            continue;
        }
        let mut j = i + 4;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b':' {
            i += 1;
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() {
            return Value::Null;
        }
        if bytes[j] == b'"' {
            j += 1;
            let start = j;
            while j < bytes.len() {
                if bytes[j] == b'\\' {
                    j = (j + 2).min(bytes.len());
                    continue;
                }
                if bytes[j] == b'"' {
                    return std::str::from_utf8(&bytes[start..j])
                        .map(|text| Value::String(text.to_string()))
                        .unwrap_or(Value::Null);
                }
                j += 1;
            }
            return Value::Null;
        }
        if bytes.get(j..j + 4) == Some(&b"null"[..]) {
            return Value::Null;
        }
        let start = j;
        if bytes[j] == b'-' {
            j += 1;
        }
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > start {
            if let Ok(text) = std::str::from_utf8(&bytes[start..j]) {
                if let Ok(n) = text.parse::<i64>() {
                    return json!(n);
                }
            }
        }
        return Value::Null;
    }
    Value::Null
}

const STDOUT_WRITER_SHUTDOWN: Duration = Duration::from_secs(5);

/// Tokio's stdio adapter delegates every read/write to the blocking pool. If
/// the OS temporarily refuses another worker thread, Tokio panics instead of
/// returning an error. The host's control pipe must not share that failure
/// mode, so it uses two fixed, explicitly named threads instead.
fn is_transient_io_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
    ) || matches!(error.raw_os_error(), Some(11) | Some(35))
}

/// Largest single NDJSON request line the host accepts. A Write payload of a
/// few megabytes fits comfortably; anything past this is a framing fault, not
/// a request, and must not be buffered into memory line by line.
const MAX_STDIN_LINE_BYTES: u64 = 64 * 1024 * 1024;

fn spawn_stdin_reader(tx: mpsc::UnboundedSender<StdinEvent>) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("pi-host-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut reader = StdBufReader::new(stdin.lock());
            let mut line = String::new();

            loop {
                let read = (&mut reader)
                    .take(MAX_STDIN_LINE_BYTES + 1)
                    .read_line(&mut line);
                match read {
                    Ok(0) => break,
                    Ok(_) if line.len() as u64 > MAX_STDIN_LINE_BYTES => {
                        // Drain the rest of this NDJSON record so a too-large
                        // replaceMessages cannot kill the control pipe. The
                        // serve loop answers LIMIT_EXCEEDED and keeps running.
                        if !line.ends_with('\n') {
                            let mut discard = [0u8; 8192];
                            loop {
                                match reader.read(&mut discard) {
                                    Ok(0) => break,
                                    Ok(n) if discard[..n].contains(&b'\n') => break,
                                    Ok(_) => {}
                                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                                        continue;
                                    }
                                    Err(error) if is_transient_io_error(&error) => {
                                        thread::sleep(Duration::from_millis(10));
                                    }
                                    Err(error) => {
                                        let _ = tx.send(StdinEvent::Error(error.to_string()));
                                        return;
                                    }
                                }
                            }
                        }
                        let id = peek_jsonrpc_id(&line);
                        line.clear();
                        if tx.send(StdinEvent::Oversize { id }).is_err() {
                            break;
                        }
                    }

                    Ok(_) => {
                        if tx
                            .send(StdinEvent::Line(std::mem::take(&mut line)))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if is_transient_io_error(&error) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => {
                        let _ = tx.send(StdinEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
        })
}

fn write_stdout_message(writer: &mut impl Write, message: &str) -> io::Result<()> {
    let bytes = message.as_bytes();
    let mut offset = 0;

    while offset < bytes.len() {
        match writer.write(&bytes[offset..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "stdout writer made no progress",
                ));
            }
            Ok(written) => offset += written,
            Err(error) if is_transient_io_error(&error) => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }

    loop {
        match writer.flush() {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_io_error(&error) => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn spawn_stdout_writer(
    mut rx: mpsc::UnboundedReceiver<String>,
    done_tx: oneshot::Sender<Option<String>>,
) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("pi-host-stdout".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut writer = stdout.lock();
            let mut writer_error = None;

            while let Some(message) = rx.blocking_recv() {
                if let Err(error) = write_stdout_message(&mut writer, &message) {
                    writer_error = Some(error.to_string());
                    break;
                }
            }

            let _ = done_tx.send(writer_error);
        })
}

pub async fn serve(state: Arc<Mutex<AppState>>) -> Result<()> {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    // Keep request tasks bounded as well as tool executions. Tool calls have
    // their own class/session budgets below; this cap protects the host from
    // non-tool RPC bursts and prevents an unbounded tokio task fan-out.
    const MAX_IN_FLIGHT_RPC: usize = 32;
    let request_slots = Arc::new(Semaphore::new(MAX_IN_FLIGHT_RPC));
    let mut request_tasks = tokio::task::JoinSet::new();

    // Keep stdio off Tokio's blocking pool. Under process/thread pressure,
    // Tokio's stdio adapter can panic while trying to create a worker thread;
    // these two dedicated threads instead report startup errors or stop on a
    // closed pipe without taking down the async request dispatcher.
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<Option<String>>();
    let _writer = spawn_stdout_writer(rx, writer_done_tx)
        .map_err(|error| anyhow!("host stdout writer unavailable: {error}"))?;
    // Electron's RegisterHotKey cannot claim Windows' Alt+Space system-menu
    // chord. Keep the native fallback beside the host transport so it remains
    // active even when PI-Desktop is unfocused.
    crate::keyboard::start(tx.clone());
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<StdinEvent>();
    let _stdin_reader = match spawn_stdin_reader(input_tx) {
        Ok(handle) => handle,
        Err(error) => {
            drop(tx);
            let _ = writer_done_rx.await;
            return Err(anyhow!("host stdin reader unavailable: {error}"));
        }
    };
    let config_sync_scheduler = tokio::spawn({
        let state = state.clone();
        let tx = tx.clone();
        async move {
            // The host owns a short local debounce clock; remote polling is
            // gated inside the engine to five minutes when no local change is
            // pending. This lets a quiet app settle filesystem edits without
            // turning every tick into a WebDAV request.
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let _ =
                    crate::config_sync::engine::sync_if_enabled(state.clone(), tx.clone()).await;
            }
        }
    });

    let mut input_error = None;
    let mut writer_done = false;
    'serve: loop {
        tokio::select! {
            event = input_rx.recv() => {
                let Some(event) = event else {
                    break 'serve;
                };
                let line = match event {
                    StdinEvent::Line(line) => line,
                    StdinEvent::Oversize { id } => {
                        let response = JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(rpc_err(
                                1002,
                                "request line exceeds 64 MiB",
                                "LIMIT_EXCEEDED",
                            )),
                        };
                        if let Ok(raw) = serde_json::to_string(&response) {
                            let _ = tx.send(format!("{raw}\n"));
                        }
                        continue 'serve;
                    }
                    StdinEvent::Error(error) => {
                        input_error = Some(format!("host stdin read failed: {error}"));
                        break 'serve;
                    }
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue 'serve;
                }

                let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
                    Err(e) => {
                        let resp = JsonRpcResponse {
                            jsonrpc: "2.0",
                            id: Value::Null,
                            result: None,
                            error: Some(JsonRpcError {
                                code: -32700,
                                message: format!("parse error: {e}"),
                                data: None,
                            }),
                        };
                        let _ = tx.send(format!("{}\n", serde_json::to_string(&resp)?));
                        continue 'serve;
                    }
                };

                if req.id.is_none() {
                    continue 'serve;
                }

                let id = req.id.clone().unwrap_or(Value::Null);
                let method = req.method.clone();
                let params = req.params.unwrap_or(json!({}));
                let state = state.clone();
                let tx = tx.clone();
                let permit = match request_slots.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let response = JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(rpc_err(
                                -32029,
                                "host RPC capacity is exhausted",
                                "HOST_OVERLOADED",
                            )),
                        };
                        if let Ok(raw) = serde_json::to_string(&response) {
                            let _ = tx.send(format!("{raw}\n"));
                        }
                        continue 'serve;
                    }
                };

                request_tasks.spawn(async move {
                    let _permit = permit;
                    let out = match handle_request(state, &method, params, tx.clone()).await {
                        Ok(result) => JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: Some(result),
                            error: None,
                        },
                        Err(err) => JsonRpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(err),
                        },
                    };
                    if let Ok(raw) = serde_json::to_string(&out) {
                        let _ = tx.send(format!("{raw}\n"));
                    }
                });
            }
            result = &mut writer_done_rx => {
                writer_done = true;
                input_error = match result {
                    Ok(Some(error)) => Some(format!("host stdout write failed: {error}")),
                    Ok(None) => Some("host stdout writer stopped".to_string()),
                    Err(_) => Some("host stdout writer status unavailable".to_string()),
                };
                break 'serve;
            }
            completed = request_tasks.join_next(), if !request_tasks.is_empty() => {
                if let Some(Err(error)) = completed {
                    tracing::warn!(error = %error, "RPC request task failed");
                }
            }
        }
    }

    config_sync_scheduler.abort();
    let _ = config_sync_scheduler.await;
    {
        let mut st = state.lock().await;
        st.shutdown();
    }
    while let Some(result) = request_tasks.join_next().await {
        if let Err(error) = result {
            tracing::warn!(error = %error, "RPC request task failed during shutdown");
        }
    }
    drop(tx);
    if !writer_done {
        input_error = match tokio::time::timeout(STDOUT_WRITER_SHUTDOWN, writer_done_rx).await {
            Ok(Ok(Some(error))) => Some(format!("host stdout write failed: {error}")),
            Ok(Ok(None)) => input_error,
            Ok(Err(_)) => Some("host stdout writer status unavailable".to_string()),
            Err(_) => {
                tracing::warn!("host stdout writer did not stop after stdin closed");
                input_error.or_else(|| {
                    Some("host stdout writer did not stop after stdin closed".to_string())
                })
            }
        };
    }
    input_error
        .map(|error| Err(anyhow!("{error}")))
        .unwrap_or(Ok(()))
}

fn rpc_err(code: i64, message: impl Into<String>, error_code: &str) -> JsonRpcError {
    JsonRpcError {
        code,
        message: message.into(),
        data: Some(json!({ "errorCode": error_code })),
    }
}

fn config_sync_rpc_err(error: impl ToString) -> JsonRpcError {
    let message = error.to_string();
    let error_code = message
        .split_once(':')
        .map(|(code, _)| code.trim())
        .unwrap_or("INTERNAL")
        .to_string();
    let code = match error_code.as_str() {
        "CONFIG_SYNC_INVALID" | "CONFIG_SYNC_LIMIT_EXCEEDED" => 1002,
        "CONFIG_SYNC_LOCKED" => 1001,
        "CONFIG_SYNC_CONFLICT" => 1008,
        "CONFIG_SYNC_UNSUPPORTED" => 1002,
        "CONFIG_SYNC_SECURITY" => 1003,
        "CONFIG_SYNC_CRYPTO" | "CONFIG_SYNC_MAPPING_REQUIRED" => 1002,
        "CONFIG_SYNC_REMOTE" => 1000,
        _ => 1000,
    };
    rpc_err(code, message, &error_code)
}

fn provider_rpc_err(error: impl ToString) -> JsonRpcError {
    let message = error.to_string();
    for error_code in ["MODEL_ALIAS_TOO_LONG", "MODEL_BINDINGS_DEGRADED"] {
        if message.starts_with(&format!("{error_code}:")) {
            return rpc_err(1002, message, error_code);
        }
    }
    rpc_err(1000, message, "INTERNAL")
}

fn session_collaboration_rpc_err(error: impl ToString) -> JsonRpcError {
    let message = error.to_string();
    let code = message.split(':').next().unwrap_or("INTERNAL").trim();
    let rpc_code = match code {
        "INVALID_ARGUMENT" | "INVALID_PARAMS" | "LIMIT_EXCEEDED" => 1002,
        "PERMISSION_DENIED" => 1003,
        "NOT_FOUND" => 1007,
        "CONFLICT" | "IDEMPOTENCY_CONFLICT" | "AGENT_BUSY" => 1008,
        _ => return rpc_err(1000, message, "INTERNAL"),
    };
    rpc_err(rpc_code, message.clone(), code)
}

fn plugin_session_rpc_err(error: impl ToString) -> JsonRpcError {
    let message = error.to_string();
    let code = message
        .split_once(':')
        .map(|(code, _)| code.to_string())
        .unwrap_or_else(|| "INTERNAL".to_string());
    let rpc_code = match code.as_str() {
        "INVALID_PARAMS" | "LIMIT_EXCEEDED" => 1002,
        "NOT_FOUND" => 1007,
        "CONFLICT" => 1008,
        "RATE_LIMITED" => 1006,
        _ => 1000,
    };
    rpc_err(rpc_code, message, &code)
}

/// Parse the optional session thinking selector at the RPC boundary.  A
/// missing/null value keeps the backwards-compatible default; present values
/// must be strings from the host's allowlist rather than being silently
/// coerced to `off`.
fn thinking_level_param(params: &Value) -> Result<Option<String>, JsonRpcError> {
    let Some(value) = params.get("thinkingLevel") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(level) = value.as_str() else {
        return Err(rpc_err(
            1002,
            "thinkingLevel must be a string",
            "INVALID_PARAMS",
        ));
    };
    if !sessions::is_valid_thinking_level(level) {
        return Err(rpc_err(
            1002,
            format!(
                "thinkingLevel must be one of {}",
                sessions::THINKING_LEVELS.join(", ")
            ),
            "INVALID_PARAMS",
        ));
    }
    Ok(Some(level.to_string()))
}

/// Parse the optional parent session used for permission inheritance. The
/// caller supplies an existing session id, never an arbitrary permission mode;
/// the host resolves the persisted mode while holding its state lock.
fn permission_parent_param(params: &Value) -> Result<Option<String>, JsonRpcError> {
    let Some(value) = params.get("inheritPermissionFromSessionId") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(parent_id) = value.as_str() else {
        return Err(rpc_err(
            1002,
            "inheritPermissionFromSessionId must be a string",
            "INVALID_PARAMS",
        ));
    };
    if parent_id.trim().is_empty() {
        return Err(rpc_err(
            1002,
            "inheritPermissionFromSessionId must not be empty",
            "INVALID_PARAMS",
        ));
    }
    Ok(Some(parent_id.to_string()))
}

/// Drop the per-session files and caches that live outside SQLite. Shared by
/// `session.delete` and `projects.remove` so removing a project cleans up
/// exactly the same side data as deleting one session.
fn drop_session_side_data(st: &AppState, id: &str) {
    scratch::remove_session_dir(&st.data_dir, id);
    review::remove_session(&st.data_dir, id);
    st.hashline.drop_session(id);
}

const DEFAULT_LARGE_PASTE_THRESHOLD: i64 = 600;
const MIN_LARGE_PASTE_THRESHOLD: i64 = 1;
const MAX_LARGE_PASTE_THRESHOLD: i64 = 1_000_000;

/// Monthly spend ceiling for the usage dashboard (D657). A ceiling below one
/// cent cannot be spent against, and one above a hundred million dollars is a
/// typo rather than a budget, so both ends are refused.
const MIN_USAGE_BUDGET_USD: f64 = 0.01;
const MAX_USAGE_BUDGET_USD: f64 = 100_000_000.0;

/// A ceiling is valid when it is absent, null (no ceiling), or a finite
/// number inside the accepted range. Rejects NaN and the infinities, which
/// `serde_json` will parse from `1e999` and which would poison every
/// comparison the dashboard makes.
fn valid_usage_budget_usd(value: &Value) -> bool {
    match value {
        Value::Null => true,
        other => other.as_f64().is_some_and(|usd| {
            usd.is_finite() && (MIN_USAGE_BUDGET_USD..=MAX_USAGE_BUDGET_USD).contains(&usd)
        }),
    }
}

fn normalize_settings_value(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("planApprovalPermissionMode");
        if object.get("defaultMode").and_then(Value::as_str) == Some("chat") {
            object.insert("defaultMode".into(), Value::String("plan".into()));
        }
        let valid_command_shell = object
            .get("defaultCommandShell")
            .and_then(Value::as_str)
            .is_some_and(tools::shell::is_known_shell_id);
        if !valid_command_shell {
            object.insert(
                "defaultCommandShell".into(),
                Value::String(tools::shell::default_shell_id().into()),
            );
        }
        let valid_large_paste_threshold = object
            .get("largePasteThreshold")
            .and_then(Value::as_i64)
            .is_some_and(|threshold| {
                (MIN_LARGE_PASTE_THRESHOLD..=MAX_LARGE_PASTE_THRESHOLD).contains(&threshold)
            });
        if !valid_large_paste_threshold {
            object.insert(
                "largePasteThreshold".into(),
                Value::Number(DEFAULT_LARGE_PASTE_THRESHOLD.into()),
            );
        }
        // The spend ceiling is presentational, so an unusable value is repaired
        // to the canonical shape `{ "monthlyUsd": null }` rather than failing a
        // settings load. `settings.set` rejects the same shapes outright, so a
        // repaired value only ever comes from a store written by another build.
        if let Some(budget) = object.get("usageBudget") {
            let monthly = budget
                .get("monthlyUsd")
                .filter(|usd| valid_usage_budget_usd(usd))
                .cloned()
                .unwrap_or(Value::Null);
            let mut next = serde_json::Map::new();
            next.insert("monthlyUsd".into(), monthly);
            object.insert("usageBudget".into(), Value::Object(next));
        }
        // The network policy replaced three per-feature switches. A section that
        // is present is written back in the shape
        // `packages/shared/src/network-policy.ts` defines: a usable `mode`, plus
        // the one-time notice flag when it is set. Anything unusable falls back
        // to the documented default, `relaxed`; the plaintext flag of a build
        // before the mode existed survives as `strict`, because its `false` was
        // the user's own answer.
        let stored_policy = object
            .get("networkPolicy")
            .filter(|value| !value.is_null())
            .cloned();
        if let Some(stored_policy) = stored_policy {
            let policy = stored_policy.as_object().cloned().unwrap_or_default();
            let mode = match policy.get("mode").and_then(Value::as_str) {
                Some("relaxed") => "relaxed",
                Some("strict") => "strict",
                _ => {
                    if policy.get("allowInsecureUserEndpoints") == Some(&Value::Bool(false)) {
                        "strict"
                    } else {
                        "relaxed"
                    }
                }
            };
            let mut next = serde_json::Map::new();
            next.insert("mode".into(), Value::String(mode.into()));
            if policy.get("insecureNoticeAcknowledged") == Some(&Value::Bool(true)) {
                next.insert("insecureNoticeAcknowledged".into(), Value::Bool(true));
            }
            object.insert("networkPolicy".into(), Value::Object(next));
        }
    }
    value
}

fn merge_settings_value(stored: Option<Value>, incoming: Value) -> Value {
    let Value::Object(incoming) = incoming else {
        return incoming;
    };
    let mut merged = match stored {
        Some(Value::Object(object)) => object,
        _ => serde_json::Map::new(),
    };
    merged.extend(incoming);
    Value::Object(merged)
}

/// Setting keys that hold a generation binding plus its candidate list.
const IMAGE_GENERATION_SETTING_KEYS: [&str; 2] = ["imageGeneration", "imageGenerationModels"];
const VIDEO_GENERATION_SETTING_KEYS: [&str; 2] = ["videoGeneration", "videoGenerationModels"];

/// Drop generation bindings whose provider row is gone.
///
/// `settings.set` merges into the stored object and the shell writes whole
/// snapshots back, so deleting a provider row used to leave `imageGeneration`
/// (and now `videoGeneration`) naming an id that no longer resolves. Every
/// `GenerateImages` and `GenerateVideos` call then
/// answered `IMAGE_MODEL_UNAVAILABLE`, and once the candidate list was empty
/// the settings row that owns the default hid itself, so the binding could
/// neither run nor be repaired from the UI. A binding that cannot resolve is
/// therefore not a preference the store keeps: the active default falls back
/// to "no default" and the candidate list loses that entry, on read and on
/// write alike. A provider that still exists but is disabled or carries no
/// credential keeps its binding — that is a state the user repairs in
/// Settings, and no reference to it is dropped here.
///
/// The same rule config sync already enforces when it applies a bundle
/// (`validate_application_references`), applied to the local settings channel
/// so a stale id cannot be written into or read out of the store.
fn prune_unresolvable_generation_bindings(
    db: &crate::db::Database,
    settings: &mut Value,
    keys: [&str; 2],
) -> Result<bool> {
    let Some(object) = settings.as_object_mut() else {
        return Ok(false);
    };
    let [active_key, list_key] = keys;
    let resolves = |binding: &Value| -> Result<bool> {
        match binding.get("providerId").and_then(Value::as_str) {
            Some(provider_id) => providers::provider_exists(db, provider_id),
            None => Ok(false),
        }
    };
    let mut changed = false;
    let active_is_stale = match object.get(active_key) {
        Some(binding) if !binding.is_null() => !resolves(binding)?,
        _ => false,
    };
    if active_is_stale {
        object.insert(active_key.into(), Value::Null);
        changed = true;
    }
    if let Some(Value::Array(candidates)) = object.get(list_key).cloned() {
        let mut kept = Vec::with_capacity(candidates.len());
        let mut dropped = false;
        for candidate in candidates {
            if resolves(&candidate)? {
                kept.push(candidate);
            } else {
                dropped = true;
            }
        }
        if dropped {
            object.insert(list_key.into(), Value::Array(kept));
            changed = true;
        }
    }
    Ok(changed)
}

/// Bounds and shape a generation binding plus its candidate list.
///
/// One rule for every generation capability: the key names and the model caps
/// differ, the acceptance test does not, so a new kind cannot be validated one
/// way in one branch and another way somewhere else.
fn validate_generation_bindings(
    object: &serde_json::Map<String, Value>,
    keys: [&str; 2],
    label: &str,
    max_models: usize,
) -> Result<(), JsonRpcError> {
    let [active_key, list_key] = keys;
    let fields_valid = |binding: &Value| {
        [("providerId", 128usize), ("modelId", 256usize)]
            .iter()
            .all(|(key, max)| {
                binding
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= *max)
            })
    };
    if let Some(binding) = object.get(active_key).filter(|v| !v.is_null()) {
        if !fields_valid(binding) {
            let message = format!("invalid {label} binding");
            return Err(rpc_err(1002, &message, "INVALID_PARAMS"));
        }
    }
    if let Some(candidates) = object.get(list_key).filter(|v| !v.is_null()) {
        let Some(candidates) = candidates.as_array() else {
            let message = format!("{list_key} must be an array");
            return Err(rpc_err(1002, &message, "INVALID_PARAMS"));
        };
        if candidates.len() > max_models {
            let message = format!("{list_key} contains too many models");
            return Err(rpc_err(1002, &message, "INVALID_PARAMS"));
        }
        for binding in candidates {
            if !fields_valid(binding) {
                let message = format!("invalid {label} candidate");
                return Err(rpc_err(1002, &message, "INVALID_PARAMS"));
            }
        }
    }
    Ok(())
}

fn effective_command_shell_id(settings: Option<&Value>) -> Option<String> {
    let configured = settings
        .and_then(|value| value.get("defaultCommandShell"))
        .and_then(Value::as_str);
    tools::shell::catalog(configured)
        .effective
        .map(|shell| shell.id)
}

fn validate_settings_value(value: &Value) -> Result<(), JsonRpcError> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if let Some(policy) = object.get("networkPolicy").filter(|v| !v.is_null()) {
        let Some(policy) = policy.as_object() else {
            return Err(rpc_err(
                1002,
                "networkPolicy must be an object",
                "INVALID_PARAMS",
            ));
        };
        if policy
            .get("mode")
            .is_some_and(|mode| !matches!(mode.as_str(), Some("relaxed") | Some("strict")))
        {
            return Err(rpc_err(
                1002,
                "networkPolicy.mode must be relaxed or strict",
                "INVALID_PARAMS",
            ));
        }
        if policy
            .get("insecureNoticeAcknowledged")
            .is_some_and(|flag| !flag.is_boolean())
        {
            return Err(rpc_err(
                1002,
                "insecureNoticeAcknowledged must be a boolean",
                "INVALID_PARAMS",
            ));
        }
    }
    validate_generation_bindings(
        object,
        IMAGE_GENERATION_SETTING_KEYS,
        "image generation",
        128,
    )?;
    validate_generation_bindings(
        object,
        VIDEO_GENERATION_SETTING_KEYS,
        "video generation",
        64,
    )?;
    if let Some(preference) = object.get("updatePreference") {
        if !matches!(preference.as_str(), Some("automatic") | Some("manual")) {
            return Err(rpc_err(
                1002,
                "updatePreference must be automatic or manual",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(version) = object.get("lastNotifiedUpdateVersion") {
        let Some(version) = version.as_str() else {
            return Err(rpc_err(
                1002,
                "lastNotifiedUpdateVersion must be a non-empty string",
                "INVALID_PARAMS",
            ));
        };
        if version.trim().is_empty() || version.len() > 128 {
            return Err(rpc_err(
                1002,
                "lastNotifiedUpdateVersion must contain 1 to 128 characters",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(infinite_retry) = object.get("infiniteProviderRetry") {
        if !infinite_retry.is_boolean() {
            return Err(rpc_err(
                1002,
                "infiniteProviderRetry must be a boolean",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(keep_awake) = object.get("keepAwakeWhileRunning") {
        if !keep_awake.is_boolean() {
            return Err(rpc_err(
                1002,
                "keepAwakeWhileRunning must be a boolean",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(threshold_value) = object.get("largePasteThreshold") {
        let Some(threshold) = threshold_value.as_i64() else {
            return Err(rpc_err(
                1002,
                "largePasteThreshold must be an integer",
                "INVALID_PARAMS",
            ));
        };
        if !(MIN_LARGE_PASTE_THRESHOLD..=MAX_LARGE_PASTE_THRESHOLD).contains(&threshold) {
            return Err(rpc_err(
                1002,
                format!(
                    "largePasteThreshold must be between {MIN_LARGE_PASTE_THRESHOLD} and {MAX_LARGE_PASTE_THRESHOLD}"
                ),
                "INVALID_PARAMS",
            ));
        }
    }
    if let Err(message) = crate::network_proxy::validate_network_proxy(value) {
        return Err(rpc_err(1002, message, "INVALID_PARAMS"));
    }
    if let Some(budget) = object.get("usageBudget").filter(|v| !v.is_null()) {
        let Some(budget) = budget.as_object() else {
            return Err(rpc_err(
                1002,
                "usageBudget must be an object",
                "INVALID_PARAMS",
            ));
        };
        if let Some(monthly) = budget.get("monthlyUsd") {
            if !valid_usage_budget_usd(monthly) {
                return Err(rpc_err(
                    1002,
                    "usageBudget.monthlyUsd must be null or a positive amount",
                    "INVALID_PARAMS",
                ));
            }
        }
    }
    let Some(shell_value) = object.get("defaultCommandShell") else {
        return Ok(());
    };
    let Some(shell_id) = shell_value.as_str() else {
        return Err(rpc_err(
            1002,
            "defaultCommandShell must be a supported command shell ID",
            "COMMAND_SHELL_INVALID",
        ));
    };
    if !tools::shell::is_known_shell_id(shell_id) {
        return Err(rpc_err(
            1002,
            format!("unknown command shell ID '{shell_id}'"),
            "COMMAND_SHELL_INVALID",
        ));
    }
    let catalog = tools::shell::catalog(None);
    if !catalog
        .choices
        .iter()
        .any(|choice| choice.id == shell_id && choice.available)
    {
        return Err(rpc_err(
            1002,
            format!("command shell ID '{shell_id}' is unavailable on this platform"),
            "COMMAND_SHELL_INVALID",
        ));
    }
    Ok(())
}

fn gate_default_command_shell_setting(state: &AppState) -> Result<(), JsonRpcError> {
    plans::expire_pending_approvals(&state.db)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let blocked: bool = state
        .db
        .conn()
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM turns WHERE status = 'running'
             ) OR EXISTS(
                 SELECT 1 FROM plan_approvals WHERE status = 'pending'
             ) OR EXISTS(
                 SELECT 1 FROM plan_approvals
                 WHERE execution_state IN ('queued', 'running')
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    if blocked {
        return Err(rpc_err(
            1008,
            "defaultCommandShell can only change while all sessions are idle",
            "PLAN_CONFIGURATION_BLOCKED",
        ));
    }
    Ok(())
}

fn command_shell_catalog(state: &AppState) -> Result<tools::shell::ShellCatalog, JsonRpcError> {
    let settings = state
        .db
        .get_setting("app")
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .unwrap_or_else(|| json!({}));
    let configured_id = settings.get("defaultCommandShell").and_then(Value::as_str);
    Ok(tools::shell::catalog(configured_id))
}

fn shell_failure_result(
    p: &ToolsExecuteParams,
    error_code: &str,
    message: impl Into<String>,
    command_shell_id: Option<String>,
    started: std::time::Instant,
) -> tools::ToolsExecuteResult {
    let message = message.into();
    let mut content = json!({ "error": message, "code": error_code });
    if let Some(shell_id) = command_shell_id.as_deref() {
        content["commandShellId"] = json!(shell_id);
    }
    tools::ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: false,
        is_error: Some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code: Some(error_code.to_string()),
        command_shell_id,
    }
}

fn shell_changed_result(
    p: &ToolsExecuteParams,
    expected_shell_id: &str,
    expected_shell_dialect: Option<&str>,
    current_shell_id: Option<String>,
    current_shell_dialect: Option<&str>,
    started: std::time::Instant,
) -> tools::ToolsExecuteResult {
    let current = current_shell_id
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let mut result = shell_failure_result(
        p,
        "COMMAND_SHELL_CHANGED",
        format!(
            "command shell changed: expected '{expected_shell_id}', current effective shell is '{current}'"
        ),
        current_shell_id,
        started,
    );
    let mut content = json!({
        "error": result.content["error"],
        "code": "COMMAND_SHELL_CHANGED",
        "expectedCommandShellId": expected_shell_id,
        "commandShellId": current,
    });
    if let Some(expected_shell_dialect) = expected_shell_dialect {
        content["expectedCommandShellDialect"] = json!(expected_shell_dialect);
    }
    if let Some(current_shell_dialect) = current_shell_dialect {
        content["commandShellDialect"] = json!(current_shell_dialect);
    }
    result.content = content;
    result
}

fn plan_rpc_err(error: impl ToString) -> JsonRpcError {
    let message = error.to_string();
    let error_code = message
        .split_whitespace()
        .next()
        .filter(|code| code.starts_with("PLAN_"))
        .unwrap_or("PLAN_INTERNAL")
        .to_string();
    rpc_err(1015, message, &error_code)
}

fn resolve_persisted_project_workspace(
    state: &AppState,
    session_id: &str,
) -> Result<Option<String>, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(detail)) => Ok(detail.summary.project_path),
        // A tool request must name a persisted session: an unknown id never
        // inherits the mutable global workspace.
        Ok(None) => Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND")),
        Err(error) => Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
}

fn resolve_tool_workspace(
    state: &AppState,
    session_id: &str,
) -> Result<Option<String>, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(detail)) => {
            if let Some(project_path) = detail.summary.project_path {
                return Ok(Some(project_path));
            }
            let scratch = scratch::session_dir(&state.data_dir, session_id)
                .ok_or_else(|| rpc_err(1000, "temporary session has an invalid id", "INTERNAL"))?;
            std::fs::create_dir_all(&scratch)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            Ok(Some(scratch.to_string_lossy().into_owned()))
        }
        // A tool request must name a persisted session: an unknown id never
        // inherits the mutable global workspace.
        Ok(None) => Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND")),
        Err(error) => Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
}

/// Select a registered logical-project root for an absolute tool path.
///
/// The active workspace remains the session's primary root by default. A path
/// inside another root of the same host-owned project group may use that root
/// as its containment base; arbitrary external paths still follow the normal
/// permission flow and never become group roots implicitly.
fn resolve_tool_workspace_for_call(
    state: &AppState,
    session_id: &str,
    args: &Value,
) -> Result<Option<String>, JsonRpcError> {
    let primary = resolve_tool_workspace(state, session_id)?;
    let Some(primary_path) = primary.as_deref() else {
        return Ok(primary);
    };
    let Some(raw_path) = args.get("path").and_then(Value::as_str) else {
        return Ok(primary);
    };
    if !Path::new(raw_path).is_absolute() {
        return Ok(primary);
    }
    let group = state
        .db
        .project_group_for_path(primary_path)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    // Resolve the spelling before containment. macOS can expose the same
    // directory as `/var` and `/private/var`, while the database stores the
    // canonical spelling. Non-existent leaves are still supported by the
    // workspace resolver's existing-ancestor behavior.
    let comparable_path = workspace::resolve_external_path(Path::new(primary_path), raw_path)
        .unwrap_or_else(|_| PathBuf::from(raw_path));
    if let Some(group) = group {
        if let Some(root) = group.roots.iter().find(|root| {
            workspace::lexically_inside(Path::new(&root.path), &comparable_path.to_string_lossy())
        }) {
            return Ok(Some(root.path.clone()));
        }
    }
    Ok(primary)
}

/// Read/search tools are low risk inside their normal roots, but an explicit
/// path outside both roots is a separate capability. The check is deliberately
/// based on the same resolver used for execution so `..` and symlink escapes
/// cannot avoid the permission card. Scratch paths are recognized lexically
/// before the lazy scratch directory exists.
fn requires_external_path_permission(
    workspace_path: Option<&str>,
    scratch_path: Option<&Path>,
    tool_name: &str,
    args: &Value,
) -> bool {
    if !matches!(tool_name, "Read" | "Glob" | "Grep" | "Write" | "Edit") {
        return false;
    }
    let Some(path) = args.get("path").and_then(Value::as_str) else {
        return false;
    };
    if scratch_path.is_some_and(|root| workspace::lexically_inside(root, path)) {
        return false;
    }
    let Some(workspace_path) = workspace_path else {
        return false;
    };
    matches!(
        workspace::resolve_tool_path(Path::new(workspace_path), scratch_path, path),
        Err(error) if error == "PATH_OUTSIDE_WORKSPACE"
    )
}

/// Plans are owned by the session's persisted project. Unlike the legacy
/// tool compatibility resolver, a plan submission never inherits the mutable
/// global workspace or accepts a session-less request.
fn resolve_plan_workspace(state: &AppState, session_id: &str) -> Result<PathBuf, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(_)) => {}
        Ok(None) => return Err(plan_rpc_err("PLAN_SESSION_NOT_FOUND")),
        Err(error) => return Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
    resolve_persisted_project_workspace(state, session_id)?
        .map(PathBuf::from)
        .ok_or_else(|| plan_rpc_err("PLAN_WORKSPACE_REQUIRED"))
}

fn resolve_plan_workspace_if_available(
    state: &AppState,
    session_id: &str,
) -> Result<Option<PathBuf>, JsonRpcError> {
    match sessions::get_session(&state.db, session_id) {
        Ok(Some(_)) => {}
        Ok(None) => return Err(plan_rpc_err("PLAN_SESSION_NOT_FOUND")),
        Err(error) => return Err(rpc_err(1000, error.to_string(), "INTERNAL")),
    }
    Ok(resolve_persisted_project_workspace(state, session_id)?.map(PathBuf::from))
}

/// Push one notification line to the caller's stream.
fn send_notification(tx: &mpsc::UnboundedSender<String>, method: &str, params: Value) {
    let note = JsonRpcNotification {
        jsonrpc: "2.0",
        method: method.to_string(),
        params,
    };
    if let Ok(raw) = serde_json::to_string(&note) {
        let _ = tx.send(format!("{raw}\n"));
    }
}

async fn emit_notification(tx: &mpsc::UnboundedSender<String>, method: &str, params: Value) {
    send_notification(tx, method, params);
}

async fn wait_for_bash_cancellation(
    receiver: &mut Option<tokio::sync::watch::Receiver<bool>>,
) -> bool {
    let Some(receiver) = receiver.as_mut() else {
        return std::future::pending::<bool>().await;
    };
    if *receiver.borrow() {
        return true;
    }
    loop {
        if receiver.changed().await.is_err() {
            return std::future::pending::<bool>().await;
        }
        if *receiver.borrow() {
            return true;
        }
    }
}

fn bash_cancellation_requested(receiver: &Option<tokio::sync::watch::Receiver<bool>>) -> bool {
    receiver.as_ref().is_some_and(|receiver| *receiver.borrow())
}

async fn clear_bash_cancellation(state: &Arc<Mutex<AppState>>, p: &ToolsExecuteParams) {
    if !matches!(
        p.tool_name.as_str(),
        "Bash" | "GenerateImages" | "GenerateVideos"
    ) {
        return;
    }
    let mut st = state.lock().await;
    st.clear_bash_cancellation(&p.session_id, &p.tool_call_id);
}

async fn cancel_pending_permission(state: &Arc<Mutex<AppState>>, p: &ToolsExecuteParams) -> bool {
    let mut st = state.lock().await;
    st.cancel_pending_permission(&p.session_id, &p.tool_call_id)
}

/// Dispatch a `plugin_*` tool to the desktop runner (Electron main), which
/// executes the plugin JS and answers via `plugins.resolveExecution`.
async fn execute_plugin_tool(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    p: &ToolsExecuteParams,
    timeout_ms: u64,
    session_mode: &str,
) -> tools::ToolsExecuteResult {
    let started = std::time::Instant::now();
    let execution_id = uuid::Uuid::new_v4().to_string();
    let (otx, orx) = tokio::sync::oneshot::channel::<Value>();
    {
        let mut st = state.lock().await;
        st.plugin_execs.insert(execution_id.clone(), otx);
    }
    emit_notification(
        tx,
        "plugins.execute",
        json!({
            "executionId": execution_id,
            "sessionId": p.session_id,
            "turnId": p.turn_id,
            "toolCallId": p.tool_call_id,
            "toolName": p.tool_name,
            "args": p.args,
            // Durable session mode, not the sidecar-supplied field: ADR 0052
            // forbids a conflicting sidecar mode from authorizing a tool
            // (ADR 0211).
            "mode": session_mode,
            "planSafeActions": p.plan_safe_actions,
        }),
    )
    .await;

    let outcome = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), orx).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(Ok(resp)) => {
            let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let content = resp.get("content").cloned().unwrap_or(Value::Null);
            let error_code = resp
                .get("errorCode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            tools::ToolsExecuteResult {
                tool_call_id: p.tool_call_id.clone(),
                ok,
                is_error: if ok { None } else { Some(true) },
                content,
                duration_ms,
                denied: None,
                error_code: if ok {
                    None
                } else {
                    Some(error_code.unwrap_or_else(|| "TOOL_FAILED".into()))
                },
                command_shell_id: None,
            }
        }
        _ => {
            let mut st = state.lock().await;
            st.plugin_execs.remove(&execution_id);
            tools::ToolsExecuteResult {
                tool_call_id: p.tool_call_id.clone(),
                ok: false,
                is_error: Some(true),
                content: json!({
                    "error": "plugin tool dispatch timed out or no desktop runner is attached",
                    "code": "TOOL_TIMEOUT"
                }),
                duration_ms,
                denied: None,
                error_code: Some("TOOL_TIMEOUT".into()),
                command_shell_id: None,
            }
        }
    }
}

fn plugin_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("PLUGIN_INVALID") {
        rpc_err(1009, msg, "PLUGIN_INVALID")
    } else if msg.contains("PLUGIN_LOAD_FAILED") {
        rpc_err(1010, msg, "PLUGIN_LOAD_FAILED")
    } else if msg.contains("PLUGIN_INTEGRITY") {
        rpc_err(1012, msg, "PLUGIN_INTEGRITY")
    } else if msg.contains("PLUGIN_PERMISSION_DENIED") {
        rpc_err(1013, msg, "PLUGIN_PERMISSION_DENIED")
    } else if msg.contains("PLUGIN_NOT_FOUND") {
        rpc_err(1003, msg, "NOT_FOUND")
    } else if msg.contains("PLUGIN_CANCELLED") {
        // The user's own action rather than a failure: the surface closes the
        // dialog quietly instead of reporting an error.
        rpc_err(1019, msg, "PLUGIN_CANCELLED")
    } else if msg.contains("PLUGIN_MARKET_NOT_PUBLISHED") {
        // The platform has the version and is not offering it yet: a state to
        // report, not a bug to sweep into INTERNAL.
        rpc_err(1020, msg, "PLUGIN_MARKET_NOT_PUBLISHED")
    } else if msg.contains("PLUGIN_MARKET_ARCHIVED") {
        rpc_err(1021, msg, "PLUGIN_MARKET_ARCHIVED")
    } else if msg.contains("PLUGIN_MARKET_NOT_FOUND") {
        rpc_err(1022, msg, "PLUGIN_MARKET_NOT_FOUND")
    } else if msg.contains("PLUGIN_MARKET_RATE_LIMITED") {
        rpc_err(1023, msg, "PLUGIN_MARKET_RATE_LIMITED")
    } else if msg.contains("PLUGIN_MARKET_NO_SOURCE") {
        rpc_err(1024, msg, "PLUGIN_MARKET_NO_SOURCE")
    } else if msg.contains("PLUGIN_NETWORK") {
        rpc_err(1014, msg, "PLUGIN_NETWORK")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

/// Capability query failures have their own code so callers can distinguish
/// a missing project context from a malformed MCP or skill document.
fn capability_err(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1018, message, "CAPABILITY_INVALID")
}

/// Validation failures from the user-owned MCP registry are the user's typo,
/// not an internal fault, so they get a distinct code the UI can show inline.
fn scope_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("CAPABILITY_INVALID") {
        capability_err(msg)
    } else if msg.contains("MCP_INVALID") {
        rpc_err(1038, msg, "MCP_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

fn skill_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("CAPABILITY_INVALID") {
        capability_err(msg)
    } else if msg.contains("SKILL_INVALID") {
        rpc_err(1016, msg, "SKILL_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

fn subagent_err(err: impl ToString) -> JsonRpcError {
    let msg = err.to_string();
    if msg.contains("SUBAGENT_INVALID") {
        rpc_err(1017, msg, "SUBAGENT_INVALID")
    } else {
        rpc_err(1000, msg, "INTERNAL")
    }
}

/// Read the create/update payload for a user subagent. Absent fields stay absent
/// so `update` can distinguish "unchanged" from "cleared".
fn parse_subagent_input(
    params: &Value,
) -> Result<crate::user_subagents::UserSubagentInput, JsonRpcError> {
    let raw = params
        .get("subagent")
        .cloned()
        .unwrap_or_else(|| params.clone());
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

fn require_id(params: &Value) -> Result<String, JsonRpcError> {
    params
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))
}

/// Read an `ActivationScope` from request params, accepting either a nested
/// `scope` object or the flat `mode`/`projects` pair the renderer sends.
fn parse_scope(params: &Value) -> Result<crate::activation::ActivationScope, JsonRpcError> {
    let raw = match params.get("scope") {
        Some(scope) => scope.clone(),
        None => json!({
            "mode": params.get("mode").cloned().unwrap_or(json!("global")),
            "projects": params.get("projects").cloned().unwrap_or(json!([])),
        }),
    };
    serde_json::from_value(raw).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))
}

fn parse_capability_query(
    params: &Value,
) -> Result<(CapabilityLevel, Option<String>), JsonRpcError> {
    let level = CapabilityLevel::parse(params.get("level").and_then(Value::as_str))
        .map_err(|error| capability_err(error.to_string()))?;
    let project_path = params
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        return Err(capability_err(
            "projectPath required for project capability queries",
        ));
    }
    Ok((level, project_path))
}

/// Read one end of a move from a nested `{ level, projectPath }` object.
///
/// A move names two directories at once, so unlike the single-level queries it
/// reads a named key instead of the flat params, and the two ends can never be
/// confused for each other. `level` must be present and a string: defaulting a
/// missing or non-string level to `global` would silently write a capability
/// into the wrong directory, so it is rejected as invalid params instead.
fn parse_capability_target(
    params: &Value,
    key: &str,
) -> Result<crate::agent_capabilities::CapabilityTarget, JsonRpcError> {
    let source = params
        .get(key)
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))?;
    let level = match source.get("level") {
        Some(Value::String(level)) => CapabilityLevel::parse(Some(level))
            .map_err(|error| capability_err(error.to_string()))?,
        _ => {
            return Err(rpc_err(
                1002,
                format!("{key}.level must be 'global' or 'project'"),
                "INVALID_PARAMS",
            ))
        }
    };
    let project_path = source
        .get("projectPath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty());
    crate::agent_capabilities::CapabilityTarget::new(level, project_path.as_deref())
        .map_err(|error| capability_err(error.to_string()))
}

async fn handle_request(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    if method != "app.handshake" {
        let st = state.lock().await;
        if !st.handshook {
            return Err(rpc_err(1001, "handshake required", "UNAUTHORIZED"));
        }
        if st.shutting_down {
            return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
        }
    }

    if method.starts_with("configSync.") {
        return config_sync_rpc::handle(state, method, params, tx)
            .await
            .map_err(config_sync_rpc_err);
    }

    match method {
        method if method.starts_with("session.collaboration.") => {
            let st = state.lock().await;
            crate::session_collaboration::handle(&st.db, method, &params)
                .map_err(session_collaboration_rpc_err)
        }
        "app.handshake" => {
            let client_version = params
                .get("protocolVersion")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            if client_version != PROTOCOL_VERSION {
                return Err(rpc_err(
                    1011,
                    format!("protocol mismatch: client={client_version} host={PROTOCOL_VERSION}"),
                    "PROTOCOL_MISMATCH",
                ));
            }
            let mut st = state.lock().await;
            st.handshook = true;
            // Restore the current workspace from kv → projects.
            if let Ok(Some(pid)) = st.db.kv_get("app", "currentProjectId") {
                let pid = pid
                    .as_i64()
                    .or_else(|| pid.as_str().and_then(|s| s.parse::<i64>().ok()));
                if let Some(pid) = pid {
                    if let Ok(Some(path)) = st.db.project_path(pid) {
                        if !path.is_empty() {
                            st.workspace.set(PathBuf::from(path));
                        }
                    }
                }
            }
            Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "version": HOST_VERSION,
                "capabilities": [
                    "tools", "sessions", "providers", "secrets", "plugins", "permissions",
                    "scheduled", "artifacts", "plans", "search", "turns", "notifications"
                ]
            }))
        }
        "app.health" => {
            let st = state.lock().await;
            let budget = st.tool_budget.snapshot();
            Ok(json!({
                "ok": true,
                "protocolVersion": PROTOCOL_VERSION,
                "version": HOST_VERSION,
                "uptimeMs": st.uptime_ms(),
                "toolBudget": {
                    "active": budget.active,
                    "queued": budget.queued,
                    "total": budget.total,
                    "shell": budget.shell,
                    "reads": budget.reads,
                    "mutations": budget.mutations,
                    "plugins": budget.plugins
                }
            }))
        }
        method if method.starts_with("keyboard.") => {
            return keyboard_rpc::handle(&state, method, params).await;
        }

        "app.getVersion" => Ok(json!({
            "name": "pi-desktop-host-core",
            "version": HOST_VERSION,
            "protocolVersion": PROTOCOL_VERSION
        })),

        "workspace.get" => {
            let st = state.lock().await;
            Ok(json!({ "workspace": st.workspace.get() }))
        }
        "projects.list" => {
            let st = state.lock().await;
            let projects = st
                .db
                .list_projects()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "projects": projects }))
        }
        "project.groups.list" => {
            let st = state.lock().await;
            let groups = st
                .db
                .list_project_groups()
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "groups": groups }))
        }
        "project.group.create" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let folders = params
                .get("folders")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_err(1002, "folders required", "INVALID_PARAMS"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let st = state.lock().await;
            let group = st
                .db
                .create_project_group(name, &folders)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.update" => {
            let group_id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let folders = params
                .get("folders")
                .and_then(Value::as_array)
                .ok_or_else(|| rpc_err(1002, "folders required", "INVALID_PARAMS"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let st = state.lock().await;
            let group = st
                .db
                .update_project_group(group_id, name, &folders)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.rename" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "name required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let group = st
                .db
                .rename_project_group(id, name)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "group": group }))
        }
        "project.group.memory.get" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .get_project_group_memory(id)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.group.memory.set" => {
            let id = params
                .get("groupId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "groupId required", "INVALID_PARAMS"))?;
            let entries = params
                .get("entries")
                .ok_or_else(|| rpc_err(1002, "entries required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .set_project_group_memory(id, entries)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.group.context" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let context = st
                .db
                .project_group_context_for_path(path)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "context": context }))
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
        "project.memory.get" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let memory = st
                .db
                .get_project_memory(path)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
        }
        "project.memory.set" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            if let Some(entries) = params.get("entries") {
                let memory = st
                    .db
                    .set_project_memory_entries(path, entries)
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
                return Ok(json!({ "memory": memory }));
            }
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "content required", "INVALID_PARAMS"))?;
            let memory = st
                .db
                .set_project_memory(path, content)
                .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            Ok(json!({ "memory": memory }))
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
        "workspace.clear" => {
            let mut st = state.lock().await;
            st.hashline.drop_all();
            st.workspace.clear();
            st.db
                .kv_delete("app", "currentProjectId")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "review.rollback" => {
            let session_id = params
                .get("sessionId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
            let snapshot_id = params
                .get("snapshotId")
                .and_then(|value| value.as_str())
                .ok_or_else(|| rpc_err(1002, "snapshotId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let workspace_root = resolve_tool_workspace(&st, session_id)?;
            let outcome = review::rollback_change(
                &st.data_dir,
                session_id,
                snapshot_id,
                workspace_root.as_deref().map(std::path::Path::new),
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            if matches!(outcome.status, "rolledBack" | "alreadyRolledBack") {
                if let Some(root) = workspace_root.as_deref() {
                    let resolved = std::path::Path::new(root).join(&outcome.path);
                    st.hashline.invalidate_path(
                        session_id,
                        &crate::tools::hashline::canonical_key(&resolved),
                    );
                }
                sessions::update_tool_review_state(
                    &st.db,
                    session_id,
                    &outcome.message_id,
                    snapshot_id,
                    "rolledBack",
                )
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            }
            Ok(serde_json::to_value(outcome)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)
        }

        "settings.get" => {
            let st = state.lock().await;
            let stored = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // A brand-new install follows the OS theme. Dark is still the
            // palette the shell is designed around, but a fresh install on a
            // light desktop must not open dark: "system" resolves against the
            // OS at paint time (useAppShellRuntime), so the first launch
            // matches the machine it was installed on.
            let mut settings = normalize_settings_value(stored.unwrap_or_else(|| {
                json!({
                    "defaultMode": "agent",
                    "defaultCommandShell": tools::shell::default_shell_id(),
                    "theme": "system",
                    "enterToSend": true,
                    "largePasteThreshold": DEFAULT_LARGE_PASTE_THRESHOLD,
                    "contextCompaction": {
                        "enabled": true,
                        "reserveTokens": 16384,
                        "keepRecentTokens": 20000
                    },
                    "onboardingDismissed": false
                })
            }));
            // Repair on read: a binding whose provider row is already gone —
            // deleted by a build that did not prune, an uninstalled plugin, or
            // synced bundle — is dropped here and the store is corrected, so
            // the shell never presents a default the runtime must reject.
            let pruned_images = prune_unresolvable_generation_bindings(
                &st.db,
                &mut settings,
                IMAGE_GENERATION_SETTING_KEYS,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let pruned_videos = prune_unresolvable_generation_bindings(
                &st.db,
                &mut settings,
                VIDEO_GENERATION_SETTING_KEYS,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if pruned_images || pruned_videos {
                st.db
                    .set_setting("app", &settings)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            Ok(settings)
        }
        "settings.set" => {
            validate_settings_value(&params)?;
            let mut st = state.lock().await;
            let stored = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let incoming_shell = params.get("defaultCommandShell").and_then(Value::as_str);
            let current_effective_shell = effective_command_shell_id(stored.as_ref());
            if incoming_shell.is_some_and(|shell| current_effective_shell.as_deref() != Some(shell))
            {
                gate_default_command_shell_setting(&st)?;
            }
            let mut settings = normalize_settings_value(merge_settings_value(stored, params));
            for keys in [IMAGE_GENERATION_SETTING_KEYS, VIDEO_GENERATION_SETTING_KEYS] {
                prune_unresolvable_generation_bindings(&st.db, &mut settings, keys)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            st.db
                .set_setting("app", &settings)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // Re-pin the marketplace channel in memory. Fetching here would hold
            // the state lock behind a remote timeout, so the renderer triggers
            // `market.refresh` after switching channels.
            let (channel, custom_url) =
                crate::plugins::market_channel_from_settings(Some(&settings));
            st.plugins.set_market_channel(channel, custom_url);
            // A concrete app language pins the plugin display locale here, so a
            // shell that only writes settings still gets localized plugin rows.
            // `auto` is resolved by the shell and pushed through
            // `plugins.setLocale`.
            if let Some(language) = settings.get("language").and_then(Value::as_str) {
                if language != "auto" {
                    st.plugins.set_locale(language);
                }
            }
            crate::network_proxy::apply_from_settings(Some(&settings));
            crate::network_policy::apply_from_settings(Some(&settings));
            Ok(json!({ "ok": true }))
        }

        method if method.starts_with("commandShells.") => {
            return command_shells_rpc::handle(&state, method, params).await;
        }

        "secrets.set" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let value = params
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "value required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let backend = st
                .secrets
                .set(secret_ref, value)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true, "backend": backend }))
        }
        "secrets.delete" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            st.secrets
                .delete(secret_ref)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "secrets.has" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            Ok(json!({ "has": st.secrets.has(secret_ref) }))
        }
        "secrets.getForRuntime" => {
            let secret_ref = params
                .get("secretRef")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "secretRef required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let value = st
                .secrets
                .get(secret_ref)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "value": value }))
        }

        method if method.starts_with("providers.") => {
            providers_rpc::handle(&state, method, params).await
        }

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
        method if method.starts_with("promptPreset.") => {
            return prompt_preset_rpc::handle(&state, method, params).await;
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
        "plugin.session.import" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            if !st.allow_plugin_import(plugin_id, false) {
                return Err(rpc_err(1006, "plugin import rate exceeded", "RATE_LIMITED"));
            }
            let result = plugin_sessions::import(&st.db, plugin_id, &params)
                .map_err(plugin_session_rpc_err)?;
            Ok(result)
        }
        "plugin.session.importBatch" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            if !st.allow_plugin_import(plugin_id, true) {
                return Err(rpc_err(
                    1006,
                    "plugin batch import rate exceeded",
                    "RATE_LIMITED",
                ));
            }
            let result = plugin_sessions::import_batch(&st.db, plugin_id, &params)
                .map_err(plugin_session_rpc_err)?;
            Ok(result)
        }
        "plugin.session.list" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::list(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }
        "plugin.session.get" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::get(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }
        "plugin.session.listMessages" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::list_messages(&st.db, plugin_id, &params)
                .map_err(plugin_session_rpc_err)
        }
        "plugin.session.rename" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            plugin_sessions::rename(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }
        "plugin.session.delete" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            if !st.allow_plugin_delete(plugin_id) {
                return Err(rpc_err(1006, "plugin delete rate exceeded", "RATE_LIMITED"));
            }
            plugin_sessions::delete(&st.db, plugin_id, &params).map_err(plugin_session_rpc_err)
        }

        // Plugin usage is a read-only facts domain: a keyset page of completed
        // turns from non-deleted sessions, served to plugins that hold
        // `usage.read` (checked in Electron main before dispatch). The payload
        // carries counters and titles — never a message body — and Electron
        // main remains the only caller that can supply pluginId.
        "plugin.usage.listTurns" => {
            let plugin_id = params
                .get("pluginId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let page =
                plugin_usage::list_turns_page(&st.db, &params).map_err(plugin_session_rpc_err)?;
            tracing::debug!(
                method = "plugin.usage.listTurns",
                plugin_id,
                count = page["turns"].as_array().map(Vec::len).unwrap_or(0),
                "plugin usage rpc served"
            );
            Ok(page)
        }

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

        "notification.list" => {
            let unread_only = params
                .get("unreadOnly")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let limit = params
                .get("limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(crate::db::NOTIFICATION_KEEP);
            let st = state.lock().await;
            let (notifications, unread_count) = notifications::list(&st.db, unread_only, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "notifications": notifications,
                "unreadCount": unread_count
            }))
        }
        "notification.markRead" => {
            let id = params
                .get("id")
                .and_then(|value| value.as_str())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let ok = notifications::mark_read(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "notification.markAllRead" => {
            let st = state.lock().await;
            notifications::mark_all_read(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }
        "notification.clear" => {
            let st = state.lock().await;
            notifications::clear(&st.db).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": true }))
        }

        "search.sessions" => {
            let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if query.chars().count() > 500 {
                return Err(rpc_err(
                    1001,
                    "query exceeds 500 characters",
                    "INVALID_ARGUMENT",
                ));
            }
            let offset = params.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);
            let st = state.lock().await;
            let page = crate::session_search::search(&st.db, query, offset)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!(page))
        }
        "search.context" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let message_id = params
                .get("messageId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let direction = params
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("around");
            if session_id.is_empty()
                || message_id.is_empty()
                || query.chars().count() > 500
                || !matches!(direction, "around" | "before" | "after")
            {
                return Err(rpc_err(1001, "invalid search context", "INVALID_ARGUMENT"));
            }
            let st = state.lock().await;
            let context =
                crate::session_search::context(&st.db, session_id, message_id, direction, query)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                    .ok_or_else(|| rpc_err(1007, "message not found", "NOT_FOUND"))?;
            Ok(json!(context))
        }

        "search.query" => {
            let query = params
                .get("query")
                .or_else(|| params.get("q"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(20);
            let st = state.lock().await;
            let hits = sessions::search_messages(&st.db, query, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "hits": hits }))
        }

        "stats.getTokenUsageHistory" => {
            let bucket = params
                .get("bucket")
                .and_then(|v| v.as_str())
                .unwrap_or("day");

            let st = state.lock().await;
            let history = sessions::get_token_usage_history(
                &st.db,
                params.get("startDate").and_then(|v| v.as_i64()),
                params.get("endDate").and_then(|v| v.as_i64()),
                bucket,
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(history)
        }

        "stats.getUsageBreakdown" => {
            let st = state.lock().await;
            let breakdown = sessions::get_usage_breakdown(
                &st.db,
                params.get("startDate").and_then(|v| v.as_i64()),
                params.get("endDate").and_then(|v| v.as_i64()),
                params.get("providerId").and_then(|v| v.as_str()),
                params.get("modelId").and_then(|v| v.as_str()),
                params
                    .get("recentLimit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(100),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(breakdown)
        }

        "stats.getModelPricing" => {
            let st = state.lock().await;
            let pricing = crate::pricing::list_pricing(st.db.conn())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(pricing)
        }

        "stats.updateModelPricing" => {
            let st = state.lock().await;
            let pricing = crate::pricing::upsert_pricing(st.db.conn(), &params)
                .map_err(|e| rpc_err(1001, e.to_string(), "INVALID_ARGUMENT"))?;
            Ok(pricing)
        }

        "stats.deleteModelPricing" => {
            let model_id = params
                .get("modelId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1001, "modelId is required", "INVALID_ARGUMENT"))?;
            let st = state.lock().await;
            let pricing = crate::pricing::delete_pricing(st.db.conn(), model_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(pricing)
        }

        "stats.resetModelPricing" => {
            let st = state.lock().await;
            let pricing = crate::pricing::reset_defaults(st.db.conn())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(pricing)
        }

        method if method.starts_with("artifacts.") => {
            return artifacts_rpc::handle(&state, method, params).await;
        }

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

        method if method.starts_with("scheduled.") => {
            let st = state.lock().await;
            scheduled_rpc::handle(&st, method, params)
        }

        method if method.starts_with("computer.") => {
            computer_rpc::handle(&state, method, params).await
        }

        method if method.starts_with("connection.") => {
            connection_rpc::handle(&state, method, params).await
        }

        "tools.list" => {
            let mut definitions = tools::builtin_tool_defs();
            if let Some(items) = definitions.as_array_mut() {
                items.extend(scheduled_tools::definitions());
                // Computer is offered only while the user has it switched on;
                // the same gate refuses the call at execute time.
                if computer_rpc::control_enabled(&state).await {
                    items.extend(computer_tool::definitions());
                }
                // Connection is offered only while the user has outbound
                // connections switched on. The listing door and the execution
                // door read the same predicate (D659).
                if connection_rpc::switch_enabled(&state).await {
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
                    let _ = cancel_pending_permission(&state, &p).await;
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
                        let _ = cancel_pending_permission(&state, &p).await;
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
                            let _ = cancel_pending_permission(&state, &p).await;
                            cancelled = true;
                            PermissionDecision::Deny
                        },
                    }
                } else {
                    PermissionDecision::Deny
                };
                cancelled = cancelled || bash_cancellation_requested(&permission_cancellation);
                if cancelled {
                    let _ = cancel_pending_permission(&state, &p).await;
                }
                // Everything up to here is approval: the auto-decision path costs
                // microseconds, the prompt path costs however long the user took.
                let permission_wait_ms = call_started.elapsed().as_millis() as u64;

                if matches!(final_decision, PermissionDecision::Deny) {
                    let _ = cancel_pending_permission(&state, &p).await;
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
                        &state,
                        &tx,
                        &p,
                        tools::desktop_dispatch_timeout_ms(p.timeout_ms),
                        &durable_mode,
                    )
                    .await
                } else if connection_tool::recognizes(&p.tool_name) {
                    // The connection tool awaits inside, so it takes the state
                    // lock itself rather than being handed a held guard.
                    connection_tool::execute(&state, &p).await
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
            clear_bash_cancellation(&state, &p).await;
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

        "permissions.evaluate" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tool_name = params
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let declared_risk = params.get("declaredRisk").and_then(|v| v.as_str());
            let plan_safe_actions: Option<Vec<String>> = params
                .get("planSafeActions")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .filter(|items: &Vec<String>| !items.is_empty());
            let st = state.lock().await;
            let Some(mode) = sessions::session_mode(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            else {
                return Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND"));
            };
            let session_pm = sessions::session_permission_mode(&st.db, session_id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .filter(|value| value != "inherit");
            let effective_pm = session_pm
                .or_else(|| {
                    st.db
                        .get_setting("app")
                        .ok()
                        .flatten()
                        .and_then(|settings| {
                            settings
                                .get("defaultPermissionMode")
                                .and_then(|value| value.as_str())
                                .filter(|value| {
                                    sessions::is_valid_permission_mode(value) && *value != "inherit"
                                })
                                .map(str::to_string)
                        })
                })
                .unwrap_or_else(|| "ask".into());
            let args = params.get("args").cloned().unwrap_or_else(|| json!({}));
            let workspace_path = resolve_tool_workspace_for_call(&st, session_id, &args)?;
            let scratch_path = scratch::session_dir(&st.data_dir, session_id);
            let external_path_permission = requires_external_path_permission(
                workspace_path.as_deref(),
                scratch_path.as_deref(),
                tool_name,
                &args,
            );
            let decision = st
                .permissions
                .evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                    session_id,
                    tool_name,
                    mode: &mode,
                    permission_mode: &effective_pm,
                    session_grants: &st.session_grants,
                    declared_risk,
                    requires_external_path_permission: external_path_permission,
                    plan_safe_actions: plan_safe_actions.as_deref(),
                });
            Ok(json!({
                "decision": decision,
                "risk": PermissionManager::tool_risk_with_declared(tool_name, declared_risk),
                "externalPathPermission": external_path_permission
            }))
        }
        "permissions.resolve" => {
            let request_id = params
                .get("requestId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
            let decision_raw = params
                .get("decision")
                .and_then(|v| v.as_str())
                .unwrap_or("deny");
            let decision = match decision_raw {
                "allow-once" => PermissionDecision::AllowOnce,
                "allow-session" => PermissionDecision::AllowSession,
                _ => PermissionDecision::Deny,
            };
            let mut st = state.lock().await;
            st.resolve_permission(request_id, decision)
                .map_err(|code| {
                    let c = if code == "NOT_FOUND" { 1007 } else { 1000 };
                    rpc_err(c, code.clone(), &code)
                })?;
            Ok(json!({ "ok": true }))
        }
        "permissions.listSessionGrants" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let st = state.lock().await;
            Ok(json!({
                "grants": st.session_grants.get(session_id).cloned().unwrap_or_default()
            }))
        }
        "permissions.clearSessionGrants" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut st = state.lock().await;
            st.session_grants.remove(session_id);
            Ok(json!({ "ok": true }))
        }
        "permissions.pending" => {
            // Pending requests are Host state (D374/D375): a client that
            // attaches after `permissions.request` was emitted reads the open
            // set here and answers through the unchanged `permissions.resolve`.
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let st = state.lock().await;
            Ok(json!({ "requests": st.permissions.pending_requests(session_id) }))
        }

        "plugins.setLocale" => {
            // The desktop shell owns the app language — `settings.language`, or
            // the OS locale while that is `auto` — so it pushes the resolved
            // locale here whenever it changes. Rows then read their display
            // strings from the matching `i18n` entry, and a locale change needs
            // no registry rewrite.
            let locale = params.get("locale").and_then(Value::as_str).unwrap_or("");
            let mut st = state.lock().await;
            st.plugins.set_locale(locale);
            Ok(json!({ "ok": true, "locale": st.plugins.locale() }))
        }

        "plugins.list" => {
            let st = state.lock().await;
            Ok(json!({ "plugins": st.plugins.list() }))
        }
        "plugins.resolveExecution" => {
            let execution_id = params
                .get("executionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "executionId required", "INVALID_PARAMS"))?;
            let sender = {
                let mut st = state.lock().await;
                st.plugin_execs.remove(execution_id)
            };
            match sender {
                Some(sender) => {
                    let _ = sender.send(params.clone());
                    Ok(json!({ "ok": true }))
                }
                None => Err(rpc_err(1003, "unknown executionId", "NOT_FOUND")),
            }
        }
        "plugins.loadDev" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st.plugins.load_dev(path).map_err(|e| {
                let msg = e.to_string();
                if msg.contains("PLUGIN_INVALID") {
                    rpc_err(1009, msg, "PLUGIN_INVALID")
                } else {
                    rpc_err(1010, msg, "PLUGIN_LOAD_FAILED")
                }
            })?;
            // A development plugin owns its declared provider rows the same way
            // an installed one does.
            if let Err(error) =
                crate::plugins::reconcile_plugin(&st.db, &st.secrets, &st.plugins, &plugin.id, true)
            {
                tracing::warn!(plugin = %plugin.id, %error, "plugin provider sync failed");
            }
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.enable" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_enabled(id, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if let Some(current) = plugin.as_ref() {
                if let Err(error) = crate::plugins::reconcile_plugin(
                    &st.db,
                    &st.secrets,
                    &st.plugins,
                    &current.id,
                    true,
                ) {
                    tracing::warn!(plugin = %current.id, %error, "plugin provider sync failed");
                }
            }
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.disable" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_enabled(id, false)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            // The declaration still exists, so the rows stay and are turned
            // off: a re-enable restores the credential the user already gave.
            if plugin.is_some() {
                if let Err(error) = crate::plugins::set_plugin_providers_enabled(&st.db, id, false)
                {
                    tracing::warn!(plugin = id, %error, "plugin provider disable failed");
                }
            }
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.uninstall" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let ok = st
                .plugins
                .uninstall(id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if ok {
                if let Err(error) = crate::plugins::remove_plugin_providers(&st.db, &st.secrets, id)
                {
                    tracing::warn!(plugin = id, %error, "plugin provider removal failed");
                }
            }
            Ok(json!({ "ok": ok }))
        }
        "plugins.getPermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let plugin = st.plugins.list().into_iter().find(|p| p.id == id);
            Ok(json!({
                "permissions": plugin.map(|p| p.permissions).unwrap_or_default()
            }))
        }
        "plugins.installFromPath" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_path(
                    path,
                    crate::plugins::InstallOptions {
                        source: "installed".into(),
                        enable,
                        marketplace: None,
                        expected_shasum: None,
                        auto_update: false,
                        granted_permissions: granted,
                    },
                )
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "plugins.installFromPackage" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "path required", "INVALID_PARAMS"))?;
            let enable = params
                .get("enable")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let granted = params
                .get("grantedPermissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
            let expected_shasum = params
                .get("expectedShasum")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut st = state.lock().await;
            let result = st
                .plugins
                .install_from_package(
                    path,
                    crate::plugins::InstallOptions {
                        source: "installed".into(),
                        enable,
                        marketplace: None,
                        expected_shasum,
                        auto_update: false,
                        granted_permissions: granted,
                    },
                )
                .map_err(plugin_err)?;
            Ok(json!({ "result": result }))
        }
        "plugins.grantPermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let permissions = params
                .get("permissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .grant_permissions(id, permissions)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.revokePermissions" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let permissions = params
                .get("permissions")
                .cloned()
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .revoke_permissions(id, permissions)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.setAutoUpdate" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let enabled = params
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_auto_update(id, enabled)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }
        "plugins.setScope" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let plugin = st
                .plugins
                .set_scope(id, scope)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "plugin": plugin }))
        }

        "mcp.list" => {
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let servers = st
                .mcp_servers
                .list(level, project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            let servers = st.mcp_servers.active_for(project_path).map_err(scope_err)?;
            Ok(json!({ "servers": servers, "statuses": [] }))
        }
        "mcp.upsert" => {
            let input: crate::mcp_servers::McpServerInput =
                serde_json::from_value(params.get("server").cloned().unwrap_or(params.clone()))
                    .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.upsert(input).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.remove" => {
            let id = require_id(&params)?;
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let ok = st
                .mcp_servers
                .remove(&id, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "ok": ok }))
        }
        "mcp.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (level, project_path) = parse_capability_query(&params)?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .set_enabled(&id, enabled, Some(level), project_path.as_deref())
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let server = st.mcp_servers.set_scope(&id, scope).map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }
        "mcp.transfer" => {
            let id = require_id(&params)?;
            let from = parse_capability_target(&params, "from")?;
            let to = parse_capability_target(&params, "to")?;
            let mut st = state.lock().await;
            let server = st
                .mcp_servers
                .transfer(&id, &from, &to)
                .map_err(scope_err)?;
            Ok(json!({ "server": server }))
        }

        method if method.starts_with("skills.") => skills_rpc::handle(&state, method, params).await,

        "agents.list" => {
            let mut st = state.lock().await;
            Ok(json!({ "subagents": st.user_subagents.list().map_err(subagent_err)? }))
        }
        "agents.active" => {
            let project_path = params.get("projectPath").and_then(Value::as_str);
            let mut st = state.lock().await;
            Ok(
                json!({ "subagents": st.user_subagents.active_for(project_path).map_err(subagent_err)? }),
            )
        }
        "agents.create" => {
            let input = parse_subagent_input(&params)?;
            let mut st = state.lock().await;
            let subagent = st.user_subagents.create(input).map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.update" => {
            let id = require_id(&params)?;
            let input = parse_subagent_input(&params)?;
            let mut st = state.lock().await;
            let subagent = st.user_subagents.update(&id, input).map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.read" => {
            let id = require_id(&params)?;
            let mut st = state.lock().await;
            match st.user_subagents.read(&id).map_err(subagent_err)? {
                Some((subagent, body)) => Ok(json!({ "subagent": subagent, "body": body })),
                None => Ok(json!({ "subagent": null, "body": null })),
            }
        }
        "agents.remove" => {
            let id = require_id(&params)?;
            let mut st = state.lock().await;
            let ok = st.user_subagents.remove(&id).map_err(subagent_err)?;
            Ok(json!({ "ok": ok }))
        }
        "agents.setEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut st = state.lock().await;
            let subagent = st
                .user_subagents
                .set_enabled(&id, enabled)
                .map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.setScope" => {
            let id = require_id(&params)?;
            let scope = parse_scope(&params)?;
            let mut st = state.lock().await;
            let subagent = st
                .user_subagents
                .set_scope(&id, scope)
                .map_err(subagent_err)?;
            Ok(json!({ "subagent": subagent }))
        }
        "agents.disabledBuiltins" => {
            let st = state.lock().await;
            Ok(json!({ "disabled": st.user_subagents.disabled_builtins() }))
        }
        "agents.setBuiltinEnabled" => {
            let id = require_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut st = state.lock().await;
            let id = st
                .user_subagents
                .set_builtin_enabled(&id, enabled)
                .map_err(subagent_err)?;
            Ok(json!({ "id": id, "enabled": enabled }))
        }

        method if method.starts_with("market.") => {
            return market_rpc::handle(&state, method, params, tx.clone()).await;
        }

        "app.getOnboarding" => {
            let st = state.lock().await;
            let settings = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or_else(|| json!({}));
            let dismissed = settings
                .get("onboardingDismissed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let providers = providers::list_providers(&st.db, &st.secrets, true)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let has_provider = !providers.is_empty();
            let has_secret = providers.iter().any(|p| p.has_secret);
            let has_project = st.workspace.get().is_some();
            let session_count = sessions::session_count(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            let has_session = session_count > 0;
            let steps = vec![
                json!({"id":"provider","title":"Add a model provider","done": has_provider, "action":"settings.providers"}),
                json!({"id":"secret","title":"Save your API key","done": has_secret, "action":"settings.providers"}),
                json!({"id":"project","title":"Open a project folder","done": has_project, "action":"project.open"}),
                json!({"id":"prompt","title":"Send your first prompt","done": has_session, "action":"chat.focus"}),
                json!({"id":"plugin","title":"Load a development plugin (optional)","done": !st.plugins.list().is_empty(), "action":"plugins.open"}),
            ];
            let critical_incomplete = !has_provider || !has_secret || !has_session;
            Ok(json!({
                "showChecklist": critical_incomplete && !dismissed,
                "steps": steps
            }))
        }

        "audit.append" => {
            let kind = params
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("custom");
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let payload = params.get("payload").cloned().unwrap_or(json!({}));
            let st = state.lock().await;
            audit::append(&st.db, kind, session_id, payload)
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

#[cfg(test)]
mod tests;

#[cfg(test)]
mod image_generation_settings_tests {
    use super::*;
    #[test]
    fn validates_optional_image_binding() {
        for value in [
            json!({}),
            json!({"imageGeneration": null}),
            json!({"imageGeneration": {"providerId": "p", "modelId": "image"}}),
            json!({"imageGenerationModels": null}),
            json!({"imageGenerationModels": []}),
            json!({"imageGenerationModels": [
                {"providerId": "p", "modelId": "image-one"},
                {"providerId": "q", "modelId": "image-two"}
            ]}),
        ] {
            assert!(validate_settings_value(&value).is_ok());
        }
        for value in [
            json!(false),
            json!({}),
            json!({"providerId": "p", "modelId": " "}),
        ] {
            assert!(validate_settings_value(&json!({"imageGeneration": value})).is_err());
        }
        for value in [
            json!(false),
            json!({}),
            json!([{"providerId": "p", "modelId": " "}]),
        ] {
            assert!(validate_settings_value(&json!({"imageGenerationModels": value})).is_err());
        }
    }
}

#[cfg(test)]
mod update_settings_tests {
    use super::*;

    #[test]
    fn validates_update_preference_and_reminder_version() {
        for value in [
            json!({}),
            json!({"updatePreference": "automatic"}),
            json!({"updatePreference": "manual"}),
            json!({"lastNotifiedUpdateVersion": "0.15.9"}),
        ] {
            assert!(validate_settings_value(&value).is_ok(), "{value}");
        }
        for value in [
            json!({"updatePreference": "sometimes"}),
            json!({"updatePreference": null}),
            json!({"lastNotifiedUpdateVersion": "  "}),
            json!({"lastNotifiedUpdateVersion": 12}),
            json!({"lastNotifiedUpdateVersion": "x".repeat(129)}),
        ] {
            assert!(validate_settings_value(&value).is_err(), "{value}");
        }
    }
}
