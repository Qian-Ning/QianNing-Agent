/**
 * The media workbench, against a real HTTP fixture.
 *
 * These tests exist because the workbench adds exactly three things the Agent
 * tools do not have, and each one is a way to spend the user's money wrongly if
 * it breaks: a model chosen per request, parameters that must reach the provider
 * unchanged, and per-item progress. Everything else — containment, credentials,
 * download rules — is the tool path, covered by the tool tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { MAX_WORKBENCH_COUNT, clampCount, normalizeCount } = await import(
  "../src/features/workbench/presets.ts"
);
const { createMediaWorkbenchService, resolveGeneratedFile } = await import(
  "../electron/main/services/media-workbench-service.ts"
);
const { appendMediaLibrary, libraryEntryFrom, readMediaLibrary } = await import(
  "../electron/main/services/media-library.ts"
);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);
/** `ftyp` at offset 4 is what the container sniffer checks. */
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.from([0, 0, 2, 0]),
  Buffer.alloc(64, 9),
]);
const pngBase64 = png.toString("base64");

/**
 * One fixture covering both capabilities.
 *
 * `holdCreates` parks every create call until `release()` runs. A local fixture
 * answers in microseconds, so without a gate a four-clip batch finishes before a
 * test could ever cancel it; with one, "what was in flight when the user stopped
 * it" is deterministic.
 */
function startServer() {
  const requests = [];
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let hold = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("latin1");
    requests.push({
      url: request.url,
      method: request.method,
      body,
      contentType: String(request.headers["content-type"] ?? ""),
      authorization: String(request.headers.authorization ?? ""),
    });
    const port = server.address().port;
    if (request.method === "POST" && request.url === "/v1/videos") {
      if (hold) await gate;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: `job-${requests.length}`, status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/v1/videos/")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ status: "completed", url: `http://127.0.0.1:${port}/clip.mp4` }),
      );
      return;
    }
    if (request.url === "/clip.mp4") {
      response.setHeader("Content-Type", "video/mp4");
      response.end(mp4);
      return;
    }
    if (
      request.method === "POST" &&
      (request.url === "/v1/images/generations" || request.url === "/v1/images/edits")
    ) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  return {
    server,
    requests,
    holdCreates() {
      hold = true;
    },
    release() {
      release();
    },
  };
}

async function makeEnv(t, options = {}) {
  const fixture = startServer();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "workbench-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const scratch = join(dataDir, "scratch", "session");
  await mkdir(scratch, { recursive: true });
  const baseUrl = `http://127.0.0.1:${fixture.server.address().port}`;
  const provider = {
    id: "provider-one",
    enabled: options.enabled ?? true,
    authKind: options.authKind ?? "api_key_and_base_url",
    models: (options.models ?? ["video-one", "video-two", "img-one", "img-two"]).map((id) => ({
      id,
    })),
    baseUrl,
  };
  const host = {
    call: async (method) => {
      if (method === "settings.get") return options.settings ?? {};
      if (method === "providers.get") return { provider };
      if (method === "providers.getSecret") return { value: "fixture-key" };
      if (method === "session.getScratchPath") return { path: scratch };
      if (method === "session.get") return { session: {} };
      throw new Error(`unexpected host call ${method}`);
    },
  };
  const events = [];
  return {
    fixture,
    scratch,
    dataDir,
    events,
    host,
    baseUrl,
    service: createMediaWorkbenchService({
      dataDir,
      getHost: () => host,
      emit: (event) => events.push(event),
    }),
    providerId: provider.id,
  };
}

/**
 * Wait for an observable fact, and fail loudly if it never arrives.
 *
 * A fixed sleep cannot prove the run has reached the state a test needs: on a
 * machine running the whole suite in parallel the sleep can elapse first, so the
 * test cancels a run that had not yet put a clip in flight and then asserts
 * against a state the run never reached. Polling for the fact itself makes the
 * precondition deterministic, and the deadline turns "the run never got there"
 * into a named failure instead of a silent race.
 */
