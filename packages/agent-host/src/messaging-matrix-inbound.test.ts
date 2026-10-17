/**
 * The Matrix channel, driven end to end against an in-process fake homeserver.
 *
 * The fake answers the three calls this build makes — `whoami`, `sync` and the
 * `send` PUT — from one monotone event log, so a cursor is modelled the way a
 * homeserver models it: a token names a position in a log that only grows. No
 * test opens a socket or reaches a Matrix server.
 *
 * The suite covers what the shared conformance suite cannot see for a
 * token-cursor pull channel: the real sync loop (identity, own-sender filter, the
 * encrypted refusal, the redelivery gate, the audit line), token durability
 * across a restart, and the transaction id on the send path.
 */

import { describe, expect, it } from "vitest";

import type { InboundMessage } from "./messaging-inbound.js";
import { ingressMessageKey } from "./messaging-ingress.js";
import {
  classifyMatrixEvent,
  createMatrixIdentityLookup,
  createMatrixInboundPushTransport,
  createMatrixIngressAdapter,
  createMatrixSender,
  MATRIX_ENCRYPTED_REASON,
  MATRIX_MESSAGE_LIMIT,
  MATRIX_TXN_ID_PREFIX,
  matrixApiBase,
  normaliseMatrixEvent,
  type MatrixFetch,
  type MatrixInboundAuditEntry,
  type MatrixRoomEvent,
} from "./messaging-matrix-inbound.js";

// ---------------------------------------------------------------------------
// The fake homeserver
// ---------------------------------------------------------------------------

type LogEntry = {
  roomId: string;
  event: {
    event_id: string;
    sender: string;
    type: string;
    content: Record<string, unknown>;
  };
};

type Post = { roomId: string; txnId: string; body: string };

/**
 * An in-process homeserver: one growing event log, a token that is a position in
 * it, and the three routes this build calls.
 *
 * `sinceToken(token)` is the whole of the cursor model — a token is the log
 * length at the moment it was issued, so asking from it offers exactly what
 * arrived afterwards and nothing before it. A client that loses the token asks
 * from `""` and is offered the whole log, which is what makes a failed save
 * visible in the tests rather than silently harmless.
 */
class FakeHomeserver {
  readonly userId = "@pi-bot:example.test";
  readonly token = "matrix-super-secret-token";
  readonly log: LogEntry[] = [];
  readonly syncRequests: string[] = [];
  readonly posts: Post[] = [];
  /** Every transaction id that reached the server, including refused attempts. */
  readonly attempts: string[] = [];
  /** Set to answer the next identity lookup with this status. */
  whoamiStatus = 200;
  /** Set to answer a sync with this status (0 means "answer normally"). */
  syncStatus = 0;
  /** Set to answer the next send with this status once, then recover. */
  sendStatusOnce = 0;
  /**
   * When set, every sync answer carries this token instead of one derived from
   * the log: a homeserver that repeats the token it was asked from.
   */
  nextBatchOverride: string | null = null;
  /** Called with the index of each sync request; the suite aborts from here. */
  onSync: ((index: number) => void) | null = null;
  /** Every response body the fake sent, for the token-leak assertion. */
  readonly responses: string[] = [];
  /** Every request URL that reached the fake, for the token-leak assertion. */
  readonly urls: string[] = [];

  /** Append one event to the log, as somebody posting in a room would. */
  post(roomId: string, event: LogEntry["event"]): void {
    this.log.push({ roomId, event });
  }

  /** A position in the log: opaque, and only meaningful to this server. */
  private tokenAt(position: number): string {
    return `sync-token-${position}`;
  }

  private sincePosition(token: string): number {
    const match = /^sync-token-(\d+)$/.exec(token);
    return match ? Number(match[1]) : 0;
  }

