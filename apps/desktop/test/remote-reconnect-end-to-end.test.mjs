/**
 * R2b stage 3b, end to end over the real transport.
 *
 * A real `pi-host` `TerminalService` behind the real RACP in-memory harness, the
 * desktop's RACP adapter (with the production reconnect policy), its event
 * bridge, and its connection layer. The test drives the one thing the unit
 * fixtures cannot: an actual `MemoryLink` drop, the `RacpClient` reconnect with
 * backoff, and the resync pass that re-subscribes and re-attaches afterwards.
 *
 * Nothing here waits on an arbitrary sleep: the reconnect is awaited on the
 * fact (`adapter.state() === "connected"`), and every assertion counts a side
 * effect (requests on the wire, renderer events) rather than trusting that
 * something merely succeeded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { harness, OWNER_TOKEN, MemoryLink, flush } = await import("@pi-desktop/racp/test-harness");
const { createRacpRemoteHostClient } = await import(
  "../electron/main/remote/racp-remote-host-client.ts"
);
const { createBackendRouter, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { createRemoteHostConnection } = await import(
  "../electron/main/remote/remote-host-connection.ts"
);
// The Host half of the terminal surface, so the ring the desktop re-attaches
// from is the real `TerminalService`'s ring, not a fixture's idea of one.
const { TerminalService } = await import("@pi-desktop/pi-host/dist/terminal.js");

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "s1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);
const SESSION_ROOT = "/srv/host/session-root";
/** The Host's ring bound; the desktop may never be handed more than this. */
const RING_BYTES = 64;
/** Reconnect policy for the test: no delay, so the drop is retried at once. */
const RECONNECT = { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 };

function fakePty() {
  const spawned = [];
  const exits = [];
  let onData = null;
  const module = {
    spawn(file, args, options) {
      const record = { file, args, options, writes: [], resizes: [], killed: false };
      spawned.push(record);
      return {
        pid: 4242,
        write(data) {
          record.writes.push(data);
        },
        resize(cols, rows) {
          record.resizes.push([cols, rows]);
        },
        kill() {
          record.killed = true;
        },
        onData(listener) {
          onData = listener;
          return {
            dispose() {
              if (onData === listener) onData = null;
            },
          };
        },
        onExit(listener) {
          exits.push(listener);
          return { dispose() {} };
        },
      };
    },
  };
  return {
    module,
    spawned,
    emit(data) {
      if (!onData) throw new Error("no data listener attached");
      onData(data);
    },
    exit(code) {
      for (const listener of exits) listener({ exitCode: code });
    },
  };
}

