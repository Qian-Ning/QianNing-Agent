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
  type IngressDeliveryResult,
  type IngressMessage,
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
 * A push channel's reconnect probe: one connection, then a second one, so the
 * suite can prove a reconnect does not create a second subscription and does
 * not re-deliver a message the durable guard already knows.
 */
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

export type IngressConformanceFixture = {
  /** The adapter under test. */
  adapter: MessagingIngressAdapter;
  /** One raw event from another person, and the shape it must become. */
  foreign(): IngressConformanceEvent;
  /** One raw event the bot itself produced, where the platform delivers it. */
  own?(): unknown;
  /** A push channel's live reconnect probe. */
  reconnect?(): Promise<IngressReconnectProbe>;
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
        const text = longReply(limit);
        const chunks = chunkIngressText(text, limit);
        assert.ok(chunks.length > 1, "the fixture reply must cross the limit");
        for (const chunk of chunks) {
          assert.ok(chunk.length <= limit, `a chunk of ${chunk.length} exceeds the limit ${limit}`);
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
        for (const chunk of delivery.chunks) {
          assert.ok(
            chunk.length <= limit,
            `a delivered chunk of ${chunk.length} exceeds the limit ${limit}`,
          );
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

  return scenarios;
}
