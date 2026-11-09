import { describe, expect, it } from "vitest";

import { createSmsAdapter, createSmsVerifier, twilioSignature } from "./messaging-sms-inbound.js";

const TOKEN = "twilio-auth-token-SECRET";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const MESSAGE = {
  From: "+15551234567",
  To: "+15559876543",
  Body: "deploy please",
  MessageSid: "SM1234567890abcdef",
  AccountSid: "AC123",
};

describe("the Twilio form reader", () => {
  it("reads a form-encoded body into fields", () => {
    const adapter = createSmsAdapter();
    const parsed = adapter.parse!(form(MESSAGE)) as Record<string, string>;
    expect(parsed.Body).toBe("deploy please");
    expect(parsed.From).toBe("+15551234567");
  });
});

describe("the SMS adapter", () => {
  it("projects a text message onto the shared shape", () => {
    const adapter = createSmsAdapter();
    const result = adapter.normalise(adapter.parse!(form(MESSAGE)));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "SM1234567890abcdef",
      chatId: "+15551234567",
      text: "deploy please",
      chatKind: "private",
      sender: { id: "+15551234567" },
    });
  });

  it("filters a request with no body — a status callback, not a message", () => {
    const adapter = createSmsAdapter();
    const result = adapter.normalise(adapter.parse!(form({ MessageSid: "SM1", From: "+1555" })));
    expect(result.kind).toBe("filtered");
  });

  it("filters a message with no id", () => {
    const adapter = createSmsAdapter();
    const result = adapter.normalise(adapter.parse!(form({ From: "+1555", Body: "hi" })));
    expect(result.kind).toBe("filtered");
  });
});

describe("the Twilio verifier", () => {
  const body = Buffer.from(form(MESSAGE), "utf8");
  const host = "desk.example.com";
  const url = new URL("https://desk.example.com/webhooks/twilio");

  const signatureFor = (scheme: string): string =>
    twilioSignature(TOKEN, `${scheme}://${host}/webhooks/twilio`, MESSAGE);

  it("accepts a signature computed over the https address", () => {
    const result = createSmsVerifier(TOKEN).verify(body, {
      host,
      "x-twilio-signature": signatureFor("https"),
    }, url);
    expect(result).toMatchObject({ ok: true, deliveryId: "SM1234567890abcdef" });
  });

  it("accepts the http form too, because a local proxy may terminate TLS", () => {
    const result = createSmsVerifier(TOKEN).verify(body, {
      host,
      "x-twilio-signature": signatureFor("http"),
    }, url);
    expect(result).toMatchObject({ ok: true });
  });

  it("refuses a signature over a different body", () => {
    const other = Buffer.from(form({ ...MESSAGE, Body: "something else" }), "utf8");
    expect(
      createSmsVerifier(TOKEN).verify(other, {
        host,
        "x-twilio-signature": signatureFor("https"),
      }, url),
    ).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a missing signature", () => {
    expect(createSmsVerifier(TOKEN).verify(body, { host }, url)).toMatchObject({
      ok: false,
      reason: "missing-signature",
    });
  });

  it("refuses everything when no token is stored", () => {
    expect(
      createSmsVerifier("   ").verify(body, { host, "x-twilio-signature": signatureFor("https") }, url),
    ).toMatchObject({ ok: false });
  });

  it("never puts the token in the refusal", () => {
    const result = createSmsVerifier(TOKEN).verify(body, { host, "x-twilio-signature": "nope" }, url);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
