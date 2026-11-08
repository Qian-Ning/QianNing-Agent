import { createCipheriv } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptWecomPayload,
  encryptWecomPayload,
  wecomAesKey,
  wecomReplyEnvelope,
  wecomSignature,
  wecomSignatureMatches,
} from "./messaging-wecom-crypto.js";

/** A well-formed 43-character key: 32 bytes once base64-decoded. */
const AES_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
  .toString("base64")
  .replace(/=+$/, "");
const TOKEN = "wecom-token";
const CORP_ID = "ww1234567890abcdef";

describe("the WeCom AES key", () => {
  it("decodes a 43-character EncodingAESKey to 32 bytes", () => {
    expect(wecomAesKey(AES_KEY)).toHaveLength(32);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => wecomAesKey("too-short")).toThrow(/32 bytes/);
  });
});

describe("the WeCom signature", () => {
  it("sorts its four parts, so argument order does not change the digest", () => {
    const a = wecomSignature(TOKEN, "1700000000", "nonce", "CIPHERTEXT");
    const b = wecomSignature("CIPHERTEXT", "nonce", TOKEN, "1700000000");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("compares in constant-ish time and still says no", () => {
    expect(wecomSignatureMatches("abcdef", "abcdef")).toBe(true);
    expect(wecomSignatureMatches("abcdef", "abcdeF")).toBe(false);
    expect(wecomSignatureMatches("abcdef", "abcde")).toBe(false);
  });
});

describe("the WeCom payload", () => {
  it("round-trips a message and its receiver id", () => {
    const encrypted = encryptWecomPayload(AES_KEY, "<xml>hi</xml>", CORP_ID);
    const decoded = decryptWecomPayload(AES_KEY, encrypted);
    expect(decoded).toEqual({ message: "<xml>hi</xml>", receiverId: CORP_ID });
  });

  it("round-trips an empty reply", () => {
    const encrypted = encryptWecomPayload(AES_KEY, "", CORP_ID);
    expect(decryptWecomPayload(AES_KEY, encrypted)).toEqual({ message: "", receiverId: CORP_ID });
  });

  it("round-trips a multi-byte message without counting characters as bytes", () => {
    const message = "<xml>深海热泉 — 42</xml>";
    const encrypted = encryptWecomPayload(AES_KEY, message, CORP_ID);
    expect(decryptWecomPayload(AES_KEY, encrypted).message).toBe(message);
  });

  it("refuses a payload that is not a whole number of blocks", () => {
    const broken = Buffer.from("not-a-block").toString("base64");
    expect(() => decryptWecomPayload(AES_KEY, broken)).toThrow(/AES blocks/);
  });

  it("refuses a payload decrypted with the wrong key instead of returning junk", () => {
    const otherKey = Buffer.from("fedcba9876543210fedcba9876543210", "utf8")
      .toString("base64")
      .replace(/=+$/, "");
    const encrypted = encryptWecomPayload(AES_KEY, "<xml>hi</xml>", CORP_ID);
    expect(() => decryptWecomPayload(otherKey, encrypted)).toThrow();
  });

  it("refuses a length that runs past the buffer", () => {
    // Encrypt a body whose length field has been inflated by hand.
    const key = wecomAesKey(AES_KEY);
    const iv = key.subarray(0, 16);
    const prefix = Buffer.alloc(16, 1);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(9999, 0);
    const plain = Buffer.concat([prefix, length, Buffer.from("<xml/>", "utf8"), Buffer.from(CORP_ID)]);
    const pad = 32 - (plain.length % 32);
    const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const forged = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
    expect(() => decryptWecomPayload(AES_KEY, forged)).toThrow(/more bytes/);
  });
});

describe("the WeCom reply envelope", () => {
  it("carries a signature over the payload it just produced", () => {
    const envelope = wecomReplyEnvelope({
      token: TOKEN,
      encodingAesKey: AES_KEY,
      receiverId: CORP_ID,
      timestamp: "1700000000",
      nonce: "nonce-1",
    });
    expect(envelope).toContain("<Encrypt><![CDATA[");
    const encrypted = /<Encrypt><!\[CDATA\[([^\]]+)\]\]><\/Encrypt>/.exec(envelope)?.[1];
    expect(encrypted).toBeTruthy();
    const signature = /<MsgSignature><!\[CDATA\[([^\]]+)\]\]><\/MsgSignature>/.exec(envelope)?.[1];
    expect(signature).toBe(wecomSignature(TOKEN, "1700000000", "nonce-1", encrypted!));
    expect(decryptWecomPayload(AES_KEY, encrypted!).message).toBe("");
  });
});
