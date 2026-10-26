import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "./index.js";
import { RestoreWindow } from "./restore-window.js";
import { RuleSet, builtinRules } from "./rules.js";
import { MappingStore } from "./store.js";
import { redactText, redactValue, restoreText } from "./walk.js";

const dirs: string[] = [];
const stores: MappingStore[] = [];

async function makeStore(): Promise<MappingStore> {
  const dir = await mkdtemp(join(tmpdir(), "redaction-walk-"));
  dirs.push(dir);
  const store = new MappingStore({ path: join(dir, "mappings.json") });
  stores.push(store);
  return store;
}

afterEach(async () => {
  // Let every pending atomic write finish before the directory goes away:
  // on Windows an open handle turns the cleanup into EBUSY.
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

const rules = new RuleSet({ rules: builtinRules() });

describe("payload walk", () => {
  it("replaces string values and leaves keys alone", async () => {
    const store = await makeStore();
    const payload = { model: "x", messages: [{ role: "user", content: "call 13812345678" }] };
    const output = redactValue(payload, rules, store) as typeof payload;
    expect(Object.keys(output)).toEqual(["model", "messages"]);
    expect(output.model).toBe("x");
    expect(output.messages[0]?.content).not.toContain("13812345678");
    expect(output.messages[0]?.content).toContain("{{PHONE_");
  });

  it("leaves base64 image data untouched", async () => {
    const store = await makeStore();
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", media_type: "image/png", data: "13812345678iVBORw0KGgo=" },
            { type: "text", text: "call 13812345678" },
          ],
        },
      ],
    };
    const output = redactValue(payload, rules, store) as typeof payload;
    expect(output.messages[0]?.content[0]?.data).toBe("13812345678iVBORw0KGgo=");
    expect(output.messages[0]?.content[1]?.text).not.toContain("13812345678");
  });

  it("round-trips one string", async () => {
    const store = await makeStore();
    const original = "server postgres://app:hunter2@db.internal and 13812345678";
    const redacted = redactText(original, rules, store);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("13812345678");
    expect(restoreText(redacted, store)).toBe(original);
  });

  it("leaves a token the table never issued as written", async () => {
    const store = await makeStore();
    const text = "example {{PHONE_01J0000000000000000000000}} stays";
    expect(restoreText(text, store)).toBe(text);
  });
});

describe("RestoreWindow", () => {
  it("restores a token split across chunks", async () => {
    const store = await makeStore();
    const token = store.getOrInsert("PHONE", "13812345678");
    const text = `call ${token} now`;
    const window = new RestoreWindow(store);
    let seen = "";
    for (let i = 0; i < text.length; i += 7) seen += window.push(text.slice(i, i + 7));
    seen += window.flush();
    expect(seen).toBe("call 13812345678 now");
  });

  it("does not delay text that cannot become a token", async () => {
    const store = await makeStore();
    const window = new RestoreWindow(store);
    expect(window.push("hello there")).toBe("hello there");
    expect(window.flush()).toBe("");
  });

  it("holds a trailing brace until the next chunk decides", async () => {
    const store = await makeStore();
    const token = store.getOrInsert("PHONE", "13812345678");
    const window = new RestoreWindow(store);
    const first = window.push(`x${token.slice(0, 1)}`);
    expect(first).toBe("x");
    expect(window.push(token.slice(1)) + window.flush()).toBe("13812345678");
  });
});

describe("createRedactor", () => {
  it("redacts a JSON string payload and restores the reply", async () => {
    const store = await makeStore();
    const redactor = createRedactor({ rules, store });
    const body = JSON.stringify({ messages: [{ role: "user", content: "key sk-ant-abcdefghijklmnopqrst" }] });
    const out = redactor.redactPayload(body) as string;
    expect(out).not.toContain("sk-ant-abcdefghijklmnopqrst");
    const content = (JSON.parse(out) as { messages: Array<{ content: string }> }).messages[0]?.content ?? "";
    expect(content).toContain("{{APIKEY_");
    expect(redactor.restoreText(content)).toBe("key sk-ant-abcdefghijklmnopqrst");
  });

  it("passes non-JSON text through string redaction", async () => {
    const store = await makeStore();
    const redactor = createRedactor({ rules, store });
    expect(redactor.redactPayload("bare 13812345678")).not.toContain("13812345678");
  });
});
