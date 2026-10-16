/**
 * A live remote host: one desktop-side coordinator per paired `pi-host`. Owns
 * the {@link BackendRouter} registrations for that host's sessions, subscribes
 * to the host's RACP event streams, and pipes them through the event bridge
 * onto the renderer's IPC events. Ownership of the transport itself stays
 * with the caller (Stage 3b builds it around a real {@link RacpClient}); this
 * layer only speaks the interfaces {@link RemoteHostClient} exposes.
 *
 * Compatibility: while no connection has {@link open}ed, the router has no
 * remote backends registered, so every renderer call still hits the local
 * handler byte-for-byte. Failure of a remote host — network drop, protocol
 * mismatch — never escalates into a local regression: `close()` unregisters
 * every session and the fallback route resumes.
 *
 * ## Reconnect and resync (R2b stage 3b)
 *
 * The transport's own reconnect with backoff lives in `RacpClient` (bounded
 * delay, bounded attempts); this layer owns what happens *after* it comes
 * back, via {@link RemoteHostClient.subscribeReconnected}. `resync()` re-runs
 * exactly the pass `open()` ran — host-scope subscribe, `session/list`,
 * per-session subscribe, terminal re-attach — so one code path serves the
 * first dial and every reconnect instead of a parallel one.
 *
 * What bounds a resync:
 *
 * - **Re-subscription resumes from the cursor the client kept, never from
 *   zero.** `RacpClient.cursorFor` / `cursorForHost` supply the last durable
 *   `(epoch, sequence)` per stream, so a reconnect replays only the gap.
 * - **When that cursor is no longer usable** — the epoch changed or the replay
 *   window evicted it — the Host answers `replayComplete: false` (or raises
 *   `resync.required`). This layer then takes the Host's **snapshot**
 *   (`session/attach { includeSnapshot: true }`) and re-subscribes from the
 *   head, which delivers no history at all. It never asks the Host for a
 *   backlog it may no longer hold.
 * - **Terminals resume from the Host's bounded replay ring.** `terminal/open`
 *   with an id re-attaches and answers with the ring — the same bound the
 *   `TerminalService` applies on the remote machine (128 KiB by default) — and
 *   that ring is the only terminal history that can cross the wire.
 * - **Nothing accumulates locally while disconnected.** This layer holds only
 *   bounded metadata: one router registration per session and one id per open
 *   terminal. It keeps no event queue and no transcript; an event that arrives
 *   while the transport is down is rejected by `RacpClient` at the request
 *   layer and is never buffered here.
 */
import {
  IPC,
  isDurableEventKind,
  type RacpCursor,
  type RacpEventEnvelope,
  type RacpSession,
  type RemoteHostLinkState,
} from "@pi-desktop/shared";
import type { BackendRouter, RemoteBackend } from "./backend-router.js";
import { makeRemoteSessionId } from "./backend-router.js";
import { createRemoteBackend, type RemoteRacpClient } from "./remote-backend.js";
import {
  createRemoteEventBridge,
  type RemoteEventBridge,
  type RemoteLifecycleEvent,
} from "./remote-event-bridge.js";

/**
 * The transport surface this connection needs. {@link RemoteRacpClient} covers
 * the request half; {@link subscribe} bridges RACP's single-callback
 * {@link RacpClient.onEvent} into a multiple-listener seam for tests.
 *
 * The three optional members are the Stage 3b seams: a real
 * `createRacpRemoteHostClient` exposes all of them, while a bare fake used by
 * a bridge-only fixture may expose none — absent means "no reconnect, no live
 * state, no cursor resume", which degrades to the pre-3b behaviour rather than
 * failing.
 */
export type RemoteHostClient = RemoteRacpClient & {
  /** Subscribe to raw RACP envelopes. The returned function detaches this listener. */
  subscribe(listener: (envelope: RacpEventEnvelope) => void): () => void;
  /**
   * Subscribe to "the transport reconnected and re-initialized". The returned
   * function detaches. Fired once per successful reconnect, after the new
   * transport is initialized, so a handler may issue requests immediately.
   */
  subscribeReconnected?(listener: () => void): () => void;
  /** Subscribe to transport link-state transitions; returns a detach function. */
  subscribeState?(listener: (state: RemoteHostLinkState) => void): () => void;
  /** Last durable cursor applied for one host session, for `after` on resubscribe. */
  cursorFor?(sessionId: string): RacpCursor | undefined;
  /** Last durable cursor applied for the host-scope stream, for `after` on resubscribe. */
  cursorForHost?(): RacpCursor | undefined;
};

