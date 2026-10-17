/**
 * The IRC channel, proven against an in-process fake server.
 *
 * There is no network here and no listening socket: the client is given one end
 * of [`createIngressRawSocketPair`] and the suite plays the server on the other,
 * byte for byte. That is what makes the three classic IRC failures provable
 * rather than assumed — registration refusals, the keepalive, and the byte
 * budget all cross a real socket-shaped seam, not a mocked method.
 *
 * Each test names the failure it prevents. A suite that only asserted "a message
 * arrives" would pass for a client that never answers PING and dies every five
 * minutes.
 */

import { describe, expect, it } from "vitest";

import {
  createIrcIngressAdapter,
  createIrcInboundPushTransport,
  createIrcSender,
  isIrcNickValid,
  IrcClient,
  MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF,
  normaliseIrcChannels,
  normaliseIrcMessage,
  parseIrcLine,
  validateIrcEndpoint,
  type IrcClientOptions,
  type IrcInboundAuditEntry,
} from "./messaging-irc-inbound.js";
import {
  chunkIrcMessage,
  IRC_MESSAGE_LIMIT_BYTES,
  type IrcSocketFactory,
} from "./messaging-irc-send.js";
import { createIngressRawSocketPair } from "./messaging-ingress-conformance.js";
import type { IngressMessage } from "./messaging-ingress.js";

const ENDPOINT = { host: "irc.test.invalid", port: 6697, tls: true };

/** Poll a condition with microtask-sized steps; no fixed sleep. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One connection the suite plays a server on. */
type FakeConnection = {
  /** Every complete line the client wrote, CRLF stripped. */
  lines: string[];
  /** Write one line to the client. */
  send(line: string): void;
  /** Write raw bytes, so a test can split a line across two reads. */
  raw(chunk: string): void;
  /** Close the client's end, as a dropped connection would. */
  close(): void;
  /** Report a transport error. */
  fail(error: unknown): void;
};

/** A fake IRC server: one in-process connection per connect attempt. */
class FakeIrcServer {
  readonly connections: FakeConnection[] = [];

