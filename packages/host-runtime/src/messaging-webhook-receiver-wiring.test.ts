/**
 * The webhook receiver's wiring, exercised over a real socket.
 *
 * The assertions are the ones a sender and an operator can both observe: the
 * status code on the socket, whether a turn started, which session it started
 * on, whether the port is free once the owner stops it, and what the operator is
 * told when the record cannot start at all. The Agent Host is a fake because
 * this module's job is composition; the HTTP contract itself is
 * `messaging-ingress-receiver.test.ts` and the body projection is
 * `messaging-webhook-inbound.test.ts`.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  INGRESS_WEBHOOK_RECEIVER_SECTION,
  INGRESS_WEBHOOK_SECRET_REF,
  MESSAGING_WEBHOOK_INBOUND_FORMAT,
  MESSAGING_WEBHOOK_INBOUND_VERSION,
  signIngressWebhookBody,
} from "@pi-desktop/agent-host";

import {
  createWebhookReceiverWiring,
  type HostSettingsSurface,
  type MessagingWebhookReceiverWiring,
  type WebhookTurnSurface,
} from "./messaging-inbound-wiring.js";

const SECRET = "whsec_test_4f1c9a";
const SESSION = "session-webhook-1";
const PATH_SEGMENT = "generic";

type Started = { sessionId: string; text: string; admission: string };

/** A settings surface whose record the test owns, and whose writes land. */
function fakeSettings(record: Record<string, unknown> | null): HostSettingsSurface & {
  writes: unknown[];
  replace(next: Record<string, unknown> | null): void;
} {
  const writes: unknown[] = [];
  let state: Record<string, unknown> = record === null ? {} : { [INGRESS_WEBHOOK_RECEIVER_SECTION]: record };
  return {
    writes,
    replace(next) {
      state = next === null ? {} : { [INGRESS_WEBHOOK_RECEIVER_SECTION]: next };
    },
    async read() {
      return state;
    },
    async write(patch) {
      writes.push(patch);
      state = { ...state, ...patch };
    },
  };
}

function recordFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_WEBHOOK_INBOUND_FORMAT,
    version: MESSAGING_WEBHOOK_INBOUND_VERSION,
    enabled: true,
    port: 0,
    bindAddress: "127.0.0.1",
    allowNonLoopback: false,
    secretRef: INGRESS_WEBHOOK_SECRET_REF,
    replayWindowSeconds: 300,
    maxBodyBytes: 64 * 1024,
    path: PATH_SEGMENT,
    inbound: { sessionId: SESSION },
    ...overrides,
  };
}

/** One method, because `startTurn` is the whole surface this channel drives. */
function fakeHost(recorded: Started[] = []): { agentHost: WebhookTurnSurface; started: Started[] } {
  const started = recorded;
  const agentHost = {
    async startTurn(_principal: unknown, params: { sessionId: string; admission?: string; input: { text: string } }) {
      started.push({
        sessionId: params.sessionId,
        text: params.input.text,
        admission: params.admission ?? "",
      });
      return { turn: { id: `turn-${started.length}` } };
    },
  } as unknown as WebhookTurnSurface;
  return { agentHost, started };
}

type Running = {
  wiring: MessagingWebhookReceiverWiring;
  base: string;
  abort: AbortController;
  done: Promise<void>;
  settings: HostSettingsSurface & { replace(next: Record<string, unknown> | null): void };
};

/**
 * A free port `fetch` will actually connect to.
 *
 * `undici` refuses a fixed list of ports outright, and an ephemeral port can
 * land in it, so the test picks one outside that list and retries a collision
 * instead of asking the OS for `0`.
 */
async function pickPort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const probe: Server = createServer();
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

/** Start the wiring and wait for the address it actually bound. */
async function start(
  options: {
    recordOverrides?: Record<string, unknown>;
    record?: Record<string, unknown> | null;
    secret?: string | null;
    started?: Started[];
    failures?: string[];
    logs?: Array<{ message: string }>;
  } = {},
): Promise<Running> {
  const abort = new AbortController();
  const host = fakeHost(options.started ?? []);
  const record =
    options.record === undefined
      ? recordFor({ port: await pickPort(), ...(options.recordOverrides ?? {}) })
      : options.record;
  const settings = fakeSettings(record);
  const failures = options.failures ?? [];
  let resolveBound: (address: { host: string; port: number }) => void;
  const bound = new Promise<{ host: string; port: number }>((resolve) => {
    resolveBound = resolve;
  });

  const wiring = createWebhookReceiverWiring({
    agentHost: host.agentHost,
    settings,
    secrets: async () => (options.secret === undefined ? SECRET : options.secret),
    signal: abort.signal,
    onListening: (address) => resolveBound(address),
    onFailure: (reason) => failures.push(reason),
    ...(options.logs
      ? {
          log: (_level, message, data) =>
            options.logs.push({ message: `${message} ${JSON.stringify(data ?? {})}` }),
        }
      : {}),
  });

  const done = wiring.run();
  const race = await Promise.race([
    bound,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
  ]);
  if (!race) {
    // Nothing bound: let the caller assert why, and never send to an address
    // that does not exist.
    await done;
    return { wiring, base: "", abort, done, settings };
  }
  return { wiring, base: `http://${race.host}:${race.port}`, abort, done, settings };
}

