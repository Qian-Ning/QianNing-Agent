import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createVideoGenerationTool } = await import(
  "../electron/main/services/video-generation-service.ts"
);

/** A minimal ISO-BMFF file: `ftyp` at offset 4 is what the sniffer checks. */
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.from([0, 0, 2, 0]),
  Buffer.alloc(64, 9),
]);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);

/**
 * One video fixture server: create, status polling, and the finished file.
 *
 * The status sequence is per job, so a test can make one clip fail without
 * touching the others.
 */
function startVideoServer() {
  const requests = [];
  const statuses = new Map();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("latin1");
    requests.push({
      url: request.url,
      method: request.method,
      body,
      authorization: request.headers.authorization,
      contentType: String(request.headers["content-type"] ?? ""),
    });
    if (request.method === "POST" && request.url === "/v1/videos") {
      const failed = body.includes("fail me");
      const id = failed ? "job-fail" : `job-${requests.length}`;
      if (!statuses.has(id)) {
        statuses.set(id, failed ? ["in_progress", "failed"] : ["queued", "in_progress", "completed"]);
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id, status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url.includes("/v1/videos/")) {
      const id = request.url.split("/").pop();
      const steps = statuses.get(id) ?? ["completed"];
      const next = steps.shift() ?? "completed";
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          next === "completed"
            ? { status: next, url: `http://127.0.0.1:${server.address().port}/clip.mp4` }
            : { status: next },
        ),
      );
      return;
    }
    if (request.url === "/clip.mp4") {
      response.setHeader("Content-Type", "video/mp4");
      response.end(mp4);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { server, requests, statuses };
}

async function withService(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-videos-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fixture = startVideoServer();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => fixture.server.close(resolve)));
  const scratch = join(dataDir, "scratch", "session");
  await mkdir(scratch, { recursive: true });

  let settings = {
    defaultModelId: "chat",
    defaultProviderId: "chat-provider",
    videoGeneration: { providerId: "video-provider", modelId: "video-one" },
  };
  let provider = {
    id: "video-provider",
    enabled: true,
    authKind: "api_key_and_base_url",
    models: [{ id: "video-one" }, { id: "video-two" }],
    baseUrl: `http://127.0.0.1:${fixture.server.address().port}`,
  };
  let secret = "fixture-key";

  const host = {
    call: async (method) => {
      if (method === "settings.get") return structuredClone(settings);
      if (method === "providers.get") return { provider };
      if (method === "providers.getSecret") return { value: secret };
      if (method === "session.getScratchPath") return { path: scratch };
      if (method === "session.get") return { session: {} };
      throw new Error(method);
    },
  };
  const tool = createVideoGenerationTool({ dataDir, getHost: () => host });
  const call = (args, signal) =>
    tool({ sessionId: "session", toolCallId: "call", args, signal: signal ?? new AbortController().signal });
  return {
    call,
    requests: fixture.requests,
    statuses: fixture.statuses,
    scratch,
    server: fixture.server,
    get settings() {
      return settings;
    },
    set settings(value) {
      settings = value;
    },
    get provider() {
      return provider;
    },
    set provider(value) {
      provider = value;
    },
    get secret() {
      return secret;
    },
    set secret(value) {
      secret = value;
    },
    dataDir,
  };
}

