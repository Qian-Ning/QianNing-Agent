import { describe, expect, it } from "vitest";
import { PLACEHOLDER_NOTICE, needsPlaceholderNotice, withPlaceholderNotice } from "./notice.js";

const TOKEN = "{{PHONE_01M5W9JCQEGTQDQABQF85N50XR}}";

describe("needsPlaceholderNotice", () => {
  it("ignores bodies without a placeholder", () => {
    expect(needsPlaceholderNotice({ messages: [{ role: "user", content: "hello" }] })).toBe(false);
  });

  it("finds a placeholder nested in arrays and objects", () => {
    expect(
      needsPlaceholderNotice({ messages: [{ role: "user", content: [{ type: "text", text: `call ${TOKEN}` }] }] }),
    ).toBe(true);
  });

  it("does not mistake a near-miss for a token", () => {
    expect(needsPlaceholderNotice({ messages: [{ role: "user", content: "{{PHONE_1}}" }] })).toBe(false);
  });
});

describe("withPlaceholderNotice", () => {
  it("leaves a clean body untouched", () => {
    const payload = { system: "be brief", messages: [{ role: "user", content: "hi" }] };
    expect(withPlaceholderNotice(payload)).toBe(payload);
  });

  it("appends to an Anthropic string system prompt", () => {
    const payload = { system: "be brief", messages: [{ role: "user", content: TOKEN }] };
    const next = withPlaceholderNotice(payload) as { system: string };
    expect(next.system).toBe(`be brief\n\n${PLACEHOLDER_NOTICE}`);
  });

  it("appends to an Anthropic system block array", () => {
    const payload = { system: [{ type: "text", text: "be brief" }], messages: [{ role: "user", content: TOKEN }] };
    const next = withPlaceholderNotice(payload) as { system: Array<{ type: string; text: string }> };
    expect(next.system).toHaveLength(2);
    expect(next.system[1]).toEqual({ type: "text", text: PLACEHOLDER_NOTICE });
  });

  it("appends to an existing OpenAI system message", () => {
    const payload = {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: TOKEN },
      ],
    };
    const next = withPlaceholderNotice(payload) as { messages: Array<{ role: string; content: string }> };
    expect(next.messages[0]?.content).toBe(`be brief\n\n${PLACEHOLDER_NOTICE}`);
    expect(next.messages).toHaveLength(2);
  });

  it("prepends a system message when OpenAI has none", () => {
    const payload = { messages: [{ role: "user", content: TOKEN }] };
    const next = withPlaceholderNotice(payload) as { messages: Array<{ role: string; content: string }> };
    expect(next.messages[0]).toEqual({ role: "system", content: PLACEHOLDER_NOTICE });
    expect(next.messages).toHaveLength(2);
  });

  it("appends to OpenAI Responses instructions", () => {
    const payload = { instructions: "be brief", input: [{ role: "user", content: TOKEN }] };
    const next = withPlaceholderNotice(payload) as { instructions: string };
    expect(next.instructions).toBe(`be brief\n\n${PLACEHOLDER_NOTICE}`);
  });

  it("appends to Gemini systemInstruction parts", () => {
    const payload = {
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [{ role: "user", parts: [{ text: TOKEN }] }],
    };
    const next = withPlaceholderNotice(payload) as { systemInstruction: { parts: Array<{ text: string }> } };
    expect(next.systemInstruction.parts[1]).toEqual({ text: PLACEHOLDER_NOTICE });
  });

  it("returns an unrecognised shape unchanged rather than guessing", () => {
    const payload = { contents: [{ role: "user", parts: [{ text: TOKEN }] }] };
    expect(withPlaceholderNotice(payload)).toBe(payload);
  });
});
