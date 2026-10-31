//! The outbound messaging integration adapter contract (ADR 0205 D375 item 9,
//! rollout R3, step 2).
//!
//! The messaging integration is a further caller of the Host module that runs
//! beside it: it relays redacted event summaries to the outbound channels the
//! user configured, and maps a fixed command vocabulary onto turn and approval
//! operations. This module is only the relay side's *contract* — the seam every
//! outbound channel plugs into — plus the hand-off that drives the durable
//! delivery ledger. It contains no transport: no HTTP client, no webhook
//! sender, no socket, and no inbound listener. A concrete adapter is registered
//! from outside this module.
//!
//! The component boundary fixes three prohibitions on the adapter, and this
//! contract keeps all three: it holds no permission policy (it never decides an
//! approval or a mode), it opens no inbound listener (a channel only receives
//! what the Host hands it through [`OutboundAdapter::send`]), and it carries no
//! raw transcript content (the payload is the caller's already-redacted
//! summary, stored and forwarded verbatim).
//!
//! The shape is deliberately thin. A concrete adapter implements exactly three
//! methods — [`OutboundAdapter::connect`], [`OutboundAdapter::disconnect`], and
//! [`OutboundAdapter::send`] — and every other method on the trait has a
//! default, so an implementor never writes more than those three. `send`
//! returns a structured [`SendResult`] whose failure carries a [`FailureKind`],
//! so the caller can tell a transient failure (retry on the ledger's backoff)
//! from a permanent one (end the delivery now) instead of collapsing both into
//! a bare error.
//!
//! Registration is explicit and name-keyed ([`AdapterRegistry`]); there is no
//! metadata scan and no discovery of files on disk. The hand-off
//! ([`enqueue_for`] and the attempt cycle's [`begin_attempt`] then
//! [`finish_attempt`]) is the only bridge to persistence, and it is a thin
//! wrapper over `delivery_ledger`, which stays the single owner of the delivery
//! state machine, its retry/backoff schedule, and its terminal `failed` state.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::db::Database;
use crate::delivery_ledger::{
    self, Delivery, DeliveryOperation, DeliveryState, NewDelivery, DEFAULT_LEASE_MS,
    DEFAULT_MAX_ATTEMPTS,
};
use crate::messaging_outbound::failed;

// The forwarding end of the R3 milestone has two halves, and only one of them is
// wired. The hand-off the Host spends today — `enqueue_for`, the attempt
// cycle's `begin_attempt` and `finish_attempt`, and their `OutboundMessage` and
// `AttemptOutcome` — is reached in production by the messaging.* RPC family and
// its attempt-cycle driver, so it carries no lint allowance. The inline
// `attempt_one` composer is that same cycle with the send run between the two
// halves and no lock released, so it is compiled only for the tests that drive
// the cycle without a host lock. The contract a concrete outbound channel
// implements is now reached as well: the webhook channel (`messaging_webhook`)
// registers itself into the registry at state construction, builds `SendResult`
// and `FailureKind` for every attempt, and has its `connect` run there, so those
// items carry no allowance either. What is still unreached by Host wiring keeps
// its own item-scoped `#[allow(dead_code)]` with the removal condition recorded
// on the item: the trait's `disconnect` waits for a shutdown pass, and the
// registry's `names` and `disconnect_all` wait for a caller that enumerates or
// releases channels — `rpc/mod.rs` holds the recorded ceiling that forbids
// growing it to add one.

/// Why a send attempt did not succeed, and whether a retry can help.
///
/// This is the caller-facing half of [`SendResult`]: it is the fact the ledger
/// cannot derive on its own, because whether a failure is worth retrying is a
/// property of the channel, not of the delivery's attempt count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The attempt may succeed later (a timeout, a throttled or unavailable
    /// channel). The ledger retries it on its bounded backoff.
    Retryable,
    /// The channel will reject this delivery forever (a malformed or refused
    /// payload, a revoked destination). No later attempt can succeed, so the
    /// delivery ends terminally now.
    Terminal,
}

/// The structured result of one [`OutboundAdapter::send`].
///
/// A caller classifies it without inspecting an opaque error: `Delivered` means
/// the channel accepted the delivery, and `Failed` carries the [`FailureKind`]
/// that decides retry versus terminal plus the detail to record as the last
/// error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendResult {
    /// The channel accepted the delivery.
    ///
    /// `remote_id` is whatever the channel names the created message by, when it
    /// names one at all: it is what a later edit addresses. A channel that
    /// returns nothing leaves it `None`, and a caller must read that as "this
    /// message cannot be edited later", never as a failed delivery.
    Delivered { remote_id: Option<String> },
    /// The attempt failed. `kind` decides what happens next; `detail` is kept
    /// as the delivery's last error.
    Failed { kind: FailureKind, detail: String },
}

