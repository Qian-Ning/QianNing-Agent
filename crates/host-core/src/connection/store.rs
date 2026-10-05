//! Profile persistence.
//!
//! A profile is a row in `connection_profiles` plus, optionally, a value in the
//! existing secret store under the reference this module names. Nothing here
//! reads that value: the store deals in references, and the spawn path in
//! [`super::ssh`] is the only place a secret is resolved.
//!
//! Two views leave this module, and they are built by two separate functions
//! rather than by one function with a flag, so a field added to the record
//! cannot reach the Agent surface by default:
//!
//! - [`ConnectionProfile::to_user_value`] — the full record for the
//!   Connections destination, with the credential reported as a boolean.
//! - [`ConnectionProfile::to_agent_value`] — id, label, kind, and the last
//!   probe; no reference, no target beyond what a target already published.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::{ConnKind, HostKeyPolicy, LastProbe, Limits, Multiplex, Target};
use crate::db::{now_ms, Database};

/// The table this module owns. Declared once so the migration and the queries
/// cannot disagree about a name.
pub const TABLE: &str = "connection_profiles";

/// A stored target.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionProfile {
    pub id: String,
    pub label: String,
    pub kind: ConnKind,
    /// The per-target switch. Default off: creating a target does not make it
    /// reachable.
    pub enabled: bool,
    pub target: Target,
    /// A secret-store handle, never the secret. `None` when the transport needs
    /// no credential, or the user has not supplied one yet.
    pub credential_ref: Option<String>,
    pub host_key_policy: HostKeyPolicy,
    pub host_key_fingerprint: Option<String>,
    pub multiplex: Multiplex,
    pub limits: Limits,
    pub last_probe: Option<LastProbe>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ConnectionProfile {
    /// The full record, for the user-facing surface.
    ///
    /// `configured` is what the interface is allowed to know about the
    /// credential: that one exists. The reference itself is not published,
    /// because nothing in the renderer needs it and a renderer that holds it
    /// is a renderer that could be tricked into echoing it.
    pub fn to_user_value(&self, configured: bool) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "enabled": self.enabled,
            "target": self.target,
            "credentialConfigured": configured,
            "hostKeyPolicy": self.host_key_policy,
            "hostKeyFingerprint": self.host_key_fingerprint,
            "multiplex": self.multiplex,
            "limits": self.limits,
            "lastProbe": self.last_probe,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }

    /// The record an Agent-facing caller sees.
    ///
    /// Deliberately narrow. The Agent needs to choose a target and to know
    /// whether the last probe worked; it does not need the reference, the
    /// limits, or the host-key policy, and every field that is absent here is a
    /// field that cannot leak through a tool result.
    pub fn to_agent_value(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "lastProbe": self.last_probe,
        })
    }

    /// The label and id, for an audit row: enough to answer "what ran where"
    /// without carrying anything else.
    pub fn audit_identity(&self) -> (&str, &str) {
        (self.id.as_str(), self.label.as_str())
    }
}

