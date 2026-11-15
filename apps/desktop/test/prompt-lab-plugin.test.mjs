import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
const pluginDir = join(desktopRoot, "resources/plugins/qianning.prompt-lab");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

test("the shipped prompt-lab plugin contributes a loadable agent extension", async (t) => {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
  });
  t.after(async () => {
    await runtime.unload("qianning.prompt-lab").catch(() => {});
  });

  await runtime.loadFromPath(pluginDir);
  const extensions = runtime.getAgentExtensions();
  const skipped = audits.filter((a) => a.api === "plugin.agentExtensions.skipped");
  assert.deepEqual(skipped, [], `nothing should be skipped: ${JSON.stringify(skipped)}`);
  assert.equal(extensions.length, 1, "one extension expected");
  assert.equal(extensions[0].entry, join(pluginDir, "src", "extension.mjs"));
});