async function waitFor(predicate, description, { timeoutMs = 15_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** How many create requests the fixture has actually received and is holding. */
function heldCreates(fixture) {
  return fixture.requests.filter((entry) => entry.url === "/v1/videos").length;
}

/** Two clips are truly in flight once two workers reported running AND parked at the gate. */
function twoClipsInFlight(env) {
  const running = env.events.filter((event) => event.item?.status === "running").length;
  return heldCreates(env.fixture) >= 2 && running >= 2 && env.events.every((event) => event.total === 4);
}

test("image: the chosen model and size reach the provider, and items report progress", async (t) => {
  const env = await makeEnv(t, { models: ["img-two"] });

  const result = await env.service.generate({
    capability: "image",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "img-two" },
    input: { items: [{ prompt: "a paper lantern", count: 2, size: "1536x1024" }] },
  });

  const posts = env.fixture.requests.filter((entry) => entry.url === "/v1/images/generations");
  assert.equal(posts.length, 2, "one request per requested image");
  for (const post of posts) {
    assert.match(post.body, /"model":"img-two"/, "the picked model is what runs");
    assert.match(post.body, /"size":"1536x1024"/, "the requested size is sent unchanged");
    assert.equal(post.authorization, "Bearer fixture-key");
  }

  assert.equal(result.ok, true);
  assert.equal(result.modelId, "img-two");
  assert.equal(result.results.length, 2);
  for (const item of result.results) {
    assert.equal(item.status, "succeeded");
    assert.deepEqual(
      [...(await readFile(item.path)).subarray(0, 4)],
      [0x89, 0x50, 0x4e, 0x47],
      "the saved file is the png the provider returned",
    );
  }

  const phases = env.events.map((event) => event.phase);
  assert.equal(phases[0], "submitting");
  assert.equal(phases.at(-1), "done");
  assert.equal(env.events.at(-1).completed, 2);
  assert.equal(env.events.at(-1).total, 2);
  const announced = env.events
    .filter((event) => event.item)
    .map((event) => `${event.item.index}:${event.item.status}`)
    .sort();
  assert.deepEqual(announced, ["0:running", "0:succeeded", "1:running", "1:succeeded"]);
});

test("image: a reference image goes to the edits endpoint", async (t) => {
  const env = await makeEnv(t, { models: ["img-one"] });
  const reference = join(env.scratch, "reference.png");
  await writeFile(reference, png);

  const result = await env.service.generate({
    capability: "image",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "img-one" },
    input: { items: [{ prompt: "keep the shape", images: [reference], size: "1024x1024" }] },
  });

  assert.equal(result.ok, true);
  const edits = env.fixture.requests.filter((entry) => entry.url === "/v1/images/edits");
  assert.equal(edits.length, 1, "a reference image routes to edits");
  assert.match(edits[0].contentType, /multipart\/form-data/);
  assert.match(edits[0].body, /name="image"/);
  assert.match(edits[0].body, /name="size"/);
  assert.match(edits[0].body, /1024x1024/);
});

test("video: first and last frame use the configured multipart field names", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"] });
  const first = join(env.scratch, "first.png");
  const last = join(env.scratch, "last.png");
  await writeFile(first, png);
  await writeFile(last, png);

  const result = await env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "video-one" },
    frames: { first: "start_image", last: "end_image" },
    input: {
      items: [
        {
          prompt: "a slow pan across a harbour",
          image: first,
          lastFrame: last,
          durationSeconds: 6,
          size: "1280x720",
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  const creates = env.fixture.requests.filter((entry) => entry.url === "/v1/videos");
  assert.equal(creates.length, 1);
  assert.match(creates[0].contentType, /multipart\/form-data/);
  assert.match(creates[0].body, /name="start_image"/, "the first frame uses the chosen field");
  assert.match(creates[0].body, /name="end_image"/, "the last frame uses the chosen field");
  assert.match(creates[0].body, /name="seconds"/);
  assert.match(creates[0].body, /name="size"/);
  assert.match(creates[0].body, /1280x720/);
  assert.equal(result.results[0].status, "succeeded");
  assert.equal(result.results[0].durationSeconds, 6);
  assert.deepEqual(
    [...(await readFile(result.results[0].path)).subarray(4, 8)],
    [...Buffer.from("ftyp")],
    "the saved file is the mp4 the provider returned",
  );
});

test("video: a last frame without a first frame is refused before anything is sent", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"] });
  const last = join(env.scratch, "last.png");
  await writeFile(last, png);

  const result = await env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "video-one" },
    input: { items: [{ prompt: "no anchor", lastFrame: last }] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "INVALID_ARGUMENT");
  assert.equal(env.fixture.requests.length, 0);
});

