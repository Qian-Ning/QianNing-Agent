import type {
  MessagingChannelSettings,
  MessagingWebhookReceiverSettings,
  RacpPermissionMode,
  RacpRole,
} from "@pi-desktop/shared";

/**
 * Any record the panel edits: a channel's own, or the shared webhook receiver's.
 *
 * The receiver is not a channel — its record describes an HTTP surface and the
 * one binding served on it — so it has its own type, and every writer here takes
 * the union rather than pretending the two shapes are the same.
 */
export type MessagingPlatformRecord = MessagingChannelSettings | MessagingWebhookReceiverSettings;

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
 *
 * # The catalogue is honest about breadth
 *
 * The list carries all thirty-three platforms the reference product lists, in
 * the product's own order, because a user comparing the two should be able to
 * find a platform where they expect it. Only the eleven with a send path and a
 * receive path in this build (Telegram, Slack, Discord, Mattermost, Matrix,
 * Home Assistant, IRC, ntfy, Email, Signal and the local API) are `supported`;
 * the other twenty-two each carry a `requirementClass`
 * — an outgoing long connection, a public callback, a poll or bridge, a
 * transport rather than a chat channel, or platform-side approval — and the
 * sentence that names the specific capability this build lacks. The panel says
 * both plainly. An unsupported entry has no section, no format and no
 * credentials, so there is nothing for a form to write and nothing the host
 * would read.
 */

export type MessagingPlatformId =
  | "telegram"
  | "discord"
  | "slack"
  | "mattermost"
  | "matrix"
  | "whatsapp"
  | "signal"
  | "blueBubbles"
  | "homeAssistant"
  | "email"
  | "sms"
  | "dingtalk"
  | "feishu"
  | "googleChat"
  | "wecomGroup"
  | "wecomApp"
  | "weixin"
  | "qqBot"
  | "yuanbao"
  | "apiServer"
  | "webhooks"
  | "a2a"
  | "buzz"
  | "imessagePhone"
  | "irc"
  | "line"
  | "microsoftGraph"
  | "teams"
  | "ntfy"
  | "raft"
  | "relay"
  | "simplex"
  | "whatsappCloud";

/** The one settings section key each channel's record lives under, inside `app`. */
export type MessagingSectionKey =
  | "messagingTelegram"
  | "messagingSlack"
  | "messagingDiscord"
  | "messagingMattermost"
  | "messagingMatrix"
  | "messagingIrc"
  | "messagingHomeAssistant"
  | "messagingNtfy"
  | "messagingEmail"
  | "messagingSignal"
  | "messagingApiServer"
  /**
   * The shared inbound-webhook receiver. It is a section of its own, not a
   * channel record: the record describes the surface (`enabled`, the port, the
   * signing secret's ref) and carries the one binding this build serves on it.
   */
  | "messagingWebhookReceiver";

/** One credential a channel reads, and where the host keeps it. */
export type MessagingSecretSlot = {
  id:
    | "app-token"
    | "bot-token"
    | "access-token"
    | "server-password"
    | "password"
    | "api-token"
    | "signing-secret";
  /** The `secret:` ref the runtime reads, never a value. */
  ref: string;
  labelKey: string;
  hintKey: string;
  /** An example shaped like the real value, never a real one. */
  placeholderKey: string;
  /**
   * Whether the credential may be absent on a working channel. ntfy is the
   * case: a topic on an open or self-hosted server needs no token, so a record
   * without one is complete rather than a setup gap. Absent means required.
   */
  optional?: boolean;
};

export type MessagingFieldId =
  | MessagingSecretSlot["id"]
  | "nick"
  | "channels"
  | "destination"
  | "subject"
  | "roles"
  | "permissionMode"
  | "endpoint"
  | "requestTimeoutMs"
  | "imapHost"
  | "imapPort"
  | "smtpHost"
  | "smtpPort"
  | "smtpSecurity"
  | "username"
  | "allowedSenders"
  | "subjectPrefix"
  | "account"
  | "port"
  | "bindAddress"
  /**
   * The webhook receiver only: the session an accepted event starts a turn on.
   * It is a form field because the receiver's principal holds the `owner` role
   * — the same identity model the local API channel uses — so no per-session
   * ownership write is needed for the binding to work.
   */
  | "sessionId";

/**
 * Whether a field must be filled before the channel can work at all
 * (`required`) or only tunes behaviour that already has a documented default
 * (`recommended`). The split is the page's, and each field states its own
 * consequence so a recommended one never reads as decorative.
 */
export type MessagingFieldGroup = "required" | "recommended";

export type MessagingField = {
  id: MessagingFieldId;
  group: MessagingFieldGroup;
  labelKey: string;
  /** What the field is, in one plain sentence. */
  helpKey: string;
  /** An example of a real value. */
  placeholderKey?: string;
  /** What happens when it is blank or wrong. */
  consequenceKey: string;
};

type PlatformBase = {
  id: MessagingPlatformId;
  labelKey: string;
  blurbKey: string;
  /**
   * The platform's own setup documentation, where it publishes one this build
   * can point at. Entries without a public page omit it: the panel then shows
   * no outbound link rather than one that goes somewhere else.
   */
  guideUrl?: string;
  /** The numbered walkthrough that gets the user its credentials. */
  credentialStepKeys: readonly string[];
};

export type SupportedMessagingPlatform = PlatformBase & {
  support: "supported";
  /**
   * A standing limitation the user has to know before they wire the channel up,
   * rendered in the panel in plain language. Only the channels with one carry it.
   */
  noteKey?: string;
  section: MessagingSectionKey;
  /** The record's self-identifying format; a foreign value is refused. */
  format: string;
  version: number;
  /** The platform's own API base, as the form opens when nothing is stored. */
  defaultEndpoint: string;
  secrets: MessagingSecretSlot[];
  /** Every field the panel renders, required first. */
  fields: MessagingField[];
  /**
   * What this channel deliberately does not implement, in plain language.
   *
   * The panel says it, rather than leaving a user to discover it from a failed
   * connection: IRC's honest limits are SASL and TLS client certificates.
   */
  limitationKey?: string;
};

/**
 * What an unsupported platform is missing, as a class rather than a sentence.
 *
 * "Needs setup" without the kind of setup is useless: a channel reached over an
 * outgoing socket can be wired from a home network, while one that only pushes
 * into a callback URL needs an address the internet can reach. The five classes
 * are the real shapes of the gap, and each entry states its own class next to
 * its own requirement sentence.
 *
 * - `longConnection` — an outgoing long connection to the platform's own
 *   servers, which works from a home network behind NAT.
 * - `publicCallback` — the platform pushes events into a public HTTPS endpoint,
 *   so the machine has to be reachable from the internet.
 * - `bridgeOrPoll` — a polling loop, or a bridge process paired with a phone or
 *   a Mac that owns the account.
 * - `transport` — a wire protocol rather than a chat network, so there is no
 *   conversation to link.
 * - `platformApproval` — the platform has to approve the app or a business
 *   account before any credential is issued.
 */
export type MessagingRequirementClass =
  | "longConnection"
  | "publicCallback"
  | "bridgeOrPoll"
  | "transport"
  | "platformApproval";

/** The five class labels, as the unsupported panel renders them. */
export const MESSAGING_REQUIREMENT_CLASS_KEYS: Record<MessagingRequirementClass, string> = {
  longConnection: "settings.messaging.requirementClassLongConnection",
  publicCallback: "settings.messaging.requirementClassPublicCallback",
  bridgeOrPoll: "settings.messaging.requirementClassBridge",
  transport: "settings.messaging.requirementClassTransport",
  platformApproval: "settings.messaging.requirementClassApproval",
};

/**
 * The rail's version of the requirement classes: the same five gaps, named in
 * a few words so a card's second line fits. The full sentence still uses
 * MESSAGING_REQUIREMENT_CLASS_KEYS in the detail panel.
 */
export const MESSAGING_REQUIREMENT_SHORT_KEYS: Record<MessagingRequirementClass, string> = {
  longConnection: "settings.messaging.requirementShortLongConnection",
  publicCallback: "settings.messaging.requirementShortPublicCallback",
  bridgeOrPoll: "settings.messaging.requirementShortBridge",
  transport: "settings.messaging.requirementShortTransport",
  platformApproval: "settings.messaging.requirementShortApproval",
};

export type UnsupportedMessagingPlatform = PlatformBase & {
  support: "unsupported";
  /** What kind of thing this build lacks, so the gap is placed, not just named. */
  requirementClass: MessagingRequirementClass;
  /** The capability this build lacks; the panel names it. */
  requirementKey: string;
  secrets: [];
};

export type MessagingPlatform = SupportedMessagingPlatform | UnsupportedMessagingPlatform;

function secretFields(secrets: MessagingSecretSlot[]): MessagingField[] {
  return secrets.map((slot) => ({
    id: slot.id,
    group: "required" as const,
    labelKey: slot.labelKey,
    helpKey: slot.hintKey,
    placeholderKey: slot.placeholderKey,
    consequenceKey: "settings.messaging.consequenceToken",
  }));
}

/** The fields both channels share, in panel order. */
function channelFields(platform: {
  secrets: MessagingSecretSlot[];
  destinationLabelKey: string;
  destinationHelpKey: string;
  destinationPlaceholderKey: string;
  subjectPlaceholderKey: string;
  /** The platform's API base example; defaults to Telegram's own. */
  endpointPlaceholderKey?: string;
}): MessagingField[] {
  return [
    ...secretFields(platform.secrets),
    {
      id: "destination",
      group: "required",
      labelKey: platform.destinationLabelKey,
      helpKey: platform.destinationHelpKey,
      placeholderKey: platform.destinationPlaceholderKey,
      consequenceKey: "settings.messaging.consequenceDestination",
    },
    {
      id: "subject",
      group: "required",
      labelKey: "settings.messaging.subject",
      helpKey: "settings.messaging.subjectHint",
      placeholderKey: platform.subjectPlaceholderKey,
      consequenceKey: "settings.messaging.consequenceSubject",
    },
    {
      id: "roles",
      group: "required",
      labelKey: "settings.messaging.roles",
      helpKey: "settings.messaging.rolesHint",
      consequenceKey: "settings.messaging.consequenceRoles",
    },
    {
      id: "permissionMode",
      group: "recommended",
      labelKey: "settings.messaging.permissionMode",
      helpKey: "settings.messaging.permissionModeHint",
      consequenceKey: "settings.messaging.consequencePermissionMode",
    },
    {
      id: "endpoint",
      group: "recommended",
      labelKey: "settings.messaging.endpoint",
      helpKey: "settings.messaging.endpointHint",
      placeholderKey: platform.endpointPlaceholderKey ?? "settings.messaging.endpointPlaceholder",
      consequenceKey: "settings.messaging.consequenceEndpoint",
    },
    {
      id: "requestTimeoutMs",
      group: "recommended",
      labelKey: "settings.messaging.requestTimeout",
      helpKey: "settings.messaging.requestTimeoutHint",
      placeholderKey: "settings.messaging.requestTimeoutPlaceholder",
      consequenceKey: "settings.messaging.consequenceTimeout",
    },
  ];
}

