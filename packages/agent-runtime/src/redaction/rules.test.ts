import { describe, expect, it } from "vitest";
import { RuleSet, builtinRules } from "./rules.js";

const rules = new RuleSet({ rules: builtinRules() });

describe("builtin rules", () => {
  it("finds a mobile number", () => {
    const hits = rules.findHits("打 13812345678 联系我");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe("PHONE");
    expect(hits[0]?.text).toBe("13812345678");
  });

  it("does not read a longer digit run as a mobile number", () => {
    expect(rules.findHits("订单 138123456789")).toHaveLength(0);
  });

  it("finds an 18-digit id card", () => {
    const hits = rules.findHits("身份证 11010519491231002X");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe("IDCARD");
  });

  it("finds a PEM private key block", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const hits = rules.findHits(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe("PEM");
    expect(hits[0]?.text).toBe(text);
  });

  it("finds an anthropic key and a github token", () => {
    const hits = rules.findHits(
      "key sk-ant-api03-abcdefghijklmnop and token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(hits.map((hit) => hit.type)).toEqual(["APIKEY", "APIKEY"]);
  });

  it("replaces only the password segment of a connection string", () => {
    const text = "postgres://app:hunter2@db.internal:5432/orders";
    const hits = rules.findHits(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe("CONNSTR");
    expect(hits[0]?.text).toBe("hunter2");
  });

  it("keeps email disabled by default", () => {
    expect(rules.findHits("write to ops@acme.test")).toHaveLength(0);
  });

  it("honours the allowlist", () => {
    const withEmail = new RuleSet({ rules: builtinRules().map((rule) => ({ ...rule, enabled: rule.id === "email" ? true : rule.enabled })) });
    expect(withEmail.findHits("docs@example.com")).toHaveLength(0);
    expect(withEmail.findHits("ops@acme.test")).toHaveLength(1);
  });

  it("never reports overlapping spans, and prefers the higher priority rule", () => {
    // The password inside the connection string also looks like a token; the
    // connection-string rule wins and the span is reported once.
    const text = "redis://user:sk-abcdefghijklmnopqrstuvwxyz@cache:6379";
    const hits = rules.findHits(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe("CONNSTR");
  });

  it("returns hits in text order", () => {
    const hits = rules.findHits("a 13812345678 b 13912345678 c");
    expect(hits.map((hit) => hit.start)).toEqual([...hits.map((hit) => hit.start)].sort((a, b) => a - b));
    expect(hits).toHaveLength(2);
  });
});
