/**
 * Settings ▸ Messaging platforms, plus the settings-directory reorganisation it
 * arrived with:
 *
 * - the directory no longer offers Cloud sync (`sync`) or Remote hosts
 *   (`remoteHosts`), and offers a Messaging platforms destination of its own;
 * - the messaging form is built against the record the runtime actually reads,
 *   so its top-level keys and credentials cannot drift from the host's;
 * - a save writes a credential to the secret store under its ref and never into
 *   the settings row;
 * - the Connections destination is untouched: no second target inventory was
 *   added to absorb the retired Remote Hosts page.
 *
 * The pure module is imported and exercised; the wiring assertions read the
 * source they constrain.
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
  MESSAGING_PERMISSION_MODES,
  MESSAGING_PLATFORMS,
  MESSAGING_ROLES,
  buildSectionWrite,
  deriveMessagingStatus,
  draftFrom,
  draftMissing,
  isOwnRecord,
  planSecretWrites,
  saveMessagingPlatform,
} from "../src/lib/messaging-platforms.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const settingsPage = read("../src/features/settings/SettingsPage.tsx");
const connectionsPage = read("../src/pages/ConnectionsPage.tsx");
const hostPanel = read("../src/components/connections/MachineHostPanel.tsx");
const api = read("../src/lib/api.ts");
const protocol = read("../../../packages/shared/src/protocol.ts");
const settingsIpc = read("../electron/main/ipc/settings-ipc.ts");
const settingsSearch = read("../src/lib/settings-search.ts");
const telegramCrate = read("../../../crates/host-core/src/messaging_telegram.rs");
const slackCrate = read("../../../crates/host-core/src/messaging_slack.rs");
const agentHostInbound = read("../../../packages/agent-host/src/messaging-inbound.ts");
const agentHostSlack = read("../../../packages/agent-host/src/messaging-slack-inbound.ts");
const hostRuntimeWiring = read("../../../packages/host-runtime/src/messaging-inbound-wiring.ts");

const identity = (key) => key;

const telegram = MESSAGING_PLATFORMS.find((entry) => entry.id === "telegram");
const slack = MESSAGING_PLATFORMS.find((entry) => entry.id === "slack");

/** The platform list is the shipped set, in rail order. */
test("messaging lists exactly the platforms this build can run", () => {
  assert.deepEqual(
    MESSAGING_PLATFORMS.map((entry) => entry.id),
    ["telegram", "slack"],
  );
  for (const platform of MESSAGING_PLATFORMS) {
    assert.ok(platform.labelKey.startsWith("settings.messaging."), platform.id);
    assert.ok(platform.blurbKey.startsWith("settings.messaging."), platform.id);
    assert.ok(platform.secrets.length > 0, `${platform.id} names no credential`);
    for (const slot of platform.secrets) {
      assert.match(slot.ref, /^secret:messaging-[a-z]+:[a-z-]+$/, slot.ref);
    }
  }
});

/** The directory: sync and remoteHosts gone, messaging present, in every mode. */
test("the settings directory drops cloud sync and remote hosts", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      const ids = visibleSettingsNav(developerMode, includeDevelopmentOnly).map(
        (entry) => entry.id,
      );
      assert.equal(
        ids.includes("sync"),
        false,
        `sync is still a destination (developer=${developerMode}, dev-build=${includeDevelopmentOnly})`,
      );
      assert.equal(ids.includes("remoteHosts"), false, "remoteHosts is still a destination");
      assert.equal(
        isSettingsDestinationHidden("sync", developerMode, includeDevelopmentOnly),
        true,
      );
      assert.equal(
        ids.includes("messaging"),
        true,
        "messaging is missing from the directory",
      );
    }
  }
  assert.equal(
    SETTINGS_NAV.some((entry) => entry.id === "sync" || entry.id === "remoteHosts"),
    false,
  );
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
  assert.ok(entry.keywordKeys.length >= 5);
  assert.ok(
    searchSettings("messaging.platformSlack", identity, { developerMode: true }).some(
      (hit) => hit.tab === "messaging",
    ),
    "settings search does not reach the messaging rows",
  );
});

test("settings search no longer reaches the retired destinations", () => {
  for (const developerMode of [false, true]) {
    assert.deepEqual(
      searchSettings("configSync.connectionTitle", identity, { developerMode }),
      [],
    );
    assert.deepEqual(searchSettings("remoteHosts", identity, { developerMode }), []);
  }
});

