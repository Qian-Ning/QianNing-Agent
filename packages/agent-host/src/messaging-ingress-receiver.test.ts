/**
 * The inbound webhook receiver's proof.
 *
 * Everything here runs against a real HTTP listener on a real loopback port the
 * test allocated by asking for port `0`; no external network is touched and no
 * port is hard-coded. The requests are signed with the generic HMAC scheme, and
 * the assertions are the guarantees a callback platform will rely on: a valid
 * delivery becomes one turn, a tampered one does not, a replayed one does not,
 * the answer does not wait for the turn, a large body is refused unread, and the
 * secret never appears in anything that is recorded or returned.
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { describe, it } from "vitest";

import type { IngressAuditEntry, IngressMessage, WebhookIngressAdapter } from "./messaging-ingress.js";
import {
  IngressWebhookReceiver,
  INGRESS_WEBHOOK_DEFAULT_HOST,
  INGRESS_WEBHOOK_RECEIVER_SECTION,
  INGRESS_WEBHOOK_SECRET_REF,
  isLoopbackBindAddress,
  readIngressWebhookReceiverSettings,
  type IngressWebhookAddress,
  type IngressWebhookPlatform,
} from "./messaging-ingress-receiver.js";
import {
  createHmacTimestampVerifier,
  signIngressWebhookBody,
} from "./messaging-ingress-verify.js";

const SECRET = "receiver-test-secret-0123456789abcdef";
const PLATFORM = "conformance";

type Event = { id: string; chat: string; text: string; from?: string };

/** A minimal callback platform: one JSON event in, one message out. */
function adapter(): WebhookIngressAdapter {
  return {
    platform: PLATFORM,
    kind: "webhook",
    messageLimit: 120,
    normalise: (raw: unknown) => {
      const event = raw as Event | null;
      if (!event || typeof event !== "object" || typeof event.id !== "string") {
        return { kind: "filtered" as const, reason: "not an event" };
      }
      if (event.from === "bot") return { kind: "filtered" as const, reason: "own message" };
      return {
        kind: "message" as const,
        message: { messageId: event.id, chatId: event.chat, text: event.text },
        key: `${event.chat}\u0000${event.id}`,
      };
    },
  };
}