/// One delivery handed to an adapter for one attempt.
///
/// It carries only what a channel needs to send and to tell a receiver the
/// payload may be a duplicate: the delivery id, its channel, the redacted
/// payload, and whether this attempt is a redelivery. It is not a transcript
/// and holds no lease, attempt, or permission state.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboundMessage {
    /// The ledger's delivery id, so a receiver can correlate a redelivery.
    pub id: String,
    /// The channel this delivery belongs to (the adapter's registered name).
    pub channel: String,
    /// The caller's already-redacted summary, forwarded verbatim.
    pub payload: serde_json::Value,
    /// Whether an earlier attempt for this delivery may already have been sent.
    pub redelivery: bool,
}

/// The thin contract every outbound channel implements.
///
/// An implementor provides exactly three methods: [`connect`](Self::connect),
/// [`disconnect`](Self::disconnect), and [`send`](Self::send). Every other
/// method is defaulted, so a channel that needs nothing else writes nothing
/// else.
// `disconnect` is not yet called by Host wiring: there is no channel shutdown
// pass, because the one registered channel is released by the process ending
// (removal condition — drop when a shutdown pass releases registered channels;
// `connect`, `send`, and `attempt_bound` are already used).
#[allow(dead_code)]
pub trait OutboundAdapter: Send + Sync {
    /// Prepare the channel for sends. Called once before the first `send` and
    /// again after a restart. Must not open an inbound listener.
    fn connect(&mut self) -> Result<()>;

    /// Release whatever [`connect`](Self::connect) acquired. Called once at
    /// shutdown; must be safe to call when the channel was never connected.
    fn disconnect(&mut self) -> Result<()>;

    /// Attempt one delivery. The caller releases every host lock before this
    /// call and treats the returned [`SendResult`] as the whole outcome; a
    /// channel may wait on its own transport, but no guarded Host state may be
    /// held across that wait.
    fn send(&self, message: &OutboundMessage) -> SendResult;

    /// Replace the text of a message this channel created.
    ///
    /// `remote_id` is the name the channel gave that message when it was sent.
    /// The default refuses, because a channel that cannot edit must fail loudly
    /// rather than fall back to sending a second message the turn never asked
    /// for; an adapter that can edit overrides this and decides for itself
    /// whether a failure is retryable.
    fn edit(&self, _message: &OutboundMessage, _remote_id: &str) -> SendResult {
        failed(FailureKind::Terminal, "this channel cannot edit a message")
    }

    /// Show the channel's own "working on it" indicator in a conversation.
    ///
    /// This is a hint, not a delivery: nothing is persisted, nothing is retried,
    /// and the answer says only whether the platform accepted it once. A channel
    /// with no such indicator keeps the default and reports `false`, so a caller
    /// never has to know which channels have one.
    fn typing(&self, _chat: &str) -> bool {
        false
    }

    /// The delivery's default attempt cap, so the ledger's retry/backoff bound
    /// can follow the channel's own policy. Defaults to the ledger's cap for a
    /// channel that does not override it.
    fn attempt_bound(&self) -> i64 {
        DEFAULT_MAX_ATTEMPTS
    }
}

/// A name-keyed registry of outbound adapters.
///
/// Registration is explicit: a caller registers an adapter under a name, and
/// lookup is by that name. There is no metadata scan and no discovery of files,
/// so a channel exists here only because a caller put it here.
#[derive(Default)]
pub struct AdapterRegistry {
    adapters: HashMap<String, Arc<dyn OutboundAdapter>>,
}