  private respond(status: number, body: unknown): Response {
    this.responses.push(JSON.stringify(body));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      json: async () => body,
    } as unknown as Response;
  }

  private authorised(init: RequestInit): boolean {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    return headers.get("authorization") === `Bearer ${this.token}`;
  }

  /** The injected HTTP client. */
  readonly fetch: MatrixFetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    this.urls.push(String(input));
    if (init.signal?.aborted) throw new Error("aborted");

    if (url.pathname.endsWith("/account/whoami")) {
      if (!this.authorised(init) || this.whoamiStatus !== 200) {
        return this.respond(this.whoamiStatus === 200 ? 401 : this.whoamiStatus, {
          errcode: "M_UNKNOWN_TOKEN",
        });
      }
      return this.respond(200, { user_id: this.userId });
    }

    if (url.pathname.endsWith("/sync")) {
      const index = this.syncRequests.length;
      const since = url.searchParams.get("since") ?? "";
      this.syncRequests.push(since);
      this.onSync?.(index);
      if (this.syncStatus !== 0) return this.respond(this.syncStatus, { errcode: "M_UNKNOWN" });
      if (!this.authorised(init)) return this.respond(401, { errcode: "M_UNKNOWN_TOKEN" });
      const from = this.sincePosition(since);
      const join: Record<string, { timeline: { events: unknown[] } }> = {};
      for (const entry of this.log.slice(from)) {
        join[entry.roomId] ??= { timeline: { events: [] } };
        join[entry.roomId].timeline.events.push(entry.event);
      }
      return this.respond(200, {
        next_batch: this.nextBatchOverride ?? this.tokenAt(this.log.length),
        rooms: { join },
      });
    }

    const send = /\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(url.pathname);
    if (send) {
      this.attempts.push(decodeURIComponent(send[2] ?? ""));
      if (this.sendStatusOnce !== 0) {
        const status = this.sendStatusOnce;
        this.sendStatusOnce = 0;
        return this.respond(status, { errcode: "M_LIMIT_EXCEEDED" });
      }
      if (!this.authorised(init)) return this.respond(401, { errcode: "M_UNKNOWN_TOKEN" });
      const body = JSON.parse(String(init.body)) as { msgtype: string; body: string };
      this.posts.push({
        roomId: decodeURIComponent(send[1] ?? ""),
        txnId: decodeURIComponent(send[2] ?? ""),
        body: body.body,
      });
      return this.respond(200, { event_id: `$sent-${this.posts.length}` });
    }

    return this.respond(404, { errcode: "M_UNRECOGNISED" });
  }) as unknown as MatrixFetch;
}

/** A durable guard over one process, as the settings-backed store behaves. */
function durableGuard(): { has(id: string): Promise<boolean>; record(id: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (id) => seen.has(id),
    record: async (id) => {
      seen.add(id);
    },
  };
}

/** A cursor store that records what it was asked to save, and when. */
function tokenStore(order: string[] = [], initial: string | null = null): {
  dump(): string | null;
  store: { load(): Promise<string | null>; save(token: string): Promise<void> };
} {
  let saved: string | null = initial;
  return {
    dump: () => saved,
    store: {
      load: async () => saved,
      save: async (token) => {
        order.push("save");
        saved = token;
      },
    },
  };
}

const ROOM = "!ops:example.test";
const SENDER = "@alice:example.test";

