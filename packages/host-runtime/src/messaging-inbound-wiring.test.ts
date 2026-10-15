import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { MESSAGING_TELEGRAM_FORMAT, MESSAGING_TELEGRAM_FORMAT_VERSION } from "@pi-desktop/agent-host";
import type { Principal } from "@pi-desktop/agent-host";

import {
  MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF,
  bindMessagingInboundSession,
  createMessagingInboundWiring,
  createSettingsCursorStore,
  createSettingsSessionBindingStore,
  settleWithinBudget,
  type HostSettingsSurface,
  type MessagingInboundHandle,
  type MessagingInboundHostSurface,
  type MessagingInboundWiringLog,
} from "./messaging-inbound-wiring.js";

const CHAT_ID = "chat-9";
const SESSION_ID = "session-1";
const LINKED_PRINCIPAL: Principal = { subject: "linked-user", roles: ["controller", "approver"] };

/** A settings row in memory, merged at the top level the way `settings.set` does. */
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
  return {
    surface,
    row: () => row,
    section: () => row.messagingTelegram as Record<string, unknown> | undefined,
    inbound: () => (row.messagingTelegram as Record<string, unknown> | undefined)?.inbound as
      | Record<string, unknown>
      | undefined,
  };
}

/** A linked channel section, with the binding and cursor opt-in. */
function linkedSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_TELEGRAM_FORMAT,
    version: MESSAGING_TELEGRAM_FORMAT_VERSION,
    endpoint: "https://api.example.invalid",
    destination: CHAT_ID,
    inbound: {
      linkedPrincipal: { subject: LINKED_PRINCIPAL.subject, roles: [...LINKED_PRINCIPAL.roles] },
      ...extra,
    },
  };
}

type Routed = { operation: string; sessionId?: string; turnId?: string };

function stubHost(routed: Routed[]): MessagingInboundHostSurface {
  const surface = {
    async startTurn(_principal: Principal, params: { sessionId: string }): Promise<unknown> {
      routed.push({ operation: "turn/start", sessionId: params.sessionId });
      return { turn: { id: "turn-1" } };
    },
    async stopTurn(_principal: Principal, turnId: string): Promise<unknown> {
      routed.push({ operation: "turn/stop", turnId });
      return { id: turnId };
    },
    async interruptTurn(_principal: Principal, turnId: string): Promise<unknown> {
      routed.push({ operation: "turn/interrupt", turnId });
      return { id: turnId };
    },
    async respondApproval(): Promise<void> {},
  };
  const snapshot = (async () => ({ activeTurn: { id: "turn-1" }, pendingApprovals: [] })) as unknown as
    MessagingInboundHostSurface["snapshot"];
  return { ...surface, snapshot } as MessagingInboundHostSurface;
}

function buildWiring(options: {
  settings: HostSettingsSurface;
  routed: Routed[];
  signal: AbortSignal;
  secrets?: (secretRef: string) => Promise<string | null>;
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
}) {
  const logs = options.logs ?? [];
  const log: MessagingInboundWiringLog = (level, message, data) => logs.push({ level, message, data });
  const wiring = createMessagingInboundWiring({
    agentHost: stubHost(options.routed),
    settings: options.settings,
    secrets: options.secrets ?? (async () => null),
    signal: options.signal,
    log,
  });
  return { wiring, logs };
}

function message(text: string) {
  return { updateId: 1, messageId: "m1", chatId: CHAT_ID, text };
}

// ---------------------------------------------------------------------------
// The link and the binding: read from the settings row, fail closed.
// ---------------------------------------------------------------------------

