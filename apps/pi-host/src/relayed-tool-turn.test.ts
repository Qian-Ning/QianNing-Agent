/**
 * The reverse tool relay, end to end through a real turn (rollout R2b, R2
 * criterion 6 clause 1: "a desktop-configured MCP tool advertised for relay
 * executes on the desktop DURING A REMOTE TURN").
 *
 * The relay-layer suite (`packages/racp/src/tool-relay.test.ts`) proves the
 * registry's contract; it calls `RacpServer.executeRelayedTool` directly, which
 * a passing production build never does by itself. This suite closes the gap
 * the rollout named: it drives the *wiring* that makes the relay reachable from
 * an agent turn —
 *
 *   the advertised catalog reaches the runtime's tool list, so the tool is
 *   offered in that session, and the agent's call for it is routed through
 *   `RacpServer.executeRelayedTool` to the desktop and returned as the tool's
 *   outcome, while the turn keeps running.
 *
 * It uses the real components on both sides of the seam: the in-memory RACP
 * harness (`@pi-desktop/racp/test-harness`) for the Host and the desktop client,
 * and a real `AgentSidecar` — spawning a real child process that issues the
 * reverse `tools.list` / `tools.execute` RPCs exactly as the Agent runtime does.
 * No SSH, no released bundle, no Electron. The one fake is host-core, an
 * external process binary this machine does not have, stood in for by a
 * `SidecarHostLink` that answers `tools.list`.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import type { AgentEventEnvelope, RacpRelayedTool, RacpTurn, UiMessage } from "@pi-desktop/shared";
import { modelConfigFromPi } from "@pi-desktop/agent-runtime";
import { AgentSidecar, type SidecarHostLink } from "@pi-desktop/host-runtime";
import { OWNER_TOKEN, harness, flush, summary } from "@pi-desktop/racp/test-harness";

import { RelayedToolBridge } from "./relayed-tools.js";

/**
 * A real reverse-RPC child, the shape `ParentHostProxy` speaks: on a `probe`
 * request from the embedding host it issues one `host.proxy` call and returns
 * that call's result as the probe's result. This is what a real Agent runtime
 * does when it lists tools or executes one.
 */