/**
 * The shared fields with the endpoint promoted to the required group, for the
 * channels that have no public address to fall back to: a self-hosted or
 * federated server, and Home Assistant on the user's own network.
 */
function withRequiredEndpoint(shared: MessagingField[]): MessagingField[] {
  const endpoint = shared.find((field) => field.id === "endpoint");
  if (!endpoint) return shared;
  const rest = shared.filter((field) => field.id !== "endpoint");
  return [
    ...rest.filter((field) => field.group === "required"),
    { ...endpoint, group: "required" as const },
    ...rest.filter((field) => field.group === "recommended"),
  ];
}

/**
 * Mattermost's fields. Its base URL is required, not recommended: the product
 * is self-hosted, so there is no public address to fall back to. The rest of the
 * panel is the shared shape.
 */
function mattermostFields(): MessagingField[] {
  return withRequiredEndpoint(
    channelFields({
      secrets: mattermostSecrets,
      destinationLabelKey: "settings.messaging.mattermostChannel",
      destinationHelpKey: "settings.messaging.mattermostChannelHelp",
      destinationPlaceholderKey: "settings.messaging.mattermostChannelPlaceholder",
      subjectPlaceholderKey: "settings.messaging.subjectPlaceholderMattermost",
      endpointPlaceholderKey: "settings.messaging.endpointPlaceholderMattermost",
    }),
  );
}

/**
 * Matrix's fields. Its homeserver URL is required for the same reason
 * Mattermost's is: the product is self-hosted or federated, so there is no
 * public address to fall back to. The rest of the panel is the shared shape.
 */
function matrixFields(): MessagingField[] {
  return withRequiredEndpoint(
    channelFields({
      secrets: matrixSecrets,
      destinationLabelKey: "settings.messaging.matrixRoom",
      destinationHelpKey: "settings.messaging.matrixRoomHelp",
      destinationPlaceholderKey: "settings.messaging.matrixRoomPlaceholder",
      subjectPlaceholderKey: "settings.messaging.subjectPlaceholderMatrix",
      endpointPlaceholderKey: "settings.messaging.endpointPlaceholderMatrix",
    }),
  );
}

/**
 * Home Assistant's fields.
 *
 * The base URL is required: a Home Assistant instance lives on the user's own
 * network, so there is no public address to fall back to. The linked service is
 * required and is written as `domain.service`, because that is what the send
 * path posts to. The rest of the panel is the shared shape.
 */
function homeAssistantFields(): MessagingField[] {
  return withRequiredEndpoint(
    channelFields({
      secrets: homeAssistantSecrets,
      destinationLabelKey: "settings.messaging.homeAssistantService",
      destinationHelpKey: "settings.messaging.homeAssistantServiceHelp",
      destinationPlaceholderKey: "settings.messaging.homeAssistantServicePlaceholder",
      subjectPlaceholderKey: "settings.messaging.subjectPlaceholderHomeAssistant",
      endpointPlaceholderKey: "settings.messaging.endpointPlaceholderHomeAssistant",
    }),
  );
}

/**
 * Email's one credential: the mail password, ideally an app password.
 *
 * It is a password, not a token, and the panel says so: a provider that only
 * offers OAuth sign-in is unsupported by this build, because there is no token
 * exchange here to do.
 */
const emailSecrets: MessagingSecretSlot[] = [
  {
    id: "password",
    ref: "secret:messaging-email:password",
    labelKey: "settings.messaging.emailPassword",
    hintKey: "settings.messaging.emailPasswordHint",
    placeholderKey: "settings.messaging.emailPasswordPlaceholder",
  },
];

/**
 * Email's fields.
 *
 * Email has no single "destination": the correspondent is whoever wrote, and the
 * record holds the *allowlist* of who may write. So the required set is the two
 * servers, the account, the allowlist and the password — nothing here has a
 * public default, because a provider's hostnames are the provider's — plus the
 * shared identity fields every channel needs to attribute a turn.
 *
 * The subject prefix is recommended rather than required: a reply without one is
 * still a valid reply, it is just harder to filter in a mailbox.
 */
function emailFields(): MessagingField[] {
  const field = (
    id: MessagingField["id"],
    group: MessagingField["group"],
    labelKey: string,
    helpKey: string,
    placeholderKey: string | undefined,
    consequenceKey: string,
  ): MessagingField => ({
    id,
    group,
    labelKey,
    helpKey,
    consequenceKey,
    ...(placeholderKey ? { placeholderKey } : {}),
  });
  return [
    ...secretFields(emailSecrets),
    field(
      "imapHost",
      "required",
      "settings.messaging.emailImapHost",
      "settings.messaging.emailImapHostHint",
      "settings.messaging.emailImapHostPlaceholder",
      "settings.messaging.consequenceEmailServer",
    ),
    field(
      "imapPort",
      "required",
      "settings.messaging.emailImapPort",
      "settings.messaging.emailImapPortHint",
      undefined,
      "settings.messaging.consequenceEmailServer",
    ),
    field(
      "smtpHost",
      "required",
      "settings.messaging.emailSmtpHost",
      "settings.messaging.emailSmtpHostHint",
      "settings.messaging.emailSmtpHostPlaceholder",
      "settings.messaging.consequenceEmailServer",
    ),
    field(
      "smtpPort",
      "required",
      "settings.messaging.emailSmtpPort",
      "settings.messaging.emailSmtpPortHint",
      undefined,
      "settings.messaging.consequenceEmailServer",
    ),
    field(
      "smtpSecurity",
      "required",
      "settings.messaging.emailSmtpSecurity",
      "settings.messaging.emailSmtpSecurityHint",
      undefined,
      "settings.messaging.consequenceEmailServer",
    ),
    field(
      "username",
      "required",
      "settings.messaging.emailUsername",
      "settings.messaging.emailUsernameHint",
      "settings.messaging.emailUsernamePlaceholder",
      "settings.messaging.consequenceEmailAccount",
    ),
    field(
      "allowedSenders",
      "required",
      "settings.messaging.emailAllowedSenders",
      "settings.messaging.emailAllowedSendersHint",
      "settings.messaging.emailAllowedSendersPlaceholder",
      "settings.messaging.consequenceEmailSenders",
    ),
    {
      id: "subject",
      group: "required",
      labelKey: "settings.messaging.subject",
      helpKey: "settings.messaging.subjectHint",
      placeholderKey: "settings.messaging.subjectPlaceholderEmail",
      consequenceKey: "settings.messaging.consequenceSubject",
    },
    {
      id: "roles",
      group: "required",
      labelKey: "settings.messaging.roles",
      helpKey: "settings.messaging.rolesHint",
      consequenceKey: "settings.messaging.consequenceRoles",
    },
    field(
      "subjectPrefix",
      "recommended",
      "settings.messaging.emailSubjectPrefix",
      "settings.messaging.emailSubjectPrefixHint",
      "settings.messaging.emailSubjectPrefixPlaceholder",
      "settings.messaging.consequenceEmailPrefix",
    ),
    {
      id: "permissionMode",
      group: "recommended",
      labelKey: "settings.messaging.permissionMode",
      helpKey: "settings.messaging.permissionModeHint",
      consequenceKey: "settings.messaging.consequencePermissionMode",
    },
  ];
}

/**
 * Where the local API channel's bearer token lives in the host's secret store.
 *
 * The same ref the endpoint falls back to when the record names none, spelled
 * here so the card and the runtime cannot drift apart.
 */
export const API_SERVER_TOKEN_SECRET_REF = "secret:messaging-api-server:token";

/** The port the card opens with; the same default the listener binds. */
export const API_SERVER_DEFAULT_PORT = 7842;

/**
 * The local API's one credential.
 *
 * It is required, not optional: the endpoint refuses to bind without it, because
 * a loopback listener with no token is a way into the agent for every process on
 * the machine. The value is generated by this app rather than typed by the user —
 * there is nothing on any platform's dashboard to copy it from — so the card
 * shows it once, when it is created, and after that only says one is stored.
 */
const apiServerSecrets: MessagingSecretSlot[] = [
  {
    id: "api-token",
    ref: API_SERVER_TOKEN_SECRET_REF,
    labelKey: "settings.messaging.apiServerToken",
    hintKey: "settings.messaging.apiServerTokenHint",
    placeholderKey: "settings.messaging.apiServerTokenPlaceholder",
  },
];

/**
 * A fresh bearer token for the local API.
 *
 * 32 bytes from the platform's cryptographic generator, hex-encoded: 256 bits,
 * which is what makes guessing it impossible rather than merely slow. It is
 * generated in the renderer, written straight to the host's secret store, and
 * never stored in the settings row.
 */
export function generateApiServerToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether an address only this machine can reach.
 *
 * The same three exact spellings the runtime accepts, so the card's warning and
 * the listener's refusal can never disagree: a name that merely starts like
 * `127.0.0.1` resolves wherever its owner says, and is not loopback.
 */
