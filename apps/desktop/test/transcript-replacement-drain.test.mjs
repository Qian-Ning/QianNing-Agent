import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");

test("sessionReplaceMessages drains in-flight appends before replacing the transcript", () => {
  const sessionSource = readFileSync(join(root, "electron/main/ipc/session-ipc.ts"), "utf8");

  assert.match(
    sessionSource,
    /IPC\.invoke\.sessionReplaceMessages[\s\S]*?await\s+persistenceOutbox\.prepareSessionReplacement\(sessionId/,
    "sessionReplaceMessages must drain in-flight appends before dropping the queue and truncating",
  );
  assert.match(
    sessionSource,
    /prepareSessionReplacement\(sessionId[\s\S]*?session\.replaceMessages/,
    "the drain must happen before the host truncates the transcript",
  );
});
