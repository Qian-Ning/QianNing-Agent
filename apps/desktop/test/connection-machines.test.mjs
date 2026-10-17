/**
 * The merge point between the two layers of a machine.
 *
 * These are the decisions that make Connections one surface instead of two: how
 * a target finds its runtime, what a card says when the runtime is missing or
 * the list could not be read, and what a single delete removes. They are pure
 * functions, so the join is asserted directly rather than through the DOM.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addressOf,
  hostBelongsToProfile,
  hostKeyFor,
  hostLinkKey,
  hostLinkOf,
  hostLinkTone,
  installAuthOf,
  installRequestFor,
  machineRows,
  removalPlan,
} from "../src/lib/connection-machines.ts";

let nextId = 0;

function profile(overrides = {}) {
  nextId += 1;
  return {
    id: `p${nextId}`,
    label: `target ${nextId}`,
    kind: "ssh",
    enabled: true,
    target: { kind: "ssh", host: "box.example", port: 22 },
    credentialConfigured: false,
    hostKeyPolicy: "accept-new",
    hostKeyFingerprint: null,
    multiplex: "per-call",
    limits: { timeoutMs: 1000, outputBytes: 1000, streamBytes: 1000 },
    lastProbe: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function host(overrides = {}) {
  return {
    hostKey: "h1",
    label: "host",
    url: "ws://127.0.0.1:7000",
    connected: false,
    transport: "ssh",
    ...overrides,
  };
}

test("a host key is stable, colon-free and derived from the profile", () => {
  assert.equal(hostKeyFor({ id: "abc-123" }), "conn-abc-123");
  assert.equal(hostKeyFor({ id: "a:b/c" }), "conn-a-b-c");
  assert.equal(hostKeyFor({ id: ":::" }), "conn-target");
  assert.equal(hostKeyFor({ id: "same" }), hostKeyFor({ id: "same" }));
});

test("a profile's address is its SSH descriptor", () => {
  assert.deepEqual(addressOf(profile({ target: { kind: "ssh", host: "a", port: 2222, user: "me" } })), {
    host: "a",
    port: 2222,
    user: "me",
  });
  assert.equal(addressOf(profile({ target: { kind: "raw-tcp", host: "a", port: 1 } })), null);
});

test("a target finds its runtime by minted key or by address", () => {
  const target = profile({ target: { kind: "ssh", host: "Box.Example", port: 22, user: "root" } });

  // Minted key: the link survives an address edit.
  assert.equal(
    hostBelongsToProfile(target, host({ hostKey: hostKeyFor(target), ssh: { host: "elsewhere", port: 22, remotePort: 1, version: "1" } })),
    true,
  );

  // Address: case-insensitive host, and a record with no port means 22.
  assert.equal(
    hostBelongsToProfile(
      target,
      host({ ssh: { host: "box.example", user: "root", remotePort: 1, version: "1" } }),
    ),
    true,
  );

  assert.equal(
    hostBelongsToProfile(
      target,
      host({ ssh: { host: "box.example", port: 2222, user: "root", remotePort: 1, version: "1" } }),
    ),
    false,
    "a different port is a different machine",
  );

  assert.equal(
    hostBelongsToProfile(
      target,
      host({ ssh: { host: "box.example", port: 22, user: "other", remotePort: 1, version: "1" } }),
    ),
    false,
    "a different login is a different runtime",
  );

  // One side without a user still means the same machine: absent = local login.
  assert.equal(
    hostBelongsToProfile(
      profile({ target: { kind: "ssh", host: "box.example", port: 22 } }),
      host({ ssh: { host: "box.example", user: "root", remotePort: 1, version: "1" } }),
    ),
    true,
  );

  // A direct host has no descriptor and no minted key: it cannot be claimed.
  assert.equal(
    hostBelongsToProfile(target, host({ hostKey: "direct", transport: "direct", ssh: undefined })),
    false,
  );
});

test("rows pair one host with one target and keep every host visible", () => {
  const first = profile({ id: "one", target: { kind: "ssh", host: "a", port: 22 } });
  const second = profile({ id: "two", target: { kind: "ssh", host: "a", port: 22 } });
  const third = profile({ id: "three", target: { kind: "ssh", host: "c", port: 22 } });
  const shared = host({ hostKey: "shared", ssh: { host: "a", port: 22, remotePort: 1, version: "1" } });
  const orphan = host({ hostKey: "orphan", label: "paired", url: "wss://x", ssh: undefined });

  const rows = machineRows([first, second, third], [shared, orphan]);

  assert.deepEqual(
    rows.map((row) => [row.key, row.host?.hostKey ?? null, row.hostOnly]),
    [
      ["one", "shared", false],
      ["two", null, false],
      ["three", null, false],
      ["host:orphan", "orphan", true],
    ],
  );
  assert.equal(rows[0].profile, first, "profile order is preserved");
});

test("a paired runtime with no target is still a row", () => {
  const rows = machineRows([], [host({ hostKey: "p", label: "laptop" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hostOnly, true);
  assert.equal(rows[0].key, "host:p");
  assert.equal(rows[0].profile, undefined);
});

test("the card's link state prefers the live push, then the snapshot", () => {
  const record = host({ connected: true });
  assert.equal(hostLinkOf(undefined, undefined), "not-installed");
  assert.equal(hostLinkOf(undefined, undefined, true), "unknown");
  assert.equal(hostLinkOf(record, undefined), "connected");
  assert.equal(hostLinkOf(host({ connected: true }), "failed"), "failed");
  assert.equal(hostLinkOf(host({ connected: true }), "reconnecting"), "reconnecting");
  assert.equal(hostLinkOf(host({ connected: false }), undefined), "disconnected");
});

test("every link state has its own label and only actionable ones warn", () => {
  const keys = [
    "connected",
    "connecting",
    "reconnecting",
    "disconnected",
    "failed",
    "not-installed",
    "unknown",
  ].map((state) => hostLinkKey(state));
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^connections\.host/);
  assert.equal(hostLinkTone("failed"), "warning");
  assert.equal(hostLinkTone("unknown"), "warning");
  assert.equal(hostLinkTone("connected"), undefined);
  assert.equal(hostLinkTone("not-installed"), undefined);
});

test("one delete reports both halves of the machine", () => {
  const target = profile({ id: "x" });
  const record = host({ hostKey: "k" });
  assert.deepEqual(removalPlan({ key: "x", profile: target, host: record, hostOnly: false }), {
    target: true,
    host: true,
  });
  assert.deepEqual(removalPlan({ key: "x", profile: target, hostOnly: false }), {
    target: true,
    host: false,
  });
  assert.deepEqual(removalPlan({ key: "host:k", host: record, hostOnly: true }), {
    target: false,
    host: true,
  });
});

test("the install request is the target's own address", () => {
  const plain = profile({
    label: "web",
    target: { kind: "ssh", host: "  box.example ", port: 2222, user: "deploy" },
  });
  const request = installRequestFor(plain);
  assert.deepEqual(request, {
    label: "web",
    host: "box.example",
    port: 2222,
    user: "deploy",
    hostKey: hostKeyFor(plain),
  });
  assert.equal(installAuthOf(plain), "agent");
  assert.equal("password" in request, false);

  const key = profile({
    target: {
      kind: "ssh",
      host: "box.example",
      port: 22,
      identityFile: "/home/me/.ssh/id_ed25519",
    },
  });
  assert.equal(installAuthOf(key), "key");
  assert.equal(installRequestFor(key).identityFile, "/home/me/.ssh/id_ed25519");

  const password = profile({
    credentialConfigured: true,
    target: { kind: "ssh", host: "box.example", port: 22 },
  });
  assert.equal(installAuthOf(password), "password");
  assert.equal("password" in installRequestFor(password), false, "nothing typed, nothing sent");
  assert.equal(installRequestFor(password, "  s3cret  ").password, "s3cret");

  assert.throws(() =>
    installRequestFor(profile({ target: { kind: "telnet", host: "a", port: 23 } })),
  );
});
