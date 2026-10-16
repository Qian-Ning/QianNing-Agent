/**
 * The desktop half of the reverse tool relay (rollout R2b; protocol §9.4),
 * exercised through the real Electron Main adapter against the in-memory RACP
 * harness — no socket, no SSH, no Electron binary.
 *
 * This suite proves the desktop client answers the Host's `tool/execute` server
 * request, withholds a workspace-bound plugin tool before advertising, and — the
 * clause easiest to get wrong — that a desktop that closes mid-call fails the
 * tool without interrupting the turn.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createRacpRemoteHostClient } = await import(
  "../electron/main/remote/racp-remote-host-client.ts"
);
const { createDesktopToolRelay } = await import(
  "../electron/main/remote/tool-relay-desktop.ts"
);
const { harness, OWNER_TOKEN, MemoryLink, flush } = await import("@pi-desktop/racp/test-harness");

/** Authenticates OWNER_TOKEN and hands the server the link's server side. */
function ownerTransport({ server, authenticator }) {
  return async () => {
    const auth = await authenticator.authenticate({
      authorization: `Bearer ${OWNER_TOKEN}`,
      urlHasToken: false,
      connectionId: `test-${Math.random()}`,
    });
    if (!auth) throw new Error("test authenticator refused OWNER_TOKEN");
    const link = new MemoryLink();
    const accepted = server.accept(auth, link.serverSide());
    if (!accepted) throw new Error("test server refused connection");
    return link.clientSide();
  };
}

function envelope(sessionId, turnId, event) {
  return { sessionId, turnId, ts: Date.parse("2026-09-18T00:00:01.000Z"), event };
}

const MCP_TOOL = { name: "mcp_corp_search", description: "Search the corp index", kind: "mcp" };
const WORKSPACE_FREE_PLUGIN = {
  name: "plugin_release_notes",
  description: "Fetch release notes",
  kind: "plugin",
  permissions: ["net.fetch"],
};
const WORKSPACE_PLUGIN = {
  name: "plugin_edit_workspace",
  description: "Edit a file in the session workspace",
  kind: "plugin",
  permissions: ["fs.read", "fs.write"],
};

/** Wire an adapter + relay together; the relay needs the adapter's client and the
 * adapter needs the relay's server-request handler, so one is assigned after. */
function wire(h, { listTools, run, log } = {}) {
  let relay;
  const adapter = createRacpRemoteHostClient({
    transport: ownerTransport(h),
    clientInfo: { name: "test-desktop", version: "0.20.0" },
    requestTimeoutMs: 2_000,
    onServerRequest: (method, params) => relay.onServerRequest(method, params),
    ...(log ? { log } : {}),
  });
  relay = createDesktopToolRelay({
    client: { request: (method, params) => adapter.client.request(method, params) },
    tools: { listTools: listTools ?? (async () => [MCP_TOOL, WORKSPACE_FREE_PLUGIN, WORKSPACE_PLUGIN]) },
    runner: { run: run ?? (async () => ({ result: { ok: true }, isError: false })) },
    ...(log ? { log } : {}),
  });
  return { adapter, relay };
}

test("advertises the desktop's eligible tools only, and the Host catalog matches", async () => {
  const h = await harness();
  const { adapter, relay } = wire(h);
  await adapter.connect();

  // The workspace-bound plugin tool never leaves the desktop: withheld up front,
  // because its manifest requires the filesystem the session root does not own.
  const withheld = await relay.eligibleTools();
  assert.deepEqual(
    withheld.excluded.map((entry) => entry.name),
    ["plugin_edit_workspace"],
  );
  assert.match(withheld.excluded[0].reason, /workspace\/filesystem/);

  const catalog = await relay.advertise("s1");
  assert.deepEqual(
    catalog.tools.map((tool) => tool.name).sort(),
    ["mcp_corp_search", "plugin_release_notes"],
  );
  // The advertised set already excluded it, so the Host refuses nothing.
  assert.deepEqual(catalog.rejected, []);
  assert.deepEqual(
    h.server.relayedCatalog("s1").map((tool) => tool.name).sort(),
    ["mcp_corp_search", "plugin_release_notes"],
  );

  await adapter.close();
});

