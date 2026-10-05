import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serviceSource = await readFile(
  new URL("../electron/main/voice-service.ts", import.meta.url),
  "utf8",
);
const ipcSource = await readFile(
  new URL("../electron/main/ipc/voice-ipc.ts", import.meta.url),
  "utf8",
);

test("voice model catalog initializes before it is listed", () => {
  assert.match(
    serviceSource,
    /async getModels\(\): Promise<ModelState\[\]> \{\s*await this\.ensureRuntime\(\);\s*return this\.modelManager!\.getAllStates\(\);\s*\}/s,
  );
  assert.doesNotMatch(
    serviceSource,
    /getModels\(\): ModelState\[\] \{\s*return this\.modelManager\?\.getAllStates\(\) \?\? \[\];\s*\}/s,
  );
  assert.match(
    ipcSource,
    /handle\(IPC\.invoke\.voiceGetModels, async \(\) => voiceService\.getModels\(\)\)/,
  );
});
