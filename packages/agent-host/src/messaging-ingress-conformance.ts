/**
 * The messaging ingress conformance suite.
 *
 * Every channel that wants to be admissible as a messaging ingress must pass
 * these tests. They are written once, against the adapter contract, so a new
 * platform is added by writing the adapter and one fixture — not by copying
 * another platform's test file, and not by re-deciding what "duplicate" or
 * "own message" means.
 *
 * The suite asserts the guarantees the shared layer is responsible for, through
 * the adapter's own seams:
 *
 * 1. a foreign message produces exactly one inbound turn;
 * 2. the platform's own message produces none;
 * 3. a redelivered message is not delivered twice;
 * 4. a reconnect neither duplicates the subscription nor re-delivers;
 * 5. the credential never reaches an audit record or an error;
 * 6. replies chunk at the declared limit, in order — and where the adapter owns
 *    a deliverer, leave through it chunked, at the limit and in order;
 * 7. a pull channel applies a polled batch once and advances its cursor once,
 *    and a failed poll neither applies nor moves it.
 *
 * Each fixture supplies only what is platform-specific: one raw event from
 * another person, one the bot itself produced, the channel's credential-refusal
 * path, and (for a push channel) a real connection the suite can feed and drop.
 *
 * The scenarios are returned rather than registered, so this module carries no
 * test-runner dependency: the suite file loops over them with `it`.
 */

import assert from "node:assert/strict";

import {
  chunkIngressText,
  IngressGate,
  type IngressCursorStore,
  ingressUtf8Bytes,
  type IngressDeliveryResult,
  type IngressMessage,
  type IngressNormalise,
  type IngressPollResult,
  type MessagingIngressAdapter,
} from "./messaging-ingress.js";
import { PollingIngressTransport } from "./messaging-ingress-polling.js";

/** One raw platform event and the shared shape it must project onto. */
export type IngressConformanceEvent = {
  /** What the adapter's normalise takes: the event, not the wire envelope. */
  raw: unknown;
  /**
   * What the wire carries. A socket platform delivers an envelope around the
   * event (Slack's `events_api`, Mattermost's `posted`), so the live connection
   * is fed this and the projection is asserted on `raw`. Defaults to `raw`.
   */
  frame?: unknown;
  /** The message the shared inbound shape must carry. */
  expected: IngressMessage;
};

/** One live connection the suite can feed, drop and replace. */
export type IngressConformanceConnection = {
  /** Deliver one raw event to this connection and let the client finish with it. */
  deliver(raw: unknown): Promise<void>;
  /** The platform closes the connection abruptly. */
  drop(): void;
};

/**
 * The raw-socket pair a line protocol's suite needs: two ends of one in-process
 * connection, no OS socket and no network.
 *
 * A websocket channel can be driven with a frame emitter because its transport
 * already frames for it. A line protocol — IRC is the first — has to frame
 * *bytes* itself, so a fixture that only pushed whole lines would skip the
 * splitter that is the channel's own work. Both ends here are byte sinks: what
 * one end writes arrives at the other's data handler verbatim, so a suite can
 * send half a line, then the rest, and prove the client reassembled it.
 *
 * The shape is the structural subset every raw-socket client in the shared layer
 * uses (`write`/`end`/`onData`/`onClose`/`onError`), so the next line protocol
 * reuses this rather than writing a third fake.
 */
export type IngressRawSocketEnd = {
  /** Write bytes; they arrive at the other end's data handler. */
  write(text: string): void;
  /** Close this end, which closes the other end with a close event. */
  end(): void;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
  onError(handler: (error: unknown) => void): void;
};

export type IngressRawSocketPair = {
  /** The end the client attaches; it is the `IrcRawSocket` the factory returns. */
  client: IngressRawSocketEnd;
  /** The end the suite plays the server on. */
  server: IngressRawSocketEnd;
  /** The platform's transport failure, as the client's error handler sees it. */
  fail(error: unknown): void;
};

