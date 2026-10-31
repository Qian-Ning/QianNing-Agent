//! The durable outbound-delivery ledger (ADR 0205 D375 item 9, milestone R3,
//! schema v23).
//!
//! The messaging integration adapter relays redacted event summaries to
//! outbound channels (a webhook first, then Telegram and Slack). This module is
//! the reliability substrate that sits under those channels: it records one row
//! per pending outbound delivery and owns a persisted state machine, so a
//! delivery is never silently lost when a turn must not block on it.
//!
//! What the ledger guarantees:
//!
//! * a delivery is born `pending` and every transition is written to SQLite, so
//!   the state survives a crash — nothing lives only in memory;
//! * exactly one worker holds a row at a time, through a claim/lease, so two
//!   workers never send the same delivery twice while both are alive;
//! * a failed attempt is retried on a bounded exponential backoff, and after
//!   the cap the row becomes a terminal `failed` that keeps its last error
//!   instead of being deleted;
//! * an attempt the Host crashes through is reclaimed at startup
//!   ([`recover_attempting`]) rather than staying stuck in `attempting`
//!   forever — this is the reason the ledger exists;
//! * a repeat attempt is recorded as a redelivery in the persisted state, so a
//!   receiver can be told the payload may be a duplicate.
//!
//! It opens no listener, holds no permission policy, and carries no transcript
//! content — those prohibitions belong to the adapter that will sit on top.
//!
//! The public surface here is the substrate the R3 messaging adapter calls.
//! That adapter is a separate scheduled change, so most of this API is ahead of
//! its consumer: only `recover_attempting` (from `boot_maintenance`) and the
//! tests reach it today.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, Database};

// The items below are the R3 messaging-adapter substrate: a forward API whose
// consumer is that adapter, a separate scheduled change. `recover_attempting`
// (from `boot_maintenance`) is the one item the Host wires today; every item the
// compiler still flags as unused carries an item-scoped allow so the lint stays
// blind only to this forward API. Drop each allow when the adapter lands.
/// Attempts a delivery starts with when the caller does not choose a cap.
#[allow(dead_code)]
pub const DEFAULT_MAX_ATTEMPTS: i64 = 5;

/// Default claim lease. A worker that dies without completing the delivery
/// leaves it reclaimable once this window passes.
#[allow(dead_code)]
pub const DEFAULT_LEASE_MS: i64 = 60_000;

/// First retry delay, before the exponential growth.
#[allow(dead_code)]
pub const BACKOFF_BASE_MS: i64 = 5_000;

/// Ceiling on the retry delay, so a long-lived failure never waits unboundedly.
#[allow(dead_code)]
pub const BACKOFF_MAX_MS: i64 = 15 * 60 * 1000;

/// Largest exponent applied before the cap clamps the result. Beyond this the
/// value is already far past [`BACKOFF_MAX_MS`], so the shift is defensive.
#[allow(dead_code)]
const MAX_BACKOFF_SHIFT: i64 = 16;

/// Error recorded when a delivery is reclaimed after the Host started without a
/// fresher error of its own (a crash mid-attempt).
const INTERRUPTED_ERROR: &str = "DELIVERY_INTERRUPTED";

/// The persisted state of one outbound delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DeliveryState {
    /// Queued and waiting for a worker.
    Pending,
    /// Claimed by a worker whose lease has not expired.
    Attempting,
    /// Accepted by the channel.
    Delivered,
    /// The attempt cap was reached; the row is terminal and keeps its error.
    Failed,
}

#[allow(dead_code)]
impl DeliveryState {
    /// The spelling stored in the `state` column (the `CHECK` in
    /// [`crate::db::schema::DELIVERY_LEDGER_SCHEMA`] lists exactly these).
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryState::Pending => "pending",
            DeliveryState::Attempting => "attempting",
            DeliveryState::Delivered => "delivered",
            DeliveryState::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(DeliveryState::Pending),
            "attempting" => Some(DeliveryState::Attempting),
            "delivered" => Some(DeliveryState::Delivered),
            "failed" => Some(DeliveryState::Failed),
            _ => None,
        }
    }
}

/// What a delivery asks the channel to do.
///
/// A turn is one `send` and any number of `edit`s of the message that send
/// created (ADR 0340). The ledger treats both as ordinary operations: edit rows
/// are enqueued with a single attempt because a lost update is worth nothing,
/// while the send that carries the final answer keeps the normal retry budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DeliveryOperation {
    /// Create a message in the conversation.
    Send,
    /// Replace the text of a message a previous send created.
    Edit,
}

