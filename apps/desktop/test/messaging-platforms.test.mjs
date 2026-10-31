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
import { en } from "../../../packages/i18n/src/locales/en/index.ts";
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
const inboundLifecycle = read("../electron/main/messaging-inbound-lifecycle.ts");
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
  signal: true,
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
  signal: false,
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
  "signal",
  "homeAssistant",
  "email",
  "apiServer",
  "webhooks",
  "irc",
  "ntfy",
];

/** The whole catalogue, in rail order: thirty-three, eleven of them supported. */
test("the catalogue is the product's full list and marks support honestly", () => {
  assert.deepEqual(
    MESSAGING_PLATFORMS.map((entry) => entry.id),
    CATALOGUE_IDS,
    "the catalogue is not the product's list in the product's order",
  );
  assert.deepEqual(SUPPORTED_MESSAGING_PLATFORMS.map((entry) => entry.id), SUPPORTED_IDS);

  // The split is derived from the entries, not from a tuned constant: every id
  // in the catalogue is either one of the supported or one honest absence.
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
    "line",
    "microsoftGraph",
    "teams",
  ]);
  assert.deepEqual(byClass.bridgeOrPoll, [
    "whatsapp",
    "blueBubbles",
    "imessagePhone",
  ]);
  // apiServer left this class when its listener shipped: it is a supported
  // channel now, not an honest absence, so the transport class is the two
  // protocols still lacking a local endpoint.
  assert.deepEqual(byClass.transport, ["a2a", "relay"]);
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
  // own liveness and the `*Error` keys are a listener's failure reason, so
  // neither is a loop.
  const channelKeys = Object.keys(MESSAGING_GATEWAY_OFF).filter(
    (key) => key !== "booted" && !key.endsWith("Error"),
  );

  // One catalogue id does not name its loop directly: the webhook card is one
  // platform and the loop it rides is the shared inbound receiver. Every other
  // channel's key is its own id, so a channel added without a mapping still has
  // to declare one here.
  const gatewayKey = (id) => (id === "webhooks" ? "webhookReceiver" : id);

  for (const platform of platforms) {
    assert.ok(
      channelKeys.includes(gatewayKey(platform.id)),
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
      const snapshot = { ...GATEWAY_DOWN, [gatewayKey(running.id)]: true };
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
    } else if (platform.id === "signal") {
      // Signal has no single conversation either: a reply goes to whoever
      // wrote. The required values are the bridge's address, the account it is
      // registered for and the senders it may obey; the bridge token is
      // optional — a listener on loopback normally has none — so it sits with
      // the recommended fields.
      assert.deepEqual(requiredWithoutSecrets, [
        "endpoint",
        "account",
        "allowedSenders",
        "subject",
        "roles",
      ]);
      assert.deepEqual(
        recommended.map((field) => field.id),
        ["access-token", "permissionMode"],
      );
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        [],
      );
      assert.deepEqual(
        platform.secrets.map((slot) => slot.id),
        ["access-token"],
        "Signal's optional bridge token still has a slot",
      );
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
    } else if (platform.id === "apiServer") {
      // The local API is a listener, not a chat peer: no destination, subject or
      // role list, because the bearer token is the whole identity and the caller
      // names the conversation. What the record must carry is where it binds, and
      // its token is required — a loopback listener with no token is a way into
      // the agent for every process on the machine.
      assert.deepEqual(requiredWithoutSecrets, ["port", "bindAddress"]);
      assert.deepEqual(recommended.map((field) => field.id), ["requestTimeoutMs"]);
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        ["api-token"],
        "the local API's token is required, unlike ntfy's optional one",
      );
    } else if (platform.id === "webhooks") {
      // The receiver is a listener with one binding, not a chat peer: no
      // destination, subject or role list. What it cannot start without is where
      // it binds and the session an accepted event acts on; the signing secret
      // is required too, because a receiver that authenticates nobody is a way
      // into the agent for every process that can reach the port.
      assert.deepEqual(requiredWithoutSecrets, ["port", "bindAddress", "sessionId"]);
      assert.deepEqual(recommended.map((field) => field.id), []);
      assert.deepEqual(
        requiredIds.filter((id) => platform.secrets.some((slot) => slot.id === id)),
        ["signing-secret"],
      );
      assert.deepEqual(platform.secrets.map((slot) => slot.id), ["signing-secret"]);
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
      if (platform.id === "signal" && (id === "destination" || id === "requestTimeoutMs")) {
        continue;
      }
      // The webhook receiver has none of them: its endpoint is this listener,
      // its "conversation" is the bound session it serves, and it names no link.
      if (platform.id === "webhooks") {
        continue;
      }
      // The local API has none of the conversation fields: its address is a bind
      // address on this machine, not a peer, and it has no endpoint or link.
      if (
        platform.id === "apiServer" &&
        (id === "destination" || id === "subject" || id === "endpoint")
      ) {
        continue;
      }
      const field = platform.fields.find((entry) => entry.id === id);
      assert.ok(field?.placeholderKey, `${platform.id}.${id} has no example`);
    }
  }
});

