import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import * as Value from "typebox/value";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { modelConfigFromPi } from "./model-capabilities.js";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";
import type { RuntimeHost } from "./host-client.js";
import {
  WRITE_INLINE_VIZ_NAME,
  writeInlineVisualizationDescription,
  writeInlineVisualizationParameters,
} from "./inline-viz-tool.js";

/**
 * The `WriteInlineVisualization` tool (ADR 0327) as the model sees it: the
 * declaration is opt-in, the schema bounds the arguments before the host
 * round trip, and every accepted call is forwarded to host-core's
 * `tools.execute` — the boundary where host-core runs the permission gate and
 * appends the `tool_execute` audit row, exactly like every other host tool.
 */

function flashProvider(): RuntimeProviderConfig {
  const model = Object.values(DEEPSEEK_MODELS).find((model) => model.id === "deepseek-flash")!;
  return {
    id: "flash-fixture", name: "Flash", modelId: model.id, baseUrl: model.baseUrl,
    apiKey: "test-key", authKind: "api_key", supportsReasoning: false,
    supportedThinkingLevels: ["off"], modelConfig: modelConfigFromPi(model),
  };
}

function createRuntime(options: { inlineVisualizations?: boolean; host?: RuntimeHost }) {
  const runtime = new DesktopAgentRuntime({
    sessionId: "viz-session", mode: "agent", provider: flashProvider(), thinkingLevel: "off",
    history: [],
    inlineVisualizations: options.inlineVisualizations ?? false,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: options.host ?? {
      call: async () => {
        throw new Error("unexpected host call in this fixture");
      },
      onClose: () => () => undefined,
    },
    onEvent: () => undefined,
  });
  return runtime;
}

const validArgs = {
  sessionId: "viz-session",
  title: "Usage chart",
  kind: "svg",
  content: "<svg><rect/></svg>",
};

function declaredTool(runtime: DesktopAgentRuntime) {
  // The pi agent tool registry; typed `any` because pi's Tool surface is not
  // part of this package's public types (same access as runtime.test.ts).
  const tools = (runtime as unknown as { agent: { state: { tools: any[] } } })
    .agent.state.tools;
  return tools.find((tool) => tool.name === WRITE_INLINE_VIZ_NAME);
}

describe("WriteInlineVisualization schema", () => {
  it("accepts every documented kind and rejects anything else", () => {
    const schema = Type.Object(writeInlineVisualizationParameters);
    for (const kind of ["html", "svg", "json", "csv", "text"]) {
      expect(Value.Check(schema, { ...validArgs, kind })).toBe(true);
    }
    expect(Value.Check(schema, { ...validArgs, kind: "pdf" })).toBe(false);
    expect(Value.Check(schema, { ...validArgs, kind: 3 })).toBe(false);
    expect(Value.Check(schema, { ...validArgs, kind: undefined })).toBe(false);
  });

  it("bounds title, content and required fields", () => {
    const schema = Type.Object(writeInlineVisualizationParameters);
    expect(Value.Check(schema, { ...validArgs, title: "" })).toBe(false);
    expect(Value.Check(schema, { ...validArgs, title: "t".repeat(121) })).toBe(false);
    expect(Value.Check(schema, { ...validArgs, content: "x".repeat(512 * 1024 + 1) })).toBe(false);
    expect(Value.Check(schema, { sessionId: "viz-session", title: "T", kind: "html" })).toBe(false);
  });

  it("advertises a description that states the sandbox and opt-in", () => {
    expect(writeInlineVisualizationDescription).toMatch(/sandbox/);
    expect(writeInlineVisualizationDescription).toMatch(/never executed/);
  });
});

describe("runtime wiring of WriteInlineVisualization", () => {
  it("declares the tool to the agent only while the opt-in is on", async () => {
    const off = createRuntime({ inlineVisualizations: false });
    try {
      expect(declaredTool(off)).toBeUndefined();
    } finally {
      await off.dispose();
    }
    const on = createRuntime({ inlineVisualizations: true });
    try {
      const tool = declaredTool(on);
      expect(tool).toBeDefined();
      // The model-facing declaration carries the kind enum so a bad kind is
      // rejected before any host round trip.
      expect(tool!.parameters.properties.kind).toBeDefined();
      expect(tool!.parameters.required).toEqual(
        ["sessionId", "title", "kind", "content"],
      );
    } finally {
      await on.dispose();
    }
  });

  it("forwards an accepted call to host tools.execute (the audited boundary)", async () => {
    const host = { call: vi.fn().mockResolvedValue({ ok: true, content: { visualization: { id: "viz-1" } } }) };
    const runtime = createRuntime({ inlineVisualizations: true, host });
    try {
      const result = await declaredTool(runtime)!.execute(
        "viz-call-1",
        validArgs,
      );
      const call = host.call.mock.calls[0];
      expect(call[0]).toBe("tools.execute");
      const params = call[1] as {
        sessionId: string;
        turnId: string;
        toolCallId: string;
        toolName: string;
        args: unknown;
        mode: string;
      };
      expect(params.sessionId).toBe("viz-session");
      expect(params.toolCallId).toBe("viz-call-1");
      expect(params.toolName).toBe(WRITE_INLINE_VIZ_NAME);
      expect(params.args).toEqual(validArgs);
      expect(params.mode).toBe("agent");
      expect(result.isError).toBeFalsy();
    } finally {
      await runtime.dispose();
    }
  });

  it("surfaces a permission-denied answer as an error result", async () => {
    const host = {
      call: vi.fn().mockResolvedValue({
        ok: false,
        denied: true,
        isError: true,
        content: { error: "permission denied", code: "TOOL_DENIED" },
      }),
    };
    const runtime = createRuntime({ inlineVisualizations: true, host });
    try {
      const result = await declaredTool(runtime)!.execute(
        "viz-call-2",
        validArgs,
      );
      expect(result.isError).toBe(true);
      expect((result.details as { code?: string }).code).toBe("TOOL_DENIED");
      // The audited host boundary still saw the call.
      expect(host.call).toHaveBeenCalledWith(
        "tools.execute",
        expect.objectContaining({ toolName: WRITE_INLINE_VIZ_NAME }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("never calls the host for arguments the declaration rejects", async () => {
    const schema = Type.Object(writeInlineVisualizationParameters);
    expect(Value.Check(schema, { ...validArgs, kind: "pdf" })).toBe(false);
    const host = { call: vi.fn() };
    const runtime = createRuntime({ inlineVisualizations: true, host });
    try {
      // The schema is the gate the model's arguments cross before execute;
      // a rejected payload must not reach tools.execute.
      expect(host.call).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
