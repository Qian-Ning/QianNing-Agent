import { describe, expect, it } from "vitest";

import {
  DISCORD_GATEWAY_INTENTS,
  MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF,
  MESSAGING_DISCORD_FORMAT,
  MESSAGING_DISCORD_FORMAT_VERSION,
  MESSAGING_IRC_FORMAT,
  MESSAGING_IRC_FORMAT_VERSION,
  MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF,
  MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATTERMOST_FORMAT,
  MESSAGING_MATTERMOST_FORMAT_VERSION,
  type DiscordGatewayResult,
  type DiscordSocket,
  type DiscordSocketFactory,
  type MattermostSocket,
  type MattermostSocketFactory,
  type Principal,
} from "@pi-desktop/agent-host";

import {
  createDiscordInboundWiring,
  createIrcInboundWiring,
  createMattermostInboundWiring,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
  type MessagingInboundWiringLog,
} from "./messaging-inbound-wiring.js";

const SESSION_ID = "session-1";
const LINKED_PRINCIPAL: Principal = { subject: "linked-user", roles: ["controller"] };

function memorySettings(initial: Record<string, unknown> = {}): HostSettingsSurface {
  let row: Record<string, unknown> = { ...initial };
  return {
    async read() {
      return row;
    },
    async write(patch) {
      row = { ...row, ...patch };
    },
  };
}

function section(format: string, version: number, chatId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format,
    version,
    destination: chatId,
    inbound: {
      linkedPrincipal: { subject: LINKED_PRINCIPAL.subject, roles: [...LINKED_PRINCIPAL.roles] },
      sessionId: SESSION_ID,
      ...extra,
    },
  };
}

type Routed = { operation: string; sessionId?: string; text?: string };

function stubHost(routed: Routed[]): MessagingInboundHostSurface {
  const surface = {
    async startTurn(_principal: Principal, params: { sessionId: string; input: { text: string } }): Promise<unknown> {
      routed.push({ operation: "turn/start", sessionId: params.sessionId, text: params.input.text });
      return { turn: { id: "turn-1" } };
    },
    async stopTurn(): Promise<unknown> {
      return {};
    },
    async interruptTurn(): Promise<unknown> {
      return {};
    },
    async respondApproval(): Promise<void> {},
  };
  const snapshot = (async () => ({ activeTurn: { id: "turn-1" }, pendingApprovals: [] })) as unknown as
    MessagingInboundHostSurface["snapshot"];
  return { ...surface, snapshot } as MessagingInboundHostSurface;
}

