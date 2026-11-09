import { generateKeyPairSync, sign as signWith, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTeamsAdapter, createTeamsVerifier, TEAMS_ISSUER } from "./messaging-teams-inbound.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const METADATA = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const JWKS = "https://login.botframework.com/v1/.well-known/keys";

function keyPair(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { privateKey, jwk: { ...jwk, kid: "bf-1", alg: "RS256" } };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function token(
  privateKey: KeyObject,
  options: { audience?: string; issuer?: string; exp?: number; jti?: string } = {},
): string {
  const header = { alg: "RS256", typ: "JWT", kid: "bf-1" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: options.issuer ?? TEAMS_ISSUER,
    aud: options.audience ?? APP_ID,
    iat: now,
    exp: options.exp ?? now + 600,
    jti: options.jti ?? "activity-1",
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = signWith("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

/** A fetcher that serves the metadata document and then the key set. */
function fetcher(jwk: Record<string, unknown>) {
  return async (url: string): Promise<unknown> => {
    if (url === METADATA) return { issuer: TEAMS_ISSUER, jwks_uri: JWKS };
    if (url === JWKS) return { keys: [jwk] };
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function verify(tokenValue: string, jwk: Record<string, unknown>) {
  return createTeamsVerifier({ appId: APP_ID, fetchJson: fetcher(jwk) }).verify(Buffer.from("{}"), {
    authorization: `Bearer ${tokenValue}`,
  });
}

describe("the Teams verifier", () => {
  const { privateKey, jwk } = keyPair();

  it("accepts a token the connector signed for this bot", async () => {
    expect(await verify(token(privateKey), jwk)).toMatchObject({ ok: true, deliveryId: "activity-1" });
  });

  it("follows the metadata document to the key set", async () => {
    const seen: string[] = [];
    const verifier = createTeamsVerifier({
      appId: APP_ID,
      fetchJson: async (url) => {
        seen.push(url);
        if (url === METADATA) return { jwks_uri: JWKS };
        return { keys: [jwk] };
      },
    });
    await verifier.verify(Buffer.from("{}"), { authorization: `Bearer ${token(privateKey)}` });
    expect(seen).toEqual([METADATA, JWKS]);
  });

  it("refuses a token for another bot", async () => {
    expect(await verify(token(privateKey, { audience: "someone-else" }), jwk)).toMatchObject({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("refuses a token from another issuer", async () => {
    expect(await verify(token(privateKey, { issuer: "https://example.com" }), jwk)).toMatchObject({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("refuses an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(token(privateKey, { exp: now - 3600 }), jwk)).toMatchObject({
      ok: false,
      reason: "malformed-timestamp",
    });
  });

  it("refuses when the metadata document cannot be fetched", async () => {
    const verifier = createTeamsVerifier({
      appId: APP_ID,
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(
      await verifier.verify(Buffer.from("{}"), { authorization: `Bearer ${token(privateKey)}` }),
    ).toMatchObject({ ok: false });
  });

  it("refuses a request with no bearer token", async () => {
    const verifier = createTeamsVerifier({ appId: APP_ID, fetchJson: fetcher(jwk) });
    expect(await verifier.verify(Buffer.from("{}"), {})).toMatchObject({
      ok: false,
      reason: "missing-signature",
    });
  });
});

describe("the Teams adapter", () => {
  const activity = {
    type: "message",
    id: "1a2b3c",
    text: "run the tests",
    from: { id: "29:user", name: "Ann" },
    conversation: { id: "a:1xyz", conversationType: "channel" },
    channelId: "microsoftTeams",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
  };

  it("projects an activity onto the shared shape", () => {
    const result = createTeamsAdapter().normalise(activity);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "1a2b3c",
      chatId: "a:1xyz",
      text: "run the tests",
      chatKind: "group",
      sender: { id: "29:user", name: "Ann" },
    });
  });

  it("reads a personal conversation as private", () => {
    const result = createTeamsAdapter().normalise({
      ...activity,
      conversation: { id: "a:1xyz", conversationType: "personal" },
    });
    expect(result.kind === "message" && result.message.chatKind).toBe("private");
  });

  it("filters a non-message activity", () => {
    const result = createTeamsAdapter().normalise({ ...activity, type: "conversationUpdate" });
    expect(result.kind).toBe("filtered");
  });

  it("filters an activity with no text", () => {
    const result = createTeamsAdapter().normalise({ ...activity, text: "" });
    expect(result.kind).toBe("filtered");
  });
});
