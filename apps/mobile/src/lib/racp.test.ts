import { describe, expect, it } from "vitest";
import { normalizeBase, toMessageItem } from "./racp";

describe("normalizeBase", () => {
  it("keeps an explicit scheme and drops a trailing slash", () => {
    expect(normalizeBase("https://192.168.1.5:4331/")).toBe("https://192.168.1.5:4331");
  });

  it("assumes https for a bare LAN address", () => {
    expect(normalizeBase("192.168.1.5:4331")).toBe("https://192.168.1.5:4331");
  });

  it("assumes http only for the loopback", () => {
    expect(normalizeBase("localhost:4331")).toBe("http://localhost:4331");
    expect(normalizeBase("127.0.0.1:4331")).toBe("http://127.0.0.1:4331");
  });

  it("strips the fragment so a pairing token never rides along", () => {
    expect(normalizeBase("https://host:4331/#t=abc")).toBe("https://host:4331");
  });

  it("returns empty for empty input", () => {
    expect(normalizeBase("   ")).toBe("");
  });
});

describe("toMessageItem", () => {
  it("reads a user message out of a message_start frame", () => {
    const item = toMessageItem({
      itemType: "message",
      itemId: "m1",
      event: { type: "message_start", message: { role: "user", content: "hello", status: "complete" } },
    });
    expect(item).toMatchObject({ itemId: "m1", role: "user", text: "hello" });
  });

  it("keeps a tool call even when it has no readable payload", () => {
    const item = toMessageItem({ itemType: "tool", itemId: "t1", name: "shell" });
    expect(item?.role).toBe("tool");
    expect(item?.toolName).toBe("shell");
  });

  it("joins tool input and output into one line of detail", () => {
    const item = toMessageItem({
      itemType: "tool",
      itemId: "t2",
      tool: { name: "read", input: { path: "a.ts" }, output: "ok" },
    });
    expect(item?.toolDetail).toContain("a.ts");
    expect(item?.toolDetail).toContain("ok");
  });

  it("marks a failed tool call", () => {
    const item = toMessageItem({ itemType: "tool", itemId: "t3", name: "shell", status: "failed" });
    expect(item?.toolFailed).toBe(true);
  });

  it("flattens block content into text", () => {
    const item = toMessageItem({
      itemType: "message",
      itemId: "m2",
      event: { message: { role: "assistant", content: [{ text: "a" }, { text: "b" }] } },
    });
    expect(item?.text).toBe("ab");
  });


  it("reads a stored history row, whose message sits under content", () => {
    const item = toMessageItem({
      id: "h1",
      itemType: "message",
      status: "completed",
      content: { role: "user", content: "你好" },
    });
    expect(item).toMatchObject({ itemId: "h1", role: "user", text: "你好" });
  });

  it("drops an entry with no id, because it cannot be keyed or updated", () => {
    expect(toMessageItem({ itemType: "message" })).toBeNull();
  });
});