class FakeDiscordSocket implements DiscordSocket {
  readonly sent: string[] = [];
  private onMessageHandler: ((data: string) => void) | null = null;
  private onCloseHandler: ((code?: number, reason?: string) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onMessage(handler: (data: string) => void): void {
    this.onMessageHandler = handler;
  }
  onClose(handler: (code?: number, reason?: string) => void): void {
    this.onCloseHandler = handler;
  }
  onError(): void {}
  deliver(frame: unknown): void {
    this.onMessageHandler?.(JSON.stringify(frame));
  }
  serverClose(): void {
    this.onCloseHandler?.(1006, "server closed");
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

class DiscordFactory {
  readonly created: FakeDiscordSocket[] = [];
  readonly urls: string[] = [];
  factory: DiscordSocketFactory = (url) => {
    this.urls.push(url);
    const socket = new FakeDiscordSocket();
    this.created.push(socket);
    return socket;
  };
  get last(): FakeDiscordSocket {
    const socket = this.created[this.created.length - 1];
    if (!socket) throw new Error("no socket");
    return socket;
  }
}

class FakeMattermostSocket implements MattermostSocket {
  readonly sent: string[] = [];
  private onMessageHandler: ((data: string) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onMessage(handler: (data: string) => void): void {
    this.onMessageHandler = handler;
  }
  onClose(): void {}
  onError(): void {}
  deliver(frame: unknown): void {
    this.onMessageHandler?.(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

class MattermostFactory {
  readonly created: FakeMattermostSocket[] = [];
  readonly urls: string[] = [];
  factory: MattermostSocketFactory = (url) => {
    this.urls.push(url);
    const socket = new FakeMattermostSocket();
    this.created.push(socket);
    return socket;
  };
  get last(): FakeMattermostSocket {
    const socket = this.created[this.created.length - 1];
    if (!socket) throw new Error("no socket");
    return socket;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

const HELLO = { op: 10, d: { heartbeat_interval: 60_000 } };
const READY = { op: 0, s: 1, t: "READY", d: { session_id: "sess-1", user: { id: "bot-1" } } };

function discordMessage(id = "m-1", author = "human-1", content = "/start hello"): Record<string, unknown> {
  return {
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: { id, channel_id: "chan-1", content, type: 0, author: { id: author } },
  };
}

function discordWiring(options: {
  settings: HostSettingsSurface;
  signal: AbortSignal;
  secrets: (ref: string) => Promise<string | null>;
  factory: DiscordFactory;
  routed?: Routed[];
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
  lookup?: () => Promise<DiscordGatewayResult>;
}) {
  const logs = options.logs ?? [];
  const log: MessagingInboundWiringLog = (level, message, data) => logs.push({ level, message, data });
  return {
    logs,
    wiring: createDiscordInboundWiring({
      agentHost: stubHost(options.routed ?? []),
      settings: options.settings,
      secrets: options.secrets,
      signal: options.signal,
      resolveGateway: options.lookup ?? (async () => ({ ok: true, url: "wss://gateway.discord.test" })),
      connect: options.factory.factory,
      wait: async () => {},
      log,
    }),
  };
}

function mattermostWiring(options: {
  settings: HostSettingsSurface;
  signal: AbortSignal;
  secrets: (ref: string) => Promise<string | null>;
  factory: MattermostFactory;
  routed?: Routed[];
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
  identity?: () => Promise<{ ok: true; userId: string } | { ok: false; error: string }>;
}) {
  const logs = options.logs ?? [];
  const log: MessagingInboundWiringLog = (level, message, data) => logs.push({ level, message, data });
  return {
    logs,
    wiring: createMattermostInboundWiring({
      agentHost: stubHost(options.routed ?? []),
      settings: options.settings,
      secrets: options.secrets,
      signal: options.signal,
      resolveIdentity: options.identity ?? (async () => ({ ok: true, userId: "bot-user" })),
      connect: options.factory.factory,
      wait: async () => {},
      log,
    }),
  };
}

// ---------------------------------------------------------------------------
// Discord: gate, normalisation into the existing driver, durable guard
// ---------------------------------------------------------------------------

describe("discord inbound wiring", () => {
  it("never opens a socket without the bot token, and asks for its own ref", async () => {
    const settings = memorySettings({
      messagingDiscord: section(MESSAGING_DISCORD_FORMAT, MESSAGING_DISCORD_FORMAT_VERSION, "chan-1"),
    });
    const factory = new DiscordFactory();
    const refs: string[] = [];
    const controller = new AbortController();
    const { wiring } = discordWiring({
      settings,
      signal: controller.signal,
      factory,
      secrets: async (ref) => {
        refs.push(ref);
        return null;
      },
    });
    await expect(wiring.run()).resolves.toBeUndefined();
    expect(refs).toEqual([MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF]);
    expect(factory.created).toHaveLength(0);
  });

  it("routes one foreign message into the one driver, and the bot's own into none", async () => {
    const settings = memorySettings({
      messagingDiscord: section(MESSAGING_DISCORD_FORMAT, MESSAGING_DISCORD_FORMAT_VERSION, "chan-1"),
    });
    const factory = new DiscordFactory();
    const routed: Routed[] = [];
    const controller = new AbortController();
    const { wiring } = discordWiring({
      settings,
      signal: controller.signal,
      factory,
      routed,
      secrets: async (ref) => (ref === MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF ? "bot-token-SECRET" : null),
    });
    const done = wiring.run();
    await settle();

    factory.last.deliver(HELLO);
    factory.last.deliver(READY);
    factory.last.deliver(discordMessage("m-1", "human-1", "/start hello"));
    await settle();
    expect(routed).toEqual([{ operation: "turn/start", sessionId: SESSION_ID, text: "hello" }]);

    factory.last.deliver(discordMessage("m-2", "bot-1", "/start own"));
    await settle();
    expect(routed).toHaveLength(1);

    // The identify frame asked for the intents the channel needs, with the
    // token in IDENTIFY — the platform's own place.
    const identify = factory.last.frames().find((frame) => frame.op === 2);
    expect(identify?.d).toMatchObject({ token: "bot-token-SECRET", intents: DISCORD_GATEWAY_INTENTS });

    // The durable guard recorded the message in the channel's own section.
    const row = (await settings.read()) as Record<string, unknown>;
    const inbound = (row.messagingDiscord as Record<string, unknown>).inbound as Record<string, unknown>;
    expect(inbound.handledMessageIds).toEqual(["chan-1\u0000m-1"]);

    controller.abort();
    await done;
  });

  it("does not deliver a redelivered message twice across a reconnect", async () => {
    const settings = memorySettings({
      messagingDiscord: section(MESSAGING_DISCORD_FORMAT, MESSAGING_DISCORD_FORMAT_VERSION, "chan-1"),
    });
    const factory = new DiscordFactory();
    const routed: Routed[] = [];
    const controller = new AbortController();
    const { wiring } = discordWiring({
      settings,
      signal: controller.signal,
      factory,
      routed,
      secrets: async () => "bot-token-SECRET",
    });
    const done = wiring.run();
    await settle();
    factory.last.deliver(HELLO);
    factory.last.deliver(READY);
    factory.last.deliver(discordMessage("m-1"));
    await settle();
    expect(routed).toHaveLength(1);

    factory.last.serverClose();
    await settle();
    expect(factory.created.length).toBeGreaterThanOrEqual(2);
    factory.last.deliver(HELLO);
    await settle();
    const resume = factory.last.frames().find((frame) => frame.op === 6);
    expect(resume).toBeDefined();
    factory.last.deliver(discordMessage("m-1"));
    await settle();
    expect(routed).toHaveLength(1);

    controller.abort();
    await done;
  });

  it("refuses a record of another format as unlinked", async () => {
    const settings = memorySettings({
      messagingDiscord: section("pi-desktop-messaging-slack", 1, "chan-1"),
    });
    const factory = new DiscordFactory();
    const routed: Routed[] = [];
    const controller = new AbortController();
    const { wiring } = discordWiring({
      settings,
      signal: controller.signal,
      factory,
      routed,
      secrets: async () => "bot-token-SECRET",
    });
    const done = wiring.run();
    await settle();
    factory.last.deliver(HELLO);
    factory.last.deliver(READY);
    factory.last.deliver(discordMessage("m-1"));
    await settle();
    expect(routed).toEqual([]);
    controller.abort();
    await done;
  });
});

// ---------------------------------------------------------------------------
// Mattermost: gate, handshake, normalisation, durable guard
// ---------------------------------------------------------------------------

describe("mattermost inbound wiring", () => {
  it("never opens a socket without the access token, or without a base URL", async () => {
    const factory = new MattermostFactory();
    const refs: string[] = [];
    const controller = new AbortController();
    const withoutToken = memorySettings({
      messagingMattermost: {
        ...section(MESSAGING_MATTERMOST_FORMAT, MESSAGING_MATTERMOST_FORMAT_VERSION, "chan-1"),
        endpoint: "https://chat.example.com",
      },
    });
    const first = mattermostWiring({
      settings: withoutToken,
      signal: controller.signal,
      factory,
      secrets: async (ref) => {
        refs.push(ref);
        return null;
      },
    });
    await expect(first.wiring.run()).resolves.toBeUndefined();
    expect(refs).toEqual([MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF]);
    expect(factory.created).toHaveLength(0);

    // A token with no server URL configured also opens nothing: there is no
    // default host for a self-hosted product.
    const withoutEndpoint = memorySettings({
      messagingMattermost: section(MESSAGING_MATTERMOST_FORMAT, MESSAGING_MATTERMOST_FORMAT_VERSION, "chan-1"),
    });
    await expect(
      mattermostWiring({
        settings: withoutEndpoint,
        signal: controller.signal,
        factory,
        secrets: async () => "access-token-SECRET",
      }).wiring.run(),
    ).resolves.toBeUndefined();
    expect(factory.created).toHaveLength(0);
  });

  it("authenticates, then routes one foreign post and ignores its own", async () => {
    const settings = memorySettings({
      messagingMattermost: {
        ...section(MESSAGING_MATTERMOST_FORMAT, MESSAGING_MATTERMOST_FORMAT_VERSION, "chan-1"),
        endpoint: "https://chat.example.com",
      },
    });
    const factory = new MattermostFactory();
    const routed: Routed[] = [];
    const controller = new AbortController();
    const { wiring } = mattermostWiring({
      settings,
      signal: controller.signal,
      factory,
      routed,
      secrets: async (ref) => (ref === MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF ? "access-token-SECRET" : null),
    });
    const done = wiring.run();
    await settle();

    expect(factory.urls[0]).toBe("wss://chat.example.com/api/v4/websocket");
    const challenge = factory.last.frames().find((frame) => frame.action === "authentication_challenge");
    expect(challenge?.data).toEqual({ token: "access-token-SECRET" });
    factory.last.deliver({ status: "OK", seq_reply: 1 });

    factory.last.deliver({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "p-1",
          channel_id: "chan-1",
          user_id: "human-1",
          message: "/start hi",
          type: "",
        }),
      },
    });
    await settle();
    expect(routed).toEqual([{ operation: "turn/start", sessionId: SESSION_ID, text: "hi" }]);

    factory.last.deliver({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "p-2",
          channel_id: "chan-1",
          user_id: "bot-user",
          message: "/start own",
          type: "",
        }),
      },
    });
    await settle();
    expect(routed).toHaveLength(1);

    const row = (await settings.read()) as Record<string, unknown>;
    const inbound = (row.messagingMattermost as Record<string, unknown>).inbound as Record<string, unknown>;
    expect(inbound.handledMessageIds).toEqual(["p-1"]);

    controller.abort();
    await done;
  });
});

// ---------------------------------------------------------------------------
// IRC: config gate, registration into the existing driver, byte-limited replies
// ---------------------------------------------------------------------------

/** A raw IRC socket the suite plays a server on: bytes in, lines out. */
class FakeIrcSocket {
  readonly lines: string[] = [];
  private dataHandler: ((chunk: string) => void) | null = null;
  private closed = false;
  write(text: string): void {
    if (this.closed) return;
    for (const line of text.split("\r\n")) if (line !== "") this.lines.push(line);
  }
  end(): void {
    this.closed = true;
  }
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler;
  }
  onClose(): void {}
  onError(): void {}
  send(line: string): void {
    this.dataHandler?.(`${line}\r\n`);
  }
}

class IrcFactory {
  readonly created: FakeIrcSocket[] = [];
  factory = (): FakeIrcSocket => {
    const socket = new FakeIrcSocket();
    this.created.push(socket);
    return socket;
  };
  get last(): FakeIrcSocket {
    const socket = this.created[this.created.length - 1];
    if (!socket) throw new Error("no IRC connection was opened");
    return socket;
  }
}

function ircWiring(options: {
  settings: HostSettingsSurface;
  signal: AbortSignal;
  secrets: (ref: string) => Promise<string | null>;
  factory: IrcFactory;
  routed?: Routed[];
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
}) {
  const logs = options.logs ?? [];
  const log: MessagingInboundWiringLog = (level, message, data) => logs.push({ level, message, data });
  return {
    logs,
    wiring: createIrcInboundWiring({
      agentHost: stubHost(options.routed ?? []),
      settings: options.settings,
      secrets: options.secrets,
      signal: options.signal,
      connect: options.factory.factory,
      wait: async () => {},
      log,
    }),
  };
}

function ircSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...section(MESSAGING_IRC_FORMAT, MESSAGING_IRC_FORMAT_VERSION, "#pi-desktop"),
    endpoint: "ircs://irc.example.test:6697",
    nick: "pi-bot",
    channels: "#pi-desktop, #ops",
    ...extra,
  };
}

