/**
 * The verifier seam: how one platform proves that a request came from it.
 *
 * Every callback-shaped channel authenticates its requests differently — an
 * HMAC over a timestamp and the body (most of them), a JWT from a cloud
 * identity provider (Google Chat), a signature over a URL and a parameter list
 * (Twilio). What they share is only the *shape* of the question: given the
 * request's headers and its body, is this request ours?
 *
 * So the seam is one function ([`IngressVerifier`]) and the receiver owns
 * everything around it: reading the body with a cap, calling the verifier,
 * refusing on a `{ ok: false }`, enforcing the replay window and the delivery
 * id, and answering. A platform supplies only its verifier and its projection
 * of one raw event onto [`IngressMessage`], and becomes signature-plus-parse.
 *
 * # The raw body, and why it is a Buffer
 *
 * The verifier is handed the bytes exactly as they arrived. It is never handed
 * a parsed object, because a signature computed over a re-serialised body
 * cannot detect tampering: whitespace, key order and number formatting all
 * change the bytes without changing the object, so a verifier that parsed first
 * would accept a body it never authenticated. The single most common way
 * webhook verification is implemented wrongly is this one, and the type here
 * makes it unrepresentable rather than a rule in a comment.
 *
 * The receiver derives the string it parses from the same Buffer it verified
 * (`rawBody.toString("utf8")`), so the bytes that were signed and the bytes that
 * become a turn are one value, not two.
 *
 * # What a verifier does not decide
 *
 * A verifier authenticates. It answers *who sent this*, in the platform's own
 * terms, and returns the timestamp it covered and the platform's delivery id;
 * it does not decide whether that delivery is fresh or whether it has already
 * been seen. Freshness and replay are the receiver's, once, so ten platforms
 * cannot each get the window slightly wrong.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** One request's headers, keyed lowercase, as Node hands them over. */
export type IngressVerifierHeaders = Readonly<Record<string, string | undefined>>;

/**
 * Why a request was not authenticated.
 *
 * These are a closed vocabulary rather than free text: a reason reaches an
 * audit record, and a record that could carry a platform's raw error string
 * could carry a secret with it. None of them contains the header values, the
 * signature or the secret.
 */
export type IngressVerificationFailure =
  | "missing-timestamp"
  | "malformed-timestamp"
  | "missing-signature"
  | "signature-mismatch"
  | "missing-delivery-id";

/**
 * What authenticating one request produced.
 *
 * `ok` carries the two facts the receiver needs next: the instant the platform
 * signed (`timestampMs`, from the timestamp the signature covered, so it cannot
 * be forged without the secret) and the platform's own id for this delivery,
 * which is what replay protection is keyed on.
 */
export type IngressVerification =
  | { ok: true; timestampMs: number; deliveryId: string }
  | { ok: false; reason: IngressVerificationFailure };

/**
 * One platform's signature scheme.
 *
 * `verify` may be asynchronous for the schemes that need a key set they do not
 * hold (a JWT verifier fetching a JWKS); the receiver awaits it either way, and
 * nothing is parsed before it returns.
 *
 * `scheme` is a short name for logs and tests — `hmac-sha256-timestamp` for the
 * generic implementation here, a platform's own name for its own.
 */
export type IngressVerifier = {
  readonly scheme: string;
  verify(
    rawBody: Buffer,
    headers: IngressVerifierHeaders,
  ): IngressVerification | Promise<IngressVerification>;
};

/** The default name of the header carrying Unix seconds. */
export const INGRESS_WEBHOOK_TIMESTAMP_HEADER = "x-webhook-timestamp";

/** The default name of the header carrying the hex HMAC-SHA256 signature. */
export const INGRESS_WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

/** The default name of the header carrying the platform's delivery id. */
export const INGRESS_WEBHOOK_DELIVERY_HEADER = "x-webhook-delivery";