/** Build one in-process byte connection: what one end writes the other reads. */
export function createIngressRawSocketPair(): IngressRawSocketPair {
  type Side = {
    data: Array<(chunk: string) => void>;
    close: Array<(reason?: string) => void>;
    error: Array<(error: unknown) => void>;
    peer: Side | null;
    closed: boolean;
  };
  const side = (): Side => ({ data: [], close: [], error: [], peer: null, closed: false });
  const left = side();
  const right = side();
  left.peer = right;
  right.peer = left;
  const endpoint = (self: Side): IngressRawSocketEnd => ({
    write(text) {
      const peer = self.peer;
      if (!peer || self.closed) return;
      for (const handler of peer.data) handler(text);
    },
    end() {
      if (self.closed) return;
      self.closed = true;
      for (const handler of self.peer!.close) handler("the connection ended");
    },
    onData(handler) {
      self.data.push(handler);
    },
    onClose(handler) {
      self.close.push(handler);
    },
    onError(handler) {
      self.error.push(handler);
    },
  });
  return {
    client: endpoint(left),
    server: endpoint(right),
    fail(error) {
      for (const handler of left.error) handler(error);
    },
  };
}
export type IngressReconnectProbe = {
  first: IngressConformanceConnection;
  /** Open the second connection (the reconnect), reusing the same guard. */
  reconnect(): Promise<IngressConformanceConnection>;
  /** Every message the suite's handler has been given, across both connections. */
  messages(): IngressMessage[];
};

/** What a fixture with a credential reports from a start it must refuse. */
export type IngressCredentialRefusal = {
  /** The credential that must never appear in a record or an error. */
  token: string;
  /** Every audit record and error message the refused start produced, stringified. */
  observed: string;
};

/**
 * A callback channel's half of the receiver scenarios.
 *
 * The receiver is the real one ([`IngressWebhookReceiver`]), listening on a
 * loopback port the test allocated by asking for port `0`, and signing with the
 * generic HMAC scheme unless the platform's fixture proves its own. The suite
 * supplies the assertions, so the ten callback platforms share one set of
 * guarantees rather than ten copies of "did the signature check work".
 *
 * `settled` exists because the receiver answers before the turn runs: the
 * response is not the turn's completion, and a scenario that checked
 * `messages()` right after `deliver` would be asserting the opposite of the
 * ordering this receiver is built for.
 */
export type IngressWebhookFixture = {
  /** The platform's own path segment under `/webhooks/`. */
  platform: string;
  /** One signed POST, as the platform would send it. */
  deliver(
    raw: unknown,
    options?: { timestamp?: number; deliveryId?: string },
  ): Promise<{ status: number }>;
  /** Let the accepted delivery's turn settle, without waiting on a wall clock. */
  settled(): Promise<void>;
  /** Every message this handle's receiver has routed, since the handle opened. */
  messages(): IngressMessage[];
};

/**
 * A long-poll channel's own half of the cursor scenarios.
 *
 * A long poll is a pull like Telegram's, but its cursor is an opaque token with
 * no order (Matrix's `next_batch`), so the count-shaped scenarios below cannot
 * drive it. The fixture supplies its poll — against whatever stand-in for the
 * platform it owns — and the adapter's projection; the suite supplies the store,
 * the transport and the assertions, so every future token-cursor channel is
 * covered by the same three guarantees without writing them again.
 */
export type IngressLongPollFixture = {
  /** One poll from `cursor`; a failure is reported in the result. */
  poll: (cursor: string, signal?: AbortSignal) => Promise<IngressPollResult<string>>;
  /** The adapter's own projection, the one the live loop uses. */
  normalise: IngressNormalise;
};

export type IngressConformanceFixture = {
  /** The adapter under test. */
  adapter: MessagingIngressAdapter;
  /** One raw event from another person, and the shape it must become. */
  foreign(): IngressConformanceEvent;
  /** One raw event the bot itself produced, where the platform delivers it. */
  own?(): unknown;
  /** A push channel's live reconnect probe. */
  reconnect?(): Promise<IngressReconnectProbe>;
  /** A long-poll channel's opaque-token half: its poll and its projection. */
  longPoll?(): IngressLongPollFixture;
  /** A callback channel's live receiver, where the channel is served by one. */
  webhook?(): IngressWebhookFixture;
  /**
   * Release anything the fixture started that outlives one scenario — a live
   * receiver, a socket. The suite file calls it after the group.
   */
  dispose?(): Promise<void>;
  /** A refused credential, where the channel holds one. */
  refusedCredential?(): Promise<IngressCredentialRefusal>;
  /**
   * What the adapter's `deliver` seam handed the platform, where the channel
   * owns a send path. Absent where replies leave through another process.
   */
  deliver?(text: string): { chatId: string; chunks: string[]; result: Promise<IngressDeliveryResult> };
};

