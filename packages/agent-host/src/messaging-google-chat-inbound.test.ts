import { generateKeyPairSync, sign as signWith, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createGoogleChatAdapter,
  createGoogleChatVerifier,
  GOOGLE_CHAT_ISSUER,
} from "./messaging-google-chat-inbound.js";

const AUDIENCE = "123456789012";

/** A throwaway RSA key, minted per run: never a credential, only a fixture. */
function keyPair(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { privateKey, jwk: { ...jwk, kid: "key-1", alg: "RS256" } };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(
  privateKey: KeyObject,
  options: { audience?: string; issuer?: string; exp?: number; jti?: string; kid?: string } = {},
): string {
  const header = { alg: "RS256", typ: "JWT", kid: options.kid ?? "key-1" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: options.issuer ?? GOOGLE_CHAT_ISSUER,
    aud: options.audience ?? AUDIENCE,
    iat: now,
    exp: options.exp ?? now + 600,
    jti: options.jti ?? "delivery-1",
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = signWith("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

function verify(tokenValue: string, jwk: Record<string, unknown>) {
  return createGoogleChatVerifier({
    audience: AUDIENCE,
    fetchKeys: async () => ({ keys: [jwk as never] }),
  }).verify(Buffer.from("{}"), { authorization: `Bearer ${tokenValue}` });
}

describe("the Google Chat verifier", () => {
  const { privateKey, jwk } = keyPair();

  it("accepts an assertion Google minted for this app", async () => {
    const result = await verify(token(privateKey), jwk);
    expect(result).toMatchObject({ ok: true, deliveryId: "delivery-1" });
  });

  it("refuses an assertion for another audience", async () => {
    const result = await verify(token(privateKey, { audience: "999" }), jwk);
    expect(result).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses an assertion from another issuer", async () => {
    const result = await verify(token(privateKey, { issuer: "someone@example.com" }), jwk);
    expect(result).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses an expired assertion", async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await verify(token(privateKey, { exp: now - 3600 }), jwk);
    expect(result).toMatchObject({ ok: false, reason: "malformed-timestamp" });
  });

  it("refuses a signature made with another key", async () => {
    const other = keyPair();
    const result = await verify(token(other.privateKey), jwk);
    expect(result).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a request with no bearer token", async () => {
    const verifier = createGoogleChatVerifier({
      audience: AUDIENCE,
      fetchKeys: async () => ({ keys: [jwk as never] }),
    });
    expect(await verifier.verify(Buffer.from("{}"), {})).toMatchObject({
      ok: false,
      reason: "missing-signature",
    });
  });

  it("refuses when the key set cannot be fetched, instead of falling open", async () => {
    const verifier = createGoogleChatVerifier({
      audience: AUDIENCE,
      fetchKeys: async () => {
        throw new Error("network down");
      },
    });
    expect(
      await verifier.verify(Buffer.from("{}"), { authorization: `Bearer ${token(privateKey)}` }),
    ).toMatchObject({ ok: false });
  });
});

describe("the Google Chat adapter", () => {
  const message = {
    type: "MESSAGE",
    space: { name: "spaces/AAA" },
    user: { name: "users/123", displayName: "Ann" },
    message: {
      name: "spaces/AAA/messages/XYZ",
      text: "deploy please",
    },
  };

  it("projects a message onto the shared shape", () => {
    const result = createGoogleChatAdapter().normalise(message);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "spaces/AAA/messages/XYZ",
      chatId: "spaces/AAA",
      text: "deploy please",
      chatKind: "group",
      sender: { id: "users/123", name: "Ann" },
    });
  });

  it("filters a non-message event", () => {
    const result = createGoogleChatAdapter().normalise({ ...message, type: "ADDED_TO_SPACE" });
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("ADDED_TO_SPACE");
  });

  it("filters a message with no text", () => {
    const result = createGoogleChatAdapter().normalise({
      ...message,
      message: { name: "spaces/AAA/messages/XYZ" },
    });
    expect(result.kind).toBe("filtered");
  });
});