export type HmacTimestampVerifierOptions = {
  /** The shared secret; a blank one is refused, because it authenticates anyone. */
  secret: string;
  /** The header carrying Unix seconds; defaults to [`INGRESS_WEBHOOK_TIMESTAMP_HEADER`]. */
  timestampHeader?: string;
  /** The header carrying the signature; defaults to [`INGRESS_WEBHOOK_SIGNATURE_HEADER`]. */
  signatureHeader?: string;
  /** The header carrying the delivery id; defaults to [`INGRESS_WEBHOOK_DELIVERY_HEADER`]. */
  deliveryHeader?: string;
};

/** The scheme name the generic implementation reports. */
export const INGRESS_HMAC_SCHEME = "hmac-sha256-timestamp";

/**
 * The one generic verifier: HMAC-SHA256 over `<timestamp>.<raw body>` with a
 * shared secret, signed with the platform's timestamp header.
 *
 * The signed string is the header's own text, a literal `.`, then the body
 * bytes — the shape most of the ten callback platforms use, and the one that
 * makes the timestamp tamper-evident: a captured request cannot be re-dated
 * without the secret, so the receiver's replay window is enforced over a value
 * the sender signed.
 *
 * A `sha256=` prefix on the signature is accepted and ignored, because some
 * platforms write it and some do not, and accepting both costs nothing: the
 * comparison is over the decoded bytes.
 */
export function createHmacTimestampVerifier(
  options: HmacTimestampVerifierOptions,
): IngressVerifier {
  const secret = options.secret;
  if (!secret.trim()) {
    throw new Error("a webhook verifier needs a non-blank shared secret");
  }
  const timestampHeader = (options.timestampHeader ?? INGRESS_WEBHOOK_TIMESTAMP_HEADER).toLowerCase();
  const signatureHeader = (options.signatureHeader ?? INGRESS_WEBHOOK_SIGNATURE_HEADER).toLowerCase();
  const deliveryHeader = (options.deliveryHeader ?? INGRESS_WEBHOOK_DELIVERY_HEADER).toLowerCase();
  // The MAC object is reusable with a fresh digest per request; the secret never
  // leaves this closure and is never placed in a result.
  const key = Buffer.from(secret, "utf8");

  return {
    scheme: INGRESS_HMAC_SCHEME,
    verify(rawBody, headers) {
      const timestamp = headers[timestampHeader]?.trim();
      if (!timestamp) return { ok: false, reason: "missing-timestamp" };
      // Unix seconds, digits only. The pattern is also what keeps a value like
      // `1e9` or a signed offset from reaching Number().
      if (!/^[0-9]{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed-timestamp" };

      const signature = headers[signatureHeader]?.trim();
      if (!signature) return { ok: false, reason: "missing-signature" };
      const given = signature.replace(/^sha256=/i, "");
      if (!/^[0-9a-f]{64}$/i.test(given)) return { ok: false, reason: "signature-mismatch" };

      const expected = createHmac("sha256", key)
        .update(`${timestamp}.`, "utf8")
        .update(rawBody)
        .digest();
      const actual = Buffer.from(given, "hex");
      // Both are 32 bytes here, but the length check keeps the comparison
      // well-defined rather than relying on that.
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return { ok: false, reason: "signature-mismatch" };
      }

      const deliveryId = headers[deliveryHeader]?.trim();
      if (!deliveryId) return { ok: false, reason: "missing-delivery-id" };

      return { ok: true, timestampMs: Number(timestamp) * 1000, deliveryId };
    },
  };
}

/**
 * Sign a body the way [`createHmacTimestampVerifier`] expects.
 *
 * It lives here, not in a test helper, because the receiver's own proof needs
 * it and because a platform's fixture will need it too: one implementation of
 * the generic scheme, so a test cannot pass by signing something the verifier
 * would not accept.
 */
export function signIngressWebhookBody(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf8")
    .update(rawBody)
    .digest("hex");
}