const CHILD_SOURCE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const pending = new Map();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'probe') {
    const hp = 'hp_' + m.id;
    pending.set(hp, m.id);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: hp, method: 'host.proxy', params: m.params }) + '\\n');
  } else if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
    const pid = pending.get(m.id); pending.delete(m.id);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: pid, ...(m.error ? { error: m.error } : { result: m.result }) }) + '\\n');
  }
});
`;

/** A desktop-configured MCP tool: workspace-free, so eligible for relay. */
const MCP_TOOL: RacpRelayedTool = { name: "mcp_corp_search", description: "Search the corp index", kind: "mcp" };

const HOST_TOOLS = [{ name: "Read", description: "Read a file" }];

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

const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

type Fixture = {
  h: Awaited<ReturnType<typeof harness>>;
  sidecar: AgentSidecar;
  bridge: RelayedToolBridge;
  /** The `tools.list` names the runtime would see for a session. */
  list(sessionId: string): Promise<string[]>;
  /** Run `tools.execute` for a tool the runtime offers, exactly as the runtime would. */
  execute(input: {
    sessionId: string;
    turnId?: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<{ ok: boolean; isError?: boolean; errorCode?: string; content: unknown }>;
};

async function fixture(): Promise<Fixture> {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", CHILD_SOURCE] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const host: SidecarHostLink = {
    async call<T>(method: string): Promise<T> {
      if (method === "tools.list") return { tools: HOST_TOOLS } as T;
      return { ok: true } as T;
    },
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);

  let bridge!: RelayedToolBridge;
  const h = await harness({ onRelayedToolsChanged: (sessionId) => bridge.onCatalogChanged(sessionId) });
  // A second session the desktop never advertises for, to prove the offer is
  // per-session and cannot leak one session's desktops into another's catalog.
  h.sessions.set("s2", summary("s2"));
  bridge = new RelayedToolBridge({ server: h.server, getSidecar: () => sidecar, log: () => {} });

  return {
    h,
    sidecar,
    bridge,
    async list(sessionId) {
      const result = await sidecar.call<{ tools?: Array<{ name?: unknown }> }>("probe", {
        method: "tools.list",
        params: { sessionId },
      });
      return (result.tools ?? []).map((tool) => String(tool.name));
    },
    execute: (input) =>
      sidecar.call("probe", {
        method: "tools.execute",
        params: { mode: "agent", ...input },
      }),
  };
}

describe("reverse tool relay through a real agent turn (R2 criterion 6 clause 1)", () => {
  it("offers an advertised desktop tool in that session's tool list and runs it on the desktop during the turn", async () => {
    const { h, list, execute } = await fixture();
    const desktopCalls: Array<Record<string, unknown>> = [];
    const desktop = await h.connect(OWNER_TOKEN, {
      onServerRequest: async (method, params) => {
        if (method !== "tool/execute") {
          throw Object.assign(new Error(`unexpected server request ${method}`), { errorCode: "METHOD_NOT_FOUND" });
        }
        desktopCalls.push(params as Record<string, unknown>);
        return { result: { hits: ["release notes"] }, isError: false };
      },
    });

    // Before any advertisement the runtime sees only the host's own catalog.
    expect(await list("s1")).toEqual(["Read"]);

    // The desktop advertises its MCP tool for the session.
    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
    await flush();

    // The tool is now offered to the agent IN THAT SESSION…
    expect(await list("s1")).toEqual(["Read", "mcp_corp_search"]);
    // …and not in another session that has no advertiser (per-session scoping).
    expect(await list("s2")).toEqual(["Read"]);

    // A real remote turn is running.
    await desktop.client.request("session/attach", { sessionId: "s1" });
    const started = await desktop.client.request<{ turn: RacpTurn }>("turn/start", {
      sessionId: "s1",
      input: { text: "find the release notes" },
      context: { requestId: "r1" },
    });
    expect(started.turn.status).toBe("running");
    h.host.ingest(envelope("s1", started.turn.id, { type: "agent_start" }));
    await flush();

    // The agent's call for that tool is routed to the desktop and its result
    // comes back as the tool's outcome.
    const outcome = await execute({
      sessionId: "s1",
      turnId: started.turn.id,
      toolCallId: "call_1",
      toolName: "mcp_corp_search",
      args: { query: "release notes" },
    });
    expect(outcome).toMatchObject({ ok: true, content: { hits: ["release notes"] } });

    // It ran on the desktop, with only the agent's arguments crossing.
    expect(desktopCalls).toHaveLength(1);
    expect(desktopCalls[0]).toMatchObject({
      sessionId: "s1",
      turnId: started.turn.id,
      toolCallId: "call_1",
      toolName: "mcp_corp_search",
      args: { query: "release notes" },
    });

    // The relayed call left the turn running; it completes normally.
    const running = await desktop.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(running.turn.status).toBe("running");
    for (const event of COMPLETED_TURN_EVENTS("s1", started.turn.id)) h.host.ingest(event);
    await flush();
    const finished = await desktop.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(finished.turn.status).toBe("completed");
  });

  it("adds a late advertisement to the tool list and removes it when the desktop disconnects", async () => {
    const { h, list } = await fixture();
    expect(await list("s1")).toEqual(["Read"]);

    const desktop = await h.connect(OWNER_TOKEN);
    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
    await flush();
    expect(await list("s1")).toEqual(["Read", "mcp_corp_search"]);

    // The desktop goes away: the advertisement is released and the tool leaves
    // both the session catalog and the offered list.
    desktop.link().drop();
    await flush();
    expect(h.server.relayedCatalog("s1")).toEqual([]);
    expect(await list("s1")).toEqual(["Read"]);
  });

  it("fails only the tool when the desktop goes away mid-call, without interrupting the turn", async () => {
    const { h, list, execute } = await fixture();
    let reachDesktop!: () => void;
    const reachedDesktop = new Promise<void>((resolve) => {
      reachDesktop = resolve;
    });
    const desktop = await h.connect(OWNER_TOKEN, {
      onServerRequest: async (method) => {
        if (method !== "tool/execute") {
          throw Object.assign(new Error(`unexpected server request ${method}`), { errorCode: "METHOD_NOT_FOUND" });
        }
        // The desktop holds the call; its connection is dropped before it answers.
        reachDesktop();
        return await new Promise<never>(() => undefined);
      },
    });
    const observer = await h.connect(OWNER_TOKEN);

    await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
    await flush();
    expect(await list("s1")).toEqual(["Read", "mcp_corp_search"]);

    await desktop.client.request("session/attach", { sessionId: "s1" });
    const started = await desktop.client.request<{ turn: RacpTurn }>("turn/start", {
      sessionId: "s1",
      input: { text: "search while the desktop dies" },
      context: { requestId: "r1" },
    });
    h.host.ingest(envelope("s1", started.turn.id, { type: "agent_start" }));
    await flush();

    const pending = execute({
      sessionId: "s1",
      turnId: started.turn.id,
      toolCallId: "call_1",
      toolName: "mcp_corp_search",
      args: { query: "release notes" },
    });
    await reachedDesktop;
    desktop.link().drop();
    await flush();

    // The tool fails with the relay's failure code, as a tool result — not an
    // exception that would tear the turn down.
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, isError: true, errorCode: "TOOL_FAILED" });

    // The turn is untouched: nothing aborted or stopped it, and it still runs.
    expect(h.runtime.aborts).toEqual([]);
    expect(h.runtime.stops).toEqual([]);
    const stillRunning = await observer.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(stillRunning.turn.status).toBe("running");

    // And it still completes normally.
    for (const event of COMPLETED_TURN_EVENTS("s1", started.turn.id)) h.host.ingest(event);
    await flush();
    const finished = await observer.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
    expect(finished.turn.status).toBe("completed");
    expect(h.runtime.aborts).toEqual([]);
  });
});

/**
 * The same wiring, but with the *real Agent runtime* running the turn instead of
 * a hand-rolled child. The sidecar spawns the production sidecar entry
 * (`packages/agent-runtime/dist/sidecar.js`), which builds a real
 * `DesktopAgentRuntime`: it calls `tools.list` over the reverse RPC (the sidecar
 * merges the relayed overlay built from the desktop's advertisement), the
 * scripted model emits a call for the advertised tool, and the runtime issues
 * `tools.execute` — the exact host call the bridge is registered for. The one
 * stand-in is the model endpoint (an HTTP/SSE server), the legitimate external
 * boundary, so the turn is the production agent loop end to end.
 */
describe("reverse tool relay inside a real agent-runtime turn (R2 criterion 6 clause 1)", () => {
  /** A scripted OpenAI-completions SSE endpoint: one tool call per entry, then a stop. */
  function sseModelServer(calls: Array<{ name: string; args?: Record<string, unknown> }>) {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>);
      } catch {
        /* a malformed body only matters to the assertion below */
      }
      const call = calls.shift();
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              },
            ],
          }
        : { role: "assistant", content: "Done." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    return new Promise<{ url: string; requests: Array<Record<string, unknown>>; close: () => Promise<void> }>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("no server address"));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          requests,
          close: () =>
            new Promise<void>((done, fail) => {
              // The sidecar keeps the model connection alive; drop it so close()
              // does not wait on it once the turn is done.
              server.closeAllConnections();
              server.close((error) => (error ? fail(error) : done()));
            }),
        });
      });
    });
  }

  it("runs the advertised desktop tool during a real agent-runtime turn and feeds its result back into the turn", async () => {
    const model = Object.values(DEEPSEEK_MODELS).find((entry) => entry.id === "deepseek-flash")!;
    const wire = await sseModelServer([{ name: "mcp_corp_search", args: { query: "release notes" } }]);
    const sidecarPath = fileURLToPath(new URL("../../../packages/agent-runtime/dist/sidecar.js", import.meta.url));

    const sidecar = new AgentSidecar({
      launch: { command: process.execPath, args: [sidecarPath] },
      onStderr: () => {},
    });
    sidecars.push(sidecar);

    // The runtime emits its turn as `agent.event` notifications; the turn is the
    // real one, so its `tool_end` is the runtime consuming the tool's result.
    const events: Array<{ type?: string; toolCallId?: string; result?: { details?: unknown; isError?: boolean }; isError?: unknown }> = [];
    let resolveToolEnd!: () => void;
    const toolEnded = new Promise<void>((resolve) => {
      resolveToolEnd = resolve;
    });
    sidecar.onNotification((method, params) => {
      if (method !== "agent.event") return;
      const event = (params as { event: { type?: string } }).event;
      events.push(event);
      if (event.type === "tool_end") resolveToolEnd();
    });
    // host-core is the one external process this machine lacks: the link answers
    // the host calls the runtime makes during the turn.
    const host: SidecarHostLink = {
      async call<T>(method: string): Promise<T> {
        if (method === "tools.list") return { tools: HOST_TOOLS } as T;
        if (method === "session.get") return { session: null } as T;
        return { ok: true } as T;
      },
      onNotification: () => () => {},
      onExit: () => () => {},
    };
    sidecar.setHost(host);

    let bridge!: RelayedToolBridge;
    const h = await harness({ onRelayedToolsChanged: (sessionId) => bridge.onCatalogChanged(sessionId) });
    bridge = new RelayedToolBridge({ server: h.server, getSidecar: () => sidecar, log: () => {} });

    try {
      const desktopCalls: Array<Record<string, unknown>> = [];
      const desktop = await h.connect(OWNER_TOKEN, {
        onServerRequest: async (method, params) => {
          if (method !== "tool/execute") {
            throw Object.assign(new Error(`unexpected server request ${method}`), { errorCode: "METHOD_NOT_FOUND" });
          }
          desktopCalls.push(params as Record<string, unknown>);
          return { result: { hits: ["release notes"] }, isError: false };
        },
      });

      // The desktop advertises its tool, and the runtime will see it once it runs.
      await desktop.client.request("tools/advertise", { sessionId: "s1", tools: [MCP_TOOL] });
      await flush();

      // A real remote turn is running.
      await desktop.client.request("session/attach", { sessionId: "s1" });
      const started = await desktop.client.request<{ turn: RacpTurn }>("turn/start", {
        sessionId: "s1",
        input: { text: "find the release notes" },
        context: { requestId: "r1" },
      });
      h.host.ingest(envelope("s1", started.turn.id, { type: "agent_start" }));
      await flush();

      // The REAL agent runtime runs the turn, carrying the remote turn's id.
      await sidecar.call("agent.prompt", {
        sessionId: "s1",
        content: "find the release notes",
        turnId: started.turn.id,
        mode: "agent",
        thinkingLevel: "off",
        provider: {
          id: "flash-fixture",
          name: "Flash",
          modelId: model.id,
          baseUrl: wire.url,
          apiKey: "test-key",
          authKind: "api_key",
          supportsReasoning: false,
          supportedThinkingLevels: ["off"],
          modelConfig: modelConfigFromPi(model),
        },
        commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      });

      // Wait until the runtime has executed the tool; then for the follow-up
      // model request that carries its result back into the loop.
      await Promise.race([
        toolEnded,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("real agent turn did not execute the tool in time")), 45_000),
        ),
      ]);
      const requestDeadline = Date.now() + 5_000;
      while (wire.requests.length < 2 && Date.now() < requestDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await flush();

      // The tool ran on the desktop, carrying the turn the runtime was running.
      expect(desktopCalls).toHaveLength(1);
      expect(desktopCalls[0]).toMatchObject({
        sessionId: "s1",
        turnId: started.turn.id,
        toolName: "mcp_corp_search",
        args: { query: "release notes" },
      });

      // The turn consumed the result: the runtime emitted `tool_end` — keyed to
      // the very call the desktop answered — carrying the desktop's answer, and
      // appended the tool row to the transcript.
      const toolEnd = events.find((event) => event.type === "tool_end");
      expect(toolEnd).toBeDefined();
      expect(toolEnd!.toolCallId).toBe(desktopCalls[0]!.toolCallId);
      expect(toolEnd!.result).toMatchObject({ details: { hits: ["release notes"] }, isError: false });
      expect(toolEnd!.isError).toBe(false);
      // The turn fed the result back into the agent loop: the follow-up model
      // request carried the desktop's answer as the tool result.
      expect(wire.requests.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(wire.requests.at(-1))).toContain("release notes");

      // The relayed call left the remote turn running; it completes normally.
      const running = await desktop.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
      expect(running.turn.status).toBe("running");
      for (const event of COMPLETED_TURN_EVENTS("s1", started.turn.id)) h.host.ingest(event);
      await flush();
      const finished = await desktop.client.request<{ turn: RacpTurn }>("turn/get", { turnId: started.turn.id });
      expect(finished.turn.status).toBe("completed");
    } finally {
      await wire.close();
    }
  }, 60_000);
});