  /** The socket factory the client is given. */
  readonly factory: IrcSocketFactory = () => {
    const pair = createIngressRawSocketPair();
    const connection: FakeConnection = {
      lines: [],
      send: (line) => pair.server.write(`${line}\r\n`),
      raw: (chunk) => pair.server.write(chunk),
      close: () => pair.server.end(),
      fail: (error) => pair.fail(error),
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

  get latest(): FakeConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error("no connection was opened");
    return connection;
  }

  /** The last connection's lines, for assertions about what was sent. */
  get sent(): string[] {
    return this.latest.lines;
  }
}

function memoryGuard(): { has(key: string): Promise<boolean>; record(key: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

/** A client over a fake server, with its audit records and delivered messages. */
function makeClient(overrides: Partial<IrcClientOptions> = {}) {
  const server = new FakeIrcServer();
  const audit: IrcInboundAuditEntry[] = [];
  const messages: IngressMessage[] = [];
  const client = new IrcClient({
    endpoint: ENDPOINT,
    nick: "pi-bot",
    channels: ["#pi-desktop", "#ops"],
    handled: memoryGuard(),
    onMessage: async (message) => {
      messages.push(message);
    },
    audit: (entry) => audit.push(entry),
    connect: server.factory,
    registrationTimeoutMs: 50,
    ...overrides,
  });
  return { client, server, audit, messages };
}

/**
 * Open a registered connection: the client sends its registration and the suite
 * welcomes it. Returns once `001` has been processed.
 */
async function registered(
  options: Partial<IrcClientOptions> = {},
): Promise<ReturnType<typeof makeClient>> {
  const harness = makeClient(options);
  const pending = harness.client.connect();
  await until(() => harness.server.connections.length === 1, "the first connection");
  await until(() => harness.server.sent.some((line) => line.startsWith("USER ")), "USER");
  harness.server.latest.send(":irc.test.invalid 001 pi-bot :Welcome to the test network");
  await pending;
  return harness;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("sends PASS, NICK and USER, then joins every configured channel after 001", async () => {
    const harness = await registered({ password: "hunter2-correct-horse" });
    const sent = harness.server.sent;
    expect(sent[0]).toBe("PASS :hunter2-correct-horse");
    expect(sent[1]).toBe("NICK pi-bot");
    expect(sent[2]).toMatch(/^USER pi-bot 0 \* :/);
    // JOINs come only after the welcome, one line per channel.
    expect(sent.indexOf("JOIN #pi-desktop")).toBeGreaterThan(sent.indexOf("NICK pi-bot"));
    expect(sent).toContain("JOIN #ops");
    expect(harness.client.isReady).toBe(true);
  });

  it("surfaces a taken nick as an error instead of retrying forever", async () => {
    const harness = makeClient({ channels: ["#pi-desktop"] });
    const pending = harness.client.connect();
    const settled = pending.catch((error: unknown) => error);
    await until(() => harness.server.sent.some((line) => line.startsWith("NICK ")), "NICK");
    harness.server.latest.send(":irc.test.invalid 433 * pi-bot :Nickname is already in use.");

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("433");
    expect((error as Error).message).toContain("already in use");
    expect(harness.client.lastRefusal).toContain("433");
    // Surfaced, not swallowed: the refusal is an audit record of its own.
    expect(harness.audit).toContainEqual({
      kind: "auth-failed",
      error: expect.stringContaining("433"),
    });
    // No second registration: the client did not answer 433 by re-sending NICK.
    expect(harness.server.sent.filter((line) => line.startsWith("NICK "))).toHaveLength(1);
    // And no channel is joined, because registration never completed.
    expect(harness.server.sent.some((line) => line.startsWith("JOIN "))).toBe(false);
  });

  it("reports a rejected server password without ever quoting it", async () => {
    const password = "irc-SECRET-server-password";
    const harness = makeClient({ password });
    const pending = harness.client.connect();
    const settled = pending.catch((error: unknown) => error);
    await until(() => harness.server.sent.some((line) => line.startsWith("PASS ")), "PASS");
    harness.server.latest.send(":irc.test.invalid 464 pi-bot :Password incorrect");

    const error = await settled;
    expect((error as Error).message).toContain("464");
    const observed = JSON.stringify({ audits: harness.audit, errors: [(error as Error).message] });
    expect(observed).not.toContain(password);
    // The ref the settings section carries is a reference, not a value.
    expect(MESSAGING_IRC_SERVER_PASSWORD_SECRET_REF).toBe("secret:messaging-irc:server-password");
  });

  it("reports a ban (465) and missing parameters (461) as registration refusals", async () => {
    for (const numeric of ["465", "461"] as const) {
      const harness = makeClient();
      const pending = harness.client.connect();
      const settled = pending.catch((error: unknown) => error);
      await until(() => harness.server.sent.some((line) => line.startsWith("NICK ")), "NICK");
      harness.server.latest.send(`:irc.test.invalid ${numeric} * :refused`);
      const error = (await settled) as Error;
      expect(error.message).toContain(numeric);
      expect(harness.audit.some((entry) => entry.kind === "auth-failed")).toBe(true);
    }
  });

  it("fails a registration the server never answers, and says why", async () => {
    const harness = makeClient({ registrationTimeoutMs: 5 });
    const error = (await harness.client.connect().catch((reason: unknown) => reason)) as Error;
    expect(error.message).toContain("did not answer registration");
    expect(harness.audit).toContainEqual({
      kind: "auth-failed",
      error: expect.stringContaining("did not answer registration"),
    });
  });

  it("a refusing server is one reported attempt, not a silent spin", async () => {
    const controller = new AbortController();
    const server = new FakeIrcServer();
    const audit: IrcInboundAuditEntry[] = [];
    let attempts = 0;
    const transport = createIrcInboundPushTransport({
      client: {
        endpoint: ENDPOINT,
        nick: "pi-bot",
        channels: ["#pi-desktop"],
        handled: memoryGuard(),
        audit: (entry) => audit.push(entry),
        registrationTimeoutMs: 5,
        connect: () => {
          attempts += 1;
          const factory = server.factory;
          const socket = factory(ENDPOINT);
          // Answer every attempt with 433, the way a real server would while the
          // nick stays taken.
          setTimeout(() => server.latest.send(":irc.test.invalid 433 * pi-bot :in use"), 0);
          return socket;
        },
      },
      wait: async () => {
        controller.abort();
      },
    });
    await transport.start(async () => {}, controller.signal);
    expect(attempts).toBe(1);
    expect(audit.filter((entry) => entry.kind === "auth-failed")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Keepalive and protocol bookkeeping
// ---------------------------------------------------------------------------

describe("keepalive and bookkeeping", () => {
  it("answers PING with a PONG carrying the same token", async () => {
    const harness = await registered();
    harness.server.latest.send("PING :tok-abc123");
    await until(() => harness.server.sent.includes("PONG :tok-abc123"), "PONG");
    expect(harness.server.sent).toContain("PONG :tok-abc123");
  });

  it("does not treat NAMES (353/366) as messages", async () => {
    const harness = await registered();
    harness.server.latest.send(":irc.test.invalid 353 pi-bot = #pi-desktop :pi-bot alice bob");
    harness.server.latest.send(":irc.test.invalid 366 pi-bot #pi-desktop :End of /NAMES list.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.messages).toHaveLength(0);
  });

  it("reassembles a line split across two reads", async () => {
    const harness = await registered();
    harness.server.latest.raw(":alice!a@b PRIVMSG #pi-desktop :hel");
    harness.server.latest.raw("lo there\r\n");
    await until(() => harness.messages.length === 1, "the reassembled message");
    expect(harness.messages[0]?.text).toBe("hello there");
  });
});

// ---------------------------------------------------------------------------
// Inbound normalisation
// ---------------------------------------------------------------------------

describe("inbound filtering", () => {
  it("turns one PRIVMSG in a configured channel into exactly one turn", async () => {
    const harness = await registered();
    harness.server.latest.send(":alice!a@b PRIVMSG #pi-desktop :/start do the thing");
    await until(() => harness.messages.length === 1, "the turn");
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({
      chatId: "#pi-desktop",
      text: "/start do the thing",
    });
    // No second turn from the same line.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.messages).toHaveLength(1);
  });

  it("filters our own message whatever casing the server echoes", async () => {
    const harness = await registered();
    harness.server.latest.send(":PI-BOT!bot@host PRIVMSG #pi-desktop :from myself");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.messages).toHaveLength(0);
    expect(harness.audit).toContainEqual({
      kind: "filtered",
      reason: "the message is the client's own",
      channelId: "#pi-desktop",
    });
  });

  it("filters NOTICE and CTCP ACTION", async () => {
    const harness = await registered();
    harness.server.latest.send(":alice!a@b NOTICE #pi-desktop :this is a notice");
    harness.server.latest.send(":alice!a@b PRIVMSG #pi-desktop :\u0001ACTION waves\u0001");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.messages).toHaveLength(0);
    expect(harness.audit).toContainEqual({
      kind: "filtered",
      reason: "CTCP is not a message",
      channelId: "#pi-desktop",
    });
  });

  it("filters a message outside every configured channel", async () => {
    const harness = await registered();
    harness.server.latest.send(":alice!a@b PRIVMSG #not-ours :hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.messages).toHaveLength(0);
    expect(harness.audit).toContainEqual({
      kind: "filtered",
      reason: "the message is not in a configured channel",
      channelId: "#not-ours",
    });
  });

  it("normalises to the configured channel's spelling and a stable key", () => {
    const options = { ownNick: "pi-bot", channels: ["#Pi-Desktop"] };
    const event = {
      channel: "#pi-desktop",
      nick: "alice",
      text: "/stop",
      messageId: "m-1",
    };
    const first = normaliseIrcMessage(event, options);
    const second = normaliseIrcMessage(event, options);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "message",
      message: { messageId: "m-1", chatId: "#Pi-Desktop", text: "/stop" },
    });
  });
});

// ---------------------------------------------------------------------------
// The byte budget
// ---------------------------------------------------------------------------

describe("the byte budget", () => {
  it("splits a long non-English reply without splitting a multibyte character", () => {
    // Three-byte code points, repeated past the budget many times over.
    const text = "服务端在每一条消息里都要计算字节数，".repeat(40);
    const chunks = chunkIrcMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(IRC_MESSAGE_LIMIT_BYTES);
      // A split inside a code point would have produced a replacement character
      // on the way back through UTF-8.
      expect(chunk).not.toContain("\uFFFD");
    }
    expect(chunks.join("")).toBe(text);
  });

  it("counts bytes rather than characters, which is the whole point", () => {
    const text = "中".repeat(200); // 200 characters, 600 bytes
    expect(text.length).toBeLessThanOrEqual(IRC_MESSAGE_LIMIT_BYTES);
    const chunks = chunkIrcMessage(text);
    expect(chunks).toHaveLength(2);
    expect(Buffer.byteLength(chunks[0] ?? "", "utf8")).toBeLessThanOrEqual(IRC_MESSAGE_LIMIT_BYTES);
  });

  it("keeps an emoji's surrogate pair whole at a boundary", () => {
    const text = `${"a".repeat(399)}😀rest`;
    const chunks = chunkIrcMessage(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(IRC_MESSAGE_LIMIT_BYTES);
    }
    expect(chunks[0]?.endsWith("\uD83D")).toBe(false);
  });

  it("splits on newlines so a reply never injects a second protocol line", () => {
    const chunks = chunkIrcMessage("first line\nQUIT :bye\nthird");
    expect(chunks).toEqual(["first line\n", "QUIT :bye\n", "third"]);
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("delivery", () => {
  it("sends one PRIVMSG per chunk, in order, over the live connection", async () => {
    const harness = await registered();
    const text = Array.from({ length: 12 }, (_, index) => `line ${index} 中文字符`).join("\n");
    const result = await harness.client.deliver("#pi-desktop", text);
    expect(result.ok).toBe(true);

    const written = harness.server.sent.filter((line) => line.startsWith("PRIVMSG "));
    expect(written.length).toBeGreaterThan(1);
    // Order is the text's order: each line's own words arrive in sequence.
    const payloads = written.map((line) => line.replace(/^PRIVMSG #pi-desktop :/, ""));
    expect(payloads.join("\n")).toBe(text);
    for (const payload of payloads) {
      expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(IRC_MESSAGE_LIMIT_BYTES);
    }
  });

  it("refuses to send when the connection is not open", async () => {
    const sender = createIrcSender({ write: () => {}, isOpen: () => false });
    const result = await sender.send("#pi-desktop", "hello");
    expect(result).toMatchObject({ ok: false, error: "the IRC connection is not open" });
  });

  it("writes exactly one line per whitespace-free chunk", async () => {
    const written: string[] = [];
    const sender = createIrcSender({
      write: (line) => {
        written.push(line);
      },
      isOpen: () => true,
    });
    const result = await sender.send("#pi-desktop", `a${"b".repeat(500)}`);
    expect(result.ok).toBe(true);
    expect(written).toHaveLength(2);
    expect(written[0]?.startsWith("PRIVMSG #pi-desktop :a")).toBe(true);
  });

  it("stops at the first chunk a closed connection refuses, so order is never skipped", async () => {
    const written: string[] = [];
    let open = true;
    const sender = createIrcSender({
      write: (line) => {
        written.push(line);
        // The connection drops after the first chunk.
        open = false;
      },
      isOpen: () => open,
    });
    const result = await sender.send("#pi-desktop", `a${"b".repeat(500)}`);
    expect(result).toMatchObject({ ok: false, sent: 1, error: "the IRC connection is not open" });
    expect(written).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Addresses and record shapes
// ---------------------------------------------------------------------------

describe("endpoint and record validation", () => {
  it("defaults a bare host to TLS on 6697", () => {
    expect(validateIrcEndpoint("irc.example.org")).toEqual({
      ok: true,
      endpoint: { host: "irc.example.org", port: 6697, tls: true },
    });
    expect(validateIrcEndpoint("ircs://irc.example.org")).toMatchObject({
      ok: true,
      endpoint: { port: 6697, tls: true },
    });
    expect(validateIrcEndpoint("ircs://irc.example.org:7000")).toMatchObject({
      ok: true,
      endpoint: { port: 7000, tls: true },
    });
  });

  it("refuses plaintext unless the relaxed policy names a LAN host", () => {
    expect(validateIrcEndpoint("irc://irc.example.org:6667")).toMatchObject({ ok: false });
    expect(validateIrcEndpoint("irc://irc.example.org:6667", { allowInsecureHttp: true }))
      .toMatchObject({ ok: false });
    expect(validateIrcEndpoint("irc://192.168.1.10:6667", { allowInsecureHttp: true })).toEqual({
      ok: true,
      endpoint: { host: "192.168.1.10", port: 6667, tls: false },
    });
    // A bare address is TLS, even with a port, so it is accepted without the
    // relaxed policy; only an explicit irc:// names a plaintext hop.
    expect(validateIrcEndpoint("127.0.0.1:6667", { allowInsecureHttp: true })).toMatchObject({
      ok: true,
      endpoint: { port: 6667, tls: true },
    });
    expect(validateIrcEndpoint("irc://127.0.0.1:6667")).toMatchObject({ ok: false });
    expect(validateIrcEndpoint("irc://127.0.0.1:6667", { allowInsecureHttp: true })).toMatchObject({
      ok: true,
      endpoint: { port: 6667, tls: false },
    });
  });

  it("refuses a path, userinfo, an empty address, or a foreign scheme", () => {
    for (const value of [
      "",
      "ircs://irc.example.org/join",
      "ircs://user:pass@irc.example.org",
      "ftp://irc.example.org",
    ]) {
      expect(validateIrcEndpoint(value), value).toMatchObject({ ok: false });
    }
  });

  it("validates nicks and normalises channel lists", () => {
    expect(isIrcNickValid("pi-bot")).toBe(true);
    for (const nick of ["", "pi bot", "pi,bot", "#pi"]) expect(isIrcNickValid(nick)).toBe(false);
    expect(normaliseIrcChannels("#Pi-Desktop, ops", "#pi-desktop")).toEqual([
      "#Pi-Desktop",
      "#ops",
    ]);
  });

  it("parses a line's prefix, command and trailing parameter", () => {
    expect(parseIrcLine(":alice!a@b PRIVMSG #chan :hello there")).toEqual({
      prefix: "alice!a@b",
      nick: "alice",
      command: "PRIVMSG",
      params: ["#chan", "hello there"],
    });
  });

  it("declares its limit in bytes, so the shared chunker measures bytes", () => {
    const adapter = createIrcIngressAdapter({
      endpoint: ENDPOINT,
      nick: "pi-bot",
      channels: ["#pi-desktop"],
      handled: memoryGuard(),
      connect: new FakeIrcServer().factory,
    });
    expect(adapter.messageLimit).toBe(IRC_MESSAGE_LIMIT_BYTES);
    expect(adapter.messageLimitUnit).toBe("bytes");
    expect(adapter.platform).toBe("irc");
  });
});
