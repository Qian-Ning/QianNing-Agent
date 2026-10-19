/**
 * The local API channel's wiring, exercised over real HTTP.
 *
 * Every assertion is about something a person could observe: the status code on
 * a real socket, whether a turn was started, what the gateway snapshot says, and
 * whether the port is free after the loop stopped. The Agent Host is a fake
 * because this module's job is composition — the turn itself is the Host's, and
 * `messaging-api-server.test.ts` already covers the HTTP contract in isolation.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { RacpEventEnvelope } from "@pi-desktop/shared";

import {
  API_SERVER_HEALTH_PATH,
  API_SERVER_MESSAGE_PATH,
  MESSAGING_API_SERVER_FORMAT,
  MESSAGING_API_SERVER_FORMAT_VERSION,
  MESSAGING_API_SERVER_SECTION,
  MESSAGING_API_SERVER_TOKEN_SECRET_REF,
  type ApiServerTurnSurface,
} from "@pi-desktop/agent-host";

import { MessagingGatewayRegistry } from "./messaging-gateway-registry.js";
import { MessagingInboundSupervisor } from "./messaging-inbound-supervisor.js";
import {
  createApiServerInboundWiring,
  type HostSettingsSurface,
  type MessagingApiServerWiring,
} from "./messaging-inbound-wiring.js";

const TOKEN = "test-token-8a1f2c";

type Started = { sessionId: string; text: string };

/**
 * A minimal Agent Host: one session stream, one turn that answers at once.
 *
 * The answer is delivered on a microtask, before the adapter has learned its
 * turn id, so the buffering path is the one this test exercises.
 */
function fakeHost(answer: string, failure?: string): {
  agentHost: ApiServerTurnSurface;
  started: Started[];
} {
  const started: Started[] = [];
  const sinks = new Map<string, { deliver(envelope: RacpEventEnvelope): void }>();
  let subscriptions = 0;

  const envelope = (
    kind: RacpEventEnvelope["kind"],
    sessionId: string,
    turnId: string,
    payload: unknown,
  ): RacpEventEnvelope => ({
    eventId: `e-${kind}-${turnId}`,
    scope: "session",
    sessionId,
    turnId,
    epoch: "1",
    sequence: 1,
    revision: 0,
    kind,
    occurredAt: new Date().toISOString(),
    payload,
  });

  const agentHost = {
    async subscribe(_principal: unknown, _params: unknown, sink: { deliver(e: RacpEventEnvelope): void }) {
      subscriptions += 1;
      const subscriptionId = `sub-${subscriptions}`;
      sinks.set(subscriptionId, sink);
      return {
        subscriptionId,
        scope: "session" as const,
        starting: { sequence: 0 },
        replayComplete: true,
      };
    },
    unsubscribe(subscriptionId: string) {
      return sinks.delete(subscriptionId);
    },
    async startTurn(_principal: unknown, params: { sessionId: string; input: { text: string } }) {
      started.push({ sessionId: params.sessionId, text: params.input.text });
      const turnId = `turn-${started.length}`;
      queueMicrotask(() => {
        for (const sink of sinks.values()) {
          if (failure !== undefined) {
            sink.deliver(
              envelope("turn.failed", params.sessionId, turnId, {
                turn: { id: turnId, error: { message: failure } },
              }),
            );
            continue;
          }
          sink.deliver(
            envelope("item.completed", params.sessionId, turnId, {
              itemType: "message",
              itemId: "m1",
              event: {
                type: "message_end",
                message: { id: "m1", role: "assistant", content: answer },
              },
            }),
          );
          sink.deliver(envelope("turn.completed", params.sessionId, turnId, {}));
        }
      });
      return { accepted: true, turn: { id: turnId }, cursor: { sequence: 0 } };
    },
  };

  return { agentHost: agentHost as unknown as ApiServerTurnSurface, started };
}

function settingsFor(
  record: Record<string, unknown> | null,
): HostSettingsSurface & { writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    async read() {
      return record === null ? {} : { [MESSAGING_API_SERVER_SECTION]: record };
    },
    async write(patch) {
      writes.push(patch);
    },
  };
}

function recordFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_API_SERVER_FORMAT,
    version: MESSAGING_API_SERVER_FORMAT_VERSION,
    enabled: true,
    port: 0,
    bindAddress: "127.0.0.1",
    ...overrides,
  };
}

