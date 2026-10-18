/**
 * The ingress conformance suite, run against all four working channels and the
 * webhook transport.
 *
 * This file is the only platform-specific half: each fixture below supplies the
 * platform's adapter, one raw foreign event, one raw own event, its
 * credential-refusal path and — for a push channel — a live connection the
 * shared suite can feed, drop and replace. The assertions are in
 * `messaging-ingress-conformance.ts` and are the same for every adapter.
 *
 * The last block is the negative control: an adapter deliberately broken the way
 * a copy-paste port goes wrong (no stable replay key) must fail the suite. That
 * is what makes the suite evidence rather than decoration.
 */

import { describe, expect, it } from "vitest";

import type {
  IngressMessage,
  IngressPollResult,
  IngressDeliveryResult,
  MessagingIngressAdapter,
} from "./messaging-ingress.js";
import {
  ingressConformanceScenarios,
  type IngressConformanceConnection,
  type IngressConformanceFixture,
  type IngressReconnectProbe,
} from "./messaging-ingress-conformance.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";
import {
  createSlackIngressAdapter,
  type SlackInboundAuditEntry,
} from "./messaging-slack-inbound.js";
import {
  createDiscordIngressAdapter,
  createDiscordSender,
  type DiscordGatewayResult,
  type DiscordInboundAuditEntry,
} from "./messaging-discord-inbound.js";
import {
  createMattermostIngressAdapter,
  createMattermostSender,
  type MattermostIdentityResult,
  type MattermostInboundAuditEntry,
} from "./messaging-mattermost-inbound.js";
import {
  createMatrixIngressAdapter,
  createMatrixInboundPushTransport,
  type MatrixInboundAuditEntry,
} from "./messaging-matrix-inbound.js";
import { createTelegramIngressAdapter } from "./messaging-inbound.js";
import { WebhookIngressTransport } from "./messaging-ingress-webhook.js";
import { createIngressRawSocketPair } from "./messaging-ingress-conformance.js";
import {
  createIrcIngressAdapter,
  type IrcInboundAuditEntry,
} from "./messaging-irc-inbound.js";
import {
  createHomeAssistantIngressAdapter,
  HOME_ASSISTANT_EVENT_TYPE,
  HOME_ASSISTANT_WEBSOCKET_PATH,
  type HomeAssistantInboundAuditEntry,
} from "./messaging-home-assistant-inbound.js";

// ---------------------------------------------------------------------------
// Shared doubles
// ---------------------------------------------------------------------------

