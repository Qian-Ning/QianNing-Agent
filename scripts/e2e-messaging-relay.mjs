#!/usr/bin/env node
/**
 * Headless outbound-messaging E2E (E2E-232): boots a real `pi-host` with the
 * debug host-core and the bundled sidecar on a throwaway data dir, with the
 * outbound webhook channel and the Telegram channel configured against loopback
 * fixtures, one linked chat and one unlinked chat, and drives the six steps of
 * `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-232) over the real RACP
 * socket.
 *
 * Everything is loopback: the webhook sink, the long-polling bot, and the model
 * service are `node:http` servers on `127.0.0.1:0`. No external service, no
 * live token, no Electron.
 *
 * The waits are the Host's own cadence, not arbitrary sleeps: host-core's
 * outbound driver runs one tick every 30s and claims at most one delivery per
 * tick, so a summary reaches the sink in one tick and the same summary reaches
 * the bot in the next. Every delivery wait below is a poll with a bound sized
 * for that cadence — a few queued deliveries plus a retry — and fails loudly,
 * naming the delivery it was waiting for, rather than sleeping and hoping.
 *
 * What each Expected clause is asserted by — see the `record(...)` ids:
 *
 * - "redacted summaries of turn.completed and approval.requested with ids and
 *   bounded summary text only": `payloads-carry-ids-and-bounded-summary-only`
 *   checks every envelope both receivers were sent: the summary's key set is
 *   exactly the redactor's structural fields, every string value is a short id
 *   or timestamp, the whole summary is bounded, and no sentinel — planted in
 *   the model's reply text and in the `Write` tool call's path and content —
 *   appears anywhere in it;
 * - "the linked chat's stop maps to turn/stop under the linked principal's
 *   roles and the turn ends at the next boundary":
 *   `linked-stop-maps-to-turn-stop` reads the Host's own audit record for the
 *   command (kind `operation`, operation `turn/stop`, no `operation-failed`),
 *   and `linked-stop-ends-the-turn` waits for that turn to reach its end;
 * - "the unlinked chat's command has no effect and is audited":
 *   `unlinked-command-has-no-effect` and `unlinked-command-is-audited`;
 * - "delivery failures are retried within the bound and never delay or block
 *   the turn": `delivery-failure-does-not-delay-the-turn`,
 *   `failed-delivery-is-retried-within-the-bound`,
 *   `failed-delivery-recovers-after-the-sink-recovers`;
 * - "the Host opens no listener": `host-opens-no-listener`, which enumerates
 *   the TCP listening sockets of every process in the Host's own process tree
 *   and requires them all to be the one RACP loopback port the Host announced.
 *
 * Prereqs: `pnpm build:js`, `pnpm -C packages/agent-runtime bundle`, and a
 * host-core binary (target/debug or PI_DESKTOP_HOST_BIN).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MESSAGING_TELEGRAM_FORMAT } from "../packages/agent-host/dist/index.js";
import {
  MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF,
  TELEGRAM_INBOUND_CHANNEL,
  bindMessagingInboundSession,
  createHostSessionOwnerWriter,
  createHostSettingsSurface,
} from "../packages/host-runtime/dist/index.js";
import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { assert, shortJson } from "./e2e/assert.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import {
  SENTINEL,
  SENTINEL_FILE,
  botFixture,
  pollUntil,
  relayModelFixture,
  webhookSinkFixture,
} from "./e2e/messaging-relay-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps/pi-host/dist/cli.js");
const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
for (const [label, path] of [
  ["pi-host cli", cli],
  ["sidecar bundle", sidecar],
]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    process.exit(1);
  }
}
const hostBin = resolveHostBinary();

/** The one conversation the channel is linked to, and one it is not. */
const LINKED_CHAT = "chat-linked-1";
const UNLINKED_CHAT = "chat-unlinked-2";
const LINKED_PRINCIPAL = "linked-user";
const LINKED_ROLES = ["controller", "approver"];
const BOT_TOKEN = "e2e-232-bot-token";
/** The fixed stop command of steps 3 and 4, verbatim. */
const STOP_COMMAND = "/stop";
/** What a delivered summary may carry: the redactor's structural fields only. */
const SUMMARY_KEYS = new Set([
  "eventId",
  "kind",
  "scope",
  "sessionId",
  "turnId",
  "epoch",
  "sequence",
  "revision",
  "status",
  "agentName",
  "occurredAt",
]);
/** The adapter's envelope keys, which the receiver sees around the summary. */
const ENVELOPE_KEYS = new Set(["deliveryId", "channel", "redelivery", "summary"]);
/** A summary longer than this is not "bounded summary text". */
const SUMMARY_MAX_CHARS = 1_000;
/** The webhook adapter's attempt bound (host-core's `DEFAULT_MAX_ATTEMPTS`). */
const DELIVERY_MAX_ATTEMPTS = 5;

