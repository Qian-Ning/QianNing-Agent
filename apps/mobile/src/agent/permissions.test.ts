import { describe, expect, it, vi } from "vitest";
import {
  PermissionBroker,
  normalizePermissionMode,
  requiresApproval,
  type PermissionRequest,
} from "./permissions";
import { createTools } from "./tools";
import { MemoryStore } from "./store";
import { toDesktopEvents } from "../bridge/agent-events";

function broker(mode: "ask" | "accept-edits" | "auto", timeoutMs = 5_000) {
  const asked: PermissionRequest[] = [];
  const instance = new PermissionBroker((request) => asked.push(request), {
    mode,
    timeoutMs,
    newId: () => `req_${asked.length + 1}`,
  });
  return { instance, asked };
}

function writeTool(store: MemoryStore, approve: Parameters<typeof createTools>[2]) {
  return createTools(store, () => null, approve).find((tool) => tool.name === "write_file")!;
}

describe("permission modes", () => {
  it("maps unknown values to the safe default", () => {
    expect(normalizePermissionMode(undefined)).toBe("accept-edits");
    expect(normalizePermissionMode("nonsense")).toBe("accept-edits");
    expect(normalizePermissionMode("auto")).toBe("auto");
  });

  it("only asks for what a mode gates", () => {
    expect(requiresApproval("auto", "write_file")).toBe(false);
    expect(requiresApproval("auto", "fetch_url")).toBe(false);
    expect(requiresApproval("accept-edits", "write_file")).toBe(false);
    expect(requiresApproval("accept-edits", "fetch_url")).toBe(true);
    expect(requiresApproval("ask", "write_file")).toBe(true);
    expect(requiresApproval("ask", "fetch_url")).toBe(true);
  });
});

describe("PermissionBroker", () => {
  it("lets auto through without asking", async () => {
    const { instance, asked } = broker("auto");
    await expect(
      instance.approve({
        sessionId: "s1",
        toolCallId: "t1",
        toolName: "write_file",
        action: "write_file",
        argsPreview: {},
      }),
    ).resolves.toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("asks, then allows once", async () => {
    const { instance, asked } = broker("ask");
    const pending = instance.approve({
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "write_file",
      action: "write_file",
      argsPreview: { path: "notes.md" },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].risk).toBe("write");
    expect(instance.resolve(asked[0].requestId, "allow-once")).toBe(true);
    await expect(pending).resolves.toBe(true);

    const second = instance.approve({
      sessionId: "s1",
      toolCallId: "t2",
      toolName: "write_file",
      action: "write_file",
      argsPreview: {},
    });
    expect(asked).toHaveLength(2);
    instance.resolve(asked[1].requestId, "deny");
    await expect(second).resolves.toBe(false);
  });

  it("remembers a session grant for the same action only", async () => {
    const { instance, asked } = broker("ask");
    const first = instance.approve({
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "write_file",
      action: "write_file",
      argsPreview: {},
    });
    instance.resolve(asked[0].requestId, "allow-session");
    await expect(first).resolves.toBe(true);

    await expect(
      instance.approve({
        sessionId: "s1",
        toolCallId: "t2",
        toolName: "write_file",
        action: "write_file",
        argsPreview: {},
      }),
    ).resolves.toBe(true);
    expect(asked).toHaveLength(1);

    // A fetch is a different action, so it still asks.
    void instance.approve({
      sessionId: "s1",
      toolCallId: "t3",
      toolName: "fetch_url",
      action: "fetch_url",
      argsPreview: {},
    });
    expect(asked).toHaveLength(2);
  });

  it("denies when nobody answers in time", async () => {
    vi.useFakeTimers();
    try {
      const { instance } = broker("ask", 50);
      const pending = instance.approve({
        sessionId: "s1",
        toolCallId: "t1",
        toolName: "write_file",
        action: "write_file",
        argsPreview: {},
      });
      vi.advanceTimersByTime(60);
      await expect(pending).resolves.toBe(false);
      expect(instance.pendingIds()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an answer for a request that is gone", () => {
    const { instance } = broker("ask");
    expect(instance.resolve("nope", "allow-once")).toBe(false);
  });
});

describe("tools under a permission mode", () => {
  it("refuses the write when the user denies", async () => {
    const store = new MemoryStore();
    const tool = writeTool(store, async () => false);
    const result = await tool.execute("call-1", { path: "a.md", content: "hi" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(store.readValue("file:a.md")).toBeNull();
  });

  it("writes when the user allows", async () => {
    const store = new MemoryStore();
    const tool = writeTool(store, async () => true);
    const result = await tool.execute("call-1", { path: "a.md", content: "hi" });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(store.readValue("file:a.md")).toBe("hi");
  });

  it("does not call the approver for reads", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const tools = createTools(store, () => null, async () => {
      calls += 1;
      return true;
    });
    const list = tools.find((tool) => tool.name === "list_files")!;
    await list.execute("call-2", {} as never);
    expect(calls).toBe(0);
  });
});

describe("permission events", () => {
  it("reaches the renderer as tool_permission_request", () => {
    const request = {
      requestId: "req_1",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "write_file",
      argsPreview: { path: "a.md" },
      risk: "write",
      reason: "writes a file in app storage",
    };
    const [envelope] = toDesktopEvents(
      { sessionId: "s1", kind: "permission.requested", payload: { request } },
      1_700_000_000_000,
    );
    expect(envelope.event).toMatchObject({ type: "tool_permission_request", request });
  });

  it("drops a permission event with no request", () => {
    expect(
      toDesktopEvents({ sessionId: "s1", kind: "permission.requested", payload: {} }, 1),
    ).toEqual([]);
  });
});
