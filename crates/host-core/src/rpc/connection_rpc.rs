//! Host RPC methods for the outbound connection layer.
//!
//! Each method is a thin translation: parse the arguments, hand the work to
//! [`crate::connection`], and turn a [`ConnectionError`] into the code a caller
//! branches on.
//!
//! # The three doors
//!
//! One predicate, `settings.remoteControlEnabled && profile.enabled`, is read
//! at three places: here (the Agent-facing method door), `tools.list` (the
//! listing door), and the `tools.execute` dispatch (the execution door). The
//! listing and execution doors live in `rpc/mod.rs` and call
//! [`switch_enabled_in`] — the same function this file calls — because D659's
//! defect class is exactly a listing door and an execution door that drift
//! apart.
//!
//! Every Agent-facing method is behind the switch, with no read exemption.
//! `connection.list` is how a caller learns the inventory and `connection.probe`
//! opens a connection and authenticates, so an "off" that still allowed either
//! would let a caller enumerate the user's hosts and make this machine dial
//! them.
//!
//! # The user door
//!
//! Profile mutation is not behind the switch: it is how a person turns a target
//! on. It is still a privileged mutation — audited, and reachable only through
//! these method names, which no Agent surface can call because the tool
//! vocabulary does not contain them.
//!
//! # Locking
//!
//! Every handler that awaits (probe, exec) takes the state lock, copies out
//! what it needs, and drops the guard before the transport call. Holding the
//! host mutex across a sixty-second network wait would stall every other
//! request in the process.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use super::{json, rpc_err, JsonRpcError, Value};
use crate::connection::store::{self, ConnectionProfile, NewProfile, ProfilePatch};
use crate::connection::{self, params, ssh, ConnectionError, HostKeyPolicy, LastProbe};
use crate::state::AppState;

/// The setting the global switch lives in.
///
/// Reusing the existing app settings blob means no new storage, and a profile
/// that never touched it reads as off.
pub const REMOTE_CONTROL_SETTING: &str = "remoteControlEnabled";

/// The audit kind every row this layer writes carries.
pub const AUDIT_KIND: &str = "connection";

// ---- the predicate ---------------------------------------------------------