/**
 * A free port `fetch` will actually connect to.
 *
 * `undici` refuses a fixed list of ports outright, and an ephemeral port can land
 * in it, so the tests pick a port outside that list and retry a collision.
 */
async function pickPort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return port;
    } catch {
      probe.close();
    }
  }
  throw new Error("no free port for the test listener");
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A listener holding a port, so a second bind on it fails the way a clash does. */
async function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => res.end("busy"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Run the wiring until it has bound, or until it reports a failure. */
async function run(
  options: {
    record?: Record<string, unknown> | null;
    token?: string | null;
    answer?: string;
    failure?: string;
    gateway?: MessagingGatewayRegistry;
  } = {},
): Promise<{
  wiring: MessagingApiServerWiring;
  controller: AbortController;
  done: Promise<void>;
  failures: string[];
  base: () => string;
}> {
  const settings = settingsFor(
    options.record === undefined ? recordFor({ port: await pickPort() }) : options.record,
  );
  const token = options.token === undefined ? TOKEN : options.token;
  const { agentHost } = fakeHost(options.answer ?? "the answer", options.failure);
  const controller = new AbortController();
  const failures: string[] = [];
  let port: number | null = null;
  const gateway = options.gateway;
  const wiring = createApiServerInboundWiring({
    agentHost,
    settings,
    secrets: async (ref) =>
      ref === MESSAGING_API_SERVER_TOKEN_SECRET_REF ? token : null,
    signal: controller.signal,
    onListening: (address) => {
      port = address.port;
      gateway?.clearFailure("apiServer");
    },
    onFailure: (reason) => {
      failures.push(reason);
      gateway?.fail("apiServer", reason);
    },
  });
  const done = wiring.run();
  const stop = async () => {
    controller.abort();
    await done;
  };
  cleanups.push(stop);
  return {
    wiring,
    controller,
    done,
    failures,
    base: () => {
      if (port === null) throw new Error("the wiring never bound a port");
      return `http://127.0.0.1:${port}`;
    },
  };
}

/** Wait for a condition the loop reaches asynchronously. */
async function eventually(check: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the wiring");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("the local API wiring", () => {
  it("binds nothing when the record is absent", async () => {
    const run1 = await run({ record: null });
    // `run` resolves at once with no listener: nothing was bound at all.
    await run1.done;
    expect(run1.failures).toEqual([]);
    expect(run1.wiring.endpoint).toBeNull();
  });

  it("binds nothing when the record is this build's but disabled", async () => {
    const run1 = await run({ record: recordFor({ enabled: false }) });
    await run1.done;
    expect(run1.wiring.endpoint).toBeNull();
  });

  it("refuses to bind when no token is stored, and says why", async () => {
    const run1 = await run({ token: "" });
    await run1.done;
    expect(run1.failures).toEqual(["no token is stored for the local API channel"]);
    expect(run1.wiring.endpoint).toBeNull();
  });

  it("answers a health probe, and refuses a message with no token without starting a turn", async () => {
    const host = fakeHost("the answer");
    const settings = settingsFor(recordFor());
    const controller = new AbortController();
    let port: number | null = null;
    const wiring = createApiServerInboundWiring({
      agentHost: host.agentHost,
      settings,
      secrets: async () => TOKEN,
      signal: controller.signal,
      onListening: (address) => {
        port = address.port;
      },
    });
    const done = wiring.run();
    cleanups.push(async () => {
      controller.abort();
      await done;
    });
    await eventually(() => port !== null);
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}${API_SERVER_HEALTH_PATH}`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(host.started).toEqual([]);

    const unauthorised = await fetch(`${base}${API_SERVER_MESSAGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(unauthorised.status).toBe(401);
    expect(host.started).toEqual([]);

    const wrong = await fetch(`${base}${API_SERVER_MESSAGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(wrong.status).toBe(401);
    expect(host.started).toEqual([]);
  });

  it("carries an authenticated message into a turn and returns the answer", async () => {
    const host = fakeHost("the agent's answer");
    const settings = settingsFor(recordFor());
    const controller = new AbortController();
    let port: number | null = null;
    const wiring = createApiServerInboundWiring({
      agentHost: host.agentHost,
      settings,
      secrets: async () => TOKEN,
      signal: controller.signal,
      onListening: (address) => {
        port = address.port;
      },
    });
    const done = wiring.run();
    cleanups.push(async () => {
      controller.abort();
      await done;
    });
    await eventually(() => port !== null);

    const response = await fetch(`http://127.0.0.1:${port}${API_SERVER_MESSAGE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ message: "hello there", conversationId: "session-7" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: "the agent's answer" });
    expect(host.started).toEqual([{ sessionId: "session-7", text: "hello there" }]);
  });

  it("reports a port already in use with the operating system's reason, and leaves nothing bound", async () => {
    const busy = await occupyPort();
    cleanups.push(busy.close);
    const gateway = new MessagingGatewayRegistry();
    const run1 = await run({ record: recordFor({ port: busy.port }), gateway });
    await run1.done;
    expect(run1.failures).toHaveLength(1);
    expect(run1.failures[0]).toMatch(/EADDRINUSE|address already in use/i);
    expect(run1.wiring.endpoint).toBeNull();
    // The registry is what the card reads: not running, with the reason.
    const snapshot = gateway.snapshot();
    expect(snapshot.apiServer).toBe(false);
    expect(snapshot.apiServerError).toMatch(/EADDRINUSE|address already in use/i);
    // And the port is still the other program's, not half-held by this one.
    expect(() => run1.base()).toThrow(/never bound/);
  });

  it("stops the listener when the loop is stopped, and frees the port", async () => {
    const gateway = new MessagingGatewayRegistry();
    const run1 = await run({ gateway });
    await eventually(() => run1.wiring.endpoint !== null);
    const base = run1.base();
    expect((await fetch(`${base}${API_SERVER_HEALTH_PATH}`)).status).toBe(200);

    // What the supervisor's stop does: abort, then wait for `run` to settle. The
    // settlement is the evidence the socket is closed, not an assumption.
    run1.controller.abort();
    await run1.done;
    expect(run1.wiring.endpoint).toBeNull();
    await expect(fetch(`${base}${API_SERVER_HEALTH_PATH}`)).rejects.toThrow();

    // The port is genuinely free again: a fresh listener takes it.
    const port = Number(new URL(base).port);
    const probe = createServer((_req, res) => res.end("free"));
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(run1.failures).toEqual([]);
  });

  it("clears a recorded bind failure once a later run binds", async () => {
    const busy = await occupyPort();
    const gateway = new MessagingGatewayRegistry();
    gateway.track("apiServer", { done: new Promise(() => {}) });
    const first = await run({ record: recordFor({ port: busy.port }), gateway });
    await first.done;
    expect(gateway.snapshot().apiServerError).toMatch(/EADDRINUSE|address already in use/i);

    // The port is freed, and the channel is reconciled again.
    await busy.close();
    const second = await run({ gateway });
    await eventually(() => gateway.snapshot().apiServerError === null);
    expect(gateway.snapshot().apiServerError).toBeNull();
  });
});

/** Poll the probe until the listener answers, or fail: `start` launches, it does not bind. */
async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${API_SERVER_HEALTH_PATH}`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the listener never answered its health probe");
}

/**
 * The supervisor is what actually owns the port in production, so the stop path
 * is asserted through it rather than by aborting a wiring by hand: the record
 * stops being startable, reconcile runs, and the socket must be gone afterwards.
 */
describe("the local API channel under the supervisor", () => {
  it("stops the listener when the record stops being startable", async () => {
    const port = await pickPort();
    let startable = true;
    const { agentHost } = fakeHost("the answer");
    const supervisor = new MessagingInboundSupervisor({
      readiness: async () => startable,
      gateway: { track() {}, untrack() {} },
      starters: {
        apiServer: (signal) =>
          createApiServerInboundWiring({
            agentHost,
            settings: settingsFor(recordFor({ port })),
            secrets: async () => TOKEN,
            signal,
          }),
      },
    });

    await supervisor.start("apiServer");
    await waitForHealth(port);
    expect(supervisor.isRunning("apiServer")).toBe(true);

    // The person clears the section: readiness says no, and reconcile stops it.
    startable = false;
    await supervisor.reconcile("apiServer");

    expect(supervisor.isRunning("apiServer")).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}${API_SERVER_HEALTH_PATH}`)).rejects.toThrow();

    // And the port is genuinely free, not merely unanswered.
    const probe = createServer((_req, res) => res.end("free"));
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});
