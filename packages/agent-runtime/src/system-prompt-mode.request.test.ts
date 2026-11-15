import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { DesktopAgentRuntime } from "./runtime.js";

const PERSONA = "PERSONA-MARKER: answer in one sentence and never explain.";

function sse(): string {
  return [
    `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
}

/** Run one turn against a local fixture provider and return the system prompt it received. */
async function systemPromptFor(mode: "replace" | "append"): Promise<string> {
  let captured: { messages?: { role?: string; content?: unknown }[] } | undefined;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      captured = JSON.parse(raw);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");

  const runtime = new DesktopAgentRuntime({
    host: { call: async () => ({}), onNotification: () => () => {} } as never,
    sessionId: `prompt-mode-${mode}`,
    mode: "agent",
    thinkingLevel: "off",
    provider: {
      id: "fixture",
      name: "Fixture",
      apiKey: "",
      authKind: "none",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: "fixture",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    systemPrompt: PERSONA,
    systemPromptMode: mode,
    onEvent: () => {},
  } as never);

  try {
    await runtime.prompt("hello");
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const system = captured?.messages?.find((message) => message.role === "system");
  if (!system) throw new Error("the request carried no system message");
  return typeof system.content === "string" ? system.content : JSON.stringify(system.content);
}

describe("system prompt mode, as the provider receives it", () => {
  it("append sends the built-in persona and the custom prompt in the same request", async () => {
    const system = await systemPromptFor("append");
    expect(system).toContain("You are QianNing Agent");
    expect(system).toContain(PERSONA);
  });

  it("replace sends the custom prompt and not the built-in persona", async () => {
    const system = await systemPromptFor("replace");
    expect(system).toContain(PERSONA);
    expect(system).not.toContain("You are QianNing Agent");
  });

  it("the operational rules survive both modes", async () => {
    for (const mode of ["replace", "append"] as const) {
      const system = await systemPromptFor(mode);
      expect(system, mode).toContain("## Safety");
      expect(system, mode).toContain("## Working agreement");
    }
  });
});