export function isLoopbackBindAddress(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * The local API's fields.
 *
 * Four values, and no link: the token is the identity, so there is no second
 * list of who may call and no linked chat to name. The port and the bind address
 * are the listener's; the address is loopback by default and the card says why a
 * wider one is refused rather than offering a switch that cannot work.
 */
function apiServerFields(): MessagingField[] {
  return [
    ...secretFields(apiServerSecrets),
    {
      id: "port",
      group: "required",
      labelKey: "settings.messaging.apiServerPort",
      helpKey: "settings.messaging.apiServerPortHint",
      placeholderKey: "settings.messaging.apiServerPortPlaceholder",
      consequenceKey: "settings.messaging.consequenceApiServerPort",
    },
    {
      id: "bindAddress",
      group: "required",
      labelKey: "settings.messaging.apiServerBindAddress",
      helpKey: "settings.messaging.apiServerBindAddressHint",
      placeholderKey: "settings.messaging.apiServerBindAddressPlaceholder",
      consequenceKey: "settings.messaging.consequenceApiServerBindAddress",
    },
    {
      id: "requestTimeoutMs",
      group: "recommended",
      labelKey: "settings.messaging.requestTimeout",
      helpKey: "settings.messaging.requestTimeoutHint",
      placeholderKey: "settings.messaging.requestTimeoutPlaceholder",
      consequenceKey: "settings.messaging.consequenceTimeout",
    },
  ];
}

/**
 * The port the webhook card opens with; the same default the receiver binds.
 *
 * 8787 is the receiver's own default in `@pi-desktop/agent-host`, so a record
 * saved from this card without touching the port and one written by hand agree.
 */
export const WEBHOOK_RECEIVER_DEFAULT_PORT = 8787;

/** Where the shared signing secret lives in the host's secret store. */
export const WEBHOOK_RECEIVER_SECRET_REF = "secret:messaging-webhooks:signing-secret";

/** The `/webhooks/<path>` segment this build serves. */
export const WEBHOOK_RECEIVER_PATH = "generic";

/** The receiver record's self-identifying format and version. */
export const WEBHOOK_RECEIVER_FORMAT = "pi-desktop-messaging-webhook-receiver";
export const WEBHOOK_RECEIVER_VERSION = 1;

/** The replay window (seconds) and body cap (bytes) the card opens with. */
export const WEBHOOK_RECEIVER_REPLAY_WINDOW_SECONDS = 300;
export const WEBHOOK_RECEIVER_MAX_BODY_BYTES = 262_144;

/**
 * The receiver's one credential.
 *
 * Required, not optional: the receiver refuses to bind without a signing secret,
 * because an unauthenticated listener is a way into the agent for anything that
 * can reach the port. Unlike the local API's generated token this value is
 * chosen by the operator, because the sender on the other side has to be told
 * the same secret — it is the shared key of the HMAC both ends compute.
 */
const webhookSecrets: MessagingSecretSlot[] = [
  {
    id: "signing-secret",
    ref: WEBHOOK_RECEIVER_SECRET_REF,
    labelKey: "settings.messaging.webhookSigningSecret",
    hintKey: "settings.messaging.webhookSigningSecretHint",
    placeholderKey: "settings.messaging.webhookSigningSecretPlaceholder",
  },
];

/**
 * The receiver's fields: the secret, the listener, and the one session.
 *
 * There is no endpoint and no destination. A webhook has no API base to post
 * to — the URL is this listener's own — and the conversation an event belongs to
 * is named by the event's body, not by the record. What the record does own is
 * the session the event acts on: the receiver serves one bound session in this
 * build, and a record with none refuses every event rather than guessing.
 */
function webhookFields(): MessagingField[] {
  return [
    ...secretFields(webhookSecrets),
    {
      id: "port",
      group: "required",
      labelKey: "settings.messaging.webhookPort",
      helpKey: "settings.messaging.webhookPortHint",
      placeholderKey: "settings.messaging.webhookPortPlaceholder",
      consequenceKey: "settings.messaging.consequenceWebhookPort",
    },
    {
      id: "bindAddress",
      group: "required",
      labelKey: "settings.messaging.webhookBindAddress",
      helpKey: "settings.messaging.webhookBindAddressHint",
      placeholderKey: "settings.messaging.webhookBindAddressPlaceholder",
      consequenceKey: "settings.messaging.consequenceWebhookBindAddress",
    },
    {
      id: "sessionId",
      group: "required",
      labelKey: "settings.messaging.webhookSession",
      helpKey: "settings.messaging.webhookSessionHint",
      placeholderKey: "settings.messaging.webhookSessionPlaceholder",
      consequenceKey: "settings.messaging.consequenceWebhookSession",
    },
  ];
}

/**
 * Signal's one credential, optional: a bearer token for a bridge that asks for
 * one. The documented default bridge binds loopback and has none, so leaving
 * this empty is the normal case rather than a setup gap.
 */
const signalSecrets: MessagingSecretSlot[] = [
  {
    id: "access-token",
    ref: "secret:messaging-signal:token",
    labelKey: "settings.messaging.signalToken",
    hintKey: "settings.messaging.signalTokenHint",
    placeholderKey: "settings.messaging.signalTokenPlaceholder",
    optional: true,
  },
];

/**
 * Signal's fields.
 *
 * Two values are the whole setup: the address the bridge answers on, and the
 * account it is registered for. There is no "destination" — a reply goes to
 * whoever wrote, exactly as with email — so the record's destination stays
 * empty and the panel never shows it. The token is optional because a bridge on
 * loopback normally has none.
 */
function signalFields(): MessagingField[] {
  const field = (
    id: MessagingField["id"],
    group: MessagingField["group"],
    labelKey: string,
    helpKey: string,
    placeholderKey: string | undefined,
    consequenceKey: string,
  ): MessagingField => ({
    id,
    group,
    labelKey,
    helpKey,
    consequenceKey,
    ...(placeholderKey ? { placeholderKey } : {}),
  });
  return [
    field(
      "endpoint",
      "required",
      "settings.messaging.signalBridgeUrl",
      "settings.messaging.signalBridgeUrlHint",
      "settings.messaging.signalBridgeUrlPlaceholder",
      "settings.messaging.consequenceSignalBridge",
    ),
    field(
      "account",
      "required",
      "settings.messaging.signalAccount",
      "settings.messaging.signalAccountHint",
      "settings.messaging.signalAccountPlaceholder",
      "settings.messaging.consequenceSignalAccount",
    ),
    field(
      "allowedSenders",
      "required",
      "settings.messaging.signalAllowedSenders",
      "settings.messaging.signalAllowedSendersHint",
      "settings.messaging.signalAllowedSendersPlaceholder",
      "settings.messaging.consequenceSignalSenders",
    ),
    {
      id: "subject",
      group: "required",
      labelKey: "settings.messaging.subject",
      helpKey: "settings.messaging.subjectHint",
      placeholderKey: "settings.messaging.subjectPlaceholderSignal",
      consequenceKey: "settings.messaging.consequenceSubject",
    },
    {
      id: "roles",
      group: "required",
      labelKey: "settings.messaging.roles",
      helpKey: "settings.messaging.rolesHint",
      consequenceKey: "settings.messaging.consequenceRoles",
    },
    {
      // The bridge token is optional and belongs with the recommended fields:
      // a listener on loopback normally has none, so showing it as required
      // would make a working channel look unconfigured.
      id: "access-token",
      group: "recommended",
      labelKey: "settings.messaging.signalToken",
      helpKey: "settings.messaging.signalTokenHint",
      placeholderKey: "settings.messaging.signalTokenPlaceholder",
      consequenceKey: "settings.messaging.consequenceSignalToken",
    },
    {
      id: "permissionMode",
      group: "recommended",
      labelKey: "settings.messaging.permissionMode",
      helpKey: "settings.messaging.permissionModeHint",
      consequenceKey: "settings.messaging.consequencePermissionMode",
    },
  ];
}

/** IRC's only optional credential: a PASS line for a password-protected server. */
const ircSecrets: MessagingSecretSlot[] = [
  {
    id: "server-password",
    ref: "secret:messaging-irc:server-password",
    labelKey: "settings.messaging.ircServerPassword",
    hintKey: "settings.messaging.ircServerPasswordHint",
    placeholderKey: "settings.messaging.ircServerPasswordPlaceholder",
  },
];

/**
 * IRC's fields.
 *
 * The server address is required — IRC is a network of independent servers, so
 * there is no public default — and so is the nick, which is the identity the
 * client registers under. The channel list is recommended: the linked channel is
 * always joined, so a single-channel setup needs only the destination. The
 * server password is optional and lives in the secret store like every other
 * credential, never in the record.
 */
function ircFields(): MessagingField[] {
  const shared = channelFields({
    secrets: [],
    destinationLabelKey: "settings.messaging.ircChannel",
    destinationHelpKey: "settings.messaging.ircChannelHelp",
    destinationPlaceholderKey: "settings.messaging.ircChannelPlaceholder",
    subjectPlaceholderKey: "settings.messaging.subjectPlaceholderIrc",
    endpointPlaceholderKey: "settings.messaging.endpointPlaceholderIrc",
  });
  const endpoint = shared.find((field) => field.id === "endpoint");
  const rest = shared.filter((field) => field.id !== "endpoint");
  return [
    ...(endpoint ? [{ ...endpoint, group: "required" as const }] : []),
    {
      id: "nick" as const,
      group: "required" as const,
      labelKey: "settings.messaging.ircNick",
      helpKey: "settings.messaging.ircNickHint",
      placeholderKey: "settings.messaging.ircNickPlaceholder",
      consequenceKey: "settings.messaging.consequenceIrcNick",
    },
    ...rest.filter((field) => field.group === "required"),
    {
      id: "channels" as const,
      group: "recommended" as const,
      labelKey: "settings.messaging.ircChannels",
      helpKey: "settings.messaging.ircChannelsHint",
      placeholderKey: "settings.messaging.ircChannelsPlaceholder",
      consequenceKey: "settings.messaging.consequenceIrcChannels",
    },
    ...rest.filter((field) => field.group === "recommended"),
    {
      id: "server-password" as const,
      group: "recommended" as const,
      labelKey: "settings.messaging.ircServerPassword",
      helpKey: "settings.messaging.ircServerPasswordHint",
      placeholderKey: "settings.messaging.ircServerPasswordPlaceholder",
      consequenceKey: "settings.messaging.consequenceIrcServerPassword",
    },
  ];
}

/** ntfy's one credential, optional: a protected topic needs it, an open one does not. */
const ntfySecrets: MessagingSecretSlot[] = [
  {
    id: "access-token",
    ref: "secret:messaging-ntfy:access-token",
    labelKey: "settings.messaging.ntfyAccessToken",
    hintKey: "settings.messaging.ntfyAccessTokenHint",
    placeholderKey: "settings.messaging.ntfyTokenPlaceholder",
    optional: true,
  },
];

/**
 * ntfy's fields.
 *
 * The topic is the conversation, so it is required. The server URL is
 * recommended: ntfy's public server is a real default, and a self-hosted server
 * is entered over it. The access token is recommended rather than required
 * because a topic on an open server needs none — but leaving it blank on a
 * server that requires one means the poll is refused, which the field's own
 * consequence sentence says.
 */
function ntfyFields(): MessagingField[] {
  const shared = channelFields({
    secrets: [],
    destinationLabelKey: "settings.messaging.ntfyTopic",
    destinationHelpKey: "settings.messaging.ntfyTopicHelp",
    destinationPlaceholderKey: "settings.messaging.ntfyTopicPlaceholder",
    subjectPlaceholderKey: "settings.messaging.subjectPlaceholderNtfy",
    endpointPlaceholderKey: "settings.messaging.endpointPlaceholderNtfy",
  });
  const field = (id: MessagingFieldId | "access-token"): MessagingField[] => {
    const found = shared.find((entry) => entry.id === id);
    return found ? [found] : [];
  };
  const destination = shared.find((entry) => entry.id === "destination");
  return [
    ...(destination ? [{ ...destination, consequenceKey: "settings.messaging.consequenceNtfyTopic" }] : []),
    ...field("subject"),
    ...field("roles"),
    {
      id: "access-token" as const,
      group: "recommended" as const,
      labelKey: "settings.messaging.ntfyAccessToken",
      helpKey: "settings.messaging.ntfyAccessTokenHint",
      placeholderKey: "settings.messaging.ntfyTokenPlaceholder",
      consequenceKey: "settings.messaging.consequenceNtfyToken",
    },
    ...field("permissionMode"),
    ...field("endpoint"),
    ...field("requestTimeoutMs"),
  ];
}

const telegramSecrets: MessagingSecretSlot[] = [
  {
    id: "bot-token",
    ref: "secret:messaging-telegram:bot-token",
    labelKey: "settings.messaging.botToken",
    hintKey: "settings.messaging.botTokenHint",
    placeholderKey: "settings.messaging.telegramTokenPlaceholder",
  },
];

const discordSecrets: MessagingSecretSlot[] = [
  {
    id: "bot-token",
    ref: "secret:messaging-discord:bot-token",
    labelKey: "settings.messaging.discordBotToken",
    hintKey: "settings.messaging.discordBotTokenHint",
    placeholderKey: "settings.messaging.discordTokenPlaceholder",
  },
];

const mattermostSecrets: MessagingSecretSlot[] = [
  {
    id: "access-token",
    ref: "secret:messaging-mattermost:access-token",
    labelKey: "settings.messaging.mattermostAccessToken",
    hintKey: "settings.messaging.mattermostAccessTokenHint",
    placeholderKey: "settings.messaging.mattermostTokenPlaceholder",
  },
];

const matrixSecrets: MessagingSecretSlot[] = [
  {
    id: "access-token",
    ref: "secret:messaging-matrix:access-token",
    labelKey: "settings.messaging.matrixAccessToken",
    hintKey: "settings.messaging.matrixAccessTokenHint",
    placeholderKey: "settings.messaging.matrixTokenPlaceholder",
  },
];

const homeAssistantSecrets: MessagingSecretSlot[] = [
  {
    id: "access-token",
    ref: "secret:messaging-home-assistant:access-token",
    labelKey: "settings.messaging.homeAssistantAccessToken",
    hintKey: "settings.messaging.homeAssistantAccessTokenHint",
    placeholderKey: "settings.messaging.homeAssistantTokenPlaceholder",
  },
];

const slackSecrets: MessagingSecretSlot[] = [
  {
    id: "app-token",
    ref: "secret:messaging-slack:app-token",
    labelKey: "settings.messaging.appToken",
    hintKey: "settings.messaging.appTokenHint",
    placeholderKey: "settings.messaging.slackAppTokenPlaceholder",
  },
  {
    id: "bot-token",
    ref: "secret:messaging-slack:bot-token",
    labelKey: "settings.messaging.slackBotToken",
    hintKey: "settings.messaging.slackBotTokenHint",
    placeholderKey: "settings.messaging.slackTokenPlaceholder",
  },
];

/**
 * Every platform the product lists, in the product's own order.
 *
 * The list is the catalogue, not a promise: an entry marked `support:
 * "supported"` is a channel whose send and receive paths exist in this build.
 * Every other entry carries the sentence that says what it would take, and the
 * class that sentence belongs to, so a user comparing this page with the
 * product can see both what exists and what the gap is.
 *
 * Counts are deliberately not written down here. They were, twice, in two
 * copies of this comment, and both had drifted by the time anyone read them.
 * `SUPPORTED_MESSAGING_PLATFORMS` is the answer; a sentence is not.
 */
export const MESSAGING_PLATFORMS: MessagingPlatform[] = [
  {
    id: "telegram",
    support: "supported",
    section: "messagingTelegram",
    format: "pi-desktop-messaging-telegram",
    version: 1,
    defaultEndpoint: "https://api.telegram.org",
    labelKey: "settings.messaging.platformTelegram",
    blurbKey: "settings.messaging.blurbTelegram",
    guideUrl: "https://core.telegram.org/bots/features",
    credentialStepKeys: [
      "settings.messaging.stepTelegram1",
      "settings.messaging.stepTelegram2",
      "settings.messaging.stepTelegram3",
      "settings.messaging.stepTelegram4",
    ],
    secrets: telegramSecrets,
    fields: channelFields({
      secrets: telegramSecrets,
      destinationLabelKey: "settings.messaging.chatId",
      destinationHelpKey: "settings.messaging.chatIdHelp",
      destinationPlaceholderKey: "settings.messaging.chatIdPlaceholder",
      subjectPlaceholderKey: "settings.messaging.subjectPlaceholderTelegram",
    }),
  },
  {
    id: "discord",
    support: "supported",
    section: "messagingDiscord",
    format: "pi-desktop-messaging-discord",
    version: 1,
    defaultEndpoint: "https://discord.com/api/v10",
    labelKey: "settings.messaging.platformDiscord",
    blurbKey: "settings.messaging.blurbDiscord",
    guideUrl: "https://discord.com/developers/docs/topics/gateway",
    credentialStepKeys: [
      "settings.messaging.stepDiscord1",
      "settings.messaging.stepDiscord2",
      "settings.messaging.stepDiscord3",
      "settings.messaging.stepDiscord4",
      "settings.messaging.stepDiscord5",
    ],
    secrets: discordSecrets,
    fields: channelFields({
      secrets: discordSecrets,
      destinationLabelKey: "settings.messaging.discordChannelId",
      destinationHelpKey: "settings.messaging.discordChannelIdHelp",
      destinationPlaceholderKey: "settings.messaging.discordChannelIdPlaceholder",
      subjectPlaceholderKey: "settings.messaging.subjectPlaceholderDiscord",
      endpointPlaceholderKey: "settings.messaging.endpointPlaceholderDiscord",
    }),
  },
  {
    id: "slack",
    support: "supported",
    section: "messagingSlack",
    format: "pi-desktop-messaging-slack",
    version: 1,
    defaultEndpoint: "https://slack.com",
    labelKey: "settings.messaging.platformSlack",
    blurbKey: "settings.messaging.blurbSlack",
    guideUrl: "https://api.slack.com/apis/socket-mode",
    credentialStepKeys: [
      "settings.messaging.stepSlack1",
      "settings.messaging.stepSlack2",
      "settings.messaging.stepSlack3",
      "settings.messaging.stepSlack4",
      "settings.messaging.stepSlack5",
    ],
    secrets: slackSecrets,
    fields: channelFields({
      secrets: slackSecrets,
      destinationLabelKey: "settings.messaging.channelId",
      destinationHelpKey: "settings.messaging.channelIdHelp",
      destinationPlaceholderKey: "settings.messaging.channelIdPlaceholder",
      subjectPlaceholderKey: "settings.messaging.subjectPlaceholderSlack",
    }),
  },
  {
    id: "mattermost",
    support: "supported",
    section: "messagingMattermost",
    format: "pi-desktop-messaging-mattermost",
    version: 1,
    // A self-hosted product has no public default: the server URL is required.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformMattermost",
    blurbKey: "settings.messaging.blurbMattermost",
    guideUrl: "https://developers.mattermost.com/integrate/reference/",
    credentialStepKeys: [
      "settings.messaging.stepMattermost1",
      "settings.messaging.stepMattermost2",
      "settings.messaging.stepMattermost3",
      "settings.messaging.stepMattermost4",
    ],
    secrets: mattermostSecrets,
    fields: mattermostFields(),
  },
  {
    id: "matrix",
    support: "supported",
    section: "messagingMatrix",
    format: "pi-desktop-messaging-matrix",
    version: 1,
    // Federated and self-hosted: the homeserver URL is required, with no default.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformMatrix",
    blurbKey: "settings.messaging.blurbMatrix",
    noteKey: "settings.messaging.matrixEncryptionNote",
    guideUrl: "https://spec.matrix.org/latest/client-server-api/",
    credentialStepKeys: [
      "settings.messaging.stepMatrix1",
      "settings.messaging.stepMatrix2",
      "settings.messaging.stepMatrix3",
      "settings.messaging.stepMatrix4",
    ],
    secrets: matrixSecrets,
    fields: matrixFields(),
  },
  {
    id: "whatsapp",
    support: "unsupported",
    labelKey: "settings.messaging.platformWhatsapp",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "bridgeOrPoll",
    requirementKey: "settings.messaging.needsQrPairing",
    guideUrl: "https://developers.facebook.com/docs/whatsapp",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "signal",
    support: "supported",
    section: "messagingSignal",
    format: "pi-desktop-messaging-signal",
    version: 1,
    // A bridge on this machine: the documented default listener.
    defaultEndpoint: "http://127.0.0.1:8080",
    labelKey: "settings.messaging.platformSignal",
    blurbKey: "settings.messaging.blurbSignal",
    noteKey: "settings.messaging.signalNote",
    limitationKey: "settings.messaging.signalLimitations",
    credentialStepKeys: [
      "settings.messaging.stepSignal1",
      "settings.messaging.stepSignal2",
      "settings.messaging.stepSignal3",
      "settings.messaging.stepSignal4",
      "settings.messaging.stepSignal5",
    ],
    secrets: signalSecrets,
    fields: signalFields(),
  },
  {
    id: "blueBubbles",
    support: "unsupported",
    labelKey: "settings.messaging.platformBlueBubbles",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "bridgeOrPoll",
    requirementKey: "settings.messaging.needsLocalBridge",
    guideUrl: "https://bluebubbles.app/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "homeAssistant",
    support: "supported",
    section: "messagingHomeAssistant",
    format: "pi-desktop-messaging-home-assistant",
    version: 1,
    // Home Assistant runs on the user's own network: no public default.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformHomeAssistant",
    blurbKey: "settings.messaging.blurbHomeAssistant",
    noteKey: "settings.messaging.homeAssistantInboundNote",
    limitationKey: "settings.messaging.homeAssistantLimitations",
    guideUrl: "https://developers.home-assistant.io/docs/api/websocket/",
    credentialStepKeys: [
      "settings.messaging.stepHomeAssistant1",
      "settings.messaging.stepHomeAssistant2",
      "settings.messaging.stepHomeAssistant3",
      "settings.messaging.stepHomeAssistant4",
      "settings.messaging.stepHomeAssistant5",
    ],
    secrets: homeAssistantSecrets,
    fields: homeAssistantFields(),
  },
  {
    id: "email",
    support: "supported",
    section: "messagingEmail",
    format: "pi-desktop-messaging-email",
    version: 1,
    // Email has no API base to default to: the provider's own hostnames are the
    // provider's, so the two server fields are required and empty here.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformEmail",
    blurbKey: "settings.messaging.blurbEmail",
    noteKey: "settings.messaging.emailNote",
    limitationKey: "settings.messaging.emailLimitations",
    guideUrl: "https://datatracker.ietf.org/doc/html/rfc9051",
    credentialStepKeys: [
      "settings.messaging.stepEmail1",
      "settings.messaging.stepEmail2",
      "settings.messaging.stepEmail3",
      "settings.messaging.stepEmail4",
      "settings.messaging.stepEmail5",
    ],
    secrets: emailSecrets,
    fields: emailFields(),
  },
  {
    id: "sms",
    support: "unsupported",
    labelKey: "settings.messaging.platformSms",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://www.twilio.com/docs/messaging",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "dingtalk",
    support: "unsupported",
    labelKey: "settings.messaging.platformDingtalk",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://open.dingtalk.com/document/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "feishu",
    support: "unsupported",
    labelKey: "settings.messaging.platformFeishu",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://open.feishu.cn/document/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "googleChat",
    support: "unsupported",
    labelKey: "settings.messaging.platformGoogleChat",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://developers.google.com/chat",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "wecomGroup",
    support: "unsupported",
    labelKey: "settings.messaging.platformWecomGroup",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://developer.work.weixin.qq.com/document/path/91770",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "wecomApp",
    support: "unsupported",
    labelKey: "settings.messaging.platformWecomApp",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://developer.work.weixin.qq.com/document/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "weixin",
    support: "unsupported",
    labelKey: "settings.messaging.platformWeixin",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "platformApproval",
    requirementKey: "settings.messaging.needsPlatformApproval",
    guideUrl: "https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "qqBot",
    support: "unsupported",
    labelKey: "settings.messaging.platformQqBot",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "platformApproval",
    requirementKey: "settings.messaging.needsPlatformApproval",
    guideUrl: "https://bot.q.qq.com/wiki/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "yuanbao",
    support: "unsupported",
    labelKey: "settings.messaging.platformYuanbao",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "platformApproval",
    requirementKey: "settings.messaging.needsPlatformApproval",
    guideUrl: "https://yuanbao.tencent.com/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "apiServer",
    support: "supported",
    section: "messagingApiServer",
    format: "pi-desktop-messaging-api-server",
    version: 1,
    // No API base: the "endpoint" is a listener on this machine, not a remote
    // service, so the form has nothing to fill in here.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformApiServer",
    blurbKey: "settings.messaging.blurbApiServer",
    noteKey: "settings.messaging.apiServerNote",
    limitationKey: "settings.messaging.apiServerLimitations",
    credentialStepKeys: [
      "settings.messaging.stepApiServer1",
      "settings.messaging.stepApiServer2",
      "settings.messaging.stepApiServer3",
      "settings.messaging.stepApiServer4",
    ],
    secrets: apiServerSecrets,
    fields: apiServerFields(),
  },
  {
    id: "webhooks",
    support: "supported",
    section: "messagingWebhookReceiver",
    format: WEBHOOK_RECEIVER_FORMAT,
    version: WEBHOOK_RECEIVER_VERSION,
    // No API base: the "endpoint" is this listener's own URL, not a remote
    // service, so the form has nothing to fill in here.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformWebhooks",
    blurbKey: "settings.messaging.blurbWebhooks",
    noteKey: "settings.messaging.webhooksNote",
    limitationKey: "settings.messaging.webhooksLimitations",
    guideUrl: "https://www.standardwebhooks.com/",
    credentialStepKeys: [
      "settings.messaging.stepWebhooks1",
      "settings.messaging.stepWebhooks2",
      "settings.messaging.stepWebhooks3",
      "settings.messaging.stepWebhooks4",
    ],
    secrets: webhookSecrets,
    fields: webhookFields(),
  },
  {
    id: "a2a",
    support: "unsupported",
    labelKey: "settings.messaging.platformA2a",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "transport",
    requirementKey: "settings.messaging.needsTransport",
    guideUrl: "https://a2a-protocol.org/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "buzz",
    support: "unsupported",
    labelKey: "settings.messaging.platformBuzz",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "longConnection",
    requirementKey: "settings.messaging.needsSocket",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "imessagePhone",
    support: "unsupported",
    labelKey: "settings.messaging.platformImessagePhone",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "bridgeOrPoll",
    requirementKey: "settings.messaging.needsBridge",
    guideUrl: "https://support.apple.com/guide/messages/welcome/mac",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "irc",
    support: "supported",
    section: "messagingIrc",
    format: "pi-desktop-messaging-irc",
    version: 1,
    // IRC is a network of independent servers: there is no public default.
    defaultEndpoint: "",
    labelKey: "settings.messaging.platformIrc",
    blurbKey: "settings.messaging.blurbIrc",
    guideUrl: "https://modern.ircdocs.horse/",
    credentialStepKeys: [
      "settings.messaging.stepIrc1",
      "settings.messaging.stepIrc2",
      "settings.messaging.stepIrc3",
      "settings.messaging.stepIrc4",
      "settings.messaging.stepIrc5",
    ],
    secrets: ircSecrets,
    fields: ircFields(),
    limitationKey: "settings.messaging.ircLimitations",
  },
  {
    id: "line",
    support: "unsupported",
    labelKey: "settings.messaging.platformLine",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://developers.line.biz/en/docs/messaging-api/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "microsoftGraph",
    support: "unsupported",
    labelKey: "settings.messaging.platformMicrosoftGraph",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://learn.microsoft.com/graph/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "teams",
    support: "unsupported",
    labelKey: "settings.messaging.platformTeams",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://learn.microsoft.com/microsoftteams/platform/bots/what-are-bots",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "ntfy",
    support: "supported",
    section: "messagingNtfy",
    format: "pi-desktop-messaging-ntfy",
    version: 1,
    // ntfy's public server is a real default; a self-hosted server replaces it.
    defaultEndpoint: "https://ntfy.sh",
    labelKey: "settings.messaging.platformNtfy",
    blurbKey: "settings.messaging.blurbNtfy",
    noteKey: "settings.messaging.ntfyPublicTopicNote",
    limitationKey: "settings.messaging.ntfyLimitations",
    guideUrl: "https://docs.ntfy.sh/subscribe/api/",
    credentialStepKeys: [
      "settings.messaging.stepNtfy1",
      "settings.messaging.stepNtfy2",
      "settings.messaging.stepNtfy3",
      "settings.messaging.stepNtfy4",
      "settings.messaging.stepNtfy5",
    ],
    secrets: ntfySecrets,
    fields: ntfyFields(),
  },
  {
    id: "raft",
    support: "unsupported",
    labelKey: "settings.messaging.platformRaft",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "longConnection",
    requirementKey: "settings.messaging.needsSocket",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "relay",
    support: "unsupported",
    labelKey: "settings.messaging.platformRelay",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "transport",
    requirementKey: "settings.messaging.needsTransport",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "simplex",
    support: "unsupported",
    labelKey: "settings.messaging.platformSimplex",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "longConnection",
    requirementKey: "settings.messaging.needsSocket",
    guideUrl: "https://simplex.chat/docs/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "whatsappCloud",
    support: "unsupported",
    labelKey: "settings.messaging.platformWhatsappCloud",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "platformApproval",
    requirementKey: "settings.messaging.needsBusinessAccount",
    guideUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    credentialStepKeys: [],
    secrets: [],
  },
];

/** The platforms with a working panel, in rail order. */
export const SUPPORTED_MESSAGING_PLATFORMS: SupportedMessagingPlatform[] =
  MESSAGING_PLATFORMS.filter(
    (platform): platform is SupportedMessagingPlatform => platform.support === "supported",
  );

export const UNSUPPORTED_MESSAGING_PLATFORMS: UnsupportedMessagingPlatform[] =
  MESSAGING_PLATFORMS.filter(
    (platform): platform is UnsupportedMessagingPlatform => platform.support === "unsupported",
  );

/**
 * Which gateway a supported platform rides. The third status dimension is the
 * receive loop the desktop main process started for this channel, so the key is
 * the loop's, not the settings section's.
 */
export type MessagingGatewayChannel =
  | "telegram"
  | "slack"
  | "discord"
  | "mattermost"
  | "matrix"
  | "irc"
  | "homeAssistant"
  | "ntfy"
  | "email"
  | "signal"
  | "apiServer"
  | "webhookReceiver";

/**
 * What the main process reports about the inbound loops, read once per panel
 * refresh. `booted` is whether host-core and the Agent Host came up at all: with
 * them down no loop can exist, and a panel should say that rather than blame the
 * channel's configuration.
 */
export type MessagingGatewaySnapshot = {
  booted: boolean;
  telegram: boolean;
  slack: boolean;
  discord: boolean;
  mattermost: boolean;
  matrix: boolean;
  irc: boolean;
  homeAssistant: boolean;
  ntfy: boolean;
  email: boolean;
  signal: boolean;
  apiServer: boolean;
  /** Whether the shared inbound-webhook receiver is listening. */
  webhookReceiver: boolean;
  /**
   * Why the local API channel is not listening, when its start failed for a
   * reason a person can act on — a port already taken, an address refused. It is
   * the one channel with a failure reason in the snapshot, because a bind
   * failure is a fact about the record that retrying does not fix.
   */
  apiServerError: string | null;
  /** Why the webhook receiver is not listening, on the same terms. */
  webhookReceiverError: string | null;
}

/** The snapshot to use before the first reply arrives: nothing is known to run. */
export const MESSAGING_GATEWAY_OFF: MessagingGatewaySnapshot = {
  booted: false,
  telegram: false,
  slack: false,
  discord: false,
  mattermost: false,
  matrix: false,
  irc: false,
  homeAssistant: false,
  ntfy: false,
  email: false,
  signal: false,
  apiServer: false,
  webhookReceiver: false,
  apiServerError: null,
  webhookReceiverError: null,
};

/** The catalogue ids that own a receive loop, i.e. the snapshot's channel keys. */
type GatewayBackedPlatformId =
  | Extract<MessagingPlatformId, MessagingGatewayChannel>
  /**
   * The webhook receiver's catalogue id is not its snapshot key: the card is one
   * platform, the key names the shared surface it listens on.
   */
  | "webhooks";

/**
 * Which snapshot key each platform's loop is filed under.
 *
 * `MessagingGatewaySnapshot` is already keyed per channel, so a channel's state
 * is a lookup on its own key — not a chain of `id === …` comparisons whose final
 * `else` is free to answer with whichever channel happened to be written last.
 * Matrix did exactly that: it had no branch of its own and fell through to
 * Telegram's flag, so a running Matrix loop made the Matrix card report another
 * channel's state. A table has no tail to fall into.
 *
 * The mapping is stated rather than assumed (`id` doubles as the key) because
 * the two vocabularies are separate types and either side may be renamed alone.
 * It is typed exhaustively over the gateway-backed ids, so a channel added to
 * `MessagingGatewayChannel` without an entry here stops compiling, and the test
 * that walks `SUPPORTED_MESSAGING_PLATFORMS` catches a catalogue channel with
 * no entry at all.
 */
const GATEWAY_CHANNEL_BY_PLATFORM: Partial<Record<MessagingPlatformId, MessagingGatewayChannel>> &
  Record<GatewayBackedPlatformId, MessagingGatewayChannel> = {
  telegram: "telegram",
  slack: "slack",
  discord: "discord",
  mattermost: "mattermost",
  matrix: "matrix",
  irc: "irc",
  homeAssistant: "homeAssistant",
  ntfy: "ntfy",
  email: "email",
  signal: "signal",
  apiServer: "apiServer",
  webhooks: "webhookReceiver",
};

/**
 * The snapshot key a platform's loop is filed under, or `null` when this build
 * has no loop for it. `null` is answered as "not running", never as a sibling's
 * flag: a channel with no key of its own has no loop to report, and `stopped`
 * is the honest reading of that — running is the claim that needs evidence.
 */
function gatewayChannelFor(id: MessagingPlatformId): MessagingGatewayChannel | null {
  return GATEWAY_CHANNEL_BY_PLATFORM[id] ?? null;
}

/** The link roles the inbound driver accepts, in `RACP_ROLES` order. */
export const MESSAGING_ROLES: RacpRole[] = ["viewer", "controller", "approver", "owner"];

/** The permission modes a contract approval may carry, in `RACP_PERMISSION_MODES` order. */
export const MESSAGING_PERMISSION_MODES: RacpPermissionMode[] = [
  "ask",
  "accept-edits",
  "auto",
];

/** The record's timeout bounds, as `crates/host-core/src/messaging_outbound.rs` enforces them. */
export const MESSAGING_MIN_TIMEOUT_MS = 250;
export const MESSAGING_MAX_TIMEOUT_MS = 60_000;

/**
 * What the form holds. `secrets` is the only place a typed credential lives; it
 * is emptied after a successful save and is never merged into the record.
 */
export type MessagingDraft = {
  /**
   * Whether this channel shows a process card (ADR 0340). The runtime reads it
   * from the same section, so the draft carries it like any other field.
   */
  card: boolean;
  endpoint: string;
  /** IRC only: the nick to register. Empty for every other channel. */
  nick: string;
  /** IRC only: extra channels to join, comma-separated. */
  channels: string;
  destination: string;
  subject: string;
  roles: RacpRole[];
  permissionMode: RacpPermissionMode;
  requestTimeoutMs: string;
  /** Email and Signal: the servers or account, its sender allowlist and prefix. */
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: "tls" | "starttls";
  username: string;
  allowedSenders: string;
  subjectPrefix: string;
  /** Signal only: the account the bridge is registered for. */
  account: string;
  /** The local API only: the listener's port and bind address, as typed text. */
  port: string;
  bindAddress: string;
  /** The webhook receiver only: the session an accepted event acts on. */
  sessionId: string;
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
  platform: SupportedMessagingPlatform,
  record: MessagingPlatformRecord | null | undefined,
): MessagingDraft {
  // The receiver's record has no `endpoint`/`destination`, so it is read through
  // the channel shape as a partial: every field it does not carry stays absent,
  // which is exactly what the form's defaults are for.
  const channel = (record ?? null) as Partial<MessagingChannelSettings> | null;
  const linked = channel?.inbound?.linkedPrincipal;
  const roles = MESSAGING_ROLES.filter((role) => linked?.roles?.includes(role));
  return {
    endpoint: trimmed(channel?.endpoint) || platform.defaultEndpoint,
    nick: trimmed(channel?.nick),
    channels: trimmed(channel?.channels),
    destination: trimmed(channel?.destination),
    subject: trimmed(linked?.subject),
    roles: roles.length > 0 ? roles : ["controller"],
    permissionMode: MESSAGING_PERMISSION_MODES.includes(
      channel?.inbound?.permissionMode as RacpPermissionMode,
    )
      ? (channel?.inbound?.permissionMode as RacpPermissionMode)
      : "ask",
    requestTimeoutMs:
      typeof channel?.requestTimeoutMs === "number" ? String(channel.requestTimeoutMs) : "",
    imapHost: trimmed(channel?.imapHost),
    imapPort: typeof channel?.imapPort === "number" ? String(channel.imapPort) : "",
    smtpHost: trimmed(channel?.smtpHost),
    smtpPort: typeof channel?.smtpPort === "number" ? String(channel.smtpPort) : "",
    smtpSecurity: channel?.smtpSecurity === "starttls" ? "starttls" : "tls",
    username: trimmed(channel?.username),
    allowedSenders: Array.isArray(channel?.allowedSenders)
      ? channel.allowedSenders.join(", ")
      : "",
    subjectPrefix: trimmed(channel?.subjectPrefix),
    account: trimmed(channel?.account),
    port:
      typeof channel?.port === "number"
        ? String(channel.port)
        : String(
            platform.id === "webhooks" ? WEBHOOK_RECEIVER_DEFAULT_PORT : API_SERVER_DEFAULT_PORT,
          ),
    bindAddress: trimmed(channel?.bindAddress) || "127.0.0.1",
    sessionId: trimmed(channel?.inbound?.sessionId),
    // Read structurally: a stored record may carry the switch even when the
    // settings type this build links against predates it.
    card: (channel as unknown as Record<string, unknown> | undefined)?.card === true,
    secrets: {},
  };
}

/** A draft field's value as text, for the completeness checks. */
function draftText(draft: MessagingDraft, id: MessagingField["id"]): string {
  switch (id) {
    case "imapHost":
      return draft.imapHost;
    case "imapPort":
      return draft.imapPort;
    case "smtpHost":
      return draft.smtpHost;
    case "smtpPort":
      return draft.smtpPort;
    case "smtpSecurity":
      return draft.smtpSecurity;
    case "username":
      return draft.username;
    case "allowedSenders":
      return draft.allowedSenders;
    case "endpoint":
      return draft.endpoint;
    case "subjectPrefix":
      return draft.subjectPrefix;
    case "account":
      return draft.account;
    case "port":
      return draft.port;
    case "bindAddress":
      return draft.bindAddress;
    case "sessionId":
      return draft.sessionId;
    default:
      return "";
  }
}

/** Split an allowlist or channel list into trimmed, non-empty entries. */
function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The allowlist a save writes: trimmed, lowered, and without repeats.
 *
 * Lowering is not cosmetic — the channel compares case-insensitively, so the
 * record should not depend on how the same UUID was typed twice.
 */
function allowlistFromDraft(draft: MessagingDraft): string[] {
  return [...new Set(splitList(draft.allowedSenders).map((entry) => entry.toLowerCase()))];
}

/** True when the record is this build's own, not a foreign or future one. */
export function isOwnRecord(
  platform: SupportedMessagingPlatform,
  record: MessagingPlatformRecord | null | undefined,
): boolean {
  if (!record) return false;
  return record.format === platform.format && record.version === platform.version;
}

/** The fields of one group, in panel order. */
export function fieldsInGroup(
  platform: SupportedMessagingPlatform,
  group: MessagingFieldGroup,
): MessagingField[] {
  return platform.fields.filter((field) => field.group === group);
}

/**
 * The record fields a save still needs, as i18n-neutral field ids: the
 * destination, and the two halves of the link. A credential is checked by
 * presence, not by this function, because an existing secret needs no retyping.
 */
export function draftMissing(
  platform: SupportedMessagingPlatform,
  draft: MessagingDraft,
): string[] {
  const missing: string[] = [];
  if (platform.id === "apiServer") {
    // The local API has no destination and no link to name: the token is the
    // identity, and the conversation is the caller's to choose. What a record
    // must carry is where its listener binds — a port in the TCP range and an
    // address — so a save cannot produce a listener that could not start.
    const port = Number(trimmed(draft.port));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) missing.push("port");
    if (trimmed(draft.bindAddress) === "") missing.push("bindAddress");
    return missing;
  }
  if (platform.id === "webhooks") {
    // The receiver has no destination, no link and no endpoint: the signing
    // secret is its identity and the bound session is where an accepted event
    // lands. What a save must carry is a port in the TCP range, an address and
    // that session, so the form cannot store a record the start gate would leave
    // inert. The secret is not checked here, for the same reason it is not
    // checked for any channel: a save may store a record before its credential,
    // and the Setup dimension reports the gap.
    const port = Number(trimmed(draft.port));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) missing.push("port");
    if (trimmed(draft.bindAddress) === "") missing.push("bindAddress");
    if (trimmed(draft.sessionId) === "") missing.push("sessionId");
    return missing;
  }
  if (platform.id === "email" || platform.id === "signal") {
    // These two channels have no single "destination": email's destination is
    // its sender allowlist, and Signal's is whoever wrote. Every field they
    // need is named by the catalogue rather than assumed here, and a credential
    // is checked by presence (below), not by this function.
    for (const field of platform.fields) {
      if (field.group !== "required") continue;
      if (field.id === "subject" || field.id === "roles") continue;
      if (platform.secrets.some((slot) => slot.id === field.id)) continue;
      // An allowlist is filled only when at least one identity survives the
      // split: a field of commas and spaces is blank, not four entries.
      const filled =
        field.id === "allowedSenders"
          ? splitList(draft.allowedSenders).length > 0
          : draftText(draft, field.id).trim() !== "";
      if (!filled) missing.push(field.id);
    }
  } else if (trimmed(draft.destination) === "") {
    missing.push("destination");
  }
  if (platform.fields.some((field) => field.id === "nick") && trimmed(draft.nick) === "") {
    missing.push("nick");
  }
  if (trimmed(draft.subject) === "" || draft.roles.length === 0) missing.push("link");
  return missing;
}

