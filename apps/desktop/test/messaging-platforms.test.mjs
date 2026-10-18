/**
 * Settings ▸ Messaging platforms — the chooser/panel redesign.
 *
 * What these tests hold:
 *
 * - the catalogue carries the reference product's breadth and marks honestly
 *   which platforms this build supports;
 * - the three state dimensions are derived from three different pieces of
 *   evidence and never collapse into one another;
 * - required and recommended fields are grouped, and every field explains what
 *   it is and what happens if it is blank;
 * - an unsupported platform renders a statement, not a form;
 * - a credential is written to the secret store under its `secret:` ref and
 *   never into the settings row;
 * - the gateway answer comes from the loops the main process actually started,
 *   and the Telegram quick setup probes a constant host and never echoes the
 *   token.
 *
 * The pure modules and the two main-process modules are imported and exercised;
 * the wiring assertions read the source they constrain, anchored on the
 * narrowest structural invariant rather than a byte offset.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";
import {
  MESSAGING_GATEWAY_OFF,
  MESSAGING_MAX_TIMEOUT_MS,
  MESSAGING_MIN_TIMEOUT_MS,
  MESSAGING_PERMISSION_MODES,
  MESSAGING_PLATFORMS,
  MESSAGING_REQUIREMENT_CLASS_KEYS,
  MESSAGING_ROLES,
  SUPPORTED_MESSAGING_PLATFORMS,
  UNSUPPORTED_MESSAGING_PLATFORMS,
  buildSectionWrite,
  canSave,
  deriveChannelState,
  draftFrom,
  draftMissing,
  fieldsInGroup,
  gatewayPresentation,
  isOwnRecord,
  isTimeoutValid,
  planSecretWrites,
  saveMessagingPlatform,
} from "../src/lib/messaging-platforms.ts";
import { MessagingGatewayRegistry } from "../electron/main/messaging-gateway.ts";
import {
  discoverTelegramChats,
  isTelegramTokenShaped,
  probeTelegramBot,
} from "../electron/main/messaging-telegram-probe.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const settingsPage = read("../src/features/settings/SettingsPage.tsx");
const api = read("../src/lib/api.ts");
const protocol = read("../../../packages/shared/src/protocol.ts");
const settingsIpc = read("../electron/main/ipc/settings-ipc.ts");
const startup = read("../electron/main/bootstrap/startup.ts");
const settingsSearch = read("../src/lib/settings-search.ts");
const page = read("../src/components/settings/MessagingPlatformsPage.tsx");
const probeModule = read("../electron/main/messaging-telegram-probe.ts");
const telegramCrate = read("../../../crates/host-core/src/messaging_telegram.rs");
const slackCrate = read("../../../crates/host-core/src/messaging_slack.rs");
const agentHostInbound = read("../../../packages/agent-host/src/messaging-inbound.ts");
const agentHostSlack = read("../../../packages/agent-host/src/messaging-slack-inbound.ts");
const agentHostDiscord = read("../../../packages/agent-host/src/messaging-discord-inbound.ts");
const agentHostMattermost = read("../../../packages/agent-host/src/messaging-mattermost-inbound.ts");
const hostRuntimeWiring = read("../../../packages/host-runtime/src/messaging-inbound-wiring.ts");

const identity = (key) => key;

const telegram = SUPPORTED_MESSAGING_PLATFORMS.find((entry) => entry.id === "telegram");
const slack = SUPPORTED_MESSAGING_PLATFORMS.find((entry) => entry.id === "slack");
const discord = SUPPORTED_MESSAGING_PLATFORMS.find((entry) => entry.id === "discord");
const mattermost = SUPPORTED_MESSAGING_PLATFORMS.find((entry) => entry.id === "mattermost");
const irc = SUPPORTED_MESSAGING_PLATFORMS.find((entry) => entry.id === "irc");

const TELEGRAM_RECORD = {
  format: "pi-desktop-messaging-telegram",
  version: 1,
  endpoint: "https://api.telegram.org",
  destination: "-1001234567890",
  inbound: { linkedPrincipal: { subject: "telegram:ops", roles: ["controller"] } },
};
const TELEGRAM_SECRET = { "secret:messaging-telegram:bot-token": true };
const GATEWAY_UP = {
  booted: true,
  telegram: true,
  slack: true,
  discord: true,
  mattermost: true,
  matrix: true,
  irc: true,
  homeAssistant: true,
  ntfy: true,
};
const GATEWAY_DOWN = {
  booted: true,
  telegram: false,
  slack: false,
  discord: false,
  mattermost: false,
  matrix: false,
  irc: false,
  homeAssistant: false,
  ntfy: false,
};

/**
 * The product's own catalogue, in the product's order. This is the spec: the
 * page mirrors the product, so the list is asserted verbatim rather than
 * measured against a number someone tuned.
 */
const CATALOGUE_IDS = [
  "telegram",
  "discord",
  "slack",
  "mattermost",
  "matrix",
  "whatsapp",
  "signal",
  "blueBubbles",
  "homeAssistant",
  "email",
  "sms",
  "dingtalk",
  "feishu",
  "googleChat",
  "wecomGroup",
  "wecomApp",
  "weixin",
  "qqBot",
  "yuanbao",
  "apiServer",
  "webhooks",
  "a2a",
  "buzz",
  "imessagePhone",
  "irc",
  "line",
  "microsoftGraph",
  "teams",
  "ntfy",
  "raft",
  "relay",
  "simplex",
  "whatsappCloud",
];

/** The channels whose send and receive paths exist in this build. */
const SUPPORTED_IDS = [
  "telegram",
  "discord",
  "slack",
  "mattermost",
  "matrix",
  "homeAssistant",
  "email",
  "irc",
  "ntfy",
];

