import { readMainModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const racpSource = await readFile(
  new URL("../../../packages/shared/src/racp.ts", import.meta.url),
  "utf8",
);
const settingsIpcSource = await readMainModule("ipc/settings-ipc.ts");
const apiSource = await readFile(
  new URL("../src/lib/api.ts", import.meta.url),
  "utf8",
);

/**
 * The session-bind IPC channel is channel-parameterized (ADR 0326): the
 * Telegram channel keeps its exact shape (pinned by
 * `messaging-inbound-bind-ipc.test.mjs`), and the Slack channel gets its own
 * counterpart that selects the Slack settings section. These contracts pin the
 * Slack side and that it, too, stayed a host-internal write.
 */
test("the Slack bind channel is declared, handled with its channel descriptor, and exposed", () => {
  assert.match(
    protocolSource,
    /messagingInboundBindSessionSlack: "pi-desktop\/messagingSlack\/bindSession"/,
  );
  assert.match(settingsIpcSource, /handle\(IPC\.invoke\.messagingInboundBindSessionSlack,/);
  // The Slack handler selects the Slack channel descriptor; the write is the
  // same host-internal one the Telegram handler makes.
  assert.match(settingsIpcSource, /SLACK_INBOUND_CHANNEL/);
  assert.match(
    settingsIpcSource,
    /bindMessagingInboundSession\(\s*createHostSettingsSurface\(getHost\),\s*sessionId,\s*createHostSessionOwnerWriter\(getHost\),\s*SLACK_INBOUND_CHANNEL,?\s*\)/,
  );
  assert.match(apiSource, /bindSlackInboundSession: \(sessionId: string\)/);
  assert.match(
    apiSource,
    /invoke<\{ ok: boolean \}>\(IPC\.invoke\.messagingInboundBindSessionSlack, sessionId\)/,
  );
});

test("the Slack bind channel is not a RACP operation, so no remote peer can reach the settings row", () => {
  assert.doesNotMatch(racpSource, /messagingInboundBindSessionSlack|messagingSlack\/bindSession/);
});