/** Whether the typed timeout is usable: empty means the host default. */
export function isTimeoutValid(draft: MessagingDraft): boolean {
  const value = trimmed(draft.requestTimeoutMs);
  if (value === "") return true;
  const parsed = Number(value);
  return (
    Number.isInteger(parsed) &&
    parsed >= MESSAGING_MIN_TIMEOUT_MS &&
    parsed <= MESSAGING_MAX_TIMEOUT_MS
  );
}

/** Whether a save is allowed: the required fields are there and the timeout parses. */
export function canSave(platform: SupportedMessagingPlatform, draft: MessagingDraft): boolean {
  return draftMissing(platform, draft).length === 0 && isTimeoutValid(draft);
}

export type MessagingEnabledState = "on" | "off" | "unreadable";
export type MessagingSetupState = "complete" | "incomplete" | "notStarted" | "unknown";
export type MessagingGatewayState = "running" | "stopped";

/**
 * The channel in three dimensions that are computed independently, because they
 * answer three different questions and a single badge would hide two of them:
 *
 * - `enabled`: is a record of ours stored? `off` means no section at all (the
 *   host registers nothing and the loop polls nothing); `unreadable` means a
 *   section exists with another `format`/`version`, which the host refuses
 *   rather than half-reads.
 * - `setup`: does that record carry everything the channel needs — destination,
 *   link, and every credential its transport reads? `notStarted` is the state of
 *   a channel that was never enabled; `unknown` belongs to an unreadable record.
 * - `gateway`: did the desktop main process start this channel's receive loop,
 *   and is that loop still running? Read from `MessagingGatewaySnapshot`, which
 *   is the main process's own view of the handles it started.
 *
 * The three never collapse: a complete record with a stopped loop is enabled,
 * set up and not running — a real combination after a restart that failed, or on
 * a host that never booted.
 */
