import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createWeixinAdapter,
  createWeixinHandshake,
  createWeixinVerifier,
  weixinSignature,
} from "./messaging-weixin-inbound.js";

const TOKEN = "wechat-token-value";
const ACCOUNT = "gh_abcdef123456";

function signedUrl(path: string, extra: Record<string, string> = {}): URL {
  const timestamp = "1700000000";
  const nonce = "n0nce";
  const signature = createHash("sha1")
    .update([TOKEN, timestamp, nonce].sort().join(""), "utf8")
    .digest("hex");
  const params = new URLSearchParams({ signature, timestamp, nonce, ...extra });
  return new URL(`https://host.test${path}?${params.toString()}`);
}

function xml(fields: Record<string, string>): string {
  const inner = Object.entries(fields)
    .map(([key, value]) => `<${key}><![CDATA[${value}]]></${key}>`)
    .join("");
  return `<xml>${inner}</xml>`;
}

const textMessage = {
  ToUserName: ACCOUNT,
  FromUserName: "oUser123",
  CreateTime: "1700000000",
  MsgType: "text",
  Content: "deploy please",
  MsgId: "1000000001",
};

describe("the WeChat signature", () => {
  it("is sha1 over the sorted token, timestamp and nonce", () => {
    const expected = createHash("sha1").update(["a", "b", "c"].sort().join(""), "utf8").digest("hex");
    expect(weixinSignature("a", "b", "c")).toBe(expected);
  });
});

describe("the WeChat verifier", () => {
  const verifier = createWeixinVerifier({ token: TOKEN });

  it("accepts a query signed with the token", async () => {
    expect(await verifier.verify(Buffer.from(""), {}, signedUrl("/webhooks/weixin"))).toMatchObject({
      ok: true,
    });
  });

  it("refuses another token", async () => {
    const url = signedUrl("/webhooks/weixin");
    url.searchParams.set("signature", "0".repeat(40));
    expect(await verifier.verify(Buffer.from(""), {}, url)).toMatchObject({
      ok: false,
      reason: "signature-mismatch",
    });
  });

  it("refuses a request with no signature", async () => {
    expect(
      await verifier.verify(Buffer.from(""), {}, new URL("https://host.test/webhooks/weixin")),
    ).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses when it is given no URL at all", async () => {
    expect(await verifier.verify(Buffer.from(""), {})).toMatchObject({ ok: false });
  });

  it("names a delivery id stable across a redelivery", async () => {
    const first = await verifier.verify(Buffer.from(""), {}, signedUrl("/webhooks/weixin"));
    const second = await verifier.verify(Buffer.from(""), {}, signedUrl("/webhooks/weixin"));
    expect(first.ok && first.deliveryId).toBe(second.ok && second.deliveryId);
  });
});

describe("the WeChat handshake", () => {
  const handshake = createWeixinHandshake({ token: TOKEN });

  it("echoes the challenge for a signed request", () => {
    const url = signedUrl("/webhooks/weixin", { echostr: "42" });
    expect(handshake(url)).toMatchObject({ status: 200, body: "42" });
  });

  it("refuses an unsigned request", () => {
    const url = new URL("https://host.test/webhooks/weixin?echostr=42");
    expect(handshake(url)).toMatchObject({ status: 403 });
  });
});

describe("the WeChat adapter", () => {
  const adapter = createWeixinAdapter({ accountId: ACCOUNT });

  it("projects a text message onto the shared shape", () => {
    const result = adapter.normalise(adapter.parse?.(xml(textMessage)));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "1000000001",
      chatId: "oUser123",
      text: "deploy please",
      chatKind: "private",
    });
  });

  it("filters a non-text message", () => {
    const result = adapter.normalise(
      adapter.parse?.(xml({ ...textMessage, MsgType: "image", Content: "" })),
    );
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("image");
  });

  it("filters a message addressed to another account", () => {
    const result = adapter.normalise(
      adapter.parse?.(xml({ ...textMessage, ToUserName: "gh_other" })),
    );
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("another account");
  });

  it("filters a message with no id", () => {
    const { MsgId: _dropped, ...rest } = textMessage;
    const result = adapter.normalise(adapter.parse?.(xml(rest)));
    expect(result.kind).toBe("filtered");
  });
});