// `names` and `disconnect_all` are not yet reached by Host wiring: nothing
// enumerates the registry and the release pass waits for a shutdown caller
// (removal condition — drop when a caller names or releases registered
// channels; `new`, `get`, `register`, and `connect_all` are already used).
#[allow(dead_code)]
impl AdapterRegistry {
    /// An empty registry. Nothing is registered until [`register`](Self::register).
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `adapter` under `name`. The name is the delivery channel used
    /// by the ledger, so it must be non-blank, and it must be unique: a second
    /// registration under a live name is rejected rather than silently
    /// replacing the first.
    pub fn register(&mut self, name: &str, adapter: Box<dyn OutboundAdapter>) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(anyhow!("adapter name must not be blank"));
        }
        if self.adapters.contains_key(name) {
            return Err(anyhow!("an adapter is already registered as '{name}'"));
        }
        self.adapters.insert(name.to_string(), Arc::from(adapter));
        Ok(())
    }

    /// Look up the adapter registered under `name`, or `None` when no caller
    /// registered one.
    pub fn get(&self, name: &str) -> Option<&dyn OutboundAdapter> {
        self.adapters.get(name).map(|adapter| adapter.as_ref())
    }

    /// A shared handle to the adapter registered under `name`.
    ///
    /// The registry keeps its own reference, so a caller can carry this handle
    /// out of the guarded state and run a send with the host lock released —
    /// the same discipline the config-sync transport uses for its own network
    /// wait. The channel stays alive as long as it stays registered.
    pub fn get_shared(&self, name: &str) -> Option<Arc<dyn OutboundAdapter>> {
        self.adapters.get(name).cloned()
    }

    /// Every registered name, sorted, so a caller iterates deterministically.
    pub fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.adapters.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Connect every registered adapter, in name order. A failing `connect`
    /// stops the pass and names the channel, so the Host can report which one.
    ///
    /// A registered channel can also be held by a shared handle mid-send, which
    /// no `connect` may happen behind; that channel is reported rather than
    /// mutated through another reference.
    pub fn connect_all(&mut self) -> Result<()> {
        for name in self.sorted_names() {
            let adapter = self
                .adapters
                .get_mut(&name)
                .ok_or_else(|| anyhow!("adapter '{name}' vanished during connect"))?;
            let adapter = Arc::get_mut(adapter).ok_or_else(|| {
                anyhow!("adapter '{name}' is shared and cannot be connected while in use")
            })?;
            adapter
                .connect()
                .map_err(|error| anyhow!("adapter '{name}' failed to connect: {error}"))?;
        }
        Ok(())
    }

    /// Disconnect every registered adapter, in name order, for Host shutdown.
    pub fn disconnect_all(&mut self) -> Result<()> {
        for name in self.sorted_names() {
            let adapter = self
                .adapters
                .get_mut(&name)
                .ok_or_else(|| anyhow!("adapter '{name}' vanished during disconnect"))?;
            let adapter = Arc::get_mut(adapter).ok_or_else(|| {
                anyhow!("adapter '{name}' is shared and cannot be disconnected while in use")
            })?;
            adapter
                .disconnect()
                .map_err(|error| anyhow!("adapter '{name}' failed to disconnect: {error}"))?;
        }
        Ok(())
    }

    fn sorted_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.adapters.keys().cloned().collect();
        names.sort();
        names
    }
}

/// Enqueue one outbound item for a registered channel.
///
/// The delivery is born in the ledger's `pending` state, and its attempt bound
/// comes from the adapter, so the ledger's retry/backoff rules follow the
/// channel's own policy. A channel with no registered adapter is rejected here
/// instead of being enqueued to nowhere.
pub fn enqueue_for(
    db: &Database,
    registry: &AdapterRegistry,
    channel: &str,
    payload: serde_json::Value,
) -> Result<Delivery> {
    let key = channel.trim();
    let adapter = registry
        .get(key)
        .ok_or_else(|| anyhow!("no outbound adapter registered for channel '{key}'"))?;
    delivery_ledger::enqueue(
        db,
        NewDelivery {
            id: None,
            channel: key.to_string(),
            payload,
            max_attempts: Some(adapter.attempt_bound()),
            operation: None,
            card_of: None,
        },
    )
}

/// What one attempt cycle did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptOutcome {
    /// Nothing was due, or nothing was claimable behind its backoff gate.
    Idle,
    /// A due delivery was sent and the channel accepted it.
    Delivered { id: String },
    /// A delivery's attempt failed retryably; the ledger rescheduled it.
    Retried { id: String, error: String },
    /// A delivery reached terminal `failed` and will not be attempted again.
    Failed { id: String, error: String },
}

/// The start of one attempt cycle, in the form a caller that must release the
/// host lock needs.
///
/// [`begin_attempt`] claims a due delivery while the caller holds the lock and
/// resolves everything the send needs into a [`PreparedAttempt`]. The caller
/// then drops the lock and runs [`PreparedAttempt::send`], and [`finish_attempt`]
/// records the outcome once the lock is held again. The send stays on the
/// ledger's attempt cycle; only the lock is released across it, so a slow
/// channel never holds guarded Host state while it waits.
pub enum AttemptStart {
    /// Nothing was due, or nothing was claimable behind its backoff gate.
    Idle,
    /// The claim was settled inside the ledger without a send — a delivery
    /// whose channel has no registered adapter ends terminally.
    Settled(AttemptOutcome),
    /// Claimed and resolved: send through the channel, then record the result
    /// with [`finish_attempt`].
    Ready(PreparedAttempt),
}

/// A claimed delivery whose channel is resolved and whose send is ready to run.
///
/// It carries its own reference to the channel, so the send does not borrow the
/// registry and can run with the host lock released.
pub struct PreparedAttempt {
    id: String,
    adapter: Arc<dyn OutboundAdapter>,
    message: OutboundMessage,
    operation: DeliveryOperation,
    /// For an edit: the channel's name for the message being rewritten.
    remote_id: Option<String>,
}

impl PreparedAttempt {
    /// Attempt the send through the resolved channel.
    ///
    /// This is the one step of the cycle that can block, so the caller must not
    /// hold the host state lock across it.
    pub fn send(&self) -> SendResult {
        match self.operation {
            DeliveryOperation::Send => self.adapter.send(&self.message),
            DeliveryOperation::Edit => match self.remote_id.as_deref() {
                Some(remote_id) => self.adapter.edit(&self.message, remote_id),
                // begin_attempt resolves the id before it prepares an edit, so
                // reaching here means the row and the resolution disagree.
                None => failed(
                    FailureKind::Terminal,
                    "an edit delivery reached the channel without a message to rewrite",
                ),
            },
        }
    }
}