test("runs an advertised tool on the desktop and returns its result to the Host", async () => {
  const h = await harness();
  const ran = [];
  const { adapter, relay } = wire(h, {
    run: async (params) => {
      ran.push(params);
      return { result: { hits: ["release notes"] }, isError: false };
    },
  });
  await adapter.connect();
  await relay.advertise("s1");

  const outcome = await h.server.executeRelayedTool({
    sessionId: "s1",
    toolCallId: "call_1",
    toolName: "mcp_corp_search",
    args: { query: "release notes" },
  });

  assert.equal(outcome.status, "answered");
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.result, { hits: ["release notes"] });
  assert.equal(ran.length, 1);
  assert.equal(ran[0].toolName, "mcp_corp_search");
  assert.deepEqual(ran[0].args, { query: "release notes" });

  await adapter.close();
});

test("answers a tool that throws on the desktop as an isError result, not a protocol error", async () => {
  const h = await harness();
  const { adapter, relay } = wire(h, {
    listTools: async () => [MCP_TOOL],
    run: async () => {
      throw new Error("desktop tool blew up");
    },
  });
  await adapter.connect();
  await relay.advertise("s1");

  const outcome = await h.server.executeRelayedTool({
    sessionId: "s1",
    toolCallId: "call_1",
    toolName: "mcp_corp_search",
    args: {},
  });

  assert.equal(outcome.status, "answered");
  assert.equal(outcome.isError, true);
  assert.match(String(outcome.result), /desktop tool blew up/);

  await adapter.close();
});

test("leaves server requests it does not own unhandled", async () => {
  const h = await harness();
  const { adapter, relay } = wire(h);
  assert.equal(relay.onServerRequest("approval/request", {}), undefined);
  assert.equal(relay.onServerRequest("input/request", {}), undefined);
  await adapter.close();
});

test("a desktop that closes mid-call fails the tool without interrupting the turn", async () => {
  const h = await harness();
  let reachDesktop;
  const reached = new Promise((resolve) => {
    reachDesktop = resolve;
  });
  const { adapter, relay } = wire(h, {
    listTools: async () => [MCP_TOOL],
    run: async () => {
      reachDesktop();
      return await new Promise(() => undefined); // the answer never comes
    },
  });
  // An independent owner connection observes the turn afterwards, so the
  // assertion does not depend on the closed desktop reconnecting.
  const observer = await h.connect(OWNER_TOKEN);

  await adapter.connect();
  await relay.advertise("s1");
  await adapter.client.request("session/attach", { sessionId: "s1" });
  const started = await adapter.client.request("turn/start", {
    sessionId: "s1",
    input: { text: "search while the desktop dies" },
    context: { requestId: "r1" },
  });
  h.host.ingest(envelope("s1", started.turn.id, { type: "agent_start" }));
  await flush();

  const pending = h.server.executeRelayedTool({
    sessionId: "s1",
    turnId: started.turn.id,
    toolCallId: "call_1",
    toolName: "mcp_corp_search",
    args: { query: "release notes" },
  });
  await reached; // the Host sent tool/execute and the desktop is holding it
  await adapter.close(); // the desktop goes away mid-call

  const outcome = await pending;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "TOOL_FAILED");

  // The turn is not interrupted; it is still running and still completes.
  const stillRunning = await observer.client.request("turn/get", { turnId: started.turn.id });
  assert.equal(stillRunning.turn.status, "running");
  h.host.ingest(
    envelope("s1", started.turn.id, {
      type: "agent_end",
      messageIds: [],
    }),
  );
  await flush();
  const finished = await observer.client.request("turn/get", { turnId: started.turn.id });
  assert.equal(finished.turn.status, "completed");

  await observer.client.close();
});