describe("irc inbound wiring", () => {
  it("opens no connection without a section, without a nick, or without a channel", async () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { messagingIrc: ircSection({ nick: "" }) },
      { messagingIrc: ircSection({ channels: "", destination: "" }) },
    ];
    for (const row of cases) {
      const factory = new IrcFactory();
      const controller = new AbortController();
      const { wiring } = ircWiring({
        settings: memorySettings(row),
        signal: controller.signal,
        factory,
        secrets: async () => null,
      });
      const done = wiring.run();
      await settle();
      expect(factory.created).toHaveLength(0);
      controller.abort();
      await done;
    }
  });

  it("refuses a plaintext server address without the relaxed policy and logs why", async () => {
    const factory = new IrcFactory();
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const { wiring } = ircWiring({
      settings: memorySettings({
        messagingIrc: ircSection({ endpoint: "irc://irc.example.test:6667" }),
      }),
      signal: controller.signal,
      factory,
      secrets: async () => null,
      logs,
    });
    const done = wiring.run();
    await settle();
    expect(factory.created).toHaveLength(0);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
    controller.abort();
    await done;
  });

  it("registers, joins the configured channels, and routes one message into a turn", async () => {
    const routed: Routed[] = [];
    const factory = new IrcFactory();
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const controller = new AbortController();
    const secretsAsked: string[] = [];
    const { wiring } = ircWiring({
      settings: memorySettings({ messagingIrc: ircSection() }),
      signal: controller.signal,
      factory,
      secrets: async (ref) => {
        secretsAsked.push(ref);
        return "server-password-value";
      },
      routed,
      logs,
    });
    const done = wiring.run();
    await settle();

    expect(factory.created).toHaveLength(1);
    const socket = factory.last;
    expect(socket.lines).toContain("PASS :server-password-value");
    expect(socket.lines).toContain("NICK pi-bot");
    expect(secretsAsked).toContain(MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF);

    socket.send(":irc.example.test 001 pi-bot :Welcome");
    await settle();
    expect(socket.lines).toContain("JOIN #pi-desktop");
    expect(socket.lines).toContain("JOIN #ops");

    socket.send(":human-1!u@host PRIVMSG #pi-desktop :/start hi");
    await settle();
    expect(routed).toEqual([{ operation: "turn/start", sessionId: SESSION_ID, text: "hi" }]);

    // Our own nick, echoed with the server's casing, is not a command.
    socket.send(":PI-BOT!bot@host PRIVMSG #pi-desktop :/start own");
    await settle();
    expect(routed).toHaveLength(1);

    // The password never reaches a log entry.
    expect(JSON.stringify(logs)).not.toContain("server-password-value");

    controller.abort();
    await done;
  });
});