export type MessagingChannelState = {
  enabled: MessagingEnabledState;
  setup: MessagingSetupState;
  gateway: MessagingGatewayState;
  /** What the record still lacks, as field ids. Empty unless `setup` is `incomplete`. */
  missing: string[];
};

/** The field ids a stored record still lacks: destination, link, credentials. */
export function missingFromRecord(
  platform: SupportedMessagingPlatform,
  record: MessagingPlatformRecord,
  secretPresent: Record<string, boolean>,
): string[] {
  const missing: string[] = [];
  // The receiver's record is not a channel record, so the branches below read it
  // through the channel shape once: a field the receiver does not carry reads as
  // absent, which is what the completeness check wants.
  const channel = record as MessagingChannelSettings;
  if (platform.id === "webhooks") {
    // The receiver's own facts: a usable port, a bind address, and the one
    // session an accepted event acts on. The session lives inside `inbound`
    // because that is where every channel's binding lives, so it is read there
    // rather than from a top-level field this record does not have.
    const port = record.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      missing.push("port");
    }
    if (trimmed(record.bindAddress) === "") missing.push("bindAddress");
    if (trimmed(record.inbound?.sessionId) === "") missing.push("sessionId");
  } else if (platform.id === "apiServer") {
    // No destination and no linked principal: the token authenticates the
    // caller, so the only record facts that can be missing are the listener's.
    const port = channel.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      missing.push("port");
    }
    if (trimmed(channel.bindAddress) === "") missing.push("bindAddress");
  } else if (platform.id === "email") {
    if (trimmed(channel.imapHost) === "") missing.push("imapHost");
    if (typeof channel.imapPort !== "number") missing.push("imapPort");
    if (trimmed(channel.smtpHost) === "") missing.push("smtpHost");
    if (typeof channel.smtpPort !== "number") missing.push("smtpPort");
    if (trimmed(channel.username) === "") missing.push("username");
    if (!Array.isArray(channel.allowedSenders) || channel.allowedSenders.length === 0) {
      missing.push("allowedSenders");
    }
  } else if (platform.id === "signal") {
    if (trimmed(channel.endpoint) === "") missing.push("endpoint");
    if (trimmed(channel.account) === "") missing.push("account");
    // Fail closed: a record with no allowed sender is incomplete, not open.
    if (!Array.isArray(channel.allowedSenders) || channel.allowedSenders.length === 0) {
      missing.push("allowedSenders");
    }
  } else {
    if (trimmed(channel.endpoint) === "" && trimmed(platform.defaultEndpoint) === "") {
      missing.push("endpoint");
    }
    if (trimmed(channel.destination) === "") missing.push("destination");
  }
  if (platform.fields.some((field) => field.id === "nick") && trimmed(channel.nick) === "") {
    missing.push("nick");
  }
  // The two channels whose caller is identified by a credential rather than by a
  // linked principal: the local API's token holder, and the webhook's signing
  // secret holder. Neither has a link to record, so requiring one would mark a
  // working channel incomplete forever.
  if (platform.id !== "apiServer" && platform.id !== "webhooks") {
    const linked = channel.inbound?.linkedPrincipal;
    if (!linked || trimmed(linked.subject) === "" || (linked.roles?.length ?? 0) === 0) {
      missing.push("link");
    }
  }
  for (const slot of platform.secrets) {
    // An optional credential is not a setup gap: ntfy's topic may be open.
    if (slot.optional === true) continue;
    if (secretPresent[slot.ref] !== true) missing.push(slot.id);
  }
  return missing;
}

