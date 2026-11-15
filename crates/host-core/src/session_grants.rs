//! Session-scoped tool grants, kept in the database.
//!
//! "Allow for this session" used to live in a `HashMap` on `AppState`, so the
//! answer survived exactly as long as the host process. A user who granted a tool
//! before lunch was asked again after a restart — for a decision they had already
//! made, about the same conversation.
//!
//! The row is the decision, not the request: one per `(session, tool)`, so a
//! second grant is a no-op and the table cannot grow with every prompt. `origin`
//! records who answered, because a desktop confirmation and an approval arriving
//! through a chat channel are not the same evidence.
//!
//! Kept as a plain table rather than a `Vec` per session so the answer is durable
//! and auditable; the in-memory map stays as the hot path and is hydrated at
//! startup.

use std::collections::HashMap;

use anyhow::Result;

use crate::db::Database;

/// Every grant in the database, shaped like the in-memory map the permission path
/// already reads. An unreadable table yields an empty map upstream rather than
/// blocking the host: losing grants costs a confirmation, refusing to start costs
/// the application.
pub fn load(db: &Database) -> Result<HashMap<String, Vec<String>>> {
    let mut statement = db
        .conn()
        .prepare("SELECT session_id, tool_name FROM session_grants ORDER BY granted_at")?;
    let mut rows = statement.query([])?;
    let mut grants: HashMap<String, Vec<String>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let session_id: String = row.get(0)?;
        let tool_name: String = row.get(1)?;
        grants.entry(session_id).or_default().push(tool_name);
    }
    Ok(grants)
}

/// Record one grant. Idempotent: the same tool granted twice in a session leaves
/// one row, and the first `origin` wins — the earliest answer is the one that has
/// to be defensible afterwards.
pub fn record(db: &Database, session_id: &str, tool_name: &str, origin: &str) -> Result<()> {
    db.conn()
        .prepare_cached(
            "INSERT OR IGNORE INTO session_grants (session_id, tool_name, origin, granted_at)
             VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(rusqlite::params![
            session_id,
            tool_name,
            origin,
            crate::db::now_ms()
        ])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn session(db: &Database, id: &str) {
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, 't', 1, 1)",
                [id],
            )
            .unwrap();
    }

    #[test]
    fn a_grant_survives_a_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            session(&db, "s1");
            record(&db, "s1", "Bash", "user").unwrap();
        }
        let db = Database::open(&path).unwrap();
        let grants = load(&db).unwrap();
        assert_eq!(grants.get("s1"), Some(&vec!["Bash".to_string()]));
    }

    #[test]
    fn granting_the_same_tool_twice_leaves_one_row() {
        let dir = tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        session(&db, "s1");
        record(&db, "s1", "Edit", "user").unwrap();
        record(&db, "s1", "Edit", "chat_channel").unwrap();

        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM session_grants", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let origin: String = db
            .conn()
            .query_row("SELECT origin FROM session_grants", [], |row| row.get(0))
            .unwrap();
        assert_eq!(origin, "user", "the first answer is the one kept");
    }

    #[test]
    fn deleting_a_session_removes_its_grants() {
        let dir = tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        session(&db, "s1");
        record(&db, "s1", "Write", "user").unwrap();
        db.conn()
            .execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();

        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM session_grants", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "the grant goes with the conversation");
    }
}