/** A named scenario the suite file registers with `it`. */
export type IngressConformanceScenario = { name: string; run: () => Promise<void> };

/** An in-memory restart-durable guard for the suite's gate. */
function memoryGuard(): { has(key: string): Promise<boolean>; record(key: string): Promise<void> } {
  const seen = new Set<string>();
  return {
    has: async (key) => seen.has(key),
    record: async (key) => {
      seen.add(key);
    },
  };
}

/**
 * Drive one key through the shared gate the way a client does, and collect what
 * reached the routing path.
 */
async function throughGate(
  adapter: MessagingIngressAdapter,
  raw: unknown,
  guard = memoryGuard(),
): Promise<IngressMessage[]> {
  const messages: IngressMessage[] = [];
  const gate = new IngressGate({
    handled: guard,
    onMessage: async (message) => {
      messages.push(message);
    },
  });
  const normalisation = adapter.normalise(raw);
  if (normalisation.kind === "message") {
    await gate.ingest(normalisation.message, normalisation.key);
  }
  return messages;
}

/** A reply long enough to cross every channel's limit many times over. */
function longReply(limit: number): string {
  const line = "a reply line that is long enough to matter, with a newline at the end\n";
  const repeat = Math.ceil((limit * 2.5) / line.length);
  return `${line.repeat(repeat)}trailing words without a final newline`;
}

/**
 * The scenarios every adapter must pass.
 *
 * A fixture is the only platform-specific input: a raw foreign event, a raw own
 * event, and — where the channel has one — the credential-refusal path and a
 * live reconnect probe.
 */