const dataDir = mkdtempSync(join(tmpdir(), "pi-host-messaging-e2e-"));
const project = join(dataDir, "project");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# relay project\n");
const logPath = join(dataDir, "logs", "pi-host.log");
const at = (seconds) => (seconds ? seconds * 1_000 : 0);

const results = [];
const record = (id, ok, detail = "") => {
  results.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
};

const started = Date.now();
/** Progress tracing for diagnosing a run; silent unless PI_RELAY_TRACE=1. */
function trace(message) {
  if (process.env.PI_RELAY_TRACE === "1") {
    console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
  }
}

/** Every audit record the Host logged, newest read from the file each call. */
function hostAudit() {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf8").split("\n");
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message === "inbound messaging command path" && parsed.data) entries.push(parsed.data);
    } catch {
      // A partially written last line is not an audit record.
    }
  }
  return entries;
}

/**
 * The TCP listening sockets owned by `pid` and every descendant of it: one
 * `Get-NetTCPConnection` filtered by the process tree, so the answer is the
 * operating system's view of the Host, not a probe of a port the test chose.
 */
function hostListeners(pid) {
  const script = [
    `$root = ${Number(pid)}`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
    "$ids = @($root)",
    "$grow = $true",
    "while ($grow) { $grow = $false; foreach ($p in $all) { if (($ids -contains $p.ParentProcessId) -and (-not ($ids -contains $p.ProcessId))) { $ids += $p.ProcessId; $grow = $true } } }",
    "$out = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess",
    'if ($out) { $out | ConvertTo-Json -Compress } else { "[]" }',
  ].join("; ");
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
  const parsed = JSON.parse(raw || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    address: entry.LocalAddress,
    port: entry.LocalPort,
    pid: entry.OwningProcess,
  }));
}