export type RemoteHostConnectionOptions = {
  hostKey: string;
  client: RemoteHostClient;
  router: BackendRouter;
  /** Dispatch a local IPC event to the renderer. */
  emit: (channel: string, payload: unknown) => void;
  /** Optional deterministic request-id source; forwarded to the backend. */
  newRequestId?: () => string;
  /** Optional structured log; defaults to a no-op. */
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};

export interface RemoteHostConnection {
  readonly hostKey: string;
  /**
   * List the host's sessions, register a backend for each, then subscribe to
   * host-scope and per-session RACP event streams. Idempotent: a second call
   * on an open connection is a no-op.
   */
  open(): Promise<void>;
  /**
   * Detach the event subscription, unregister every session, and drop internal
   * state. Idempotent: closing twice is a no-op. The underlying transport is
   * the caller's responsibility.
   */
  close(): Promise<void>;
  /**
   * Re-establish what the connection holds after the transport came back:
   * re-subscribe the host and every live session stream, reconcile the router
   * against the Host's current session list, and re-attach the terminals the
   * desktop was watching. Safe to call while closed (a no-op) and coalesced —
   * two overlapping calls run one pass. Called automatically from the client's
   * reconnect seam; exposed for tests and for a manual refresh.
   */
  resync(): Promise<void>;
}

type SessionListResponse = { sessions: RacpSession[] };

/** The `events/subscribe` result's resync-relevant half (spec §7.2). */
type SubscribeResult = {
  replayComplete?: boolean;
  resyncReason?: "epoch" | "evicted" | "ahead";
};

/** The `terminal/open` result's replay half; see `remote-backend.ts`. */
type TerminalOpenResult = { terminalId: string; replay: string; cols: number; rows: number };

/** The map key for the host-scope durable stream (session ids are never this). */
const HOST_STREAM_KEY = "\u0000host";

/**
 * Terminal kinds are connection-local and their `sequence` (for
 * `terminal.changed`) is the *session stream's* cursor, not an ordinal of their
 * own — so they must not enter the duplicate-drop watermark below.
 */
