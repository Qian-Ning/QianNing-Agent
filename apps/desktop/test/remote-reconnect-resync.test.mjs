/**
 * R2b stage 3b: the resync path's race cases and its guards, driven through a
 * fake {@link RemoteHostClient} so every step has an explicit sync point. The
 * real transport is exercised in `remote-reconnect-end-to-end.test.mjs`; here
 * the point is to land a reconnect at a chosen moment — after teardown, twice
 * at once, after a session was closed — and to count the side effects.
 *
 * Every test asserts a count of a side effect (requests on the wire, renderer
 * events) rather than that a call merely resolved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { createRemoteHostConnection } = await import(
  "../electron/main/remote/remote-host-connection.ts"
);

const HOST_KEY = "hostA";
const REMOTE_S1 = makeRemoteSessionId(HOST_KEY, "s1");

/**
 * A controllable `RemoteHostClient`: records every request, exposes the
 * reconnect and link-state seams the real adapter provides, and lets a test
 * *gate* one method so a pass can be paused mid-await while something else
 * happens (teardown, a second reconnect, a session closing).
 */
function fakeClient(options = {}) {
  const calls = [];
  const listeners = new Set();
  const reconnectedListeners = new Set();
  const allReconnectedListeners = [];
  const stateListeners = new Set();
  const gates = new Map();
  const responses = new Map();
  let sessions = options.sessions ?? [];
  const cursors = new Map(Object.entries(options.cursors ?? {}));
  let hostCursor = options.hostCursor;
  let notConnected = false;

  const nextGate = (method) => {
    const list = gates.get(method);
    if (!list || list.length === 0) return null;
    return list.shift();
  };

  return {
    calls,
    setSessions(next) {
      sessions = next;
    },
    setNotConnected(value) {
      notConnected = value;
    },
    /** Make the next call to `method` answer with `value` (or a function of params). */
    respond(method, value) {
      responses.set(method, value);
    },
    /** Pause the next call to `method` until the returned handle is released. */
    gate(method) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      const list = gates.get(method) ?? [];
      list.push({ promise });
      gates.set(method, list);
      return { release: () => release() };
    },
    callsOf(method, filter) {
      return calls.filter(
        (call) => call.method === method && (!filter || filter(call.params)),
      );
    },
    async request(method, params) {
      calls.push({ method, params });
      const gate = nextGate(method);
      if (gate) await gate.promise;
      if (notConnected) {
        throw Object.assign(new Error(`not connected`), {
          errorCode: "HOST_DISCONNECTED",
          code: "HOST_DISCONNECTED",
        });
      }
      const scripted = responses.get(method);
      if (scripted !== undefined) {
        return typeof scripted === "function" ? scripted(params) : scripted;
      }
      if (method === "session/list") return { sessions };
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeReconnected(listener) {
      reconnectedListeners.add(listener);
      allReconnectedListeners.push(listener);
      return () => reconnectedListeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    cursorFor: (sessionId) => cursors.get(sessionId),
    cursorForHost: () => hostCursor,
    // Test-only escape hatches.
    push(envelope) {
      for (const listener of [...listeners]) listener(envelope);
    },
    fireReconnected() {
      for (const listener of [...reconnectedListeners]) listener();
    },
    /** Fire every reconnect listener this client ever handed out — including a
     * detached one, the way a transport that was already reconnecting does. */
    fireReconnectedEverywhere() {
      for (const listener of [...allReconnectedListeners]) listener();
    },
    fireState(state) {
      for (const listener of [...stateListeners]) listener(state);
    },
    reconnectedListenerCount: () => reconnectedListeners.size,
    stateListenerCount: () => stateListeners.size,
  };
}

function makeSession(id) {
  return {
    id,
    title: id,
    mode: "chat",
    status: "idle",
    planningState: "inactive",
    permissionMode: "default",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
  };
}

function durableEnvelope(sequence, overrides = {}) {
  return {
    eventId: `e${sequence}`,
    scope: "session",
    sessionId: "s1",
    epoch: "ep-1",
    sequence,
    revision: 1,
    kind: "item.completed",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {
      itemType: "message",
      itemId: `m${sequence}`,
      event: {
        type: "message_end",
        message: {
          id: `m${sequence}`,
          role: "assistant",
          content: `chunk ${sequence}`,
          createdAt: "2026-09-18T10:00:00.000Z",
          status: "complete",
        },
      },
    },
    ...overrides,
  };
}

function setup(options = {}) {
  const events = [];
  const router = createBackendRouter();
  const client = fakeClient(options);
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    client,
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    newRequestId: () => "req-const",
  });
  return {
    conn,
    router,
    client,
    events,
    agentMessages: () => events.filter((e) => e.channel === IPC.event.agentMessage),
    linkStates: () =>
      events.filter((e) => e.channel === IPC.event.remoteHostState).map((e) => e.payload.state),
    sessionsChanged: () =>
      events.filter((e) => e.channel === IPC.event.sessionsChanged).map((e) => e.payload.reason),
  };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// Race 1 — a reconnect that lands after teardown must not resurrect anything
