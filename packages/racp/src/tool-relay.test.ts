/**
 * Exit criterion 6 of rollout R2 (`docs/spec/06-delivery/07-remote-control-rollout.md`),
 * exercised against the in-memory RACP harness — no SSH, no released bundle, no
 * Electron:
 *
 *   1. a desktop-configured MCP tool advertised for relay executes on the
 *      desktop during a remote turn;
 *   2. a workspace-requiring plugin tool is absent from the remote catalog; and
 *   3. closing the desktop mid-call fails the tool without interrupting the turn.
 *
 * The desktop side of these tests is a `RacpClient` whose `onServerRequest`
 * answers `tool/execute`, which is exactly the seam the Electron Main relay
 * (`apps/desktop/electron/main/remote/tool-relay-desktop.ts`) attaches to.
 */
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, RacpRelayedTool, RacpToolsAdvertiseResult, RacpTurn, UiMessage } from "@pi-desktop/shared";

import { OWNER_TOKEN, VIEWER_TOKEN, flush, harness } from "./test-harness.js";
import { ToolRelayRegistry, type RelayTargetConnection } from "./tool-relay.js";

function envelope(sessionId: string, turnId: string, event: AgentEventEnvelope["event"]): AgentEventEnvelope {
  return { sessionId, turnId, ts: Date.parse("2026-09-18T00:00:01.000Z"), event };
}

function assistantMessage(id: string): UiMessage {
  return { id, role: "assistant", content: "done", createdAt: "2026-09-18T00:00:01.000Z", status: "complete" };
}

const COMPLETED_TURN_EVENTS = (sessionId: string, turnId: string): AgentEventEnvelope[] => [
  envelope(sessionId, turnId, { type: "message_end", message: assistantMessage("m1") }),
  envelope(sessionId, turnId, { type: "agent_end", messageIds: ["m1"] }),
];

/** A desktop-configured MCP tool: it never touches the session workspace. */
const MCP_TOOL: RacpRelayedTool = { name: "mcp_corp_search", description: "Search the corp index", kind: "mcp" };

/** A plugin tool that only needs the network, so it is workspace-free and eligible. */
const WORKSPACE_FREE_PLUGIN: RacpRelayedTool = {
  name: "plugin_release_notes",
  description: "Fetch release notes",
  kind: "plugin",
  permissions: ["net.fetch"],
};

/** A plugin tool whose manifest requires the workspace/filesystem: excluded (design decision 2). */
const WORKSPACE_PLUGIN: RacpRelayedTool = {
  name: "plugin_edit_workspace",
  description: "Edit a file in the session workspace",
  kind: "plugin",
  permissions: ["fs.read", "fs.write"],
};

