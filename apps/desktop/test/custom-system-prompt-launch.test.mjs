import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");

// The persona a launch carries is exactly one editable scope:
//
//   conversation (sessions.system_prompt)  >  built-in default
//
// The old file layer (`.pi/SYSTEM.md` / `APPEND_SYSTEM.md`) and the app-wide
// global prompt were both removed: a persona the UI cannot show, or a second
// scope the user did not set on this conversation, is a persona the user
// cannot reason about. The regression this file guards is a file on disk, or
// an inherited setting, silently overriding — or blanking — what the user
// typed on this conversation.
const workspace = mkdtempSync(join(tmpdir(), "pi-csp-ws-"));

test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
const provider = {
  id: "fixture-provider", vendorKey: "fixture", name: "Fixture", enabled: true,
  authKind: "none", baseUrl: "http://127.0.0.1:1/v1", apiStyle: "openai-chat",
  models: [{ id: "parent", thinkingLevels: ["off"] }],
};

function launchRuntime() {
  return createSessionLaunchRuntime({
    runtimeState: { host: {
      isAvailable: () => true,
      call: async (method) => {
        if (method === "commandShells.list") return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return {};
        if (method === "agents.active") return { subagents: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "project.memory.get") return {};
        throw new Error(`Unexpected host call ${method}`);
      },
    } },
    logger: { app() {} }, userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: workspace, vendorOAuth: {},
    modelsDevCatalog: { ensureLoaded: async () => {}, findModel: () => undefined },
    getWorkspacePath: () => workspace, pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((m) => m.id === id),
    effectiveSubagentModelConfig: () => ({}),
    normalizeThinkingLevel: () => "off",
  });
}

async function launchParams(
  runtime,
  session = { providerId: provider.id, modelId: "parent", projectPath: workspace },
  settings = {},
) {
  const launch = await runtime.resolveAgentRuntimeLaunch("session", session, settings);
  return launch.sidecarParams;
}

test("launch reads no persona from disk", async () => {
  const runtime = launchRuntime();

  // A persona file in the workspace — the old `.pi/SYSTEM.md` layer — must not
  // reach the sidecar at all. The name is deliberately the one that used to win.
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "SYSTEM.md"), "MARKER-FILE-PERSONA");
  writeFileSync(join(workspace, ".pi", "APPEND_SYSTEM.md"), "MARKER-FILE-APPEND");

  try {
    const params = await launchParams(runtime);
    assert.equal(params.systemPrompt, undefined);
    assert.equal(params.customSystemPrompt, undefined);
    assert.doesNotMatch(JSON.stringify(params), /MARKER-FILE-/);
  } finally {
    rmSync(join(workspace, ".pi"), { recursive: true, force: true });
  }
});

test("a conversation with no prompt of its own falls back to the built-in persona", async () => {
  const runtime = launchRuntime();
  const base = { providerId: provider.id, modelId: "parent", projectPath: workspace };

  // There is no app-wide scope any more: a global setting must not become the
  // persona, so it is ignored and the built-in persona answers.
  assert.equal(
    (await launchParams(runtime, base, { globalSystemPrompt: "MARKER-GLOBAL-PERSONA" }))
      .systemPrompt,
    undefined,
  );
  // With nothing set at all, the launch carries no prompt and the built-in
  // persona answers.
  assert.equal((await launchParams(runtime, base)).systemPrompt, undefined);
});

test("the conversation prompt is the only editable scope", async () => {
  const runtime = launchRuntime();
  const base = { providerId: provider.id, modelId: "parent", projectPath: workspace };

  // The conversation prompt reaches the model, and a stray global setting does
  // not shadow or replace it.
  const set = await launchParams(
    runtime,
    { ...base, systemPrompt: "MARKER-CONVERSATION" },
    { globalSystemPrompt: "MARKER-GLOBAL-PERSONA" },
  );
  assert.equal(set.systemPrompt, "MARKER-CONVERSATION");

  // A whitespace-only conversation prompt is not an override, so the built-in
  // persona — not a blank one and not a global setting — is what reaches the model.
  const blank = await launchParams(
    runtime,
    { ...base, systemPrompt: "   " },
    { globalSystemPrompt: "MARKER-GLOBAL-PERSONA" },
  );
  assert.equal(blank.systemPrompt, undefined);

  // The stored value is trimmed, so a padded prompt does not carry its
  // whitespace into the model's system message.
  const padded = await launchParams(runtime, { ...base, systemPrompt: "  spaced  " });
  assert.equal(padded.systemPrompt, "spaced");
});
