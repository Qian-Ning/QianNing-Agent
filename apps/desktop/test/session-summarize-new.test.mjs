import { readAppSource, readStoreSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [store, api, main, protocol, runtime, inspector, transcriptText] =
  await Promise.all([
    readStoreSource(),
    read("../src/lib/api.ts"),
    readMainSource(),
    read("../../../packages/shared/src/protocol.ts"),
    read("../../../packages/agent-runtime/src/session-context-summarize.ts"),
    read("../src/components/ContextUsageInspector.tsx"),
    read("../src/lib/chat-transcript-text.ts"),
  ]);

/** The body of the summarize action, isolated from the rest of the store blob. */
function summarizeActionBody(source) {
  const start = source.indexOf("summarizeAndStartNewSession: async () => {");
  assert.ok(start >= 0, "summarizeAndStartNewSession action not found in store");
  // The next slice action begins the following store entry; bound the body well
  // before it so cross-action matches cannot leak in.
  return source.slice(start, start + 2600);
}

test("context summarization is wired through the full desktop path", () => {
  // Channel declared once in the protocol, exposed via the renderer api, handled
  // in main, and backed by a one-shot runtime twin of title summarization.
  assert.match(
    protocol,
    /sessionSummarizeContext: "pi-desktop\/session\/summarizeContext"/,
  );
  assert.match(
    api,
    /summarizeSessionContext: \(req: SessionSummarizeContextRequest\)/,
  );
  assert.match(api, /IPC\.invoke\.sessionSummarizeContext/);
  assert.match(main, /handle\(IPC\.invoke\.sessionSummarizeContext/);
  assert.match(main, /summarizeSessionContext\(/);
  assert.match(runtime, /completeOneShot\(/);
  assert.match(runtime, /context to carry forward/);
});

test("summarize-and-new-session is additive: it never compacts or mutates the source", () => {
  // The action reads the full session, summarizes it, opens a fresh session in
  // the same project, and pre-fills the composer. It must not call api.compact
  // and must route the summary into composerPrefill, never a system prompt.
  const body = summarizeActionBody(store);
  assert.match(body, /await api\.getSession\(sessionId\)/);
  assert.match(body, /await api\.summarizeSessionContext\(/);
  assert.match(body, /await get\(\)\.newSession\(\{ projectPath \}\)/);
  assert.match(body, /composerPrefill: \{/);
  // The summary is a draft the user edits, not a persona layer, and the source
  // conversation is never compacted or otherwise mutated by this path.
  assert.doesNotMatch(body, /setActiveSessionSystemPrompt/);
  assert.doesNotMatch(body, /api\.compact\(/);
  // Project inheritance keeps a project conversation's summary inside it.
  assert.match(body, /projectPath = source\?\.projectPath \?\? null/);
});

test("the summarize action is declared on the store and exposed from the inspector", () => {
  // The action type lives in the store's app-state surface.
  assert.match(store, /summarizeAndStartNewSession: \(\) => Promise<void>/);
  // The inspector drives it, gates it while a turn runs, and skips native sessions.
  assert.match(inspector, /summarizeAndStartNewSession/);
  assert.match(inspector, /context-inspector-summarize/);
  assert.match(inspector, /disabled=\{isRunning \|\| summarizing\}/);
  assert.match(inspector, /chat\.summarizeNewSession/);
  assert.match(inspector, /startsWith\("native-pi:"\)/);
});

test("the transcript clamp keeps the summary input bounded", () => {
  assert.match(transcriptText, /export function clampTranscriptForSummary/);
  assert.match(transcriptText, /SUMMARY_TRANSCRIPT_MAX_CHARS/);
});