#[allow(dead_code)]
impl DeliveryOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryOperation::Send => "send",
            DeliveryOperation::Edit => "edit",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "send" => Some(DeliveryOperation::Send),
            "edit" => Some(DeliveryOperation::Edit),
            _ => None,
        }
    }
}

/// A delivery to enqueue. `payload` is the redacted summary or a reference to
/// it; the ledger stores it verbatim and never inspects its contents.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct NewDelivery {
    /// Caller-chosen id; minted when absent.
    pub id: Option<String>,
    pub channel: String,
    pub payload: Value,
    /// Per-delivery attempt cap; [`DEFAULT_MAX_ATTEMPTS`] when absent.
    #[serde(default)]
    pub max_attempts: Option<i64>,
    /// What the channel should do; a send when absent, so every caller written
    /// before edits existed keeps its meaning.
    #[serde(default)]
    pub operation: Option<DeliveryOperation>,
    /// For an edit: the delivery whose message this row rewrites. Required for
    /// an edit and refused on a send, because a send creates the message rather
    /// than addressing one.
    ///
    /// The platform's own message id is deliberately not an input: it is minted
    /// by the channel and stays inside the Host, so a caller cannot address a
    /// message it did not create.
    #[serde(default)]
    pub card_of: Option<String>,
}

/// A persisted delivery row.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct Delivery {
    pub id: String,
    pub channel: String,
    pub payload: Value,
    pub state: DeliveryState,
    /// Attempts *started*, counted when a worker claims the row.
    pub attempts: i64,
    pub max_attempts: i64,
    /// Whether this attempt is a repeat of one that was already sent or tried.
    pub redelivery: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<String>,
    pub operation: DeliveryOperation,
    /// The channel's own name for the message this delivery created. Written by
    /// the worker when the channel reports one; `None` means "no message to
    /// edit", never "unknown yet".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<String>,
    /// For an edit: the delivery whose message this row rewrites.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_of: Option<String>,
}

#[allow(dead_code)]
const DELIVERY_COLUMNS: &str = "id, channel, payload_json, state, attempts, max_attempts, \
     redelivery, next_attempt_at, lease_owner, lease_expires_at, last_error, \
     created_at, updated_at, delivered_at, failed_at, operation, remote_id, card_of";

#[allow(dead_code)]
fn delivery_state_from_db(raw: &str) -> rusqlite::Result<DeliveryState> {
    DeliveryState::parse(raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown delivery_ledger.state value '{raw}'"),
            )),
        )
    })
}

#[allow(dead_code)]
fn row_to_delivery(row: &rusqlite::Row<'_>) -> rusqlite::Result<Delivery> {
    let state_raw: String = row.get(3)?;
    let payload_raw: String = row.get(2)?;
    let payload = serde_json::from_str(&payload_raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Delivery {
        id: row.get(0)?,
        channel: row.get(1)?,
        payload,
        state: delivery_state_from_db(&state_raw)?,
        attempts: row.get(4)?,
        max_attempts: row.get(5)?,
        redelivery: row.get::<_, i64>(6)? != 0,
        next_attempt_at: row.get::<_, Option<i64>>(7)?.map(ms_to_ts),
        lease_owner: row.get(8)?,
        lease_expires_at: row.get::<_, Option<i64>>(9)?.map(ms_to_ts),
        last_error: row.get(10)?,
        created_at: ms_to_ts(row.get::<_, i64>(11)?),
        updated_at: ms_to_ts(row.get::<_, i64>(12)?),
        delivered_at: row.get::<_, Option<i64>>(13)?.map(ms_to_ts),
        failed_at: row.get::<_, Option<i64>>(14)?.map(ms_to_ts),
        operation: {
            let raw: String = row.get(15)?;
            DeliveryOperation::parse(&raw).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    15,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("unknown delivery operation '{raw}'"),
                    )),
                )
            })?
        },
        remote_id: row.get(16)?,
        card_of: row.get(17)?,
    })
}

/// The retry delay after `attempts` failed attempts, before the cap.
///
/// `attempts` is the count already recorded for the delivery (at least the one
/// that just failed). The delay doubles each attempt from [`BACKOFF_BASE_MS`]
/// and stops at [`BACKOFF_MAX_MS`]. This is the single owner of the schedule;
/// [`mark_failed`] is the only caller that persists it.
#[allow(dead_code)]
pub fn backoff_ms(attempts: i64) -> i64 {
    let shift = (attempts.max(1) - 1).min(MAX_BACKOFF_SHIFT) as u32;
    BACKOFF_BASE_MS
        .saturating_mul(1i64 << shift)
        .min(BACKOFF_MAX_MS)
}

