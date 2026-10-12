mod agents_rpc;
mod artifacts_rpc;
mod audit_rpc;
mod command_shells_rpc;
mod computer_rpc;
mod computer_tool;
mod config_sync_rpc;
mod connection_rpc;
mod connection_tool;
mod keyboard_rpc;
mod market_rpc;
mod mcp_rpc;
mod notification_rpc;
mod permissions_rpc;
mod plans_rpc;
mod plugin_rpc;
mod plugins_rpc;
mod prompt_preset_rpc;
mod providers_rpc;
mod review_rpc;
mod scheduled_rpc;
mod scheduled_tools;
mod search_rpc;
mod secrets_rpc;
mod session_rpc;
mod settings_rpc;
mod skills_rpc;
mod stats_rpc;
mod tools_rpc;

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
use crate::plans;
use crate::providers;
use crate::review;
use crate::scratch;
use crate::sessions;
use crate::state::{AppState, HOST_VERSION, PROTOCOL_VERSION};
use crate::tools::{self, ToolsExecuteParams};
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
        method if method.starts_with("review.") => {
            return review_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("settings.") => {
            return settings_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("commandShells.") => {
            return command_shells_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("secrets.") => {
            return secrets_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("providers.") => {
            providers_rpc::handle(&state, method, params).await
        }

        method if method.starts_with("session.") => {
            return session_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("promptPreset.") => {
            return prompt_preset_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("plugin.") => {
            return plugin_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("notification.") => {
            return notification_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("search.") => {
            return search_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("stats.") => {
            return stats_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("artifacts.") => {
            return artifacts_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("plans.") => {
            return plans_rpc::handle(&state, method, params, tx.clone()).await;
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

        method if method.starts_with("tools.") => {
            return tools_rpc::handle(&state, method, params, tx.clone()).await;
        }

        method if method.starts_with("permissions.") => {
            return permissions_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("plugins.") => {
            return plugins_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("mcp.") => {
            return mcp_rpc::handle(&state, method, params).await;
        }

        method if method.starts_with("skills.") => skills_rpc::handle(&state, method, params).await,

        method if method.starts_with("agents.") => {
            return agents_rpc::handle(&state, method, params).await;
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

        method if method.starts_with("audit.") => {
            return audit_rpc::handle(&state, method, params).await;
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