/** The whole catalogue, in rail order: thirty-three, eight of them supported. */
test("the catalogue is the product's full list and marks support honestly", () => {
  assert.deepEqual(
    MESSAGING_PLATFORMS.map((entry) => entry.id),
    CATALOGUE_IDS,
    "the catalogue is not the product's list in the product's order",
  );
  assert.deepEqual(SUPPORTED_MESSAGING_PLATFORMS.map((entry) => entry.id), SUPPORTED_IDS);

  // The split is derived from the entries, not from a tuned constant: every id
  // in the catalogue is either one of the seven supported or one honest absence.
  assert.deepEqual(
    UNSUPPORTED_MESSAGING_PLATFORMS.map((entry) => entry.id),
    CATALOGUE_IDS.filter((id) => !SUPPORTED_IDS.includes(id)),
  );
  assert.equal(
    UNSUPPORTED_MESSAGING_PLATFORMS.length,
    MESSAGING_PLATFORMS.length - SUPPORTED_MESSAGING_PLATFORMS.length,
  );
  // Ids are unique: two rows must never share a platform.
  assert.equal(new Set(MESSAGING_PLATFORMS.map((entry) => entry.id)).size, MESSAGING_PLATFORMS.length);

  for (const platform of MESSAGING_PLATFORMS) {
    assert.ok(platform.labelKey.startsWith("settings.messaging.platform"), platform.id);
    assert.match(platform.blurbKey, /^settings\.messaging\./, platform.id);
    if (platform.guideUrl !== undefined) {
      assert.match(platform.guideUrl, /^https:\/\//, `${platform.id} has a non-https guide`);
    }
  }

  for (const platform of SUPPORTED_MESSAGING_PLATFORMS) {
    assert.ok(platform.secrets.length > 0, `${platform.id} names no credential`);
    assert.equal(platform.credentialStepKeys.length >= 4, true, `${platform.id} has no walkthrough`);
    for (const key of platform.credentialStepKeys) {
      assert.match(key, /^settings\.messaging\.step/, key);
    }
    for (const slot of platform.secrets) {
      // A channel name may be hyphenated (home-assistant), so the middle
      // segment allows hyphens as the runtime refs always have.
      assert.match(slot.ref, /^secret:messaging-[a-z-]+:[a-z-]+$/, slot.ref);
      assert.match(slot.placeholderKey, /^settings\.messaging\./, slot.ref);
    }
  }

  // The unsupported rows carry a capability and a class, and nothing a form
  // could write.
  for (const platform of UNSUPPORTED_MESSAGING_PLATFORMS) {
    assert.ok(
      platform.requirementKey.startsWith("settings.messaging.needs"),
      `${platform.id} has no requirement sentence`,
    );
    assert.ok(
      MESSAGING_REQUIREMENT_CLASS_KEYS[platform.requirementClass],
      `${platform.id} has no requirement class`,
    );
    assert.deepEqual(platform.secrets, [], `${platform.id} claims a credential`);
    assert.deepEqual(platform.credentialStepKeys, [], `${platform.id} claims a walkthrough`);
  }
});

/** What an unsupported platform lacks is placed in a real class, not just named. */
test("every unsupported platform is grouped by the kind of work it needs", () => {
  const byClass = {};
  for (const platform of MESSAGING_PLATFORMS) {
    if (platform.support === "supported") continue;
    byClass[platform.requirementClass] = [
      ...(byClass[platform.requirementClass] ?? []),
      platform.id,
    ];
  }

  // The split follows reachability: an outgoing long connection works from a
  // home network, a callback does not, a bridge owns the account on a phone,
  // a transport has no conversation at all, and approval happens off-machine.
  assert.deepEqual(byClass.longConnection, [
    "buzz",
    "raft",
    "simplex",
  ]);
  assert.deepEqual(byClass.publicCallback, [
    "sms",
    "dingtalk",
    "feishu",
    "googleChat",
    "wecomGroup",
    "wecomApp",
    "webhooks",
    "line",
    "microsoftGraph",
    "teams",
  ]);
  assert.deepEqual(byClass.bridgeOrPoll, [
    "whatsapp",
    "signal",
    "blueBubbles",
    "imessagePhone",
  ]);
  assert.deepEqual(byClass.transport, ["apiServer", "a2a", "relay"]);
  assert.deepEqual(byClass.platformApproval, [
    "weixin",
    "qqBot",
    "yuanbao",
    "whatsappCloud",
  ]);

  // No class is decorative and no class is invented.
  assert.deepEqual(
    Object.keys(byClass).sort(),
    Object.keys(MESSAGING_REQUIREMENT_CLASS_KEYS).sort(),
  );
});

/** An unsupported platform must never expose something a form could save. */
test("no unsupported platform exposes a credential or a field", () => {
  for (const platform of UNSUPPORTED_MESSAGING_PLATFORMS) {
    // There is no form to build: no fields, no credential slots, no section,
    // no record format and no endpoint to fall back to.
    assert.equal("fields" in platform, false, `${platform.id} exposes fields`);
    assert.deepEqual(platform.secrets, [], `${platform.id} exposes a credential slot`);
    assert.equal("section" in platform, false, `${platform.id} names a settings section`);
    assert.equal("format" in platform, false, `${platform.id} names a record format`);
    assert.equal("defaultEndpoint" in platform, false, `${platform.id} names an endpoint`);
  }

  // The negative side of the same invariant: every supported channel does carry
  // the credential field its slot names, so the assertion above is not passing
  // because fields vanished everywhere.
  for (const platform of SUPPORTED_MESSAGING_PLATFORMS) {
    const credentialFields = platform.fields.filter((field) =>
      platform.secrets.some((slot) => slot.id === field.id),
    );
    assert.deepEqual(
      credentialFields.map((field) => field.id),
      platform.secrets.map((slot) => slot.id),
      `${platform.id} lost a credential field`,
    );
  }
});

/**
 * A loop only starts for an enabled channel, so "not running" is only a warning
 * when the channel was actually asked to run.
 */
test("the gateway is a warning only for an enabled channel whose loop is dead", () => {
  const storedOn = deriveChannelState(telegram, TELEGRAM_RECORD, TELEGRAM_SECRET, GATEWAY_DOWN);
  const neverEnabled = deriveChannelState(telegram, undefined, {}, GATEWAY_DOWN);
  const running = deriveChannelState(telegram, TELEGRAM_RECORD, TELEGRAM_SECRET, GATEWAY_UP);

  // The fact is untouched: no loop is running in either stopped case.
  assert.equal(storedOn.gateway, "stopped");
  assert.equal(neverEnabled.gateway, "stopped");
  // What the page may claim differs: a channel that was never enabled is idle.
  assert.equal(gatewayPresentation(storedOn), "stopped");
  assert.equal(gatewayPresentation(neverEnabled), "idle");
  assert.equal(gatewayPresentation(running), "running");
  // An unreadable record is not "enabled", so it is not a false alarm either.
  const unreadable = deriveChannelState(
    telegram,
    { ...TELEGRAM_RECORD, format: "pi-desktop-messaging-slack" },
    TELEGRAM_SECRET,
    GATEWAY_DOWN,
  );
  assert.equal(unreadable.enabled, "unreadable");
  assert.equal(gatewayPresentation(unreadable), "idle");
});

/** The three dimensions, each from its own evidence. */
test("enabled, setup and gateway are computed independently", () => {
  // 1. Enabled only: the record is complete, the loop is not running.
  const enabledOnly = deriveChannelState(telegram, TELEGRAM_RECORD, TELEGRAM_SECRET, GATEWAY_DOWN);
  assert.deepEqual(enabledOnly, {
    enabled: "on",
    setup: "complete",
    gateway: "stopped",
    missing: [],
  });

  // 2. Needs setup, while the gateway is up: a missing field is not a stopped loop.
  const needsSetup = deriveChannelState(
    telegram,
    { ...TELEGRAM_RECORD, destination: "  " },
    TELEGRAM_SECRET,
    GATEWAY_UP,
  );
  assert.deepEqual(needsSetup, {
    enabled: "on",
    setup: "incomplete",
    gateway: "running",
    missing: ["destination"],
  });

  // 3. Gateway down on its own: nothing about the record changed.
  const gatewayDown = deriveChannelState(telegram, TELEGRAM_RECORD, TELEGRAM_SECRET, {
    booted: true,
    telegram: false,
    slack: true,
    discord: true,
    mattermost: true,
  });
  assert.deepEqual(gatewayDown, {
    enabled: "on",
    setup: "complete",
    gateway: "stopped",
    missing: [],
  });

  // Never configured: off and not started, and still not "needs setup".
  assert.deepEqual(deriveChannelState(telegram, undefined, {}, MESSAGING_GATEWAY_OFF), {
    enabled: "off",
    setup: "notStarted",
    gateway: "stopped",
    missing: [],
  });

  // A record this build cannot read is unreadable, not off and not incomplete.
  assert.deepEqual(
    deriveChannelState(telegram, { ...TELEGRAM_RECORD, version: 2 }, TELEGRAM_SECRET, GATEWAY_UP),
    { enabled: "unreadable", setup: "unknown", gateway: "running", missing: [] },
  );

  // A missing credential is a setup gap, and names the slot.
  assert.deepEqual(deriveChannelState(telegram, TELEGRAM_RECORD, {}, GATEWAY_UP), {
    enabled: "on",
    setup: "incomplete",
    gateway: "running",
    missing: ["bot-token"],
  });

  // The gateway is per channel: Slack's loop is not Telegram's.
  const slackRecord = {
    format: "pi-desktop-messaging-slack",
    version: 1,
    endpoint: "https://slack.com",
    destination: "C0123456789",
    inbound: { linkedPrincipal: { subject: "slack:ops", roles: ["controller"] } },
  };
  assert.equal(
    deriveChannelState(
      slack,
      slackRecord,
      {
        "secret:messaging-slack:app-token": true,
        "secret:messaging-slack:bot-token": true,
      },
      {
        booted: true,
        telegram: true,
        slack: false,
        discord: false,
        mattermost: false,
        matrix: false,
        homeAssistant: false,
      },
    ).gateway,
    "stopped",
  );
});

/**
 * The grid that catches a channel borrowing a sibling's gateway.
 *
 * The platform list comes from the catalogue, not from a hand-written array, so
 * a channel added later is covered the moment it is marked `supported`. The
 * snapshot is built by spreading `MESSAGING_GATEWAY_OFF` and flipping ONE key,
 * so a platform whose id is not a snapshot key cannot pass by accident: the
 * extra property is never read, the card stays stopped, and the expectation
 * below fails loudly.
 */
test("a channel reports its own gateway, never a sibling's", () => {
  const platforms = SUPPORTED_MESSAGING_PLATFORMS;
  assert.ok(platforms.length >= 8, "the supported catalogue lost a channel");

  // The per-channel keys the snapshot itself declares. `booted` is the host's
  // own liveness, not a channel.
  const channelKeys = Object.keys(MESSAGING_GATEWAY_OFF).filter((key) => key !== "booted");

  for (const platform of platforms) {
    assert.ok(
      channelKeys.includes(platform.id),
      `${platform.id} has no gateway key of its own in the snapshot`,
    );

    // Booted but idle: nothing may read as running.
    assert.equal(
      deriveChannelState(platform, undefined, {}, GATEWAY_DOWN).gateway,
      "stopped",
      `${platform.id} claims a running loop with every loop stopped`,
    );

    // One running loop at a time. Only the platform that owns it may report it.
    for (const running of platforms) {
      const snapshot = { ...GATEWAY_DOWN, [running.id]: true };
      const expected = running.id === platform.id ? "running" : "stopped";
      assert.equal(
        deriveChannelState(platform, undefined, {}, snapshot).gateway,
        expected,
        `${platform.id} reported "${
          deriveChannelState(platform, undefined, {}, snapshot).gateway
        }" while only ${running.id}'s loop was running`,
      );
    }
  }
});

/** Required vs recommended, and the consequence of a blank. */
test("fields are grouped, and every field explains itself and its blank", () => {
  for (const platform of SUPPORTED_MESSAGING_PLATFORMS) {
    const required = fieldsInGroup(platform, "required");
    const recommended = fieldsInGroup(platform, "recommended");

    // The credentials, the conversation and the link are always required; the
    // endpoint is required only where the platform has no public default
    // (Mattermost and Matrix are self-hosted; Home Assistant runs on the user's
    // own network), and recommended everywhere else.
    const selfHosted =
      platform.id === "mattermost" ||
      platform.id === "matrix" ||
      platform.id === "homeAssistant";
    const requiredIds = required.map((field) => field.id);
    const requiredWithoutSecrets = requiredIds.filter(
      (id) => !platform.secrets.some((slot) => slot.id === id),
    );
    // IRC is the one channel whose address and nick are both required and whose
    // server password is optional: a network of independent servers has no
    // public default, and a nick is the identity it registers.
    if (platform.id === "irc") {
      assert.deepEqual(requiredWithoutSecrets, [
        "endpoint",
        "nick",
        "destination",
        "subject",
        "roles",
      ]);
      assert.deepEqual(
        recommended.map((field) => field.id),
        ["channels", "permissionMode", "requestTimeoutMs", "server-password"],
      );
      // The optional server password is a secret slot but never a required one.
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        [],
      );
    } else if (platform.id === "email") {
      // Email has no single conversation: the correspondent is whoever wrote,
      // and the record's destination is the sender allowlist rather than one
      // chat id. So the required set is the two servers, the account, the
      // allowlist and the password — no `destination`, no `endpoint` field.
      assert.deepEqual(requiredWithoutSecrets, [
        "imapHost",
        "imapPort",
        "smtpHost",
        "smtpPort",
        "smtpSecurity",
        "username",
        "allowedSenders",
        "subject",
        "roles",
      ]);
      assert.deepEqual(
        recommended.map((field) => field.id),
        ["subjectPrefix", "permissionMode"],
      );
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        ["password"],
        "email's credential is required, unlike ntfy's optional token",
      );
      assert.deepEqual(platform.secrets.map((slot) => slot.id), ["password"]);
    } else if (platform.id === "ntfy") {
      // ntfy has a public default server and an optional credential: a topic on
      // an open server needs no token, so only the topic and the link are
      // required. The token sits with the recommended fields but still has a
      // secret slot of its own.
      assert.deepEqual(requiredWithoutSecrets, ["destination", "subject", "roles"]);
      assert.deepEqual(
        recommended.map((field) => field.id),
        ["access-token", "permissionMode", "endpoint", "requestTimeoutMs"],
      );
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        [],
      );
      assert.deepEqual(
        platform.secrets.map((slot) => slot.id),
        ["access-token"],
        "ntfy's optional credential still has a slot",
      );
    } else {
      assert.deepEqual(
        requiredWithoutSecrets,
        selfHosted
          ? ["destination", "subject", "roles", "endpoint"]
          : ["destination", "subject", "roles"],
        `${platform.id} required group`,
      );
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        platform.secrets.map((slot) => slot.id),
        `${platform.id} credential group`,
      );
      assert.deepEqual(
        recommended.map((field) => field.id),
        selfHosted
          ? ["permissionMode", "requestTimeoutMs"]
          : ["permissionMode", "endpoint", "requestTimeoutMs"],
        `${platform.id} recommended group`,
      );
    }

    for (const field of platform.fields) {
      assert.match(field.labelKey, /^settings\.messaging\./, field.id);
      assert.match(field.helpKey, /^settings\.messaging\./, field.id);
      // Every field states a consequence, required ones included.
      assert.match(field.consequenceKey, /^settings\.messaging\.consequence/, field.id);
    }

    // Recommended fields carry distinct consequences: none is decorative.
    const consequences = recommended.map((field) => field.consequenceKey);
    assert.equal(new Set(consequences).size, consequences.length, `${platform.id} repeats a consequence`);

    // Text fields carry a realistic placeholder.
    for (const id of ["destination", "subject", "endpoint", "requestTimeoutMs"]) {
      // Email has no single conversation, no API base and no timeout field:
      // its examples live on the two hosts and the account address instead.
      if (
        platform.id === "email" &&
        (id === "destination" || id === "endpoint" || id === "requestTimeoutMs")
      ) {
        continue;
      }
      const field = platform.fields.find((entry) => entry.id === id);
      assert.ok(field?.placeholderKey, `${platform.id}.${id} has no example`);
    }
  }
});

