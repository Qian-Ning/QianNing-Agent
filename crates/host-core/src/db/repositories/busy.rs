//! SQLite writer contention policy.
//!
//! WAL gives readers a snapshot, but it still allows exactly one writer at a
//! time. A transaction that begins `DEFERRED` can read for a while and only then
//! discover that it needs the writer lock; in that upgrade case SQLite cannot
//! wait for the competing writer, because doing so would break the snapshot the
//! transaction already read. It returns `SQLITE_BUSY` (often
//! `SQLITE_BUSY_SNAPSHOT` in WAL) immediately, before `busy_timeout` gets a
//! chance to retry.
//!
//! Every connection opened through [`Database`](crate::db::Database) therefore
//! begins transactions `IMMEDIATE`: the writer lock is taken before the first
//! statement, so a busy database waits in one place instead of failing halfway
//! through a write. The wait is bounded by [`WRITE_BUDGET`] and the sleep before
//! each retry is jittered, so several connections that hit the same writer do
//! not wake in lockstep.
//!
//! This is a per-lock-event budget, not a timeout on the transaction itself.
//! Once the lock is held, a slow statement is still allowed to finish; the
//! budget only decides how long a writer may wait to get in.

use std::cell::Cell;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, TransactionBehavior};

/// How long one connection waits for a competing SQLite writer before the
/// operation fails with `SQLITE_BUSY`.
pub(crate) const WRITE_BUDGET: Duration = Duration::from_millis(WRITE_BUDGET_MS);
const WRITE_BUDGET_MS: u64 = 5_000;
const MAX_BACKOFF_MS: u64 = 50;

thread_local! {
    /// Per-connection jitter state. SQLite's safe busy-handler API is a plain
    /// function pointer, so the entropy lives on the thread that drives the
    /// connection instead of in a captured closure.
    static JITTER_STATE: Cell<u64> = const { Cell::new(0) };
    /// Start of the current lock wait. SQLite resets its attempt count to zero
    /// for each new lock event, so attempt zero means "start a new budget".
    static BUSY_START: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Apply the writer policy to a freshly opened connection.
pub(crate) fn install(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.set_transaction_behavior(TransactionBehavior::Immediate);
    JITTER_STATE.with(|state| state.set(seed()));
    BUSY_START.with(|state| state.set(None));
    conn.busy_handler(Some(wait_for_writer))
}

/// SQLite busy callback. `attempt` counts the prior callbacks for this lock
/// event; returning `true` asks SQLite to retry the operation.
fn wait_for_writer(attempt: i32) -> bool {
    let attempt = u32::try_from(attempt).unwrap_or(0);
    let now = Instant::now();
    let started = BUSY_START.with(|state| {
        if attempt == 0 || state.get().is_none() {
            state.set(Some(now));
        }
        state.get().unwrap_or(now)
    });

    let Some(remaining) = remaining_budget(started, now) else {
        return false;
    };
    let max_sleep_ms = jittered_delay_ms(attempt, next_random());
    let remaining_ms = u64::try_from(remaining.as_millis()).unwrap_or(u64::MAX);
    let sleep_ms = max_sleep_ms.min(remaining_ms);
    if sleep_ms == 0 {
        return false;
    }
    thread::sleep(Duration::from_millis(sleep_ms));
    true
}

fn remaining_budget(started: Instant, now: Instant) -> Option<Duration> {
    let elapsed = now.saturating_duration_since(started);
    (elapsed < WRITE_BUDGET).then(|| WRITE_BUDGET - elapsed)
}

fn max_delay_ms(attempt: u32) -> u64 {
    let shift = attempt.min(6);
    (1u64 << shift).min(MAX_BACKOFF_MS)
}

/// Jittered exponential backoff, bounded to `[ceil(max/2), max]` per step.
fn jittered_delay_ms(attempt: u32, entropy: u64) -> u64 {
    let max = max_delay_ms(attempt);
    let floor = (max / 2).max(1);
    let span = max - floor + 1;
    floor + entropy % span
}

fn next_random() -> u64 {
    JITTER_STATE.with(|state| {
        let mut value = state.get();
        if value == 0 {
            value = seed();
        }
        value ^= value >> 12;
        value ^= value << 25;
        value ^= value >> 27;
        value = value.wrapping_mul(0x2545_F491_4F6C_DD1D);
        state.set(value);
        value
    })
}

fn seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    (nanos ^ ((std::process::id() as u64) << 32)) | 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use rusqlite::params;
    use tempfile::tempdir;

    #[test]
    fn jitter_stays_inside_the_backoff_step() {
        for attempt in 0..20 {
            let max = max_delay_ms(attempt);
            let floor = (max / 2).max(1);
            for entropy in [0, 1, 7, u64::MAX / 2, u64::MAX] {
                let delay = jittered_delay_ms(attempt, entropy);
                assert!(
                    (floor..=max).contains(&delay),
                    "attempt {attempt}: {delay} outside {floor}..={max}"
                );
            }
        }
    }

    #[test]
    fn the_budget_expires_after_five_seconds() {
        let started = Instant::now();
        assert_eq!(remaining_budget(started, started), Some(WRITE_BUDGET));
        assert!(
            remaining_budget(started, started + WRITE_BUDGET - Duration::from_millis(1)).is_some()
        );
        assert!(remaining_budget(started, started + WRITE_BUDGET).is_none());
    }

    #[test]
    fn write_transaction_takes_the_writer_lock_before_its_first_statement() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();

        // No statement has run inside this transaction, so a DEFERRED begin
        // would still let the second connection insert.
        let tx = db.conn().unchecked_transaction().unwrap();
        let other = Connection::open(&path).unwrap();
        other.busy_timeout(Duration::ZERO).unwrap();

        let blocked = other.execute(
            "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params!["test", "write-lock-late", "{}", 0],
        );
        match blocked {
            Err(rusqlite::Error::SqliteFailure(error, _)) => {
                assert_eq!(error.code, rusqlite::ErrorCode::DatabaseBusy);
            }
            other => panic!("expected SQLITE_BUSY while the writer is held, got {other:?}"),
        }

        drop(tx);
        other
            .execute(
                "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params!["test", "write-lock-late", "{}", 0],
            )
            .unwrap();
    }

    #[test]
    fn a_held_writer_returns_busy_after_the_budget() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let contender = Database::open(&path).unwrap();

        let tx = db.conn().unchecked_transaction().unwrap();
        let started = Instant::now();
        let error = contender.conn().unchecked_transaction().unwrap_err();
        let elapsed = started.elapsed();

        match error {
            rusqlite::Error::SqliteFailure(error, _) => {
                assert_eq!(error.code, rusqlite::ErrorCode::DatabaseBusy);
            }
            other => panic!("expected SQLITE_BUSY after the budget, got {other:?}"),
        }
        assert!(
            elapsed >= WRITE_BUDGET - Duration::from_millis(100),
            "returned before the budget: {elapsed:?}"
        );
        assert!(
            elapsed < WRITE_BUDGET + Duration::from_secs(2),
            "waited past the budget: {elapsed:?}"
        );
        drop(tx);
    }
}
