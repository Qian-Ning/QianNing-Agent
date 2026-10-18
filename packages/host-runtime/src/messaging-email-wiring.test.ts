/**
 * The email channel's wiring: what the composition root starts, and what it
 * refuses to start.
 *
 * The adapter's own tests prove the protocol; this file proves the gate. Every
 * case below is a record the Host must decline to act on — no section, a
 * foreign format, no allowlisted sender, no stored password — plus the one case
 * where it does connect, so the port defaults and the secret ref are asserted
 * rather than assumed.
 */

import { describe, expect, it } from "vitest";

import {
  MESSAGING_EMAIL_FORMAT,
  MESSAGING_EMAIL_FORMAT_VERSION,
  MESSAGING_EMAIL_PASSWORD_SECRET_REF,
  type ImapRawSocket,
  type ImapTarget,
} from "@pi-desktop/agent-host";
import type { Principal } from "@pi-desktop/agent-host";

import {
  createEmailInboundWiring,
  createSettingsEmailCursorStore,
  type HostSettingsSurface,
  type MessagingInboundHostSurface,
} from "./messaging-inbound-wiring.js";

const PASSWORD = "app-password-value-never-logged";
const LINKED: Principal = { subject: "linked-user", roles: ["controller"] };

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

function emailSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: MESSAGING_EMAIL_FORMAT,
    version: MESSAGING_EMAIL_FORMAT_VERSION,
    imapHost: "imap.example.org",
    imapPort: 993,
    smtpHost: "smtp.example.org",
    smtpPort: 587,
    smtpSecurity: "starttls",
    username: "bot@example.org",
    allowedSenders: ["alice@example.org"],
    subjectPrefix: "[pi]",
    inbound: { linkedPrincipal: { subject: LINKED.subject, roles: [...LINKED.roles] } },
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

/**
 * A connection factory that records the target and then has the server refuse
 * the session, so the gate is proven without a real mailbox and without a
 * twenty-second greeting timeout.
 */
function refusingConnect() {
  const targets: ImapTarget[] = [];
  const factory = (target: ImapTarget): ImapRawSocket => {
    targets.push(target);
    return {
      write: () => {},
      end: () => {},
      onData: (handler) => {
        // Delivered on a later turn: the client installs its greeting waiter
        // straight after this call, so a synchronous push would be dropped and
        // the session would sit until the timeout.
        setTimeout(() => handler(Buffer.from("* BYE not today\r\n", "latin1")), 0);
      },
      onClose: () => {},
      onError: () => {},
    };
  };
  return { targets, factory };
}

function wiringFor(options: {
  settings: HostSettingsSurface;
  signal: AbortSignal;
  password?: string | null;
  connect?: (target: ImapTarget) => ImapRawSocket;
  wait?: (ms: number) => Promise<void>;
  logs?: Array<{ level: string; message: string; data?: Record<string, unknown> }>;
}) {
  const logs = options.logs ?? [];
  return createEmailInboundWiring({
    agentHost: stubHost(),
    settings: options.settings,
    secrets: async (ref) =>
      ref === MESSAGING_EMAIL_PASSWORD_SECRET_REF ? (options.password ?? null) : null,
    signal: options.signal,
    log: (level, message, data) => logs.push({ level, message, data }),
    ...(options.connect ? { connect: options.connect } : {}),
    wait: options.wait ?? (async () => {}),
  });
}

/**
 * Run the wiring for exactly one poll.
 *
 * The loop's own wait is the abort point, so the first poll finishes and the
 * second never starts — which is what makes the connection count meaningful.
 */
async function runOnce(options: {
  settings: HostSettingsSurface;
  password?: string | null;
}): Promise<{ targets: ImapTarget[]; logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> }> {
  const logs: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
  const controller = new AbortController();
  const { targets, factory } = refusingConnect();
  const wiring = wiringFor({
    settings: options.settings,
    signal: controller.signal,
    ...(options.password !== undefined ? { password: options.password } : {}),
    connect: factory,
    wait: async () => controller.abort(),
    logs,
  });
  await wiring.run();
  return { targets, logs };
}

describe("email wiring", () => {
  it("starts nothing when the channel has no section", async () => {
    const settings = memorySettings();
    const { targets } = await runOnce({ settings: settings.surface, password: PASSWORD });
    expect(targets).toEqual([]);
  });

  it("starts nothing when the record is another build's format", async () => {
    const settings = memorySettings({
      messagingEmail: emailSection({ format: "someone-elses-format" }),
    });
    const { targets } = await runOnce({ settings: settings.surface, password: PASSWORD });
    expect(targets).toEqual([]);
  });

  it("starts nothing when no sender is allowlisted", async () => {
    const settings = memorySettings({ messagingEmail: emailSection({ allowedSenders: [] }) });
    const { targets } = await runOnce({ settings: settings.surface, password: PASSWORD });
    expect(targets).toEqual([]);
  });

  it("starts nothing when the IMAP host is missing", async () => {
    const settings = memorySettings({
      messagingEmail: emailSection({ imapHost: "" }),
    });
    const { targets } = await runOnce({ settings: settings.surface, password: PASSWORD });
    expect(targets).toEqual([]);
  });

  it("starts nothing, and says so, when no password is stored", async () => {
    const settings = memorySettings({ messagingEmail: emailSection() });
    const { targets, logs } = await runOnce({ settings: settings.surface, password: null });
    expect(targets).toEqual([]);
    expect(logs.some((entry) => entry.message.includes("no password stored"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("connects to the configured IMAP host on its port when the record is complete", async () => {
    const settings = memorySettings({ messagingEmail: emailSection() });
    const { targets, logs } = await runOnce({ settings: settings.surface, password: PASSWORD });
    expect(targets).toEqual([{ host: "imap.example.org", port: 993 }]);
    // The refusal is surfaced as a loop failure, and the password is in no
    // record: the adapter's typed error carries the server's status only.
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("defaults the IMAP port to 993 when the record names none", async () => {
    const section = emailSection();
    delete section.imapPort;
    const settings = memorySettings({ messagingEmail: section });
    const { targets } = await runOnce({ settings: settings.surface, password: PASSWORD });
    expect(targets).toEqual([{ host: "imap.example.org", port: 993 }]);
  });
});

describe("the email cursor store", () => {
  it("reads a stored UID and ignores a value that is not one", async () => {
    const settings = memorySettings({ messagingEmail: emailSection({ inbound: { lastUid: 42 } }) });
    const store = createSettingsEmailCursorStore(settings.surface);
    expect(await store.load()).toBe(42);

    const bad = memorySettings({ messagingEmail: emailSection({ inbound: { lastUid: "42" } }) });
    expect(await createSettingsEmailCursorStore(bad.surface).load()).toBeNull();
  });

  it("writes the UID beside the rest of the inbound record, keeping it", async () => {
    const settings = memorySettings({ messagingEmail: emailSection() });
    const store = createSettingsEmailCursorStore(settings.surface);
    await store.save(97);
    const section = settings.row().messagingEmail as Record<string, unknown>;
    const inbound = section.inbound as Record<string, unknown>;
    expect(inbound.lastUid).toBe(97);
    expect(inbound.linkedPrincipal).toEqual({
      subject: LINKED.subject,
      roles: [...LINKED.roles],
    });
    // The record's own identity survives a cursor write.
    expect(section.format).toBe(MESSAGING_EMAIL_FORMAT);
  });
});