let child = null;
let stderr = "";
function startHost() {
  child = spawn(
    process.execPath,
    [
      cli,
      "--data-dir",
      dataDir,
      "--port",
      "0",
      "--host-core",
      hostBin,
      "--sidecar",
      sidecar,
      "--browse-root",
      dataDir,
      "--log-level",
      "info",
      "--pair",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (process.env.DEBUG_HOST) process.stderr.write(chunk);
  });
  return new Promise((resolveReady, reject) => {
    let out = "";
    const ready = {};
    const timer = setTimeout(() => reject(new Error("pi-host did not become ready\n" + stderr.slice(-2_000))), 60_000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      for (const line of out.split("\n")) {
        if (line.startsWith("PI_HOST_READY ")) ready.info = JSON.parse(line.slice("PI_HOST_READY ".length));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) ready.pairing = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length));
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          reject(new Error("pi-host failed: " + line + "\n" + stderr.slice(-2_000)));
        }
      }
      if (ready.info && ready.pairing) {
        clearTimeout(timer);
        resolveReady(ready);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi-host exited early code=${code}\n${stderr.slice(-2_000)}`));
    });
  });
}

async function stopHost() {
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolveExit) => {
    proc.once("exit", resolveExit);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
  });
}

let exitCode = 0;
const sink = await webhookSinkFixture();
const bot = await botFixture();
const model = await relayModelFixture();
let ownerClient = null;
let sessionId = null;

try {
  // -------------------------------------------------------------------------
  // Configure the Host the way its own users do: through host-core's own call
  // path, before the Host starts. The channels' records, the bot credential and
  // the conversation-to-session binding all ride surfaces the Host already has.
  // -------------------------------------------------------------------------
  const seed = new Host(hostBin, dataDir);
  await seed.start();
  await seed.call("workspace.set", { path: project });
  const { provider } = await seed.call("providers.create", {
    name: "Relay fixture model",
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl: model.baseUrl,
    authKind: "none",
    defaultModelId: "relay-fixture",
    apiStyle: "chat_completions",
  });
  const created = await seed.call("session.create", {
    title: "Relay E2E session",
    mode: "agent",
    projectPath: project,
  });
  sessionId = created.session.id;
  // `ask` is the mode that makes host-core leave a high-risk tool call pending.
  await seed.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "ask" });
  await seed.call("settings.set", {
    language: "en",
    defaultProviderId: provider.id,
    defaultModelId: "relay-fixture",
    defaultMode: "agent",
    defaultPermissionMode: "ask",
    messagingWebhook: {
      format: "pi-desktop-messaging-webhook",
      version: 1,
      endpoint: sink.endpoint,
      requestTimeoutMs: 5_000,
    },
    messagingTelegram: {
      format: MESSAGING_TELEGRAM_FORMAT,
      version: 1,
      endpoint: bot.endpoint,
      destination: LINKED_CHAT,
      requestTimeoutMs: 5_000,
      inbound: {
        linkedPrincipal: { subject: LINKED_PRINCIPAL, roles: [...LINKED_ROLES] },
        permissionMode: "ask",
      },
    },
  });
  await seed.call("secrets.set", { secretRef: MESSAGING_TELEGRAM_BOT_TOKEN_SECRET_REF, value: BOT_TOKEN });
  bot.setToken(BOT_TOKEN);
  // The production writer of the conversation-to-session binding, on the host's
  // internal call path: it also records the session's owner, which is what lets
  // the linked principal reach it at all.
  const surface = createHostSettingsSurface(() => seed);
  await bindMessagingInboundSession(
    surface,
    sessionId,
    createHostSessionOwnerWriter(() => seed),
    TELEGRAM_INBOUND_CHANNEL,
  );
  const row = await surface.read();
  const bound = (await seed.call("session.get", { id: sessionId })).session;
  record(
    "linked-chat-is-bound-to-the-session",
    row.messagingTelegram?.inbound?.sessionId === sessionId && bound.owner === LINKED_PRINCIPAL,
    shortJson({ boundSession: row.messagingTelegram?.inbound?.sessionId, owner: bound.owner }),
  );
  await seed.stop();

  // -------------------------------------------------------------------------
  // Boot the real headless Host and pair a device over the loopback RACP socket.
  // -------------------------------------------------------------------------
  const ready = await startHost();
  record(
    "host-boots-on-loopback",
    ready.info.host === "127.0.0.1" && ready.info.port > 0,
    shortJson(ready.info),
  );
  const url = `ws://127.0.0.1:${ready.info.port}/v1/racp/ws`;
  const pairing = new RacpClient({
    transport: wsClientTransport({ url, token: ready.pairing.token }),
    client: { name: "pi-host-e2e", version: "0.20.0" },
    onEvent: () => {},
    requestTimeoutMs: 60_000,
  });
  await pairing.connect();
  const paired = await pairing.request("connection/pair", { deviceLabel: "e2e messaging relay" });
  await pairing.close();

  const events = [];
  ownerClient = new RacpClient({
    transport: wsClientTransport({ url, token: paired.deviceToken }),
    client: { name: "pi-host-e2e", version: "0.20.0" },
    onEvent: (envelope) => events.push(envelope),
    onStateChange: (state, error) => trace(`racp ${state} ${error?.message ?? ""}`),
    requestTimeoutMs: 60_000,
  });
  await ownerClient.connect();
  await ownerClient.request("events/subscribe", { scope: "host" });
  // The relay subscribed the channels the Host has records for: both of them.
  record(
    "host-subscribed-the-configured-outbound-channels",
    await pollUntil(async () => {
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      return ["webhook", "telegram"].every((channel) =>
        log.includes(`"message":"outbound messaging relay subscribed","data":{"channel":"${channel}"`),
      );
    }, { timeoutMs: 30_000, label: "the outbound relay to subscribe both channels" }),
  );

  const attach = () => ownerClient.request("session/attach", { sessionId });
  const idle = async () => {
    const snapshot = (await attach()).snapshot;
    return snapshot.activeTurn ? false : snapshot;
  };
  let turnSeq = 0;
  async function startTurn(text) {
    turnSeq += 1;
    trace(`turn/start ${turnSeq} (${text.slice(0, 40)})`);
    const running = await ownerClient.request("turn/start", {
      sessionId,
      input: { text },
      context: { requestId: `e2e-232-${turnSeq}`, idempotencyKey: `e2e-232-${turnSeq}` },
    });
    const turnId = running.turn?.id;
    assert(typeof turnId === "string" && turnId, "turn/start returned a turn id: " + shortJson(running));
    trace(`turn ${turnId} started`);
    return turnId;
  }
  const envelopesAtSink = () => sink.envelopes();
  const envelopesAtBot = () => bot.envelopes();
  const summaryFor = (envelopes, kind, turnId) =>
    envelopes.find((envelope) => envelope.summary?.kind === kind && envelope.summary?.turnId === turnId);

  // -------------------------------------------------------------------------
  // Step 1: run a turn to completion.
  // -------------------------------------------------------------------------
  const firstTurn = await startTurn("please complete this turn");
  await pollUntil(idle, { timeoutMs: 60_000, label: `turn ${firstTurn} to settle` });
  const firstCompletion = await pollUntil(
    () => {
      const sinkHit = summaryFor(envelopesAtSink(), "turn.completed", firstTurn);
      const botHit = summaryFor(envelopesAtBot(), "turn.completed", firstTurn);
      return sinkHit && botHit ? { sinkHit, botHit } : false;
    },
    { timeoutMs: 180_000, intervalMs: 500, label: `the completion of turn ${firstTurn} at the sink and the bot` },
  );
  record(
    "turn-completion-is-relayed-to-the-sink-and-the-bot",
    firstCompletion.sinkHit.summary.status === "completed" && firstCompletion.botHit.summary.status === "completed",
    shortJson({ sink: firstCompletion.sinkHit.summary, botChat: firstCompletion.botHit.chatId }),
  );

  // -------------------------------------------------------------------------
  // Step 2: start a turn that raises a tool approval and leave it pending.
  // -------------------------------------------------------------------------
  const approvalTurn = await startTurn("RAISE_APPROVAL");
  const pending = await pollUntil(
    async () => {
      const snapshot = (await attach()).snapshot;
      return snapshot.pendingApprovals?.length ? snapshot.pendingApprovals[0] : false;
    },
    { timeoutMs: 60_000, intervalMs: 250, label: `turn ${approvalTurn} to raise a pending approval` },
  );
  record("approval-turn-raises-pending-approval", Boolean(pending.id), shortJson(pending));
  const approvalRelay = await pollUntil(
    () => {
      const sinkHit = summaryFor(envelopesAtSink(), "approval.requested", approvalTurn);
      const botHit = summaryFor(envelopesAtBot(), "approval.requested", approvalTurn);
      return sinkHit && botHit ? { sinkHit, botHit } : false;
    },
    { timeoutMs: 180_000, intervalMs: 500, label: `approval.requested of turn ${approvalTurn} at the sink and the bot` },
  );
  record(
    "approval-request-is-relayed-to-the-sink-and-the-bot",
    approvalRelay.sinkHit.summary.status === undefined && approvalRelay.botHit.summary.sessionId === sessionId,
    shortJson(approvalRelay.sinkHit.summary),
  );

  // -------------------------------------------------------------------------
  // Step 3: send the stop command from the linked chat during the running turn.
  // The turn is the one just started; it is live in the Host (waiting on the
  // approval) and the stop is a graceful one, so it ends at the turn's next
  // boundary. The test drives that boundary by resolving the pending approval
  // — the same decision a client would make — instead of waiting out the
  // permission's own 120s timeout.
  // -------------------------------------------------------------------------
  const stopUpdate = bot.push(LINKED_CHAT, STOP_COMMAND);
  const stopMessageId = String(stopUpdate.message.message_id);
  const stopOperation = await pollUntil(
    () => hostAudit().find((entry) => entry.kind === "operation" && entry.messageId === stopMessageId),
    { timeoutMs: 60_000, intervalMs: 250, label: "the linked chat's stop to be audited as an operation" },
  );
  const stopFailure = hostAudit().find(
    (entry) => entry.kind === "operation-failed" && entry.messageId === stopMessageId,
  );
  record(
    "linked-stop-maps-to-turn-stop",
    stopOperation.operation === "turn/stop" && !stopFailure && LINKED_ROLES.includes("controller"),
    shortJson({ audit: stopOperation, failed: stopFailure ?? null, roles: LINKED_ROLES }),
  );
  await ownerClient.request("approval/respond", {
    approvalId: pending.id,
    decision: "deny",
    context: { requestId: "e2e-232-approval-deny" },
  });
  const stoppedTurn = await pollUntil(
    async () => {
      const snapshot = (await attach()).snapshot;
      return snapshot.activeTurn ? false : snapshot.session.activeTurnId ? false : true;
    },
    { timeoutMs: 60_000, intervalMs: 250, label: `turn ${approvalTurn} to end at the next boundary` },
  );
  record("linked-stop-ends-the-turn", stoppedTurn === true, `turn ${approvalTurn} is no longer the session's active turn`);

  // -------------------------------------------------------------------------
  // Step 4: send the same command from the unlinked chat.
  // -------------------------------------------------------------------------
  const unlinkedBefore = (await attach()).snapshot;
  const unlinkedUpdate = bot.push(UNLINKED_CHAT, STOP_COMMAND);
  const unlinkedMessageId = String(unlinkedUpdate.message.message_id);
  const unlinkedAudit = await pollUntil(
    () =>
      hostAudit().find(
        (entry) => entry.kind === "unlinked-chat" && entry.chatId === UNLINKED_CHAT && entry.messageId === unlinkedMessageId,
      ),
    { timeoutMs: 60_000, intervalMs: 250, label: "the unlinked chat's command to be audited" },
  );
  record("unlinked-command-is-audited", unlinkedAudit.chatId === UNLINKED_CHAT, shortJson(unlinkedAudit));
  // No operation, no failure, and no turn: the command had no effect anywhere.
  // Then let a further poll cycle pass so a late effect would be caught.
  await new Promise((done) => setTimeout(done, at(3)));
  const unlinkedAfter = (await attach()).snapshot;
  const unlinkedOperations = hostAudit().filter(
    (entry) =>
      entry.messageId === unlinkedMessageId &&
      (entry.kind === "operation" || entry.kind === "operation-failed" || entry.kind === "refused"),
  );
  record(
    "unlinked-command-has-no-effect",
    unlinkedOperations.length === 0 &&
      !unlinkedAfter.activeTurn &&
      !unlinkedBefore.activeTurn &&
      unlinkedAfter.session.id === unlinkedBefore.session.id,
    shortJson({ operations: unlinkedOperations, activeTurn: unlinkedAfter.activeTurn ?? null }),
  );

  // -------------------------------------------------------------------------
  // Step 5: the sink returns errors, then recovers. The errors are driven by
  // the sink's own status, not by waiting a real minute; the delivery's retry
  // is the ledger's, observed at the sink as a redelivery of the same id.
  // -------------------------------------------------------------------------
  sink.setStatus(503);
  const errorTurnStarted = Date.now();
  const errorTurn = await startTurn("please complete this turn while the sink is failing");
  await pollUntil(idle, { timeoutMs: 60_000, label: `turn ${errorTurn} to settle while the sink fails` });
  const errorTurnElapsed = Date.now() - errorTurnStarted;
  const failedAttempt = await pollUntil(
    () => sink.envelopes().find((envelope) => envelope.summary?.turnId === errorTurn && envelope.summary?.kind === "turn.completed"),
    { timeoutMs: 240_000, intervalMs: 500, label: `the failing delivery of turn ${errorTurn} to reach the sink` },
  );
  const failedRequests = () =>
    sink.requests().filter((entry) => (JSON.parse(entry.body).summary ?? {}).turnId === errorTurn);
  record(
    "delivery-failure-does-not-delay-the-turn",
    errorTurnElapsed < 12_000,
    `turn settled in ${errorTurnElapsed}ms while the sink answered 503 (first attempt: ${failedAttempt.summary.kind})`,
  );
  const redelivery = await pollUntil(
    () => failedRequests().find((entry) => JSON.parse(entry.body).redelivery === true),
    { timeoutMs: 240_000, intervalMs: 500, label: `a retry of the failed delivery for turn ${errorTurn}` },
  );
  record(
    "failed-delivery-is-retried-within-the-bound",
    JSON.parse(redelivery.body).deliveryId === JSON.parse(failedRequests()[0].body).deliveryId &&
      failedRequests().length <= DELIVERY_MAX_ATTEMPTS,
    shortJson({
      deliveryId: JSON.parse(redelivery.body).deliveryId,
      attempts: failedRequests().length,
      bound: DELIVERY_MAX_ATTEMPTS,
      answers: failedRequests().map((entry) => entry.answered),
    }),
  );
  const attemptsBeforeRecovery = failedRequests().length;
  sink.setStatus(200);
  const recovered = await pollUntil(
    () => failedRequests().slice(attemptsBeforeRecovery).find((entry) => entry.answered === 200),
    { timeoutMs: 240_000, intervalMs: 500, label: "the delivery to be accepted after the sink recovered" },
  );
  record(
    "failed-delivery-recovers-after-the-sink-recovers",
    JSON.parse(recovered.body).deliveryId === JSON.parse(redelivery.body).deliveryId &&
      failedRequests().length <= DELIVERY_MAX_ATTEMPTS,
    shortJson({ attempts: failedRequests().length, answered: recovered.answered }),
  );

  // -------------------------------------------------------------------------
  // Step 6: inspect every payload delivered to either receiver.
  // -------------------------------------------------------------------------
  const sinkEnvelopes = sink.envelopes();
  const botEnvelopes = bot.envelopes();
  const delivered = [...sinkEnvelopes, ...botEnvelopes];
  record("both-receivers-were-sent-payloads", sinkEnvelopes.length >= 4 && botEnvelopes.length >= 3, shortJson({ sink: sinkEnvelopes.length, bot: botEnvelopes.length }));

  const payloadFailures = [];
  for (const envelope of delivered) {
    const keys = Object.keys(envelope);
    for (const key of keys) {
      if (!ENVELOPE_KEYS.has(key)) payloadFailures.push(`envelope key ${key}: ${shortJson(envelope)}`);
    }
    const summary = envelope.summary;
    if (!summary || typeof summary !== "object") {
      payloadFailures.push(`no summary: ${shortJson(envelope)}`);
      continue;
    }
    for (const key of Object.keys(summary)) {
      if (!SUMMARY_KEYS.has(key)) payloadFailures.push(`summary key ${key}: ${shortJson(summary)}`);
    }
    // Ids and timestamps only: a string summary value is a bounded token.
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === "string" && value.length > 128) payloadFailures.push(`unbounded ${key}: ${shortJson(summary)}`);
      if (typeof value === "number" && !Number.isFinite(value)) payloadFailures.push(`non-finite ${key}`);
    }
    if (!summary.eventId || !summary.epoch || !summary.occurredAt) payloadFailures.push(`missing ids: ${shortJson(summary)}`);
    if (typeof summary.revision !== "number") payloadFailures.push(`no revision: ${shortJson(summary)}`);
    if (JSON.stringify(summary).length > SUMMARY_MAX_CHARS) payloadFailures.push(`summary too long: ${shortJson(summary)}`);
    // The sentinel lives only in transcript-bearing content.
    if (JSON.stringify(envelope).includes(SENTINEL)) payloadFailures.push(`sentinel leaked: ${shortJson(envelope)}`);
  }
  const kindsAtSink = new Set(sinkEnvelopes.map((envelope) => envelope.summary?.kind));
  const kindsAtBot = new Set(botEnvelopes.map((envelope) => envelope.summary?.kind));
  const summaryIdsMatch = delivered.every(
    (envelope) => envelope.summary.sessionId === sessionId || envelope.summary.scope === "host",
  );
  record(
    "payloads-carry-ids-and-bounded-summary-only",
    payloadFailures.length === 0 &&
      kindsAtSink.has("turn.completed") &&
      kindsAtSink.has("approval.requested") &&
      kindsAtBot.has("turn.completed") &&
      kindsAtBot.has("approval.requested") &&
      summaryIdsMatch,
    shortJson({
      sinkKinds: [...kindsAtSink],
      botKinds: [...kindsAtBot],
      delivered: delivered.length,
      failures: payloadFailures,
    }),
  );

  // -------------------------------------------------------------------------
  // The Host opened no listener: every listening socket in the Host's process
  // tree is the one RACP loopback port the Host itself announced.
  // -------------------------------------------------------------------------
  const listeners = hostListeners(child.pid);
  const loopback = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);
  record(
    "host-opens-no-listener",
    listeners.length > 0 &&
      listeners.every((entry) => loopback.has(entry.address) && entry.port === ready.info.port),
    shortJson({ announced: ready.info.port, listeners }),
  );

  await ownerClient.close();
  ownerClient = null;
} catch (error) {
  record(
    "headless-messaging-relay-e2e",
    false,
    `${error?.stack ?? error?.message ?? error}\nreceivers: ${shortJson({
      sinkRequests: sink.requests().length,
      botDeliveries: bot.delivered().length,
    })}\nmodel calls: ${shortJson(model.describe())}\n${stderr.slice(-3_000)}`,
  );
} finally {
  try {
    await ownerClient?.close();
  } catch {
    // The socket is going away with the process either way.
  }
  await stopHost();
  sink.close();
  bot.close();
  model.close();
  if (process.env.PI_RELAY_KEEP === "1") {
    console.log(`kept data dir: ${dataDir}`);
  } else {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) exitCode = 1;
process.exit(exitCode);
