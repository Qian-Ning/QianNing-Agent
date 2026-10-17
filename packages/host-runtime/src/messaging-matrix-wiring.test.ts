import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_MATRIX_FORMAT,
  MESSAGING_MATRIX_FORMAT_VERSION,
} from "@pi-desktop/agent-host";
import type { Principal } from "@pi-desktop/agent-host";

import {
  createMatrixInboundWiring,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
} from "./messaging-inbound-wiring.js";

const ROOM = "!ops:example.test";
const TOKEN = "syt_matrix_test_token_value";
const OWN_USER = "@bot:example.test";
const LINKED: Principal = { subject: "linked-user", roles: ["controller", "approver"] };

/** The settings row in memory, merged at the top level the way `settings.set` does. */
function memorySettings(initial: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = { ...initial };
  const surface: HostSettingsSurface = {
    async read() {
      return row;
    },
    async write(patch) {
      row = { ...row, ...patch };
    },
  };
  return { surface, row: () => row };
}

function matrixSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_MATRIX_FORMAT,
    version: MESSAGING_MATRIX_FORMAT_VERSION,
    endpoint: "https://matrix.example.test",
    destination: ROOM,
    inbound: { linkedPrincipal: { subject: LINKED.subject, roles: [...LINKED.roles] }, ...extra },
  };
}

function stubHost(): MessagingInboundHostSurface {
  const surface = {
    async startTurn(): Promise<unknown> {
      return { turn: { id: "turn-1" } };
    },
    async stopTurn(): Promise<unknown> {
      return {};
    },
    async interruptTurn(): Promise<unknown> {
      return {};
    },
    async respondApproval(): Promise<void> {},
  };
  const snapshot = (async () => ({ activeTurn: null, pendingApprovals: [] })) as unknown as
    MessagingInboundHostSurface["snapshot"];
  return { ...surface, snapshot } as MessagingInboundHostSurface;
}

/** One deterministic sync answer, then a signal that stops the loop. */
function stubHomeserver() {
  const seen: { url: string; since: string | null; auth: string | null }[] = [];
  const controller = new AbortController();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({
      url: url.toString(),
      since: url.searchParams.get("since"),
      auth: new Headers(init?.headers).get("authorization"),
    });
    controller.abort();
    return new Response(
      JSON.stringify({
        next_batch: "batch-1",
        rooms: { join: { [ROOM]: { timeline: { events: [] } } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { seen, signal: controller.signal };
}

function wiringFor(options: {
  settings: HostSettingsSurface;
  signal: AbortSignal;
  token?: string | null;
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
}) {
  const logs = options.logs ?? [];
  return createMatrixInboundWiring({
    agentHost: stubHost(),
    settings: options.settings,
    secrets: async (ref) =>
      ref === MESSAGING_MATRIX_ACCESS_TOKEN_SECRET_REF ? (options.token ?? null) : null,
    signal: options.signal,
    log: (level, message, data) => logs.push({ level, message, data }),
    resolveIdentity: async () => ({ ok: true, userId: OWN_USER }),
    wait: async () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matrix wiring", () => {
  it("opens no connection while the secret store holds no token", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const settings = memorySettings({ messagingMatrix: matrixSection() });
    const wiring = wiringFor({ settings: settings.surface, signal: new AbortController().signal });

    await wiring.run();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settings.row().messagingMatrix).toEqual(matrixSection());
  });

  it("opens no connection while the channel names no endpoint", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const section = matrixSection();
    delete section.endpoint;
    const settings = memorySettings({ messagingMatrix: section });
    const wiring = wiringFor({
      settings: settings.surface,
      signal: new AbortController().signal,
      token: TOKEN,
    });

    await wiring.run();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("long-polls the configured homeserver, then saves the token under the channel's section", async () => {
    const settings = memorySettings({ messagingMatrix: matrixSection() });
    const server = stubHomeserver();
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const wiring = wiringFor({ settings: settings.surface, signal: server.signal, token: TOKEN, logs });

    await wiring.run();

    expect(logs.filter((line) => line.level === "warn")).toEqual([]);
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.since).toBeNull();
    // The token travels in the header the daemon reads, never in the URL.
    expect(server.seen[0]?.url).not.toContain(TOKEN);
    const section = settings.row().messagingMatrix as Record<string, unknown>;
    expect((section.inbound as Record<string, unknown>).syncToken).toBe("batch-1");
    // A save really happened here, so this is not a vacuous check: the token is
    // in the secret store, and the row that was written carries the cursor only.
    expect(JSON.stringify(settings.row())).not.toContain(TOKEN);
  });

  it("refuses a plaintext homeserver unless the relaxed LAN policy allows it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const settings = memorySettings({
      messagingMatrix: { ...matrixSection(), endpoint: "http://matrix.example.test" },
    });
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const wiring = wiringFor({
      settings: settings.surface,
      signal: new AbortController().signal,
      token: TOKEN,
      logs,
    });

    await wiring.run();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs.some((line) => line.message.includes("unusable endpoint"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("never writes the access token into a log line", async () => {
    const settings = memorySettings({ messagingMatrix: matrixSection() });
    const server = stubHomeserver();
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const wiring = wiringFor({
      settings: settings.surface,
      signal: server.signal,
      token: TOKEN,
      logs,
    });

    await wiring.run();

    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(settings.row())).not.toContain(TOKEN);
  });
});
