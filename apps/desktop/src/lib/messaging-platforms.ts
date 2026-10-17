import type {
  MessagingChannelSettings,
  RacpPermissionMode,
  RacpRole,
} from "@pi-desktop/shared";

/**
 * The messaging-platform settings surface (Settings ▸ Messaging platforms).
 *
 * Every platform entry restates what the runtime already reads, so the form can
 * only build a record the host accepts:
 *
 * - the section key, `format` and `version` come from
 *   `packages/agent-host/src/messaging-inbound.ts` (Telegram) and
 *   `messaging-slack-inbound.ts` (Slack);
 * - the top-level record fields are the ones
 *   `crates/host-core/src/messaging_{telegram,slack}.rs` deserialize;
 * - each secret ref is the one the transport reads
 *   (`MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF`,
 *   `MESSAGING_SLACK_APP_TOKEN_SECRET_REF`, and the Slack outbound bot token).
 *
 * Slack has two credentials because the product has two directions with two
 * different platform tokens: an app-level token for the Socket Mode connection
 * and a bot token for `chat.postMessage`. Telegram has one bot token for both.
 *
 * A credential is never part of the stored record. It is written to the host's
 * secret store under its ref, and the record carries only the non-secret
 * endpoint, destination and link. The split is enforced here, in
 * `buildSectionWrite` (which never copies a typed credential) and in
 * `saveMessagingPlatform` (which sends secrets to the secret store only).
 */

export type MessagingPlatformId = "telegram" | "slack";

/** The one settings section key each channel's record lives under, inside `app`. */
export type MessagingSectionKey = "messagingTelegram" | "messagingSlack";

/** One credential a channel reads, and where the host keeps it. */
export type MessagingSecretSlot = {
  id: "app-token" | "bot-token";
  /** The `secret:` ref the runtime reads, never a value. */
  ref: string;
  labelKey: string;
  hintKey: string;
};

export type MessagingPlatform = {
  id: MessagingPlatformId;
  section: MessagingSectionKey;
  /** The record's self-identifying format; a foreign value is refused. */
  format: string;
  version: number;
  /** The platform's own API base, as the form opens when nothing is stored. */
  defaultEndpoint: string;
  labelKey: string;
  blurbKey: string;
  secrets: MessagingSecretSlot[];
};

/**
 * The platforms whose send and receive paths both exist in this build. Nothing
 * else is listed: a row that could not be made to work would be a promise the
 * build does not keep.
 */
export const MESSAGING_PLATFORMS: MessagingPlatform[] = [
  {
    id: "telegram",
    section: "messagingTelegram",
    format: "pi-desktop-messaging-telegram",
    version: 1,
    defaultEndpoint: "https://api.telegram.org",
    labelKey: "settings.messaging.platformTelegram",
    blurbKey: "settings.messaging.blurbTelegram",
    secrets: [
      {
        id: "bot-token",
        ref: "secret:messaging-telegram:bot-token",
        labelKey: "settings.messaging.botToken",
        hintKey: "settings.messaging.botTokenHint",
      },
    ],
  },
  {
    id: "slack",
    section: "messagingSlack",
    format: "pi-desktop-messaging-slack",
    version: 1,
    defaultEndpoint: "https://slack.com",
    labelKey: "settings.messaging.platformSlack",
    blurbKey: "settings.messaging.blurbSlack",
    secrets: [
      {
        id: "app-token",
        ref: "secret:messaging-slack:app-token",
        labelKey: "settings.messaging.appToken",
        hintKey: "settings.messaging.appTokenHint",
      },
      {
        id: "bot-token",
        ref: "secret:messaging-slack:bot-token",
        labelKey: "settings.messaging.botToken",
        hintKey: "settings.messaging.slackBotTokenHint",
      },
    ],
  },
];

/** The link roles the inbound driver accepts, in `RACP_ROLES` order. */
export const MESSAGING_ROLES: RacpRole[] = ["viewer", "controller", "approver", "owner"];

