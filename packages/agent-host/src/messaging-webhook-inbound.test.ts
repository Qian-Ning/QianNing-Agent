import { describe, expect, it } from "vitest";

import { ingressMessageKey } from "./messaging-ingress.js";
import { signIngressWebhookBody } from "./messaging-ingress-verify.js";
import {
  createGenericWebhookAdapter,
  createWebhookInboundVerifier,
  WEBHOOK_INBOUND_DEFAULT_CHAT,
  WEBHOOK_INBOUND_MESSAGE_LIMIT,
  WEBHOOK_INBOUND_PLATFORM,
} from "./messaging-webhook-inbound.js";

const adapter = createGenericWebhookAdapter();

describe("the generic webhook adapter", () => {
  it("declares itself a webhook channel with the build's message limit", () => {
    expect(adapter.kind).toBe("webhook");
    expect(adapter.platform).toBe(WEBHOOK_INBOUND_PLATFORM);
    expect(adapter.messageLimit).toBe(WEBHOOK_INBOUND_MESSAGE_LIMIT);
  });

  it("projects a plain text body onto the shared shape", () => {
    const result = adapter.normalise({ text: "deploy finished", id: "evt-1" });
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message.text).toBe("deploy finished");
    expect(result.message.messageId).toBe("evt-1");
    expect(result.message.chatId).toBe(WEBHOOK_INBOUND_DEFAULT_CHAT);
    expect(result.key).toBe(ingressMessageKey(WEBHOOK_INBOUND_DEFAULT_CHAT, "evt-1"));
  });

  it("reads a Standard Webhooks envelope's data object", () => {
    const result = adapter.normalise({
      type: "build.completed",
      data: { message: "  build 42 passed  ", topic: "ci", id: "evt-9" },
    });
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message.text).toBe("build 42 passed");
    expect(result.message.chatId).toBe("ci");
    expect(result.message.messageId).toBe("evt-9");
  });

  it("accepts message and content as the text field, in that order", () => {
    const viaMessage = adapter.normalise({ message: "from message", text: "from text" });
    expect(viaMessage.kind).toBe("message");
    if (viaMessage.kind === "message") expect(viaMessage.message.text).toBe("from text");

    const viaContent = adapter.normalise({ content: "from content" });
    expect(viaContent.kind).toBe("message");
    if (viaContent.kind === "message") expect(viaContent.message.text).toBe("from content");
  });

  it("filters a body that carries no text, with a typed reason and never a throw", () => {
    const result = adapter.normalise({ type: "ping" });
    expect(result).toEqual({ kind: "filtered", reason: "the event carries no message text" });
  });

  it("filters a blank text rather than delivering an empty message", () => {
    const result = adapter.normalise({ text: "   " });
    expect(result.kind).toBe("filtered");
  });

  it("filters anything that is not a JSON object", () => {
    expect(adapter.normalise(null)).toEqual({
      kind: "filtered",
      reason: "the event body is not a JSON object",
    });
    expect(adapter.normalise([1, 2]).kind).toBe("filtered");
    expect(adapter.normalise("text").kind).toBe("filtered");
  });

  it("derives a stable key for an event that names no delivery id", () => {
    const first = adapter.normalise({ text: "same body" });
    const second = adapter.normalise({ text: "same body" });
    const other = adapter.normalise({ text: "other body" });
    expect(first.kind).toBe("message");
    expect(second.kind).toBe("message");
    expect(other.kind).toBe("message");
    if (first.kind !== "message" || second.kind !== "message" || other.kind !== "message") return;
    expect(first.key).toBe(second.key);
    expect(first.key).not.toBe(other.key);
  });

  it("names the conversation from a chatId-like field, preferring chatId", () => {
    const result = adapter.normalise({ text: "hi", chatId: "ops", topic: "ci" });
    expect(result.kind).toBe("message");
    if (result.kind === "message") expect(result.message.chatId).toBe("ops");
  });
});

describe("the generic webhook verifier", () => {
  const secret = "s3cret-shared";
  const verifier = createWebhookInboundVerifier(secret);
  const body = Buffer.from(JSON.stringify({ text: "hi" }), "utf8");

  const headers = (timestamp: string, signature: string) => ({
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": signature,
    "x-webhook-delivery": "dlv-1",
  });

  it("accepts a request signed over `<timestamp>.<body>`", async () => {
    const timestamp = "1700000000";
    const signature = signIngressWebhookBody(secret, timestamp, body);
    const result = await verifier.verify(body, headers(timestamp, signature));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timestampMs).toBe(1_700_000_000_000);
      expect(result.deliveryId).toBe("dlv-1");
    }
  });

  it("accepts the sha256= prefix some senders write", async () => {
    const timestamp = "1700000000";
    const signature = `sha256=${signIngressWebhookBody(secret, timestamp, body)}`;
    expect((await verifier.verify(body, headers(timestamp, signature))).ok).toBe(true);
  });

  it("refuses a signature made with a different secret", async () => {
    const timestamp = "1700000000";
    const signature = signIngressWebhookBody("another-secret", timestamp, body);
    expect(await verifier.verify(body, headers(timestamp, signature))).toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("refuses a body altered after signing", async () => {
    const timestamp = "1700000000";
    const signature = signIngressWebhookBody(secret, timestamp, body);
    const tampered = Buffer.from(JSON.stringify({ text: "hi!" }), "utf8");
    expect((await verifier.verify(tampered, headers(timestamp, signature))).ok).toBe(false);
  });

  it("refuses a request with no timestamp, no signature, or no delivery id", async () => {
    const timestamp = "1700000000";
    const signature = signIngressWebhookBody(secret, timestamp, body);
    expect(await verifier.verify(body, { "x-webhook-signature": signature })).toEqual({
      ok: false,
      reason: "missing-timestamp",
    });
    expect(await verifier.verify(body, { "x-webhook-timestamp": timestamp })).toEqual({
      ok: false,
      reason: "missing-signature",
    });
    expect(
      await verifier.verify(body, {
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
      }),
    ).toEqual({ ok: false, reason: "missing-delivery-id" });
  });

  it("refuses a blank secret rather than authenticating everyone", () => {
    expect(() => createWebhookInboundVerifier("   ")).toThrow();
  });
});