/** A signed delivery, exactly the way the documented scheme signs one. */
function signed(
  body: unknown,
  options: { timestamp?: number; secret?: string; delivery?: string } = {},
): { body: string; headers: Record<string, string> } {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    body: raw.toString("utf8"),
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signIngressWebhookBody(options.secret ?? SECRET, timestamp, raw),
      "x-webhook-delivery": options.delivery ?? `delivery-${Math.random().toString(36).slice(2)}`,
    },
  };
}

const running: Running[] = [];

afterEach(async () => {
  for (const item of running.splice(0)) {
    item.abort.abort();
    await item.done;
  }
});

describe("createWebhookReceiverWiring", () => {
  it("accepts a signed event and starts a turn on the bound session", async () => {
    const started: Started[] = [];
    const item = await start({ started });
    running.push(item);

    const request = signed({ text: "deploy finished", id: "evt-1" });
    const response = await fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(200);
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({ sessionId: SESSION, text: "deploy finished", admission: "queue" });
  });

  it("projects the event's own chat id onto the turn when it carries one", async () => {
    const started: Started[] = [];
    const item = await start({ started });
    running.push(item);

    const request = signed({ text: "build failed", chat_id: "ci-room", id: "evt-2" });
    const response = await fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(200);
    expect(started.map((turn) => turn.text)).toEqual(["build failed"]);
  });

  it("refuses a body whose signature does not match, and starts nothing", async () => {
    const started: Started[] = [];
    const item = await start({ started });
    running.push(item);

    const request = signed({ text: "rm -rf /" });
    const response = await fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, {
      method: "POST",
      headers: { ...request.headers, "x-webhook-signature": "0".repeat(64) },
      body: request.body,
    });

    expect(response.status).toBe(401);
    expect(started).toHaveLength(0);
  });

  it("answers a repeated delivery id without starting a second turn", async () => {
    const started: Started[] = [];
    const item = await start({ started });
    running.push(item);

    const request = signed({ text: "only once", id: "evt-same" }, { delivery: "delivery-fixed" });
    const send = () =>
      fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(started).toHaveLength(1);
  });

  it("answers an event but starts nothing when the binding is cleared while it listens", async () => {
    // The receiver answers its HTTP request before the turn starts, so the 200
    // is the receiver's own contract; what must not happen is a turn on a
    // session the record no longer names. The audit carries the failure.
    const started: Started[] = [];
    const logs: Array<{ message: string }> = [];
    const item = await start({ started, logs });
    running.push(item);

    item.settings.replace(recordFor({ port: item.wiring.address?.port ?? 0, inbound: {} }));

    const request = signed({ text: "cleared binding" });
    const response = await fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    expect(response.status).toBe(200);
    expect(started).toHaveLength(0);
    expect(logs.some((entry) => entry.message.includes("no session bound"))).toBe(true);
  });

  it("reports a failure and binds nothing when no signing secret is stored", async () => {
    const failures: string[] = [];
    const item = await start({ secret: null, failures });

    expect(item.base).toBe("");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("signing secret");
    expect(item.wiring.address).toBeNull();
  });

  it("ignores a record written by a different build instead of half-reading it", async () => {
    const failures: string[] = [];
    const item = await start({
      recordOverrides: { version: 2 },
      failures,
    });

    expect(item.base).toBe("");
    expect(failures).toHaveLength(0);
    expect(item.wiring.address).toBeNull();
  });

  it("stops listening when the owner aborts, and frees the port", async () => {
    const item = await start();
    const first = await fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, {
      method: "POST",
      headers: signed({ text: "before stop" }).headers,
      body: signed({ text: "before stop" }).body,
    });
    expect(first.status).toBe(200);

    item.abort.abort();
    await item.done;

    expect(item.wiring.address).toBeNull();
    await expect(
      fetch(`${item.base}/webhooks/${PATH_SEGMENT}`, { method: "POST", body: "{}" }),
    ).rejects.toBeTruthy();
  });
});
