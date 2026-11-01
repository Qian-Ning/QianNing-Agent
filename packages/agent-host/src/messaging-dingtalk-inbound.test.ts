import { describe, expect, it } from "vitest";

import {
  DINGTALK_TEXT_LIMIT,
  DingtalkStreamClient,
  createDingtalkGatewayOpener,
  createDingtalkIngressAdapter,
  normaliseDingtalkMessage,
  type DingtalkFetch,
} from "./messaging-dingtalk-inbound.js";
import type { IngressAudit, IngressHandledStore, IngressMessage } from "./messaging-ingress.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";

/** A socket the suite drives by hand: it records frames and pushes its own. */
function fakeSocket() {
  const sent: string[] = [];
  let onMessage: ((data: string) => void) | null = null;
  const socket: IngressSocket = {
    send: (data) => sent.push(data),
    close: () => {},
    onMessage: (handler) => {
      onMessage = handler;
    },
    onClose: () => {},
    onError: () => {},
  };
  return { socket, sent, push: (data: string) => onMessage?.(data) };
}

function memoryStore(): IngressHandledStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    has: async (key) => keys.has(key),
    record: async (key) => {
      keys.add(key);
    },
  };
}

const CREDENTIALS = { clientId: "ding-app-id", clientSecret: "ding-app-secret" };