/** The record shape is the host's, not an invention of the form. */
test("the written record has exactly the host's stored fields", () => {
  const storedFields = (source) => {
    const body = source.match(/struct StoredConfig \{([\s\S]*?)\n\}/)?.[1] ?? "";
    return [...body.matchAll(/^\s+(?:request_timeout_ms|format|version|endpoint|destination):/gm)]
      .map((match) => match[0].trim().replace(":", ""))
      .map((name) =>
        name.replace(/_([a-z])/g, (_all, letter) => letter.toUpperCase()),
      )
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

test("each platform's section, format and version match the runtime's constants", () => {
  assert.match(telegramCrate, /const SETTINGS_SECTION: &str = "messagingTelegram";/);
  assert.match(telegramCrate, /const FORMAT: &str = "pi-desktop-messaging-telegram";/);
  assert.match(telegramCrate, /const FORMAT_VERSION: u32 = 1;/);
  assert.match(slackCrate, /const SETTINGS_SECTION: &str = "messagingSlack";/);
  assert.match(slackCrate, /const FORMAT: &str = "pi-desktop-messaging-slack";/);
  assert.match(slackCrate, /const FORMAT_VERSION: u32 = 1;/);
  assert.match(
    agentHostInbound,
    /export const MESSAGING_TELEGRAM_SECTION = "messagingTelegram";/,
  );
  assert.match(
    agentHostInbound,
    /export const MESSAGING_TELEGRAM_FORMAT = "pi-desktop-messaging-telegram";/,
  );
  assert.match(agentHostSlack, /export const MESSAGING_SLACK_SECTION = "messagingSlack";/);
  assert.match(
    agentHostSlack,
    /export const MESSAGING_SLACK_FORMAT = "pi-desktop-messaging-slack";/,
  );

  assert.equal(telegram.section, "messagingTelegram");
  assert.equal(telegram.format, "pi-desktop-messaging-telegram");
  assert.equal(telegram.version, 1);
  assert.equal(slack.section, "messagingSlack");
  assert.equal(slack.format, "pi-desktop-messaging-slack");
  assert.equal(slack.version, 1);
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
  // Slack's send path reads a second, different token.
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
  assert.equal("inbound" in section, true);
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

test("the secret plan is a ref and a typed value, nothing else", () => {
  const draft = {
    ...draftFrom(telegram, null),
    secrets: { "bot-token": "  spaced-token  " },
  };
  assert.deepEqual(planSecretWrites(telegram, draft), [
    { ref: "secret:messaging-telegram:bot-token", value: "spaced-token" },
  ]);
});

/** Status is derived from what is stored, and every state is reachable. */
test("status reflects disabled, needs setup, running and error", () => {
  const complete = {
    format: "pi-desktop-messaging-telegram",
    version: 1,
    endpoint: "https://api.telegram.org",
    destination: "-1001234567890",
    inbound: { linkedPrincipal: { subject: "telegram:ops", roles: ["controller"] } },
  };

  assert.deepEqual(deriveMessagingStatus(telegram, undefined, {}), {
    status: "disabled",
    missing: [],
  });

  assert.deepEqual(
    deriveMessagingStatus(telegram, { ...complete, destination: "  " }, {
      "secret:messaging-telegram:bot-token": true,
    }),
    { status: "needsSetup", missing: ["destination"] },
  );

  assert.deepEqual(
    deriveMessagingStatus(telegram, { ...complete, inbound: {} }, {
      "secret:messaging-telegram:bot-token": true,
    }),
    { status: "needsSetup", missing: ["link"] },
  );

  assert.deepEqual(deriveMessagingStatus(telegram, complete, {}), {
    status: "needsSetup",
    missing: ["bot-token"],
  });

  assert.deepEqual(
    deriveMessagingStatus(telegram, complete, {
      "secret:messaging-telegram:bot-token": true,
    }),
    { status: "running", missing: [] },
  );

  assert.deepEqual(
    deriveMessagingStatus(telegram, { ...complete, version: 2 }, {
      "secret:messaging-telegram:bot-token": true,
    }),
    { status: "error", missing: [] },
  );
  assert.deepEqual(
    deriveMessagingStatus(telegram, { ...complete, format: "someone-elses" }, {
      "secret:messaging-telegram:bot-token": true,
    }),
    { status: "error", missing: [] },
  );

  // Slack needs both credentials, so one present is still needs setup.
  assert.deepEqual(
    deriveMessagingStatus(
      slack,
      {
        format: "pi-desktop-messaging-slack",
        version: 1,
        endpoint: "https://slack.com",
        destination: "C0123456789",
        inbound: { linkedPrincipal: { subject: "slack:ops", roles: ["controller"] } },
      },
      { "secret:messaging-slack:app-token": true },
    ),
    { status: "needsSetup", missing: ["bot-token"] },
  );
  assert.equal(
    isOwnRecord(slack, { format: "pi-desktop-messaging-telegram", version: 1 }),
    false,
  );
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

/** The page and its wiring: one destination, one narrow write, no dead page. */
test("Settings renders the messaging page and no longer imports RemoteHostsPage", () => {
  assert.match(settingsPage, /import \{ MessagingPlatformsPage \} from "\.\.\/\.\.\/components\/settings\/MessagingPlatformsPage"/);
  assert.match(settingsPage, /tab === "messaging" && <MessagingPlatformsPage \/>/);
  assert.match(settingsPage, /messaging: <IconChat size=\{14\} \/>/);
  assert.doesNotMatch(settingsPage, /RemoteHostsPage/);
  assert.doesNotMatch(settingsPage, /remoteHosts/);
  // The retired component is gone, not merely unimported.
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

test("the section write is narrow, allowlisted and goes through the host", () => {
  assert.match(protocol, /messagingSetSection: "pi-desktop\/messaging\/setSection"/);
  assert.match(settingsIpc, /IPC\.invoke\.messagingSetSection/);
  assert.match(
    settingsIpc,
    /section !== MESSAGING_TELEGRAM_SECTION && section !== MESSAGING_SLACK_SECTION/,
  );
  assert.match(settingsIpc, /host\.call\("settings\.set", \{ \[section\]: value \}\)/);
  assert.match(api, /\bsetMessagingSection:/);
  assert.match(api, /\bsetSecret:/);
  assert.match(api, /\bhasSecret:/);
  // The page has no read path for a credential: presence only.
  assert.doesNotMatch(api, /getSecret|readSecret/);
});

/** The Connections page after the reconciliation: one surface, two layers. */
test("Connections keeps the target layer and gains the host layer", () => {
  // Target layer, unchanged: add, list, switch, policy, limits.
  assert.match(connectionsPage, /api\.createConnectionProfile\(base\)/);
  assert.match(connectionsPage, /api\.listConnectionProfiles\(\)/);
  assert.match(connectionsPage, /api\.setConnectionEnabled\(profile\.id, !profile\.enabled\)/);
  assert.match(connectionsPage, /POLICIES\.map\(/);
  assert.match(connectionsPage, /connections\.limits/);

  // Host layer, merged in rather than a second manager.
  assert.match(connectionsPage, /useRemoteHosts\(\)/);
  assert.match(connectionsPage, /machineRows\(profiles \?\? \[\], hosts\)/);
  assert.match(connectionsPage, /<MachineHostSection/);
  assert.match(connectionsPage, /<HostOnlyPanel/);
  assert.match(hostPanel, /api\.onRemoteHostState/);
  assert.match(hostPanel, /api\.bootstrapRemoteHost\(/);
  assert.match(hostPanel, /api\.pairRemoteHost\(/);
  assert.match(hostPanel, /installRequestFor\(profile, password\)/);

  // One delete reports what it removed.
  assert.match(connectionsPage, /removalPlan\(row\)/);
  assert.match(connectionsPage, /api\.removeRemoteHost\(\{ hostKey: row\.host\.hostKey \}\)/);
  assert.match(connectionsPage, /connections\.removedBoth/);

  // Install is an action on a target, not a second add form: its dialog takes
  // no address — only the SSH password when the target's credential is one.
  const dialog = hostPanel.slice(
    hostPanel.indexOf("function InstallDialog"),
    hostPanel.indexOf("function MachineHostSection"),
  );
  assert.ok(dialog.length > 0, "InstallDialog not found");
  assert.equal((dialog.match(/<Input/g) ?? []).length, 0, "the install form grew an address field");
  assert.equal((dialog.match(/<PasswordInput/g) ?? []).length, 1);

  // Connections stays about targets: no messaging section was folded in.
  assert.doesNotMatch(connectionsPage, /messagingTelegram|messagingSlack/);
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
  assert.ok(keys.length >= 35, `expected the messaging key set, saw ${keys.length}`);

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
