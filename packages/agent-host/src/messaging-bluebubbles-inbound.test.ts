import { describe, expect, it } from "vitest";

import { createBluebubblesAdapter, createBluebubblesVerifier } from "./messaging-bluebubbles-inbound.js";

const PASSWORD = "server-password";

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: "new-message",
    data: {
      guid: "msg-guid-1",
      text: "deploy please",
      isFromMe: false,
      handle: { address: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      ...overrides,
    },
  };
}

function verify(query: string, body: unknown = event()) {
  return createBluebubblesVerifier({ password: PASSWORD }).verify(
    Buffer.from(JSON.stringify(body), "utf8"),
    {},
    new URL(`https://host.test/webhooks/bluebubbles?${query}`),
  );
}

describe("the BlueBubbles verifier", () => {
  it("accepts the password in any of its three names", async () => {
    for (const name of ["guid", "password", "token"]) {
      expect(await verify(`${name}=${PASSWORD}`)).toMatchObject({ ok: true });
    }
  });

  it("refuses another password", async () => {
    expect(await verify("password=wrong")).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a request with no password", async () => {
    expect(await verify("")).toMatchObject({ ok: false, reason: "missing-signature" });
  });

  it("refuses when no URL is given", async () => {
    expect(
      await createBluebubblesVerifier({ password: PASSWORD }).verify(Buffer.from("{}"), {}),
    ).toMatchObject({ ok: false });
  });

  it("names the same delivery twice for a repeated body", async () => {
    const first = await verify(`password=${PASSWORD}`);
    const second = await verify(`password=${PASSWORD}`);
    expect(first.ok && first.deliveryId).toBe(second.ok && second.deliveryId);
  });
});

describe("the BlueBubbles adapter", () => {
  const adapter = createBluebubblesAdapter();

  it("projects a direct message onto the shared shape", () => {
    const result = adapter.normalise(event());
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "msg-guid-1",
      chatId: "iMessage;-;+15551234567",
      text: "deploy please",
      chatKind: "private",
      sender: { id: "+15551234567" },
    });
  });

  it("reads a group chat as a group", () => {
    const result = adapter.normalise(
      event({ chats: [{ guid: "iMessage;+;chat12345" }] }),
    );
    expect(result.kind === "message" && result.message.chatKind).toBe("group");
  });

  it("falls back to the sender when no chat is named", () => {
    const result = adapter.normalise(event({ chats: [] }));
    expect(result.kind === "message" && result.message.chatId).toBe("+15551234567");
  });

  it("refuses the bridge's own echo", () => {
    const result = adapter.normalise(event({ isFromMe: true }));
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("own");
  });

  it("filters an event that is not a new message", () => {
    const result = adapter.normalise({ type: "typing-indicator", data: {} });
    expect(result.kind).toBe("filtered");
  });

  it("filters a message with no text", () => {
    const result = adapter.normalise(event({ text: "" }));
    expect(result.kind).toBe("filtered");
  });
});