test("video: a model the provider does not list is refused before anything is sent", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"] });

  const result = await env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "ghost-model" },
    input: { items: [{ prompt: "never runs" }] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "VIDEO_MODEL_UNAVAILABLE");
  assert.match(result.message ?? "", /not available from that service/);
  assert.equal(env.fixture.requests.length, 0, "a refused model never reaches the provider");
});

test("video: an OAuth provider cannot be used for generation", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"], authKind: "oauth" });

  const result = await env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "video-one" },
    input: { items: [{ prompt: "never runs" }] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "VIDEO_AUTH_UNSUPPORTED");
});

test("video: cancelling a run stops the clips it has not started", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"] });

  env.fixture.holdCreates();
  const pending = env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "video-one" },
    input: { items: [{ prompt: "hold", count: 4 }] },
  });
  // The gate parks each create call, so once the fixture holds both creates and
  // both workers have reported running, two clips are truly in flight and two
  // have not started — wait for that fact instead of sleeping, which a loaded
  // parallel run can outrun before either worker has reached the gate.
  await waitFor(() => twoClipsInFlight(env), "two clips in flight and the plan expanded to four");
  const id = env.events.at(-1)?.generationId ?? "";
  assert.ok(id, "the run reports progress under its id");
  assert.equal(env.service.cancel(id), true);
  env.fixture.release();

  const result = await pending;
  assert.equal(result.ok, false);
  const succeeded = result.results.filter((item) => item.status === "succeeded");
  assert.equal(
    succeeded.length,
    0,
    `an aborted run must not report a finished clip: ${JSON.stringify(result.results)}`,
  );
  assert.equal(result.results.length, 4, "every requested clip is accounted for");
  for (const item of result.results) {
    assert.equal(item.status, "cancelled", JSON.stringify(item));
    assert.equal(item.errorCode, "VIDEO_CANCELLED");
  }
});

test("files: a render can be handed out only from the session that wrote it", async (t) => {
  const env = await makeEnv(t);
  const inside = join(env.scratch, "generated-one.png");
  await writeFile(inside, "render");
  const outsider = join(env.dataDir, "settings.json");
  await writeFile(outsider, "{}");

  const resolve = (target) =>
    resolveGeneratedFile({ dataDir: env.dataDir, scratchPath: env.scratch, target });

  assert.equal(await resolve(inside), await realpath(inside), "a file this session wrote is handed out");
  assert.equal(await resolve(outsider), null, "a sibling of the scratch root is refused");
  assert.equal(
    await resolve(join(env.scratch, "..", "..", "settings.json")),
    null,
    "traversal out of the scratch root is refused",
  );
  assert.equal(await resolve(env.scratch), null, "a directory is not a render");
  assert.equal(await resolve(join(env.scratch, "absent.png")), null, "a missing file is refused");
  assert.equal(
    await resolveGeneratedFile({ dataDir: env.dataDir, scratchPath: outsider, target: inside }),
    null,
    "a session directory outside the scratch root is refused",
  );
});

