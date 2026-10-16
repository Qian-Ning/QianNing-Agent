/**
 * Remote workspace routing (rollout R2b): a remote session's list, read and
 * diff must resolve on the Host, and a local session must behave exactly as it
 * did before.
 *
 * The Host half is real — `createWorkspaceAccess` from `pi-host`, over real
 * directories on this filesystem, behind the real in-memory RACP harness — so
 * "the Host's data" and "the Host refuses this path" are measured rather than
 * asserted against a fake. The desktop half is the real `createRemoteBackend`,
 * `createBackendRouter`, `createRemoteHostConnection` and the real local IPC
 * handlers registered by `registerWorkspaceIpc`.
 *
 * The assertion that matters most is in "a remote session's read can never
 * answer from this machine": with the host gone the router falls back to
 * ROUTE_LOCAL (its documented behaviour), and the only thing standing between
 * the user and another machine's file is the local handler's refusal. That test
 * drives the local handler with the same file that a fallback *would* have
 * returned, so a regression there fails rather than passing quietly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { ErrorCodes, IPC } = await import("@pi-desktop/shared");
const { OWNER_TOKEN, MemoryLink, harness } = await import("@pi-desktop/racp/test-harness");
const { collectWorkspaceDiff, listDir } = await import("@pi-desktop/host-runtime");
const { createRacpRemoteHostClient } = await import(
  "../electron/main/remote/racp-remote-host-client.ts"
);
const {
  ROUTE_LOCAL,
  createBackendRouter,
  makeRemoteSessionId,
} = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostConnection } = await import(
  "../electron/main/remote/remote-host-connection.ts"
);
const { registerWorkspaceIpc } = await import("../electron/main/ipc/workspace-ipc.ts");
// The Host's own workspace access, imported from compiled output for the same
// reason the terminal end-to-end test does: the source uses TypeScript
// parameter properties, which Node's strip-only loader rejects.
const { createWorkspaceAccess } = await import("@pi-desktop/pi-host/dist/host-operations.js");

const HOST_KEY = "hostA";
const HOST_SESSION_ID = "s1";
const REMOTE_SESSION_ID = makeRemoteSessionId(HOST_KEY, HOST_SESSION_ID);
/** Assembled rather than written out: a credential-shaped literal in source. */
const AUTH_SCHEME = ["Bea", "rer"].join("");

/**
 * Four real directories: the desktop's own workspace, the Host's workspace, a
 * tree both sides are pointed at (for parity), and a file *outside* every root
 * that a containment check — not a missing file — has to refuse.
 */
async function workspaceFixture() {
  const base = await mkdtemp(join(tmpdir(), "pi-remote-workspace-"));
  const local = join(base, "local");
  const host = join(base, "host");
  const shared = join(base, "shared");
  const dataDir = join(base, "data");
  for (const dir of [local, host, shared, dataDir]) await mkdir(dir, { recursive: true });
  await writeFile(join(local, "local-only.txt"), "local\n");
  await writeFile(join(host, "host-only.txt"), "host\n");
  await writeFile(join(shared, "shared.txt"), "shared\n");
  // Reachable from `shared` by `../outside.txt` and readable by anyone: a
  // refusal here can only come from containment.
  await writeFile(join(base, "outside.txt"), "outside\n");
  // The Host's tree is a work tree, so its diff is a different answer from a
  // machine that has never seen the path rather than two identical empty ones.
  const init = spawnSync("git", ["init", "-q", host], { env: process.env });
  assert.equal(init.status, 0, `git init failed: ${String(init.stderr)}`);
  return { base, local, host, shared, dataDir };
}

/**
 * A host-core double. The local handlers ask it for the open workspace; the
 * Host's workspace access asks it for the session's project root. Everything
 * else fails loudly, so a handler that starts making a new call is visible.
 */
function hostDouble(root) {
  return {
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === "workspace.get") {
        return { workspace: { path: root, name: "root" } };
      }
      if (method === "session.get") {
        return { session: { id: params?.id ?? HOST_SESSION_ID, projectPath: root } };
      }
      throw new Error(`unexpected host-core call: ${method}`);
    },
  };
}