/** A settable clock-free socket: records what the client sends, replays frames. */
class FakeSocket implements IngressSocket {
  sent: string[] = [];
  closed = false;
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((code?: number, reason?: string) => void) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (code?: number, reason?: string) => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** The platform delivers one frame. */
  emit(frame: unknown): void {
    this.messageHandler?.(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  /** The platform closes the connection. */
  serverClose(reason = "closed by the platform"): void {
    this.closeHandler?.(undefined, reason);
  }
  /** The platform reports a transport error. */
  serverError(error: unknown): void {
    this.errorHandler?.(error);
  }
}

/** Let every promise the client queued settle, without a wall clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A durable guard shared by every connection of one fixture (a restart). */
function durableGuard(): { has(key: string): Promise<boolean>; record(key: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function slackFixture(): IngressConformanceFixture {
  const handled = durableGuard();
  const audit: SlackInboundAuditEntry[] = [];
  let socket: FakeSocket | null = null;
  const adapter = createSlackIngressAdapter({
    appToken: "xapp-conformance-token",
    openConnection: async () => ({ ok: true, url: "wss://conformance.slack.test/link" }),
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    handled,
    audit: (entry) => audit.push(entry),
  });
  const open = async (
    onMessage: (message: IngressMessage) => Promise<void>,
  ): Promise<IngressConformanceConnection> => {
    const client = adapter.openClient(onMessage);
    await client.connect();
    const current = socket as FakeSocket;
    return {
      async deliver(raw) {
        current.emit(raw);
        await settle();
      },
      drop() {
        current.serverClose();
      },
    };
  };
  const envelope = (event: Record<string, unknown>, eventId = "Ev-conformance") => ({
    type: "events_api",
    envelope_id: "env-conformance",
    payload: { type: "event_callback", event_id: eventId, event },
  });
  const foreignEvent = {
    type: "message",
    channel: "C-conformance",
    ts: "1700000000.000100",
    text: "/start do the thing",
    channel_type: "im",
  };
  return {
    adapter,
    foreign: () => ({
      raw: foreignEvent,
      frame: envelope(foreignEvent),
      expected: {
        messageId: "1700000000.000100",
        chatId: "C-conformance",
        text: "/start do the thing",
      },
    }),
    own: () => ({ ...foreignEvent, ts: "1700000000.000101", bot_id: "B-own" }),
    async reconnect(): Promise<IngressReconnectProbe> {
      const messages: IngressMessage[] = [];
      const record = async (message: IngressMessage) => {
        messages.push(message);
      };
      return {
        first: await open(record),
        reconnect: () => open(record),
        messages: () => messages,
      };
    },
    async refusedCredential() {
      const refusedAudit: SlackInboundAuditEntry[] = [];
      const errors: string[] = [];
      const refused = createSlackIngressAdapter({
        appToken: "xapp-SECRET-token",
        openConnection: async () => ({ ok: false, error: "invalid_auth" }),
        connect: () => new FakeSocket(),
        handled: durableGuard(),
        audit: (entry) => refusedAudit.push(entry),
      });
      const client = refused.openClient(async () => {});
      try {
        await client.connect();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      return {
        token: "xapp-SECRET-token",
        observed: JSON.stringify({ refusedAudit, errors }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function discordFixture(): IngressConformanceFixture {
  const handled = durableGuard();
  const audit: DiscordInboundAuditEntry[] = [];
  let socket: FakeSocket | null = null;
  // The channel owns a sender, so the adapter carries a real deliverer and the
  // suite can prove the reply leaves chunked, at the limit and in order.
  const delivered: string[] = [];
  const sender = createDiscordSender({
    token: "discord-conformance-token",
    endpoint: "https://discord.com/api/v10",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { content?: string };
      delivered.push(body.content ?? "");
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => ({ id: `d-${delivered.length}` }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const adapter = createDiscordIngressAdapter({
    token: "discord-conformance-token",
    resolveGateway: async (): Promise<DiscordGatewayResult> => ({
      ok: true,
      url: "wss://conformance.discord.test/?v=10",
    }),
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    handled,
    audit: (entry) => audit.push(entry),
    deliver: (chatId, text) => sender.send(chatId, text),
  });
  const open = async (
    onMessage: (message: IngressMessage) => Promise<void>,
  ): Promise<IngressConformanceConnection> => {
    const client = adapter.openClient(onMessage);
    await client.connect();
    const current = socket as FakeSocket;
    return {
      async deliver(raw) {
        current.emit(raw);
        await settle();
      },
      drop() {
        current.serverClose();
      },
    };
  };
  const message = (options: { id: string; text: string; author: Record<string, unknown> }) => ({
    id: options.id,
    channel_id: "chan-conformance",
    content: options.text,
    type: 0,
    author: options.author,
  });
  /** The Gateway wraps a message in a dispatch frame; normalise takes the `d`. */
  const dispatch = (payload: Record<string, unknown>) => ({
    op: 0,
    s: 1,
    t: "MESSAGE_CREATE",
    d: payload,
  });
  const foreign = message({
    id: "m-conformance",
    text: "/start do the thing",
    author: { id: "human-conformance", bot: false },
  });
  return {
    adapter,
    deliver: (text: string) => {
      const chunks: string[] = [];
      const before = delivered.length;
      const deliverer = adapter.deliver!;
      const result = (async () => {
        const outcome = await deliverer("chan-conformance", text);
        chunks.push(...delivered.slice(before));
        return outcome;
      })();
      return { chatId: "chan-conformance", chunks, result };
    },
    foreign: () => ({
      raw: foreign,
      frame: dispatch(foreign),
      expected: {
        messageId: "m-conformance",
        chatId: "chan-conformance",
        text: "/start do the thing",
      },
    }),
    own: () =>
      message({
        id: "m-own",
        text: "/start from the bot",
        author: { id: "bot-conformance", bot: true },
      }),
    async reconnect(): Promise<IngressReconnectProbe> {
      const messages: IngressMessage[] = [];
      const record = async (message: IngressMessage) => {
        messages.push(message);
      };
      return { first: await open(record), reconnect: () => open(record), messages: () => messages };
    },
    async refusedCredential() {
      const refusedAudit: DiscordInboundAuditEntry[] = [];
      const errors: string[] = [];
      const refused = createDiscordIngressAdapter({
        token: "discord-SECRET-token",
        resolveGateway: async () => ({ ok: false, error: "unauthorized" }),
        connect: () => new FakeSocket(),
        handled: durableGuard(),
        audit: (entry) => refusedAudit.push(entry),
      });
      const client = refused.openClient(async () => {});
      try {
        await client.connect();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      return { token: "discord-SECRET-token", observed: JSON.stringify({ refusedAudit, errors }) };
    },
  };
}

// ---------------------------------------------------------------------------
// Mattermost
// ---------------------------------------------------------------------------

function mattermostFixture(): IngressConformanceFixture {
  const handled = durableGuard();
  const audit: MattermostInboundAuditEntry[] = [];
  let socket: FakeSocket | null = null;
  const delivered: string[] = [];
  const sender = createMattermostSender({
    token: "mattermost-conformance-token",
    endpoint: "https://conformance.mattermost.test",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { message?: string };
      delivered.push(body.message ?? "");
      return {
        status: 201,
        ok: true,
        headers: new Headers(),
        json: async () => ({ id: `m-${delivered.length}` }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const adapter = createMattermostIngressAdapter({
    token: "mattermost-conformance-token",
    resolveIdentity: async (): Promise<MattermostIdentityResult> => ({
      ok: true,
      userId: "bot-conformance",
    }),
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    url: "wss://conformance.mattermost.test/api/v4/websocket",
    handled,
    audit: (entry) => audit.push(entry),
    ownUserId: "bot-conformance",
    deliver: (chatId, text) => sender.send({ channelId: chatId }, text),
  });
  const open = async (
    onMessage: (message: IngressMessage) => Promise<void>,
  ): Promise<IngressConformanceConnection> => {
    const client = adapter.openClient(onMessage);
    await client.connect();
    const current = socket as FakeSocket;
    return {
      async deliver(raw) {
        current.emit(raw);
        await settle();
      },
      drop() {
        current.serverClose();
      },
    };
  };
  const posted = (post: Record<string, unknown>) => ({
    event: "posted",
    data: { post: JSON.stringify(post) },
  });
  const foreignPost = {
    id: "post-conformance",
    channel_id: "chan-conformance",
    user_id: "human-conformance",
    message: "/start do the thing",
    type: "",
  };
  return {
    adapter,
    deliver: (text: string) => {
      const chunks: string[] = [];
      const before = delivered.length;
      const deliverer = adapter.deliver!;
      const result = (async () => {
        const outcome = await deliverer("chan-conformance", text);
        chunks.push(...delivered.slice(before));
        return outcome;
      })();
      return { chatId: "chan-conformance", chunks, result };
    },
    foreign: () => ({
      raw: foreignPost,
      frame: posted(foreignPost),
      expected: {
        messageId: "post-conformance",
        chatId: "chan-conformance",
        text: "/start do the thing",
      },
      // normalise takes the post; the wire carries it wrapped in `posted`.
    }),
    own: () => ({ ...foreignPost, id: "post-own", user_id: "bot-conformance" }),
    async reconnect(): Promise<IngressReconnectProbe> {
      const messages: IngressMessage[] = [];
      const record = async (message: IngressMessage) => {
        messages.push(message);
      };
      return { first: await open(record), reconnect: () => open(record), messages: () => messages };
    },
    async refusedCredential() {
      const refusedAudit: MattermostInboundAuditEntry[] = [];
      const errors: string[] = [];
      const refused = createMattermostIngressAdapter({
        token: "mattermost-SECRET-token",
        resolveIdentity: async () => ({ ok: false, error: "unauthorized" }),
        connect: () => new FakeSocket(),
        url: "wss://conformance.mattermost.test/api/v4/websocket",
        handled: durableGuard(),
        audit: (entry) => refusedAudit.push(entry),
      });
      const client = refused.openClient(async () => {});
      try {
        await client.connect();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      return {
        token: "mattermost-SECRET-token",
        observed: JSON.stringify({ refusedAudit, errors }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Matrix (long poll over the client-server API)
// ---------------------------------------------------------------------------

/** The one batch the fixture's fake homeserver has to offer. */
const MATRIX_ROOM = "!conformance:matrix.test";
const MATRIX_OWN_USER = "@bot:matrix.test";
const MATRIX_BATCH_TOKEN = "conformance-batch-1";

const matrixRoomEvent = (event: Record<string, unknown>) => ({
  room_id: MATRIX_ROOM,
  ...event,
});

function matrixFixture(): IngressConformanceFixture {
  const foreignEvent = {
    event_id: "$conformance",
    sender: "@human:matrix.test",
    type: "m.room.message",
    content: { msgtype: "m.text", body: "/start do the thing" },
  };
  const delivered: string[] = [];
  /**
   * One fake homeserver for the pull and send routes. A sync from a token other
   * than the batch's own offers the batch (which is what a lost cursor looks
   * like); a sync from the batch token offers nothing.
   */
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    let body: unknown = {};
    if (url.pathname.endsWith("/sync")) {
      const since = url.searchParams.get("since") ?? "";
      body =
        since === MATRIX_BATCH_TOKEN
          ? { next_batch: MATRIX_BATCH_TOKEN, rooms: { join: {} } }
          : {
              next_batch: MATRIX_BATCH_TOKEN,
              rooms: {
                join: { [MATRIX_ROOM]: { timeline: { events: [foreignEvent] } } },
              },
            };
    } else if (url.pathname.includes("/send/m.room.message/")) {
      const payload = JSON.parse(String(init.body)) as { body?: string };
      delivered.push(payload.body ?? "");
      body = { event_id: `$sent-${delivered.length}` };
    } else {
      body = { user_id: MATRIX_OWN_USER };
    }
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const adapter = createMatrixIngressAdapter({
    endpoint: "https://conformance.matrix.test",
    token: "matrix-conformance-token",
    fetchImpl,
    ownUserId: MATRIX_OWN_USER,
    wait: async () => {},
  });

  return {
    adapter,
    foreign: () => ({
      raw: matrixRoomEvent(foreignEvent),
      expected: {
        messageId: "$conformance",
        chatId: MATRIX_ROOM,
        text: "/start do the thing",
      },
    }),
    own: () =>
      matrixRoomEvent({
        ...foreignEvent,
        event_id: "$own",
        sender: MATRIX_OWN_USER,
      }),
    longPoll: () => ({
      poll: adapter.poll,
      normalise: adapter.normalise,
    }),
    deliver: (text: string) => {
      const chunks: string[] = [];
      const before = delivered.length;
      const deliverer = adapter.deliver!;
      const result = (async () => {
        const outcome = await deliverer(MATRIX_ROOM, text);
        chunks.push(...delivered.slice(before));
        return outcome;
      })();
      return { chatId: MATRIX_ROOM, chunks, result };
    },
    async refusedCredential() {
      const refusedAudit: MatrixInboundAuditEntry[] = [];
      const controller = new AbortController();
      const transport = createMatrixInboundPushTransport({
        endpoint: "https://conformance.matrix.test",
        token: "matrix-SECRET-token",
        resolveIdentity: async () => ({ ok: false, error: "the identity lookup was refused" }),
        handled: durableGuard(),
        cursor: { load: async () => null, save: async () => {} },
        wait: async () => {
          controller.abort();
        },
        audit: (entry) => refusedAudit.push(entry),
      });
      await transport.start(async () => {}, controller.signal);
      return { token: "matrix-SECRET-token", observed: JSON.stringify(refusedAudit) };
    },
  };
}

// ---------------------------------------------------------------------------
// Telegram (polling)
// ---------------------------------------------------------------------------

function telegramFixture(): IngressConformanceFixture {
  const adapter = createTelegramIngressAdapter({
    transport: {
      poll: async (offset) => ({ ok: true, messages: [], nextOffset: offset }),
    },
  });
  return {
    adapter,
    foreign: () => ({
      raw: {
        update_id: 7,
        message: { message_id: 11, chat: { id: 42 }, text: "/start do the thing" },
      },
      expected: { messageId: "11", chatId: "42", text: "/start do the thing" },
    }),
    // Telegram's long poll never returns the bot's own message: the platform
    // delivers only updates addressed to the bot, and a bot's own send is not an
    // update to itself. There is no own-message case to filter here, so this
    // fixture declares none rather than inventing a filter the product lacks.
  };
}

// ---------------------------------------------------------------------------
// IRC (raw socket, line protocol)
// ---------------------------------------------------------------------------

/**
 * A fake IRC server over the conformance module's in-process byte pair: one
 * connection per attempt, a line log of what the client wrote, and a way to send
 * a line back. No port is bound and nothing leaves the process.
 */
class LineServer {
  private readonly connections: Array<{
    lines: string[];
    send(line: string): void;
    close(): void;
  }> = [];

  readonly factory = () => {
    const pair = createIngressRawSocketPair();
    const connection = {
      lines: [] as string[],
      send: (line: string) => pair.server.write(`${line}\r\n`),
      close: () => pair.server.end(),
    };
    let buffer = "";
    pair.server.onData((chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) break;
        connection.lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 2);
      }
    });
    this.connections.push(connection);
    return pair.client;
  };

  get latest() {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error("no IRC connection was opened");
    return connection;
  }

  get sent(): string[] {
    return this.latest.lines;
  }

  get count(): number {
    return this.connections.length;
  }
}

function ircFixture(): IngressConformanceFixture {
  const handled = durableGuard();
  const audit: IrcInboundAuditEntry[] = [];
  const server = new LineServer();
  const chunks: string[] = [];
  const adapter = createIrcIngressAdapter({
    endpoint: { host: "irc.conformance.test", port: 6697, tls: true },
    nick: "pi-bot",
    channels: ["#conformance"],
    handled,
    audit: (entry) => audit.push(entry),
    connect: server.factory,
    registrationTimeoutMs: 200,
    onChunk: (chunk) => chunks.push(chunk),
  });

  /** Wait for the client's registration lines to arrive on the current socket. */
  const waitForRegistration = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const lines = server.sent;
      if (lines.includes("NICK pi-bot") && lines.some((line) => line.startsWith("USER "))) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("the client never sent its registration");
  };

  /** Open one registered connection and return a handle the suite can drive. */
  const open = async (
    onMessage: (message: IngressMessage) => Promise<void>,
  ): Promise<IngressConformanceConnection & { client: ReturnType<typeof adapter.openClient> }> => {
    const client = adapter.openClient(onMessage);
    const connecting = client.connect();
    await waitForRegistration();
    server.latest.send(":irc.conformance.test 001 pi-bot :Welcome");
    await connecting;
    const connection = server.latest;
    return {
      client,
      async deliver(raw) {
        const line = typeof raw === "string" ? raw : "";
        connection.send(line);
        await settle();
      },
      drop() {
        connection.close();
      },
    };
  };

  const foreignLine = ":human-conformance!u@host PRIVMSG #conformance :/start do the thing";

  return {
    adapter,
    deliver: (text: string) => {
      const delivery: {
        chatId: string;
        chunks: string[];
        result: Promise<IngressDeliveryResult>;
      } = {
        chatId: "#conformance",
        chunks: [],
        result: Promise.resolve({ ok: false, error: "not started", sent: 0 }),
      };
      const before = chunks.length;
      delivery.result = (async () => {
        if (server.count === 0) {
          const opening = adapter.openClient(async () => {});
          const connecting = opening.connect();
          await waitForRegistration();
          server.latest.send(":irc.conformance.test 001 pi-bot :Welcome");
          await connecting;
        }
        const outcome = await adapter.deliver!("#conformance", text);
        // The chunks this send produced, read from the sender's own seam.
        delivery.chunks = chunks.slice(before);
        return outcome;
      })();
      return delivery;
    },
    foreign: () => ({
      raw: {
        channel: "#conformance",
        nick: "human-conformance",
        text: "/start do the thing",
        messageId: "m-conformance",
      },
      frame: foreignLine,
      expected: {
        messageId: "m-conformance",
        chatId: "#conformance",
        text: "/start do the thing",
      },
    }),
    // A server echoes our own PRIVMSG with *its* casing for the nick; the filter
    // must compare case-insensitively or the bot answers itself forever.
    own: () => ({
      channel: "#conformance",
      nick: "PI-BOT",
      text: "/start from the bot",
      messageId: "m-own",
    }),
    async refusedCredential() {
      const refusedAudit: IrcInboundAuditEntry[] = [];
      const errors: string[] = [];
      const refusedServer = new LineServer();
      const refused = createIrcIngressAdapter({
        endpoint: { host: "irc.conformance.test", port: 6697, tls: true },
        nick: "pi-bot",
        channels: ["#conformance"],
        handled: durableGuard(),
        password: "irc-SECRET-server-password",
        audit: (entry) => refusedAudit.push(entry),
        connect: refusedServer.factory,
        registrationTimeoutMs: 200,
      });
      const client = refused.openClient(async () => {});
      const connecting = client.connect().catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      });
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (refusedServer.sent.some((line) => line.startsWith("PASS "))) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      refusedServer.latest.send(":irc.conformance.test 464 pi-bot :Password incorrect");
      await connecting;
      return {
        token: "irc-SECRET-server-password",
        observed: JSON.stringify({ refusedAudit, errors }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Home Assistant (websocket, event bus)
// ---------------------------------------------------------------------------

/**
 * A fake Home Assistant over the shared frame-level socket double.
 *
 * The greeting is driven by the fixture rather than by the double, because the
 * shared `FakeSocket` is a frame sink: the fixture emits `auth_required`,
 * `auth_ok` and the subscription result in Home Assistant's own order, which is
 * the ordering under test.
 */
function homeAssistantFixture(): IngressConformanceFixture {
  const handled = durableGuard();
  const audit: HomeAssistantInboundAuditEntry[] = [];
  const delivered: string[] = [];
  let socket: FakeSocket | null = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { message?: string };
    delivered.push(body.message ?? "");
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const adapter = createHomeAssistantIngressAdapter({
    base: "https://conformance.ha.test",
    url: `wss://conformance.ha.test${HOME_ASSISTANT_WEBSOCKET_PATH}`,
    token: "ha-conformance-token",
    service: "notify.persistent_notification",
    handled,
    audit: (entry) => audit.push(entry),
    connect: () => {
      socket = new FakeSocket();
      return socket;
    },
    fetchImpl,
  });

  /** Drive Home Assistant's handshake on the socket the client just opened. */
  const handshake = async (current: FakeSocket, connecting: Promise<void>): Promise<void> => {
    current.emit({ type: "auth_required", ha_version: "2024.1.0" });
    await settle();
    current.emit({ type: "auth_ok", ha_version: "2024.1.0" });
    await settle();
    current.emit({ id: 1, type: "result", success: true, result: null });
    await connecting;
    await settle();
  };

  const open = async (
    onMessage: (message: IngressMessage) => Promise<void>,
  ): Promise<IngressConformanceConnection> => {
    const client = adapter.openClient(onMessage);
    const connecting = client.connect();
    const connection = socket as FakeSocket;
    await handshake(connection, connecting);
    return {
      async deliver(raw) {
        connection.emit({ id: 1, type: "event", event: raw });
        await settle();
      },
      drop() {
        connection.serverClose();
      },
    };
  };

  const foreignEvent = {
    event_type: HOME_ASSISTANT_EVENT_TYPE,
    data: { text: "/start do the thing" },
    origin: "LOCAL",
    time_fired: "2026-10-18T10:00:00.000000+00:00",
    context: { id: "01JCONFORMANCE", parent_id: null, user_id: "user-1" },
  };

  return {
    adapter,
    deliver: (text: string) => {
      const chunks: string[] = [];
      const before = delivered.length;
      const deliverer = adapter.deliver!;
      const result = (async () => {
        const outcome = await deliverer("notify.persistent_notification", text);
        chunks.push(...delivered.slice(before));
        return outcome;
      })();
      return { chatId: "notify.persistent_notification", chunks, result };
    },
    foreign: () => ({
      raw: foreignEvent,
      expected: {
        messageId: "01JCONFORMANCE",
        chatId: "notify.persistent_notification",
        text: "/start do the thing",
      },
    }),
    // An echo of this assistant's own outbound message: the marker a user's
    // automation carries when it re-fires a reply it just received.
    own: () => ({
      ...foreignEvent,
      data: { text: "/start from the bot", source: "qianning" },
      context: { id: "01JOWN" },
    }),
    async reconnect(): Promise<IngressReconnectProbe> {
      const messages: IngressMessage[] = [];
      const record = async (message: IngressMessage) => {
        messages.push(message);
      };
      return { first: await open(record), reconnect: () => open(record), messages: () => messages };
    },
    async refusedCredential() {
      const refusedAudit: HomeAssistantInboundAuditEntry[] = [];
      const errors: string[] = [];
      let refusedSocket: FakeSocket | null = null;
      const refused = createHomeAssistantIngressAdapter({
        base: "https://conformance.ha.test",
        url: `wss://conformance.ha.test${HOME_ASSISTANT_WEBSOCKET_PATH}`,
        token: "ha-SECRET-token",
        service: "notify.persistent_notification",
        handled: durableGuard(),
        audit: (entry) => refusedAudit.push(entry),
        connect: () => {
          refusedSocket = new FakeSocket();
          return refusedSocket;
        },
        fetchImpl,
      });
      const client = refused.openClient(async () => {});
      const connecting = client.connect().catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      });
      const current = refusedSocket as FakeSocket | null;
      if (current) {
        current.emit({ type: "auth_required" });
        await settle();
        current.emit({ type: "auth_invalid", message: "Invalid access token or password" });
      }
      await connecting;
      return { token: "ha-SECRET-token", observed: JSON.stringify({ refusedAudit, errors }) };
    },
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const FIXTURES: { name: string; build: () => IngressConformanceFixture }[] = [
  { name: "slack", build: slackFixture },
  { name: "discord", build: discordFixture },
  { name: "mattermost", build: mattermostFixture },
  { name: "telegram", build: telegramFixture },
  { name: "matrix", build: matrixFixture },
  { name: "irc", build: ircFixture },
  { name: "home assistant", build: homeAssistantFixture },
];

for (const entry of FIXTURES) {
  describe(`${entry.name} ingress conformance`, () => {
    const fixture = entry.build();
    for (const scenario of ingressConformanceScenarios(fixture)) {
      it(scenario.name, scenario.run);
    }
  });
}

// ---------------------------------------------------------------------------
// The webhook transport, proven by its own adapter
// ---------------------------------------------------------------------------

type HookEvent = { kind: string; id: string; chat: string; text: string; from: string };

function hookAdapter() {
  return {
    platform: "hook-conformance",
    kind: "webhook" as const,
    messageLimit: 120,
    normalise: (raw: unknown) => {
      const event = raw as HookEvent;
      if (!event || typeof event !== "object" || typeof event.id !== "string") {
        return { kind: "filtered" as const, reason: "not an event" };
      }
      if (event.from === "bot") return { kind: "filtered" as const, reason: "own message" };
      return {
        kind: "message" as const,
        message: { messageId: event.id, chatId: event.chat, text: event.text },
        key: event.id,
      };
    },
  };
}

describe("webhook ingress transport", () => {
  it("delivers a foreign event once and answers 200", async () => {
    const messages: IngressMessage[] = [];
    const guard = durableGuard();
    const transport = new WebhookIngressTransport(hookAdapter(), {
      handled: guard,
      onMessage: async (message) => {
        messages.push(message);
      },
    });
    const body = JSON.stringify({ kind: "message", id: "e1", chat: "c1", text: "hello", from: "human" });
    const first = await transport.handle({ body });
    const second = await transport.handle({ body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(messages).toEqual([{ messageId: "e1", chatId: "c1", text: "hello" }]);
  });

  it("answers 200 without delivering when the event is the bot's own", async () => {
    const messages: IngressMessage[] = [];
    const transport = new WebhookIngressTransport(hookAdapter(), {
      handled: durableGuard(),
      onMessage: async (message) => {
        messages.push(message);
      },
    });
    const response = await transport.handle({
      body: JSON.stringify({ kind: "message", id: "e2", chat: "c1", text: "hi", from: "bot" }),
    });
    expect(response.status).toBe(200);
    expect(messages).toHaveLength(0);
  });

  it("answers 400 for a body that is not JSON, and delivers nothing", async () => {
    const messages: IngressMessage[] = [];
    const transport = new WebhookIngressTransport(hookAdapter(), {
      handled: durableGuard(),
      onMessage: async (message) => {
        messages.push(message);
      },
    });
    const response = await transport.handle({ body: "not json" });
    expect(response.status).toBe(400);
    expect(messages).toHaveLength(0);
  });

  it("answers 500 when handling fails, so the platform redelivers", async () => {
    const transport = new WebhookIngressTransport(hookAdapter(), {
      handled: durableGuard(),
      onMessage: async () => {
        throw new Error("routing failed");
      },
    });
    const response = await transport.handle({
      body: JSON.stringify({ kind: "message", id: "e3", chat: "c1", text: "hi", from: "human" }),
    });
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Negative control: an adapter broken the way a copy-paste port goes wrong
// ---------------------------------------------------------------------------

describe("the conformance suite rejects a broken adapter", () => {
  /** The Slack adapter with its replay key broken: a fresh key every call. */
  function brokenReplayKey(): MessagingIngressAdapter {
    const good = slackFixture().adapter;
    let counter = 0;
    return {
      ...good,
      normalise: (raw: unknown) => {
        const normalisation = good.normalise(raw);
        if (normalisation.kind !== "message") return normalisation;
        counter += 1;
        return { ...normalisation, key: `${normalisation.key}#${counter}` };
      },
    };
  }

  /**
   * The Discord adapter with its own-message filter forgotten — the fields the
   * filter reads are stripped, exactly as a copy-paste port that skipped the
   * rule would produce.
   */
  function brokenOwnFilter(): MessagingIngressAdapter {
    const good = discordFixture().adapter;
    return {
      ...good,
      normalise: (raw: unknown) => {
        const payload = raw as Record<string, unknown> | null;
        if (!payload || typeof payload !== "object") return good.normalise(raw);
        const author = payload.author as Record<string, unknown> | undefined;
        if (!author) return good.normalise(raw);
        const { bot: _bot, ...rest } = author;
        return good.normalise({ ...payload, author: rest });
      },
    };
  }

  it("fails the redelivery scenario when the replay key is not stable", async () => {
    const fixture = { ...slackFixture(), adapter: brokenReplayKey() };
    const scenarios = ingressConformanceScenarios(fixture);
    const redelivery = scenarios.find((s) => s.name.includes("redelivered"));
    expect(redelivery).toBeDefined();
    await expect(redelivery!.run()).rejects.toThrow();
  });

  it("passes the same scenario with the real adapter, so the control is not vacuous", async () => {
    const scenarios = ingressConformanceScenarios(slackFixture());
    const redelivery = scenarios.find((s) => s.name.includes("redelivered"));
    await expect(redelivery!.run()).resolves.toBeUndefined();
  });

  it("fails the own-message scenario when the bot filter is dropped", async () => {
    const fixture = { ...discordFixture(), adapter: brokenOwnFilter() };
    const scenarios = ingressConformanceScenarios(fixture);
    const own = scenarios.find((s) => s.name.includes("own message"));
    expect(own).toBeDefined();
    await expect(own!.run()).rejects.toThrow();
  });

  it("passes the own-message scenario with the real adapter", async () => {
    const scenarios = ingressConformanceScenarios(discordFixture());
    const own = scenarios.find((s) => s.name.includes("own message"));
    await expect(own!.run()).resolves.toBeUndefined();
  });

  /**
   * The long-poll cursor half: a channel whose poll ignores the token it was
   * given is the copy-paste failure this scenario exists for — it applies the
   * batch again after a restart.
   */
  function brokenLongPoll(): MessagingIngressAdapter & { kind: "poll" } {
    type Polling = {
      poll: (cursor: string, signal?: AbortSignal) => Promise<IngressPollResult<string>>;
    };
    const base = matrixFixture().adapter as unknown as Record<string, unknown> & Polling;
    return {
      ...base,
      poll: async () => {
        const consequence = await base.poll("", undefined);
        if (consequence.ok) return { ok: true, events: consequence.events, nextCursor: "moved" };
        return consequence;
      },
    } as unknown as MessagingIngressAdapter & { kind: "poll" };
  }

  it("fails the restart scenario when the poll ignores its token", async () => {
    const broken = brokenLongPoll();
    const polling = broken as unknown as {
      poll: (cursor: string, signal?: AbortSignal) => Promise<IngressPollResult<string>>;
    };
    const fixture: IngressConformanceFixture = {
      ...matrixFixture(),
      adapter: broken,
      // The probe has to point at the broken adapter, or it would keep polling
      // through the good one and the control would prove nothing.
      longPoll: () => ({ poll: polling.poll, normalise: broken.normalise }),
    };
    const scenarios = ingressConformanceScenarios(fixture);
    const restart = scenarios.find((s) => s.name.includes("restart resumes"));
    expect(restart).toBeDefined();
    await expect(restart!.run()).rejects.toThrow();
  });

  it("passes the restart scenario with the real adapter", async () => {
    const scenarios = ingressConformanceScenarios(matrixFixture());
    const restart = scenarios.find((s) => s.name.includes("restart resumes"));
    await expect(restart!.run()).resolves.toBeUndefined();
  });
});