describe("reverse tool relay (R2 exit criterion 6)", () => {
  it("advertises exactly the eligible desktop tools and drops a workspace-requiring plugin tool from the catalog", async () => {
    const h = await harness();
    const desktop = await h.connect(OWNER_TOKEN);

    const advertised = await desktop.client.request<RacpToolsAdvertiseResult>("tools/advertise", {
      sessionId: "s1",
      tools: [MCP_TOOL, WORKSPACE_FREE_PLUGIN, WORKSPACE_PLUGIN],
    });

    // Clause 2: the workspace-requiring plugin tool is absent, with the reason.
    expect(advertised.tools.map((tool) => tool.name).sort()).toEqual(["mcp_corp_search", "plugin_release_notes"]);
    expect(advertised.tools.map((tool) => tool.name)).not.toContain("plugin_edit_workspace");
    expect(advertised.rejected).toHaveLength(1);
    expect(advertised.rejected[0]).toMatchObject({ name: "plugin_edit_workspace" });
    expect(advertised.rejected[0]!.reason).toMatch(/workspace\/filesystem/);
    // The catalog the Host exposes to the session is the same eligible set.
    expect(h.server.relayedCatalog("s1").map((tool) => tool.name).sort()).toEqual(["mcp_corp_search", "plugin_release_notes"]);
    // The Host advertises the relay capability so a client can discover it.
    expect(desktop.client.initialized?.capabilities.toolRelay).toBe(true);
  });

  it("clears a connection's advertised tools when it disconnects", async () => {
    const h = await harness();
    const desktop = await h.connect(OWNER_TOKEN);
    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
    expect(h.server.relayedCatalog("s1")).toHaveLength(1);
    desktop.link().drop();
    await flush();
    expect(h.server.relayedCatalog("s1")).toEqual([]);
  });

  it("requires the owner role and an existing, admitted session to advertise", async () => {
    const h = await harness();
    // A viewer may not advertise at all: `tools/advertise` is owner-gated.
    const viewer = await h.connect(VIEWER_TOKEN);
    await expect(viewer.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The operation is session-addressed (ADR 0325), so it names the session it
    // advertises for and the Host admits that session before the handler stores
    // anything: an unknown session is NOT_FOUND and nothing is recorded. (An
    // `owner`-role principal passes the ownership comparison itself by design,
    // which is why the role gate above, not this one, is what refuses a viewer.)
    const owner = await h.connect(OWNER_TOKEN);
    await expect(owner.client.request("tools/advertise", { sessionId: "nope", tools: [MCP_TOOL] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.server.relayedCatalog("nope")).toEqual([]);
  });

  it("runs an advertised MCP tool on the desktop during a remote turn and returns its result into the turn", async () => {
    const h = await harness();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const desktop = await h.connect(OWNER_TOKEN, {
      onServerRequest: async (method, params) => {
        if (method !== "tool/execute") {
          throw Object.assign(new Error(`unexpected server request ${method}`), { errorCode: "METHOD_NOT_FOUND" });
        }
        calls.push({ method, params: params as Record<string, unknown> });
        return { result: { hits: ["release notes"] }, isError: false };
      },
    });

    // Clause 1: a desktop-configured MCP tool advertised for relay…
    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });

    // …during a remote turn…
    await desktop.client.request("session/attach", { sessionId: "s1" });
    const started = await desktop.client.request<{ turn: RacpTurn }>("turn/start", {
      sessionId: "s1",
      input: { text: "find the release notes" },
      context: { requestId: "r1" },
    });
    expect(started.turn.status).toBe("running");
    h.host.ingest(envelope("s1", started.turn.id, { type: "agent_start" }));
    await flush();

    // …executes on the desktop, and its result comes back into the Host.
    const outcome = await h.server.executeRelayedTool({
      sessionId: "s1",
      turnId: started.turn.id,
      toolCallId: "call_1",
      toolName: "mcp_corp_search",
      args: { query: "release notes" },
    });
    expect(outcome).toMatchObject({ status: "answered", isError: false, result: { hits: ["release notes"] } });

    // The Host sent exactly one `tool/execute` to the advertising desktop, and
    // only the Agent's arguments crossed (the tool never runs on the Host).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toMatchObject({
      sessionId: "s1",
      turnId: started.turn.id,
      toolCallId: "call_1",
      toolName: "mcp_corp_search",
      args: { query: "release notes" },
    });
    expect(calls[0]!.params.executionId).toMatch(/^exec_/);

    // The relay does not disturb the turn, which completes normally.
    for (const event of COMPLETED_TURN_EVENTS("s1", started.turn.id)) h.host.ingest(event);
    await flush();
    const turn = await desktop.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(turn.turn.status).toBe("completed");
  });

  it("refuses a relay for a tool no live desktop advertises", async () => {
    const h = await harness();
    const desktop = await h.connect(OWNER_TOKEN);
    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
    const outcome = await h.server.executeRelayedTool({ sessionId: "s1", toolCallId: "call_1", toolName: "not_advertised", args: {} });
    expect(outcome).toMatchObject({ status: "failed", code: "TOOL_FAILED", reason: "no_advertiser" });
  });

  /**
   * Clause 3 — the clause most easily implemented wrongly. The desktop goes away
   * *while a tool call is in flight*: the Host has sent `tool/execute` and the
   * desktop is holding it when the connection drops. The tool must FAIL with
   * `TOOL_FAILED`, the turn must still be running afterwards, and it must still
   * complete — asserted on the turn's own state, not merely on the absence of an
   * error. A relay that rejected instead of resolving an outcome, or that
   * aborted the turn, fails this test.
   */
  it("fails the tool with TOOL_FAILED when the desktop goes away mid-call, without interrupting the turn", async () => {
    const h = await harness();
    let reachDesktop!: () => void;
    const reachedDesktop = new Promise<void>((resolve) => {
      reachDesktop = resolve;
    });
    // The desktop's answer never arrives: the connection is gone first.
    const desktop = await h.connect(OWNER_TOKEN, {
      onServerRequest: async (method) => {
        if (method !== "tool/execute") {
          throw Object.assign(new Error(`unexpected server request ${method}`), { errorCode: "METHOD_NOT_FOUND" });
        }
        reachDesktop();
        return await new Promise<never>(() => undefined);
      },
    });
    // A second, independent owner connection observes the turn afterwards, so the
    // assertion does not depend on the dropped desktop reconnecting.
    const observer = await h.connect(OWNER_TOKEN);

    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
    await desktop.client.request("session/attach", { sessionId: "s1" });
    const started = await desktop.client.request<{ turn: RacpTurn }>("turn/start", {
      sessionId: "s1",
      input: { text: "search while the desktop dies" },
      context: { requestId: "r1" },
    });
    h.host.ingest(envelope("s1", started.turn.id, { type: "agent_start" }));
    await flush();

    const outcomePromise = h.server.executeRelayedTool({
      sessionId: "s1",
      turnId: started.turn.id,
      toolCallId: "call_1",
      toolName: "mcp_corp_search",
      args: { query: "release notes" },
    });
    // The call is in flight: the Host sent the request and the desktop is holding it.
    await reachedDesktop;
    // The desktop goes away mid-call.
    desktop.link().drop();
    await flush();

    // The tool fails…
    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({ status: "failed", code: "TOOL_FAILED", reason: "disconnected" });

    // …and the turn is NOT interrupted: nothing aborted or stopped it, and it is
    // still running afterwards — the assertion is on the turn's own state.
    expect(h.runtime.aborts).toEqual([]);
    expect(h.runtime.stops).toEqual([]);
    const stillRunning = await observer.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(stillRunning.turn.status).toBe("running");

    // It still completes normally: the failed tool did not end the turn.
    for (const event of COMPLETED_TURN_EVENTS("s1", started.turn.id)) h.host.ingest(event);
    await flush();
    const finished = await observer.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(finished.turn.status).toBe("completed");
  });
});