export function ingressConformanceScenarios(
  fixture: IngressConformanceFixture,
): IngressConformanceScenario[] {
  const { adapter } = fixture;
  const scenarios: IngressConformanceScenario[] = [
    {
      name: "a foreign message produces exactly one inbound turn",
      async run() {
        const { raw, expected } = fixture.foreign();
        const normalisation = adapter.normalise(raw);
        assert.equal(normalisation.kind, "message", "the foreign message must be accepted");
        if (normalisation.kind !== "message") return;
        assert.deepEqual(normalisation.message, expected);
        assert.ok(normalisation.key.length > 0, "the adapter must supply a replay key");
        const messages = await throughGate(adapter, raw);
        assert.deepEqual(messages, [expected]);
      },
    },
    {
      name: "a redelivered message is not delivered twice",
      async run() {
        const { raw } = fixture.foreign();
        const guard = memoryGuard();
        const first = await throughGate(adapter, raw, guard);
        const second = await throughGate(adapter, raw, guard);
        assert.equal(first.length, 1);
        assert.equal(second.length, 0, "a redelivery must be recognised by the durable guard");
      },
    },
    {
      name: "replies chunk at the declared limit, in order",
      async run() {
        const limit = adapter.messageLimit;
        assert.ok(Number.isFinite(limit) && limit > 0, "the adapter must declare its message limit");
        const unit = adapter.messageLimitUnit ?? "characters";
        const text = longReply(limit);
        const chunks = chunkIngressText(text, limit, unit);
        assert.ok(chunks.length > 1, "the fixture reply must cross the limit");
        for (const chunk of chunks) {
          const size = unit === "bytes" ? ingressUtf8Bytes(chunk) : chunk.length;
          assert.ok(size <= limit, `a chunk of ${size} exceeds the limit ${limit} ${unit}`);
        }
        assert.equal(chunks.join(""), text, "joining the chunks must return the original text");
      },
    },
  ];

  if (fixture.own) {
    const own = fixture.own.bind(fixture);
    scenarios.push({
      name: "its own message produces none",
      async run() {
        const normalisation = adapter.normalise(own());
        assert.equal(normalisation.kind, "filtered", "the bot's own message must be filtered");
        const messages = await throughGate(adapter, own());
        assert.deepEqual(messages, [], "an own message must reach no handler");
      },
    });
  }

  if (fixture.reconnect) {
    scenarios.push({
      name: "a reconnect duplicates neither the subscription nor a message",
      async run() {
        const probe = await fixture.reconnect!();
        const event = fixture.foreign();
        const frame = event.frame ?? event.raw;
        await probe.first.deliver(frame);
        assert.equal(probe.messages().length, 1, "the first connection must deliver once");
        probe.first.drop();
        // A frame the platform re-sends down the dead connection must not act.
        await probe.first.deliver(frame);
        assert.equal(probe.messages().length, 1, "a dropped connection must not deliver again");
        const second = await probe.reconnect();
        await second.deliver(frame);
        assert.equal(
          probe.messages().length,
          1,
          "a reconnect must not re-deliver a message the guard already knows",
        );
      },
    });
  }

  if (fixture.deliver) {
    scenarios.push({
      name: "a reply leaves through the adapter's deliverer, chunked and in order",
      async run() {
        assert.ok(adapter.deliver, "the fixture declares a deliverer the adapter must carry");
        const limit = adapter.messageLimit;
        const text = longReply(limit);
        const delivery = fixture.deliver!(text);
        const result = await delivery.result;
        assert.equal(result.ok, true, "the delivery must succeed");
        assert.ok(delivery.chunks.length > 1, "the fixture reply must cross the limit");
        const unit = adapter.messageLimitUnit ?? "characters";
        for (const chunk of delivery.chunks) {
          const size = unit === "bytes" ? ingressUtf8Bytes(chunk) : chunk.length;
          assert.ok(size <= limit, `a delivered chunk of ${size} exceeds the limit ${limit} ${unit}`);
        }
        assert.equal(
          delivery.chunks.join(""),
          text,
          "the delivered chunks must join back into the reply, in order",
        );
      },
    });
  }

  if (fixture.refusedCredential) {
    scenarios.push({
      name: "the credential never reaches an audit record or an error",
      async run() {
        const refusal = await fixture.refusedCredential!();
        assert.equal(
          refusal.observed.includes(refusal.token),
          false,
          "the token appeared in a record or an error",
        );
      },
    });
  }

  if (adapter.kind === "poll") {
    const pollAdapter = adapter;
    scenarios.push({
      name: "a polled batch is applied once and advances the cursor once",
      async run() {
        const { raw, expected } = fixture.foreign();
        let batch = 0;
        const transport = new PollingIngressTransport<unknown>({
          poll: async (cursor) => {
            batch += 1;
            // The platform offers the batch once, then nothing at the new
            // position — a redelivery of the same batch is what a wrongly kept
            // cursor would look like.
            return batch === 1
              ? { ok: true, events: [raw], nextCursor: cursor + 1 }
              : { ok: true, events: [], nextCursor: cursor };
          },
          normalise: pollAdapter.normalise,
        });
        const messages: IngressMessage[] = [];
        const apply = async (message: IngressMessage) => {
          messages.push(message);
        };
        await transport.pollOnce(apply);
        assert.deepEqual(messages, [expected], "the batch must be applied exactly once");
        assert.equal(transport.nextCursor, 1, "the cursor must advance to the batch's position");
        await transport.pollOnce(apply);
        assert.equal(messages.length, 1, "the next poll must not re-apply the batch");
      },
    });
    scenarios.push({
      name: "a failed poll advances no cursor and reports the platform's back-off",
      async run() {
        const transport = new PollingIngressTransport<unknown>({
          poll: async () => ({ ok: false, error: "the platform is unavailable", retryAfterMs: 7_000 }),
          normalise: pollAdapter.normalise,
        });
        const messages: IngressMessage[] = [];
        const outcome = await transport.pollOnce(async (message) => {
          messages.push(message);
        });
        assert.equal(outcome.polled, false);
        assert.equal(outcome.retryAfterMs, 7_000);
        assert.equal(transport.nextCursor, 0, "a failed poll must not move the cursor");
        assert.deepEqual(messages, []);
      },
    });
  }

  if (fixture.longPoll) {
    const longPoll = fixture.longPoll.bind(fixture);
    /**
     * One transport over `store`, built the way a channel builds it: the token
     * starts empty and advances only when the server answers a different one.
     *
     * The scenarios drive `run`, not `pollOnce`, because loading the stored
     * token is the loop's first act — that is what a restart is. `stopAfter`
     * aborts the loop once that many polls have been waited out, so each run is
     * one or two iterations and no test sleeps.
     */
    const build = (
      store: IngressCursorStore<string>,
      stopAfter: number,
    ): { run: PollingIngressTransport<unknown, string>["run"]; transport: PollingIngressTransport<unknown, string> } => {
      const source = longPoll();
      const controller = new AbortController();
      let polls = 0;
      const poll = async (cursor: string, signal?: AbortSignal) => {
        const result = await source.poll(cursor, signal);
        polls += 1;
        return result;
      };
      const transport = new PollingIngressTransport<unknown, string>({
        poll,
        normalise: source.normalise,
        cursor: store,
        initialCursor: "",
        nextIsAhead: (next, current) => next !== current,
        wait: async () => {
          if (polls >= stopAfter) controller.abort();
        },
      });
      return {
        transport,
        run: (apply) => transport.run(apply, controller.signal),
      };
    };
    const memoryStore = (
      order: string[] = [],
    ): { store: IngressCursorStore<string>; saved: string[] } => {
      const saved: string[] = [];
      return {
        saved,
        store: {
          load: async () => (saved.length > 0 ? saved[saved.length - 1]! : null),
          save: async (token) => {
            order.push("save");
            saved.push(token);
          },
        },
      };
    };

    scenarios.push({
      name: "a sync batch is applied once and its token is saved after the batch",
      async run() {
        const { expected } = fixture.foreign();
        const order: string[] = [];
        const { store, saved } = memoryStore(order);
        const { transport, run } = build(store, 1);
        const applied: IngressMessage[] = [];
        await run(async (message) => {
          order.push("apply");
          applied.push(message);
        });
        assert.deepEqual(applied, [expected], "the batch must be applied exactly once");
        assert.deepEqual(order, ["apply", "save"], "the token must be saved after the batch");
        assert.equal(saved.length, 1, "the token must be saved once");
        assert.equal(transport.nextCursor, saved[0], "the cursor must be the token that was saved");
      },
    });

    scenarios.push({
      name: "a restart resumes from the saved token and replays nothing",
      async run() {
        const { store, saved } = memoryStore();
        const first = build(store, 1);
        const before: IngressMessage[] = [];
        await first.run(async (message) => {
          before.push(message);
        });
        assert.equal(before.length, 1);
        assert.equal(saved.length, 1);
        // A second transport over the same store is a restart: the token it
        // loads is the one the first run saved, so the platform is asked from
        // there and the batch is not offered again.
        const second = build(store, 1);
        const after: IngressMessage[] = [];
        await second.run(async (message) => {
          after.push(message);
        });
        assert.equal(second.transport.nextCursor, saved[0], "the restart must resume at the saved token");
        assert.deepEqual(after, [], "a restart must not replay a batch it already applied");
        assert.equal(saved.length, 1, "a restart with nothing new must save nothing");
      },
    });

    scenarios.push({
      name: "a batch whose apply throws saves no token",
      async run() {
        const { store, saved } = memoryStore();
        const { run } = build(store, 1);
        await run(async () => {
          throw new Error("the routing path failed");
        });
        assert.deepEqual(saved, [], "a batch that was not applied must not advance the token");
      },
    });
  }

  if (fixture.webhook) {
    const webhook = fixture.webhook.bind(fixture);
    scenarios.push({
      name: "a signed delivery through the receiver produces exactly one turn",
      async run() {
        const { raw, expected } = fixture.foreign();
        const delivery = webhook();
        const response = await delivery.deliver(raw, { deliveryId: "conformance-once" });
        assert.equal(response.status, 200, "an authentic delivery must be acknowledged");
        await delivery.settled();
        assert.deepEqual(delivery.messages(), [expected]);
      },
    });
    scenarios.push({
      name: "a replayed delivery id produces no second turn",
      async run() {
        const { raw } = fixture.foreign();
        const delivery = webhook();
        const first = await delivery.deliver(raw, { deliveryId: "conformance-replay" });
        await delivery.settled();
        const second = await delivery.deliver(raw, { deliveryId: "conformance-replay" });
        await delivery.settled();
        assert.equal(first.status, 200);
        assert.equal(
          second.status,
          200,
          "a replay is acknowledged, not refused: the platform must stop retrying",
        );
        assert.equal(
          delivery.messages().length,
          1,
          "a replayed delivery id must not become a second turn",
        );
      },
    });
    scenarios.push({
      name: "a stale timestamp is rejected and becomes no turn",
      async run() {
        const { raw } = fixture.foreign();
        const delivery = webhook();
        // A day old is outside every sane window; a fixture whose receiver
        // accepted it would have a window of a day or more.
        const stale = Math.floor(Date.now() / 1000) - 86_400;
        const response = await delivery.deliver(raw, {
          timestamp: stale,
          deliveryId: "conformance-stale",
        });
        await delivery.settled();
        assert.equal(response.status, 401, "a timestamp outside the window must be refused");
        assert.deepEqual(delivery.messages(), []);
      },
    });
  }

  return scenarios;
}
