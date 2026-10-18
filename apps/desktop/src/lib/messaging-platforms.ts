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
 *
 * # The catalogue is honest about breadth
 *
 * The list carries all thirty-three platforms the reference product lists, in
 * the product's own order, because a user comparing the two should be able to
 * find a platform where they expect it. Only the six with a send path and a
 * receive path in this build (Telegram, Slack, Discord, Mattermost, Matrix and
 * IRC) are `supported`; the other twenty-seven each carry a `requirementClass`
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
  | "messagingIrc";

/** One credential a channel reads, and where the host keeps it. */
export type MessagingSecretSlot = {
  id: "app-token" | "bot-token" | "access-token" | "server-password";
  /** The `secret:` ref the runtime reads, never a value. */
  ref: string;
  labelKey: string;
  hintKey: string;
  /** An example shaped like the real value, never a real one. */
  placeholderKey: string;
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
  | "requestTimeoutMs";

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
 * Mattermost's fields. Its base URL is required, not recommended: the product
 * is self-hosted, so there is no public address to fall back to. The rest of the
 * panel is the shared shape.
 */
function mattermostFields(): MessagingField[] {
  const shared = channelFields({
    secrets: mattermostSecrets,
    destinationLabelKey: "settings.messaging.mattermostChannel",
    destinationHelpKey: "settings.messaging.mattermostChannelHelp",
    destinationPlaceholderKey: "settings.messaging.mattermostChannelPlaceholder",
    subjectPlaceholderKey: "settings.messaging.subjectPlaceholderMattermost",
    endpointPlaceholderKey: "settings.messaging.endpointPlaceholderMattermost",
  });
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
 * Matrix's fields. Its homeserver URL is required for the same reason
 * Mattermost's is: the product is self-hosted or federated, so there is no
 * public address to fall back to. The rest of the panel is the shared shape.
 */
function matrixFields(): MessagingField[] {
  const shared = channelFields({
    secrets: matrixSecrets,
    destinationLabelKey: "settings.messaging.matrixRoom",
    destinationHelpKey: "settings.messaging.matrixRoomHelp",
    destinationPlaceholderKey: "settings.messaging.matrixRoomPlaceholder",
    subjectPlaceholderKey: "settings.messaging.subjectPlaceholderMatrix",
    endpointPlaceholderKey: "settings.messaging.endpointPlaceholderMatrix",
  });
  const endpoint = shared.find((field) => field.id === "endpoint");
  if (!endpoint) return shared;
  const rest = shared.filter((field) => field.id !== "endpoint");
  return [
    ...rest.filter((field) => field.group === "required"),
    { ...endpoint, group: "required" as const },
    ...rest.filter((field) => field.group === "recommended"),
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
 * The list is the catalogue, not a promise: the six entries with `support:
 * "supported"` are the channels whose send and receive paths exist in this
 * build. Each of the other twenty-seven carries the sentence that says what it
 * would take, and the class that sentence belongs to, so a user comparing this
 * page with the product can see both what exists and what the gap is.
 */
/**
 * Every platform the product lists, in the product's own order.
 *
 * The list is the catalogue, not a promise: the six entries with `support:
 * "supported"` are the channels whose send and receive paths exist in this
 * build. Each of the other twenty-seven carries the sentence that says what it
 * would take, and the class that sentence belongs to, so a user comparing this
 * page with the product can see both what exists and what the gap is.
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
    support: "unsupported",
    labelKey: "settings.messaging.platformSignal",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "bridgeOrPoll",
    requirementKey: "settings.messaging.needsBridge",
    guideUrl: "https://github.com/AsamK/signal-cli",
    credentialStepKeys: [],
    secrets: [],
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
    support: "unsupported",
    labelKey: "settings.messaging.platformHomeAssistant",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "longConnection",
    requirementKey: "settings.messaging.needsSocket",
    guideUrl: "https://developers.home-assistant.io/docs/api/websocket/",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "email",
    support: "unsupported",
    labelKey: "settings.messaging.platformEmail",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "bridgeOrPoll",
    requirementKey: "settings.messaging.needsPolling",
    guideUrl: "https://datatracker.ietf.org/doc/html/rfc9051",
    credentialStepKeys: [],
    secrets: [],
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
    support: "unsupported",
    labelKey: "settings.messaging.platformApiServer",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "transport",
    requirementKey: "settings.messaging.needsTransport",
    guideUrl: "https://www.rfc-editor.org/rfc/rfc9110",
    credentialStepKeys: [],
    secrets: [],
  },
  {
    id: "webhooks",
    support: "unsupported",
    labelKey: "settings.messaging.platformWebhooks",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "publicCallback",
    requirementKey: "settings.messaging.needsWebhook",
    guideUrl: "https://www.standardwebhooks.com/",
    credentialStepKeys: [],
    secrets: [],
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
    support: "unsupported",
    labelKey: "settings.messaging.platformNtfy",
    blurbKey: "settings.messaging.blurbUnsupported",
    requirementClass: "longConnection",
    requirementKey: "settings.messaging.needsSocket",
    guideUrl: "https://docs.ntfy.sh/subscribe/phone/",
    credentialStepKeys: [],
    secrets: [],
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
  | "irc";

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
};

/** The snapshot to use before the first reply arrives: nothing is known to run. */
export const MESSAGING_GATEWAY_OFF: MessagingGatewaySnapshot = {
  booted: false,
  telegram: false,
  slack: false,
  discord: false,
  mattermost: false,
  matrix: false,
  irc: false,
};

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
  record: MessagingChannelSettings | null | undefined,
): MessagingDraft {
  const linked = record?.inbound?.linkedPrincipal;
  const roles = MESSAGING_ROLES.filter((role) => linked?.roles?.includes(role));
  return {
    endpoint: trimmed(record?.endpoint) || platform.defaultEndpoint,
    nick: trimmed(record?.nick),
    channels: trimmed(record?.channels),
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
  platform: SupportedMessagingPlatform,
  record: MessagingChannelSettings | null | undefined,
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
  if (trimmed(draft.destination) === "") missing.push("destination");
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
  record: MessagingChannelSettings,
  secretPresent: Record<string, boolean>,
): string[] {
  const missing: string[] = [];
  if (trimmed(record.endpoint) === "" && trimmed(platform.defaultEndpoint) === "") {
    missing.push("endpoint");
  }
  if (trimmed(record.destination) === "") missing.push("destination");
  if (platform.fields.some((field) => field.id === "nick") && trimmed(record.nick) === "") {
    missing.push("nick");
  }
  const linked = record.inbound?.linkedPrincipal;
  if (!linked || trimmed(linked.subject) === "" || (linked.roles?.length ?? 0) === 0) {
    missing.push("link");
  }
  for (const slot of platform.secrets) {
    if (secretPresent[slot.ref] !== true) missing.push(slot.id);
  }
  return missing;
}

/** The three state dimensions, each from its own evidence. */
export function deriveChannelState(
  platform: SupportedMessagingPlatform,
  record: MessagingChannelSettings | null | undefined,
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
  const channel: MessagingGatewayChannel =
    platform.id === "slack"
      ? "slack"
      : platform.id === "discord"
        ? "discord"
        : platform.id === "mattermost"
          ? "mattermost"
          : platform.id === "irc"
            ? "irc"
            : "telegram";
  const gatewayState: MessagingGatewayState =
    gateway.booted && gateway[channel] ? "running" : "stopped";
  return { enabled, setup, gateway: gatewayState, missing };
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
  existing: MessagingChannelSettings | null | undefined,
): MessagingChannelSettings {
  const endpoint = trimmed(draft.endpoint) || platform.defaultEndpoint;
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
    value: MessagingChannelSettings | null,
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
  existing: MessagingChannelSettings | null | undefined,
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
