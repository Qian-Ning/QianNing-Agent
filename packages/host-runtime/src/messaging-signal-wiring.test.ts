/**
 * The Signal channel's wiring: what the composition root starts, and what it
 * refuses to start.
 *
 * The adapter's own tests prove the protocol against a real loopback bridge;
 * this file proves the gate. Every case below is a record the Host must decline
 * to act on — no section, a foreign format, no account — plus the one case
 * where it does poll, so the account, the path and the optional secret ref are
 * asserted rather than assumed.
 */

import { describe, expect, it } from "vitest";

import {
  MESSAGING_SIGNAL_FORMAT,
  MESSAGING_SIGNAL_FORMAT_VERSION,
  MESSAGING_SIGNAL_SECTION,
  MESSAGING_SIGNAL_TOKEN_SECRET_REF,
  type SignalFetch,
} from "@pi-desktop/agent-host";

import {
  createSettingsSignalCursorStore,
  createSignalInboundWiring,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
} from "./messaging-inbound-wiring.js";

const ACCOUNT = "+15550000000";
const CORRESPONDENT = "+15550000002";
const BRIDGE = "http://127.0.0.1:8080";

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

function signalSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_SIGNAL_FORMAT,
    version: MESSAGING_SIGNAL_FORMAT_VERSION,
    endpoint: BRIDGE,
    account: ACCOUNT,
    allowedSenders: [CORRESPONDENT],
    inbound: { linkedPrincipal: { subject: "linked-user", roles: ["controller"] } },
    ...extra,
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

/** A fetch double that records the request and answers an empty receive batch. */
function recordingFetch() {
  const calls: Array<{ url: string; method: string; body: string; headers: Headers }> = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    calls.push({
      url: input,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
      headers: new Headers(init.headers as Record<string, string>),
    });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "wire", result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as SignalFetch;
  return { calls, fetchImpl };
}

/** Build a wiring whose signal this helper owns, run it for one poll, then stop. */
async function pollOnce(options: {
  settings: HostSettingsSurface;
  fetchImpl: SignalFetch;
  token?: string | null;
}): Promise<void> {
  const controller = new AbortController();
  let polls = 0;
  const wiring = createSignalInboundWiring({
    agentHost: stubHost(),
    settings: options.settings,
    secrets: async (ref) =>
      ref === MESSAGING_SIGNAL_TOKEN_SECRET_REF ? (options.token ?? null) : null,
    signal: controller.signal,
    fetchImpl: options.fetchImpl,
    wait: async () => {
      polls += 1;
      if (polls >= 1) controller.abort();
    },
  });
  await wiring.run();
}

describe("Signal wiring", () => {
  it("makes no request at all when the channel has no record", async () => {
    const settings = memorySettings();
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("makes no request for a record written by another build", async () => {
    const settings = memorySettings({
      [MESSAGING_SIGNAL_SECTION]: signalSection({ format: "someone-elses-format" }),
    });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("makes no request when the record names no account", async () => {
    const settings = memorySettings({
      [MESSAGING_SIGNAL_SECTION]: signalSection({ account: "  " }),
    });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("makes no request when the record allows nobody", async () => {
    // Fail closed: an empty allowlist is a channel that receives nothing, not
    // one that accepts everyone. It must not even open the poll.
    const settings = memorySettings({
      [MESSAGING_SIGNAL_SECTION]: signalSection({ allowedSenders: [] }),
    });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("makes no request for a record whose allowlist has only blank entries", async () => {
    const settings = memorySettings({
      [MESSAGING_SIGNAL_SECTION]: signalSection({ allowedSenders: ["  ", ",", ""] }),
    });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("makes no request for a record from before the allowlist existed", async () => {
    // An older record of this build's own format carries no `allowedSenders`.
    // Reading it as "everyone" would reopen exactly the hole this closed, so it
    // is treated as incomplete and stays inert until the panel is saved again.
    const legacy = signalSection();
    delete legacy.allowedSenders;
    const settings = memorySettings({ [MESSAGING_SIGNAL_SECTION]: legacy });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });
    expect(calls).toEqual([]);
  });

  it("polls the bridge with the record's account and the documented path", async () => {
    const settings = memorySettings({ [MESSAGING_SIGNAL_SECTION]: signalSection() });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BRIDGE}/api/v1/rpc`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body.method).toBe("receive");
    expect(body.params).toMatchObject({ account: ACCOUNT });
    // No token was stored, so no Authorization header is sent.
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("sends the stored bridge token as a bearer header, never in the body", async () => {
    const settings = memorySettings({ [MESSAGING_SIGNAL_SECTION]: signalSection() });
    const { calls, fetchImpl } = recordingFetch();
    await pollOnce({ settings: settings.surface, fetchImpl, token: "bridge-token-value" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer bridge-token-value");
    expect(calls[0]!.body).not.toContain("bridge-token-value");
  });

  it("records the newest envelope timestamp in the channel's own section", async () => {
    const settings = memorySettings({ [MESSAGING_SIGNAL_SECTION]: signalSection() });
    const store = createSettingsSignalCursorStore(settings.surface);
    await store.save(1_760_000_000_500);
    const section = settings.row()[MESSAGING_SIGNAL_SECTION] as Record<string, unknown>;
    const inbound = section.inbound as Record<string, unknown>;
    // The cursor rides the section's `inbound` record beside the link, which
    // the save must not disturb.
    expect(inbound.lastTimestamp).toBe(1_760_000_000_500);
    expect(inbound.linkedPrincipal).toEqual({ subject: "linked-user", roles: ["controller"] });
    expect(await store.load()).toBe(1_760_000_000_500);
  });
});