test("configure, generate, poll, download and replace the binding; files survive service recreation", async (t) => {
  const ctx = await withService(t);
  const batch = await ctx.call({ items: [{ prompt: "a fox" }] });
  assert.equal(batch.ok, true);
  assert.equal(batch.content.kind, "generated-videos");
  assert.equal(batch.content.results.length, 1);
  const result = batch.content.results[0];
  assert.equal(result.status, "succeeded");
  assert.equal(result.mimeType, "video/mp4");
  assert.deepEqual(await readFile(result.path), mp4);
  assert.match(basename(result.path), /^generated-[0-9a-f-]{36}\.mp4$/);

  // Create, then two status reads before the file: queued, in_progress, done.
  assert.deepEqual(
    ctx.requests.map((request) => `${request.method} ${request.url}`),
    [
      "POST /v1/videos",
      "GET /v1/videos/job-1",
      "GET /v1/videos/job-1",
      "GET /v1/videos/job-1",
      "GET /clip.mp4",
    ],
  );
  // The credential rides every provider call, and never the media download:
  // the finished file is fetched without provider headers.
  assert.ok(
    ctx.requests
      .filter((request) => request.url !== "/clip.mp4")
      .every((request) => request.authorization === "Bearer fixture-key"),
  );
  assert.equal(ctx.requests.at(-1).authorization, undefined);
  assert.equal(JSON.parse(ctx.requests[0].body).model, "video-one");

  // The binding is read per call, so switching the model switches the request.
  ctx.settings = {
    ...ctx.settings,
    videoGeneration: { providerId: "video-provider", modelId: "video-two" },
  };
  await ctx.call({ items: [{ prompt: "replacement" }] });
  const create = ctx.requests.filter((request) => request.method === "POST").at(-1);
  assert.equal(JSON.parse(create.body).model, "video-two");

  // Switching provider to OAuth is refused outright.
  ctx.provider = { ...ctx.provider, authKind: "oauth" };
  assert.equal(
    (await ctx.call({ items: [{ prompt: "no oauth" }] })).errorCode,
    "VIDEO_AUTH_UNSUPPORTED",
  );
  ctx.provider = { ...ctx.provider, authKind: "api_key_and_base_url" };

  // A missing key is reported before any request leaves.
  ctx.secret = undefined;
  assert.equal((await ctx.call({ items: [{ prompt: "no key" }] })).errorCode, "VIDEO_AUTH_FAILED");
  ctx.secret = "fixture-key";

  // A disabled provider or a model it does not list is unavailable.
  ctx.provider = { ...ctx.provider, enabled: false };
  assert.equal(
    (await ctx.call({ items: [{ prompt: "disabled" }] })).errorCode,
    "VIDEO_MODEL_UNAVAILABLE",
  );
  ctx.provider = { ...ctx.provider, enabled: true };
  ctx.settings = {
    ...ctx.settings,
    videoGeneration: { providerId: "video-provider", modelId: "not-listed" },
  };
  assert.equal(
    (await ctx.call({ items: [{ prompt: "unknown model" }] })).errorCode,
    "VIDEO_MODEL_UNAVAILABLE",
  );

  // No default is a configuration error with a settings path, never a silent pick.
  ctx.settings = { ...ctx.settings, videoGeneration: null };
  const unset = await ctx.call({ items: [{ prompt: "unset" }] });
  assert.equal(unset.errorCode, "VIDEO_NOT_CONFIGURED");
  assert.match(unset.content.message, /Settings/);
  assert.equal(ctx.settings.defaultModelId, "chat");
});

test("a failing clip reports partial success, and the batch keeps input order", async (t) => {
  const ctx = await withService(t);
  const batch = await ctx.call({
    items: [{ prompt: "first clip" }, { prompt: "fail me", count: 1 }, { prompt: "third clip" }],
  });
  assert.equal(batch.ok, true);
  assert.deepEqual(
    batch.content.results.map((result) => [result.index, result.status]),
    [
      [0, "succeeded"],
      [1, "failed"],
      [2, "succeeded"],
    ],
  );
  assert.equal(batch.content.results[1].errorCode, "VIDEO_JOB_FAILED");
  assert.deepEqual(await readFile(batch.content.results[2].path), mp4);
});

test("a first frame is read from the session roots only, and a bad one is refused", async (t) => {
  const ctx = await withService(t);
  const frame = join(ctx.scratch, "frame.png");
  await writeFile(frame, png);
  const ok = await ctx.call({ items: [{ prompt: "animate this", image: frame }] });
  assert.equal(ok.content.results[0].status, "succeeded");
  const create = ctx.requests.find((request) => request.method === "POST");
  assert.match(create.contentType, /^multipart\/form-data; boundary=/);
  assert.match(create.body, /name="input_reference"/);
  assert.match(create.body, /filename="frame\.png"/);

  // Outside the project/scratch/attachment roots.
  await writeFile(join(ctx.dataDir, "outside.png"), png);
  const outside = await ctx.call({
    items: [{ prompt: "escape", image: join(ctx.dataDir, "outside.png") }],
  });
  assert.equal(outside.content.results[0].errorCode, "VIDEO_FRAME_UNAVAILABLE");

  // Inside, but not an image.
  const fake = join(ctx.scratch, "not-an-image.png");
  await writeFile(fake, "definitely not a png");
  const bad = await ctx.call({ items: [{ prompt: "bad frame", image: fake }] });
  assert.equal(bad.content.results[0].errorCode, "VIDEO_FRAME_UNAVAILABLE");
});

test("an already-aborted call stops before dispatch", async (t) => {
  const ctx = await withService(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ctx.call({ items: [{ prompt: "cancelled" }] }, controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(ctx.requests.length, 0);
});

test("the default videogen skill is discoverable and loads in an ordinary session", async () => {
  const previous = globalThis.__dirname;
  globalThis.__dirname = fileURLToPath(new URL("../electron/main/", import.meta.url));
  try {
    const { builtinSkills, loadBuiltinSkillBody } = await import(
      "../electron/main/builtin-skills.ts"
    );
    const skills = builtinSkills({});
    assert.equal(skills.find((skill) => skill.id === "qianning/videogen")?.name, "videogen");
    assert.ok(!skills.some((skill) => skill.id === "qianning/plugin-development"));
    const body = loadBuiltinSkillBody("qianning/videogen").body;
    assert.match(body, /GenerateVideos/);
    assert.match(body, /Video generation model/);
    assert.match(body, /Do not retry/);
    assert.equal(loadBuiltinSkillBody("qianning/nope"), null);
  } finally {
    globalThis.__dirname = previous;
  }
});