/**
 * The shared layer dispatches a frame without awaiting it (`void
 * handleFrame`), so a suite must let the microtask queue drain before reading
 * what the frame produced.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function callbackFrame(data: Record<string, unknown>, messageId = "cb-1"): string {
  return JSON.stringify({
    specVersion: "1.0",
    type: "CALLBACK",
    headers: { topic: "/v1.0/im/bot/messages/get", messageId },
    data: JSON.stringify(data),
  });
}

function botMessage(overrides: Record<string, unknown> = {}) {
  return {
    msgtype: "text",
    text: { content: " 你好，帮我查一下进度 " },
    msgId: "msg-1",
    conversationId: "cid-1",
    conversationType: "2",
    senderStaffId: "staff-1",
    senderNick: "同事",
    robotCode: "ding-app-id",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
    ...overrides,
  };
}

function harness(options: { handled?: IngressHandledStore; fetch?: DingtalkFetch } = {}) {
  const socket = fakeSocket();
  const received: IngressMessage[] = [];
  const audits: Array<Parameters<IngressAudit>[0]> = [];
  const client = new DingtalkStreamClient({
    credentials: CREDENTIALS,
    openGateway: async () => ({ endpoint: "wss://stream.example/connect", ticket: "t-1" }),
    connect: () => socket.socket,
    onMessage: async (message) => {
      received.push(message);
    },
    handled: options.handled ?? memoryStore(),
    audit: (entry) => audits.push(entry),
    heartbeatMs: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { client, socket, received, audits };
}

describe("dingtalk stream connect", () => {
  it("asks the gateway, then connects with the ticket in the query string", async () => {
    const seen: string[] = [];
    const calls: unknown[] = [];
    const client = new DingtalkStreamClient({
      credentials: CREDENTIALS,
      openGateway: async (credentials) => {
        calls.push(credentials);
        return { endpoint: "wss://stream.example/connect", ticket: "t 1/2" };
      },
      connect: (url) => {
        seen.push(url);
        return fakeSocket().socket;
      },
      onMessage: async () => {},
      handled: memoryStore(),
      heartbeatMs: 0,
    });

    await client.connect();

    expect(calls).toEqual([CREDENTIALS]);
    expect(seen).toEqual(["wss://stream.example/connect?ticket=t%201%2F2"]);
    expect(client.isReady).toBe(true);
  });

  it("refuses an empty credential pair before touching the gateway", async () => {
    const audits: Array<Parameters<IngressAudit>[0]> = [];
    const client = new DingtalkStreamClient({
      credentials: { clientId: " ", clientSecret: "" },
      openGateway: async () => {
        throw new Error("the gateway must not be asked");
      },
      connect: () => fakeSocket().socket,
      onMessage: async () => {},
      handled: memoryStore(),
      audit: (entry) => audits.push(entry),
      heartbeatMs: 0,
    });

    await expect(client.connect()).rejects.toThrow(/credentials are empty/);
    expect(audits[0]?.kind).toBe("auth-failed");
  });

  it("turns a refused handshake into an error the transport can retry", async () => {
    const opener = createDingtalkGatewayOpener(
      (async () => new Response("denied", { status: 401 })) as DingtalkFetch,
    );
    await expect(opener(CREDENTIALS)).rejects.toThrow(/401/);
  });

  it("reads the endpoint and ticket out of a gateway answer", async () => {
    const opener = createDingtalkGatewayOpener(
      (async () =>
        new Response(JSON.stringify({ endpoint: "wss://x/connect", ticket: "t" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as DingtalkFetch,
    );
    await expect(opener(CREDENTIALS)).resolves.toEqual({ endpoint: "wss://x/connect", ticket: "t" });
  });
});

describe("dingtalk callback handling", () => {
  it("passes a text message through and acknowledges the frame", async () => {
    const { client, socket, received } = harness();
    await client.connect();

    socket.push(callbackFrame(botMessage()));

    await settle();

    expect(received).toEqual([{ messageId: "msg-1", chatId: "cid-1", text: "你好，帮我查一下进度" }]);
    const ack = JSON.parse(socket.sent.at(-1) ?? "{}") as Record<string, unknown>;
    expect(ack.code).toBe(200);
    expect(ack.headers).toMatchObject({ messageId: "cb-1" });
  });

  it("keeps the conversation's session webhook for the reply", async () => {
    const { client, socket } = harness();
    await client.connect();
    socket.push(callbackFrame(botMessage()));
    await settle();
    expect(client.sessionWebhookFor("cid-1")).toBe(
      "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
    );
    expect(client.sessionWebhookFor("cid-2")).toBeNull();
  });

  it("filters the bot's own echo but still acknowledges it", async () => {
    const { client, socket, received, audits } = harness();
    await client.connect();

    socket.push(callbackFrame(botMessage({ senderStaffId: "ding-app-id" })));

    await settle();

    expect(received).toEqual([]);
    expect(audits.some((entry) => entry.kind === "filtered")).toBe(true);
    expect((JSON.parse(socket.sent.at(-1) ?? "{}") as { code?: number }).code).toBe(200);
  });

  it("filters a non-text body without asking the routing path", async () => {
    const { client, socket, received, audits } = harness();
    await client.connect();

    socket.push(callbackFrame(botMessage({ msgtype: "picture", text: undefined })));

    await settle();

    expect(received).toEqual([]);
    expect(audits.at(-1)?.kind).toBe("filtered");
  });

  it("reads rich text runs, which is how a phone usually sends", () => {
    const normalisation = normaliseDingtalkMessage({
      msgId: "m",
      conversationId: "c",
      msgtype: "richText",
      content: { richText: [{ text: "第一段" }, { text: " 第二段" }] },
    });
    expect(normalisation).toEqual({
      kind: "message",
      message: { messageId: "m", chatId: "c", text: "第一段 第二段" },
      key: "m",
    });
  });

  it("drops a redelivered message instead of acting on it twice", async () => {
    const handled = memoryStore();
    const { client, socket, received } = harness({ handled });
    await client.connect();

    socket.push(callbackFrame(botMessage()));

    await settle();
    socket.push(callbackFrame(botMessage(), "cb-2"));
    await settle();

    expect(received).toHaveLength(1);
    expect(handled.keys.has("msg-1")).toBe(true);
  });

  it("rejects a callback whose data is not JSON, with a failure code", async () => {
    const { client, socket, received, audits } = harness();
    await client.connect();

    socket.push(
      JSON.stringify({ type: "CALLBACK", headers: { topic: "/v1.0/im/bot/messages/get", messageId: "cb-9" }, data: "{" }),
    );

    expect(received).toEqual([]);
    expect(audits.at(-1)?.kind).toBe("malformed");
    expect((JSON.parse(socket.sent.at(-1) ?? "{}") as { code?: number }).code).toBe(400);
  });

  it("ignores the answer to its own ping", async () => {
    const { client, socket, audits } = harness();
    await client.connect();
    socket.push(JSON.stringify({ code: 200, headers: { topic: "ping", messageId: "ping-1" } }));
    await settle();
    expect(audits).toEqual([]);
  });
});

describe("dingtalk replies", () => {
  it("posts the answer to the session webhook that arrived with the message", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    }) as unknown as DingtalkFetch;

    const adapter = createDingtalkIngressAdapter({
      credentials: CREDENTIALS,
      openGateway: async () => ({ endpoint: "wss://stream.example/connect", ticket: "t" }),
      connect: () => fakeSocket().socket,
      handled: memoryStore(),
      heartbeatMs: 0,
      fetch: fetchImpl,
    });
    const client = adapter.openClient(async () => {}) as DingtalkStreamClient;
    await client.connect();
    // The message carries the webhook; the adapter's reply resolves it by chat.
    (client as unknown as { handleFrame(raw: string): Promise<void> }).handleFrame(
      callbackFrame(botMessage()),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await adapter.deliver?.("cid-1", "收到");

    expect(result).toEqual({ ok: true, sent: 1, ids: [] });
    expect(posts).toEqual([
      {
        url: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
        body: { msgtype: "text", text: { content: "收到" } },
      },
    ]);
  });

  it("refuses to reply in a conversation it has never seen", async () => {
    const adapter = createDingtalkIngressAdapter({
      credentials: CREDENTIALS,
      openGateway: async () => ({ endpoint: "wss://x", ticket: "t" }),
      connect: () => fakeSocket().socket,
      handled: memoryStore(),
      heartbeatMs: 0,
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as DingtalkFetch,
    });

    await expect(adapter.deliver?.("cid-none", "在吗")).resolves.toEqual({
      ok: false,
      error: "this conversation has no session webhook yet",
      sent: 0,
    });
  });

  it("declares the channel's own text ceiling and platform name", () => {
    const adapter = createDingtalkIngressAdapter({
      credentials: CREDENTIALS,
      openGateway: async () => ({ endpoint: "wss://x", ticket: "t" }),
      connect: () => fakeSocket().socket,
      handled: memoryStore(),
      heartbeatMs: 0,
    });
    expect(adapter.platform).toBe("dingtalk");
    expect(adapter.kind).toBe("socket");
    expect(adapter.messageLimit).toBe(DINGTALK_TEXT_LIMIT);
  });
});
