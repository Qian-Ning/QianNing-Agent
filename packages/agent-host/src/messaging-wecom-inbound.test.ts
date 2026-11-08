import { describe, expect, it } from "vitest";

import { encryptWecomPayload, wecomSignature } from "./messaging-wecom-crypto.js";
import {
  createWecomAdapter,
  createWecomHandshake,
  createWecomVerifier,
  parseWecomXml,
  wecomEncrypted,
} from "./messaging-wecom-inbound.js";

const AES_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
  .toString("base64")
  .replace(/=+$/, "");
const TOKEN = "wecom-token";
const CORP_ID = "ww1234567890abcdef";

/** One encrypted callback, the way WeCom builds it. */
function callback(
  fields: Record<string, string>,
  options: { corpId?: string } = {},
): { body: string; url: URL } {
  const inner = [
    "<xml>",
    ...Object.entries(fields).map(([key, value]) => `<${key}><![CDATA[${value}]]></${key}>`),
    "</xml>",
  ].join("");
  const encrypted = encryptWecomPayload(AES_KEY, inner, options.corpId ?? CORP_ID);
  const body = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
  const timestamp = "1700000000";
  const nonce = "nonce-1";
  const signature = wecomSignature(TOKEN, timestamp, nonce, encrypted);
  const url = new URL(
    `http://localhost/webhooks/wecom?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
  );
  return { body, url };
}

function normalise(body: string) {
  const adapter = createWecomAdapter({ encodingAesKey: AES_KEY, corpId: CORP_ID });
  return adapter.normalise(adapter.parse!(body));
}

describe("the WeCom XML reader", () => {
  it("reads flat tags, CDATA or plain", () => {
    const fields = parseWecomXml(
      "<xml><A><![CDATA[one]]></A><B>two</B><C></C></xml>",
    );
    expect(fields).toEqual({ A: "one", B: "two", C: "" });
  });

  it("finds the encrypted payload in an envelope", () => {
    expect(wecomEncrypted("<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>")).toBe("abc");
    expect(wecomEncrypted("<xml><Encrypt></Encrypt></xml>")).toBeNull();
  });
});

describe("the WeCom adapter", () => {
  it("projects a text message onto the shared shape", () => {
    const { body } = callback({
      ToUserName: CORP_ID,
      FromUserName: "zhangsan",
      CreateTime: "1700000000",
      MsgType: "text",
      Content: "你好",
      MsgId: "1000000000000001",
      AgentID: "1000002",
    });
    const result = normalise(body);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "1000000000000001",
      chatId: "zhangsan",
      text: "你好",
      chatKind: "private",
      sender: { id: "zhangsan" },
      sentAt: 1700000000000,
    });
  });

  it("filters an event callback", () => {
    const { body } = callback({
      FromUserName: "zhangsan",
      MsgType: "event",
      Event: "enter_agent",
      CreateTime: "1700000000",
    });
    const result = normalise(body);
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("enter_agent");
  });

  it("filters a non-text message", () => {
    const { body } = callback({
      FromUserName: "zhangsan",
      MsgType: "image",
      CreateTime: "1700000000",
      MsgId: "1",
    });
    expect(normalise(body).kind).toBe("filtered");
  });

  it("filters an envelope addressed to another corp", () => {
    const { body } = callback(
      { FromUserName: "zhangsan", MsgType: "text", Content: "hi", MsgId: "1", CreateTime: "1700000000" },
      { corpId: "wwOTHER" },
    );
    const result = normalise(body);
    expect(result.kind).toBe("filtered");
    expect(result.kind === "filtered" && result.reason).toContain("another corp");
  });

  it("throws on a body it cannot decrypt, which the receiver answers 401", () => {
    const adapter = createWecomAdapter({ encodingAesKey: AES_KEY, corpId: CORP_ID });
    expect(() => adapter.parse!("<xml><Encrypt><![CDATA[bm90LWEtYmxvY2s=]]></Encrypt></xml>")).toThrow();
  });
});

describe("the WeCom verifier", () => {
  const verify = (body: string, url: URL) =>
    createWecomVerifier(TOKEN).verify(Buffer.from(body, "utf8"), {}, url);

  it("accepts a correctly signed callback and reports seconds as milliseconds", () => {
    const { body, url } = callback({ MsgType: "text", Content: "hi", FromUserName: "u", MsgId: "1" });
    const result = verify(body, url);
    expect(result).toMatchObject({ ok: true, timestampMs: 1700000000000 });
  });

  it("refuses a signature over different bytes", () => {
    const { body, url } = callback({ MsgType: "text", Content: "hi", FromUserName: "u", MsgId: "1" });
    url.searchParams.set("nonce", "another-nonce");
    expect(verify(body, url)).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a callback with no signature in the query", () => {
    const { body } = callback({ MsgType: "text", Content: "hi", FromUserName: "u", MsgId: "1" });
    expect(verify(body, new URL("http://localhost/webhooks/wecom"))).toMatchObject({
      ok: false,
      reason: "missing-signature",
    });
  });
});

describe("the WeCom GET handshake", () => {
  it("answers the decrypted echo", () => {
    const echo = encryptWecomPayload(AES_KEY, "1234567890123456", CORP_ID);
    const timestamp = "1700000000";
    const nonce = "n";
    const signature = wecomSignature(TOKEN, timestamp, nonce, echo);
    const url = new URL(
      `http://localhost/webhooks/wecom?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echo)}`,
    );
    const answer = createWecomHandshake({ token: TOKEN, encodingAesKey: AES_KEY })(url);
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("1234567890123456");
  });

  it("refuses a handshake signed with another token", () => {
    const echo = encryptWecomPayload(AES_KEY, "x", CORP_ID);
    const url = new URL(
      `http://localhost/webhooks/wecom?msg_signature=${wecomSignature("wrong", "1", "n", echo)}&timestamp=1&nonce=n&echostr=${encodeURIComponent(echo)}`,
    );
    expect(createWecomHandshake({ token: TOKEN, encodingAesKey: AES_KEY })(url).status).toBe(401);
  });
});