const TERMINAL_KINDS: ReadonlySet<string> = new Set(["terminal.output", "terminal.changed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createRemoteHostConnection(
  options: RemoteHostConnectionOptions,
): RemoteHostConnection {
  const { hostKey, client, router, emit } = options;
  const log = options.log ?? (() => undefined);
  const backend: RemoteBackend = createRemoteBackend({
    hostKey,
    client,
    ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
  });

  const registered = new Set<string>();
  /** Remote session id → the Host's own id, so a release never re-parses the key. */
  const hostIdByRemoteId = new Map<string, string>();
  /** Host session ids whose stream subscription is live on the current transport. */
  const subscribed = new Set<string>();
  /** Host session id → terminal ids the desktop has been watching output for. */
  const terminals = new Map<string, Set<string>>();
  /**
   * Highest durable `(epoch, sequence)` applied per stream. A second delivery
   * of an event at or below it is a duplicate — the shape an event from the
   * previous connection, or a replayed-overlap from the new one, takes.
   */
  const applied = new Map<string, RacpCursor>();
  let bridge: RemoteEventBridge | null = null;
  let unsubscribeEvent: (() => void) | null = null;
  let unsubscribeReconnected: (() => void) | null = null;
  let unsubscribeState: (() => void) | null = null;
  let opened = false;
  /**
   * Bumped by `open()` and `close()`. Every async step of an establish pass
   * captures it and re-checks after each await: a pass whose generation no
   * longer matches has been superseded (teardown, or a newer pass) and must
   * abort rather than register, emit, or subscribe into a dead connection.
   */
  let generation = 0;
  let resyncInFlight: Promise<void> | null = null;
  let lastLinkState: RemoteHostLinkState | null = null;

  /**
   * Link state to the UI path. Deduplicated so a transport `connected` that
   * precedes the re-subscription pass does not double-report, and the row
   * shows one honest transition per event.
   */
  const emitLinkState = (state: RemoteHostLinkState): void => {
    if (lastLinkState === state) return;
    lastLinkState = state;
    emit(IPC.event.remoteHostState, { hostKey, state });
  };

  /**
   * True when this envelope is a duplicate or a stale delivery: a durable kind
   * at or below the watermark already applied for its stream. Terminal kinds
   * are excluded (their sequence is not their own ordinal), and an ephemeral
   * kind never carries one.
   */
  const isStaleDelivery = (envelope: RacpEventEnvelope): boolean => {
    if (TERMINAL_KINDS.has(envelope.kind)) return false;
    if (!isDurableEventKind(envelope.kind) || typeof envelope.sequence !== "number") return false;
    const key = envelope.scope === "host" ? HOST_STREAM_KEY : envelope.sessionId;
    if (typeof key !== "string") return false;
    const previous = applied.get(key);
    if (previous && previous.epoch === envelope.epoch && envelope.sequence <= previous.sequence) {
      return true;
    }
    applied.set(key, { epoch: envelope.epoch, sequence: envelope.sequence });
    return false;
  };

  const rememberTerminal = (hostSessionId: string, terminalId: string): void => {
    let ids = terminals.get(hostSessionId);
    if (!ids) {
      ids = new Set();
      terminals.set(hostSessionId, ids);
    }
    ids.add(terminalId);
  };

  const forgetTerminal = (hostSessionId: string, terminalId: string): void => {
    const ids = terminals.get(hostSessionId);
    if (!ids) return;
    ids.delete(terminalId);
    if (ids.size === 0) terminals.delete(hostSessionId);
  };

  /**
   * Track which terminals the desktop is watching, from the stream itself:
   * output for a terminal under a live session means a re-attach would restore
   * a pane the user was looking at, and its exit means it is gone.
   */
  const observeTerminalActivity = (envelope: RacpEventEnvelope): void => {
    if (!TERMINAL_KINDS.has(envelope.kind)) return;
    if (typeof envelope.sessionId !== "string") return;
    if (!isRecord(envelope.payload) || typeof envelope.payload.terminalId !== "string") return;
    if (envelope.kind === "terminal.output") {
      rememberTerminal(envelope.sessionId, envelope.payload.terminalId);
    } else if (envelope.payload.state === "exited") {
      forgetTerminal(envelope.sessionId, envelope.payload.terminalId);
    }
  };

  const subscribeHostScope = async (after?: RacpCursor): Promise<boolean> => {
    try {
      const result = await client.request<SubscribeResult>("events/subscribe", {
        scope: "host",
        ...(after ? { after } : {}),
      });
      return result?.replayComplete !== false;
    } catch (error) {
      log("warn", "events/subscribe host scope failed", error);
      return false;
    }
  };

  /**
   * Take the Host's snapshot for a session whose cursor it rejected, tell the
   * renderer to re-read it, and restart the stream from the head. Never asks
   * the Host to replay a backlog it may no longer hold — the snapshot *is* the
   * refreshed state, and a head subscription carries no history.
   */
  const refreshSession = async (hostSessionId: string, reason: string): Promise<void> => {
    const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
    if (!registered.has(remoteSessionId)) return;
    log("warn", `session ${hostSessionId} requires resync`, { reason });
    try {
      await client.request("session/attach", { sessionId: hostSessionId, includeSnapshot: true });
    } catch (error) {
      log("warn", `session/attach refresh failed for ${hostSessionId}`, error);
    }
    if (!opened || !registered.has(remoteSessionId)) return;
    emit(IPC.event.sessionsChanged, { reason: "remote.session.resync" });
    try {
      // No `after`: subscribe at the Host's current head so the invalid cursor
      // is dropped. The follow-up answers `replayComplete: true`, which is why
      // this cannot recurse into a second refresh.
      await client.request("events/subscribe", { scope: "session", sessionId: hostSessionId });
    } catch (error) {
      log("warn", `events/subscribe after resync failed for ${hostSessionId}`, error);
    }
  };

  /**
   * Subscribe one session's stream, resuming from the client's cursor, and
   * refresh from a snapshot if the Host says that cursor no longer works.
   */
  const subscribeSession = async (
    hostSessionId: string,
    fromHead = false,
  ): Promise<void> => {
    const after = fromHead ? undefined : client.cursorFor?.(hostSessionId);
    let result: SubscribeResult;
    try {
      result = await client.request<SubscribeResult>("events/subscribe", {
        scope: "session",
        sessionId: hostSessionId,
        ...(after ? { after } : {}),
      });
    } catch (error) {
      // A session-scope subscribe failure keeps the backend registered; the
      // renderer can still fetch snapshot/history via request paths, and the
      // next reconnect retries the stream. Errors that must surface to the
      // user go through the link-state channel instead.
      log("warn", `events/subscribe failed for session ${hostSessionId}`, error);
      return;
    }
    if (result?.replayComplete === false) {
      await refreshSession(hostSessionId, result.resyncReason ?? "resync.required");
    }
  };

  /**
   * Bind one host session to the router backend, remember the reverse mapping,
   * and return the renderer-visible id. Idempotent — the single place a
   * registration is created, so the reverse map can never miss an entry the
   * release path needs.
   */
  const ensureRegistered = (hostSessionId: string): string => {
    const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
    if (!registered.has(remoteSessionId)) {
      router.registerBackend(remoteSessionId, backend);
      registered.add(remoteSessionId);
      hostIdByRemoteId.set(remoteSessionId, hostSessionId);
    }
    return remoteSessionId;
  };

  const registerSession = async (hostSessionId: string): Promise<void> => {
    ensureRegistered(hostSessionId);
    if (subscribed.has(hostSessionId)) return;
    subscribed.add(hostSessionId);
    await subscribeSession(hostSessionId);
  };

  const unregisterSession = (hostSessionId: string): void => {
    const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
    subscribed.delete(hostSessionId);
    terminals.delete(hostSessionId);
    applied.delete(hostSessionId);
    hostIdByRemoteId.delete(remoteSessionId);
    if (!registered.delete(remoteSessionId)) return;
    router.unregisterBackend(remoteSessionId);
  };

  const handleLifecycle = (event: RemoteLifecycleEvent): void => {
    if (event.kind === "session.created") {
      void registerSession(event.hostSessionId);
      return;
    }
    if (event.kind === "session.archived") {
      unregisterSession(event.hostSessionId);
    }
  };

  const handleResyncRequired = (hostSessionId: string | null): void => {
    if (!opened) return;
    if (hostSessionId) {
      void refreshSession(hostSessionId, "resync.required");
      return;
    }
    // The host-scope stream has no snapshot; its refresh is a re-list, which
    // is exactly what a full pass does (and overlapping calls coalesce).
    void resync();
  };

  /** Re-attach every terminal the desktop was watching, from the Host's ring. */
  const reattachTerminals = async (gen: number): Promise<void> => {
    for (const [hostSessionId, ids] of [...terminals]) {
      const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
      if (!registered.has(remoteSessionId)) {
        terminals.delete(hostSessionId);
        continue;
      }
      for (const terminalId of [...ids]) {
        if (gen !== generation || !opened) return;
        try {
          const reopened = await client.request<TerminalOpenResult>("terminal/open", {
            sessionId: hostSessionId,
            terminalId,
          });
          // The Host answers with its *bounded* replay ring, which is the whole
          // re-attach and the only terminal history that can cross the wire.
          if (typeof reopened?.replay === "string" && reopened.replay.length > 0) {
            emit(IPC.event.terminalOutput, {
              sessionId: remoteSessionId,
              terminalId,
              data: reopened.replay,
            });
          }
        } catch (error) {
          log("warn", `terminal ${terminalId} could not be re-attached`, error);
          forgetTerminal(hostSessionId, terminalId);
        }
      }
    }
  };

  /**
   * One establishment pass, shared by `open()` and `resync()`. Re-checks the
   * generation after every await: a pass that a teardown (or a newer pass)
   * superseded must not register, subscribe, or emit into a dead connection.
   */
  const establish = async (gen: number): Promise<void> => {
    // The previous transport's subscriptions died with it; a session the
    // `session.created` path re-registers below re-adds its own entry.
    subscribed.clear();
    // Host scope BEFORE the list closes the create race: any `session.created`
    // a peer emits between the two calls arrives as an event and is handled by
    // the lifecycle path (idempotent register).
    const resumed = await subscribeHostScope(client.cursorForHost?.());
    if (gen !== generation || !opened) return;
    if (!resumed) {
      // The host cursor is unusable: take the head instead. There is no host
      // snapshot to fetch, so re-listing is the refresh.
      await subscribeHostScope();
      if (gen !== generation || !opened) return;
    }
    let response: SessionListResponse;
    try {
      response = await client.request<SessionListResponse>("session/list");
    } catch (error) {
      log("error", "session/list failed; connection stays with no registered sessions", error);
      return;
    }
    if (gen !== generation || !opened) return;
    const live = new Set<string>();
    for (const session of response.sessions) {
      live.add(ensureRegistered(session.id));
    }
    // A session closed while the desktop was away is not in the Host's list:
    // it must not be re-subscribed, re-attached, or left registered here.
    for (const remoteSessionId of [...registered]) {
      if (live.has(remoteSessionId)) continue;
      const hostSessionId = hostIdByRemoteId.get(remoteSessionId);
      if (hostSessionId === undefined) continue;
      unregisterSession(hostSessionId);
    }
    // Re-subscribe every live session from the cursor the client kept.
    await Promise.all(response.sessions.map((session) => registerSession(session.id)));
    if (gen !== generation || !opened) return;
    await reattachTerminals(gen);
    if (gen !== generation || !opened) return;
    emitLinkState("connected");
  };

  /**
   * Re-establish the connection's state. Coalesced: a second call while a pass
   * is in flight returns that pass, so two reconnect signals can never produce
   * two subscriptions or two terminal attachments.
   */
  const resync = (): Promise<void> => {
    // A reconnect that lands after teardown must not resurrect anything.
    if (!opened) return Promise.resolve();
    if (resyncInFlight) return resyncInFlight;
    const gen = generation;
    const run = (async () => {
      try {
        await establish(gen);
      } catch (error) {
        log("error", `remote host ${hostKey} resync failed`, { error: String(error) });
      }
    })();
    const wrapped = run.finally(() => {
      if (resyncInFlight === wrapped) resyncInFlight = null;
    });
    resyncInFlight = wrapped;
    return wrapped;
  };

  return {
    hostKey,
    async open() {
      if (opened) return;
      opened = true;
      generation += 1;
      const gen = generation;
      emitLinkState("connecting");
      bridge = createRemoteEventBridge({
        hostKey,
        emit,
        onLifecycle: handleLifecycle,
        // Terminal kinds are connection-local, so the bridge needs the live
        // registration view to drop a chunk whose session the router has
        // already released (session switch, host disconnect). The set is the
        // same one `close()` clears, so it needs no separate teardown.
        isSessionActive: (remoteSessionId) => registered.has(remoteSessionId),
        onResyncRequired: handleResyncRequired,
        log: (level, message, data) => log(level, message, data),
      });
      unsubscribeEvent = client.subscribe((envelope) => {
        // An event from the old connection arriving after the new one is
        // established carries a sequence at or below the watermark and is
        // dropped rather than delivered as if current.
        if (isStaleDelivery(envelope)) return;
        observeTerminalActivity(envelope);
        bridge?.handle(envelope);
      });
      unsubscribeReconnected =
        client.subscribeReconnected?.(() => {
          void resync();
        }) ?? null;
      unsubscribeState =
        client.subscribeState?.((state) => {
          if (!opened) return;
          emitLinkState(state);
        }) ?? null;
      await establish(gen);
    },
    async close() {
      if (!opened) return;
      opened = false;
      // Invalidate any pass in flight: it re-checks the generation after each
      // await and aborts instead of registering into a closed connection.
      generation += 1;
      resyncInFlight = null;
      unsubscribeEvent?.();
      unsubscribeEvent = null;
      unsubscribeReconnected?.();
      unsubscribeReconnected = null;
      unsubscribeState?.();
      unsubscribeState = null;
      bridge = null;
      for (const remoteSessionId of registered) router.unregisterBackend(remoteSessionId);
      registered.clear();
      hostIdByRemoteId.clear();
      subscribed.clear();
      terminals.clear();
      applied.clear();
      lastLinkState = null;
    },
    resync,
  };
}