/** The permission modes a contract approval may carry, in `RACP_PERMISSION_MODES` order. */
export const MESSAGING_PERMISSION_MODES: RacpPermissionMode[] = [
  "ask",
  "accept-edits",
  "auto",
];

/**
 * What the form holds. `secrets` is the only place a typed credential lives; it
 * is emptied after a successful save and is never merged into the record.
 */
export type MessagingDraft = {
  endpoint: string;
  destination: string;
  subject: string;
  roles: RacpRole[];
  permissionMode: RacpPermissionMode;
  requestTimeoutMs: string;
  secrets: Record<string, string>;
};

export function platformById(id: MessagingPlatformId): MessagingPlatform {
  const platform = MESSAGING_PLATFORMS.find((entry) => entry.id === id);
  if (!platform) throw new Error(`unknown messaging platform: ${id}`);
  return platform;
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The form's opening state: the stored record, or the platform's defaults. */
export function draftFrom(
  platform: MessagingPlatform,
  record: MessagingChannelSettings | null | undefined,
): MessagingDraft {
  const linked = record?.inbound?.linkedPrincipal;
  const roles = MESSAGING_ROLES.filter((role) => linked?.roles?.includes(role));
  return {
    endpoint: trimmed(record?.endpoint) || platform.defaultEndpoint,
    destination: trimmed(record?.destination),
    subject: trimmed(linked?.subject),
    roles: roles.length > 0 ? roles : ["controller"],
    permissionMode: MESSAGING_PERMISSION_MODES.includes(
      record?.inbound?.permissionMode as RacpPermissionMode,
    )
      ? (record?.inbound?.permissionMode as RacpPermissionMode)
      : "ask",
    requestTimeoutMs:
      typeof record?.requestTimeoutMs === "number" ? String(record.requestTimeoutMs) : "",
    secrets: {},
  };
}

/** True when the record is this build's own, not a foreign or future one. */
export function isOwnRecord(
  platform: MessagingPlatform,
  record: MessagingChannelSettings | null | undefined,
): boolean {
  if (!record) return false;
  return record.format === platform.format && record.version === platform.version;
}

/** The fields a save still needs, as i18n-neutral field ids. */
export function draftMissing(
  platform: MessagingPlatform,
  draft: MessagingDraft,
): string[] {
  const missing: string[] = [];
  if (trimmed(draft.endpoint) === "") missing.push("endpoint");
  if (trimmed(draft.destination) === "") missing.push("destination");
  if (trimmed(draft.subject) === "" || draft.roles.length === 0) missing.push("link");
  return missing;
}

export type MessagingStatus = "disabled" | "needsSetup" | "running" | "error";

export type MessagingStatusView = {
  status: MessagingStatus;
  /**
   * What is still missing, as field ids: `endpoint`, `destination`, `link`, or a
   * secret slot id (`bot-token`, `app-token`). Empty for `running`, `disabled`
   * and `error`.
   */
  missing: string[];
};

/**
 * The channel's state, read from what is actually stored rather than assumed.
 *
 * - `disabled`: no section at all. The host registers nothing for the channel
 *   and its inbound loop polls nothing, so "disabled" is the true state.
 * - `error`: a section this build cannot read — a foreign `format` or another
 *   `version`. The host refuses it instead of half-reading it.
 * - `needsSetup`: a section of ours with a required field or a credential
 *   missing. The host starts nothing useful in this state.
 * - `running`: the record is complete and every credential the channel reads is
 *   present, which is what the host needs to open the channel.
 *
 * `running` is configuration state, not a heartbeat: the desktop exposes no
 * liveness channel for these transports, so this never claims the socket is
 * open or the poll succeeded just now.
 */
export function deriveMessagingStatus(
  platform: MessagingPlatform,
  record: MessagingChannelSettings | null | undefined,
  secretPresent: Record<string, boolean>,
): MessagingStatusView {
  if (!record) return { status: "disabled", missing: [] };
  if (!isOwnRecord(platform, record)) return { status: "error", missing: [] };
  const missing: string[] = [];
  if (trimmed(record.endpoint) === "") missing.push("endpoint");
  if (trimmed(record.destination) === "") missing.push("destination");
  const linked = record.inbound?.linkedPrincipal;
  if (!linked || trimmed(linked.subject) === "" || (linked.roles?.length ?? 0) === 0) {
    missing.push("link");
  }
  for (const slot of platform.secrets) {
    if (secretPresent[slot.ref] !== true) missing.push(slot.id);
  }
  return missing.length > 0
    ? { status: "needsSetup", missing }
    : { status: "running", missing: [] };
}

/**
 * The record a save writes. It carries no credential: the token fields of the
 * draft are not read here at all, so a value typed into the form cannot reach
 * the settings row even by mistake.
 *
 * `existing` is the stored section, kept so the parts this form does not own —
 * the poll cursor, the conversation-to-session binding, Slack's replay guard —
 * survive an edit of the fields it does own. `settings.set` replaces a top-level
 * key, so the whole section has to be rebuilt rather than patched.
 */
export function buildSectionWrite(
  platform: MessagingPlatform,
  draft: MessagingDraft,
  existing: MessagingChannelSettings | null | undefined,
): MessagingChannelSettings {
  const endpoint = trimmed(draft.endpoint);
  const destination = trimmed(draft.destination);
  const subject = trimmed(draft.subject);
  const roles = MESSAGING_ROLES.filter((role) => draft.roles.includes(role));
  const timeout = Number(trimmed(draft.requestTimeoutMs));
  const inbound = {
    ...(existing?.inbound ?? {}),
    ...(subject !== "" && roles.length > 0
      ? { linkedPrincipal: { subject, roles } }
      : {}),
    permissionMode: draft.permissionMode,
  };
  return {
    format: platform.format,
    version: platform.version,
    endpoint,
    destination,
    ...(Number.isFinite(timeout) && timeout > 0
      ? { requestTimeoutMs: Math.floor(timeout) }
      : {}),
    inbound,
  };
}

/**
 * The credentials a save writes: one per non-empty field, under the slot's ref.
 * An empty field means "leave the stored credential alone", so a user editing
 * the endpoint is never asked to retype a token — and never has one cleared by
 * accident.
 */
export function planSecretWrites(
  platform: MessagingPlatform,
  draft: MessagingDraft,
): Array<{ ref: string; value: string }> {
  return platform.secrets
    .map((slot) => ({ ref: slot.ref, value: trimmed(draft.secrets[slot.id]) }))
    .filter((entry) => entry.value !== "");
}

export type MessagingSavePorts = {
  /** Write the channel's own settings section, through the host's settings row. */
  writeSection(section: MessagingSectionKey, value: MessagingChannelSettings): Promise<void>;
  /** Write one credential to the host's secret store, under its ref. */
  setSecret(ref: string, value: string): Promise<void>;
};

/**
 * Save a platform: credentials first, then the record.
 *
 * The order is the failure direction. If a secret write fails, the record is
 * untouched and the channel keeps its previous configuration. If the record
 * write fails after the secrets landed, the stored credentials are simply newer
 * than the record that names them; nothing is left pointing at a credential
 * that was never written.
 */
export async function saveMessagingPlatform(
  platform: MessagingPlatform,
  draft: MessagingDraft,
  existing: MessagingChannelSettings | null | undefined,
  ports: MessagingSavePorts,
): Promise<{ secretsWritten: number }> {
  const secrets = planSecretWrites(platform, draft);
  for (const secret of secrets) {
    await ports.setSecret(secret.ref, secret.value);
  }
  await ports.writeSection(platform.section, buildSectionWrite(platform, draft, existing));
  return { secretsWritten: secrets.length };
}