/// Claim one due delivery and resolve its channel, without waiting on it yet.
///
/// Pairs with [`finish_attempt`]: a caller that holds the host lock uses this
/// to take everything the send needs out of the guarded state, then drops the
/// lock for the send. A caller that holds no such lock can instead call
/// `attempt_one`, which runs the two halves around the send itself.
pub fn begin_attempt(
    db: &Database,
    registry: &AdapterRegistry,
    worker: &str,
) -> Result<AttemptStart> {
    let Some(delivery) = delivery_ledger::claim(db, worker, DEFAULT_LEASE_MS)? else {
        return Ok(AttemptStart::Idle);
    };
    let id = delivery.id.clone();

    let Some(adapter) = registry.get_shared(&delivery.channel) else {
        // A delivery for a channel no caller registered can never be sent, so
        // it is terminal rather than left to cycle through its budget.
        let error = format!(
            "no outbound adapter registered for channel '{}'",
            delivery.channel
        );
        return match delivery_ledger::mark_failed_terminal(db, &id, worker, &error)? {
            Some(_) => Ok(AttemptStart::Settled(AttemptOutcome::Failed { id, error })),
            None => Err(lease_write_missed(&id, worker, "failed")),
        };
    };

    // An edit addresses the message a previous delivery created, so the
    // channel's name for that message is resolved here, under the same claim
    // that will carry the edit. A card that does not exist yet is a reason to
    // wait; a card that never names a message is a reason to stop.
    let (operation, remote_id) = match delivery.operation {
        DeliveryOperation::Send => (DeliveryOperation::Send, None),
        DeliveryOperation::Edit => {
            let Some(card_id) = delivery.card_of.as_deref() else {
                let error = "an edit delivery names no card".to_string();
                return match delivery_ledger::mark_failed_terminal(db, &id, worker, &error)? {
                    Some(_) => Ok(AttemptStart::Settled(AttemptOutcome::Failed { id, error })),
                    None => Err(lease_write_missed(&id, worker, "failed")),
                };
            };
            match delivery_ledger::get(db, card_id)? {
                Some(card) if card.state == DeliveryState::Delivered => {
                    let Some(remote_id) = card.remote_id else {
                        let error = format!("the card '{card_id}' has no message to rewrite");
                        return match delivery_ledger::mark_failed_terminal(db, &id, worker, &error)?
                        {
                            Some(_) => {
                                Ok(AttemptStart::Settled(AttemptOutcome::Failed { id, error }))
                            }
                            None => Err(lease_write_missed(&id, worker, "failed")),
                        };
                    };
                    (DeliveryOperation::Edit, Some(remote_id))
                }
                Some(_) => {
                    let error = format!("the card '{card_id}' has no message yet");
                    let row = delivery_ledger::mark_failed(db, &id, worker, &error)?;
                    return Ok(match row.map(|row| row.state) {
                        Some(DeliveryState::Failed) => {
                            AttemptStart::Settled(AttemptOutcome::Failed { id, error })
                        }
                        _ => AttemptStart::Settled(AttemptOutcome::Retried { id, error }),
                    });
                }
                None => {
                    let error = format!("the card '{card_id}' does not exist");
                    return match delivery_ledger::mark_failed_terminal(db, &id, worker, &error)? {
                        Some(_) => Ok(AttemptStart::Settled(AttemptOutcome::Failed { id, error })),
                        None => Err(lease_write_missed(&id, worker, "failed")),
                    };
                }
            }
        }
    };

    Ok(AttemptStart::Ready(PreparedAttempt {
        id: id.clone(),
        adapter,
        operation,
        remote_id,
        message: OutboundMessage {
            id,
            channel: delivery.channel.clone(),
            payload: delivery.payload.clone(),
            redelivery: delivery.redelivery,
        },
    }))
}