/** The record shape is the host's, not an invention of the form. */
test("the written record has exactly the host's stored fields", () => {
  const storedFields = (source) => {
    const body = source.match(/struct StoredConfig \{([\s\S]*?)\n\}/)?.[1] ?? "";
    return [...body.matchAll(/^\s+(?:request_timeout_ms|format|version|endpoint|destination):/gm)]
      .map((match) => match[0].trim().replace(":", ""))
      .map((name) => name.replace(/_([a-z])/g, (_all, letter) => letter.toUpperCase()))
      .sort();
  };
  const expected = storedFields(telegramCrate);
  assert.deepEqual(expected, [
    "destination",
    "endpoint",
    "format",
    "requestTimeoutMs",
    "version",
  ]);
  assert.deepEqual(storedFields(slackCrate), expected);

  const draft = draftFrom(telegram, null);
  draft.destination = "42";
  draft.subject = "ops";
  const withTimeout = buildSectionWrite(telegram, { ...draft, requestTimeoutMs: "15000" }, null);
  assert.deepEqual(Object.keys(withTimeout).sort(), [
    "destination",
    "endpoint",
    "format",
    "inbound",
    "requestTimeoutMs",
    "version",
  ]);
  const withoutTimeout = buildSectionWrite(telegram, draft, null);
  assert.deepEqual(Object.keys(withoutTimeout).sort(), [
    "destination",
    "endpoint",
    "format",
    "inbound",
    "version",
  ]);
});