/// Enqueue a pending delivery. The row is immediately claimable.
#[allow(dead_code)]
pub fn enqueue(db: &Database, input: NewDelivery) -> Result<Delivery> {
    let channel = input.channel.trim();
    if channel.is_empty() {
        return Err(anyhow!("delivery channel must not be blank"));
    }
    let operation = input.operation.unwrap_or(DeliveryOperation::Send);
    let card_of = input
        .card_of
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    match (operation, card_of.as_deref()) {
        (DeliveryOperation::Edit, None) => {
            return Err(anyhow!("an edit delivery must name the card it belongs to"));
        }
        (DeliveryOperation::Send, Some(_)) => {
            return Err(anyhow!(
                "a send delivery must not name a card; enqueue an edit instead"
            ));
        }
        _ => {}
    }
    let max_attempts = input.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS).max(1);
    let id = input
        .id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let payload_json = serde_json::to_string(&input.payload)?;
    let now = now_ms();
    db.conn().execute(
        "INSERT INTO delivery_ledger (
            id, channel, payload_json, state, attempts, max_attempts, redelivery,
            next_attempt_at, created_at, updated_at, operation, card_of
         ) VALUES (?1, ?2, ?3, 'pending', 0, ?4, 0, ?5, ?5, ?5, ?6, ?7)",
        params![
            id,
            channel,
            payload_json,
            max_attempts,
            now,
            operation.as_str(),
            card_of
        ],
    )?;
    get(db, &id)?.ok_or_else(|| anyhow!("delivery {id} disappeared after insert"))
}

/// Record the channel's own name for the message a delivery created.
///
/// Only the holder of the live lease may write it, for the same reason only the
/// holder may mark the row delivered: a worker whose lease was reclaimed is no
/// longer the one that speaks for this row.
#[allow(dead_code)]
pub fn record_remote_id(db: &Database, id: &str, worker: &str, remote_id: &str) -> Result<()> {
    db.conn().execute(
        "UPDATE delivery_ledger SET remote_id = ?3, updated_at = ?4
         WHERE id = ?1 AND lease_owner = ?2",
        params![id, worker, remote_id, now_ms()],
    )?;
    Ok(())
}