/// Record the outcome of a send the caller ran with [`PreparedAttempt::send`].
///
/// The ledger stays the single owner of persistence: under a retryable failure
/// it reschedules behind the backoff gate, and the attempt that reaches the cap
/// becomes terminal failed.
pub fn finish_attempt(
    db: &Database,
    worker: &str,
    prepared: &PreparedAttempt,
    result: SendResult,
) -> Result<AttemptOutcome> {
    let id = prepared.id.clone();
    match result {
        SendResult::Delivered { remote_id } => {
            // Written before the row is marked delivered, because delivery is
            // what clears the lease and the write is lease-scoped: afterwards
            // this worker is no longer the one that speaks for the row.
            if let Some(remote_id) = remote_id.as_deref() {
                delivery_ledger::record_remote_id(db, &id, worker, remote_id)?;
            }
            match delivery_ledger::mark_delivered(db, &id, worker)? {
                Some(_) => Ok(AttemptOutcome::Delivered { id }),
                None => Err(lease_write_missed(&id, worker, "delivered")),
            }
        }
        SendResult::Failed {
            kind: FailureKind::Terminal,
            detail,
        } => match delivery_ledger::mark_failed_terminal(db, &id, worker, &detail)? {
            Some(_) => Ok(AttemptOutcome::Failed { id, error: detail }),
            None => Err(lease_write_missed(&id, worker, "failed")),
        },
        SendResult::Failed {
            kind: FailureKind::Retryable,
            detail,
        } => {
            // The ledger owns the retry decision: under the cap it reschedules
            // behind the backoff gate, and the attempt that reaches the cap
            // becomes terminal failed.
            let row = delivery_ledger::mark_failed(db, &id, worker, &detail)?;
            match row.map(|row| row.state) {
                Some(DeliveryState::Failed) => Ok(AttemptOutcome::Failed { id, error: detail }),
                _ => Ok(AttemptOutcome::Retried { id, error: detail }),
            }
        }
    }
}

/// Claim one due delivery, send it through its channel, and record the result.
///
/// This is the whole attempt cycle the Host drives: claim at most one due item,
/// hand it to the registered adapter, and let the ledger decide what the
/// outcome means. It runs the send inline, so a caller that holds the host
/// state lock must use [`begin_attempt`] and [`finish_attempt`] instead, with
/// the send between them and no lock held. A retryable failure returns the item
/// to the ledger's bounded backoff and, at the attempt cap, terminals it; a
/// terminal failure ends it immediately. The ledger stays the single owner of
/// persistence — this function only calls it, never writes delivery state
/// itself.
#[cfg(test)]
pub fn attempt_one(
    db: &Database,
    registry: &AdapterRegistry,
    worker: &str,
) -> Result<AttemptOutcome> {
    match begin_attempt(db, registry, worker)? {
        AttemptStart::Idle => Ok(AttemptOutcome::Idle),
        AttemptStart::Settled(outcome) => Ok(outcome),
        AttemptStart::Ready(prepared) => {
            let result = prepared.send();
            finish_attempt(db, worker, &prepared, result)
        }
    }
}