test("a blank endpoint falls back to the platform's own address", () => {
  const draft = { ...draftFrom(telegram, null), endpoint: "   ", destination: "42", subject: "ops" };
  assert.equal(buildSectionWrite(telegram, draft, null).endpoint, "https://api.telegram.org");
  assert.equal(
    buildSectionWrite(slack, { ...draft, destination: "C1" }, null).endpoint,
    "https://slack.com",
  );
});

test("each platform's section, format and version match the runtime's constants", () => {
  assert.match(telegramCrate, /const SETTINGS_SECTION: &str = "messagingTelegram";/);
  assert.match(telegramCrate, /const FORMAT: &str = "pi-desktop-messaging-telegram";/);
  assert.match(telegramCrate, /const FORMAT_VERSION: u32 = 1;/);
  assert.match(slackCrate, /const SETTINGS_SECTION: &str = "messagingSlack";/);
  assert.match(slackCrate, /const FORMAT: &str = "pi-desktop-messaging-slack";/);
  assert.match(slackCrate, /const FORMAT_VERSION: u32 = 1;/);
  assert.match(agentHostInbound, /export const MESSAGING_TELEGRAM_SECTION = "messagingTelegram";/);
  assert.match(
    agentHostInbound,
    /export const MESSAGING_TELEGRAM_FORMAT = "pi-desktop-messaging-telegram";/,
  );
  assert.match(agentHostSlack, /export const MESSAGING_SLACK_SECTION = "messagingSlack";/);
  assert.match(agentHostSlack, /export const MESSAGING_SLACK_FORMAT = "pi-desktop-messaging-slack";/);

  assert.equal(telegram.section, "messagingTelegram");
  assert.equal(telegram.format, "pi-desktop-messaging-telegram");
  assert.equal(telegram.version, 1);
  assert.equal(slack.section, "messagingSlack");
  assert.equal(slack.format, "pi-desktop-messaging-slack");
  assert.equal(slack.version, 1);

  // The two gateway channels name their own section and record, and the
  // renderer's values are the runtime's.
  assert.match(agentHostDiscord, /MESSAGING_DISCORD_SECTION = "messagingDiscord";/);
  assert.match(agentHostDiscord, /MESSAGING_DISCORD_FORMAT = "pi-desktop-messaging-discord";/);
  assert.match(agentHostMattermost, /MESSAGING_MATTERMOST_SECTION = "messagingMattermost";/);
  assert.match(
    agentHostMattermost,
    /MESSAGING_MATTERMOST_FORMAT = "pi-desktop-messaging-mattermost";/,
  );
  assert.equal(discord.section, "messagingDiscord");
  assert.equal(discord.format, "pi-desktop-messaging-discord");
  assert.equal(discord.version, 1);
  assert.equal(mattermost.section, "messagingMattermost");
  assert.equal(mattermost.format, "pi-desktop-messaging-mattermost");
  assert.equal(mattermost.version, 1);
});

