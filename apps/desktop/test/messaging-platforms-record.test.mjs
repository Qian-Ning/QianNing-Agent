/**
 * The webhook receiver's panel record, as pure functions.
 *
 * The panel itself is exercised end to end elsewhere; what is asserted here is
 * the part that decides what gets written and what the three state dimensions
 * say about it — the two places a wrong answer is silent, because the form still
 * looks right after it saves something the host cannot start.
 *
 * The catalogue module is TypeScript and imports only types, so Node's type
 * stripping loads it directly; running it here keeps these assertions in the
 * package's own `node --test` gate rather than in a runner nothing invokes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MESSAGING_GATEWAY_OFF,
  UNSUPPORTED_MESSAGING_PLATFORMS,
  WEBHOOK_RECEIVER_DEFAULT_PORT,
  WEBHOOK_RECEIVER_FORMAT,
  WEBHOOK_RECEIVER_PATH,
  WEBHOOK_RECEIVER_SECRET_REF,
  WEBHOOK_RECEIVER_VERSION,
  buildSectionWrite,
  canSave,
  deriveChannelState,
  draftFrom,
  draftMissing,
  isOwnRecord,
  missingFromRecord,
  platformById,
} from "../src/lib/messaging-platforms.ts";

const platform = platformById("webhooks");

// Keyed by the secret's `ref`, which is what the panel reads from the store.
const SECRETS = { [WEBHOOK_RECEIVER_SECRET_REF]: true };

const draft = (overrides = {}) => ({ ...draftFrom(platform, null), ...overrides });

const record = (overrides = {}) => ({
  ...buildSectionWrite(platform, draft({ sessionId: "session-1" }), null),
  ...overrides,
});

test("the webhooks entry is offered as supported, and not as a requirement class", () => {
  assert.equal(platform.support, "supported");
  assert.equal(
    UNSUPPORTED_MESSAGING_PLATFORMS.some((entry) => entry.id === "webhooks"),
    false,
  );
  assert.equal(platform.section, "messagingWebhookReceiver");
  assert.equal(platform.format, WEBHOOK_RECEIVER_FORMAT);
  assert.equal(platform.version, WEBHOOK_RECEIVER_VERSION);
});

test("it asks for no endpoint and no destination, because the URL is its own", () => {
  assert.equal(platform.defaultEndpoint, "");
  assert.equal(platform.fields.some((field) => field.id === "endpoint"), false);
  assert.equal(platform.fields.some((field) => field.id === "destination"), false);
});

test("a save writes the surface, the secret ref, the fixed path and the binding", () => {
  const written = buildSectionWrite(platform, draft({ sessionId: "session-1" }), null);
  assert.equal(written.format, WEBHOOK_RECEIVER_FORMAT);
  assert.equal(written.version, WEBHOOK_RECEIVER_VERSION);
  assert.equal(written.enabled, true);
  assert.equal(written.port, WEBHOOK_RECEIVER_DEFAULT_PORT);
  assert.equal(written.bindAddress, "127.0.0.1");
  assert.equal(written.allowNonLoopback, false);
  assert.equal(written.secretRef, WEBHOOK_RECEIVER_SECRET_REF);
  assert.equal(written.path, WEBHOOK_RECEIVER_PATH);
  assert.deepEqual(written.inbound, { sessionId: "session-1" });
});

test("a wider bind address is stored as typed but never auto-permitted", () => {
  const written = buildSectionWrite(platform, draft({ bindAddress: "0.0.0.0" }), null);
  assert.equal(written.bindAddress, "0.0.0.0");
  assert.equal(written.allowNonLoopback, false);
});

test("an edit keeps the record's other inbound keys and drops only a cleared binding", () => {
  const existing = {
    ...record(),
    port: 9000,
    inbound: { sessionId: "session-1", permissionMode: "ask" },
  };

  const cleared = buildSectionWrite(platform, draft({ sessionId: "", port: "9000" }), existing);
  assert.equal(cleared.port, 9000);
  assert.deepEqual(cleared.inbound, { permissionMode: "ask" });

  const kept = buildSectionWrite(platform, draft({ sessionId: "session-2" }), existing);
  assert.deepEqual(kept.inbound, { sessionId: "session-2", permissionMode: "ask" });
});

test("an edit carries the runtime's delivery guard instead of clearing it", () => {
  // The receiver writes `handledEventIds` into this same section. Rebuilding the
  // record from the form alone would erase it, and a replayed delivery would run
  // a second turn after any edit to the port.
  const existing = { ...record(), handledEventIds: ["generic:delivery-1", "generic:delivery-2"] };

  const saved = buildSectionWrite(platform, draft({ sessionId: "session-1", port: "9100" }), existing);
  assert.equal(saved.port, 9100);
  assert.deepEqual(saved.handledEventIds, ["generic:delivery-1", "generic:delivery-2"]);
});

test("a port outside the TCP range falls back to the receiver's default", () => {
  for (const port of ["", "0", "-1", "70000", "eighty"]) {
    const written = buildSectionWrite(platform, draft({ sessionId: "s", port }), null);
    assert.equal(written.port, WEBHOOK_RECEIVER_DEFAULT_PORT, `port ${JSON.stringify(port)}`);
  }
});

test("the form opens at the receiver's defaults, with only the binding empty", () => {
  const opening = draftFrom(platform, null);
  assert.equal(opening.port, String(WEBHOOK_RECEIVER_DEFAULT_PORT));
  assert.equal(opening.bindAddress, "127.0.0.1");
  assert.equal(opening.sessionId, "");
  assert.deepEqual(opening.secrets, {});
  assert.deepEqual(draftMissing(platform, opening), ["sessionId"]);
  assert.equal(canSave(platform, opening), false);
});

test("the form reads a stored binding and port back", () => {
  const opening = draftFrom(platform, { ...record(), port: 9100, inbound: { sessionId: "session-9" } });
  assert.equal(opening.port, "9100");
  assert.equal(opening.sessionId, "session-9");
  // No credential is ever read back: the store holds it, the form does not.
  assert.deepEqual(opening.secrets, {});
});

test("a save is allowed once the port, the address and the session are there", () => {
  assert.equal(canSave(platform, draft({ sessionId: "session-1" })), true);
  assert.deepEqual(draftMissing(platform, draft({ sessionId: "session-1", port: "0" })), ["port"]);
  assert.deepEqual(draftMissing(platform, draft({ sessionId: "   " })), ["sessionId"]);
});

test("a complete record reads as enabled and complete, with no invented link", () => {
  const own = record();
  assert.equal(isOwnRecord(platform, own), true);
  assert.deepEqual(missingFromRecord(platform, own, SECRETS), []);

  const state = deriveChannelState(platform, own, SECRETS, MESSAGING_GATEWAY_OFF);
  assert.equal(state.enabled, "on");
  assert.equal(state.setup, "complete");
});

test("a record with no binding names the binding, and only the binding", () => {
  const unbound = record({ inbound: {} });
  assert.deepEqual(missingFromRecord(platform, unbound, SECRETS), ["sessionId"]);
  assert.equal(
    deriveChannelState(platform, unbound, SECRETS, MESSAGING_GATEWAY_OFF).setup,
    "incomplete",
  );
});

test("a record of another build reads as unreadable rather than incomplete", () => {
  const foreign = record({ version: WEBHOOK_RECEIVER_VERSION + 1 });
  assert.equal(isOwnRecord(platform, foreign), false);
  assert.equal(
    deriveChannelState(platform, foreign, SECRETS, MESSAGING_GATEWAY_OFF).enabled,
    "unreadable",
  );
});

test("the gateway flag is read from the receiver's own channel key", () => {
  const own = record();
  assert.equal(
    deriveChannelState(platform, own, SECRETS, {
      ...MESSAGING_GATEWAY_OFF,
      booted: true,
      webhookReceiver: true,
    }).gateway,
    "running",
  );
  assert.equal(
    deriveChannelState(platform, own, SECRETS, { ...MESSAGING_GATEWAY_OFF, booted: true }).gateway,
    "stopped",
  );
});
