import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLineAdapter, createLineVerifier } from "./messaging-line-inbound.js";

const SECRET = "line-channel-secret";

function textEvent(overrides: {
  id?: string;
  text?: string;
  userId?: string;
  groupId?: string;
  type?: string;
  messageType?: string;
} = {}): unknown {
  return {
    destination: "Ubot",
    events: [
      {
        type: overrides.type ?? "message",
        timestamp: 1700000000000,
        source: {
          type: overrides.groupId ? "group" : "user",
          userId: overrides.userId ?? "Uuser",
          ...(overrides.groupId ? { groupId: overrides.groupId } : {}),
        },
        message: {
          id: overrides.id ?? "1234567890",
          type: overrides.messageType ?? "text",
          text: overrides.text ?? "hello",
        },
      },
    ],
  };
}

describe("the LINE adapter", () => {
  it("projects a text message onto the shared shape", () => {
    const result = createLineAdapter().normalise(textEvent());
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "1234567890",
      chatId: "Uuser",
      text: "hello",
      chatKind: "private",
      sender: { id: "Uuser" },
      sentAt: 1700000000000,
    });
  });

  it("answers in the group when the source is a group", () => {
    const result = createLineAdapter().normalise(textEvent({ groupId: "Cgroup" }));
    expect(result.kind === "message" && result.message.chatId).toBe("Cgroup");
    expect(result.kind === "message" && result.message.chatKind).toBe("group");
  });

  it("filters a follow event", () => {
    const raw = {
      destination: "Ubot",
      events: [{ type: "follow", timestamp: 1, source: { type: "user", userId: "U1" } }],
    };
    const result = createLineAdapter().normalise(raw);
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("follow");
  });

  it("filters a sticker", () => {
    const result = createLineAdapter().normalise(textEvent({ messageType: "sticker" }));
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("sticker");
  });

  it("takes the first text message out of a mixed batch", () => {
    const raw = {
      destination: "Ubot",
      events: [
        { type: "follow", timestamp: 1, source: { type: "user", userId: "U1" } },
        {
          type: "message",
          timestamp: 2,
          source: { type: "user", userId: "U1" },
          message: { id: "m1", type: "text", text: "second" },
        },
      ],
    };
    const result = createLineAdapter().normalise(raw);
    expect(result.kind === "message" && result.message.text).toBe("second");
  });

  it("filters an empty batch rather than throwing", () => {
    expect(createLineAdapter().normalise({ destination: "Ubot", events: [] }).kind).toBe("filtered");
  });
});

describe("the LINE verifier", () => {
  const body = Buffer.from(JSON.stringify(textEvent()), "utf8");

  it("accepts a correctly signed body", () => {
    const signature = createHmac("sha256", SECRET).update(body).digest("base64");
    const result = createLineVerifier(SECRET).verify(body, { "x-line-signature": signature });
    expect(result).toMatchObject({ ok: true });
  });

  it("refuses a signature over different bytes", () => {
    const signature = createHmac("sha256", SECRET).update(Buffer.from("{}")).digest("base64");
    expect(createLineVerifier(SECRET).verify(body, { "x-line-signature": signature })).toMatchObject({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("refuses a missing signature", () => {
    expect(createLineVerifier(SECRET).verify(body, {})).toMatchObject({
      ok: false,
      reason: "missing-signature",
    });
  });

  it("keys a redelivery of the same bytes to the same delivery id", () => {
    const signature = createHmac("sha256", SECRET).update(body).digest("base64");
    const first = createLineVerifier(SECRET).verify(body, { "x-line-signature": signature });
    const second = createLineVerifier(SECRET).verify(body, { "x-line-signature": signature });
    // The verifier is synchronous here; the interface allows a promise for the
    // schemes that fetch a key set, so the test narrows the union explicitly.
    const a = first as { ok: true; deliveryId: string };
    const b = second as { ok: true; deliveryId: string };
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.deliveryId).toBe(b.deliveryId);
  });

  it("refuses everything when no secret is stored", () => {
    const signature = createHmac("sha256", "").update(body).digest("base64");
    expect(createLineVerifier("   ").verify(body, { "x-line-signature": signature })).toMatchObject({
      ok: false,
    });
  });
});