/// The columns every read selects, in one place so the row mapper stays
/// correct when a column is added.
const COLUMNS: &str = "id, label, kind, enabled, target_json, credential_ref, \
     host_key_policy, host_key_fingerprint, multiplex, limits_json, last_probe_json, \
     created_at, updated_at";

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionProfile> {
    let kind: String = row.get(2)?;
    let target_json: String = row.get(4)?;
    let multiplex: String = row.get(8)?;
    let limits_json: String = row.get(9)?;
    let last_probe_json: Option<String> = row.get(10)?;

    // A stored value that no longer decodes is a corrupt row, not a caller
    // error, so it is reported as a SQL error and surfaces as an internal
    // failure rather than as a plausible-looking profile.
    let kind = ConnKind::parse(&kind).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, error.into())
    })?;
    let target: Target = serde_json::from_str(&target_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let multiplex = Multiplex::parse(&multiplex).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, error.into())
    })?;
    let limits: Limits = serde_json::from_str(&limits_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let last_probe: Option<LastProbe> = match last_probe_json {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                10,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?),
        None => None,
    };
    let policy: String = row.get(6)?;
    let host_key_policy = HostKeyPolicy::parse(&policy).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, error.into())
    })?;

    Ok(ConnectionProfile {
        id: row.get(0)?,
        label: row.get(1)?,
        kind,
        enabled: row.get::<_, i64>(3)? != 0,
        target,
        credential_ref: row.get(5)?,
        host_key_policy,
        host_key_fingerprint: row.get(7)?,
        multiplex,
        limits,
        last_probe,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

/// Every profile, ordered by label so the destination and the tool list are
/// stable between calls.
pub fn list_all(db: &Database) -> Result<Vec<ConnectionProfile>> {
    let sql = format!("SELECT {COLUMNS} FROM {TABLE} ORDER BY label COLLATE NOCASE, id");
    let mut statement = db.conn().prepare(&sql)?;
    let rows = statement.query_map([], row_to_profile)?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

/// Only the profiles the user has enabled.
///
/// This is the set `connection.list` reports. A disabled profile is not merely
/// omitted from the listing: a call naming one is refused with its own code,
/// so a model holding a stale list learns why rather than assuming the target
/// never existed.
pub fn list_enabled(db: &Database) -> Result<Vec<ConnectionProfile>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM {TABLE} WHERE enabled = 1 ORDER BY label COLLATE NOCASE, id"
    );
    let mut statement = db.conn().prepare(&sql)?;
    let rows = statement.query_map([], row_to_profile)?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

/// One profile by id.
pub fn get(db: &Database, id: &str) -> Result<Option<ConnectionProfile>> {
    let sql = format!("SELECT {COLUMNS} FROM {TABLE} WHERE id = ?1");
    let mut statement = db.conn().prepare(&sql)?;
    let profile = statement.query_row([id], row_to_profile).optional()?;
    Ok(profile)
}

/// The id of a profile already using `label`, if any.
///
/// Labels are what a user reads, so two profiles sharing one is a mistake the
/// store refuses rather than a situation the interface has to explain.
pub fn label_owner(db: &Database, label: &str, excluding: Option<&str>) -> Result<Option<String>> {
    let mut statement = db.conn().prepare(&format!(
        "SELECT id FROM {TABLE} WHERE label = ?1 COLLATE NOCASE AND (?2 IS NULL OR id <> ?2)"
    ))?;
    let owner = statement
        .query_row(params![label, excluding], |row| row.get::<_, String>(0))
        .optional()?;
    Ok(owner)
}

/// A row ready to be written. Split out from `ConnectionProfile` so the
/// create path cannot accidentally carry an id, a timestamp, or a probe result
/// supplied by a caller.
pub struct NewProfile<'a> {
    pub label: &'a str,
    pub kind: ConnKind,
    pub target: &'a Target,
    pub host_key_policy: HostKeyPolicy,
    pub host_key_fingerprint: Option<&'a str>,
    pub multiplex: Multiplex,
    pub limits: Limits,
}

/// Insert a profile. A new profile is always disabled: creating a target does
/// not make it reachable.
pub fn insert(db: &Database, profile: &NewProfile<'_>) -> Result<ConnectionProfile> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let target_json = serde_json::to_string(profile.target).context("encode target")?;
    let limits_json = serde_json::to_string(&profile.limits).context("encode limits")?;
    db.conn().execute(
        &format!(
            "INSERT INTO {TABLE} (id, label, kind, enabled, target_json, credential_ref, \
             host_key_policy, host_key_fingerprint, multiplex, limits_json, last_probe_json, \
             created_at, updated_at) \
             VALUES (?1, ?2, ?3, 0, ?4, NULL, ?5, ?6, ?7, ?8, NULL, ?9, ?9)"
        ),
        params![
            id,
            profile.label,
            profile.kind.as_str(),
            target_json,
            profile.host_key_policy.as_str(),
            profile.host_key_fingerprint,
            profile.multiplex.as_str(),
            limits_json,
            now,
        ],
    )?;
    get(db, &id)?.context("the row just inserted is missing")
}

/// The fields an edit may change. Every one is optional: an absent field means
/// "leave it alone", which is what makes a partial edit safe.
#[derive(Default)]
pub struct ProfilePatch<'a> {
    pub label: Option<&'a str>,
    pub target: Option<&'a Target>,
    pub host_key_policy: Option<HostKeyPolicy>,
    /// `Some(None)` clears the fingerprint; `None` leaves it alone.
    pub host_key_fingerprint: Option<Option<&'a str>>,
    pub multiplex: Option<Multiplex>,
    pub limits: Option<Limits>,
}