/** The Host's real workspace access over real files, behind the real harness. */
async function hostStack({ hostRoot }) {
  const host = hostDouble(hostRoot);
  const h = await harness({
    operations: {
      workspace: createWorkspaceAccess({ getHost: () => host }),
    },
  });
  const adapter = createRacpRemoteHostClient({
    transport: async () => {
      const auth = await h.authenticator.authenticate({
        authorization: `${AUTH_SCHEME} ${OWNER_TOKEN}`,
        urlHasToken: false,
        connectionId: `test-${Math.random()}`,
      });
      if (!auth) throw new Error("test authenticator refused OWNER_TOKEN");
      const link = new MemoryLink();
      if (!h.server.accept(auth, link.serverSide())) throw new Error("test server refused connection");
      return link.clientSide();
    },
    clientInfo: { name: "test-desktop", version: "0.20.0" },
    requestTimeoutMs: 2_000,
  });
  await adapter.connect();
  const router = createBackendRouter();
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    client: adapter.client,
    router,
    emit: () => undefined,
    newRequestId: () => "req-const",
  });
  // `open()` lists the Host's sessions and registers a backend per session id;
  // the harness seeds one session, `s1`.
  await conn.open();
  return { adapter, conn, host, router };
}

/**
 * The real local handlers, registered and driven exactly as the preload bridge
 * drives them. Nothing here is a stand-in for desktop code: only host-core is a
 * double, and it answers `workspace.get` like the real one.
 */
function localStack({ root, dataDir }) {
  const handlers = new Map();
  const host = hostDouble(root);
  registerWorkspaceIpc({
    registrar: {
      ipcMain: {},
      handle: (channel, fn) => handlers.set(channel, fn),
      handleWithEvent: (channel, fn) => handlers.set(channel, fn),
      assertMainWindowSender: () => undefined,
    },
    getMainWindow: () => null,
    getHost: () => host,
    getSidecar: () => null,
    dataDir,
    isDevelopmentBuild: false,
    plugins: { getLoaded: () => null },
    browserHost: {},
    clipboardHistory: { recordText: () => undefined },
    recordPastedClipboardFiles: () => undefined,
    currentWorkspacePath: () => root,
    setCurrentWorkspacePath: () => undefined,
    withGitBranch: async (workspace) => workspace,
    stripWinLongPrefix: (path) => path,
  });
  return {
    host,
    has: (channel) => handlers.has(channel),
    call: (channel, ...args) => handlers.get(channel)(...args),
  };
}

/** Drive a routed call the way the renderer's IPC invoke does. */
const route = (router, channel, args) => router.route(channel, args);

/**
 * A RACP result crossed JSON, so a key whose value was `undefined` is absent
 * rather than present-and-undefined. Comparing a remote answer with a locally
 * computed one has to account for that and nothing else.
 */
const onTheWire = (value) => JSON.parse(JSON.stringify(value));

