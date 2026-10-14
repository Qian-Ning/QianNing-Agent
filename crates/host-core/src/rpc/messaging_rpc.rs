//! Host RPC methods for the outbound messaging delivery ledger (ADR 0205 D375
//! item 9, milestone R3, step 3).
//!
//! The outbound messaging integration is a caller of the Agent Host module that
//! runs beside it. The Host process subscribes to the module's host-scope event
//! surface, redacts each event down to a summary that carries structure and
//! metadata only, and hands that summary across the **existing** stdio NDJSON
//! JSON-RPC channel to the durable delivery ledger this file reaches. Redaction
//! happens before the payload crosses the channel, so host-core never sees
//! transcript content.
//!
//! `messaging.enqueue` is the single verb on that channel that writes a
//! delivery, and it writes it through the adapter contract's existing
//! [`enqueue_for`] hand-off — never through `delivery_ledger` directly — so the
//! ledger stays the only owner of the delivery state machine, its attempt
//! bound, its retry/backoff schedule, and its terminal `failed` state. There is
//! no second enqueue path, no new process channel, and no Rust event surface.
//!
//! [`drive_once`] is one tick of the attempt cycle the Host's background driver
//! runs: it claims at most one due delivery and records the outcome through the
//! ledger. The channel registry it drives ([`AppState::messaging`]) holds no
//! adapter until a concrete outbound channel is registered, so in production
//! the cycle claims nothing and `messaging.enqueue` refuses an unregistered
//! channel — the ledger, not this file, governs a delivery once one exists.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::{rpc_err, AppState, JsonRpcError};
use crate::messaging_adapter::{attempt_one, enqueue_for, AttemptOutcome};

/// How often the host's background driver runs one tick of the outbound
/// messaging attempt cycle. It matches the neighboring config-sync cadence: the
/// ledger's own backoff gate, not this interval, decides when a retry is due.
const DRIVER_TICK: Duration = Duration::from_secs(30);

/// The lease owner name the outbound attempt cycle claims deliveries under.
const DRIVER_WORKER: &str = "messaging-outbound";

