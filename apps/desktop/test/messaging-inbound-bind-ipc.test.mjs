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
 * The inbound messaging wiring builds a conversation-to-session binding store,
 * but nothing in production wrote it: a linked chat was always unbound and
 * every inbound command was refused. These contracts pin the writer that fixes
 * that — the protocol declaration, the desktop-main handler, and the client
 * surface — and pin that it stayed a host-internal write.
 */
test("the host-internal bind channel is declared, handled, and exposed to the client", () => {
  assert.match(
    protocolSource,
    /messagingInboundBindSession: "pi-desktop\/messagingInbound\/bindSession"/,
  );
  assert.match(settingsIpcSource, /handle\(IPC\.invoke\.messagingInboundBindSession,/);
  // Assert the behaviour, not a byte-exact call: the bind write must receive the
  // settings surface, the session id, and a session-owner writer. The three
  // arguments are matched as a set with whitespace tolerance so a reflow or a
  // trailing comma does not break the test, while the meaning — that the owner
  // writer rides along with the settings surface and session id — is still
  // pinned. It is no longer pinned to one private implementation line. The
  // behaviour itself (the owner write and the binding write are one call) is
  // covered by packages/host-runtime/src/messaging-inbound-wiring.test.ts.
  assert.match(
    settingsIpcSource,
    /bindMessagingInboundSession\(\s*createHostSettingsSurface\(getHost\),\s*sessionId,\s*createHostSessionOwnerWriter\(getHost\),?\s*\)/,
  );
  assert.match(apiSource, /bindMessagingInboundSession: \(sessionId: string\)/);
  assert.match(
    apiSource,
    /invoke<\{ ok: boolean \}>\(IPC\.invoke\.messagingInboundBindSession, sessionId\)/,
  );
});

test("the bind channel is not a RACP operation, so no remote peer can reach the settings row", () => {
  assert.doesNotMatch(racpSource, /messagingInboundBindSession|messagingInbound\/bindSession/);
});