/// Apply an edit. Returns the updated record, or `None` when no profile has
/// that id.
pub fn update(
    db: &Database,
    id: &str,
    patch: &ProfilePatch<'_>,
) -> Result<Option<ConnectionProfile>> {
    let Some(mut profile) = get(db, id)? else {
        return Ok(None);
    };

    if let Some(label) = patch.label {
        profile.label = label.to_string();
    }
    if let Some(target) = patch.target {
        profile.target = target.clone();
        // The kind follows the target: they are one fact, and letting them
        // drift would produce a record whose columns disagree.
        profile.kind = target.kind();
    }
    if let Some(policy) = patch.host_key_policy {
        profile.host_key_policy = policy;
    }
    match patch.host_key_fingerprint {
        Some(fingerprint) => profile.host_key_fingerprint = fingerprint.map(str::to_string),
        None => {
            // Switching away from `pinned` drops the stale fingerprint; keeping
            // it would suggest the record still enforces a key it does not.
            if profile.host_key_policy != HostKeyPolicy::Pinned {
                profile.host_key_fingerprint = None;
            }
        }
    }
    if let Some(multiplex) = patch.multiplex {
        profile.multiplex = multiplex;
    }
    if let Some(limits) = patch.limits {
        profile.limits = limits;
    }

    let target_json = serde_json::to_string(&profile.target).context("encode target")?;
    let limits_json = serde_json::to_string(&profile.limits).context("encode limits")?;
    let now = now_ms();
    db.conn().execute(
        &format!(
            "UPDATE {TABLE} SET label = ?2, kind = ?3, target_json = ?4, host_key_policy = ?5, \
             host_key_fingerprint = ?6, multiplex = ?7, limits_json = ?8, updated_at = ?9 \
             WHERE id = ?1"
        ),
        params![
            id,
            profile.label,
            profile.kind.as_str(),
            target_json,
            profile.host_key_policy.as_str(),
            profile.host_key_fingerprint,
            profile.multiplex.as_str(),
            limits_json,
            now,
        ],
    )?;
    get(db, id)
}