/** The three state dimensions, each from its own evidence. */
export function deriveChannelState(
  platform: SupportedMessagingPlatform,
  record: MessagingPlatformRecord | null | undefined,
  secretPresent: Record<string, boolean>,
  gateway: MessagingGatewaySnapshot,
): MessagingChannelState {
  const own = isOwnRecord(platform, record);
  const enabled: MessagingEnabledState = !record ? "off" : own ? "on" : "unreadable";
  const missing = record && own ? missingFromRecord(platform, record, secretPresent) : [];
  const setup: MessagingSetupState = !record
    ? "notStarted"
    : !own
      ? "unknown"
      : missing.length > 0
        ? "incomplete"
        : "complete";
  // The channel's own key: one lookup, and a platform with no key of its own
  // reads as stopped instead of inheriting the last branch's flag.
  const channel = gatewayChannelFor(platform.id);
  const gatewayState: MessagingGatewayState =
    channel !== null && gateway.booted && gateway[channel] === true ? "running" : "stopped";
  return { enabled, setup, gateway: gatewayState, missing };
}

/**
 * How the gateway may be *described*, given the channel it belongs to.
 *
 * `gateway` above is the loop's own fact and stays "running" | "stopped". What
 * the UI may claim from it is narrower: a loop only starts for an enabled
 * channel, so "stopped" on a channel that was never enabled is not breakage —
 * it is a channel that has not been asked to run yet (`idle`). Only an enabled
 * channel whose loop is dead is a real warning. Nothing here invents "running".
 */