/// Whether the global switch is on.
///
/// A store that cannot be read reads as off: the failure mode of an
/// unavailable gate must be closed, never open. This is the same shape as
/// `computer_rpc::control_enabled_in`, and the two are deliberately parallel so
/// that a reader comparing them sees one pattern.
pub(crate) fn switch_enabled_in(st: &AppState) -> bool {
    st.db
        .get_setting("app")
        .ok()
        .flatten()
        .and_then(|settings| {
            settings
                .get(REMOTE_CONTROL_SETTING)
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

/// The same answer for a caller that does not hold the state lock.
pub(crate) async fn switch_enabled(state: &Arc<Mutex<AppState>>) -> bool {
    let st = state.lock().await;
    switch_enabled_in(&st)
}

/// The per-profile half of the predicate.
///
/// The caller must already have established that the global switch is on, so
/// that the two halves stay distinguishable as `1029` and `1031`.
pub(crate) fn require_profile_enabled(profile: &ConnectionProfile) -> Result<(), ConnectionError> {
    if profile.enabled {
        Ok(())
    } else {
        Err(ConnectionError::ProfileDisabled(profile.id.clone()))
    }
}

fn require_switch(st: &AppState) -> Result<(), ConnectionError> {
    if switch_enabled_in(st) {
        Ok(())
    } else {
        Err(ConnectionError::Disabled)
    }
}

// ---- the error envelope ----------------------------------------------------

/// The error this layer answers with.
///
/// The payload fields *add* to the code slug rather than replacing it — the
/// rule `computer_err` established after the seam that made the agent tool
/// answer `INTERNAL` for a failure this door named `1027`. Both keys travel
/// together: `data.errorCode` keeps its documented meaning and the specific
/// fields stay readable beside it.
pub(super) fn connection_err(error: ConnectionError) -> JsonRpcError {
    let message = error.to_string();
    let code = error.code();
    let slug = error.slug();
    let details = error.details();
    let mut reply = rpc_err(code, message, slug);
    for (key, value) in details {
        insert_data(&mut reply, value, key);
    }
    reply
}

/// Add one field beside the code slug `rpc_err` already wrote.
fn insert_data(reply: &mut JsonRpcError, value: Value, key: &str) {
    let data = reply
        .data
        .get_or_insert_with(|| Value::Object(Default::default()));
    match data {
        Value::Object(object) => {
            object.insert(key.to_string(), value);
        }
        other => *other = json!({ key: value }),
    }
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(-32602, message.to_string(), "INVALID_PARAMS")
}

fn internal(error: impl std::fmt::Display) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

/// Restate a validation message as the error shape this layer answers with.
fn require<T>(result: Result<T, String>) -> Result<T, JsonRpcError> {
    result.map_err(|message| invalid(&message))
}

// ---- audit -----------------------------------------------------------------

/// The fields an audit row carries beyond the profile it names.
#[derive(Default)]
struct AuditFacts {
    duration_ms: Option<u64>,
    extra: Value,
}

impl AuditFacts {
    fn with_duration(duration_ms: u64) -> Self {
        Self {
            duration_ms: Some(duration_ms),
            extra: Value::Null,
        }
    }

    fn with_extra(extra: Value) -> Self {
        Self {
            duration_ms: None,
            extra,
        }
    }
}

/// Write one audit row.
///
/// Written for every Agent-facing call — including one the gate refused, so the
/// record shows that something tried — and for every profile mutation. The
/// payload names the profile, the action, the outcome, and the code when there
/// is one. It never carries a credential. `audit::append` bounds and redacts on
/// the way in, so a command line that happens to contain a token cannot land in
/// the log.
fn write_audit(
    st: &AppState,
    profile: Option<&ConnectionProfile>,
    action: &str,
    outcome: &str,
    error: Option<&ConnectionError>,
    facts: AuditFacts,
) {
    let mut payload = serde_json::Map::new();
    payload.insert("action".into(), json!(action));
    payload.insert("outcome".into(), json!(outcome));
    if let Some(profile) = profile {
        let (id, label) = profile.audit_identity();
        payload.insert("profileId".into(), json!(id));
        payload.insert("profileLabel".into(), json!(label));
    }
    if let Some(error) = error {
        payload.insert("errorCode".into(), json!(error.slug()));
    }
    if let Some(duration_ms) = facts.duration_ms {
        payload.insert("durationMs".into(), json!(duration_ms));
    }
    if let Value::Object(extra) = facts.extra {
        for (key, value) in extra {
            payload.insert(key, value);
        }
    }

    if let Err(error) = crate::audit::append(&st.db, AUDIT_KIND, None, Value::Object(payload)) {
        // An audit write that fails must not fail the call it describes. The
        // operation already happened; losing the row is a logging fault, not a
        // reason to report a success as a failure.
        tracing::warn!(%error, "connection audit row failed to write");
    }
}

/// One audit row for a call the gate refused.
///
/// The profile is looked up best-effort: a refusal may arrive before a profile
/// id is even parseable, and a missing label must not stop the record.
fn write_refusal(st: &AppState, profile_id: Option<&str>, action: &str, error: &ConnectionError) {
    let profile = profile_id.and_then(|id| store::get(&st.db, id).ok().flatten());
    write_audit(
        st,
        profile.as_ref(),
        action,
        "refused",
        Some(error),
        AuditFacts::default(),
    );
}

// ---- shared helpers --------------------------------------------------------

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Resolve a profile by id, or the `1030` refusal.
fn require_profile(st: &AppState, id: &str) -> Result<ConnectionProfile, JsonRpcError> {
    store::get(&st.db, id)
        .map_err(internal)?
        .ok_or_else(|| connection_err(ConnectionError::NotFound(id.to_string())))
}

/// The record for the user-facing surface, with the credential reported as a
/// boolean rather than as the handle.
///
/// The handle is not published because nothing in the renderer needs it, and a
/// renderer that holds one is a renderer that could be tricked into echoing it.
fn user_view(st: &AppState, profile: &ConnectionProfile) -> Value {
    let configured = profile
        .credential_ref
        .as_ref()
        .is_some_and(|reference| st.secrets.has(reference));
    profile.to_user_value(configured)
}

// ---- dispatch --------------------------------------------------------------

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    args: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        // ---- user-facing: never gated, because this is how a person turns a
        // target on ----------------------------------------------------------
        "connection.profiles" => {
            let st = state.lock().await;
            let profiles = store::list_all(&st.db).map_err(internal)?;
            Ok(json!({
                "profiles": profiles
                    .iter()
                    .map(|profile| user_view(&st, profile))
                    .collect::<Vec<_>>(),
            }))
        }
        "connection.create" => {
            let st = state.lock().await;
            // Create stores a new record, so an id in the payload means the
            // caller meant to edit; naming the right method beats guessing.
            if args
                .get("profileId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(invalid(
                    "connection.create stores a new profile and takes no profileId; use connection.update",
                ));
            }
            upsert_profile(&st, &args)
        }
        "connection.update" => {
            let st = state.lock().await;
            require(params::required_str(&args, "profileId"))?;
            upsert_profile(&st, &args)
        }
        "connection.delete" => {
            let st = state.lock().await;
            let id = require(params::required_str(&args, "profileId"))?;
            // Idempotent: a profile that is already gone is the state the
            // caller asked for, so this reports `false` rather than failing.
            // The audit row is written either way, because "someone asked for
            // this to be deleted" is the fact worth keeping.
            let before = store::get(&st.db, &id).map_err(internal)?;
            let deleted = store::delete(&st.db, &id).map_err(internal)?;
            if deleted {
                // The secret goes with the record, so deleting a profile does
                // not leave a credential behind that nothing can reach.
                if let Some(reference) = before
                    .as_ref()
                    .and_then(|profile| profile.credential_ref.as_deref())
                {
                    let _ = st.secrets.delete(reference);
                }
            }
            write_audit(
                &st,
                before.as_ref(),
                "profile.delete",
                if deleted { "ok" } else { "missing" },
                None,
                AuditFacts::default(),
            );
            Ok(json!({ "deleted": deleted }))
        }
        "connection.setEnabled" => {
            let st = state.lock().await;
            let id = require(params::required_str(&args, "profileId"))?;
            let enabled =
                require(params::bool_field(&args, "enabled").map(|value| value.unwrap_or(false)))?;
            let profile = require_profile(&st, &id)?;
            let applied = store::set_enabled(&st.db, &id, enabled).map_err(internal)?;
            write_audit(
                &st,
                Some(&profile),
                if enabled {
                    "profile.enable"
                } else {
                    "profile.disable"
                },
                "ok",
                None,
                AuditFacts::default(),
            );
            Ok(json!({ "enabled": applied.is_some_and(|value| value) }))
        }
        "connection.setCredential" => {
            let st = state.lock().await;
            let id = require(params::required_str(&args, "profileId"))?;
            let secret = require(params::required_str(&args, "secret"))?;
            if secret.is_empty() {
                return Err(invalid("secret must not be empty"));
            }
            let profile = require_profile(&st, &id)?;
            let reference = connection::credential_ref_for(&id);
            st.secrets.set(&reference, &secret).map_err(internal)?;
            store::set_credential_ref(&st.db, &id, Some(&reference)).map_err(internal)?;
            // Neither the value nor the handle is in the payload.
            write_audit(
                &st,
                Some(&profile),
                "credential.set",
                "ok",
                None,
                AuditFacts::default(),
            );
            Ok(json!({ "credentialConfigured": true }))
        }
        "connection.clearCredential" => {
            let st = state.lock().await;
            let id = require(params::required_str(&args, "profileId"))?;
            let profile = require_profile(&st, &id)?;
            if let Some(reference) = profile.credential_ref.as_deref() {
                let _ = st.secrets.delete(reference);
            }
            store::set_credential_ref(&st.db, &id, None).map_err(internal)?;
            write_audit(
                &st,
                Some(&profile),
                "credential.clear",
                "ok",
                None,
                AuditFacts::default(),
            );
            Ok(json!({ "credentialConfigured": false }))
        }
        "connection.acceptHostKey" => {
            let st = state.lock().await;
            let id = require(params::required_str(&args, "profileId"))?;
            let fingerprint = require(params::required_str(&args, "fingerprint"))?;
            let profile = require_profile(&st, &id)?;
            store::update(
                &st.db,
                &id,
                &ProfilePatch {
                    host_key_policy: Some(HostKeyPolicy::Pinned),
                    host_key_fingerprint: Some(Some(fingerprint.as_str())),
                    ..Default::default()
                },
            )
            .map_err(internal)?
            .ok_or_else(|| connection_err(ConnectionError::NotFound(id.clone())))?;
            // A changed key is the case a person must decide on, so the record
            // shows a human accepted one rather than only that data moved.
            write_audit(
                &st,
                Some(&profile),
                "hostKey.accept",
                "ok",
                None,
                AuditFacts::default(),
            );
            Ok(json!({ "hostKeyPolicy": "pinned", "hostKeyFingerprint": fingerprint }))
        }
        "connection.activity" => {
            let st = state.lock().await;
            let id = require(params::required_str(&args, "profileId"))?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .min(200) as i64;
            let rows = activity_for(&st, &id, limit).map_err(internal)?;
            Ok(json!({ "activity": rows }))
        }

        // ---- Agent-facing: behind the switch -------------------------------
        "connection.list" => {
            let st = state.lock().await;
            if let Err(error) = require_switch(&st) {
                write_refusal(&st, None, "list", &error);
                return Err(connection_err(error));
            }
            let profiles = store::list_enabled(&st.db).map_err(internal)?;
            Ok(json!({
                "profiles": profiles
                    .iter()
                    .map(ConnectionProfile::to_agent_value)
                    .collect::<Vec<_>>(),
            }))
        }
        "connection.probe" => probe(state, &args).await,
        "connection.exec" => exec(state, &args).await,
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// Connect, verify the host key, learn the shell, disconnect, and record.
async fn probe(state: &Arc<Mutex<AppState>>, args: &Value) -> Result<Value, JsonRpcError> {
    let profile_id = require(params::profile_id(args))?;

    // Everything the transport needs is copied out here so the host mutex is
    // not held across the network wait.
    let (profile, secrets, timeout) = {
        let st = state.lock().await;
        if let Err(error) = require_switch(&st) {
            write_refusal(&st, Some(&profile_id), "probe", &error);
            return Err(connection_err(error));
        }
        let profile = require_profile(&st, &profile_id)?;
        if let Err(error) = require_profile_enabled(&profile) {
            write_refusal(&st, Some(&profile_id), "probe", &error);
            return Err(connection_err(error));
        }
        let timeout = Duration::from_millis(params::effective_timeout_ms(&profile.limits, None));
        (profile, st.secrets.clone(), timeout)
    };

    let result = ssh::probe(&secrets, &profile, timeout).await;

    let st = state.lock().await;
    let body = match &result {
        Ok(report) => {
            let _ = store::record_probe(
                &st.db,
                &profile.id,
                &LastProbe {
                    ok: true,
                    at: now_rfc3339(),
                    error_code: None,
                    reason: None,
                },
            );
            write_audit(
                &st,
                Some(&profile),
                "probe",
                "ok",
                None,
                AuditFacts::with_duration(report.duration_ms),
            );
            json!({
                "ok": true,
                "fingerprint": report.fingerprint,
                "shell": report.shell,
                "multiplexed": report.multiplexed,
                "durationMs": report.duration_ms,
            })
        }
        Err(error) => {
            let _ = store::record_probe(
                &st.db,
                &profile.id,
                &LastProbe {
                    ok: false,
                    at: now_rfc3339(),
                    error_code: Some(error.slug().to_string()),
                    // The reason is the layer's own sentence, so it carries no
                    // target detail a caller did not already have.
                    reason: Some(error.to_string()),
                },
            );
            write_audit(
                &st,
                Some(&profile),
                "probe",
                "error",
                Some(error),
                AuditFacts::default(),
            );
            return Err(connection_err(error.clone()));
        }
    };
    Ok(body)
}

/// Run one command on the target and return its result.
async fn exec(state: &Arc<Mutex<AppState>>, args: &Value) -> Result<Value, JsonRpcError> {
    let profile_id = require(params::profile_id(args))?;

    let (profile, secrets, timeout, budget, scratch) = {
        let st = state.lock().await;
        if let Err(error) = require_switch(&st) {
            write_refusal(&st, Some(&profile_id), "exec", &error);
            return Err(connection_err(error));
        }
        let profile = require_profile(&st, &profile_id)?;
        if let Err(error) = require_profile_enabled(&profile) {
            write_refusal(&st, Some(&profile_id), "exec", &error);
            return Err(connection_err(error));
        }
        if !connection::capabilities_for(profile.kind).exec {
            // Decided here, before any connection is attempted, so a serial,
            // telnet, or raw TCP target is never dialled by an `exec`.
            let error = ConnectionError::NoExec;
            write_refusal(&st, Some(&profile_id), "exec", &error);
            return Err(connection_err(error));
        }
        let requested = require(params::requested_timeout_ms(args))?;
        let timeout =
            Duration::from_millis(params::effective_timeout_ms(&profile.limits, requested));
        let budget = params::effective_output_bytes(&profile.limits);
        // The spill file is read back by the local Read tool, so it goes in the
        // same per-session scratch directory that tool reads from. Without a
        // session id there is nowhere for it to go, and the marker says so.
        let scratch = args
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|session| crate::scratch::session_dir(st.db.data_dir(), session));
        (profile, st.secrets.clone(), timeout, budget, scratch)
    };

    let command = require(params::command(args))?;
    let reduced = params::budget_is_reduced(&profile.limits);
    let result = ssh::exec(&secrets, &profile, &command, timeout).await;

    let st = state.lock().await;
    match result {
        Ok(report) => {
            let stdout = render_budget(&report.stdout, budget, scratch.as_deref());
            let stderr = render_budget(&report.stderr, budget, scratch.as_deref());
            write_audit(
                &st,
                Some(&profile),
                "exec",
                "ok",
                None,
                AuditFacts::with_duration(report.duration_ms),
            );
            let mut body = json!({
                "exitCode": report.exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "durationMs": report.duration_ms,
            });
            if reduced {
                // A caller that got less than it expected is told why, rather
                // than left to wonder where the rest went.
                body["outputBudgetBytes"] = json!(budget);
            }
            Ok(body)
        }
        Err(error) => {
            write_audit(
                &st,
                Some(&profile),
                "exec",
                "error",
                Some(&error),
                AuditFacts::with_extra(json!({ "commandBytes": command.len() })),
            );
            Err(connection_err(error))
        }
    }
}