/**
 * The registry's own lifecycle guards, tested where each one lives, because the
 * two are not the same guard. The server's `release()` call is memory hygiene —
 * it bounds the registry across reconnects — and a *closed* connection is also
 * kept out of the catalog and out of the advertiser lookup by its `isClosed`
 * flag, which closes the window between the transport closing and `release`
 * running. Neither is observable through the other, so each is pinned here.
 */
describe("relay registry lifecycle", () => {
  function openConnection(id: string): RelayTargetConnection & { close(): void } {
    return {
      id,
      isClosed: false,
      request: async () => ({ isError: false }),
      close() {
        this.isClosed = true;
      },
    };
  }

  it("drops an advertisement on release even while the connection is still open", () => {
    const registry = new ToolRelayRegistry();
    const connection = openConnection("conn_1");
    registry.advertise(connection, { sessionId: "s1", tools: [MCP_TOOL] });
    expect(registry.catalogFor("s1")).toHaveLength(1);
    registry.release(connection.id);
    expect(registry.catalogFor("s1")).toEqual([]);
    expect(registry.hasAdvertiser("s1")).toBe(false);
  });

  it("keeps a closed connection out of the catalog and out of the advertiser lookup", () => {
    const registry = new ToolRelayRegistry();
    const connection = openConnection("conn_2");
    registry.advertise(connection, { sessionId: "s1", tools: [MCP_TOOL] });
    expect(registry.advertiserFor("s1", "mcp_corp_search")).toBe(connection);
    connection.close();
    expect(registry.catalogFor("s1")).toEqual([]);
    expect(registry.advertiserFor("s1", "mcp_corp_search")).toBeUndefined();
  });
});