/// Handles the `messaging.*` family.
pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "messaging.enqueue" => {
            let channel = params
                .get("channel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|channel| !channel.is_empty())
                .ok_or_else(|| {
                    rpc_err(
                        1002,
                        "channel is required and must not be blank",
                        "INVALID_PARAMS",
                    )
                })?;
            let payload = params
                .get("payload")
                .cloned()
                .ok_or_else(|| rpc_err(1002, "payload is required", "INVALID_PARAMS"))?;
            let st = state.lock().await;
            let delivery = enqueue_for(&st.db, &st.messaging, channel, payload)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            Ok(json!({ "delivery": delivery }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// One tick of the outbound attempt cycle.
///
/// This is the only caller of [`attempt_one`]: claim at most one due delivery,
/// send it through its channel, and let the ledger record the outcome. A
/// delivery's retry, backoff and terminal rules are the ledger's, unchanged.
pub(crate) async fn drive_once(
    state: &Arc<Mutex<AppState>>,
    worker: &str,
) -> Result<AttemptOutcome, JsonRpcError> {
    let st = state.lock().await;
    attempt_one(&st.db, &st.messaging, worker)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
}

/// Spawn the host's background driver for the outbound attempt cycle.
///
/// This is the side that owns the job: host-core holds SQLite and the ledger,
/// so it is host-core that claims a due delivery, sends it through its channel,
/// and records the outcome. No other side drives [`attempt_one`], and the
/// driver adds no enqueue path — a delivery exists only because
/// `messaging.enqueue` created it. `serve` owns the returned handle and aborts
/// it on shutdown, exactly as it does the config-sync scheduler.
pub(crate) fn spawn_driver(state: Arc<Mutex<AppState>>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(DRIVER_TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = drive_once(&state, DRIVER_WORKER).await {
                tracing::warn!(
                    message = %error.message,
                    "outbound messaging attempt cycle failed"
                );
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;
    use std::sync::{Arc as StdArc, Mutex as StdMutex};

    use crate::delivery_ledger::{self, DeliveryState, DEFAULT_MAX_ATTEMPTS};
    use crate::messaging_adapter::{FailureKind, OutboundAdapter, OutboundMessage, SendResult};

    /// What a fake channel records while a test drives the cycle.
    #[derive(Default)]
    struct FakeChannel {
        sent: Vec<OutboundMessage>,
        /// Results to return, one per `send`, oldest first. Empty means accept.
        script: VecDeque<SendResult>,
    }

    /// An in-process channel: the real [`OutboundAdapter`] contract with no
    /// transport behind it, so a test drives the whole cycle without a wire.
    struct FakeAdapter {
        state: StdArc<StdMutex<FakeChannel>>,
        bound: i64,
    }

    impl OutboundAdapter for FakeAdapter {
        fn connect(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        fn disconnect(&mut self) -> anyhow::Result<()> {
            Ok(())
        }

        fn send(&self, message: &OutboundMessage) -> SendResult {
            let mut state = self.state.lock().unwrap();
            state.sent.push(message.clone());
            state.script.pop_front().unwrap_or(SendResult::Delivered)
        }

        fn attempt_bound(&self) -> i64 {
            self.bound
        }
    }

    /// A host state with one registered fake channel under `name`, plus the
    /// handle its `send` records into.
    fn state_with_channel(
        name: &str,
        bound: i64,
    ) -> (
        tempfile::TempDir,
        Arc<Mutex<AppState>>,
        StdArc<StdMutex<FakeChannel>>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        let channel = StdArc::new(StdMutex::new(FakeChannel::default()));
        app.messaging
            .register(
                name,
                Box::new(FakeAdapter {
                    state: channel.clone(),
                    bound,
                }),
            )
            .unwrap();
        (dir, Arc::new(Mutex::new(app)), channel)
    }

    async fn enqueue(
        state: &Arc<Mutex<AppState>>,
        channel: &str,
        payload: Value,
    ) -> Result<Value, JsonRpcError> {
        handle(
            state,
            "messaging.enqueue",
            json!({ "channel": channel, "payload": payload }),
        )
        .await
    }

    async fn delivery_count(state: &Arc<Mutex<AppState>>) -> i64 {
        let st = state.lock().await;
        st.db
            .conn()
            .query_row("SELECT COUNT(*) FROM delivery_ledger", [], |row| row.get(0))
            .unwrap()
    }

    #[tokio::test]
    async fn the_enqueue_verb_persists_one_pending_delivery_through_the_adapter_path() {
        let (_dir, state, channel) = state_with_channel("primary", 3);
        let summary = json!({
            "kind": "turn.completed",
            "sessionId": "session-1",
            "turnId": "turn-1",
            "status": "completed",
            "revision": 12,
            "occurredAt": "2026-10-14T09:00:00.000Z",
        });

        let result = enqueue(&state, "primary", summary.clone()).await.unwrap();
        let delivery = &result["delivery"];

        // Born pending, on the requested channel, carrying the adapter's
        // attempt bound and the payload it was handed — the ledger's rules.
        assert_eq!(delivery["state"], json!("pending"));
        assert_eq!(delivery["channel"], json!("primary"));
        assert_eq!(delivery["attempts"], json!(0));
        assert_eq!(
            delivery["maxAttempts"],
            json!(3),
            "the bound is the adapter's, not the ledger default"
        );
        assert_eq!(
            delivery["payload"], summary,
            "the ledger stores the redacted summary verbatim and invents nothing"
        );

        let id = delivery["id"].as_str().unwrap().to_string();
        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id).unwrap().unwrap();
        assert_eq!(stored.state, DeliveryState::Pending);
        assert_eq!(stored.max_attempts, 3);
        drop(st);

        assert!(
            channel.lock().unwrap().sent.is_empty(),
            "nothing is sent until the attempt cycle runs"
        );
    }

    #[tokio::test]
    async fn the_enqueue_verb_refuses_an_unregistered_channel_before_persistence() {
        let (_dir, state, _channel) = state_with_channel("primary", DEFAULT_MAX_ATTEMPTS);

        let error = enqueue(&state, "ghost", json!({ "kind": "turn.completed" }))
            .await
            .unwrap_err();
        assert_eq!(error.code, 1000);
        assert!(
            error.message.contains("no outbound adapter registered"),
            "the refusal names the missing adapter: {}",
            error.message
        );
        assert_eq!(
            delivery_count(&state).await,
            0,
            "an unknown channel writes no ledger row"
        );
    }

    #[tokio::test]
    async fn the_enqueue_verb_requires_a_channel_and_a_payload() {
        let (_dir, state, _channel) = state_with_channel("primary", DEFAULT_MAX_ATTEMPTS);

        let missing_channel = handle(&state, "messaging.enqueue", json!({ "payload": {} }))
            .await
            .unwrap_err();
        assert_eq!(missing_channel.code, 1002);

        let blank_channel = handle(
            &state,
            "messaging.enqueue",
            json!({ "channel": "  ", "payload": {} }),
        )
        .await
        .unwrap_err();
        assert_eq!(blank_channel.code, 1002);

        let missing_payload = handle(&state, "messaging.enqueue", json!({ "channel": "primary" }))
            .await
            .unwrap_err();
        assert_eq!(missing_payload.code, 1002);

        assert_eq!(delivery_count(&state).await, 0);
    }

    #[tokio::test]
    async fn an_unknown_messaging_method_is_not_found() {
        let (_dir, state, _channel) = state_with_channel("primary", DEFAULT_MAX_ATTEMPTS);
        let error = handle(&state, "messaging.replay", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, -32601);
    }

    #[tokio::test]
    async fn the_attempt_driver_sends_the_enqueued_delivery_and_the_ledger_records_it() {
        let (_dir, state, channel) = state_with_channel("primary", DEFAULT_MAX_ATTEMPTS);
        let summary =
            json!({ "kind": "turn.failed", "sessionId": "session-1", "status": "failed" });
        let result = enqueue(&state, "primary", summary.clone()).await.unwrap();
        let id = result["delivery"]["id"].as_str().unwrap().to_string();

        // The driver tick claims the one due delivery and sends it.
        let outcome = drive_once(&state, "worker-a").await.unwrap();
        assert_eq!(outcome, AttemptOutcome::Delivered { id: id.clone() });

        let sent = channel.lock().unwrap().sent.clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].id, id);
        assert_eq!(sent[0].channel, "primary");
        assert_eq!(sent[0].payload, summary);
        assert!(!sent[0].redelivery);

        // With nothing left due, the next tick is idle.
        assert_eq!(
            drive_once(&state, "worker-a").await.unwrap(),
            AttemptOutcome::Idle
        );

        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id).unwrap().unwrap();
        assert_eq!(stored.state, DeliveryState::Delivered);
        assert!(stored.delivered_at.is_some());
    }

    #[tokio::test]
    async fn the_driver_leaves_the_retry_schedule_to_the_ledger() {
        let (_dir, state, channel) = state_with_channel("primary", 3);
        channel
            .lock()
            .unwrap()
            .script
            .push_back(SendResult::Failed {
                kind: FailureKind::Retryable,
                detail: "channel unavailable".into(),
            });
        let result = enqueue(&state, "primary", json!({ "kind": "turn.completed" }))
            .await
            .unwrap();
        let id = result["delivery"]["id"].as_str().unwrap().to_string();

        let outcome = drive_once(&state, "worker-a").await.unwrap();
        assert_eq!(
            outcome,
            AttemptOutcome::Retried {
                id: id.clone(),
                error: "channel unavailable".into()
            }
        );

        // The ledger, not the driver, rescheduled it: pending again with the
        // error kept and a real backoff gate set, so an immediate tick is idle.
        let st = state.lock().await;
        let row = delivery_ledger::get(&st.db, &id).unwrap().unwrap();
        assert_eq!(row.state, DeliveryState::Pending);
        assert_eq!(row.attempts, 1);
        assert_eq!(row.last_error.as_deref(), Some("channel unavailable"));
        let gate: i64 = st
            .db
            .conn()
            .query_row(
                "SELECT next_attempt_at FROM delivery_ledger WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(gate > 0, "the retry carries a backoff gate");
        drop(st);

        assert_eq!(
            drive_once(&state, "worker-a").await.unwrap(),
            AttemptOutcome::Idle
        );
        assert_eq!(channel.lock().unwrap().sent.len(), 1);
    }
}