/** The two gateway panels write a record the runtime reads, and no credential. */
test("Discord and Mattermost write their own record and their own secret ref", async () => {
  for (const platform of [discord, mattermost]) {
    const draft = {
      ...draftFrom(platform, null),
      destination: platform.id === "discord" ? "123456789012345678" : "channel-id",
      subject: `${platform.id}:ops`,
      endpoint:
        platform.id === "discord" ? "https://discord.com/api/v10" : "https://chat.example.com",
      secrets: { [platform.secrets[0].id]: `${platform.id}-secret-value` },
    };
    const written = [];
    const secrets = [];
    await saveMessagingPlatform(platform, draft, null, {
      setSecret: async (ref, value) => secrets.push({ ref, value }),
      writeSection: async (section, value) => written.push({ section, value }),
    });

    assert.equal(written[0].section, platform.section);
    assert.equal(written[0].value.format, platform.format);
    assert.equal(written[0].value.version, platform.version);
    assert.equal(JSON.stringify(written[0].value).includes("secret-value"), false);
    assert.deepEqual(
      secrets.map((entry) => entry.ref),
      [platform.secrets[0].ref],
    );

    // Turning it off clears the section and writes no credential.
    const calls = [];
    await saveMessagingPlatform(
      platform,
      draft,
      written[0].value,
      {
        setSecret: async (ref) => calls.push({ kind: "secret", ref }),
        writeSection: async (section, value) => calls.push({ kind: "section", section, value }),
      },
      { enabled: false },
    );
    assert.deepEqual(calls, [{ kind: "section", section: platform.section, value: null }]);
  }

  // Mattermost's base URL is required: a blank one is a setup gap, while
  // Discord falls back to its public API base.
  const emptyMattermost = {
    format: mattermost.format,
    version: 1,
    endpoint: "",
    destination: "channel-id",
    inbound: { linkedPrincipal: { subject: "mattermost:ops", roles: ["controller"] } },
  };
  assert.equal(
    deriveChannelState(
      mattermost,
      emptyMattermost,
      { "secret:messaging-mattermost:access-token": true },
      GATEWAY_UP,
    ).missing.includes("endpoint"),
    true,
  );
  const blankDiscord = {
    format: discord.format,
    version: 1,
    endpoint: "",
    destination: "123",
    inbound: { linkedPrincipal: { subject: "discord:ops", roles: ["controller"] } },
  };
  assert.equal(
    deriveChannelState(
      discord,
      blankDiscord,
      { "secret:messaging-discord:bot-token": true },
      GATEWAY_UP,
    ).missing.includes("endpoint"),
    false,
  );
});

test("every credential ref is the one the transport reads", () => {
  assert.match(
    hostRuntimeWiring,
    /MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF = "secret:messaging-telegram:bot-token"/,
  );
  assert.match(
    agentHostSlack,
    /MESSAGING_SLACK_APP_TOKEN_SECRET_REF = "secret:messaging-slack:app-token"/,
  );
  assert.match(slackCrate, /const BOT_TOKEN_SECRET_REF: &str = "secret:messaging-slack:bot-token";/);
  assert.match(telegramCrate, /const BOT_TOKEN_SECRET_REF: &str = "secret:messaging-telegram:bot-token";/);

  assert.deepEqual(
    telegram.secrets.map((slot) => slot.ref),
    ["secret:messaging-telegram:bot-token"],
  );
  assert.deepEqual(
    slack.secrets.map((slot) => slot.ref),
    ["secret:messaging-slack:app-token", "secret:messaging-slack:bot-token"],
  );
  assert.match(
    agentHostDiscord,
    /MESSAGING_DISCORD_BOT_TOKEN_SECRET_REF = "secret:messaging-discord:bot-token"/,
  );
  assert.match(
    agentHostMattermost,
    /MESSAGING_MATTERMOST_ACCESS_TOKEN_SECRET_REF = "secret:messaging-mattermost:access-token"/,
  );
  assert.deepEqual(
    discord.secrets.map((slot) => slot.ref),
    ["secret:messaging-discord:bot-token"],
  );
  assert.deepEqual(
    mattermost.secrets.map((slot) => slot.ref),
    ["secret:messaging-mattermost:access-token"],
  );
});

/** The secret write path: a ref, and never the value. */
test("a Telegram save writes a secret ref and never the token value", async () => {
  const token = "7000000000:AAH-THIS-IS-A-SECRET-VALUE";
  const calls = [];
  const written = [];
  const draft = {
    ...draftFrom(telegram, null),
    destination: "-1001234567890",
    subject: "telegram:ops",
    secrets: { "bot-token": token },
  };

  const result = await saveMessagingPlatform(telegram, draft, null, {
    setSecret: async (ref, value) => {
      calls.push({ kind: "secret", ref, value });
    },
    writeSection: async (section, value) => {
      calls.push({ kind: "section", section, value });
      written.push(value);
    },
  });

  assert.equal(result.secretsWritten, 1);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["secret", "section"],
    "credentials must land before the record that names them",
  );
  assert.deepEqual(
    { ref: calls[0].ref, value: calls[0].value },
    { ref: "secret:messaging-telegram:bot-token", value: token },
  );
  assert.equal(calls[1].section, "messagingTelegram");

  const section = written[0];
  assert.equal(JSON.stringify(section).includes(token), false, "the token leaked into settings");
  assert.equal(JSON.stringify(section).includes("SECRET"), false);
  for (const field of ["token", "botToken", "appToken", "secret", "credential"]) {
    assert.equal(field in section, false, `${field} must not be a settings field`);
  }
  assert.deepEqual(section.inbound.linkedPrincipal, {
    subject: "telegram:ops",
    roles: ["controller"],
  });

  // The same rule with no token typed: nothing is written to the secret store.
  const untouched = [];
  await saveMessagingPlatform(telegram, { ...draft, secrets: {} }, section, {
    setSecret: async (ref) => {
      untouched.push(ref);
    },
    writeSection: async () => undefined,
  });
  assert.deepEqual(untouched, [], "an empty token field must not rewrite the credential");
});

