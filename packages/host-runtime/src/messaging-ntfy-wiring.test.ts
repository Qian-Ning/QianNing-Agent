import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MESSAGING_NTFY_ACCESS_TOKEN_SECRET_REF,
  MESSAGING_NTFY_FORMAT,
  MESSAGING_NTFY_FORMAT_VERSION,
} from "@pi-desktop/agent-host";
import type { Principal } from "@pi-desktop/agent-host";

import {
  createNtfyInboundWiring,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
} from "./messaging-inbound-wiring.js";

const TOPIC = "pi-desktop-ops";
const TOKEN = "tk_ntfy_test_token_value";
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

function ntfySection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_NTFY_FORMAT,
    version: MESSAGING_NTFY_FORMAT_VERSION,
    endpoint: "https://ntfy.sh",
    destination: TOPIC,
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

/** One ndjson answer carrying one message, then a signal that stops the loop. */
function stubNtfy(messageId = "ntfy-1") {
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
      `${JSON.stringify({ id: messageId, event: "message", topic: TOPIC, message: "hello" })}\n`,
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
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
  return createNtfyInboundWiring({
    agentHost: stubHost(),
    settings: options.settings,
    secrets: async (ref) =>
      ref === MESSAGING_NTFY_ACCESS_TOKEN_SECRET_REF ? (options.token ?? null) : null,
    signal: options.signal,
    log: (level, message, data) => logs.push({ level, message, data }),
    wait: async () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ntfy wiring", () => {
  it("starts nothing while the channel names no topic", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const section = ntfySection();
    delete section.destination;
    const settings = memorySettings({ messagingNtfy: section });

    await wiringFor({ settings: settings.surface, signal: new AbortController().signal }).run();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("starts nothing while the channel has no section at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const settings = memorySettings();

    await wiringFor({ settings: settings.surface, signal: new AbortController().signal }).run();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("long-polls the configured topic and saves the message id in the channel's section", async () => {
    const settings = memorySettings({ messagingNtfy: ntfySection() });
    const server = stubNtfy("ntfy-42");
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];

    await wiringFor({ settings: settings.surface, signal: server.signal, token: TOKEN, logs }).run();

    // The message reached the routing path: it is not a command, so the driver
    // refuses it and audits the id — one turn attempted, not zero.
    const routed = logs.filter((line) => line.data?.kind === "refused");
    expect(routed.map((line) => line.data?.messageId)).toEqual(["ntfy-42"]);
    expect(server.seen).toHaveLength(1);
    // A first run asks from now, not from the topic's whole retained history.
    expect(server.seen[0]?.since).toBeNull();
    expect(server.seen[0]?.url).not.toContain(TOKEN);
    expect(server.seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    const section = settings.row().messagingNtfy as Record<string, unknown>;
    expect((section.inbound as Record<string, unknown>).sinceId).toBe("ntfy-42");
    expect(JSON.stringify(settings.row())).not.toContain(TOKEN);
  });

  it("polls an open topic with no token configured", async () => {
    const settings = memorySettings({ messagingNtfy: ntfySection() });
    const server = stubNtfy();

    await wiringFor({ settings: settings.surface, signal: server.signal }).run();

    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.auth).toBeNull();
  });

  it("refuses a plaintext server unless the relaxed LAN policy allows it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const settings = memorySettings({
      messagingNtfy: { ...ntfySection(), endpoint: "http://ntfy.example.test" },
    });
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];

    await wiringFor({
      settings: settings.surface,
      signal: new AbortController().signal,
      token: TOKEN,
      logs,
    }).run();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs.some((line) => line.message.includes("unusable endpoint"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("never writes the access token into a log line or the settings row", async () => {
    const settings = memorySettings({ messagingNtfy: ntfySection() });
    const server = stubNtfy();
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];

    await wiringFor({ settings: settings.surface, signal: server.signal, token: TOKEN, logs }).run();

    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(settings.row())).not.toContain(TOKEN);
  });
});