// ---------------------------------------------------------------------------

test("a resync pass still in flight when the connection closes registers nothing after it resumes", async () => {
  const { conn, router, client, events } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  const callsBefore = client.calls.length;

  // Pause the pass at its `session/list`, then tear the connection down.
  const gate = client.gate("session/list");
  const pass = conn.resync();
  await flush();
  await conn.close();
  gate.release();
  await pass;
  await flush();

  // The resumed pass must not subscribe, register, or re-emit.
  assert.equal(
    client.callsOf("events/subscribe", (params) => params.scope === "session").length,
    1,
    "only the original open subscribed the session, not the aborted pass",
  );
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: REMOTE_S1 }]),
    null,
    "a closed connection must hold no registration",
  );
  const afterClose = events.filter(
    (e) => e.channel === IPC.event.remoteHostState && e.payload.state === "connected",
  );
  assert.equal(
    client.reconnectedListenerCount(),
    0,
    "close must detach the reconnect seam",
  );
  assert.equal(client.stateListenerCount(), 0, "close must detach the state seam");
  assert.equal(
    afterClose.length,
    1,
    "no link-state transition may be emitted after teardown",
  );
  assert.ok(client.calls.length >= callsBefore);
});

test("a reconnect signal delivered after close is a no-op", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  await conn.close();
  const callsAfterClose = client.calls.length;

  // The seam an in-flight transport still holds fires after teardown; resync's
  // own guard must refuse even though the listener is gone.
  client.fireReconnectedEverywhere();
  await conn.resync();
  await flush();

  assert.equal(client.calls.length, callsAfterClose, "a closed connection issues no requests");
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: REMOTE_S1 }]),
    null,
    "nothing may be registered after teardown",
  );
});

// ---------------------------------------------------------------------------
// Race 2 — two overlapping reconnect attempts: one subscription, one attach
// ---------------------------------------------------------------------------

test("two overlapping resync passes issue one host subscribe and one session subscribe", async () => {
  const { conn, client } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  const baselineHost = client.callsOf("events/subscribe", (p) => p.scope === "host").length;
  const baselineSession = client.callsOf("events/subscribe", (p) => p.scope === "session").length;

  // Both passes are held at the same await, then released together.
  const gate = client.gate("session/list");
  const first = conn.resync();
  const second = conn.resync();
  await flush();
  gate.release();
  await Promise.all([first, second]);
  await flush();

  assert.equal(
    client.callsOf("events/subscribe", (p) => p.scope === "host").length,
    baselineHost + 1,
    "exactly one host subscribe for two overlapping passes",
  );
  assert.equal(
    client.callsOf("events/subscribe", (p) => p.scope === "session").length,
    baselineSession + 1,
    "exactly one session subscribe for two overlapping passes",
  );
});