/**
 * Signal's allowlist is the one field that decides whether the channel obeys
 * anyone at all. The panel must refuse to save without it, write it trimmed and
 * lowered, treat a stored record without it as incomplete, and say plainly that
 * an empty list lets nobody in.
 */
test("Signal's sender allowlist is required, normalised, and explained as fail-closed", () => {
  const signal = SUPPORTED_MESSAGING_PLATFORMS.find((platform) => platform.id === "signal");

  const field = signal.fields.find((entry) => entry.id === "allowedSenders");
  assert.ok(field, "Signal has no sender allowlist field");
  assert.equal(field.group, "required", "an allowlist that can be skipped protects nobody");
  for (const key of [field.labelKey, field.helpKey, field.placeholderKey, field.consequenceKey]) {
    assert.match(key, /^settings\.messaging\./, `${field.id} names a missing key`);
  }

  const draft = {
    ...draftFrom(signal, null),
    endpoint: "http://127.0.0.1:8080",
    account: "+15550000000",
    subject: "signal:ops",
    roles: ["controller"],
  };
  assert.equal(canSave(signal, { ...draft, allowedSenders: "" }), false);
  assert.equal(canSave(signal, { ...draft, allowedSenders: "  ,   " }), false);
  assert.equal(canSave(signal, { ...draft, allowedSenders: "+15550000002" }), true);

  const record = buildSectionWrite(
    signal,
    { ...draft, allowedSenders: " +15550000002 , 0f2a-uuid , +15550000002 " },
    null,
  );
  assert.deepEqual(record.allowedSenders, ["+15550000002", "0f2a-uuid"]);
  assert.equal(record.destination, "", "Signal still has no single destination");

  // A stored record from before the field existed is incomplete, not open.
  const { allowedSenders: _omitted, ...legacy } = record;
  const state = deriveChannelState(signal, legacy, {}, MESSAGING_GATEWAY_OFF);
  assert.equal(state.setup, "incomplete");
  assert.ok(state.missing.includes("allowedSenders"));

  // The copy states the fail-closed rule, in words a person reads once.
  assert.match(en.settings.messaging.consequenceSignalSenders, /empty list allows nobody/i);
  assert.match(en.settings.messaging.signalAllowedSendersHint, /group/i);
  assert.match(en.settings.messaging.signalAllowedSendersHint, /sent it, not the group/i);
  assert.match(en.settings.messaging.signalLimitations, /empty list refuses everyone/i);
});