test("a Slack save writes both of its credential refs and one record", async () => {
  const secrets = [];
  const written = [];
  const draft = {
    ...draftFrom(slack, null),
    destination: "C0123456789",
    subject: "slack:ops",
    secrets: { "app-token": "xapp-1-secret", "bot-token": "xoxb-2-secret" },
  };
  await saveMessagingPlatform(slack, draft, null, {
    setSecret: async (ref, value) => secrets.push({ ref, value }),
    writeSection: async (section, value) => written.push({ section, value }),
  });
  assert.deepEqual(
    secrets.map((entry) => entry.ref),
    ["secret:messaging-slack:app-token", "secret:messaging-slack:bot-token"],
  );
  assert.equal(written.length, 1);
  assert.equal(written[0].section, "messagingSlack");
  assert.equal(JSON.stringify(written[0].value).includes("xapp-1-secret"), false);
  assert.equal(JSON.stringify(written[0].value).includes("xoxb-2-secret"), false);
});

/** Turning a channel off clears the section and keeps the credentials. */
test("the enable toggle off clears the section and writes no credential", async () => {
  const calls = [];
  const draft = {
    ...draftFrom(telegram, null),
    destination: "42",
    subject: "ops",
    secrets: { "bot-token": "should-not-be-written" },
  };
  const result = await saveMessagingPlatform(
    telegram,
    draft,
    TELEGRAM_RECORD,
    {
      setSecret: async (ref) => calls.push({ kind: "secret", ref }),
      writeSection: async (section, value) => calls.push({ kind: "section", section, value }),
    },
    { enabled: false },
  );
  assert.deepEqual(calls, [{ kind: "section", section: "messagingTelegram", value: null }]);
  assert.equal(result.cleared, true);
  assert.equal(result.secretsWritten, 0);
});

test("the secret plan is a ref and a typed value, nothing else", () => {
  const draft = { ...draftFrom(telegram, null), secrets: { "bot-token": "  spaced-token  " } };
  assert.deepEqual(planSecretWrites(telegram, draft), [
    { ref: "secret:messaging-telegram:bot-token", value: "spaced-token" },
  ]);
});

test("a save cannot start without the fields the link needs", () => {
  const draft = draftFrom(telegram, null);
  assert.deepEqual(draftMissing(telegram, draft), ["destination", "link"]);
  const withDestination = { ...draft, destination: "42", subject: "ops" };
  assert.deepEqual(draftMissing(telegram, withDestination), []);
  assert.deepEqual(draftMissing(telegram, { ...withDestination, roles: [] }), ["link"]);
  assert.deepEqual(MESSAGING_ROLES, ["viewer", "controller", "approver", "owner"]);
  assert.deepEqual(MESSAGING_PERMISSION_MODES, ["ask", "accept-edits", "auto"]);
});

test("the request timeout is bounded like the host bounds it", () => {
  const draft = draftFrom(telegram, null);
  assert.equal(isTimeoutValid(draft), true, "empty means the host default");
  assert.equal(isTimeoutValid({ ...draft, requestTimeoutMs: String(MESSAGING_MIN_TIMEOUT_MS) }), true);
  assert.equal(isTimeoutValid({ ...draft, requestTimeoutMs: String(MESSAGING_MAX_TIMEOUT_MS) }), true);
  assert.equal(isTimeoutValid({ ...draft, requestTimeoutMs: "249" }), false);
  assert.equal(isTimeoutValid({ ...draft, requestTimeoutMs: "60001" }), false);
  assert.equal(isTimeoutValid({ ...draft, requestTimeoutMs: "12.5" }), false);
  assert.equal(
    canSave(telegram, { ...draft, destination: "42", subject: "ops", requestTimeoutMs: "9" }),
    false,
  );
  assert.equal(canSave(telegram, { ...draft, destination: "42", subject: "ops" }), true);
  assert.equal(isOwnRecord(telegram, TELEGRAM_RECORD), true);
  assert.equal(isOwnRecord(slack, TELEGRAM_RECORD), false);
});

/** The page: a chooser plus a panel, three states, no dead form. */
test("the page renders the three state dimensions separately", () => {
  // Three labelled rows in the panel, one per dimension, each fed by the same
  // derived state object and rendered with its own value.
  const panel = page.slice(page.indexOf("function SupportedPanel"));
  for (const key of [
    "settings.messaging.stateEnabled",
    "settings.messaging.stateSetup",
    "settings.messaging.stateGateway",
  ]) {
    assert.ok(panel.includes(key), `${key} is not rendered in the panel`);
  }
  assert.equal(
    (panel.match(/<StateRow/g) ?? []).length,
    3,
    "the panel must render exactly three state rows",
  );
  assert.ok(page.includes("deriveChannelState("), "the page does not derive state");
  assert.match(api, /messagingGateway: \(\) =>\s*\n?\s*invoke<MessagingGatewaySnapshot>\(IPC\.invoke\.messagingGateway\)/);
  assert.match(page, /api\.messagingGateway\(\)/);
  // The old single badge is gone from the page.
  assert.equal(page.includes("deriveMessagingStatus"), false);
});

