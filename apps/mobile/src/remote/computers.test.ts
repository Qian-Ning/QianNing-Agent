import { beforeEach, describe, expect, it, vi } from "vitest";

import { REMOTE_UNREACHABLE } from "@pi-desktop/shared";

import {
  fetchApprovals,
  fetchChat,
  fetchHistory,
  fetchSessions,
  listComputers,
  normalizeAddress,
  pairComputer,
  removeComputer,
  respondApproval,
  sendTurn,
} from "./computers";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const plugins: Record<string, unknown> = {};
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: { Plugins: plugins },
    localStorage,
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = localStorage;
});

function stubRemote(overrides: {
  certificate?: { pem: string; fingerprint: string };
  request?: (options: { path: string; method: string; token: string }) => {
    status: number;
    body: string;
  };
}) {
  const plugins = (globalThis as unknown as { window: { Capacitor: { Plugins: Record<string, unknown> } } })
    .window.Capacitor.Plugins;
  const request = vi.fn(async (options: { path: string; method: string; token: string }) =>
    overrides.request
      ? overrides.request(options)
      : { status: 200, body: JSON.stringify({ result: { sessions: [] } }) },
  );
  plugins.QnRemote = {
    fetchCertificate: vi.fn(async () => overrides.certificate ?? { pem: "-----BEGIN CERTIFICATE-----", fingerprint: "AA:BB" }),
    request,
  };
  return { request };
}

describe("addresses", () => {
  it("accepts what a person reads off the desktop", () => {
    expect(normalizeAddress(" 192.168.1.8:7317 ")).toBe("https://192.168.1.8:7317");
    expect(normalizeAddress("https://192.168.1.8:7317/")).toBe("https://192.168.1.8:7317");
  });

  it("refuses a plaintext address instead of silently upgrading it", () => {
    expect(() => normalizeAddress("http://192.168.1.8:7317")).toThrow(/https/);
  });

  it("insists on the port, because the desktop never listens on 443", () => {
    expect(() => normalizeAddress("192.168.1.8")).toThrow(/port/);
  });
});

describe("pairing", () => {
  it("keeps the certificate it pinned and replaces a repeat pairing", async () => {
    stubRemote({ certificate: { pem: "PEM-ONE", fingerprint: "AA:BB" } });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    stubRemote({ certificate: { pem: "PEM-TWO", fingerprint: "CC:DD" } });
    await pairComputer({ url: "https://192.168.1.8:7317", token: "pdt1.two" });

    const computers = listComputers();
    expect(computers).toHaveLength(1);
    expect(computers[0]?.pem).toBe("PEM-TWO");
    expect(computers[0]?.token).toBe("pdt1.two");
    expect(computers[0]?.label).toBe("192.168.1.8");
  });

  it("will not pair without a token", async () => {
    stubRemote({});
    await expect(pairComputer({ url: "192.168.1.8:7317", token: "  " })).rejects.toThrow(/token/);
    expect(listComputers()).toHaveLength(0);
  });

  it("survives a corrupted store instead of throwing on open", () => {
    store.set("qn.remote.computers", "{not json");
    expect(listComputers()).toEqual([]);
  });

  it("forgets a computer", async () => {
    stubRemote({});
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    expect(removeComputer("https://192.168.1.8:7317")).toBe(true);
    expect(listComputers()).toEqual([]);
  });
});