export type MessagingGatewayDisplay = "running" | "stopped" | "idle";

export function gatewayPresentation(state: MessagingChannelState): MessagingGatewayDisplay {
  if (state.gateway === "running") return "running";
  return state.enabled === "on" ? "stopped" : "idle";
}

/**
 * The one sentence a platform card shows.
 *
 * The three dimensions stay three facts — `deriveChannelState` still reports
 * them separately and the detail panel still lists them as three rows. This is
 * only the order a person needs them in while scanning a list: a channel that
 * is switched off is off before it is "incomplete", and a channel that was
 * never asked to run is not broken.
 */
export type MessagingStatusTone = "success" | "warning" | "neutral" | "error";

export type MessagingStatus = {
  tone: MessagingStatusTone;
  key: string;
  /** How many fields are still missing, when the sentence counts them. */
  count?: number;
};

export const MESSAGING_STATUS_KEYS = {
  running: "settings.messaging.statusRunning",
  stopped: "settings.messaging.statusStopped",
  incomplete: "settings.messaging.statusIncomplete",
  disabled: "settings.messaging.statusDisabled",
  notConfigured: "settings.messaging.statusNotConfigured",
  unreadable: "settings.messaging.statusUnreadable",
} as const;

export function channelStatus(state: MessagingChannelState): MessagingStatus {
  if (state.enabled === "unreadable" || state.setup === "unknown") {
    return { tone: "error", key: MESSAGING_STATUS_KEYS.unreadable };
  }
  if (state.enabled === "off") {
    return { tone: "neutral", key: MESSAGING_STATUS_KEYS.disabled };
  }
  if (state.setup === "notStarted") {
    return { tone: "neutral", key: MESSAGING_STATUS_KEYS.notConfigured };
  }
  if (state.setup === "incomplete") {
    return {
      tone: "warning",
      key: MESSAGING_STATUS_KEYS.incomplete,
      count: state.missing.length,
    };
  }
  if (state.gateway === "running") {
    return { tone: "success", key: MESSAGING_STATUS_KEYS.running };
  }
  return { tone: "warning", key: MESSAGING_STATUS_KEYS.stopped };
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
  platform: SupportedMessagingPlatform,
  draft: MessagingDraft,
  existing: MessagingPlatformRecord | null | undefined,
): MessagingPlatformRecord & { card?: boolean } {
  const section = buildSectionWriteBase(platform, draft, existing);
  // Written only when on. The section is rebuilt from the draft on every save,
  // so omitting the key is what turns the switch off — and a channel that never
  // asked for a card keeps the record shape it always had.
  return { ...section, ...(draft.card ? { card: true } : {}) };
}