test("two overlapping passes re-attach a watched terminal exactly once", async () => {
  const { conn, client } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  // Output for a terminal is how the desktop learns it is watching one.
  client.push({
    eventId: "t1",
    scope: "session",
    sessionId: "s1",
    epoch: "ep-1",
    afterSequence: 0,
    revision: 0,
    kind: "terminal.output",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: { terminalId: "term_1", data: "YQ==" },
  });
  const gate = client.gate("session/list");
  const first = conn.resync();
  const second = conn.resync();
  await flush();
  gate.release();
  await Promise.all([first, second]);
  await flush();

  assert.equal(
    client.callsOf("terminal/open", (p) => p.terminalId === "term_1").length,
    1,
    "exactly one re-attach for two overlapping passes",
  );
});

// ---------------------------------------------------------------------------
// Race 3 — an event from the old connection after the new one is established
// ---------------------------------------------------------------------------

test("a durable event re-delivered after a reconnect is dropped, a newer one is delivered", async () => {
  const { conn, client, agentMessages } = setup({ sessions: [makeSession("s1")] });
  await conn.open();

  client.push(durableEnvelope(5));
  await flush();
  assert.equal(agentMessages().length, 1, "the event is delivered once while current");

  // The reconnect lands; then the old connection's queued frame arrives.
  client.fireReconnected();
  await flush();
  client.push(durableEnvelope(5));
  await flush();
  assert.equal(
    agentMessages().length,
    1,
    "an event at or below the applied watermark must not be delivered as current",
  );

  // The guard is a watermark, not a blanket mute: the next sequence lands.
  client.push(durableEnvelope(6));
  await flush();
  assert.equal(agentMessages().length, 2, "a genuinely newer event is still delivered");
  assert.equal(agentMessages()[1].payload.event.message.id, "m6");
});

// ---------------------------------------------------------------------------
// Race 4 — a session closed while disconnected must not be re-attached
// ---------------------------------------------------------------------------

test("a session closed while disconnected is not re-subscribed and its terminal is not re-attached", async () => {
  const { conn, router, client, events } = setup({
    sessions: [makeSession("s1"), makeSession("s2")],
  });
  await conn.open();
  client.push({
    eventId: "t1",
    scope: "session",
    sessionId: "s1",
    epoch: "ep-1",
    afterSequence: 0,
    revision: 0,
    kind: "terminal.output",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: { terminalId: "term_1", data: "YQ==" },
  });
  const subsBefore = client.callsOf("events/subscribe", (p) => p.scope === "session").length;

  // While away, s1 was archived; the Host's list no longer carries it.
  client.setSessions([makeSession("s2")]);
  client.fireReconnected();
  await flush();

  const newSubs = client.callsOf(
    "events/subscribe",
    (p) => p.scope === "session",
  ).slice(subsBefore);
  assert.deepEqual(
    newSubs.map((call) => call.params.sessionId),
    ["s2"],
    "only the still-live session is re-subscribed",
  );
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: REMOTE_S1 }]),
    null,
    "the closed session must be unregistered, not left registered",
  );
  assert.equal(
    client.callsOf("terminal/open", (p) => p.terminalId === "term_1").length,
    0,
    "a terminal under a closed session must not be re-attached",
  );
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [
      { id: makeRemoteSessionId(HOST_KEY, "s2") },
    ]),
    "the live session stays routable",
  );
  assert.ok(events.length > 0);
});

// ---------------------------------------------------------------------------
// resync.required is honoured, not dropped
// ---------------------------------------------------------------------------

test("a session-scope resync.required refreshes from the Host snapshot and re-subscribes from the head", async () => {
  const { conn, client, sessionsChanged } = setup({
    sessions: [makeSession("s1")],
    cursors: { s1: { epoch: "ep-1", sequence: 9 } },
  });
  await conn.open();

  client.push({
    eventId: "r1",
    scope: "session",
    sessionId: "s1",
    epoch: "ep-2",
    sequence: 1,
    revision: 0,
    kind: "resync.required",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: { reason: "epoch" },
  });
  await flush();

  const refreshes = client.callsOf("session/attach", (p) => p.sessionId === "s1");
  assert.equal(refreshes.length, 1, "the resync.required must trigger a snapshot refresh");
  assert.equal(refreshes[0].params.includeSnapshot, true);
  assert.ok(sessionsChanged().includes("remote.session.resync"));

  const headSubscribes = client
    .callsOf("events/subscribe", (p) => p.scope === "session")
    .filter((call) => call.params.after === undefined);
  assert.ok(
    headSubscribes.length >= 1,
    "after a resync the stream restarts at the head, not from the invalid cursor",
  );
});