describe("talking to a paired computer", () => {
  it("sends the pinned certificate and the device token on every call", async () => {
    const remote = stubRemote({});
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await fetchSessions(listComputers()[0]!);

    const call = remote.request.mock.calls[0]?.[0] as unknown as {
      url: string;
      path: string;
      token: string;
      pem: string;
    };
    expect(call.url).toBe("https://192.168.1.8:7317");
    expect(call.path).toBe("/v1/sessions");
    expect(call.token).toBe("pdt1.one");
    expect(call.pem).toBe("-----BEGIN CERTIFICATE-----");
  });

  it("reads the sessions envelope and sorts newest first", async () => {
    stubRemote({
      request: () => ({
        status: 200,
        body: JSON.stringify({
          result: {
            sessions: [
              { id: "s1", title: "Older", updatedAt: 100 },
              { id: "s2", title: "Newer", updatedAt: 900 },
              { id: "s3", updatedAt: 500 },
              { nope: true },
            ],
          },
        }),
      }),
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    const sessions = await fetchSessions(listComputers()[0]!);

    expect(sessions.map((session) => session.id)).toEqual(["s2", "s3", "s1"]);
    expect(sessions[1]?.title).toBe("未命名会话");
  });

  it("turns a rejected token into a sentence, not a status code", async () => {
    stubRemote({ request: () => ({ status: 401, body: "" }) });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await expect(fetchSessions(listComputers()[0]!)).rejects.toThrow(/device token/);
  });

  it("collapses a socket timeout into a code the screen can phrase", async () => {
    // The platform's own wording names two ports and elapsed milliseconds, which
    // is exactly what the phone showed when the desktop's listener was closed.
    stubRemote({
      request: () => {
        throw new Error(
          "failed to connect to /192.168.10.104 (port 6838) from /192.168.10.71 (port 47018) after 15000ms",
        );
      },
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await expect(fetchSessions(listComputers()[0]!)).rejects.toThrow(REMOTE_UNREACHABLE);
  });

  it("reduces a transcript to the lines a phone can show", async () => {
    stubRemote({
      request: () => ({
        status: 200,
        body: JSON.stringify({
          result: {
            items: [
              { id: "i1", itemType: "message", content: { role: "user", content: "把日志清一下" } },
              {
                id: "i2",
                itemType: "message",
                status: "streaming",
                content: { role: "assistant", content: [{ type: "text", text: "" }] },
              },
              {
                id: "i2",
                itemType: "message",
                content: {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "internal" },
                    { type: "text", text: "清完了。" },
                  ],
                },
              },
              { id: "i3", itemType: "tool", content: { toolCallId: "i3", toolName: "shell", args: {} } },
              { id: "i3", itemType: "tool", content: { toolCallId: "i3", result: "ok", isError: false } },
              { id: "i4", itemType: "compaction", content: {} },
              { id: "i5", itemType: "message", content: { role: "assistant", content: "" } },
              { id: "i6", itemType: "message", content: { role: "assistant", content: { odd: true } } },
              {
                id: "i7",
                itemType: "message",
                content: { role: "tool", toolName: "Connection", content: '{"ok":true}' },
              },
              { id: "i8", itemType: "message", content: { role: "system", content: "runtime rules" } },
            ],
          },
        }),
      }),
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });

    const messages = await fetchHistory(listComputers()[0]!, "s1");

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "note", "tool"]);
    expect(messages[1]?.text).toBe("清完了。");
    expect(messages[2]?.toolName).toBe("shell");
    // A tool result is a name, never its JSON payload.
    expect(messages[4]?.toolName).toBe("Connection");
    expect(messages[4]?.text).toBe("Connection");
  });

  it("sends a prompt into a conversation on that computer", async () => {
    const seen: Array<{ path: string; method: string; body?: unknown }> = [];
    stubRemote({
      request: (options) => {
        seen.push(options as { path: string; method: string });
        return { status: 200, body: JSON.stringify({ result: { turnId: "t1" } }) };
      },
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await sendTurn(listComputers()[0]!, "s1", "  继续  ");

    const post = seen.at(-1) as { path: string; method: string; body: string };
    expect(post.method).toBe("POST");
    expect(post.path).toBe("/v1/sessions/s1/turns");
    const payload = JSON.parse(post.body) as { input: { text: string }; context: { requestId: string } };
    expect(payload.input.text).toBe("继续");
    expect(payload.context.requestId).toBeTruthy();
  });

  it("reads the approvals a turn is blocked on", async () => {
    stubRemote({
      request: () => ({
        status: 200,
        body: JSON.stringify({
          result: {
            snapshot: {
              pendingApprovals: [
                { id: "ap1", kind: "tool", summary: "rm -rf build", toolName: "shell", risk: "high" },
                { id: "ap2", kind: "plan", summary: "改动 3 个文件" },
                { nope: true },
              ],
            },
          },
        }),
      }),
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });

    const approvals = await fetchApprovals(listComputers()[0]!, "s1");

    expect(approvals.map((entry) => entry.id)).toEqual(["ap1", "ap2"]);
    expect(approvals[0]?.toolName).toBe("shell");
    expect(approvals[1]?.kind).toBe("plan");
  });

  it("answers an approval at its own route", async () => {
    const seen: Array<{ path: string; method: string; body?: string }> = [];
    stubRemote({
      request: (options) => {
        seen.push(options as { path: string; method: string; body?: string });
        return { status: 200, body: JSON.stringify({ result: { status: "resolved" } }) };
      },
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });
    await respondApproval(listComputers()[0]!, "ap1", "allow-once");

    const post = seen.at(-1) as { path: string; method: string; body: string };
    expect(post.path).toBe("/v1/approvals/ap1:respond");
    expect(JSON.parse(post.body).decision).toBe("allow-once");
  });

  it("reads a whole conversation in one attach", async () => {
    stubRemote({
      request: () => ({
        status: 200,
        body: JSON.stringify({
          result: {
            snapshot: {
              items: [
                { id: "m1", itemType: "message", content: { role: "user", content: "hi" } },
                { id: "m2", itemType: "message", content: { role: "assistant", content: "在。" } },
              ],
              pendingApprovals: [
                {
                  id: "ap1",
                  kind: "tool",
                  summary: "run tests",
                  allowedDecisions: ["allow-once", "deny"],
                },
              ],
              activeItems: [
                { id: "live1", itemType: "message", content: { role: "assistant", content: "正在" } },
              ],
              activeTurn: { id: "t1" },
              queuedTurns: [],
            },
          },
        }),
      }),
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });

    const snapshot = await fetchChat(listComputers()[0]!, "s1");

    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(snapshot.messages[2]?.text).toBe("正在");
    expect(snapshot.approvals[0]?.id).toBe("ap1");
    expect(snapshot.approvals[0]?.allowed).toEqual(["allow-once", "deny"]);
    expect(snapshot.active).toBe(true);
  });

  it("reports an idle conversation as not running", async () => {
    stubRemote({
      request: () => ({
        status: 200,
        body: JSON.stringify({ result: { snapshot: { items: [], activeTurn: null, queuedTurns: [] } } }),
      }),
    });
    await pairComputer({ url: "192.168.1.8:7317", token: "pdt1.one" });

    expect((await fetchChat(listComputers()[0]!, "s1")).active).toBe(false);
  });
});