function buildSectionWriteBase(
  platform: SupportedMessagingPlatform,
  draft: MessagingDraft,
  existing: MessagingPlatformRecord | null | undefined,
): MessagingPlatformRecord {
  const endpoint = trimmed(draft.endpoint) || platform.defaultEndpoint;
  const destination = trimmed(draft.destination);
  const subject = trimmed(draft.subject);
  const roles = MESSAGING_ROLES.filter((role) => draft.roles.includes(role));
  const timeout = Number(trimmed(draft.requestTimeoutMs));
  if (platform.id === "apiServer") {
    // The record is the listener's own facts. `enabled` is explicit because the
    // runtime reads this section as "may bind" rather than "is configured", and
    // the token's ref is stored so a rotated ref is honoured without a code
    // change. Neither destination nor a link is written: the token is the
    // identity and the caller names its conversation.
    const port = Number(trimmed(draft.port));
    return {
      format: platform.format,
      version: platform.version,
      enabled: true,
      endpoint: "",
      destination: "",
      port: Number.isInteger(port) && port > 0 ? port : API_SERVER_DEFAULT_PORT,
      bindAddress: trimmed(draft.bindAddress) || "127.0.0.1",
      tokenSecretRef: API_SERVER_TOKEN_SECRET_REF,
      // A bound session is not this form's business — the card never edits it —
      // so an existing one rides through untouched instead of being dropped by an
      // edit to the port.
      ...(existing?.inbound ? { inbound: existing.inbound } : {}),
      ...(Number.isFinite(timeout) && timeout > 0
        ? { requestTimeoutMs: Math.floor(timeout) }
        : {}),
    };
  }
  if (platform.id === "webhooks") {
    // The receiver's record is the surface's own facts plus the one binding
    // served on it. `enabled` is explicit for the same reason the local API's
    // is: the runtime reads this section as "may listen", not "is configured".
    // The replay window, the body cap and the path segment are this build's
    // defaults — the card offers none of them — so they are written here rather
    // than left for a reader to guess.
    //
    // The saved record starts from the stored one, because the runtime keeps its
    // own state in this same section: the restart-durable delivery guard
    // (`handledEventIds`) is written by the receiver, not by this form, and a
    // save that rebuilt the record from the form alone would clear it and let a
    // replayed delivery run a second turn.
    const port = Number(trimmed(draft.port));
    const sessionId = trimmed(draft.sessionId);
    const next: Record<string, unknown> = {
      ...((existing ?? {}) as Record<string, unknown>),
      format: platform.format,
      version: platform.version,
      enabled: true,
      port:
        Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : WEBHOOK_RECEIVER_DEFAULT_PORT,
      bindAddress: trimmed(draft.bindAddress) || "127.0.0.1",
      // The panel never offers a non-loopback bind: this listener speaks plain
      // HTTP, and publishing it without a TLS-terminating proxy in front is the
      // mistake the receiver's own default exists to prevent.
      allowNonLoopback: false,
      secretRef: WEBHOOK_RECEIVER_SECRET_REF,
      replayWindowSeconds: WEBHOOK_RECEIVER_REPLAY_WINDOW_SECONDS,
      maxBodyBytes: WEBHOOK_RECEIVER_MAX_BODY_BYTES,
      path: WEBHOOK_RECEIVER_PATH,
    };
    const inbound = { ...((existing?.inbound ?? {}) as Record<string, unknown>) };
    if (sessionId !== "") inbound.sessionId = sessionId;
    else delete inbound.sessionId;
    if (Object.keys(inbound).length > 0) next.inbound = inbound;
    else delete next.inbound;
    return next as MessagingWebhookReceiverSettings;
  }
  if (platform.id === "email") {
    const imapPort = Number(trimmed(draft.imapPort));
    const smtpPort = Number(trimmed(draft.smtpPort));
    const allowedSenders = allowlistFromDraft(draft);
    return {
      format: platform.format,
      version: platform.version,
      // Email has neither a single API base nor a single destination. The record
      // type keeps both fields because every other channel has them; here they
      // are empty and the panel never shows them.
      endpoint: "",
      destination: "",
      imapHost: trimmed(draft.imapHost),
      ...(Number.isInteger(imapPort) && imapPort > 0 ? { imapPort } : {}),
      smtpHost: trimmed(draft.smtpHost),
      ...(Number.isInteger(smtpPort) && smtpPort > 0 ? { smtpPort } : {}),
      smtpSecurity: draft.smtpSecurity === "starttls" ? "starttls" : "tls",
      username: trimmed(draft.username),
      allowedSenders,
      ...(trimmed(draft.subjectPrefix) !== ""
        ? { subjectPrefix: trimmed(draft.subjectPrefix) }
        : {}),
      inbound: {
        ...(existing?.inbound ?? {}),
        ...(subject !== "" && roles.length > 0
          ? { linkedPrincipal: { subject, roles } }
          : {}),
        permissionMode: draft.permissionMode,
      },
    };
  }
  if (platform.id === "signal") {
    // Signal has no destination either: a reply goes to whoever wrote. The
    // record carries the bridge address, the account and the senders it may
    // obey, and nothing the form does not own is dropped — the inbound
    // high-water mark and the session binding survive an edit.
    return {
      format: platform.format,
      version: platform.version,
      endpoint: endpoint || platform.defaultEndpoint,
      destination: "",
      account: trimmed(draft.account),
      allowedSenders: allowlistFromDraft(draft),
      inbound: {
        ...(existing?.inbound ?? {}),
        ...(subject !== "" && roles.length > 0
          ? { linkedPrincipal: { subject, roles } }
          : {}),
        permissionMode: draft.permissionMode,
      },
    };
  }
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
    ...(trimmed(draft.nick) !== "" ? { nick: trimmed(draft.nick) } : {}),
    ...(trimmed(draft.channels) !== "" ? { channels: trimmed(draft.channels) } : {}),
    destination,
    ...(Number.isFinite(timeout) && timeout > 0
      ? { requestTimeoutMs: Math.floor(timeout) }
      : {}),
    inbound,
  };
}

/**
 * The credential writes a save makes: one per non-empty field, under the slot's
 * ref. An empty field means "leave the stored credential alone", so a user
 * editing the endpoint is never asked to retype a token — and never has one
 * cleared by accident.
 */
export function planSecretWrites(
  platform: SupportedMessagingPlatform,
  draft: MessagingDraft,
): Array<{ ref: string; value: string }> {
  return platform.secrets
    .map((slot) => ({ ref: slot.ref, value: trimmed(draft.secrets[slot.id]) }))
    .filter((entry) => entry.value !== "");
}

export type MessagingSavePorts = {
  /**
   * Write the channel's own settings section through the host's settings row.
   * `null` clears it, which is how the panel's enable toggle turns a channel
   * off: the host then reads no section, registers nothing and polls nothing.
   * Credentials are left in the secret store, so re-enabling needs no retyping.
   */
  writeSection(
    section: MessagingSectionKey,
    value: MessagingPlatformRecord | null,
  ): Promise<void>;
  /** Write one credential to the host's secret store, under its ref. */
  setSecret(ref: string, value: string): Promise<void>;
};

export type MessagingSaveResult = {
  /** How many credentials were written. Zero when the token fields were blank. */
  secretsWritten: number;
  /** Whether the section was cleared instead of written. */
  cleared: boolean;
};

/**
 * Save a platform: credentials first, then the record.
 *
 * The order is the failure direction. If a secret write fails, the record is
 * untouched and the channel keeps its previous configuration. If the record
 * write fails after the secrets landed, the stored credentials are simply newer
 * than the record that names them; nothing is left pointing at a credential
 * that was never written.
 *
 * With `enabled: false` the section is cleared and no credential is written: a
 * channel the user turned off holds no configuration to drift, and its tokens
 * stay in the secret store untouched for the next time it is turned on.
 */
export async function saveMessagingPlatform(
  platform: SupportedMessagingPlatform,
  draft: MessagingDraft,
  existing: MessagingPlatformRecord | null | undefined,
  ports: MessagingSavePorts,
  options: { enabled?: boolean } = {},
): Promise<MessagingSaveResult> {
  const enabled = options.enabled !== false;
  if (!enabled) {
    await ports.writeSection(platform.section, null);
    return { secretsWritten: 0, cleared: true };
  }
  const secrets = planSecretWrites(platform, draft);
  for (const secret of secrets) {
    await ports.setSecret(secret.ref, secret.value);
  }
  await ports.writeSection(platform.section, buildSectionWrite(platform, draft, existing));
  return { secretsWritten: secrets.length, cleared: false };
}

/**
 * The credential check the Telegram quick-setup panel performs. The token is
 * handed to the desktop main process, which calls Telegram's `getMe` and
 * `getUpdates` and returns only identity and chat ids — never the token, and
 * never a response body.
 */
export type TelegramProbeFailure =
  | "malformed"
  | "unauthorized"
  | "network"
  | "refused";

export type TelegramBotIdentity = {
  id: number;
  username: string;
  name: string;
};

export type TelegramChatCandidate = {
  /** The numeric chat id, as the record's `destination` wants it. */
  id: string;
  title: string;
};

export type TelegramProbeResult =
  | { ok: true; bot: TelegramBotIdentity }
  | { ok: false; reason: TelegramProbeFailure };

export type TelegramChatsResult =
  | { ok: true; chats: TelegramChatCandidate[] }
  | { ok: false; reason: TelegramProbeFailure };