describe("createMessagingInboundWiring", () => {
  it("applies a linked chat's command to the session named by the persisted binding", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const routed: Routed[] = [];
    const { wiring } = buildWiring({ settings: settings.surface, routed, signal: new AbortController().signal });

    const outcome = await wiring.driver.handleMessage(message("/start do the thing"));

    expect(outcome).toEqual({ kind: "invoked", messageId: "m1", operation: "turn/start" });
    expect(routed).toEqual([{ operation: "turn/start", sessionId: SESSION_ID }]);
  });

  it("fails closed when the linked chat has no session binding", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection() });
    const routed: Routed[] = [];
    const { wiring } = buildWiring({ settings: settings.surface, routed, signal: new AbortController().signal });

    const outcome = await wiring.driver.handleMessage(message("/start do the thing"));

    expect(outcome.kind).toBe("refused");
    expect(routed).toEqual([]);
  });

  it("treats a chat that is not the linked one as unlinked and never binds it", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const routed: Routed[] = [];
    const { wiring } = buildWiring({ settings: settings.surface, routed, signal: new AbortController().signal });

    const outcome = await wiring.driver.handleMessage({ ...message("/start hi"), chatId: "chat-other" });

    expect(outcome).toEqual({ kind: "unlinked", messageId: "m1" });
    expect(routed).toEqual([]);
  });

  it("reads a foreign record as unlinked rather than half-reading it", async () => {
    const settings = memorySettings({
      messagingTelegram: { ...linkedSection({ sessionId: SESSION_ID }), format: "someone-elses-format" },
    });
    const routed: Routed[] = [];
    const { wiring } = buildWiring({ settings: settings.surface, routed, signal: new AbortController().signal });

    expect(await wiring.driver.handleMessage(message("/start hi"))).toEqual({
      kind: "unlinked",
      messageId: "m1",
    });
    expect(routed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The settings-backed stores: the cursor and the binding ride the same row.
// ---------------------------------------------------------------------------

describe("settings-backed stores", () => {
  it("persists the poll cursor under the channel's settings section", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const store = createSettingsCursorStore(settings.surface);

    expect(await store.load()).toBeNull();
    await store.save(42);
    expect(await store.load()).toBe(42);
    // The write replaces the whole section, so the record's own fields survive.
    expect(settings.section()).toMatchObject({
      format: MESSAGING_TELEGRAM_FORMAT,
      destination: CHAT_ID,
      inbound: { sessionId: SESSION_ID, pollOffset: 42 },
    });
  });

  it("reads a negative or non-numeric cursor as no stored position", async () => {
    const negative = memorySettings({ messagingTelegram: linkedSection({ pollOffset: -3 }) });
    const junk = memorySettings({ messagingTelegram: linkedSection({ pollOffset: "nope" }) });

    expect(await createSettingsCursorStore(negative.surface).load()).toBeNull();
    expect(await createSettingsCursorStore(junk.surface).load()).toBeNull();
  });

  it("round-trips the conversation-to-session binding through the settings row", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection() });
    const store = createSettingsSessionBindingStore(settings.surface);

    expect(await store.load()).toBeNull();
    await store.save(SESSION_ID);
    expect(await store.load()).toBe(SESSION_ID);
    expect(settings.inbound()).toMatchObject({ sessionId: SESSION_ID });

    // A blank binding is not a binding: the store drops it rather than writing.
    await store.save("   ");
    expect(await store.load()).toBe(SESSION_ID);
  });

  it("writes nothing when the channel has no section to write into", async () => {
    const settings = memorySettings();
    await createSettingsCursorStore(settings.surface).save(7);
    await createSettingsSessionBindingStore(settings.surface).save(SESSION_ID);
    expect(settings.row()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The configured transport: the endpoint and the token come from the host.
// ---------------------------------------------------------------------------

async function startScriptedServer(body: string): Promise<{
  origin: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the test server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length) await running.pop()!();
});

describe("configured transport", () => {
  it("long-polls the endpoint from the settings with the token from the secret store", async () => {
    const server = await startScriptedServer(
      JSON.stringify({ ok: true, result: [{ update_id: 41, message: { message_id: 900, chat: { id: 9 }, text: "/start hi" } }] }),
    );
    running.push(server.close);
    const settings = memorySettings({
      messagingTelegram: { ...linkedSection({ sessionId: SESSION_ID }), endpoint: server.origin },
    });
    const routed: Routed[] = [];
    const secretRefs: string[] = [];
    const { wiring } = buildWiring({
      settings: settings.surface,
      routed,
      signal: new AbortController().signal,
      secrets: async (secretRef) => {
        secretRefs.push(secretRef);
        return "test-token";
      },
    });

    const result = await wiring.driver.pollOnce();

    expect(result.polled).toBe(true);
    expect(secretRefs).toEqual([MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF]);
    expect(server.requests[0]).toContain("/bottest-token/getUpdates");
    expect(server.requests[0]).toContain("offset=0");
  });

  it("polls nothing while the channel names no endpoint", async () => {
    const settings = memorySettings({ messagingTelegram: { ...linkedSection({ sessionId: SESSION_ID }), endpoint: "" } });
    const routed: Routed[] = [];
    const { wiring, logs } = buildWiring({
      settings: settings.surface,
      routed,
      signal: new AbortController().signal,
      secrets: async () => {
        throw new Error("the secret store should not be asked for an unconfigured channel");
      },
    });

    const result = await wiring.driver.pollOnce();

    expect(result).toEqual({ polled: true, outcomes: [] });
    expect(logs).toEqual([]);
  });

  it("polls nothing while the secret store holds no token", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const routed: Routed[] = [];
    const { wiring } = buildWiring({
      settings: settings.surface,
      routed,
      signal: new AbortController().signal,
      secrets: async () => null,
    });

    expect(await wiring.driver.pollOnce()).toEqual({ polled: true, outcomes: [] });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: the loop observes the owner's signal and leaves `run`.
// ---------------------------------------------------------------------------

describe("run lifecycle", () => {
  it("leaves run once the owner aborts, without waiting out the poll interval", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const routed: Routed[] = [];
    const controller = new AbortController();
    const { wiring } = buildWiring({
      settings: settings.surface,
      routed,
      signal: controller.signal,
      secrets: async () => null,
    });

    let polls = 0;
    // A poll that answers immediately returns the loop to a wait; the abort in
    // the wait must end the loop rather than hold it for the poll interval.
    const run = wiring.run();
    const tick = setInterval(() => {
      polls += 1;
      controller.abort();
    }, 5);
    await expect(run).resolves.toBeUndefined();
    clearInterval(tick);
    expect(polls).toBeGreaterThan(0);
  });

  it("resolves run immediately when the signal is already aborted", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const controller = new AbortController();
    controller.abort();
    const { wiring } = buildWiring({ settings: settings.surface, routed: [], signal: controller.signal });

    await expect(wiring.run()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The audit sink: structure and ids, never message text.
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("records the operation's structure and never the message text", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection({ sessionId: SESSION_ID }) });
    const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const { wiring } = buildWiring({
      settings: settings.surface,
      routed: [],
      signal: new AbortController().signal,
      logs,
    });

    await wiring.driver.handleMessage(message("/start a secret plan nobody should read"));

    const recorded = JSON.stringify(logs);
    expect(recorded).not.toContain("a secret plan nobody should read");
    expect(logs.some((entry) => entry.data?.kind === "operation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The production binding write, and the bound on stopping the loop.
// ---------------------------------------------------------------------------

describe("bindMessagingInboundSession", () => {
  it("binds the conversation through the host-internal write, then its command reaches an operation", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection() });
    const routed: Routed[] = [];
    const owners: Array<{ sessionId: string; owner: string }> = [];
    const { wiring } = buildWiring({
      settings: settings.surface,
      routed,
      signal: new AbortController().signal,
    });

    // Unbound: the command is refused before any operation runs.
    const refused = await wiring.driver.handleMessage(message("/start do the thing"));
    expect(refused.kind).toBe("refused");
    expect(routed).toEqual([]);

    // The host-internal write the operator bind channel drives.
    await bindMessagingInboundSession(settings.surface, SESSION_ID, async (sessionId, owner) => {
      owners.push({ sessionId, owner });
    });
    expect(await wiring.binding.load()).toBe(SESSION_ID);

    // A fresh message id: the first refusal is recorded in the replay guard.
    const outcome = await wiring.driver.handleMessage({
      ...message("/start do the thing"),
      messageId: "m2",
    });
    expect(outcome).toEqual({ kind: "invoked", messageId: "m2", operation: "turn/start" });
    expect(routed).toEqual([{ operation: "turn/start", sessionId: SESSION_ID }]);
    expect(owners).toEqual([{ sessionId: SESSION_ID, owner: LINKED_PRINCIPAL.subject }]);
  });

  it("records the session's owner as the linked principal's subject in the same bind", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection() });
    const owners: Array<{ sessionId: string; owner: string }> = [];

    await bindMessagingInboundSession(settings.surface, SESSION_ID, async (sessionId, owner) => {
      owners.push({ sessionId, owner });
    });

    // The owner write and the binding write are one call, in that order: the
    // binding is written only after the owner write succeeds, and an unowned
    // session is never bound. (The two writes are not transactional, so an
    // owner-write-succeeds/save-fails partial state is possible — it leaves the
    // session owned and the conversation unbound, which refuses every inbound
    // command.)
    expect(owners).toEqual([{ sessionId: SESSION_ID, owner: LINKED_PRINCIPAL.subject }]);
    expect(settings.inbound()).toMatchObject({ sessionId: SESSION_ID });
  });

  it("fails closed on an unknown session id: the owner write rejects and no binding is written", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection() });

    await expect(
      bindMessagingInboundSession(settings.surface, SESSION_ID, async () => {
        throw Object.assign(new Error("session not found"), { errorCode: "NOT_FOUND" });
      }),
    ).rejects.toThrow(/not found/);

    expect(settings.inbound()).not.toHaveProperty("sessionId");
    expect(await createSettingsSessionBindingStore(settings.surface).load()).toBeNull();
  });

  it("fails closed when the channel names no linked principal to own the session", async () => {
    const settings = memorySettings({ messagingTelegram: { format: "pi-desktop-messaging-telegram", version: 1 } });

    await expect(
      bindMessagingInboundSession(settings.surface, SESSION_ID, async () => {}),
    ).rejects.toThrow(/no linked principal/);
  });

  it("fails closed: a blank or non-string id is refused and nothing is written", async () => {
    const settings = memorySettings({ messagingTelegram: linkedSection() });

    await expect(bindMessagingInboundSession(settings.surface, "   ", async () => {})).rejects.toThrow(/non-empty/);
    await expect(bindMessagingInboundSession(settings.surface, "", async () => {})).rejects.toThrow(/non-empty/);
    await expect(bindMessagingInboundSession(settings.surface, 42, async () => {})).rejects.toThrow(/non-empty/);
    await expect(bindMessagingInboundSession(settings.surface, null, async () => {})).rejects.toThrow(/non-empty/);

    expect(settings.inbound()).not.toHaveProperty("sessionId");
    expect(await createSettingsSessionBindingStore(settings.surface).load()).toBeNull();
  });

  it("writes only the channel's settings key, leaving a neighbouring setting intact", async () => {
    const settings = memorySettings({ theme: "dark", messagingTelegram: linkedSection() });

    await bindMessagingInboundSession(settings.surface, SESSION_ID, async () => {});

    expect(settings.row().theme).toBe("dark");
    expect(settings.inbound()).toMatchObject({ sessionId: SESSION_ID });
  });
});

describe("settleWithinBudget", () => {
  it("gives up after its budget when a stop wait never finishes", async () => {
    const controller = new AbortController();
    const handle: MessagingInboundHandle = {
      controller,
      // A loop that never leaves `run`: it ignores the abort entirely, the way a
      // single in-flight host RPC does for the length of its own deadline.
      done: new Promise<void>(() => {}),
    };
    const started = Date.now();

    controller.abort();
    await settleWithinBudget(handle.done, 40);

    expect(controller.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns as soon as the work settles, well before the budget", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const settled = settleWithinBudget(work, 5_000);
    finish();
    await expect(settled).resolves.toBeUndefined();
  });

  it("resolves rather than rejects when the work rejects, and when there is no work", async () => {
    await expect(
      settleWithinBudget(Promise.reject(new Error("boom")), 50),
    ).resolves.toBeUndefined();
    await expect(settleWithinBudget(undefined, 5_000)).resolves.toBeUndefined();
  });
});