/// Claim one claimable delivery for `worker`, leasing it for `lease_ms`.
///
/// Claimable means either `pending` and past its backoff gate, or `attempting`
/// with an expired lease (a worker that died mid-attempt). A successful claim
/// moves the row to `attempting`, counts the attempt, sets the lease, and
/// records whether this attempt is a redelivery. `Ok(None)` means nothing was
/// claimable.
///
/// Exclusion decision: the claim is a single `UPDATE ... WHERE id = (SELECT ...
/// LIMIT 1) ... RETURNING` statement rather than a read followed by a write.
/// SQLite runs one writer at a time, so the row a worker selects is the row it
/// updates — a second worker's statement re-evaluates the subquery against the
/// committed result (the row is now `attempting` with a live lease) and finds
/// nothing. That makes "exactly one worker per row" a property of one atomic
/// statement, not of holding a lock across two round-trips.
#[allow(dead_code)]
pub fn claim(db: &Database, worker: &str, lease_ms: i64) -> Result<Option<Delivery>> {
    let worker = worker.trim();
    if worker.is_empty() {
        return Err(anyhow!("delivery worker id must not be blank"));
    }
    let lease_ms = lease_ms.max(1);
    let now = now_ms();
    let lease_expires_at = now + lease_ms;
    let sql = format!(
        "UPDATE delivery_ledger
         SET state = 'attempting',
             attempts = attempts + 1,
             redelivery = CASE WHEN attempts > 0 THEN 1 ELSE 0 END,
             lease_owner = ?1,
             lease_expires_at = ?2,
             updated_at = ?3
         WHERE id = (
             SELECT id FROM delivery_ledger
             WHERE (state = 'pending'
                    AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
                OR (state = 'attempting'
                    AND lease_expires_at IS NOT NULL
                    AND lease_expires_at <= ?3)
             ORDER BY COALESCE(next_attempt_at, 0) ASC, created_at ASC, id ASC
             LIMIT 1
         )
         RETURNING {DELIVERY_COLUMNS}"
    );
    let mut stmt = db.conn().prepare_cached(&sql)?;
    Ok(stmt
        .query_row(params![worker, lease_expires_at, now], row_to_delivery)
        .optional()?)
}

/// Mark a claimed delivery delivered. Only the holder of the live lease may
/// complete it; any other caller — including one whose lease expired and was
/// reclaimed — gets `Ok(None)` and the row is left alone.
#[allow(dead_code)]
pub fn mark_delivered(db: &Database, id: &str, worker: &str) -> Result<Option<Delivery>> {
    let now = now_ms();
    let sql = format!(
        "UPDATE delivery_ledger
         SET state = 'delivered',
             delivered_at = ?3,
             updated_at = ?3,
             lease_owner = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL
         WHERE id = ?1 AND state = 'attempting' AND lease_owner = ?2
         RETURNING {DELIVERY_COLUMNS}"
    );
    let mut stmt = db.conn().prepare_cached(&sql)?;
    Ok(stmt
        .query_row(params![id, worker, now], row_to_delivery)
        .optional()?)
}

/// Record a failed attempt and decide what happens next.
///
/// Under the cap the row returns to `pending` with `next_attempt_at` moved out
/// by [`backoff_ms`], so it is not claimable until the delay elapses. At the cap
/// (`attempts >= max_attempts`) the row becomes terminal `failed`, keeps its
/// last error, and is never claimed again. Only the lease holder may report the
/// failure; anyone else gets `Ok(None)`.
#[allow(dead_code)]
pub fn mark_failed(db: &Database, id: &str, worker: &str, error: &str) -> Result<Option<Delivery>> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let current: Option<(i64, i64)> = tx
        .prepare_cached(
            "SELECT attempts, max_attempts FROM delivery_ledger
             WHERE id = ?1 AND state = 'attempting' AND lease_owner = ?2",
        )?
        .query_row(params![id, worker], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .optional()?;
    let Some((attempts, max_attempts)) = current else {
        return Ok(None);
    };
    let now = now_ms();
    // The cap lives here, in Rust: `attempts` counts attempts already started,
    // so the attempt that reaches `max_attempts` is the last one allowed.
    let (state, next_attempt_at, failed_at) = if attempts >= max_attempts {
        (DeliveryState::Failed, None, Some(now))
    } else {
        (
            DeliveryState::Pending,
            Some(now + backoff_ms(attempts)),
            None,
        )
    };
    let sql = format!(
        "UPDATE delivery_ledger
         SET state = ?3,
             next_attempt_at = ?4,
             failed_at = ?5,
             last_error = ?6,
             updated_at = ?7,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE id = ?1 AND state = 'attempting' AND lease_owner = ?2
         RETURNING {DELIVERY_COLUMNS}"
    );
    let row = tx.prepare_cached(&sql)?.query_row(
        params![
            id,
            worker,
            state.as_str(),
            next_attempt_at,
            failed_at,
            error,
            now
        ],
        row_to_delivery,
    )?;
    tx.commit()?;
    Ok(Some(row))
}

/// Mark a claimed delivery terminally failed without spending the attempt cap.
///
/// [`mark_failed`] spends the bounded retry budget on a failure that might
/// succeed later. When the caller classifies a send failure as permanent for
/// this delivery — the channel will reject the same payload forever, so no
/// later attempt can succeed — retrying only burns the budget. This writes the
/// same terminal `failed` state the cap would reach, keeps the last error, and
/// stops the row from being claimed again. Only the holder of the live lease
/// may take the transition; anyone else gets `Ok(None)` and the row is left
/// alone, exactly like [`mark_failed`].
#[allow(dead_code)]
pub fn mark_failed_terminal(
    db: &Database,
    id: &str,
    worker: &str,
    error: &str,
) -> Result<Option<Delivery>> {
    let now = now_ms();
    let sql = format!(
        "UPDATE delivery_ledger
         SET state = 'failed',
             failed_at = ?3,
             last_error = ?4,
             updated_at = ?3,
             lease_owner = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL
         WHERE id = ?1 AND state = 'attempting' AND lease_owner = ?2
         RETURNING {DELIVERY_COLUMNS}"
    );
    let mut stmt = db.conn().prepare_cached(&sql)?;
    Ok(stmt
        .query_row(params![id, worker, now, error], row_to_delivery)
        .optional()?)
}

/// Read one delivery by id.
#[allow(dead_code)]
pub fn get(db: &Database, id: &str) -> Result<Option<Delivery>> {
    let sql = format!("SELECT {DELIVERY_COLUMNS} FROM delivery_ledger WHERE id = ?1");
    let mut stmt = db.conn().prepare_cached(&sql)?;
    Ok(stmt.query_row(params![id], row_to_delivery).optional()?)
}

/// Every delivery, oldest first, or only those in `state`.
#[allow(dead_code)]
pub fn list(db: &Database, state: Option<DeliveryState>) -> Result<Vec<Delivery>> {
    let deliveries = match state {
        Some(state) => db
            .conn()
            .prepare_cached(&format!(
                "SELECT {DELIVERY_COLUMNS} FROM delivery_ledger WHERE state = ?1
                 ORDER BY created_at ASC, id ASC"
            ))?
            .query_map(params![state.as_str()], row_to_delivery)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        None => db
            .conn()
            .prepare_cached(&format!(
                "SELECT {DELIVERY_COLUMNS} FROM delivery_ledger ORDER BY created_at ASC, id ASC"
            ))?
            .query_map([], row_to_delivery)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(deliveries)
}

/// Reclaim deliveries a crash left mid-flight. Runs at Host startup.
///
/// Every row still in `attempting` belongs to a worker that is gone: its lease
/// either already expired or will once the window passes, but the process that
/// took it is never coming back to complete it. Recovery makes those rows
/// claimable again instead of leaving them stuck. A row whose attempt count
/// already reached its cap becomes terminal `failed` rather than being handed
/// out for an attempt past the bound; every other row returns to `pending` and
/// is claimable at once. The `last_error` marker is only written where the row
/// has none, so a real error from an earlier attempt is never overwritten.
///
/// Returns how many rows were reclaimed. Only the lease fields and state are
/// touched — attempts are not incremented here (the crashed attempt was already
/// counted when it was claimed).
pub(crate) fn recover_attempting(conn: &Connection) -> Result<usize> {
    let now = now_ms();
    let exhausted = conn.execute(
        "UPDATE delivery_ledger
         SET state = 'failed',
             failed_at = ?1,
             updated_at = ?1,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = COALESCE(last_error, ?2)
         WHERE state = 'attempting' AND attempts >= max_attempts",
        params![now, INTERRUPTED_ERROR],
    )?;
    let reclaimed = conn.execute(
        "UPDATE delivery_ledger
         SET state = 'pending',
             next_attempt_at = ?1,
             updated_at = ?1,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = COALESCE(last_error, ?2)
         WHERE state = 'attempting'",
        params![now, INTERRUPTED_ERROR],
    )?;
    Ok(exhausted + reclaimed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        (dir, db)
    }

    fn new_delivery(channel: &str) -> NewDelivery {
        NewDelivery {
            id: None,
            channel: channel.to_string(),
            payload: serde_json::json!({ "kind": "turn.completed", "turnId": "turn-1" }),
            max_attempts: None,
            operation: None,
            card_of: None,
        }
    }

    /// Move a row's backoff gate into the past, standing in for the delay
    /// elapsing. Reaches into the persisted column, not a private field.
    fn make_ready(db: &Database, id: &str) {
        db.conn()
            .execute(
                "UPDATE delivery_ledger SET next_attempt_at = 0 WHERE id = ?1",
                params![id],
            )
            .unwrap();
    }

    fn raw_next_attempt_at(db: &Database, id: &str) -> Option<i64> {
        db.conn()
            .query_row(
                "SELECT next_attempt_at FROM delivery_ledger WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn enqueue_persists_a_pending_delivery() {
        let (_dir, db) = open();
        let payload = serde_json::json!({ "kind": "approval.requested", "id": "a-1" });
        let input = NewDelivery {
            id: Some("delivery-1".into()),
            channel: "webhook".into(),
            payload: payload.clone(),
            max_attempts: None,
            operation: None,
            card_of: None,
        };
        let created = enqueue(&db, input).unwrap();
        assert_eq!(created.id, "delivery-1");
        assert_eq!(created.state, DeliveryState::Pending);
        assert_eq!(created.attempts, 0);
        assert_eq!(created.max_attempts, DEFAULT_MAX_ATTEMPTS);
        assert!(!created.redelivery);
        assert_eq!(created.payload, payload);
        assert!(created.lease_owner.is_none());
        // The row is persisted, not just returned.
        let stored = get(&db, "delivery-1").unwrap().unwrap();
        assert_eq!(stored, created);
        assert_eq!(list(&db, Some(DeliveryState::Pending)).unwrap().len(), 1);
    }

    #[test]
    fn a_delivery_without_an_operation_is_a_send() {
        let (_dir, db) = open();
        let created = enqueue(&db, new_delivery("telegram")).unwrap();
        assert_eq!(created.operation, DeliveryOperation::Send);
        assert_eq!(created.remote_id, None);
        let stored = get(&db, &created.id).unwrap().unwrap();
        assert_eq!(stored.operation, DeliveryOperation::Send);
    }

    #[test]
    fn an_edit_keeps_the_card_it_belongs_to_through_a_claim() {
        let (_dir, db) = open();
        let mut input = new_delivery("telegram");
        input.operation = Some(DeliveryOperation::Edit);
        input.card_of = Some("  card-4711  ".into());
        let created = enqueue(&db, input).unwrap();
        assert_eq!(created.operation, DeliveryOperation::Edit);
        assert_eq!(created.card_of.as_deref(), Some("card-4711"));
        assert_eq!(
            created.remote_id, None,
            "the channel's own message id is never an input"
        );

        let claimed = claim(&db, "worker-1", 30_000).unwrap().unwrap();
        assert_eq!(claimed.id, created.id);
        assert_eq!(claimed.operation, DeliveryOperation::Edit);
        assert_eq!(claimed.card_of.as_deref(), Some("card-4711"));
    }

    #[test]
    fn an_edit_must_name_the_card_it_belongs_to() {
        let (_dir, db) = open();
        let mut input = new_delivery("telegram");
        input.operation = Some(DeliveryOperation::Edit);
        let error = enqueue(&db, input).unwrap_err();
        assert!(
            error.to_string().contains("must name the card"),
            "unexpected refusal: {error}"
        );
        assert!(list(&db, None).unwrap().is_empty());
    }

    #[test]
    fn a_send_must_not_name_a_card() {
        let (_dir, db) = open();
        let mut input = new_delivery("telegram");
        input.card_of = Some("card-4711".into());
        let error = enqueue(&db, input).unwrap_err();
        assert!(
            error.to_string().contains("must not name a card"),
            "unexpected refusal: {error}"
        );
        assert!(list(&db, None).unwrap().is_empty());
    }

    #[test]
    fn enqueue_rejects_a_blank_channel() {
        let (_dir, db) = open();
        let mut input = new_delivery("webhook");
        input.channel = "   ".into();
        assert!(enqueue(&db, input).is_err());
        assert!(list(&db, None).unwrap().is_empty());
    }

    #[test]
    fn claim_leases_one_row_at_a_time_and_two_workers_get_different_rows() {
        let (_dir, db) = open();
        let a = enqueue(&db, new_delivery("webhook")).unwrap();
        let b = enqueue(&db, new_delivery("telegram")).unwrap();
        let first = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        let second = claim(&db, "worker-b", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert_ne!(
            first.id, second.id,
            "one row is never handed to two workers"
        );
        assert_eq!(first.state, DeliveryState::Attempting);
        assert_eq!(first.attempts, 1);
        assert_eq!(first.lease_owner.as_deref(), Some("worker-a"));
        assert!(!first.redelivery, "the first attempt is not a redelivery");
        assert!(first.lease_expires_at.is_some());
        let claimed_ids = [first.id.clone(), second.id.clone()];
        assert!(claimed_ids.contains(&a.id) && claimed_ids.contains(&b.id));
        // Both rows are now leased, so a third worker gets nothing.
        assert!(claim(&db, "worker-c", DEFAULT_LEASE_MS).unwrap().is_none());
    }

    #[test]
    fn claim_does_not_steal_a_live_lease_but_reclaims_an_expired_one() {
        let (_dir, db) = open();
        let d = enqueue(&db, new_delivery("webhook")).unwrap();
        let first = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert_eq!(first.id, d.id);
        assert!(
            claim(&db, "worker-b", DEFAULT_LEASE_MS).unwrap().is_none(),
            "a live lease is left alone"
        );
        // Expire the lease as a worker that stopped heartbeating would leave it.
        db.conn()
            .execute(
                "UPDATE delivery_ledger SET lease_expires_at = 0 WHERE id = ?1",
                params![d.id],
            )
            .unwrap();
        let reclaimed = claim(&db, "worker-b", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert_eq!(reclaimed.id, d.id, "an expired lease is reclaimable");
        assert_eq!(reclaimed.attempts, 2, "the re-claim counts a new attempt");
        assert!(reclaimed.redelivery, "the re-claim is marked a redelivery");
        assert_eq!(reclaimed.lease_owner.as_deref(), Some("worker-b"));
    }

    #[test]
    fn mark_delivered_requires_the_current_lease_holder() {
        let (_dir, db) = open();
        let d = enqueue(&db, new_delivery("webhook")).unwrap();
        claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert!(
            mark_delivered(&db, &d.id, "worker-b").unwrap().is_none(),
            "a non-holder cannot complete the delivery"
        );
        assert_eq!(
            get(&db, &d.id).unwrap().unwrap().state,
            DeliveryState::Attempting,
            "the failed completion attempt changed nothing"
        );
        let done = mark_delivered(&db, &d.id, "worker-a").unwrap().unwrap();
        assert_eq!(done.state, DeliveryState::Delivered);
        assert!(done.delivered_at.is_some());
        assert!(
            done.lease_owner.is_none(),
            "the lease is released on completion"
        );
        // Completing twice is a no-op, not a second transition.
        assert!(mark_delivered(&db, &d.id, "worker-a").unwrap().is_none());
        assert_eq!(list(&db, Some(DeliveryState::Delivered)).unwrap().len(), 1);
    }

    #[test]
    fn mark_failed_terminal_requires_the_current_lease_holder() {
        let (_dir, db) = open();
        let d = enqueue(&db, new_delivery("webhook")).unwrap();
        claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert!(
            mark_failed_terminal(&db, &d.id, "worker-b", "destination refused")
                .unwrap()
                .is_none(),
            "a non-holder cannot take the terminal transition"
        );
        assert_eq!(
            get(&db, &d.id).unwrap().unwrap().state,
            DeliveryState::Attempting,
            "the rejected terminal write changed nothing"
        );
        let terminal = mark_failed_terminal(&db, &d.id, "worker-a", "destination refused")
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, DeliveryState::Failed);
        assert!(terminal.failed_at.is_some());
        assert_eq!(
            terminal.last_error.as_deref(),
            Some("destination refused"),
            "the last error is kept"
        );
        assert!(
            terminal.lease_owner.is_none(),
            "the lease is released on the terminal write"
        );
        // A repeat terminal call is a no-op, not a second transition.
        assert!(
            mark_failed_terminal(&db, &d.id, "worker-a", "destination refused")
                .unwrap()
                .is_none()
        );
        assert_eq!(list(&db, Some(DeliveryState::Failed)).unwrap().len(), 1);
    }

    #[test]
    fn retry_backs_off_and_after_the_cap_keeps_a_terminal_failure() {
        let (_dir, db) = open();
        let mut input = new_delivery("webhook");
        input.max_attempts = Some(3);
        let d = enqueue(&db, input).unwrap();
        assert_eq!(d.max_attempts, 3);

        for expected_attempt in 1..=2 {
            let claimed = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
            assert_eq!(claimed.attempts, expected_attempt);
            let failed = mark_failed(&db, &d.id, "worker-a", "connection refused")
                .unwrap()
                .unwrap();
            assert_eq!(
                failed.state,
                DeliveryState::Pending,
                "under the cap a delivery is retried"
            );
            assert_eq!(failed.last_error.as_deref(), Some("connection refused"));
            assert!(
                claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().is_none(),
                "a retry waits for its backoff before it is claimable"
            );
            // The gate is a real, future timestamp in the persisted row.
            let gate = raw_next_attempt_at(&db, &d.id).unwrap();
            assert!(gate > 0, "the retry carries a backoff gate");
            make_ready(&db, &d.id);
        }

        let final_claim = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert_eq!(final_claim.attempts, 3);
        let terminal = mark_failed(&db, &d.id, "worker-a", "connection refused")
            .unwrap()
            .unwrap();
        assert_eq!(
            terminal.state,
            DeliveryState::Failed,
            "the third attempt is the cap"
        );
        assert!(terminal.failed_at.is_some());
        assert_eq!(
            terminal.last_error.as_deref(),
            Some("connection refused"),
            "the last error is kept, not discarded"
        );
        // The row survives in a terminal failed state and is never claimed again.
        let stored = get(&db, &d.id).unwrap().expect("a failed row is retained");
        assert_eq!(stored.state, DeliveryState::Failed);
        assert!(claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().is_none());
    }

    #[test]
    fn backoff_schedule_grows_exponentially_then_caps() {
        assert_eq!(backoff_ms(1), BACKOFF_BASE_MS);
        assert_eq!(backoff_ms(2), BACKOFF_BASE_MS * 2);
        assert_eq!(backoff_ms(3), BACKOFF_BASE_MS * 4);
        assert_eq!(backoff_ms(4), BACKOFF_BASE_MS * 8);
        assert_eq!(
            backoff_ms(50),
            BACKOFF_MAX_MS,
            "the delay never passes the cap"
        );
        assert_eq!(
            backoff_ms(0),
            BACKOFF_BASE_MS,
            "an unmapped count uses the base delay"
        );
    }

    #[test]
    fn redelivery_is_persisted_for_a_repeat_attempt() {
        let (_dir, db) = open();
        let d = enqueue(&db, new_delivery("telegram")).unwrap();
        let first = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert!(!first.redelivery);
        mark_failed(&db, &d.id, "worker-a", "boom")
            .unwrap()
            .unwrap();
        make_ready(&db, &d.id);
        let second = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert!(second.redelivery, "a retry is marked a redelivery");
        // The flag is durable state, not reconstructed at read time.
        assert!(get(&db, &d.id).unwrap().unwrap().redelivery);
    }

    #[test]
    fn recover_inflight_reclaims_an_attempting_row_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let id;
        {
            let db = Database::open(&path).unwrap();
            id = enqueue(&db, new_delivery("webhook")).unwrap().id;
            let claimed = claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
            assert_eq!(claimed.state, DeliveryState::Attempting);
            // The worker is killed mid-attempt: the database is closed with the
            // row still 'attempting' and no mark_delivered / mark_failed ever ran.
        }

        let db = Database::open(&path).unwrap();
        let recovered = get(&db, &id)
            .unwrap()
            .expect("an interrupted delivery survives the restart");
        assert_eq!(
            recovered.state,
            DeliveryState::Pending,
            "a crashed attempt is reclaimed, never stuck in 'attempting'"
        );
        assert!(
            recovered.lease_owner.is_none(),
            "the dead worker's lease is cleared"
        );
        assert_eq!(
            recovered.last_error.as_deref(),
            Some("DELIVERY_INTERRUPTED")
        );

        let reclaimed = claim(&db, "worker-b", DEFAULT_LEASE_MS).unwrap().unwrap();
        assert_eq!(reclaimed.id, id);
        assert_eq!(reclaimed.attempts, 2);
        assert!(reclaimed.redelivery, "the recovery attempt is a redelivery");
        assert_eq!(
            mark_delivered(&db, &id, "worker-b").unwrap().unwrap().state,
            DeliveryState::Delivered
        );
    }

    #[test]
    fn recover_marks_an_exhausted_interrupted_attempt_as_failed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let id;
        {
            let db = Database::open(&path).unwrap();
            let mut input = new_delivery("webhook");
            input.max_attempts = Some(1);
            id = enqueue(&db, input).unwrap().id;
            // The first (and only permitted) attempt is claimed, then the crash.
            claim(&db, "worker-a", DEFAULT_LEASE_MS).unwrap().unwrap();
        }
        let db = Database::open(&path).unwrap();
        let recovered = get(&db, &id).unwrap().unwrap();
        assert_eq!(
            recovered.state,
            DeliveryState::Failed,
            "an interrupted attempt already at the cap is terminal, not retried past it"
        );
        assert!(recovered.failed_at.is_some());
        assert!(claim(&db, "worker-b", DEFAULT_LEASE_MS).unwrap().is_none());
    }

    #[test]
    fn a_v22_database_upgrades_with_existing_data_and_the_ledger_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            // Pre-existing user data a v22 database would already hold.
            db.set_setting("deliveryTest", &serde_json::json!({ "kept": true }))
                .unwrap();
            // Force the pre-v23 shape: drop the ledger so the migration has real
            // work, then rewind the version marker.
            db.conn()
                .execute_batch("DROP TABLE IF EXISTS delivery_ledger;")
                .unwrap();
            db.conn().pragma_update(None, "user_version", 22).unwrap();
        }
        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::db::SCHEMA_VERSION);
        assert!(crate::db::migration_backup_path(&path, 22).exists());
        // The additive migration leaves existing data untouched.
        assert_eq!(
            db.get_setting("deliveryTest").unwrap().unwrap()["kept"],
            serde_json::json!(true)
        );
        // The new table is usable immediately after the upgrade.
        let d = enqueue(&db, new_delivery("webhook")).unwrap();
        assert_eq!(
            claim(&db, "worker-a", DEFAULT_LEASE_MS)
                .unwrap()
                .unwrap()
                .id,
            d.id
        );
    }
}
