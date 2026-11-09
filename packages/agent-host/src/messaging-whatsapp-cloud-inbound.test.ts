import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createWhatsappCloudAdapter,
  createWhatsappCloudHandshake,
  createWhatsappCloudVerifier,
  whatsappCloudSignature,
} from "./messaging-whatsapp-cloud-inbound.js";

const APP_SECRET = "app-secret-value";
const VERIFY_TOKEN = "verify-token-value";

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1234",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "999" },
              contacts: [{ profile: { name: "Ann" }, wa_id: "15551234567" }],
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.ABC",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "deploy please" },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  });
}

function verify(raw: string, signature?: string) {
  return createWhatsappCloudVerifier({ appSecret: APP_SECRET }).verify(Buffer.from(raw, "utf8"), {
    "x-hub-signature-256": signature ?? whatsappCloudSignature(APP_SECRET, Buffer.from(raw, "utf8")),
  });
}

describe("the WhatsApp Cloud verifier", () => {
  it("accepts a body Meta signed", async () => {
    expect(await verify(body())).toMatchObject({ ok: true });
  });

  it("refuses a body that changed after signing", async () => {
    const raw = body();
    const signature = whatsappCloudSignature(APP_SECRET, Buffer.from(raw, "utf8"));
    const tampered = raw.replace("deploy please", "deploy now");
    expect(await verify(tampered, signature)).toMatchObject({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("refuses another app's signature", async () => {
    const raw = body();
    const foreign = `sha256=${createHmac("sha256", "other").update(raw).digest("hex")}`;
    expect(await verify(raw, foreign)).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a request with no signature", async () => {
    const verifier = createWhatsappCloudVerifier({ appSecret: APP_SECRET });
    expect(await verifier.verify(Buffer.from(body(), "utf8"), {})).toMatchObject({
      ok: false,
      reason: "missing-signature",
    });
  });

  it("names a delivery id stable across a redelivery", async () => {
    const first = await verify(body());
    const second = await verify(body());
    expect(first.ok && first.deliveryId).toBe(second.ok && second.deliveryId);
  });
});

describe("the WhatsApp Cloud handshake", () => {
  const handshake = createWhatsappCloudHandshake({ verifyToken: VERIFY_TOKEN });

  it("answers the challenge for the configured token", () => {
    const url = new URL(
      `https://host.test/webhooks/whatsapp-cloud?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`,
    );
    expect(handshake(url)).toMatchObject({ status: 200, body: "42" });
  });

  it("refuses another token", () => {
    const url = new URL(
      "https://host.test/webhooks/whatsapp-cloud?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42",
    );
    expect(handshake(url)).toMatchObject({ status: 403 });
  });

  it("refuses a request that is not a subscription", () => {
    const url = new URL(
      `https://host.test/webhooks/whatsapp-cloud?hub.mode=other&hub.verify_token=${VERIFY_TOKEN}`,
    );
    expect(handshake(url)).toMatchObject({ status: 400 });
  });
});

describe("the WhatsApp Cloud adapter", () => {
  const adapter = createWhatsappCloudAdapter();

  it("projects a text message onto the shared shape", () => {
    const result = adapter.normalise(JSON.parse(body()));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "wamid.ABC",
      chatId: "15551234567",
      text: "deploy please",
      chatKind: "private",
      sender: { id: "15551234567", name: "Ann" },
    });
  });

  it("names a delivery status as a status, not a malformed event", () => {
    const statuses = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [{ id: "wamid.ABC", status: "delivered", recipient_id: "15551234567" }],
              },
            },
          ],
        },
      ],
    };
    const result = adapter.normalise(statuses);
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("delivery statuses");
  });

  it("filters a media message by its type", () => {
    const media = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "15551234567", id: "wamid.IMG", type: "image" }],
              },
            },
          ],
        },
      ],
    };
    const result = adapter.normalise(media);
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("image");
  });

  it("filters a body that is not a WhatsApp envelope", () => {
    expect(adapter.normalise({ object: "page" }).kind).toBe("filtered");
  });
});