function textEvent(eventId: string, text: string, sender = SENDER): LogEntry["event"] {
  return {
    event_id: eventId,
    sender,
    type: "m.room.message",
    content: { msgtype: "m.text", body: text },
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("matrix classification", () => {
  it("accepts a plain text message from another person", () => {
    const event: MatrixRoomEvent = {
      room_id: ROOM,
      ...textEvent("$e1", "/start do the thing"),
    };
    expect(classifyMatrixEvent(event, "@pi-bot:example.test")).toEqual({
      accepted: true,
      message: { messageId: "$e1", chatId: ROOM, text: "/start do the thing" },
    });
    expect(normaliseMatrixEvent(event, "@pi-bot:example.test")).toEqual({
      kind: "message",
      message: { messageId: "$e1", chatId: ROOM, text: "/start do the thing" },
      key: ingressMessageKey(ROOM, "$e1"),
    });
  });

  it("refuses the account's own message", () => {
    const event: MatrixRoomEvent = {
      room_id: ROOM,
      ...textEvent("$e2", "/start from the bot", "@pi-bot:example.test"),
    };
    expect(classifyMatrixEvent(event, "@pi-bot:example.test")).toEqual({
      accepted: false,
      reason: "event is the account's own message",
    });
  });

  it("refuses an encrypted event with the reason the help text states", () => {
    const event: MatrixRoomEvent = {
      room_id: ROOM,
      event_id: "$e3",
      sender: SENDER,
      type: "m.room.encrypted",
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "AwgAEnB..." },
    };
    expect(classifyMatrixEvent(event, "@pi-bot:example.test")).toEqual({
      accepted: false,
      reason: MATRIX_ENCRYPTED_REASON,
      encrypted: true,
    });
    const normalisation = normaliseMatrixEvent(event, "@pi-bot:example.test");
    expect(normalisation.kind).toBe("filtered");
    if (normalisation.kind === "filtered") expect(normalisation.channelId).toBe(ROOM);
  });

  it("refuses non-text msgtypes, non-message types and incomplete events", () => {
    const image: MatrixRoomEvent = {
      room_id: ROOM,
      event_id: "$e4",
      sender: SENDER,
      type: "m.room.message",
      content: { msgtype: "m.image", body: "cat.png" },
    };
    expect(classifyMatrixEvent(image, null)).toEqual({
      accepted: false,
      reason: "message is not plain text",
    });
    const typing: MatrixRoomEvent = {
      room_id: ROOM,
      event_id: "$e5",
      sender: SENDER,
      type: "m.typing",
      content: {},
    };
    expect(classifyMatrixEvent(typing, null)).toEqual({
      accepted: false,
      reason: "event is not a room message",
    });
    const noRoom: MatrixRoomEvent = { room_id: "", ...textEvent("$e6", "hello") };
    expect(classifyMatrixEvent(noRoom, null)).toEqual({
      accepted: false,
      reason: "event names no room",
    });
    const noText: MatrixRoomEvent = {
      room_id: ROOM,
      event_id: "$e7",
      sender: SENDER,
      type: "m.room.message",
      content: { msgtype: "m.text", body: "   " },
    };
    expect(classifyMatrixEvent(noText, null)).toEqual({
      accepted: false,
      reason: "message carries no text",
    });
    expect(classifyMatrixEvent("not an event", null)).toEqual({
      accepted: false,
      reason: "event is not an object",
    });
  });
});

// ---------------------------------------------------------------------------
// The endpoint rule
// ---------------------------------------------------------------------------

describe("matrix endpoint", () => {
  it("refuses plaintext HTTP unless the relaxed policy allows the host", () => {
    expect(matrixApiBase("http://matrix.example.test").ok).toBe(false);
    expect(matrixApiBase("https://matrix.example.test/")).toEqual({
      ok: true,
      base: "https://matrix.example.test",
    });
    expect(matrixApiBase("http://127.0.0.1:8008", { allowInsecureHttp: true })).toEqual({
      ok: true,
      base: "http://127.0.0.1:8008",
    });
    expect(matrixApiBase("https://user:pw@matrix.example.test").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The sync loop, against the fake homeserver
// ---------------------------------------------------------------------------

/**
 * Run the real transport until `syncCount` polls have happened, then abort.
 *
 * The wait between polls is immediate, so the only clock in these tests is the
 * abort: the loop leaves as soon as its signal is aborted, which keeps every
 * assertion deterministic.
 */
async function runLoop(
  server: FakeHomeserver,
  options: {
    syncCount: number;
    messages: InboundMessage[];
    audit?: MatrixInboundAuditEntry[];
    guard?: ReturnType<typeof durableGuard>;
    order?: string[];
    savedFrom?: string | null;
  },
): Promise<{ saved: string | null; messages: InboundMessage[] }> {
  const controller = new AbortController();
  server.onSync = (index) => {
    if (index + 1 >= options.syncCount) controller.abort();
  };
  const store = tokenStore(options.order);
  if (options.savedFrom) await store.store.save(options.savedFrom);
  const transport = createMatrixInboundPushTransport({
    endpoint: "https://matrix.example.test",
    token: server.token,
    fetchImpl: server.fetch,
    handled: options.guard ?? durableGuard(),
    cursor: store.store,
    wait: async () => {},
    ...(options.audit ? { audit: (entry) => options.audit!.push(entry) } : {}),
  });
  await transport.start(async (message) => {
    options.order?.push("apply");
    options.messages.push(message);
  }, controller.signal);
  return { saved: store.dump(), messages: options.messages };
}

/**
 * Run the real transport until its first failed attempt and one wait, then stop,
 * and return everything that run exposed to a human: the audit records this
 * build emitted, the URLs it asked for, and the bodies the fake answered with.
 *
 * A start can fail in three places — a refused identity, an identity request
 * that never completed, a sync request that never completed — and the access
 * token must be absent from the report of each, so each is a case of its own.
 */
async function runFailingStart(
  server: FakeHomeserver,
  fetchImpl: MatrixFetch,
): Promise<{ audit: MatrixInboundAuditEntry[]; observed: string }> {
  const controller = new AbortController();
  const audit: MatrixInboundAuditEntry[] = [];
  const transport = createMatrixInboundPushTransport({
    endpoint: "https://matrix.example.test",
    token: server.token,
    fetchImpl,
    handled: durableGuard(),
    cursor: tokenStore().store,
    wait: async () => {
      controller.abort();
    },
    audit: (entry) => audit.push(entry),
  });
  await transport.start(async () => {}, controller.signal);
  return {
    audit,
    observed: JSON.stringify({ audit, urls: server.urls, responses: server.responses }),
  };
}

describe("matrix sync loop", () => {
  it("turns one foreign message into exactly one inbound turn and saves the token after it", async () => {
    const server = new FakeHomeserver();
    server.post(ROOM, textEvent("$e1", "/start do the thing"));
    const messages: InboundMessage[] = [];
    const order: string[] = [];
    const { saved } = await runLoop(server, { syncCount: 2, messages, order });

    expect(messages).toEqual([{ messageId: "$e1", chatId: ROOM, text: "/start do the thing" }]);
    // The batch is applied before the token is written: a crash in between
    // replays the batch rather than dropping it.
    expect(order).toEqual(["apply", "save"]);
    expect(saved).toBe("sync-token-1");
    // The second poll asked from the saved token, so nothing was offered twice.
    expect(server.syncRequests).toEqual(["", "sync-token-1"]);
  });

  it("leaves the saved token alone when the batch could not be applied", async () => {
    const server = new FakeHomeserver();
    server.post(ROOM, textEvent("$e1", "/start do the thing"));
    const store = tokenStore();
    const audit: MatrixInboundAuditEntry[] = [];
    const controller = new AbortController();
    server.onSync = (index) => {
      if (index >= 1) controller.abort();
    };
    const transport = createMatrixInboundPushTransport({
      endpoint: "https://matrix.example.test",
      token: server.token,
      fetchImpl: server.fetch,
      handled: durableGuard(),
      cursor: store.store,
      wait: async () => {},
      audit: (entry) => audit.push(entry),
    });
    await transport.start(async () => {
      throw new Error("the turn could not be started");
    }, controller.signal);

    // The batch never landed, so the cursor must not have moved: the next run
    // asks from the old token and is offered the event again.
    expect(store.dump()).toBeNull();
    // Every retry still asks from the start: the token never advanced.
    expect(server.syncRequests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(server.syncRequests)).toEqual(new Set([""]));
    expect(audit).toContainEqual(
      expect.objectContaining({ kind: "process-failed", error: "the turn could not be started" }),
    );
  });

  it("produces no turn for the account's own message", async () => {
    const server = new FakeHomeserver();
    server.post(ROOM, textEvent("$own", "/start from the bot", server.userId));
    const messages: InboundMessage[] = [];
    await runLoop(server, { syncCount: 2, messages });
    expect(messages).toEqual([]);
  });

  it("produces no turn for an encrypted room, and audits why", async () => {
    const server = new FakeHomeserver();
    server.post(ROOM, {
      event_id: "$enc",
      sender: SENDER,
      type: "m.room.encrypted",
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "AwgAEnB..." },
    });
    const messages: InboundMessage[] = [];
    const audit: MatrixInboundAuditEntry[] = [];
    await runLoop(server, { syncCount: 2, messages, audit });

    expect(messages).toEqual([]);
    expect(audit).toContainEqual({
      kind: "encrypted",
      reason: MATRIX_ENCRYPTED_REASON,
      roomId: ROOM,
    });
  });

  it("produces no turn for an event id it has already handled", async () => {
    const server = new FakeHomeserver();
    // One durable guard across both runs, and no saved token: this is a restart
    // whose cursor was lost, so the homeserver offers the same event again and
    // the guard is the only thing that can refuse it.
    server.post(ROOM, textEvent("$same", "/start do the thing"));
    const guard = durableGuard();
    const messages: InboundMessage[] = [];
    const audit: MatrixInboundAuditEntry[] = [];
    await runLoop(server, { syncCount: 2, messages, guard, audit });
    expect(messages).toHaveLength(1);

    const again: InboundMessage[] = [];
    const secondAudit: MatrixInboundAuditEntry[] = [];
    await runLoop(server, { syncCount: 2, messages: again, guard, audit: secondAudit });
    expect(again).toEqual([]);
    expect(secondAudit).toContainEqual({
      kind: "duplicate",
      eventId: ingressMessageKey(ROOM, "$same"),
    });
  });

  it("resumes from the saved token and does not replay the batch", async () => {
    const server = new FakeHomeserver();
    server.post(ROOM, textEvent("$e1", "/start do the thing"));
    const messages: InboundMessage[] = [];
    // A restart that resumes at the token the previous run saved sees nothing.
    await runLoop(server, { syncCount: 2, messages, savedFrom: "sync-token-1" });
    expect(server.syncRequests[0]).toBe("sync-token-1");
    expect(messages).toEqual([]);
  });

  it("does not move or save the token when the homeserver repeats the one it was asked from", async () => {
    const server = new FakeHomeserver();
    // The token is opaque: there is no order to compare, so the only rule is
    // "a different token from the server advances it". A server that answers
    // the token it was asked from must leave both the cursor and the store
    // exactly where they were.
    server.nextBatchOverride = "sync-token-1";
    const order: string[] = [];
    const store = tokenStore(order, "sync-token-1");
    const controller = new AbortController();
    server.onSync = (index) => {
      if (index + 1 >= 2) controller.abort();
    };
    const transport = createMatrixInboundPushTransport({
      endpoint: "https://matrix.example.test",
      token: server.token,
      fetchImpl: server.fetch,
      handled: durableGuard(),
      cursor: store.store,
      wait: async () => {},
    });

    await transport.start(async () => {}, controller.signal);

    expect(server.syncRequests).toEqual(["sync-token-1", "sync-token-1"]);
    expect(order).toEqual([]);
    expect(store.dump()).toBe("sync-token-1");
  });

  it("never puts the access token in an audit record or an error when the homeserver refuses the identity", async () => {
    const server = new FakeHomeserver();
    server.whoamiStatus = 401;
    const { audit, observed } = await runFailingStart(server, server.fetch);

    expect(audit).toContainEqual({
      kind: "identity-failed",
      error: "matrix answered HTTP 401 for the identity lookup",
    });
    expect(observed).not.toContain(server.token);
  });

  it("never puts the access token in an audit record or an error when the identity request fails", async () => {
    const server = new FakeHomeserver();
    // A transport failure rather than an answer: the branch a refusal by status
    // never reaches, and the one that builds its own detail string.
    const failing = (async (input: string, init: RequestInit = {}) => {
      if (String(input).includes("/account/whoami")) throw new Error("socket hang up");
      return server.fetch(input, init);
    }) as unknown as MatrixFetch;
    const { audit, observed } = await runFailingStart(server, failing);

    expect(audit).toContainEqual({
      kind: "identity-failed",
      error: "the identity lookup failed",
    });
    expect(observed).not.toContain(server.token);
  });

  it("never puts the access token in an audit record or an error when the sync request fails", async () => {
    const server = new FakeHomeserver();
    const failing = (async (input: string, init: RequestInit = {}) => {
      if (String(input).includes("/sync")) throw new Error("socket hang up");
      return server.fetch(input, init);
    }) as unknown as MatrixFetch;
    const { audit, observed } = await runFailingStart(server, failing);

    expect(audit).toContainEqual({ kind: "connect-failed", error: "the sync request failed" });
    expect(observed).not.toContain(server.token);
  });
});

// ---------------------------------------------------------------------------
// The send path
// ---------------------------------------------------------------------------

describe("matrix send", () => {
  const options = (server: FakeHomeserver) => ({
    endpoint: "https://matrix.example.test",
    token: server.token,
    fetchImpl: server.fetch,
    wait: async () => {},
  });

  it("puts one m.text event per chunk, at the declared limit and in order", async () => {
    const server = new FakeHomeserver();
    const sender = createMatrixSender(options(server));
    const text = `${"a line of the reply\n".repeat(Math.ceil(MATRIX_MESSAGE_LIMIT / 10))}tail`;
    const result = await sender.send(ROOM, text);

    expect(result.ok).toBe(true);
    expect(server.posts.length).toBeGreaterThan(1);
    for (const post of server.posts) expect(post.body.length).toBeLessThanOrEqual(MATRIX_MESSAGE_LIMIT);
    expect(server.posts.map((post) => post.body).join("")).toBe(text);
    expect(server.posts.every((post) => post.roomId === ROOM)).toBe(true);
    // The room id is percent-encoded, because a Matrix room id contains a colon
    // and the id is a path segment rather than a query value.
    expect(server.posts[0]?.txnId.startsWith(MATRIX_TXN_ID_PREFIX)).toBe(true);
  });

  it("draws a fresh transaction id per attempt, so no attempt can be folded into another", async () => {
    const server = new FakeHomeserver();
    server.sendStatusOnce = 429;
    const sender = createMatrixSender(options(server));
    const result = await sender.send(ROOM, "hello");

    expect(result.ok).toBe(true);
    // Two attempts reached the server at different transaction ids, so the
    // retry could not be answered as a replay of the request that was refused.
    expect(server.attempts).toHaveLength(2);
    expect(server.attempts[0]).not.toBe(server.attempts[1]);
    expect(server.posts).toHaveLength(1);

    const second = await sender.send(ROOM, "hello");
    expect(second.ok).toBe(true);
    expect(server.posts).toHaveLength(2);
    // Two sends of identical text are two different transactions.
    expect(server.posts[1]?.txnId).not.toBe(server.posts[0]?.txnId);
  });

  it("refuses a redirect instead of following it, and never reports the token", async () => {
    const server = new FakeHomeserver();
    const redirecting = (async () =>
      ({
        status: 302,
        ok: false,
        headers: new Headers({ location: "https://evil.test/" }),
        json: async () => ({}),
      }) as unknown as Response) as unknown as MatrixFetch;
    const sender = createMatrixSender({
      endpoint: "https://matrix.example.test",
      token: "matrix-SECRET-token",
      fetchImpl: redirecting,
      wait: async () => {},
    });
    const result = await sender.send(ROOM, "hello");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("redirect");
      expect(result.error).not.toContain("matrix-SECRET-token");
    }
    expect(server.posts).toEqual([]);
  });

  it("reports a transport failure as unknown rather than retrying it", async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new Error("socket hang up");
    }) as unknown as MatrixFetch;
    const sender = createMatrixSender({
      endpoint: "https://matrix.example.test",
      token: "matrix-SECRET-token",
      fetchImpl: failing,
      wait: async () => {},
    });
    const result = await sender.send(ROOM, "hello");
    expect(result.ok).toBe(false);
    // A single attempt: retrying an unknown outcome with a fresh transaction id
    // could post the reply twice.
    expect(calls).toBe(1);
    if (!result.ok) expect(result.error).not.toContain("matrix-SECRET-token");
  });
});

describe("matrix identity", () => {
  it("reads the account's own user id and refuses a redirect", async () => {
    const server = new FakeHomeserver();
    const lookup = createMatrixIdentityLookup({
      endpoint: "https://matrix.example.test",
      fetchImpl: server.fetch,
    });
    expect(await lookup(server.token)).toEqual({ ok: true, userId: server.userId });

    const redirecting = (async () =>
      ({ status: 301, ok: false, headers: new Headers(), json: async () => ({}) }) as unknown as Response) as unknown as MatrixFetch;
    const refused = createMatrixIdentityLookup({
      endpoint: "https://matrix.example.test",
      fetchImpl: redirecting,
    });
    const outcome = await refused("matrix-SECRET-token");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).not.toContain("matrix-SECRET-token");
  });
});

describe("matrix adapter seams", () => {
  it("declares a limit, a poll and a deliverer", () => {
    const server = new FakeHomeserver();
    const adapter = createMatrixIngressAdapter({
      endpoint: "https://matrix.example.test",
      token: server.token,
      fetchImpl: server.fetch,
      ownUserId: server.userId,
    });
    expect(adapter.platform).toBe("matrix");
    expect(adapter.kind).toBe("poll");
    expect(adapter.messageLimit).toBe(MATRIX_MESSAGE_LIMIT);
    expect(typeof adapter.deliver).toBe("function");
  });
});