test("an unsupported platform opens a statement, not a form", () => {
  assert.match(page, /platform\.support === "supported" \? \(/);
  assert.match(page, /\) : \(\s*\n\s*<UnsupportedPanel platform=\{platform\} \/>/);

  const panel = page.slice(page.indexOf("function UnsupportedPanel"));
  assert.ok(panel.includes('data-panel="unsupported"'));
  for (const control of ["<form", "<Input", "<PasswordInput", "<SettingsToggle", "<CheckboxGroup", "<SegmentedControl"]) {
    assert.equal(panel.includes(control), false, `the unsupported panel rendered ${control}`);
  }
  assert.ok(panel.includes("unsupportedNeeds"), "the panel does not name what is missing");
  assert.ok(
    panel.includes("MESSAGING_REQUIREMENT_CLASS_KEYS"),
    "the panel does not place the requirement in its class",
  );
  assert.ok(panel.includes("requirementType"), "the panel does not label the requirement class");
  assert.ok(panel.includes("unsupportedNoForm"), "the panel does not say why there is no form");
});

test("the panel carries the walkthrough, the groups and the footer action", () => {
  assert.ok(page.includes("platform.credentialStepKeys.map"), "no numbered walkthrough");
  assert.ok(page.includes("settings-messaging-step-list"), "the walkthrough is not a list");
  assert.ok(page.includes("platform.guideUrl"), "no outbound guide link");
  assert.match(page, /target="_blank"\s*\n?\s*rel="noopener noreferrer"/);
  assert.ok(page.includes('fieldsInGroup(platform, "required")'));
  assert.ok(page.includes('fieldsInGroup(platform, "recommended")'));
  assert.ok(page.includes("field.helpKey"), "per-field help is not rendered");
  assert.ok(page.includes("field.consequenceKey"), "per-field consequence is not rendered");
  assert.ok(page.includes("<SettingsToggle"), "no enable toggle");
  assert.ok(page.includes("<TelegramQuickSetup"), "Telegram has no quick setup");
});

/**
 * The header shortcut is a shortcut, not a second form: it lives in the
 * component that owns the draft, and it persists through the same `onSave` the
 * footer's submit uses.
 */
test("the header's quick enable action persists through the panel's submit path", () => {
  const detail = page.slice(
    page.indexOf("function MessagingDetail"),
    page.indexOf("function SupportedPanel"),
  );
  assert.ok(detail.length > 0, "the detail component is missing");
  assert.ok(detail.includes("settings.messaging.enableNow"), "no quick enable label");
  assert.ok(detail.includes("settings.messaging.disableNow"), "no quick disable label");
  assert.match(detail, /await onSave\(draft, next\)/);
  // Enabling is gated on the draft's required fields and says why; disabling is
  // not gated, so it stays available on a channel that is already on.
  assert.ok(detail.includes("settings.messaging.quickEnableBlocked"));
  assert.match(detail, /storedOn \|\| ready/);
  // One draft and one enabled flag for both controls.
  assert.equal((page.match(/useState<MessagingDraft>/g) ?? []).length, 1);
  assert.equal((page.match(/useState\(true\)/g) ?? []).length, 1);
});

/** The gateway registry: the loop's lifetime is the signal. */
test("the gateway registry reports the loops that are actually running", async () => {
  const registry = new MessagingGatewayRegistry();
  assert.deepEqual(registry.snapshot(), {
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
  });

  registry.markBooted();
  let finishTelegram;
  const telegramDone = new Promise((resolve) => {
    finishTelegram = resolve;
  });
  registry.track("telegram", { done: telegramDone });
  registry.track("slack", null);
  assert.deepEqual(registry.snapshot(), {
    booted: true,
    telegram: true,
    slack: false,
    discord: false,
    mattermost: false,
    matrix: false,
    irc: false,
    homeAssistant: false,
    ntfy: false,
    email: false,
  });

  registry.track("slack", { done: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(registry.snapshot().slack, false, "a loop that already ended is not running");

  finishTelegram();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.snapshot(), {
    booted: true,
    telegram: false,
    slack: false,
    discord: false,
    mattermost: false,
    matrix: false,
    irc: false,
    homeAssistant: false,
    ntfy: false,
    email: false,
  });
});

/** The quick setup probe: a constant host, typed failures, no token back. */
test("the Telegram probe talks only to a constant host", async () => {
  assert.match(probeModule, /const TELEGRAM_API_BASE = "https:\/\/api\.telegram\.org";/);
  assert.ok(probeModule.includes('redirect: "error"'), "redirects are followed with the token in the path");
  // The token is a path segment, and never a query parameter.
  assert.ok(probeModule.includes("/bot${token}/${method}"));
  assert.equal(probeModule.includes("searchParams"), false);

  const seen = [];
  const ok = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      status: 200,
      ok: true,
      json: async () => ({ ok: true, result: { id: 7000000000, username: "ops_bot", first_name: "Ops" } }),
    };
  };
  const result = await probeTelegramBot("7000000000:AAH-THIS-IS-A-SECRET-VALUE", { fetch: ok });
  assert.equal(result.ok, true);
  assert.deepEqual(result.bot, { id: 7000000000, username: "ops_bot", name: "Ops" });
  assert.equal(seen[0].url.startsWith("https://api.telegram.org/bot"), true);
  assert.equal(JSON.stringify(result).includes("AAH-THIS-IS-A-SECRET-VALUE"), false);
  assert.equal(seen[0].init.redirect, "error");

  // A malformed token never travels.
  const before = seen.length;
  assert.deepEqual(await probeTelegramBot("not-a-token", { fetch: ok }), {
    ok: false,
    reason: "malformed",
  });
  assert.equal(seen.length, before, "a malformed token was sent anyway");
  assert.equal(isTelegramTokenShaped("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), true);

  // A refusal in the body is a refusal, even with status 200.
  const bodyRefusal = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }),
  });
  assert.deepEqual(await probeTelegramBot("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", {
    fetch: bodyRefusal,
  }), { ok: false, reason: "unauthorized" });

  // A transport failure is typed, and carries no URL.
  const failing = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.telegram.org/bot700:AAH");
  };
  const network = await probeTelegramBot("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", {
    fetch: failing,
  });
  assert.deepEqual(network, { ok: false, reason: "network" });
  assert.equal(JSON.stringify(network).includes("AAH"), false);
});

test("the Telegram probe finds the chat that messaged the bot", async () => {
  const updates = {
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: -1001234567890, title: "Ops room" } } },
      { update_id: 2, message: { chat: { id: 42, first_name: "Ada" } } },
      // The same chat twice: one candidate, not two.
      { update_id: 3, message: { chat: { id: 42, first_name: "Ada" } } },
      { update_id: 4, edited_message: { chat: { id: 99 } } },
    ],
  };
  const result = await discoverTelegramChats("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", {
    fetch: async () => ({ status: 200, ok: true, json: async () => updates }),
  });
  assert.deepEqual(result, {
    ok: true,
    chats: [
      { id: "-1001234567890", title: "Ops room" },
      { id: "42", title: "Ada" },
    ],
  });

  const empty = await discoverTelegramChats("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", {
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true, result: [] }) }),
  });
  assert.deepEqual(empty, { ok: true, chats: [] });
});

