/**
 * WeCom's callback envelope: the signature, the AES key, and the two payload
 * shapes around them.
 *
 * # Why this is its own module
 *
 * WeCom encrypts the body of every callback with AES-256-CBC and signs the
 * request with SHA-1 over four sorted strings. Neither is a secret-sharing
 * scheme this build already has: the generic verifier is HMAC over
 * `<timestamp>.<body>`, and no other channel encrypts anything. Keeping the
 * primitives here means the adapter reads like an adapter and the arithmetic
 * has one home to be tested in.
 *
 * # The key
 *
 * WeCom hands out a 43-character `EncodingAESKey`, which is Base64 without its
 * final `=`. Decoded it is exactly 32 bytes, and the first 16 of those are also
 * the CBC IV — WeCom's own construction, not a choice made here.
 *
 * # The plaintext
 *
 * Decrypted, the message is `random(16) || length(4, big-endian) || message ||
 * receiver-id`. The length is what makes the trailing receiver id
 * distinguishable from the message itself, so it is read rather than guessed
 * from the end. Padding is PKCS#7 over a 32-byte block, not AES's own 16.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** The block size WeCom pads to, which is twice AES's own. */
const WECOM_PAD_BLOCK = 32;

/** The fixed prefix every decrypted payload begins with. */
const WECOM_RANDOM_BYTES = 16;

/** The four-byte big-endian message length that follows it. */
const WECOM_LENGTH_BYTES = 4;

/**
 * The signature WeCom puts on a callback, and on a reply.
 *
 * Four strings — the app's Token, the timestamp, the nonce and the encrypted
 * payload — sorted lexicographically, joined with no separator, hashed with
 * SHA-1, hex. The sort is WeCom's, so it is done here rather than left to a
 * caller that might assume argument order.
 */
export function wecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypted].sort().join(""), "utf8").digest("hex");
}

/** Compare two signatures without leaking where they differ. */
export function wecomSignatureMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The 32-byte AES key an `EncodingAESKey` stands for.
 *
 * A key of any other length is refused rather than padded or truncated: a wrong
 * key would fail decryption anyway, and failing at the boundary names the
 * problem.
 */
export function wecomAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey.trim()}=`, "base64");
  if (key.length !== 32) {
    throw new Error("the EncodingAESKey is not 32 bytes once decoded");
  }
  return key;
}

/** What one decrypted callback carries. */
export type WecomPayload = {
  /** The XML (or JSON) body WeCom sent. */
  message: string;
  /** The corp id or suite id the payload was addressed to. */
  receiverId: string;
};

/**
 * Decrypt one `Encrypt` value.
 *
 * Throws on anything malformed — a length that runs past the buffer, padding
 * that does not repeat, a block count that is not a multiple of the block size.
 * A caller turns that into a typed refusal; it never becomes a crash.
 */
export function decryptWecomPayload(encodingAesKey: string, encrypted: string): WecomPayload {
  const key = wecomAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const cipherText = Buffer.from(encrypted, "base64");
  if (cipherText.length === 0 || cipherText.length % 16 !== 0) {
    throw new Error("the encrypted payload is not a whole number of AES blocks");
  }
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(cipherText), decipher.final()]);

  const pad = padded[padded.length - 1];
  if (pad === undefined || pad < 1 || pad > WECOM_PAD_BLOCK) {
    throw new Error("the payload padding is not a valid length");
  }
  for (let index = padded.length - pad; index < padded.length; index += 1) {
    if (padded[index] !== pad) throw new Error("the payload padding is not uniform");
  }
  const plain = padded.subarray(0, padded.length - pad);
  if (plain.length < WECOM_RANDOM_BYTES + WECOM_LENGTH_BYTES) {
    throw new Error("the decrypted payload is too short to carry a length");
  }
  const length = plain.readUInt32BE(WECOM_RANDOM_BYTES);
  const start = WECOM_RANDOM_BYTES + WECOM_LENGTH_BYTES;
  const end = start + length;
  if (end > plain.length) {
    throw new Error("the decrypted payload claims more bytes than it holds");
  }
  return {
    message: plain.subarray(start, end).toString("utf8"),
    receiverId: plain.subarray(end).toString("utf8"),
  };
}

/**
 * Encrypt one reply, in the shape WeCom accepts.
 *
 * A reply may be empty: `""` means "received, nothing to say", which is what
 * this channel answers with, because the turn runs asynchronously and its
 * answer leaves through the send API rather than through this response.
 */
export function encryptWecomPayload(
  encodingAesKey: string,
  message: string,
  receiverId: string,
  random?: Buffer,
): string {
  const key = wecomAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const body = Buffer.from(message, "utf8");
  const prefix = random && random.length === WECOM_RANDOM_BYTES ? random : randomBytes(WECOM_RANDOM_BYTES);
  const length = Buffer.alloc(WECOM_LENGTH_BYTES);
  length.writeUInt32BE(body.length, 0);
  const plain = Buffer.concat([prefix, length, body, Buffer.from(receiverId, "utf8")]);

  const padLength = WECOM_PAD_BLOCK - (plain.length % WECOM_PAD_BLOCK);
  const padded = Buffer.concat([plain, Buffer.alloc(padLength, padLength)]);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/** The reply envelope WeCom expects for an encrypted response. */
export function wecomReplyEnvelope(options: {
  token: string;
  encodingAesKey: string;
  receiverId: string;
  timestamp: string;
  nonce: string;
  message?: string;
}): string {
  const encrypted = encryptWecomPayload(
    options.encodingAesKey,
    options.message ?? "",
    options.receiverId,
  );
  const signature = wecomSignature(options.token, options.timestamp, options.nonce, encrypted);
  return [
    "<xml>",
    `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
    `<TimeStamp>${options.timestamp}</TimeStamp>`,
    `<Nonce><![CDATA[${options.nonce}]]></Nonce>`,
    "</xml>",
  ].join("");
}
