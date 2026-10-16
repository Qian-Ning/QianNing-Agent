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
// The Host half of remote terminal support, driven end to end so the bound the
// desktop must not undermine is the real one — the pty's replay ring. Imported
// from the package's compiled output because the source uses TypeScript
// parameter properties, which Node's strip-only loader rejects; CI runs
// `pnpm build:js` before every test job, the same as `@pi-desktop/racp`.
const { TerminalService } = await import("@pi-desktop/pi-host/dist/terminal.js");

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "s1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);
const SESSION_ROOT = "/srv/host/session-root";
/** The ring bound the Host is constructed with; the desktop may never exceed it. */
const RING_BYTES = 64;

/**
 * A pty double: `TerminalService` injects its pty module, so the test owns the
 * byte stream. One terminal is enough — the module records the spawn options
 * and lets the test push output and fire the exit.
 */
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

/** A transport factory that authenticates OWNER_TOKEN on every (re)connect. */
function ownerTransport({ server, authenticator }) {
  return async () => {
    const auth = await authenticator.authenticate({
      authorization: `Bearer ${OWNER_TOKEN}`,
      urlHasToken: false,
      connectionId: `test-${Math.random()}`,
    });
    if (!auth) throw new Error("test authenticator refused OWNER_TOKEN");
    const link = new MemoryLink();
    if (!server.accept(auth, link.serverSide())) throw new Error("test server refused connection");
    return link.clientSide();
  };
}

/**
 * Wire the whole desktop path: a real `pi-host` TerminalService behind the real
 * RACP in-memory harness, the desktop's RACP adapter, its event bridge and its
 * backend router. `emit` is the renderer-facing surface under test.
 */
async function stack() {
  const pty = fakePty();
  const terminal = new TerminalService({
    pty: pty.module,
    sessionRoot: async () => SESSION_ROOT,
    shell: "/bin/sh",
    replayRingBytes: RING_BYTES,
    log: () => undefined,
  });
  const h = await harness({ operations: { terminal } });
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.20.0" },
    requestTimeoutMs: 2_000,
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
  });
  await conn.open();
  return { pty, h, adapter, router, events, conn, terminalOutputs: () =>
    events.filter((event) => event.channel === IPC.event.terminalOutput) };
}

/** Open a terminal through the router exactly as the renderer's IPC call would. */
async function openTerminal(router, extra = {}) {
  return router.route(IPC.invoke.terminalOpen, [
    { sessionId: REMOTE_SESSION_ID, cols: 80, rows: 24, ...extra },
  ]);
}

test("a terminal opened on a remote session runs on the Host, inside the session root", async () => {
  const { pty, router } = await stack();
  const outcome = await openTerminal(router);
  assert.equal(outcome.remote, true);
  assert.equal(typeof outcome.value.terminalId, "string");
  assert.equal(outcome.value.replay, "");
  assert.equal(outcome.value.cols, 80);
  assert.equal(outcome.value.rows, 24);
  // The Host spawned a real pty; its cwd is the Host-resolved session root, not
  // anything the desktop sent (no working directory crosses the wire).
  assert.equal(pty.spawned.length, 1);
  assert.equal(pty.spawned[0].options.cwd, SESSION_ROOT);
  assert.equal(pty.spawned[0].options.cols, 80);
});

test("Host output reaches the desktop surface as bounded chunks keyed by the remote session", async () => {
  const { pty, router, terminalOutputs } = await stack();
  const opened = await openTerminal(router);
  const terminalId = opened.value.terminalId;

  const chunks = [];
  for (let index = 0; index < 10; index += 1) {
    const chunk = String(index).repeat(20);
    chunks.push(chunk);
    pty.emit(chunk);
  }
  await flush();

  const outputs = terminalOutputs();
  assert.equal(outputs.length, 10, "every Host chunk is delivered exactly once");
  assert.deepEqual(
    outputs.map((event) => event.payload.data),
    chunks.map((chunk) => Buffer.from(chunk, "utf8").toString("base64")),
  );
  for (const event of outputs) {
    assert.equal(event.payload.sessionId, REMOTE_SESSION_ID);
    assert.equal(event.payload.terminalId, terminalId);
  }
  // The 200 bytes of live output is delivered in full; only the replay ring is
  // bounded, which the reconnect test below asserts.
  assert.equal(
    outputs.map((event) => Buffer.from(event.payload.data, "base64").toString("utf8")).join(""),
    chunks.join(""),
  );
});