/** Bounded wait on the fact under test; never an unbounded sleep. */
async function until(predicate, message) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${message}`);
}

/** Requests the desktop actually put on one link, decoded from its frames. */
function requestsOn(link) {
  return link.toServer
    .map((frame) => {
      try {
        return JSON.parse(frame);
      } catch {
        return null;
      }
    })
    .filter((message) => message && typeof message.method === "string");
}

function callsOf(link, method) {
  return requestsOn(link).filter((message) => message.method === method);
}

/**
 * The desktop stack: real Host, real transport pair, real adapter with the
 * production reconnect shape, the connection under test, and the renderer
 * surface (`events`) the assertions read.
 */
async function stack({ limits } = {}) {
  const pty = fakePty();
  const terminal = new TerminalService({
    pty: pty.module,
    sessionRoot: async () => SESSION_ROOT,
    shell: "/bin/sh",
    replayRingBytes: RING_BYTES,
    log: () => undefined,
  });
  const h = await harness({ ...(limits ? { limits } : {}), operations: { terminal } });
  const links = [];
  const transport = async () => {
    const auth = await h.authenticator.authenticate({
      authorization: `Bearer ${OWNER_TOKEN}`,
      urlHasToken: false,
      connectionId: `test-${links.length}`,
    });
    if (!auth) throw new Error("test authenticator refused OWNER_TOKEN");
    const link = new MemoryLink();
    links.push(link);
    if (!h.server.accept(auth, link.serverSide())) throw new Error("test server refused");
    return link.clientSide();
  };
  const adapter = createRacpRemoteHostClient({
    transport,
    clientInfo: { name: "test-desktop", version: "0.20.0" },
    requestTimeoutMs: 2_000,
    reconnect: { ...RECONNECT },
    log: () => undefined,
  });
  await adapter.connect();
  const router = createBackendRouter();
  const events = [];
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    client: adapter.client,
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    newRequestId: () => "req-const",
    log: () => undefined,
  });
  await conn.open();
  return {
    pty,
    h,
    links,
    adapter,
    router,
    events,
    conn,
    latest: () => links[links.length - 1],
    terminalOutputs: () => events.filter((e) => e.channel === IPC.event.terminalOutput),
    agentMessages: () => events.filter((e) => e.channel === IPC.event.agentMessage),
    linkStates: () =>
      events
        .filter((e) => e.channel === IPC.event.remoteHostState)
        .map((e) => e.payload.state),
  };
}

async function openTerminal(router, extra = {}) {
  return router.route(IPC.invoke.terminalOpen, [
    { sessionId: REMOTE_SESSION_ID, cols: 80, rows: 24, ...extra },
  ]);
}

/** Drop the live link and wait until the adapter has reconnected. */
async function dropAndReconnect(s) {
  const before = s.links.length;
  s.latest().drop();
  await until(() => s.links.length > before && s.adapter.state() === "connected", "reconnect");
  // Let the resync pass (and its requests) settle.
  await flush();
  await flush();
}

test("a drop reconnects and re-subscribes the host and the session it was watching", async () => {
  const s = await stack();

  // The first connection subscribed host scope once and the session once.
  assert.equal(callsOf(s.links[0], "events/subscribe").length, 2);

  await dropAndReconnect(s);

  // A brand new transport was opened, and the resync pass re-subscribed both
  // streams over it: this is re-subscription, not a silently dead pane.
  assert.equal(s.links.length, 2, "a second transport must have been dialed");
  const resubscribed = callsOf(s.latest(), "events/subscribe");
  assert.equal(resubscribed.length, 2, "host scope and the session stream, once each");
  assert.ok(resubscribed.some((call) => call.params.scope === "host"));
  assert.ok(
    resubscribed.some(
      (call) => call.params.scope === "session" && call.params.sessionId === HOST_SESSION_ID,
    ),
  );
  // The session is still routable: the user's pane is not a dead id.
  assert.ok(
    s.router.resolveBackend(IPC.invoke.sessionGet, [{ id: REMOTE_SESSION_ID }]),
    "the session must still resolve to the remote backend after a reconnect",
  );
  // And the renderer was told the host came back.
  assert.deepEqual(s.linkStates(), ["connecting", "connected", "reconnecting", "connected"]);
});

test("a drop re-attaches the terminal the desktop was watching, from the bounded ring", async () => {
  const s = await stack();
  const opened = await openTerminal(s.router);
  const terminalId = opened.value.terminalId;

  const chunks = [];
  for (let index = 0; index < 10; index += 1) {
    const chunk = String(index).repeat(20);
    chunks.push(chunk);
    s.pty.emit(chunk);
  }
  await flush();
  assert.equal(s.terminalOutputs().length, 10, "live output reached the renderer before the drop");

  await dropAndReconnect(s);

  // The re-attach: `terminal/open` WITH the id, over the new link.
  const reattached = callsOf(s.latest(), "terminal/open").filter(
    (call) => call.params.terminalId === terminalId,
  );
  assert.equal(reattached.length, 1, "exactly one re-attach for the watched terminal");
  assert.equal(s.pty.spawned.length, 1, "a re-attach must not spawn a second pty");

  // The re-attached answer is the ring, delivered to the renderer as output.
  const afterDrop = s.terminalOutputs().slice(10);
  assert.equal(afterDrop.length, 1, "the ring arrives as exactly one chunk");
  const replay = Buffer.from(afterDrop[0].payload.data, "base64").toString("utf8");
  assert.ok(replay.length <= RING_BYTES, `ring bound is ${RING_BYTES}, got ${replay.length}`);
  assert.equal(replay, chunks.join("").slice(-replay.length));
  assert.equal(afterDrop[0].payload.sessionId, REMOTE_SESSION_ID);
  assert.equal(afterDrop[0].payload.terminalId, terminalId);
});

test("a reconnect replays only the gap inside the Host window — never an unbounded backlog", async () => {
  const s = await stack();
  const durable = (index) => ({
    sessionId: HOST_SESSION_ID,
    turnId: "rt_1",
    ts: Date.parse("2026-09-18T00:00:01.000Z"),
    event: {
      type: "message_end",
      message: {
        id: `m${index}`,
        role: "assistant",
        content: `chunk ${index}`,
        createdAt: "2026-09-18T00:00:01.000Z",
        status: "complete",
      },
    },
  });

  // One durable event is applied before the drop, so the client holds a cursor.
  s.h.host.ingest(durable(0));
  await flush();
  assert.equal(s.agentMessages().length, 1);

  s.latest().drop();
  // The Host keeps publishing while the desktop is away; both events are still
  // inside the reply window, so the reconnect replays exactly those two.
  s.h.host.ingest(durable(1));
  s.h.host.ingest(durable(2));
  await until(() => s.adapter.state() === "connected" && s.links.length > 1, "reconnect");
  await flush();
  await flush();

  const afterReconnect = s.agentMessages().slice(1);
  assert.equal(afterReconnect.length, 2, "the gap alone is replayed");
  assert.deepEqual(
    afterReconnect.map((event) => event.payload.event.message.id),
    ["m1", "m2"],
  );
});

test("a cursor the Host evicted resyncs from a snapshot and replays nothing", async () => {
  // A two-event reply window, so three events away from the desktop evict the
  // cursor the client held.
  const s = await stack({ limits: { replayWindowEvents: 2 } });
  const durable = (index) => ({
    sessionId: HOST_SESSION_ID,
    turnId: "rt_1",
    ts: Date.parse("2026-09-18T00:00:01.000Z"),
    event: {
      type: "message_end",
      message: {
        id: `m${index}`,
        role: "assistant",
        content: `chunk ${index}`,
        createdAt: "2026-09-18T00:00:01.000Z",
        status: "complete",
      },
    },
  });

  s.h.host.ingest(durable(0));
  await flush();
  const before = s.agentMessages().length;
  assert.equal(before, 1);

  s.latest().drop();
  for (let index = 1; index <= 5; index += 1) s.h.host.ingest(durable(index));
  await until(() => s.adapter.state() === "connected" && s.links.length > 1, "reconnect");
  await flush();
  await flush();

  // The bound: the desktop received NONE of the five events it missed. It took
  // the Host's snapshot instead — the resync, not an unbounded backlog.
  assert.equal(
    s.agentMessages().length,
    before,
    "a resync must not deliver an evicted backlog",
  );
  const refreshed = callsOf(s.latest(), "session/attach");
  assert.ok(
    refreshed.some((call) => call.params.includeSnapshot === true),
    "an invalid cursor must be refreshed from the Host snapshot",
  );
  assert.ok(
    s.events.some(
      (event) =>
        event.channel === IPC.event.sessionsChanged &&
        event.payload.reason === "remote.session.resync",
    ),
    "the renderer must be told to re-read the refreshed session",
  );
});

test("three overlapping resync passes subscribe and re-attach exactly once", async () => {
  const s = await stack();
  const opened = await openTerminal(s.router);
  const terminalId = opened.value.terminalId;
  s.pty.emit("hello");
  await flush();

  const link = s.latest();
  const hostBefore = callsOf(link, "events/subscribe").filter((c) => c.params.scope === "host").length;
  const sessionBefore = callsOf(link, "events/subscribe").filter(
    (c) => c.params.scope === "session",
  ).length;
  const attachBefore = callsOf(link, "terminal/open").filter(
    (c) => c.params.terminalId === terminalId,
  ).length;

  // Three concurrent passes on a live connection: a reconnect storm that must
  // not double-subscribe or double-attach.
  await Promise.all([s.conn.resync(), s.conn.resync(), s.conn.resync()]);
  await flush();

  assert.equal(
    callsOf(link, "events/subscribe").filter((c) => c.params.scope === "host").length,
    hostBefore + 1,
    "one host subscribe across all overlapping passes",
  );
  assert.equal(
    callsOf(link, "events/subscribe").filter((c) => c.params.scope === "session").length,
    sessionBefore + 1,
    "one session subscribe across all overlapping passes",
  );
  assert.equal(
    callsOf(link, "terminal/open").filter((c) => c.params.terminalId === terminalId).length,
    attachBefore + 1,
    "one re-attach across all overlapping passes",
  );
  assert.equal(s.pty.spawned.length, 1);
});
