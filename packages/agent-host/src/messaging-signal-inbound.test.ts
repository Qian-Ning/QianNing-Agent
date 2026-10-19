/**
 * The inbound Signal channel, driven through its real HTTP client against a real
 * loopback bridge.
 *
 * The assertions are about the wire and about the turn: which JSON-RPC method
 * was posted, what the params carried, how many turns one envelope became, and
 * which envelopes became none. Nothing here substitutes for the client, so a
 * change to its request shape fails these tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IngressHandledStore, IngressMessage } from "./messaging-ingress.js";
import {
  SIGNAL_GROUP_CHAT_PREFIX,
  SIGNAL_MESSAGE_LIMIT,
  createSignalInboundPushTransport,
  createSignalIngressAdapter,
  normaliseSignalEnvelope,
  signalMessageId,
  type SignalInboundAuditEntry,
} from "./messaging-signal-inbound.js";
import {
  FakeSignalBridge,
  signalEnvelope,
  signalOwnSyncEnvelope,
  signalReceiptEnvelope,
  signalTypingEnvelope,
} from "./messaging-signal-test-servers.js";

const ACCOUNT = "+15550000000";
const CORRESPONDENT = "+15551110000";

let bridge: FakeSignalBridge;

beforeEach(async () => {
  bridge = new FakeSignalBridge();
  await bridge.start();
});

afterEach(async () => {
  await bridge.close();
});

/** A restart-durable guard that lives in the test, not in the settings row. */
function memoryGuard(): IngressHandledStore {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

type RunOptions = {
  polls?: number;
  bridgeUrl?: string;
  token?: string;
  account?: string;
  handled?: IngressHandledStore;
  /** Who may command the channel; defaults to the correspondent the tests use. */
  allowedSenders?: string[];
};

/**
 * Run the real push transport for a bounded number of polls.
 *
 * The loop's own wait is the stop condition, so a test never sleeps and never
 * races the loop: the abort fires after the poll it is meant to observe.
 */
async function runTransport(options: RunOptions = {}): Promise<{
  messages: IngressMessage[];
  audit: SignalInboundAuditEntry[];
}> {
  const controller = new AbortController();
  const messages: IngressMessage[] = [];
  const audit: SignalInboundAuditEntry[] = [];
  let polls = 0;
  const transport = createSignalInboundPushTransport({
    bridgeUrl: options.bridgeUrl ?? bridge.url,
    account: options.account ?? ACCOUNT,
    ...(options.token !== undefined ? { token: options.token } : {}),
    receiveTimeoutS: 1,
    allowedSenders: options.allowedSenders ?? [CORRESPONDENT],
    handled: options.handled ?? memoryGuard(),
    audit: (entry) => audit.push(entry),
    wait: async () => {
      polls += 1;
      if (polls >= (options.polls ?? 1)) controller.abort();
    },
  });
  await transport.start(async (message) => {
    messages.push(message);
  }, controller.signal);
  return { messages, audit };
}

describe("receiving", () => {
  it("posts a receive and turns one envelope into one turn with its text and sender", async () => {
    bridge.push(signalEnvelope({ from: CORRESPONDENT, text: "run the tests", timestamp: 1_760_000_000_100 }));
    const { messages } = await runTransport();

    expect(bridge.methods).toEqual(["receive"]);
    expect(messages).toEqual([
      {
        messageId: signalMessageId(1_760_000_000_100, CORRESPONDENT, "run the tests"),
        chatId: CORRESPONDENT,
        text: "run the tests",
      },
    ]);
  });

  it("ignores a receipt-only envelope", async () => {
    bridge.push(signalReceiptEnvelope({ from: CORRESPONDENT }));
    const { messages, audit } = await runTransport();
    expect(messages).toEqual([]);
    expect(audit.some((entry) => entry.kind === "filtered" && entry.reason.includes("no data message"))).toBe(
      true,
    );
  });

  it("ignores a typing-only envelope", async () => {
    bridge.push(signalTypingEnvelope({ from: CORRESPONDENT }));
    const { messages } = await runTransport();
    expect(messages).toEqual([]);
  });

  it("drops the account's own sync frame", async () => {
    bridge.push(signalOwnSyncEnvelope({ text: "a reply this channel wrote" }));
    const { messages } = await runTransport();
    expect(messages).toEqual([]);
  });

  it("drops a note-to-self data message from the configured account", async () => {
    bridge.push(signalEnvelope({ from: ACCOUNT, text: "note to self" }));
    const { messages } = await runTransport();
    expect(messages).toEqual([]);
  });

  it("answers a group message in the group", async () => {
    bridge.push(signalEnvelope({ from: CORRESPONDENT, text: "hello group", groupId: "group-id-1==" }));
    const { messages } = await runTransport();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.chatId).toBe(`${SIGNAL_GROUP_CHAT_PREFIX}group-id-1==`);
  });

  it("delivers one envelope offered twice only once", async () => {
    const envelope = signalEnvelope({ from: CORRESPONDENT, text: "twice", timestamp: 1_760_000_000_200 });
    bridge.push(envelope);
    bridge.push(envelope);
    const { messages } = await runTransport();
    expect(messages).toHaveLength(1);
  });

  it("keeps two different messages sent in the same millisecond apart", async () => {
    bridge.push(signalEnvelope({ from: CORRESPONDENT, text: "first", timestamp: 1_760_000_000_300 }));
    bridge.push(signalEnvelope({ from: CORRESPONDENT, text: "second", timestamp: 1_760_000_000_300 }));
    const { messages } = await runTransport();
    expect(messages.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("drops an attachment-only message rather than answering an empty turn", async () => {
    bridge.push({
      account: ACCOUNT,
      envelope: {
        sourceNumber: CORRESPONDENT,
        timestamp: 1_760_000_000_400,
        dataMessage: {
          timestamp: 1_760_000_000_400,
          attachments: [{ contentType: "image/png", filename: "shot.png" }],
        },
      },
    });
    const { messages, audit } = await runTransport();
    expect(messages).toEqual([]);
    expect(audit.some((entry) => entry.kind === "filtered")).toBe(true);
  });

  it("accepts a bare envelope as the daemon's push frames are shaped", () => {
    const normalisation = normaliseSignalEnvelope(
      {
        sourceNumber: CORRESPONDENT,
        timestamp: 1_760_000_000_500,
        dataMessage: { timestamp: 1_760_000_000_500, message: "bare" },
      },
      { ownIdentities: [ACCOUNT], allowedSenders: [CORRESPONDENT] },
    );
    expect(normalisation.kind).toBe("message");
  });
});

describe("the sender allowlist", () => {
  // A number is exactly as public as a phone number gets: knowing it must not
  // be enough to command the assistant. These are the two identities the block
  // is about — one on the list, one not.
  const ALLOWED = "+15501990001";
  const STRANGER = "+15501990002";

  it("turns a message from an allowlisted sender into a turn", async () => {
    bridge.push(
      signalEnvelope({ from: ALLOWED, text: "deploy it", timestamp: 1_760_000_000_700 }),
    );
    const { messages } = await runTransport({ allowedSenders: [ALLOWED] });
    expect(messages.map((message) => message.text)).toEqual(["deploy it"]);
  });

  it("refuses a stranger's message and records exactly one audit entry", async () => {
    bridge.push(
      signalEnvelope({ from: STRANGER, text: "delete everything", timestamp: 1_760_000_000_710 }),
    );
    const { messages, audit } = await runTransport({ allowedSenders: [ALLOWED] });

    expect(messages).toEqual([]);
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    expect(entry).toMatchObject({ kind: "filtered", reason: "the sender is not on the allowlist" });
    // The refusal is observable but the stranger is not quotable into it: an
    // unknown number is the one value a hostile sender controls.
    expect(JSON.stringify(audit)).not.toContain(STRANGER);
  });

  it("turns nothing at all when the allowlist is empty", async () => {
    bridge.push(signalEnvelope({ from: ALLOWED, text: "hello", timestamp: 1_760_000_000_720 }));
    const { messages, audit } = await runTransport({ allowedSenders: [] });

    expect(messages).toEqual([]);
    // Fail closed, and fail before asking: an empty list starts no poll.
    expect(bridge.receives).toBe(0);
    expect(
      audit.some(
        (entry) => entry.kind === "connect-failed" && entry.error.includes("no allowed senders"),
      ),
    ).toBe(true);
  });

  it("judges a group message by its sender, not by the group id", async () => {
    // The channel is in this group; the member who wrote is not on the list.
    // Membership is not trust, so the group id must not launder the sender.
    bridge.push(
      signalEnvelope({
        from: STRANGER,
        text: "everyone: run this",
        groupId: "a-known-group==",
        timestamp: 1_760_000_000_730,
      }),
    );
    const { messages, audit } = await runTransport({ allowedSenders: [ALLOWED] });

    expect(messages).toEqual([]);
    expect(audit.filter((entry) => entry.kind === "filtered")).toHaveLength(1);
  });

  it("still answers a group message from an allowlisted member", async () => {
    bridge.push(
      signalEnvelope({
        from: ALLOWED,
        text: "hello group",
        groupId: "a-known-group==",
        timestamp: 1_760_000_000_740,
      }),
    );
    const { messages } = await runTransport({ allowedSenders: [ALLOWED] });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.chatId).toBe(`${SIGNAL_GROUP_CHAT_PREFIX}a-known-group==`);
  });
});

describe("failure modes", () => {
  it("survives an unreachable bridge and reports it", async () => {
    // Port 1 on loopback: nothing listens there, so the connection is refused
    // the way it is when signal-cli is not running.
    const { messages, audit } = await runTransport({ bridgeUrl: "http://127.0.0.1:1" });
    expect(messages).toEqual([]);
    expect(audit.some((entry) => entry.kind === "connect-failed")).toBe(true);
  });

  it("survives a non-2xx answer", async () => {
    bridge.mode = "http-500";
    const { messages, audit } = await runTransport();
    expect(messages).toEqual([]);
    expect(audit.some((entry) => entry.kind === "connect-failed")).toBe(true);
  });

  it("survives a malformed JSON answer and reads the next poll", async () => {
    bridge.mode = "malformed";
    bridge.push(signalEnvelope({ from: CORRESPONDENT, text: "after the bad answer" }));
    // The mode is fixed for the fake's lifetime, so this proves the *loop*: a
    // bad answer ends one poll and the next poll is still made.
    const { messages, audit } = await runTransport({ polls: 2 });
    expect(messages).toEqual([]);
    expect(audit.filter((entry) => entry.kind === "connect-failed")).toHaveLength(2);
  });

  it("recovers on the next poll once the bridge answers again", async () => {
    bridge.mode = "malformed";
    bridge.push(signalEnvelope({ from: CORRESPONDENT, text: "late", timestamp: 1_760_000_000_600 }));
    const controller = new AbortController();
    const messages: IngressMessage[] = [];
    let polls = 0;
    const transport = createSignalInboundPushTransport({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      receiveTimeoutS: 1,
      allowedSenders: [CORRESPONDENT],
      handled: memoryGuard(),
      wait: async () => {
        polls += 1;
        // After the first (failed) poll, put the bridge back and stop after the
        // second, which is the one that must deliver.
        if (polls === 1) bridge.mode = "ok";
        if (polls >= 2) controller.abort();
      },
    });
    await transport.start(async (message) => {
      messages.push(message);
    }, controller.signal);
    expect(messages.map((message) => message.text)).toEqual(["late"]);
  });

  it("does not throw when the host cancels a held poll", async () => {
    bridge.holdNextReceive = true;
    const controller = new AbortController();
    const transport = createSignalInboundPushTransport({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      receiveTimeoutS: 30,
      allowedSenders: [CORRESPONDENT],
      handled: memoryGuard(),
      wait: async () => {},
    });
    const running = transport.start(async () => {}, controller.signal);
    // Give the poll a moment to reach the bridge, then cancel it: the promise
    // must resolve, not reject.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });
});

describe("replies", () => {
  it("sends one JSON-RPC send for a short reply, to the correspondent", async () => {
    const adapter = createSignalIngressAdapter({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      allowedSenders: [CORRESPONDENT],
      receiveTimeoutS: 1,
    });
    const result = await adapter.deliver(CORRESPONDENT, "the answer");
    expect(result.ok).toBe(true);
    expect(result.ok && result.sent).toBe(1);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toMatchObject({
      account: ACCOUNT,
      recipient: CORRESPONDENT,
      message: "the answer",
    });
    expect(bridge.requests[0]!.json).toMatchObject({ method: "send" });
  });

  it("chunks a long reply at the declared limit, in order, with nothing truncated", async () => {
    const adapter = createSignalIngressAdapter({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      allowedSenders: [CORRESPONDENT],
      receiveTimeoutS: 1,
    });
    const text = `${"a long line of reply text that keeps going\n".repeat(120)}the end`;
    expect(text.length).toBeGreaterThan(SIGNAL_MESSAGE_LIMIT * 2);

    const result = await adapter.deliver(CORRESPONDENT, text);
    expect(result.ok).toBe(true);
    expect(bridge.sent.length).toBeGreaterThan(1);
    for (const send of bridge.sent) {
      expect(send.message.length).toBeLessThanOrEqual(SIGNAL_MESSAGE_LIMIT);
    }
    expect(bridge.sent.map((send) => send.message).join("")).toBe(text);
  });

  it("sends to a group with groupId when the chat id says so", async () => {
    const adapter = createSignalIngressAdapter({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      allowedSenders: [CORRESPONDENT],
      receiveTimeoutS: 1,
    });
    const result = await adapter.deliver(`${SIGNAL_GROUP_CHAT_PREFIX}abc==`, "to all");
    expect(result.ok).toBe(true);
    expect(bridge.sent[0]).toMatchObject({ groupId: "abc==", message: "to all" });
    expect(bridge.sent[0]!.params).not.toHaveProperty("recipient");
  });

  it("reports a refused send without claiming it was delivered", async () => {
    bridge.mode = "rpc-error";
    const adapter = createSignalIngressAdapter({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      allowedSenders: [CORRESPONDENT],
      receiveTimeoutS: 1,
    });
    const result = await adapter.deliver(CORRESPONDENT, "refused");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.sent).toBe(0);
  });

  it("never puts the bridge token in a result or an audit record", async () => {
    bridge.requiredToken = "the-required-token";
    const audit: SignalInboundAuditEntry[] = [];
    const adapter = createSignalIngressAdapter({
      bridgeUrl: bridge.url,
      account: ACCOUNT,
      token: "the-wrong-token",
      allowedSenders: [CORRESPONDENT],
      receiveTimeoutS: 1,
      audit: (entry) => audit.push(entry),
    });
    const result = await adapter.deliver(CORRESPONDENT, "hello");
    expect(result.ok).toBe(false);
    expect(JSON.stringify({ result, audit })).not.toContain("the-wrong-token");
    expect(JSON.stringify({ result, audit })).not.toContain("the-required-token");
  });
});