test("terminal input and resize reach the Host pty", async () => {
  const { pty, router } = await stack();
  const opened = await openTerminal(router);
  const terminalId = opened.value.terminalId;

  const typed = "echo hello\n";
  const input = await router.route(IPC.invoke.terminalInput, [
    { sessionId: REMOTE_SESSION_ID, terminalId, data: Buffer.from(typed, "utf8").toString("base64") },
  ]);
  assert.deepEqual(input.value, { ok: true });
  assert.deepEqual(pty.spawned[0].writes, [typed]);

  const resized = await router.route(IPC.invoke.terminalResize, [
    { sessionId: REMOTE_SESSION_ID, terminalId, cols: 100, rows: 30 },
  ]);
  assert.deepEqual(resized.value, { ok: true });
  assert.deepEqual(pty.spawned[0].resizes, [[100, 30]]);

  const closed = await router.route(IPC.invoke.terminalClose, [
    { sessionId: REMOTE_SESSION_ID, terminalId },
  ]);
  assert.deepEqual(closed.value, { ok: true });
  assert.equal(pty.spawned[0].killed, true);
});

test("a reconnecting client re-attaches and receives the bounded ring, never a backlog", async () => {
  const { pty, router } = await stack();
  const opened = await openTerminal(router);
  const terminalId = opened.value.terminalId;

  // 200 bytes of history, in 20-byte chunks; the ring holds the last 64 bytes.
  const chunks = [];
  for (let index = 0; index < 10; index += 1) {
    const chunk = String(index).repeat(20);
    chunks.push(chunk);
    pty.emit(chunk);
  }
  await flush();

  // The reconnect path: `terminal/open` WITH the terminal id re-attaches and
  // answers with the ring alone.
  const reattached = await openTerminal(router, { terminalId });
  assert.equal(reattached.value.terminalId, terminalId);
  // A re-attach must not spawn a second pty.
  assert.equal(pty.spawned.length, 1);

  const replay = Buffer.from(reattached.value.replay, "base64").toString("utf8");
  const total = chunks.join("").length;
  assert.equal(total, 200);
  assert.ok(
    replay.length <= RING_BYTES,
    `the ring bound is ${RING_BYTES} bytes, got ${replay.length}`,
  );
  // It is the ring's bytes — the tail of the stream, not the whole backlog.
  assert.equal(replay, chunks.join("").slice(-replay.length));
  assert.ok(replay.length < total, "a reconnecting client must not receive the whole stream");
});

test("Host exit ends the terminal through the changed surface", async () => {
  const { pty, router, events } = await stack();
  const opened = await openTerminal(router);
  pty.exit(130);
  await flush();
  const changed = events.filter((event) => event.channel === IPC.event.terminalChanged);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].payload.sessionId, REMOTE_SESSION_ID);
  assert.equal(changed[0].payload.terminalId, opened.value.terminalId);
  assert.equal(changed[0].payload.state, "exited");
  assert.equal(changed[0].payload.code, 130);
});

test("a disconnect mid-stream stops the desktop from delivering, and teardown is safe", async () => {
  const { pty, router, events, conn } = await stack();
  await openTerminal(router);
  pty.emit("before-drop");
  await flush();
  const before = events.filter((event) => event.channel === IPC.event.terminalOutput).length;
  assert.equal(before, 1);

  await conn.close();
  pty.emit("after-drop");
  await flush();
  assert.equal(
    events.filter((event) => event.channel === IPC.event.terminalOutput).length,
    before,
    "no output may reach the renderer after teardown",
  );
});