/** The process card switch (ADR 0340): written when on, gone when off. */
test("the card switch is written only when it is on", () => {
  const draft = { ...draftFrom(telegram, null), destination: "42", subject: "ops" };

  const off = buildSectionWrite(telegram, { ...draft, card: false }, null);
  assert.equal(
    Object.hasOwn(off, "card"),
    false,
    "a channel that never asked for a card keeps the record shape it always had",
  );

  const on = buildSectionWrite(telegram, { ...draft, card: true }, null);
  assert.equal(on.card, true);

  // The section is rebuilt from the draft on every save, so omitting the key is
  // what turns the switch off: saving from an on-record with the switch off
  // must not carry the old value forward.
  const turnedOff = buildSectionWrite(telegram, { ...draft, card: false }, on);
  assert.equal(Object.hasOwn(turnedOff, "card"), false);
});

/** Reading a stored record back into the form. */
test("a stored card switch comes back into the draft", () => {
  const stored = { ...buildSectionWrite(telegram, { ...draftFrom(telegram, null), destination: "42" }, null), card: true };
  assert.equal(draftFrom(telegram, stored).card, true);
  assert.equal(draftFrom(telegram, null).card, false);
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
 * The header control is a two-way affordance, not a one-way button: it is a
 * switch whose checked state IS the stored state, and flipping it persists
 * through the same `onSave` the footer's submit uses.
 *
 * An earlier version rendered a button that named only the direction that was
 * possible (`enableNow` / `disableNow`). On a channel with no record that is
 * always "Enable now", which twice read to a user as "this channel cannot be
 * turned off". The switch plus the note that names the other position is the
 * fix, so this test pins the switch rather than the old labels.
 */
test("the header's enable switch is two-way and persists through the panel's submit path", () => {
  const detail = page.slice(
    page.indexOf("function MessagingDetail"),
    page.indexOf("function SupportedPanel"),
  );
  assert.ok(detail.length > 0, "the detail component is missing");
  assert.ok(detail.includes("<SettingsToggle"), "the header has no switch");
  assert.match(detail, /checked=\{storedOn\}/, "the switch does not show the stored state");
  assert.ok(detail.includes("settings.messaging.headerSwitchLabel"), "the switch has no name");
  // Both positions are named, and the note for the current one says what the
  // other one does — that sentence is what makes the control read as two-way.
  assert.ok(detail.includes("settings.messaging.headerOnNote"), "no note for the on state");
  assert.ok(detail.includes("settings.messaging.headerOffNote"), "no note for the off state");
  assert.ok(
    detail.includes("settings.messaging.headerOffBlockedNote"),
    "the blocked off state does not explain itself",
  );
  // The one-way button labels are gone from the header.
  assert.equal(detail.includes("settings.messaging.enableNow"), false);
  assert.equal(detail.includes("settings.messaging.disableNow"), false);
  // The switch and the footer save through the same `submit`, which hands the
  // draft and the toggle's direction to `onSave` — the persistence the old
  // one-way button also had, under the flag's current name.
  assert.match(detail, /await onSave\(draft, nextEnabled\)/);
  // Enabling is gated on the draft's required fields and says why; disabling is
  // not gated, so it stays available on a channel that is already on.
  assert.ok(detail.includes("settings.messaging.quickEnableBlocked"));
  assert.match(detail, /storedOn \|\| ready/);
  assert.match(detail, /if \(next && blockedReason !== null\) return;/);
  // A blocked enable disables the switch instead of letting it appear to move.
  assert.match(detail, /disabled=\{!storedOn && blockedReason !== null\}/);
  // One draft and one enabled flag for both controls.
  assert.equal((page.match(/useState<MessagingDraft>/g) ?? []).length, 1);
  assert.equal((page.match(/useState\(true\)/g) ?? []).length, 1);
});

/**
 * Every anchor on this page leaves the app, so every one of them has to look
 * clickable before it is read: the shared guide class, the external marker, and
 * the stylesheet rules that carry colour, underline, focus ring and hover.
 *
 * The count assertion is deliberate. Adding an anchor without the affordance is
 * the regression this test exists to catch, so a new anchor has to be looked at
 * here rather than silently inheriting plain-prose styling.
 */
test("every guide link on the page carries the link affordance", () => {
  const anchors = page.match(/<a\b[\s\S]*?<\/a>/g) ?? [];
  assert.equal(anchors.length, 2, "a new anchor needs the guide-link affordance");
  for (const anchor of anchors) {
    assert.ok(
      anchor.includes('className="settings-messaging-guide"'),
      "an anchor does not use the guide link class",
    );
    assert.ok(anchor.includes("settings-messaging-guide-mark"), "an anchor has no external marker");
    assert.ok(anchor.includes("settings.messaging.guideExternal"), "the marker is not named");
    assert.ok(anchor.includes('target="_blank"'), "an anchor does not leave the app");
  }

  const styles = read("../src/styles/settings.css");
  const rules = styles.slice(
    styles.indexOf(".settings-messaging-guide {"),
    styles.indexOf(".settings-messaging-quick {"),
  );
  assert.match(rules, /color: var\(--ds-accent\)/, "the link does not use the interactive colour");
  assert.match(rules, /text-decoration: underline/, "the link has no underline");
  assert.match(rules, /:focus-visible \{\s*\n\s*outline: 2px solid var\(--ds-focus\)/, "no focus ring");
  assert.match(rules, /@media \(hover: hover\) and \(pointer: fine\)/, "hover is not pointer-gated");
  assert.equal(/color:\s*#/.test(rules), false, "the link rules carry a raw colour literal");
});

/**
 * The gateway registry: the loop's lifetime is the signal.
 *
 * The expected shape is `MESSAGING_GATEWAY_OFF` — the export the panel itself
 * renders before the first reply — rather than a fourth hand-written copy of the
 * channel keys. The snapshot is asserted exactly, so a channel the registry
 * invents or drops still fails; a channel added to the snapshot type shows up
 * here without editing the literals again.
 */
test("the gateway registry reports the loops that are actually running", async () => {
  const registry = new MessagingGatewayRegistry();
  assert.deepEqual(registry.snapshot(), { ...MESSAGING_GATEWAY_OFF });

  registry.markBooted();
  let finishTelegram;
  const telegramDone = new Promise((resolve) => {
    finishTelegram = resolve;
  });
  registry.track("telegram", { done: telegramDone });
  registry.track("slack", null);
  assert.deepEqual(registry.snapshot(), {
    ...MESSAGING_GATEWAY_OFF,
    booted: true,
    telegram: true,
  });

  registry.track("slack", { done: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(registry.snapshot().slack, false, "a loop that already ended is not running");

  finishTelegram();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.snapshot(), { ...MESSAGING_GATEWAY_OFF, booted: true });
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

test("the composition root hands every loop to the one supervisor the panel's gateway reads", () => {
  // The loops are owned by `MessagingInboundSupervisor`, which tracks them in
  // the same registry the IPC handler answers the panel from. Startup builds no
  // loop of its own: a loop outside the supervisor is a loop no settings write
  // can stop, which is how a channel reported `已关闭` kept its gateway running.
  assert.match(startup, /createMessagingInboundSupervisor\(/);
  assert.match(startup, /setMessagingInboundSupervisor\(supervisor\)/);
  assert.match(startup, /messagingGateway\.markBooted\(\)/);
  assert.doesNotMatch(startup, /new AbortController\(/);
  assert.doesNotMatch(startup, /messagingGateway\.track\(/);

  // Every channel that has an inbound loop is in the one starter map, so the
  // teardown applies to all of them and not only the channel that was observed.
  for (const channel of [
    "telegram",
    "slack",
    "discord",
    "mattermost",
    "matrix",
    "irc",
    "homeAssistant",
    "ntfy",
    "email",
    "signal",
  ]) {
    assert.match(
      inboundLifecycle,
      new RegExp(`^\\s*${channel}: \\(signal\\) => create`, "m"),
      `${channel} has no starter, so its loop would have no owner`,
    );
  }
  // The readiness the supervisor starts from reads the same two host surfaces
  // the transports read, and the registry is the one the renderer polls.
  assert.match(inboundLifecycle, /createMessagingInboundReadiness\(\{ settings, secrets \}\)/);
  assert.match(inboundLifecycle, /gateway: messagingGateway/);
});

test("a messaging settings write reconciles that channel's loop", () => {
  // The settings path is the only thing that can remove a record, so it is the
  // path that must stop the loop. Both branches of the section write — the
  // clear (a channel turned off) and the replace (an edited record) — reconcile
  // after the write has landed at the host.
  const sectionWrite = settingsIpc.slice(
    settingsIpc.indexOf("IPC.invoke.messagingSetSection"),
    settingsIpc.indexOf("IPC.invoke.messagingGateway"),
  );
  assert.ok(sectionWrite.length > 0, "the messaging section write handler is missing");
  assert.equal(
    (sectionWrite.match(/await reconcileMessagingChannelSection\(section\)/g) ?? []).length,
    2,
    "both the clear and the replace must reconcile the channel",
  );
  // The general settings save round-trips the messaging sections, so it
  // reconciles the channels whose sections were in the write.
  assert.match(settingsIpc, /messagingChannelForSection\(key\)/);
  assert.match(settingsIpc, /await reconcileAllMessagingChannels\(\)/);
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

/**
 * The chooser and the detail pane are two independent scroll ports.
 *
 * The settings page used to scroll as one surface: a wheel over the platform
 * list carried the detail pane with it, and a long panel pushed the list out of
 * view. The fix only works as three parts together — the ancestor stops
 * scrolling for this destination, both columns declare a bounded scroll port,
 * and the pane (not the window) resets its own scroll on selection — so all
 * three are pinned here.
 */
test("the chooser and the detail pane are independent scroll ports", () => {
  const styles = read("../src/styles/settings.css");
  const block = (needle) => {
    const start = styles.indexOf(needle);
    assert.ok(start >= 0, `no rule for ${needle}`);
    return styles.slice(start, styles.indexOf("}", start));
  };

  // 1. The ancestor that used to scroll this section is scoped to this
  // destination and stops scrolling. The attribute is extension while a
  // plugin page owns the pane, so a plugin iframe is never clipped.
  assert.match(
    settingsPage,
    /className="settings-content"[\s\S]{0,140}data-settings-tab=\{activeExtension \? "extension" : tab\}/,
  );
  const frame = block('.settings-content[data-settings-tab="messaging"] {');
  assert.match(frame, /overflow: hidden/, "the content pane still scrolls this section");
  assert.match(frame, /min-height: 0/, "the frame hands its children no bounded height");

  // 2. Both columns are scroll ports: bounded, shrinkable, and non-chaining.
  for (const selector of [".settings-messaging-list", ".settings-messaging-detail"]) {
    const column = block(`${selector} {`);
    assert.match(column, /overflow-y: auto/, `${selector} is not a scroll port`);
    assert.match(column, /min-height: 0/, `${selector} cannot shrink to its share of the row`);
    assert.match(column, /overscroll-behavior-y: contain/, `${selector} chains its scroll`);
  }
  assert.match(
    styles,
    /\n\.settings-messaging \{[^}]*align-items: stretch;[^}]*min-height: 0;/s,
    "the columns still size to their content instead of the row",
  );
  assert.match(
    styles,
    /\n\.settings-messaging-chooser \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/s,
    "the chooser head does not keep its height above the scrolling list",
  );

  // 3. Stacked, the page scrolls again rather than showing two cramped boxes.
  const narrow = styles.slice(styles.indexOf("@media (max-width: 860px)"));
  assert.match(
    narrow,
    /\.settings-messaging-list,\n\s*\.settings-messaging-detail \{[^}]*overflow: visible/,
    "the narrow layout kept two bounded scroll boxes",
  );

  // 4. The reset is the detail pane's own scrollTop, through the pane's ref.
  assert.match(page, /const detailRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(page, /ref=\{detailRef\}/);
  assert.match(page, /detailRef\.current[\s\S]{0,80}scrollTop = 0/);
  assert.match(page, /\}, \[selectedId\]\);/);
});