test("an unusable cursor (replayComplete false) refetches the snapshot instead of the backlog", async () => {
  const { conn, client, sessionsChanged } = setup({
    sessions: [makeSession("s1")],
    cursors: { s1: { epoch: "ep-1", sequence: 3 } },
  });
  // First session subscribe answers "your cursor is gone"; the head subscribe
  // that follows answers normally.
  let sessionSubscribes = 0;
  client.respond("events/subscribe", (params) => {
    if (params.scope !== "session") return { scope: "host", replayComplete: true };
    sessionSubscribes += 1;
    return sessionSubscribes === 1
      ? { scope: "session", replayComplete: false, resyncReason: "evicted" }
      : { scope: "session", replayComplete: true };
  });

  await conn.open();
  await flush();

  assert.equal(
    client.callsOf("session/attach", (p) => p.sessionId === "s1").length,
    1,
    "an evicted cursor must be refreshed from the snapshot",
  );
  assert.ok(sessionsChanged().includes("remote.session.resync"));
  const subscribeAfter = client.callsOf("events/subscribe", (p) => p.scope === "session");
  assert.equal(subscribeAfter.length, 2, "the invalid cursor is replaced by a head subscribe");
  assert.equal(
    subscribeAfter[1].params.after,
    undefined,
    "the replacement subscribe must not ask for the evicted backlog",
  );
});

test("a reconnect resumes the session stream from the cursor, not from zero", async () => {
  const { conn, client } = setup({
    sessions: [makeSession("s1")],
    cursors: { s1: { epoch: "ep-1", sequence: 7 } },
    hostCursor: { epoch: "ep-1", sequence: 2 },
  });
  await conn.open();
  const before = client.callsOf("events/subscribe", (p) => p.scope === "session").length;

  client.fireReconnected();
  await flush();

  const resumed = client.callsOf("events/subscribe", (p) => p.scope === "session")[before];
  assert.deepEqual(
    resumed.params.after,
    { epoch: "ep-1", sequence: 7 },
    "the desktop keeps a cursor per stream, not an event log",
  );
  const hostResumed = client.callsOf("events/subscribe", (p) => p.scope === "host").at(-1);
  assert.deepEqual(hostResumed.params.after, { epoch: "ep-1", sequence: 2 });
});

// ---------------------------------------------------------------------------
// Honest link state to the UI path
// ---------------------------------------------------------------------------

test("link state is surfaced per host and deduplicated", async () => {
  const { conn, client, linkStates } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  await conn.close();
  await conn.open();

  client.fireState("reconnecting");
  client.fireState("reconnecting");
  client.fireState("failed");
  await flush();

  assert.deepEqual(linkStates(), [
    "connecting",
    "connected",
    "connecting",
    "connected",
    "reconnecting",
    "failed",
  ]);
});

test("a transport connected state that precedes the resync does not double-report", async () => {
  const { conn, client, events } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  const before = events
    .filter((e) => e.channel === IPC.event.remoteHostState)
    .map((e) => e.payload.state);
  const gate = client.gate("session/list");
  const pass = conn.resync();
  // The transport reports connected mid-pass; the pass's own completion is the
  // same state and must not emit a second transition.
  client.fireState("connected");
  gate.release();
  await pass;
  await flush();

  const after = events
    .filter((e) => e.channel === IPC.event.remoteHostState)
    .map((e) => e.payload.state);
  assert.deepEqual(after, before, "no redundant connected transition");
  assert.ok(client.callsOf("session/list").length >= 2);
});
