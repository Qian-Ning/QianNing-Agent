import { describe, expect, it } from "vitest";

import { createFeishuAdapter, createFeishuVerifier } from "./messaging-feishu-inbound.js";
import { ingressMessageKey } from "./messaging-ingress.js";

const TOKEN = "verification-token-SECRET";

function event(overrides: {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  text?: string;
  messageType?: string;
  senderType?: string;
  chatType?: string;
  createTime?: string;
} = {}): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: overrides.eventId ?? "ev_1",
      event_type: "im.message.receive_v1",
      token: TOKEN,
      create_time: overrides.createTime ?? "1730000000000",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: overrides.senderType ?? "user",
      },
      message: {
        message_id: overrides.messageId ?? "om_1",
        chat_id: overrides.chatId ?? "oc_1",
        chat_type: overrides.chatType ?? "group",
        message_type: overrides.messageType ?? "text",
        content: JSON.stringify({ text: overrides.text ?? "hello" }),
      },
    },
  };
}

describe("the Feishu adapter", () => {
  it("projects a text message onto the shared inbound shape", () => {
    const result = createFeishuAdapter().normalise(event());
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "om_1",
      chatId: "oc_1",
      text: "hello",
      chatKind: "group",
      sender: { id: "ou_sender" },
      sentAt: 1730000000000,
    });
    expect(result.key).toBe(ingressMessageKey("oc_1", "ev_1"));
  });

  it("keys the event on the platform's event id, not the message id", () => {
    // Feishu redelivers with the same event id; keying on the message id would
    // still dedupe, but the event id is the one the platform guarantees stable
    // across a retry that re-sends the same body.
    const result = createFeishuAdapter().normalise(event({ eventId: "ev_9", messageId: "om_1" }));
    expect(result.kind === "message" && result.key).toBe(ingressMessageKey("oc_1", "ev_9"));
  });

  it("answers the URL verification challenge without treating it as a message", () => {
    const result = createFeishuAdapter().normalise({
      type: "url_verification",
      challenge: "ch_123",
      token: TOKEN,
    });
    expect(result).toMatchObject({
      kind: "filtered",
      reason: "url verification",
      ack: { challenge: "ch_123" },
    });
  });

  it("filters a bot's own message", () => {
    const result = createFeishuAdapter().normalise(event({ senderType: "bot" }));
    expect(result).toMatchObject({ kind: "filtered" });
    expect(result.kind === "filtered" && result.reason).toContain("bot");
  });

  it("filters a non-text message with a reason a person can read", () => {
    const result = createFeishuAdapter().normalise(event({ messageType: "image" }));
    expect(result).toMatchObject({ kind: "filtered" });
    expect(result.kind === "filtered" && result.reason).toContain("image");
  });

  it("refuses an encrypted body instead of silently finding nothing", () => {
    const result = createFeishuAdapter().normalise({ encrypt: "base64-blob" });
    expect(result).toMatchObject({ kind: "filtered" });
    expect(result.kind === "filtered" && result.reason).toContain("encrypted");
  });

  it("refuses an event type that is not a message", () => {
    const raw = event() as { header: { event_type: string } };
    raw.header.event_type = "im.chat.updated_v1";
    const result = createFeishuAdapter().normalise(raw);
    expect(result.kind).toBe("filtered");
  });

  it("filters rather than throws when the body is not JSON", () => {
    const result = createFeishuAdapter().normalise("not an object");
    expect(result.kind).toBe("filtered");
  });

  it("de-duplicates on the event key, so one redelivery runs one command", () => {
    const first = createFeishuAdapter().normalise(event());
    const second = createFeishuAdapter().normalise(event());
    expect(first.kind === "message" && second.kind === "message" && first.key === second.key).toBe(true);
  });
});

describe("the Feishu verifier", () => {
  const verify = (body: unknown): ReturnType<ReturnType<typeof createFeishuVerifier>["verify"]> =>
    createFeishuVerifier(TOKEN).verify(Buffer.from(JSON.stringify(body), "utf8"), {});

  it("accepts a body carrying the configured verification token", () => {
    const result = verify(event());
    expect(result).toMatchObject({ ok: true, deliveryId: "ev_1" });
  });

  it("refuses a different token", () => {
    const raw = event() as { header: { token: string } };
    raw.header.token = "some-other-token";
    expect(verify(raw)).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a body with no token at all", () => {
    const raw = event() as { header: Record<string, unknown> };
    delete raw.header.token;
    expect(verify(raw)).toMatchObject({ ok: false, reason: "missing-signature" });
  });

  it("refuses when the channel has no token stored", () => {
    const result = createFeishuVerifier("   ").verify(
      Buffer.from(JSON.stringify(event()), "utf8"),
      {},
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("never puts the token in the refusal", () => {
    const raw = event() as { header: { token: string } };
    raw.header.token = "wrong-token-value";
    const result = verify(raw);
    expect(JSON.stringify(result)).not.toContain("wrong-token-value");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