/// The claim lease was not held when the cycle's terminal write ran, so the
/// transition did not land. Reported as an error rather than an outcome, so a
/// caller is never told a delivery was delivered or failed when the ledger
/// recorded neither.
fn lease_write_missed(id: &str, worker: &str, intended: &str) -> anyhow::Error {
    anyhow!(
        "delivery '{id}' was not marked {intended}: worker '{worker}' no longer holds its claim lease"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use rusqlite::params;
    use serde_json::json;

    /// What a fake adapter records while the tests drive it.
    #[derive(Default)]
    struct FakeLedger {
        connects: usize,
        disconnects: usize,
        sent: Vec<OutboundMessage>,
        /// Every edit the adapter was asked to perform, with the message it named.
        edited: Vec<(String, OutboundMessage)>,
        /// Results to return, one per `send`, oldest first. Empty means accept.
        script: VecDeque<SendResult>,
    }

    /// An in-process adapter: the real [`OutboundAdapter`] contract with no
    /// transport behind it. It records every call and returns the next scripted
    /// result, so a test can drive the whole cycle without a channel.
    struct FakeAdapter {
        state: Arc<Mutex<FakeLedger>>,
        bound: i64,
    }

    impl FakeAdapter {
        fn new(state: Arc<Mutex<FakeLedger>>, bound: i64) -> Self {
            Self { state, bound }
        }
    }

    impl OutboundAdapter for FakeAdapter {
        fn connect(&mut self) -> Result<()> {
            self.state.lock().unwrap().connects += 1;
            Ok(())
        }

        fn disconnect(&mut self) -> Result<()> {
            self.state.lock().unwrap().disconnects += 1;
            Ok(())
        }

        fn send(&self, message: &OutboundMessage) -> SendResult {
            let mut state = self.state.lock().unwrap();
            state.sent.push(message.clone());
            state
                .script
                .pop_front()
                .unwrap_or(SendResult::Delivered { remote_id: None })
        }

        fn edit(&self, message: &OutboundMessage, remote_id: &str) -> SendResult {
            let mut state = self.state.lock().unwrap();
            state.edited.push((remote_id.to_string(), message.clone()));
            state
                .script
                .pop_front()
                .unwrap_or(SendResult::Delivered { remote_id: None })
        }

        fn attempt_bound(&self) -> i64 {
            self.bound
        }
    }

    /// An adapter whose `send` lets a second worker take the row's lease while
    /// the send is in flight — a reclaim racing the cycle — so the ledger write
    /// the cycle makes next cannot land. It reaches the database through its own
    /// connection, exactly as the reclaiming worker's claim would.
    struct LeaseStealingAdapter {
        db_path: std::path::PathBuf,
        result: SendResult,
    }

    impl OutboundAdapter for LeaseStealingAdapter {
        fn connect(&mut self) -> Result<()> {
            Ok(())
        }

        fn disconnect(&mut self) -> Result<()> {
            Ok(())
        }

        fn send(&self, _message: &OutboundMessage) -> SendResult {
            rusqlite::Connection::open(&self.db_path)
                .unwrap()
                .execute("UPDATE delivery_ledger SET lease_owner = 'worker-z'", [])
                .unwrap();
            self.result.clone()
        }
    }

    fn open() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        (dir, db)
    }

    /// A registry with one fake channel named `alpha`, plus the state handle.
    fn registry_with(bound: i64) -> (AdapterRegistry, Arc<Mutex<FakeLedger>>) {
        let state = Arc::new(Mutex::new(FakeLedger::default()));
        let mut registry = AdapterRegistry::new();
        registry
            .register("alpha", Box::new(FakeAdapter::new(state.clone(), bound)))
            .unwrap();
        (registry, state)
    }

    /// Stand in for the backoff delay elapsing by moving the persisted gate into
    /// the past. Reaches into the column the ledger owns, not a private field,
    /// exactly as the ledger's own tests do for time.
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
    fn an_edit_rewrites_the_message_its_card_created() {
        let (_dir, db) = open();
        let (registry, state) = registry_with(DEFAULT_MAX_ATTEMPTS);
        state
            .lock()
            .unwrap()
            .script
            .push_back(SendResult::Delivered {
                remote_id: Some("42".into()),
            });

        delivery_ledger::enqueue(
            &db,
            NewDelivery {
                id: Some("card-1".into()),
                channel: "alpha".into(),
                payload: json!({ "kind": "turn.started" }),
                max_attempts: None,
                operation: None,
                card_of: None,
            },
        )
        .unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        assert!(matches!(outcome, AttemptOutcome::Delivered { .. }));
        let stored = delivery_ledger::get(&db, "card-1").unwrap().unwrap();
        assert_eq!(
            stored.remote_id.as_deref(),
            Some("42"),
            "the channel's name for the message is recorded when it is delivered"
        );

        delivery_ledger::enqueue(
            &db,
            NewDelivery {
                id: Some("edit-1".into()),
                channel: "alpha".into(),
                payload: json!({ "kind": "turn.progress" }),
                max_attempts: Some(1),
                operation: Some(DeliveryOperation::Edit),
                card_of: Some("card-1".into()),
            },
        )
        .unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        assert!(matches!(outcome, AttemptOutcome::Delivered { .. }));
        let edited = state.lock().unwrap().edited.clone();
        assert_eq!(edited.len(), 1, "the edit reached the channel");
        assert_eq!(edited[0].0, "42", "and named the card's message");
        assert_eq!(edited[0].1.payload, json!({ "kind": "turn.progress" }));
    }

    #[test]
    fn an_edit_of_a_card_with_no_message_fails_terminally() {
        let (_dir, db) = open();
        let (registry, state) = registry_with(DEFAULT_MAX_ATTEMPTS);

        delivery_ledger::enqueue(
            &db,
            NewDelivery {
                id: Some("card-quiet".into()),
                channel: "alpha".into(),
                payload: json!({ "kind": "turn.started" }),
                max_attempts: None,
                operation: None,
                card_of: None,
            },
        )
        .unwrap();
        // The fake channel reports no message id, which is what a channel that
        // cannot be edited looks like from the ledger's side.
        attempt_one(&db, &registry, "worker-a").unwrap();

        delivery_ledger::enqueue(
            &db,
            NewDelivery {
                id: Some("edit-quiet".into()),
                channel: "alpha".into(),
                payload: json!({ "kind": "turn.progress" }),
                max_attempts: Some(3),
                operation: Some(DeliveryOperation::Edit),
                card_of: Some("card-quiet".into()),
            },
        )
        .unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        match outcome {
            AttemptOutcome::Failed { error, .. } => {
                assert!(
                    error.contains("no message to rewrite"),
                    "unexpected error: {error}"
                );
            }
            other => panic!("expected a terminal failure, got {other:?}"),
        }
        assert!(
            state.lock().unwrap().edited.is_empty(),
            "a channel is never asked to edit a message it never named"
        );
    }

    #[test]
    fn registration_is_explicit_and_name_keyed() {
        let (mut registry, _state) = registry_with(DEFAULT_MAX_ATTEMPTS);
        assert_eq!(registry.names(), vec!["alpha"]);
        assert!(registry.get("alpha").is_some());
        assert!(registry.get("beta").is_none(), "lookup is by exact name");

        // A second registration under a live name is rejected, not a silent
        // replace: the first adapter is still the one that would be driven.
        let duplicate = registry.register(
            "alpha",
            Box::new(FakeAdapter::new(
                Arc::new(Mutex::new(FakeLedger::default())),
                DEFAULT_MAX_ATTEMPTS,
            )),
        );
        assert!(duplicate.is_err());
        assert_eq!(registry.names(), vec!["alpha"]);

        let blank = registry.register(
            "   ",
            Box::new(FakeAdapter::new(
                Arc::new(Mutex::new(FakeLedger::default())),
                DEFAULT_MAX_ATTEMPTS,
            )),
        );
        assert!(blank.is_err());
    }

    #[test]
    fn the_host_path_connects_enqueues_sends_and_delivers() {
        let (_dir, db) = open();
        let (mut registry, state) = registry_with(DEFAULT_MAX_ATTEMPTS);

        // The Host drives the lifecycle around the registry.
        registry.connect_all().unwrap();
        assert_eq!(state.lock().unwrap().connects, 1);

        let payload = json!({ "kind": "turn.completed", "turnId": "turn-1" });
        let delivered = enqueue_for(&db, &registry, "alpha", payload.clone()).unwrap();
        assert_eq!(delivered.state, DeliveryState::Pending);
        assert_eq!(delivered.channel, "alpha");
        assert_eq!(delivered.max_attempts, DEFAULT_MAX_ATTEMPTS);

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        assert_eq!(
            outcome,
            AttemptOutcome::Delivered {
                id: delivered.id.clone()
            }
        );

        // The channel saw exactly the redacted payload once, tagged with the id
        // and channel and flagged as a first attempt.
        let sent = state.lock().unwrap().sent.clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, delivered.id);
        assert_eq!(sent[0].channel, "alpha");
        assert_eq!(sent[0].payload, payload);
        assert!(!sent[0].redelivery);

        // The ledger owns the persisted result.
        let stored = delivery_ledger::get(&db, &delivered.id).unwrap().unwrap();
        assert_eq!(stored.state, DeliveryState::Delivered);
        assert!(stored.delivered_at.is_some());

        // Nothing is due once the only delivery is done.
        assert_eq!(
            attempt_one(&db, &registry, "worker-a").unwrap(),
            AttemptOutcome::Idle
        );

        registry.disconnect_all().unwrap();
        assert_eq!(state.lock().unwrap().disconnects, 1);
    }

    #[test]
    fn a_retryable_failure_keeps_the_delivery_retryable_behind_its_backoff() {
        let (_dir, db) = open();
        let (registry, state) = registry_with(3);
        state.lock().unwrap().script.push_back(SendResult::Failed {
            kind: FailureKind::Retryable,
            detail: "channel unavailable".into(),
        });

        let delivery =
            enqueue_for(&db, &registry, "alpha", json!({ "kind": "turn.failed" })).unwrap();
        assert_eq!(
            delivery.max_attempts, 3,
            "the enqueued bound is the adapter's, not the ledger default"
        );

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        assert_eq!(
            outcome,
            AttemptOutcome::Retried {
                id: delivery.id.clone(),
                error: "channel unavailable".into()
            }
        );

        // The ledger, not this layer, decided the retry: the row is pending
        // again with the error kept and a real backoff gate set.
        let row = delivery_ledger::get(&db, &delivery.id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Pending);
        assert_eq!(row.attempts, 1);
        assert_eq!(
            row.max_attempts, 3,
            "the adapter's attempt bound is persisted on the row, not the default"
        );
        assert!(
            row.attempts < row.max_attempts,
            "under the cap the row is retryable"
        );
        assert_eq!(row.last_error.as_deref(), Some("channel unavailable"));
        assert!(
            raw_next_attempt_at(&db, &delivery.id).unwrap() > 0,
            "the retry carries a backoff gate"
        );

        // Honoring backoff is observable: an immediate second cycle has nothing
        // due, so the channel is not called again before the delay passes.
        assert_eq!(
            attempt_one(&db, &registry, "worker-a").unwrap(),
            AttemptOutcome::Idle
        );
        assert_eq!(state.lock().unwrap().sent.len(), 1);

        // Once the delay elapses the retry goes through and delivers.
        make_ready(&db, &delivery.id);
        assert_eq!(
            attempt_one(&db, &registry, "worker-a").unwrap(),
            AttemptOutcome::Delivered {
                id: delivery.id.clone()
            }
        );
        let sent = state.lock().unwrap().sent.clone();
        assert_eq!(sent.len(), 2);
        assert!(sent[1].redelivery, "the retry is marked a redelivery");
    }

    #[test]
    fn a_terminal_failure_ends_the_delivery_without_spending_the_budget() {
        let (_dir, db) = open();
        // A generous cap proves terminality comes from the classification, not
        // from the ledger running out of attempts.
        let (registry, state) = registry_with(5);
        state.lock().unwrap().script.push_back(SendResult::Failed {
            kind: FailureKind::Terminal,
            detail: "destination refused".into(),
        });

        let delivery = enqueue_for(
            &db,
            &registry,
            "alpha",
            json!({ "kind": "approval.requested" }),
        )
        .unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        assert_eq!(
            outcome,
            AttemptOutcome::Failed {
                id: delivery.id.clone(),
                error: "destination refused".into()
            }
        );

        let row = delivery_ledger::get(&db, &delivery.id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Failed);
        assert_eq!(row.attempts, 1);
        assert_eq!(row.max_attempts, 5);
        assert!(
            row.attempts < row.max_attempts,
            "the terminal state is reached well before the cap"
        );
        assert_eq!(row.last_error.as_deref(), Some("destination refused"));
        assert!(row.failed_at.is_some());

        // It is never claimed again.
        assert_eq!(
            attempt_one(&db, &registry, "worker-a").unwrap(),
            AttemptOutcome::Idle
        );
        assert_eq!(state.lock().unwrap().sent.len(), 1);
    }

    #[test]
    fn a_delivery_with_no_registered_channel_fails_terminally() {
        let (_dir, db) = open();
        let registry = AdapterRegistry::new();

        // Enqueue directly through the ledger: the hand-off's `enqueue_for`
        // would reject an unregistered channel up front, but a channel can also
        // disappear from the registry after its delivery was queued.
        let delivery = delivery_ledger::enqueue(
            &db,
            NewDelivery {
                id: None,
                channel: "alpha".into(),
                payload: json!({ "kind": "turn.completed" }),
                max_attempts: None,
                operation: None,
                card_of: None,
            },
        )
        .unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a").unwrap();
        assert_eq!(
            outcome,
            AttemptOutcome::Failed {
                id: delivery.id.clone(),
                error: "no outbound adapter registered for channel 'alpha'".into()
            }
        );
        let row = delivery_ledger::get(&db, &delivery.id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Failed);

        // And the hand-off refuses to enqueue to an unknown channel at all.
        assert!(enqueue_for(&db, &registry, "ghost", json!({})).is_err());
    }

    #[test]
    fn an_attempt_a_crash_interrupted_is_reclaimed_and_redelivered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let id;
        {
            let db = Database::open(&path).unwrap();
            let (registry, _state) = registry_with(DEFAULT_MAX_ATTEMPTS);
            let delivery =
                enqueue_for(&db, &registry, "alpha", json!({ "kind": "turn.completed" })).unwrap();
            id = delivery.id;
            // A worker claims the delivery, then the Host dies before it can
            // mark the result: the row is left `attempting` with a live lease.
            delivery_ledger::claim(&db, "worker-a", DEFAULT_LEASE_MS)
                .unwrap()
                .expect("the queued delivery is claimable");
        }

        // Restart: opening the database runs the boot reclaim, so the
        // interrupted attempt is claimable again instead of stuck.
        let db = Database::open(&path).unwrap();
        let (registry, state) = registry_with(DEFAULT_MAX_ATTEMPTS);

        let outcome = attempt_one(&db, &registry, "worker-b").unwrap();
        assert_eq!(outcome, AttemptOutcome::Delivered { id: id.clone() });
        let sent = state.lock().unwrap().sent.clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, id);
        assert!(
            sent[0].redelivery,
            "the reclaimed attempt is handed to the channel as a redelivery"
        );

        let row = delivery_ledger::get(&db, &id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Delivered);
        assert_eq!(row.attempts, 2, "the reclaim counted a second attempt");
        assert!(row.redelivery);
    }

    #[test]
    fn a_delivery_write_that_does_not_land_is_not_reported_as_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();

        // The channel accepts the send, but a reclaim takes the lease before the
        // cycle can record the completion, so `mark_delivered` does not land.
        let mut registry = AdapterRegistry::new();
        registry
            .register(
                "alpha",
                Box::new(LeaseStealingAdapter {
                    db_path: path.clone(),
                    result: SendResult::Delivered { remote_id: None },
                }),
            )
            .unwrap();
        let delivery =
            enqueue_for(&db, &registry, "alpha", json!({ "kind": "turn.completed" })).unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a");
        assert!(
            outcome.is_err(),
            "an attempt whose write did not land is not reported as success"
        );

        // The losing worker's write left no trace: the row is not delivered.
        let row = delivery_ledger::get(&db, &delivery.id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Attempting);
        assert!(row.delivered_at.is_none());
    }

    #[test]
    fn a_terminal_write_that_does_not_land_is_not_reported_as_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();

        let mut registry = AdapterRegistry::new();
        registry
            .register(
                "alpha",
                Box::new(LeaseStealingAdapter {
                    db_path: path.clone(),
                    result: SendResult::Failed {
                        kind: FailureKind::Terminal,
                        detail: "destination refused".into(),
                    },
                }),
            )
            .unwrap();
        let delivery = enqueue_for(
            &db,
            &registry,
            "alpha",
            json!({ "kind": "approval.requested" }),
        )
        .unwrap();

        let outcome = attempt_one(&db, &registry, "worker-a");
        assert!(
            outcome.is_err(),
            "an attempt whose terminal write did not land is not reported as failure recorded"
        );

        let row = delivery_ledger::get(&db, &delivery.id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Attempting);
        assert!(row.failed_at.is_none());
    }
}