function memoryStore(): { has(key: string): Promise<boolean>; record(key: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

function platform(onMessage: (message: IngressMessage) => Promise<void>, verifierSecret = SECRET): IngressWebhookPlatform {
  return {
    verifier: createHmacTimestampVerifier({ secret: verifierSecret }),
    adapter: adapter(),
    onMessage,
  };
}

type Round = {
  receiver: IngressWebhookReceiver;
  address: IngressWebhookAddress;
  messages: IngressMessage[];
};

/** Start one receiver on a dynamic loopback port, and stop it at the end. */
async function round(options: {
  onMessage?: (message: IngressMessage) => Promise<void>;
  handled?: ReturnType<typeof memoryStore>;
  maxBodyBytes?: number;
  audit?: (entry: IngressAuditEntry) => void;
  now?: () => number;
  verifierSecret?: string;
  host?: string;
  allowNonLoopback?: boolean;
} = {}): Promise<Round> {
  const messages: IngressMessage[] = [];
  const receiver = new IngressWebhookReceiver({
    platforms: {
      [PLATFORM]: platform(
        options.onMessage ??
          (async (message) => {
            messages.push(message);
          }),
        options.verifierSecret,
      ),
    },
    handled: options.handled ?? memoryStore(),
    port: 0,
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.allowNonLoopback ? { allowNonLoopback: true } : {}),
  });
  const address = await receiver.start();
  return { receiver, address, messages };
}

function secondsNow(): number {
  return Math.floor(Date.now() / 1000);
}

function signedHeaders(
  body: Buffer,
  options: { timestamp?: number; deliveryId?: string; secret?: string } = {},
): Record<string, string> {
  const timestamp = String(options.timestamp ?? secondsNow());
  return {
    "content-type": "application/json",
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": signIngressWebhookBody(options.secret ?? SECRET, timestamp, body),
    "x-webhook-delivery": options.deliveryId ?? "delivery-1",
  };
}

type Reply = { status: number; body: string };

function post(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { ...headers, "content-length": String(body.length) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Let the accepted delivery's turn run to its next quiet point. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Wait until `predicate` holds, or fail the test — no wall-clock sleeps. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the inbound webhook receiver", () => {
  it("turns a valid signed POST into exactly one turn", async () => {
    const { receiver, address, messages } = await round();
    try {
      const body = Buffer.from(JSON.stringify({ id: "m1", chat: "c1", text: "hello" }));
      const reply = await post(address.port, `/webhooks/${PLATFORM}`, body, signedHeaders(body));
      assert.equal(reply.status, 200);
      await until(() => messages.length === 1, "the accepted delivery's turn");
      assert.deepEqual(messages, [{ messageId: "m1", chatId: "c1", text: "hello" }]);
    } finally {
      await receiver.stop();
    }
  });

  it("rejects a body altered after signing, and starts no turn", async () => {
    const { receiver, address, messages } = await round();
    try {
      const signed = Buffer.from('{"id":"m1","chat":"c1","text":"hello"}');
      const headers = signedHeaders(signed);
      // One byte of whitespace is enough: the signature covers the bytes, not
      // the object a parser would produce from them.
      const tampered = Buffer.from('{"id":"m1","chat":"c1", "text":"hello"}');
      const reply = await post(address.port, `/webhooks/${PLATFORM}`, tampered, headers);
      assert.equal(reply.status, 401);
      await flush();
      assert.deepEqual(messages, []);
    } finally {
      await receiver.stop();
    }
  });

  it("rejects a bad signature, and starts no turn", async () => {
    const { receiver, address, messages } = await round();
    try {
      const body = Buffer.from(JSON.stringify({ id: "m2", chat: "c1", text: "hello" }));
      const reply = await post(
        address.port,
        `/webhooks/${PLATFORM}`,
        body,
        signedHeaders(body, { secret: "not-the-secret" }),
      );
      assert.equal(reply.status, 401);
      await flush();
      assert.deepEqual(messages, []);
    } finally {
      await receiver.stop();
    }
  });

  it("verifies the raw bytes before parsing, so a non-JSON body is authenticated, not parsed", async () => {
    const audit: IngressAuditEntry[] = [];
    const { receiver, address, messages } = await round({ audit: (entry) => audit.push(entry) });
    try {
      const body = Buffer.from("{not json");
      // A bad signature over a body that cannot be parsed must still be a 401.
      // An implementation that parsed first would never reach the signature
      // check, and would answer 400 (or a 200 it never authenticated).
      const unauthorized = await post(
        address.port,
        `/webhooks/${PLATFORM}`,
        body,
        signedHeaders(body, { secret: "not-the-secret" }),
      );
      assert.equal(unauthorized.status, 401);

      // The same bytes, correctly signed, authenticate and are then found
      // unparseable: the 200 is the fast answer, and the parse failure shows up
      // in the audit rather than in the response.
      const authentic = await post(address.port, `/webhooks/${PLATFORM}`, body, signedHeaders(body));
      assert.equal(authentic.status, 200);
      await flush();
      assert.deepEqual(messages, []);
      assert.deepEqual(
        audit.filter((entry) => entry.kind === "malformed"),
        [{ kind: "malformed", reason: "the body is not JSON" }],
      );
    } finally {
      await receiver.stop();
    }
  });

  it("rejects a chunked body that crosses the cap mid-stream", async () => {
    const cap = 32;
    const { receiver, address, messages } = await round({ maxBodyBytes: cap });
    try {
      // No content-length is declared, so the cap can only be enforced by the
      // running total: the first chunk is under it, the second crosses it.
      const reply = await chunkedPost(address.port, `/webhooks/${PLATFORM}`, [
        Buffer.alloc(16, 0x61),
        Buffer.alloc(64, 0x62),
      ]);
      assert.equal(reply.status, 413);
      await flush();
      assert.deepEqual(messages, []);
    } finally {
      await receiver.stop();
    }
  });

  it("rejects a stale timestamp, and starts no turn", async () => {
    const audit: IngressAuditEntry[] = [];
    const { receiver, address, messages } = await round({ audit: (entry) => audit.push(entry) });
    try {
      const body = Buffer.from(JSON.stringify({ id: "m3", chat: "c1", text: "hello" }));
      const reply = await post(
        address.port,
        `/webhooks/${PLATFORM}`,
        body,
        signedHeaders(body, { timestamp: secondsNow() - 3_600 }),
      );
      assert.equal(reply.status, 401);
      await flush();
      assert.deepEqual(messages, []);
      assert.deepEqual(
        audit.filter((entry) => entry.kind === "rejected"),
        [{ kind: "rejected", reason: "stale-timestamp" }],
      );
    } finally {
      await receiver.stop();
    }
  });

  it("produces no second turn for a replayed delivery id, and audits it", async () => {
    const audit: IngressAuditEntry[] = [];
    const { receiver, address, messages } = await round({ audit: (entry) => audit.push(entry) });
    try {
      const body = Buffer.from(JSON.stringify({ id: "m4", chat: "c1", text: "hello" }));
      const first = await post(
        address.port,
        `/webhooks/${PLATFORM}`,
        body,
        signedHeaders(body, { deliveryId: "same-delivery" }),
      );
      await until(() => messages.length === 1, "the first turn");
      const second = await post(
        address.port,
        `/webhooks/${PLATFORM}`,
        body,
        signedHeaders(body, { deliveryId: "same-delivery" }),
      );
      assert.equal(first.status, 200);
      assert.equal(second.status, 200, "the replay is acknowledged so the platform stops retrying");
      await flush();
      assert.equal(messages.length, 1, "a replayed delivery id must not become a second turn");
      assert.equal(
        audit.filter((entry) => entry.kind === "duplicate").length,
        1,
        "the replay must be audited, and nothing about it becomes a turn",
      );
      assert.ok(
        audit.some(
          (entry) =>
            entry.kind === "duplicate" &&
            entry.eventId.includes("webhook\u0000"),
        ),
        "the replay must be recognised by the receiver's delivery key, not only by the message gate",
      );
    } finally {
      await receiver.stop();
    }
  });

  it("does not process a delivery id a previous receiver already recorded", async () => {
    // Same store, new process: this is the restart case the durable guard is for.
    const handled = memoryStore();
    const first = await round({ handled });
    const body = Buffer.from(JSON.stringify({ id: "m5", chat: "c1", text: "hello" }));
    try {
      await post(portOf(first), `/webhooks/${PLATFORM}`, body, signedHeaders(body, { deliveryId: "durable" }));
      await until(() => first.messages.length === 1, "the first turn");
    } finally {
      await first.receiver.stop();
    }
    const second = await round({ handled });
    try {
      const reply = await post(
        second.address.port,
        `/webhooks/${PLATFORM}`,
        body,
        signedHeaders(body, { deliveryId: "durable" }),
      );
      assert.equal(reply.status, 200);
      await flush();
      assert.deepEqual(second.messages, []);
    } finally {
      await second.receiver.stop();
    }
  });

  it("rejects an oversized body without reading it", async () => {
    const cap = 64;
    const { receiver, address, messages } = await round({ maxBodyBytes: cap });
    try {
      // Announce more than the cap and send no body at all: a 413 here can only
      // mean the receiver answered from the declared length, before buffering.
      const reply = await rawRequest(
        address.port,
        "POST",
        `/webhooks/${PLATFORM}`,
        [
          "content-type: application/json",
          "x-webhook-timestamp: 1",
          `content-length: ${cap + 1}`,
        ],
        Buffer.alloc(0),
      );
      assert.equal(reply.status, 413);
      await flush();
      assert.deepEqual(messages, []);
    } finally {
      await receiver.stop();
    }
  });

  it("answers an unknown platform path 404 and leaks no detail", async () => {
    const { receiver, address } = await round();
    try {
      const body = Buffer.from("{}");
      const reply = await post(address.port, "/webhooks/not-a-platform", body, {
        "content-length": String(body.length),
      });
      assert.equal(reply.status, 404);
      assert.deepEqual(JSON.parse(reply.body), { error: "not found" });
      assert.equal(reply.body.includes(PLATFORM), false, "the path list must not leak");
    } finally {
      await receiver.stop();
    }
  });

  it("returns the response before the turn completes", async () => {
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { receiver, address } = await round({
      onMessage: async () => {
        order.push("turn-started");
        await blocked;
        order.push("turn-completed");
      },
    });
    try {
      const body = Buffer.from(JSON.stringify({ id: "m6", chat: "c1", text: "slow" }));
      const reply = await post(address.port, `/webhooks/${PLATFORM}`, body, signedHeaders(body));
      order.push("responded");
      assert.equal(reply.status, 200);
      await until(() => order.includes("turn-started"), "the turn to start");
      assert.equal(
        order.includes("turn-completed"),
        false,
        "the response must not wait for the turn",
      );
      release();
      await until(() => order.includes("turn-completed"), "the turn to finish");
      assert.ok(
        order.indexOf("responded") < order.indexOf("turn-completed"),
        `the response must arrive first, saw ${JSON.stringify(order)}`,
      );
    } finally {
      await receiver.stop();
    }
  });

  it("binds loopback by default and refuses a wider bind without the opt-in", async () => {
    const { receiver, address } = await round();
    try {
      assert.equal(address.host, INGRESS_WEBHOOK_DEFAULT_HOST);
      assert.equal(isLoopbackBindAddress(address.host), true);
    } finally {
      await receiver.stop();
    }

    const wide = new IngressWebhookReceiver({
      platforms: { [PLATFORM]: platform(async () => {}) },
      handled: memoryStore(),
      port: 0,
      host: "0.0.0.0",
    });
    await assert.rejects(
      () => wide.start(),
      /refusing to bind 0\.0\.0\.0: the webhook receiver binds loopback unless allowNonLoopback is set/,
    );

    // The opt-in is not a no-op: with it, a wider address actually binds. The
    // address used here is in the loopback range but is not one of the three
    // spellings the default accepts, so it takes the same code path a `0.0.0.0`
    // or a LAN address takes without publishing anything to the network.
    const opted = await round({ host: "127.0.0.2", allowNonLoopback: true });
    try {
      assert.equal(opted.address.host, "127.0.0.2");
      assert.equal(isLoopbackBindAddress(opted.address.host), false);
    } finally {
      await opted.receiver.stop();
    }
  });

  it("never puts the signing secret in an audit record, an error or a response", async () => {
    const audit: IngressAuditEntry[] = [];
    const { receiver, address } = await round({ audit: (entry) => audit.push(entry) });
    const bodies: string[] = [];
    try {
      const body = Buffer.from(JSON.stringify({ id: "m7", chat: "c1", text: "hello" }));
      bodies.push((await post(address.port, `/webhooks/x`, body, signedHeaders(body))).body);
      bodies.push(
        (await post(address.port, `/webhooks/${PLATFORM}`, body, signedHeaders(body, { secret: "wrong" })))
          .body,
      );
      bodies.push((await post(address.port, `/webhooks/${PLATFORM}`, body, {})).body);
    } finally {
      await receiver.stop();
    }
    const observed = `${JSON.stringify(audit)} ${bodies.join(" ")}`;
    assert.equal(observed.includes(SECRET), false, "the secret appeared in a record or a response");
  });
});

/** One raw request, so a test can announce a length it never sends. */
function portOf(round: Round): number {
  return round.address.port;
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headerLines: string[],
  body: Buffer,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n`);
      for (const line of headerLines) socket.write(`${line}\r\n`);
      socket.write("\r\n");
      if (body.length > 0) socket.write(body);
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const [head, ...rest] = text.split("\r\n\r\n");
      const status = Number((head ?? "").split(" ")[1] ?? 0);
      resolve({ status, body: rest.join("\r\n\r\n") });
    });
  });
}

/** One chunked request, so a test can cross the cap without declaring a length. */
function chunkedPost(port: number, path: string, chunks: Buffer[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const [head, ...rest] = text.split("\r\n\r\n");
      const status = Number((head ?? "").split(" ")[1] ?? 0);
      resolve({ status, body: rest.join("\r\n\r\n") });
    };
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n` +
          "transfer-encoding: chunked\r\ncontent-type: application/json\r\n\r\n",
      );
      for (const chunk of chunks) {
        socket.write(`${chunk.length.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write("\r\n");
      }
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    // The receiver answers 413 and then destroys the connection while a chunk
    // is still queued, so a reset here is the expected end of the exchange.
    socket.on("error", (error) => {
      if (text.length > 0) finish();
      else reject(error);
    });
    socket.on("close", finish);
  });
}

describe("the receiver's settings section", () => {
  it("is off unless the section says it is enabled", () => {
    assert.equal(readIngressWebhookReceiverSettings({}), null);
    assert.equal(readIngressWebhookReceiverSettings({ [INGRESS_WEBHOOK_RECEIVER_SECTION]: {} }), null);
    assert.equal(
      readIngressWebhookReceiverSettings({
        [INGRESS_WEBHOOK_RECEIVER_SECTION]: { enabled: false, port: 9000 },
      }),
      null,
    );
  });

  it("defaults to loopback and clamps what it reads", () => {
    const settings = readIngressWebhookReceiverSettings({
      [INGRESS_WEBHOOK_RECEIVER_SECTION]: {
        enabled: true,
        port: 70_000,
        replayWindowSeconds: 900,
        maxBodyBytes: 10,
      },
    });
    assert.ok(settings);
    assert.equal(settings.bindAddress, INGRESS_WEBHOOK_DEFAULT_HOST);
    assert.equal(settings.allowNonLoopback, false);
    assert.equal(settings.port, 65_535);
    assert.equal(settings.replayWindowMs, 900_000);
    assert.equal(settings.maxBodyBytes, 1_024);
    assert.equal(settings.secretRef, INGRESS_WEBHOOK_SECRET_REF);
  });

  it("carries an explicit bind and opt-in through, and a secret ref by name only", () => {
    const settings = readIngressWebhookReceiverSettings({
      [INGRESS_WEBHOOK_RECEIVER_SECTION]: {
        enabled: true,
        port: 9_000,
        bindAddress: "0.0.0.0",
        allowNonLoopback: true,
        secretRef: "secret:line:channel-secret",
        replayWindowSeconds: 60,
      },
    });
    assert.ok(settings);
    assert.equal(settings.bindAddress, "0.0.0.0");
    assert.equal(settings.allowNonLoopback, true);
    assert.equal(settings.port, 9_000);
    assert.equal(settings.secretRef, "secret:line:channel-secret");
    // The section reads a ref, never a value: there is no field a secret could
    // be pasted into.
    assert.equal(Object.values(settings).includes("channel-secret"), false);
  });
});