/** The directory and the wiring. */
test("the settings directory drops cloud sync and remote hosts", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      const ids = visibleSettingsNav(developerMode, includeDevelopmentOnly).map((entry) => entry.id);
      assert.equal(ids.includes("sync"), false, `sync is still a destination (developer=${developerMode})`);
      assert.equal(ids.includes("remoteHosts"), false, "remoteHosts is still a destination");
      assert.equal(isSettingsDestinationHidden("sync", developerMode, includeDevelopmentOnly), true);
      assert.equal(ids.includes("messaging"), true, "messaging is missing from the directory");
    }
  }
  assert.equal(SETTINGS_NAV.some((entry) => entry.id === "sync" || entry.id === "remoteHosts"), false);
});

test("the messaging destination carries the nav entry contract", () => {
  const entry = visibleSettingsNav(false, false).find((row) => row.id === "messaging");
  assert.ok(entry, "messaging is not in the directory of a packaged build");
  assert.equal(entry.labelKey, "settings.nav.messaging");
  assert.equal(entry.titleKey, "settings.messaging.title");
  assert.equal(entry.group, "agent");
  assert.equal(entry.developerOnly, undefined);
  assert.equal(entry.developmentOnly, undefined);
  assert.equal(entry.experimentalBadgeKey, undefined);
  assert.ok(entry.keywordKeys.length >= 10);
  assert.ok(
    searchSettings("messaging.getCredentials", identity, { developerMode: true }).some(
      (hit) => hit.tab === "messaging",
    ),
    "settings search does not reach the new messaging rows",
  );
});

test("Settings renders the messaging page and no longer imports RemoteHostsPage", () => {
  assert.match(
    settingsPage,
    /import \{ MessagingPlatformsPage \} from "\.\.\/\.\.\/components\/settings\/MessagingPlatformsPage"/,
  );
  assert.match(settingsPage, /tab === "messaging" && <MessagingPlatformsPage \/>/);
  assert.match(settingsPage, /messaging: <IconChat size=\{14\} \/>/);
  assert.doesNotMatch(settingsPage, /RemoteHostsPage/);
  assert.doesNotMatch(settingsPage, /remoteHosts/);
  assert.equal(
    existsSync(new URL("../src/components/settings/RemoteHostsPage.tsx", import.meta.url)),
    false,
  );
  assert.doesNotMatch(settingsSearch, /remoteHosts/);
});

test("cloud sync keeps its component and render branch while leaving the rail", () => {
  assert.match(settingsPage, /import \{ ConfigSyncPage \}/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsSearch, /\| "sync"/);
});

test("the section write is narrow, allowlisted, and can clear the section", () => {
  assert.match(protocol, /messagingSetSection: "pi-desktop\/messaging\/setSection"/);
  assert.match(protocol, /messagingGateway: "pi-desktop\/messaging\/gateway"/);
  assert.match(protocol, /messagingTelegramProbe: "pi-desktop\/messaging\/telegramProbe"/);
  assert.match(settingsIpc, /IPC\.invoke\.messagingSetSection/);
  assert.match(settingsIpc, /IPC\.invoke\.messagingGateway/);
  assert.match(settingsIpc, /IPC\.invoke\.messagingTelegramProbe/);
  assert.match(settingsIpc, /section !== MESSAGING_TELEGRAM_SECTION/);
  assert.match(settingsIpc, /section !== MESSAGING_SLACK_SECTION/);
  assert.match(settingsIpc, /section !== MESSAGING_DISCORD_SECTION/);
  assert.match(settingsIpc, /section !== MESSAGING_MATTERMOST_SECTION/);
  assert.match(settingsIpc, /section !== MESSAGING_HOME_ASSISTANT_SECTION/);
  assert.match(settingsIpc, /host\.call\("settings\.set", \{ \[section\]: value \}\)/);
  assert.match(api, /\bsetMessagingSection:/);
  assert.match(api, /\bsetSecret:/);
  assert.match(api, /\bhasSecret:/);
  // The page has no read path for a credential: presence only.
  assert.doesNotMatch(api, /getSecret|readSecret/);
});

test("the composition root registers the loops the panel reports on", () => {
  assert.match(startup, /messagingGateway\.track\("telegram", state\.messagingInbound\)/);
  assert.match(startup, /messagingGateway\.track\("slack", state\.messagingSlackInbound\)/);
  assert.match(startup, /messagingGateway\.track\("discord", state\.messagingDiscordInbound\)/);
  assert.match(
    startup,
    /messagingGateway\.track\("mattermost", state\.messagingMattermostInbound\)/,
  );
  assert.match(
    startup,
    /messagingGateway\.track\("homeAssistant", state\.messagingHomeAssistantInbound\)/,
  );
  assert.match(startup, /messagingGateway\.markBooted\(\)/);
});

/** Every catalog carries the messaging strings. */
test("every shipped catalog carries the messaging strings", () => {
  const locales = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
  const english = read("../../../packages/i18n/src/locales/en/index.ts").replace(/\r\n/g, "\n");
  const from = english.search(/\n {4}messaging: \{/);
  assert.ok(from >= 0, "en has no messaging block");
  const rest = english.slice(from + 1).split("\n");
  const stop = rest.findIndex((line) => line === "    },");
  assert.ok(stop > 0, "en's messaging block has no closing brace");
  const block = rest.slice(0, stop).join("\n");
  const keys = [...block.matchAll(/^ {6}([a-zA-Z][\w]*):/gm)].map((match) => match[1]);
  assert.ok(keys.length >= 120, `expected the messaging key set, saw ${keys.length}`);

  for (const locale of locales) {
    const source = read(`../../../packages/i18n/src/locales/${locale}/index.ts`).replace(/\r\n/g, "\n");
    assert.ok(
      source.includes('messaging: "') || source.includes('"messaging": "'),
      `${locale} has no nav.messaging`,
    );
    const messagingStart = source.search(/\n {4}(?:"messaging"|messaging): \{/);
    assert.ok(messagingStart >= 0, `${locale} has no messaging block`);
    const section = source.slice(messagingStart);
    for (const key of keys) {
      const pattern = new RegExp(`^\\s{6}"?${key}"?:`, "m");
      assert.match(section, pattern, `${locale} is missing settings.messaging.${key}`);
    }
  }
});
