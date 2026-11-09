/**
 * The JWT verifier shared by the platforms that sign their own requests.
 *
 * Google Chat and Microsoft Teams both arrive as `Authorization: Bearer <jwt>`
 * signed by the platform, with a public key set published behind a metadata
 * document. The differences are the issuer string, the audience, and whether the
 * key set URL is known directly or behind an OpenID configuration document —
 * everything else, including the caching and the refusal behaviour, is the same.
 *
 * # Nothing falls open
 *
 * A key set that cannot be fetched, or that carries no key matching the token's
 * `kid`, refuses the request. A verifier that accepts when it cannot check is
 * not a verifier, and the alternative — letting an unsigned request through
 * because the network was down — is the one failure this module must never have.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";

import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** A JWK, as far as this module needs it. */
type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string };

/** Fetch JSON from a URL; injected so tests never touch the network. */
export type JsonFetcher = (url: string) => Promise<unknown>;

/** The default fetcher: plain HTTPS, no redirects followed. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** How long a fetched key set or metadata document is reused. */
const TTL_MS = 60 * 60 * 1000;

/** The tolerance applied to `exp` and `iat`. */
const CLOCK_SKEW_SECONDS = 300;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createJwtVerifier(options: {
  /** Where the OpenID configuration lives, when the key set URL is not known. */
  metadataUrl?: string;
  /** The key set URL, when it is known directly. */
  jwksUrl?: string;
  /** The exact `iss` the platform stamps. */
  issuer: string;
  /** The `aud` this app is addressed as. */
  audience: string;
  /** How the failure is named in `IngressVerification`. */
  scheme: string;
  fetchJson?: JsonFetcher;
  now?: () => number;
}): IngressVerifier {
  const fetchDocument = options.fetchJson ?? fetchJson;
  const now = options.now ?? (() => Date.now());
  const expectedAudience = options.audience.trim();
  const issuer = options.issuer.trim();
  if (options.jwksUrl === undefined && options.metadataUrl === undefined) {
    throw new Error("a JWT verifier needs a key set URL or a metadata document");
  }

  let keySet:
    | { url: string; keys: Jwk[]; at: number }
    | null = null;

  const resolveUrl = async (): Promise<string> => {
    if (options.jwksUrl) return options.jwksUrl;
    const document = await fetchDocument(options.metadataUrl as string);
    const jwksUri = isRecord(document) ? text(document.jwks_uri) : null;
    if (!jwksUri) throw new Error("the metadata document names no key set");
    return jwksUri;
  };

  const keys = async (force: boolean): Promise<Jwk[]> => {
    if (!force && keySet && now() - keySet.at < TTL_MS) return keySet.keys;
    const url = keySet?.url ?? (await resolveUrl());
    const document = await fetchDocument(url);
    const set = isRecord(document) && Array.isArray(document.keys) ? (document.keys as Jwk[]) : [];
    if (set.length === 0) throw new Error("the key set carries no keys");
    keySet = { url, keys: set, at: now() };
    return set;
  };

  return {
    scheme: options.scheme,
    async verify(_rawBody: Buffer, headers): Promise<IngressVerification> {
      if (expectedAudience === "" || issuer === "") return { ok: false, reason: "signature-mismatch" };

      const authorization = text(headers.authorization ?? null);
      if (!authorization || !/^bearer /i.test(authorization)) {
        return { ok: false, reason: "missing-signature" };
      }
      const parts = authorization.slice(7).trim().split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed-timestamp" };
      const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8")) as Record<string, unknown>;
        payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8")) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "malformed-timestamp" };
      }

      if (text(payload.iss) !== issuer) return { ok: false, reason: "signature-mismatch" };
      const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud ?? "")];
      if (!audience.includes(expectedAudience)) return { ok: false, reason: "signature-mismatch" };

      const seconds = Math.floor(now() / 1000);
      const expires = Number(payload.exp);
      if (!Number.isFinite(expires) || expires + CLOCK_SKEW_SECONDS < seconds) {
        return { ok: false, reason: "malformed-timestamp" };
      }
      const issued = Number(payload.iat);
      if (Number.isFinite(issued) && issued - CLOCK_SKEW_SECONDS > seconds) {
        return { ok: false, reason: "malformed-timestamp" };
      }

      const kid = text(header.kid);
      const signature = Buffer.from(rawSignature, "base64url");
      const signed = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
      let verified = false;
      try {
        // A `kid` that is not in the cached set usually means the platform
        // rotated keys, so the second pass refetches before giving up.
        for (const refetch of [false, true]) {
          const set = await keys(refetch);
          const key = kid ? set.find((entry) => entry.kid === kid) : set[0];
          if (!key) continue;
          const publicKey = createPublicKey({ key: key as never, format: "jwk" });
          if (verifySignature("RSA-SHA256", signed, publicKey, signature)) {
            verified = true;
            break;
          }
        }
      } catch {
        return { ok: false, reason: "signature-mismatch" };
      }
      if (!verified) return { ok: false, reason: "signature-mismatch" };

      const deliveryId = text(payload.jti) ?? text(payload.exp) ?? null;
      if (!deliveryId) return { ok: false, reason: "missing-delivery-id" };
      return { ok: true, timestampMs: now(), deliveryId };
    },
  };
}