test("count: only a whole number from 1 to the cap is accepted", () => {
  assert.equal(MAX_WORKBENCH_COUNT, 4);
  assert.equal(normalizeCount("1"), 1);
  assert.equal(normalizeCount("4"), 4);
  for (const wrong of ["0", "5", "-2", "1.5", "2x", "two", "", "   ", "١"]) {
    assert.equal(normalizeCount(wrong), null, `"${wrong}" is refused rather than reinterpreted`);
  }
  assert.equal(clampCount(0), 1, "a settled field never lands below one");
  assert.equal(clampCount(9), 4, "a settled field never lands above the cap");
  assert.equal(clampCount(3), 3);
});

test("ipc: generating with no session is accepted, because the render is the app's", async (t) => {
  const env = await makeEnv(t, { models: ["img-one"] });
  const { registerWorkbenchIpc } = await import("../electron/main/ipc/workbench-ipc.ts");
  const { IPC } = await import("@pi-desktop/shared/protocol");

  const handlers = new Map();
  registerWorkbenchIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getMainWindow: () => null,
    getHost: () => env.host,
    dataDir: env.dataDir,
  });

  const generate = handlers.get(IPC.invoke.workbenchGenerate);
  assert.ok(generate, "the generate channel is registered");

  // Exactly what the page sends when the user has no conversation open.
  const result = await generate({
    capability: "image",
    sessionId: "",
    model: { providerId: env.providerId, modelId: "img-one" },
    input: { items: [{ prompt: "a paper lantern", size: "1024x1024" }] },
  });

  assert.notEqual(
    result.errorCode,
    "INVALID_ARGUMENT",
    "a run without a session is not an argument error",
  );
  assert.equal(result.ok, true);
  assert.equal(
    env.fixture.requests.filter((entry) => entry.url === "/v1/images/generations").length,
    1,
    "the request reached the provider",
  );
});

test("library: a workbench render lands in the app library, not in a session scratch", async (t) => {
  const env = await makeEnv(t, { models: ["img-one"] });

  const result = await env.service.generate({
    capability: "image",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "img-one" },
    input: { items: [{ prompt: "a paper lantern", size: "1024x1024" }] },
  });

  assert.equal(result.ok, true);
  const library = await realpath(join(env.dataDir, "generated", "image"));
  for (const item of result.results) {
    assert.equal(item.status, "succeeded");
    const rel = relative(library, await realpath(item.path));
    assert.ok(rel && !rel.startsWith(".."), `expected a library path, got ${item.path}`);
  }
  // The chat the run came from is not where the asset lives: that directory is
  // what the old session-scoped behaviour wrote into.
  const scratchFile = relative(env.scratch, await realpath(result.results[0].path));
  assert.ok(scratchFile.startsWith(".."), "the render must not be written into session scratch");
});

test("library: a render in the library can be handed out, and nothing outside it", async (t) => {
  const env = await makeEnv(t);
  const library = join(env.dataDir, "generated", "image");
  await mkdir(library, { recursive: true });
  const asset = join(library, "generated-library.png");
  await writeFile(asset, png);

  assert.equal(
    await resolveGeneratedFile({ dataDir: env.dataDir, scratchPath: env.scratch, target: asset }),
    await realpath(asset),
    "a library render is a file the workbench may hand out",
  );
  assert.equal(
    await resolveGeneratedFile({
      dataDir: env.dataDir,
      scratchPath: env.scratch,
      target: join(env.dataDir, "settings.json"),
    }),
    null,
    "a data-directory sibling is still refused",
  );
  assert.equal(
    await resolveGeneratedFile({
      dataDir: env.dataDir,
      scratchPath: env.scratch,
      target: join(library, "..", "..", "scratch", "session", "generated-one.png"),
    }),
    null,
    "traversal back out of the library is refused",
  );
});