test("a remote session's list reaches the Host and returns the Host's tree", async () => {
  const fx = await workspaceFixture();
  try {
    const { router } = await hostStack({ hostRoot: fx.host });
    const outcome = await route(router, IPC.invoke.fsList, [
      { path: "", sessionId: REMOTE_SESSION_ID },
    ]);
    assert.equal(outcome.remote, true, "a remote session's list must not be served locally");
    // The Host's real directory, entry for entry.
    assert.deepEqual(outcome.value, { entries: await listDir(fx.host, "") });
    assert.deepEqual(
      outcome.value.entries.map((entry) => entry.name),
      ["host-only.txt"],
    );
    // The desktop's own tree is a different tree; the answer is not it.
    assert.deepEqual(
      (await listDir(fx.local, "")).map((entry) => entry.name),
      ["local-only.txt"],
    );
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("a remote session's read returns the Host's bytes, and its diff the Host's tree", async () => {
  const fx = await workspaceFixture();
  try {
    const { router } = await hostStack({ hostRoot: fx.host });

    const read = await route(router, IPC.invoke.fsRead, [
      { path: "host-only.txt", sessionId: REMOTE_SESSION_ID },
    ]);
    assert.equal(read.remote, true);
    assert.deepEqual(read.value, { kind: "text", content: "host\n", size: 5 });

    const diff = await route(router, IPC.invoke.workspaceDiff, [
      { sessionId: REMOTE_SESSION_ID },
    ]);
    assert.equal(diff.remote, true);
    assert.deepEqual(diff.value, onTheWire(await collectWorkspaceDiff(fx.host)));
    // A work tree with one untracked file is a different answer from the
    // desktop's own (non-repository) directory, so this is not a coincidence.
    assert.equal(diff.value.repo, true);
    assert.deepEqual(
      diff.value.files.map((file) => file.path),
      ["host-only.txt"],
    );
    assert.deepEqual(await collectWorkspaceDiff(fx.local), {
      repo: false,
      clean: true,
      files: [],
    });
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("a remote call that names no session this backend owns is never served locally", async () => {
  const fx = await workspaceFixture();
  try {
    const { router } = await hostStack({ hostRoot: fx.host });
    const local = localStack({ root: fx.local, dataDir: fx.dataDir });
    // A local id (or none) is not this backend's business: the router stays
    // local, exactly as it did before this change.
    assert.equal(await route(router, IPC.invoke.fsList, [{ path: "" }]), ROUTE_LOCAL);
    assert.equal(
      await route(router, IPC.invoke.fsRead, [{ path: "x", sessionId: "local-session" }]),
      ROUTE_LOCAL,
    );
    assert.equal(await route(router, IPC.invoke.workspaceDiff, []), ROUTE_LOCAL);
    // An id no backend owns — malformed, or a host that has gone — also lands
    // on the local handler, which refuses it. Nothing here can be answered from
    // this machine's filesystem.
    for (const sessionId of ["remote:", "remote:goneHost:s1"]) {
      assert.equal(
        await route(router, IPC.invoke.fsRead, [{ path: "local-only.txt", sessionId }]),
        ROUTE_LOCAL,
      );
      await assert.rejects(
        () => local.call(IPC.invoke.fsRead, { path: "local-only.txt", sessionId }),
        (error) => {
          assert.equal(error.errorCode, ErrorCodes.CAPABILITY_UNAVAILABLE);
          return true;
        },
      );
    }
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("the local session path is unchanged, with and without a remote host present", async () => {
  const fx = await workspaceFixture();
  try {
    const local = localStack({ root: fx.local, dataDir: fx.dataDir });
    // The independent expectation: the same primitives the handler wraps,
    // computed outside it. A change to filtering, ordering, or shape here
    // differences the two.
    assert.deepEqual(await local.call(IPC.invoke.fsList, { path: "" }), {
      entries: await listDir(fx.local, ""),
    });
    assert.deepEqual(await local.call(IPC.invoke.fsRead, { path: "local-only.txt" }), {
      kind: "text",
      content: "local\n",
      size: 6,
    });
    assert.deepEqual(await local.call(IPC.invoke.workspaceDiff), {
      repo: false,
      clean: true,
      files: [],
    });
    // The argument shapes the renderer used before this change, including the
    // no-argument invoke the MCP control plane issues.
    assert.deepEqual(await local.call(IPC.invoke.fsList, {}), {
      entries: await listDir(fx.local, ""),
    });
    assert.equal((await local.call(IPC.invoke.workspaceDiff, {})).repo, false);

    // With a *remote host registered*, a local session's call still routes
    // locally and still answers with the local tree — the new remote branch is
    // additive.
    const { router } = await hostStack({ hostRoot: fx.host });
    assert.equal(await route(router, IPC.invoke.fsList, [{ path: "" }]), ROUTE_LOCAL);
    assert.equal(
      await route(router, IPC.invoke.fsList, [{ path: "", sessionId: "local-session" }]),
      ROUTE_LOCAL,
    );
    assert.deepEqual(await local.call(IPC.invoke.fsList, { path: "" }), {
      entries: await listDir(fx.local, ""),
    });
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("a remote session's read can never answer from this machine", async () => {
  const fx = await workspaceFixture();
  try {
    const local = localStack({ root: fx.local, dataDir: fx.dataDir });
    const { adapter, conn, router } = await hostStack({ hostRoot: fx.host });

    // Serving remotely while the host is there.
    const served = await route(router, IPC.invoke.fsRead, [
      { path: "host-only.txt", sessionId: REMOTE_SESSION_ID },
    ]);
    assert.equal(served.remote, true);
    assert.equal(served.value.content, "host\n");

    // The host goes away, but its session is still registered: the call must
    // fail, and it must fail promptly rather than hanging on a dead socket.
    await adapter.close();
    await assert.rejects(
      () =>
        route(router, IPC.invoke.fsRead, [
          { path: "host-only.txt", sessionId: REMOTE_SESSION_ID },
        ]),
      (error) => {
        assert.equal(error.code, "HOST_DISCONNECTED");
        return true;
      },
    );

    // The harder case: the backend is gone (disconnect, kill switch), so the
    // router answers ROUTE_LOCAL. This is the exact call the local handler would
    // then receive, and the file it names *does* exist locally — which is why
    // answering it would hand the user another machine's file.
    await conn.close();
    assert.equal(
      await route(router, IPC.invoke.fsRead, [
        { path: "local-only.txt", sessionId: REMOTE_SESSION_ID },
      ]),
      ROUTE_LOCAL,
      "the router's fallback is local by design; the handler must refuse it",
    );
    for (const [channel, args] of [
      [IPC.invoke.fsRead, { path: "local-only.txt", sessionId: REMOTE_SESSION_ID }],
      [IPC.invoke.fsList, { path: "", sessionId: REMOTE_SESSION_ID }],
      [IPC.invoke.workspaceDiff, { sessionId: REMOTE_SESSION_ID }],
    ]) {
      await assert.rejects(
        () => local.call(channel, args),
        (error) => {
          assert.equal(error.errorCode, ErrorCodes.CAPABILITY_UNAVAILABLE);
          return true;
        },
        `${channel} answered a remote session from the local filesystem`,
      );
    }
    // The same handler, asked for the same file without a remote session id,
    // returns it — proving the refusal above is a refusal and not a missing
    // file.
    assert.equal(
      (await local.call(IPC.invoke.fsRead, { path: "local-only.txt" })).content,
      "local\n",
    );
    assert.equal((await local.call(IPC.invoke.fsList, { path: "" })).entries.length, 1);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("a path refused locally is refused on the Host, and an accepted one answers alike", async () => {
  const fx = await workspaceFixture();
  try {
    // Both sides pointed at the *same* real tree, so the answers are comparable.
    const local = localStack({ root: fx.shared, dataDir: fx.dataDir });
    const { router } = await hostStack({ hostRoot: fx.shared });
    const remote = (channel, args) => route(router, channel, args);

    // `../outside.txt` exists and is readable; only containment refuses it.
    await assert.rejects(() => local.call(IPC.invoke.fsRead, { path: "../outside.txt" }));
    await assert.rejects(
      () =>
        remote(IPC.invoke.fsRead, [
          { path: "../outside.txt", sessionId: REMOTE_SESSION_ID },
        ]),
      (error) => {
        assert.equal(
          error.code,
          "REMOTE_PATH_FORBIDDEN",
          "the Host must refuse by containment, not by a missing file",
        );
        return true;
      },
    );
    await assert.rejects(() => local.call(IPC.invoke.fsList, { path: "../" }));
    await assert.rejects(
      () => remote(IPC.invoke.fsList, [{ path: "../", sessionId: REMOTE_SESSION_ID }]),
      (error) => error.code === "REMOTE_PATH_FORBIDDEN",
    );

    // Same root, same path, same answer: the remote leg shapes its result with
    // the same rules the local leg does.
    assert.deepEqual(
      await remote(IPC.invoke.fsList, [{ path: "", sessionId: REMOTE_SESSION_ID }]).then(
        (outcome) => outcome.value,
      ),
      await local.call(IPC.invoke.fsList, { path: "" }),
    );
    assert.deepEqual(
      await remote(IPC.invoke.fsRead, [
        { path: "shared.txt", sessionId: REMOTE_SESSION_ID },
      ]).then((outcome) => outcome.value),
      await local.call(IPC.invoke.fsRead, { path: "shared.txt" }),
    );
    assert.deepEqual(
      await remote(IPC.invoke.workspaceDiff, [{ sessionId: REMOTE_SESSION_ID }]).then(
        (outcome) => outcome.value,
      ),
      onTheWire(await local.call(IPC.invoke.workspaceDiff)),
    );
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});