/// Flip one profile's switch. Returns the new value, or `None` when no profile
/// has that id.
pub fn set_enabled(db: &Database, id: &str, enabled: bool) -> Result<Option<bool>> {
    let changed = db.conn().execute(
        &format!("UPDATE {TABLE} SET enabled = ?2, updated_at = ?3 WHERE id = ?1"),
        params![id, i64::from(enabled), now_ms()],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(Some(enabled))
}

/// Write a credential reference onto a profile.
pub fn set_credential_ref(db: &Database, id: &str, reference: Option<&str>) -> Result<bool> {
    let changed = db.conn().execute(
        &format!("UPDATE {TABLE} SET credential_ref = ?2, updated_at = ?3 WHERE id = ?1"),
        params![id, reference, now_ms()],
    )?;
    Ok(changed > 0)
}

/// Persist the summary of a probe.
pub fn record_probe(db: &Database, id: &str, probe: &LastProbe) -> Result<()> {
    let encoded = serde_json::to_string(probe).context("encode probe")?;
    db.conn().execute(
        &format!("UPDATE {TABLE} SET last_probe_json = ?2, updated_at = ?3 WHERE id = ?1"),
        params![id, encoded, now_ms()],
    )?;
    Ok(())
}

/// Delete a profile. Idempotent: deleting an id that is already gone answers
/// `false` rather than failing, because the caller's intent is already true.
pub fn delete(db: &Database, id: &str) -> Result<bool> {
    let changed = db
        .conn()
        .execute(&format!("DELETE FROM {TABLE} WHERE id = ?1"), params![id])?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().expect("temp dir");
        let db = Database::open(dir.path().join("host.db").as_path()).expect("open");
        (dir, db)
    }

    fn ssh_target() -> Target {
        Target::Ssh {
            host: "build-box".into(),
            port: 22,
            user: Some("deploy".into()),
            identity_file: None,
            proxy_jump: None,
        }
    }

    fn new_profile<'a>(label: &'a str, target: &'a Target) -> NewProfile<'a> {
        NewProfile {
            label,
            kind: target.kind(),
            target,
            host_key_policy: HostKeyPolicy::Strict,
            host_key_fingerprint: None,
            multiplex: Multiplex::PerCall,
            limits: Limits::default(),
        }
    }

    #[test]
    fn a_new_profile_is_disabled_and_has_no_credential() {
        let (_dir, db) = fixture();
        let profile = insert(&db, &new_profile("build-box", &ssh_target())).expect("insert");
        assert!(
            !profile.enabled,
            "creating a target must not make it reachable"
        );
        assert!(profile.credential_ref.is_none());
        assert!(profile.last_probe.is_none());
        assert_eq!(profile.host_key_policy, HostKeyPolicy::Strict);
        assert_eq!(profile.multiplex, Multiplex::PerCall);
        assert_eq!(profile.limits, Limits::default());
        assert!(!profile.id.is_empty());
    }

    #[test]
    fn only_enabled_profiles_are_listed_as_enabled() {
        let (_dir, db) = fixture();
        let first = insert(&db, &new_profile("alpha", &ssh_target())).expect("insert");
        let second = insert(&db, &new_profile("beta", &ssh_target())).expect("insert");

        assert!(list_enabled(&db).expect("list").is_empty());
        assert_eq!(list_all(&db).expect("list").len(), 2);

        set_enabled(&db, &second.id, true).expect("enable");
        let enabled = list_enabled(&db).expect("list");
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, second.id);
        assert!(
            !enabled.iter().any(|profile| profile.id == first.id),
            "a disabled profile stays out of the agent-facing listing"
        );
    }

    #[test]
    fn a_label_is_unique_case_insensitively() {
        let (_dir, db) = fixture();
        let first = insert(&db, &new_profile("Build-Box", &ssh_target())).expect("insert");
        assert_eq!(
            label_owner(&db, "build-box", None).expect("lookup"),
            Some(first.id.clone())
        );
        assert_eq!(
            label_owner(&db, "BUILD-BOX", Some(&first.id)).expect("lookup"),
            None,
            "a profile editing its own label does not collide with itself"
        );
    }

    #[test]
    fn an_edit_leaves_untouched_fields_alone() {
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("build-box", &ssh_target())).expect("insert");

        let updated = update(
            &db,
            &created.id,
            &ProfilePatch {
                label: Some("build-box-2"),
                ..Default::default()
            },
        )
        .expect("update")
        .expect("a row");

        assert_eq!(updated.label, "build-box-2");
        assert_eq!(updated.target, created.target, "the target is untouched");
        assert_eq!(updated.limits, created.limits, "the limits are untouched");
        assert_eq!(updated.kind, created.kind);
        assert_eq!(updated.created_at, created.created_at);
    }

    #[test]
    fn editing_a_target_moves_the_kind_with_it() {
        // One fact, two columns: letting them disagree would produce a record
        // whose stored shape contradicts its own declared kind.
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("endpoint", &ssh_target())).expect("insert");
        let telnet = Target::Telnet {
            host: "10.0.0.5".into(),
            port: 23,
        };

        let updated = update(
            &db,
            &created.id,
            &ProfilePatch {
                target: Some(&telnet),
                ..Default::default()
            },
        )
        .expect("update")
        .expect("a row");

        assert_eq!(updated.kind, ConnKind::Telnet);
        assert_eq!(updated.target, telnet);
    }

    #[test]
    fn switching_away_from_pinned_drops_the_stale_fingerprint() {
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("box", &ssh_target())).expect("insert");
        let pinned = update(
            &db,
            &created.id,
            &ProfilePatch {
                host_key_policy: Some(HostKeyPolicy::Pinned),
                host_key_fingerprint: Some(Some("SHA256:abc")),
                ..Default::default()
            },
        )
        .expect("update")
        .expect("a row");
        assert_eq!(pinned.host_key_fingerprint.as_deref(), Some("SHA256:abc"));

        let relaxed = update(
            &db,
            &created.id,
            &ProfilePatch {
                host_key_policy: Some(HostKeyPolicy::AcceptNew),
                ..Default::default()
            },
        )
        .expect("update")
        .expect("a row");
        assert!(
            relaxed.host_key_fingerprint.is_none(),
            "a record must not suggest it still enforces a key it does not"
        );
    }

    #[test]
    fn an_edit_to_a_missing_profile_answers_none() {
        let (_dir, db) = fixture();
        assert!(update(&db, "nope", &ProfilePatch::default())
            .expect("update")
            .is_none());
        assert!(set_enabled(&db, "nope", true).expect("set").is_none());
        assert!(!delete(&db, "nope").expect("delete"));
    }

    #[test]
    fn delete_is_idempotent() {
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("build-box", &ssh_target())).expect("insert");
        assert!(delete(&db, &created.id).expect("delete"));
        assert!(!delete(&db, &created.id).expect("delete again"));
        assert!(get(&db, &created.id).expect("get").is_none());
    }

    #[test]
    fn a_probe_result_round_trips() {
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("build-box", &ssh_target())).expect("insert");
        let probe = LastProbe {
            ok: false,
            at: "2026-10-04T12:31:07.000Z".into(),
            error_code: Some("CONNECTION_HOST_KEY".into()),
            reason: None,
        };
        record_probe(&db, &created.id, &probe).expect("record");

        let reloaded = get(&db, &created.id).expect("get").expect("a row");
        assert_eq!(reloaded.last_probe, Some(probe));
    }

    #[test]
    fn the_agent_view_never_carries_a_credential_reference() {
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("build-box", &ssh_target())).expect("insert");
        set_credential_ref(&db, &created.id, Some("conn:abc")).expect("set");
        let loaded = get(&db, &created.id).expect("get").expect("a row");
        assert!(loaded.credential_ref.is_some(), "the store still holds it");

        let agent = loaded.to_agent_value();
        let rendered = agent.to_string();
        assert!(!rendered.contains("conn:abc"));
        assert!(agent.get("credentialRef").is_none());
        assert!(agent.get("credentialConfigured").is_none());
        assert!(agent.get("limits").is_none());
        assert!(agent.get("hostKeyPolicy").is_none());
        assert_eq!(agent["id"], json!(created.id));
        assert_eq!(agent["label"], json!("build-box"));

        // The user view is explicit about it rather than silent.
        let user = loaded.to_user_value(true);
        assert_eq!(user["credentialConfigured"], json!(true));
        assert!(
            user.get("credentialRef").is_none(),
            "even the user view publishes a boolean, not the handle"
        );
    }

    #[test]
    fn a_user_view_of_a_profile_without_a_credential_says_so() {
        let (_dir, db) = fixture();
        let created = insert(&db, &new_profile("box", &ssh_target())).expect("insert");
        let user = created.to_user_value(false);
        assert_eq!(user["credentialConfigured"], json!(false));
        assert_eq!(user["enabled"], json!(false));
        assert_eq!(user["hostKeyPolicy"], json!("strict"));
        assert_eq!(user["multiplex"], json!("per-call"));
    }
}