test("library: a cancelled run is remembered, with no file", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"] });

  env.fixture.holdCreates();
  const pending = env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "video-one" },
    input: { items: [{ prompt: "hold", count: 4 }] },
  });
  // Same precondition as the test above: stop the run only once both clips are
  // truly in flight, so what gets cancelled is a real two-in-flight run rather
  // than whatever a fixed sleep happened to reach under load.
  await waitFor(() => twoClipsInFlight(env), "two clips in flight and the plan expanded to four");
  const id = env.events.at(-1)?.generationId ?? "";
  assert.ok(id, "the run reports progress under its id");
  assert.equal(env.service.cancel(id), true);
  env.fixture.release();
  await pending;

  const entries = await readMediaLibrary(env.dataDir);
  assert.equal(entries.length, 4, "each cancelled clip is remembered, not dropped");
  for (const entry of entries) {
    assert.equal(entry.status, "cancelled");
    assert.equal(entry.errorCode, "VIDEO_CANCELLED");
    assert.equal(entry.path, undefined, "a cancelled run produced no file to point at");
  }
});

test("library: a refused run is remembered as one failure", async (t) => {
  const env = await makeEnv(t, { models: ["video-one"] });

  const result = await env.service.generate({
    capability: "video",
    sessionId: "session",
    model: { providerId: env.providerId, modelId: "ghost-model" },
    input: { items: [{ prompt: "never runs" }] },
  });
  assert.equal(result.ok, false);

  const entries = await readMediaLibrary(env.dataDir);
  assert.equal(entries.length, 1, "one entry for the run, not one per missing item");
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].errorCode, "VIDEO_MODEL_UNAVAILABLE");
  assert.equal(entries[0].prompt, "never runs");
  assert.equal(entries[0].path, undefined);
});

test("library ipc: entries can be removed, cleared and revealed through the real handlers", async (t) => {
  const env = await makeEnv(t, { models: ["img-one"] });
  const { registerWorkbenchIpc } = await import("../electron/main/ipc/workbench-ipc.ts");
  const { IPC } = await import("@pi-desktop/shared/protocol");
  // The same module the `electron` specifier is redirected to, so the spies see
  // exactly what the handlers call.
  const stub = await import("./helpers/electron-stub.mjs");
  stub.trashed.length = 0;
  stub.opened.length = 0;

  const handlers = new Map();
  registerWorkbenchIpc({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getMainWindow: () => null,
    getHost: () => env.host,
    dataDir: env.dataDir,
  });

  const library = join(env.dataDir, "generated", "image");
  await mkdir(library, { recursive: true });
  const a = join(library, "generated-ccccccc1-1111-1111-1111-111111111111.png");
  const b = join(library, "generated-ccccccc2-2222-2222-2222-222222222222.png");
  await writeFile(a, png);
  await writeFile(b, png);
  const entryA = libraryEntryFrom({ capability: "image", path: a, status: "succeeded" });
  const entryB = libraryEntryFrom({ capability: "image", path: b, status: "succeeded" });
  const failed = libraryEntryFrom({ capability: "video", status: "failed", errorCode: "VIDEO_TIMEOUT" });
  await appendMediaLibrary(env.dataDir, [entryA, entryB, failed]);

  const remove = handlers.get(IPC.invoke.workbenchLibraryRemove);
  const afterRemove = await remove({ ids: [entryA.id, failed.id] });
  assert.deepEqual(
    afterRemove.entries.map((entry) => entry.id),
    [entryB.id],
    "only the named ids are gone",
  );
  assert.deepEqual(
    stub.trashed,
    [a],
    "the succeeded file went to the trash; the failure had no file to reclaim",
  );

  const clear = handlers.get(IPC.invoke.workbenchLibraryClear);
  const emptied = await clear({});
  assert.deepEqual(emptied.entries, [], "clearing hands back an empty list");
  assert.deepEqual(
    stub.trashed.slice().sort(),
    [a, b].sort(),
    "the remaining file was sent to the trash too",
  );

  const reveal = handlers.get(IPC.invoke.workbenchLibraryReveal);
  const opened = await reveal({});
  assert.equal(opened.ok, true);
  assert.equal(stub.opened.at(-1), join(env.dataDir, "generated"), "the library root is what opens");
});