/// Render one stream through the same budget and spill path the local command
/// tool uses, so the marker and the spill file are identical on both sides
/// (`03-runtime/23-connections-protocol.md` §11).
fn render_budget(text: &str, budget: usize, scratch: Option<&Path>) -> String {
    let shaped = crate::tools::OutputBudget {
        max_bytes: budget,
        max_lines: crate::tools::BUDGET_SHELL.max_lines,
        direction: crate::tools::Direction::Head,
    };
    let (rendered, _truncated) =
        crate::tools::truncate_with_spill(text, shaped, scratch, "connection-output");
    rendered
}

/// Create or edit a profile from the user-facing surface.
fn upsert_profile(st: &AppState, args: &Value) -> Result<Value, JsonRpcError> {
    let label = require(params::label(&require(params::required_str(
        args, "label",
    ))?))?;
    let target = require(params::target(args))?;

    // A profile with no id is a create; one with an id is an edit. The same
    // method serves both because the caller's form does not distinguish them.
    let existing_id = args
        .get("profileId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);

    // A label is what the user reads, so a duplicate is refused rather than
    // stored as a second row they cannot tell apart.
    if let Some(owner) =
        store::label_owner(&st.db, &label, existing_id.as_deref()).map_err(internal)?
    {
        return Err(invalid(&format!(
            "another connection profile already uses the label {label} ({owner})"
        )));
    }

    let kind = require(params::kind(args))?;
    require(params::validate_target(kind, &target))?;
    let policy = require(params::host_key_policy(args))?;
    let requested_fingerprint = args
        .get("hostKeyFingerprint")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    require(params::validate_host_key(policy, requested_fingerprint))?;
    let multiplex = require(params::multiplex(args))?;
    let limits = require(params::limits(args))?;

    match existing_id {
        Some(id) => {
            let before = require_profile(st, &id)?;
            let updated = store::update(
                &st.db,
                &id,
                &ProfilePatch {
                    label: Some(&label),
                    target: Some(&target),
                    host_key_policy: Some(policy),
                    // An absent fingerprint is "leave it alone"; switching the
                    // policy away from `pinned` clears it in the store.
                    host_key_fingerprint: requested_fingerprint.map(Some),
                    multiplex: Some(multiplex),
                    limits: Some(limits),
                },
            )
            .map_err(internal)?
            .ok_or_else(|| connection_err(ConnectionError::NotFound(id.clone())))?;
            write_audit(
                st,
                Some(&before),
                "profile.update",
                "ok",
                None,
                AuditFacts::default(),
            );
            Ok(user_view(st, &updated))
        }
        None => {
            let created = store::insert(
                &st.db,
                &NewProfile {
                    label: &label,
                    kind,
                    target: &target,
                    host_key_policy: policy,
                    host_key_fingerprint: requested_fingerprint,
                    multiplex,
                    limits,
                },
            )
            .map_err(internal)?;
            write_audit(
                st,
                Some(&created),
                "profile.create",
                "ok",
                None,
                AuditFacts::default(),
            );
            Ok(user_view(st, &created))
        }
    }
}

/// Recent audit rows for one profile, newest first.
fn activity_for(st: &AppState, profile_id: &str, limit: i64) -> anyhow::Result<Vec<Value>> {
    let mut statement = st.db.conn().prepare(
        "SELECT ts, payload_json FROM audit_log \
         WHERE kind = ?1 AND json_extract(payload_json, '$.profileId') = ?2 \
         ORDER BY ts DESC, id DESC LIMIT ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![AUDIT_KIND, profile_id, limit], |row| {
        let ts: i64 = row.get(0)?;
        let raw: String = row.get(1)?;
        Ok((ts, raw))
    })?;
    let mut activity = Vec::new();
    for row in rows {
        let (ts, raw) = row?;
        // A row that no longer decodes is skipped rather than reported as a
        // malformed entry: the log is diagnostic, and one bad row must not make
        // the whole view unreadable.
        let Ok(mut payload) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Value::Object(object) = &mut payload {
            object.insert("ts".into(), json!(ts));
        }
        activity.push(payload);
    }
    Ok(activity)
}

#[cfg(test)]
mod tests;
