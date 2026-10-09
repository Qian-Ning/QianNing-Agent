#!/usr/bin/env node
/*
 * local-bridge.mjs — a zero-dependency OpenAI-compatible shim for a local
 * image generator whose native API is not the OpenAI shape.
 *
 * WHAT IT IS
 *   QianNing Agent's media workbench talks to image services in the OpenAI
 *   shape: it sends `POST /v1/images/generations` with a JSON body and reads
 *   back `data[0].b64_json` (or `data[0].url`). ComfyUI and Stable Diffusion
 *   WebUI do not speak that shape — their native routes are `POST /prompt`
 *   and `POST /sdapi/v1/txt2img` — so pointing the app straight at
 *   `http://127.0.0.1:8188` gets a 404/400. This script sits in front of the
 *   native server and translates one shape into the other. Run it, then point
 *   a "custom" provider in the app at the address it prints.
 *
 * HOW TO RUN
 *   node local-bridge.mjs --backend sd    --upstream http://127.0.0.1:7860
 *   node local-bridge.mjs --backend comfy --upstream http://127.0.0.1:8188
 *   node local-bridge.mjs --help          # every flag
 *
 *   Defaults: --upstream http://127.0.0.1:8188, --backend comfy,
 *   --port 8787, --default-size 512x512, --steps 20, --timeout 150000 ms.
 *   Override the ComfyUI graph with --workflow path/to/workflow_api.json; the
 *   graph is a template and recognises the tokens __PI_PROMPT__,
 *   __PI_NEGATIVE__, __PI_WIDTH__, __PI_HEIGHT__, __PI_STEPS__, __PI_SEED__,
 *   __PI_CKPT__.
 *
 * WHAT IT SUPPORTS
 *   GET  /v1/models               -> a minimal OpenAI model list, so the app
 *                                    treats the address as a usable endpoint.
 *   POST /v1/images/generations   -> one image per request, returned as
 *                                    data[0].b64_json. `size: "WIDTHxHEIGHT"`
 *                                    is passed straight through to the native
 *                                    server; an absent size (the app's
 *                                    "Smart" default) uses --default-size,
 *                                    because a native server has no notion of
 *                                    "let the model decide".
 *
 * WHAT IT DOES NOT SUPPORT (honest limits)
 *   - Video. `POST /v1/videos` is not implemented; the workbench's video tab
 *     will get a clear 404-shaped OpenAI error. Use a real video service.
 *   - Reference images / edits. The app sends a multipart body to
 *     `POST /v1/images/edits` when reference images are attached, and the
 *     first/last frames for video go the same route. img2img, inpainting and
 *     frame conditioning are NOT translated here; `/v1/images/edits` returns a
 *     501-shaped OpenAI error rather than pretending. Any run with a reference
 *     image is therefore expected to fail loudly, not silently degrade.
 *   - `n > 1` in a single request: the app always sends n=1, so the bridge only
 *     ever renders one image per call and returns a length-1 `data` array.
 *   - `response_format: "url"`: the bridge always returns base64. The app reads
 *     `b64_json` first, so this is fine for the app; a plain OpenAI client that
 *     insists on a URL will not get one.
 *   - Auth: the bridge checks nothing and forwards nothing. Bind it to
 *     loopback (the default) and do not expose it.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const HELP = `local-bridge.mjs — OpenAI-compatible shim for SD WebUI / ComfyUI

Usage: node local-bridge.mjs [options]

  --backend sd|comfy     Native server to drive (default: comfy)
  --upstream URL         Native server base URL (default: http://127.0.0.1:8188;
                         for --backend sd the usual port is 7860)
  --port N               Port this bridge listens on (default: 8787)
  --host HOST            Interface to bind (default: 127.0.0.1 — loopback only)
  --model NAME           Model id reported by GET /v1/models and echoed in
                         responses (default: "sd-webui" for sd, "comfyui" for comfy)
  --workflow PATH        ComfyUI API-format workflow JSON to use as the template
                         (default: a built-in minimal sd1.5 txt2img graph)
  --ckpt NAME            Checkpoint filename written into __PI_CKPT__
                         (default: v1-5-pruned-emaonly.safetensors)
  --negative TEXT        Negative prompt (default: empty)
  --default-size WxH     Size used when the request sends none (default 512x512)
  --steps N              Sampling steps (default: 20)
  --timeout MS           Per-request budget before a 504 is returned
                         (default: 150000; the app itself aborts at 180000)
  --help                 Print this text

Every value also reads from the matching environment variable:
PI_BRIDGE_BACKEND, PI_BRIDGE_UPSTREAM, PI_BRIDGE_PORT, PI_BRIDGE_MODEL,
PI_BRIDGE_WORKFLOW, PI_BRIDGE_CKPT, PI_BRIDGE_NEGATIVE, PI_BRIDGE_DEFAULT_SIZE,
PI_BRIDGE_STEPS, PI_BRIDGE_TIMEOUT.
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`option --${key} needs a value`);
      }
      args[key] = value;
      i++;
    } else {
      throw new Error(`unexpected argument: ${token}`);
    }
  }
  return args;
}

function env(name) {
  const value = process.env[`PI_BRIDGE_${name}`];
  return value === undefined || value === "" ? undefined : value;
}

function toInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

const SIZE_PATTERN = /^(\d{2,5})x(\d{2,5})$/;

function parseSize(value, label) {
  const match = SIZE_PATTERN.exec(value);
  if (!match) throw new Error(`${label} must look like 512x512, got ${JSON.stringify(value)}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function resolveOptions() {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const pick = (key, name) => raw[key] ?? env(name);
  const backend = pick("backend", "BACKEND") ?? "comfy";
  if (backend !== "sd" && backend !== "comfy") {
    throw new Error(`--backend must be "sd" or "comfy", got ${JSON.stringify(backend)}`);
  }
  const defaultUpstream = backend === "sd" ? "http://127.0.0.1:7860" : "http://127.0.0.1:8188";
  const upstreamRaw = pick("upstream", "UPSTREAM") ?? defaultUpstream;
  const upstream = upstreamRaw.replace(/\/+$/, "");
  // A malformed upstream should fail now, not on the first generation.
  const parsed = new URL(upstream);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`--upstream must be http(s), got ${JSON.stringify(upstreamRaw)}`);
  }
  const defaultSize = pick("default-size", "DEFAULT_SIZE") ?? "512x512";
  const size = parseSize(defaultSize, "--default-size");
  const workflowPath = pick("workflow", "WORKFLOW");
  let workflow = null;
  if (workflowPath) {
    try {
      workflow = readFileSync(workflowPath, "utf8");
    } catch (error) {
      throw new Error(`cannot read --workflow ${workflowPath}: ${error.message}`);
    }
  }
  return {
    backend,
    upstream,
    port: toInt(pick("port", "PORT"), 8787, "--port"),
    host: pick("host", "HOST") ?? "127.0.0.1",
    model: pick("model", "MODEL") ?? (backend === "sd" ? "sd-webui" : "comfyui"),
    workflow,
    ckpt: pick("ckpt", "CKPT") ?? "v1-5-pruned-emaonly.safetensors",
    negative: pick("negative", "NEGATIVE") ?? "",
    defaultSize: size,
    steps: toInt(pick("steps", "STEPS"), 20, "--steps"),
    timeoutMs: toInt(pick("timeout", "TIMEOUT"), 150000, "--timeout"),
  };
}

// ---------------------------------------------------------------------------
// The built-in ComfyUI graph: a minimal sd1.5 txt2img workflow in API format.
// Every value a request can vary is a __PI_*__ token the bridge substitutes,
// so nothing about one checkpoint is baked in as the only option.
//
// String-valued tokens (prompt, negative, ckpt) sit inside quotes; numeric
// tokens (width, height, steps, seed) sit bare, because ComfyUI wants numbers.
// A custom --workflow template must keep the same convention for its tokens.
// ---------------------------------------------------------------------------
const DEFAULT_WORKFLOW = `{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "seed": __PI_SEED__,
      "steps": __PI_STEPS__,
      "cfg": 7,
      "sampler_name": "euler",
      "scheduler": "normal",
      "denoise": 1,
      "model": ["4", 0],
      "positive": ["6", 0],
      "negative": ["7", 0],
      "latent_image": ["5", 0]
    }
  },
  "4": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "__PI_CKPT__" }
  },
  "5": {
    "class_type": "EmptyLatentImage",
    "inputs": { "width": __PI_WIDTH__, "height": __PI_HEIGHT__, "batch_size": 1 }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "__PI_PROMPT__", "clip": ["4", 1] }
  },
  "7": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "__PI_NEGATIVE__", "clip": ["4", 1] }
  },
  "8": {
    "class_type": "VAEDecode",
    "inputs": { "samples": ["3", 0], "vae": ["4", 2] }
  },
  "9": {
    "class_type": "SaveImage",
    "inputs": { "filename_prefix": "PI_bridge", "images": ["8", 0] }
  }
}`;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

/** A body in the OpenAI error shape, so the app reports the code it expects. */
function sendError(res, status, message, type, code) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** One budget for the whole generation, so a stuck upstream cannot hang the app. */
function withBudget(timeoutMs, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true },
    );
  });
}

/** A classified bridge failure carrying the HTTP status to answer with. */
function bridgeError(status, message, code = "bridge_upstream_error") {
  return Object.assign(new Error(message), { status, code });
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------
function sizeFor(options, requested) {
  if (requested === undefined || requested === null) return options.defaultSize;
  const match = SIZE_PATTERN.exec(String(requested).trim());
  if (!match) {
    throw bridgeError(
      400,
      `size must look like 1024x1024, got ${JSON.stringify(requested)}`,
      "invalid_size",
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// SD WebUI backend: POST /sdapi/v1/txt2img -> { images: ["<base64>", ...] }
// ---------------------------------------------------------------------------
async function renderWithSd(options, prompt, size, signal) {
  const response = await fetch(`${options.upstream}/sdapi/v1/txt2img`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal,
    body: JSON.stringify({
      prompt,
      negative_prompt: options.negative,
      steps: options.steps,
      width: size.width,
      height: size.height,
      batch_size: 1,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw bridgeError(
      502,
      `SD WebUI answered ${response.status} at ${options.upstream}/sdapi/v1/txt2img`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw bridgeError(502, "SD WebUI returned a non-JSON response");
  }
  const images = payload?.images;
  if (!Array.isArray(images) || images.length === 0 || typeof images[0] !== "string" || !images[0]) {
    throw bridgeError(502, "SD WebUI returned no image (is a checkpoint loaded?)");
  }
  return images[0];
}

// ---------------------------------------------------------------------------
// ComfyUI backend: POST /prompt -> poll GET /history/{id} -> GET /view
// ---------------------------------------------------------------------------
/** Fill the __PI_*__ tokens, escaping each value for its JSON string context. */
function buildWorkflow(options, prompt, size) {
  const jsonInner = (value) => JSON.stringify(String(value)).slice(1, -1);
  const tokens = {
    __PI_PROMPT__: jsonInner(prompt),
    __PI_NEGATIVE__: jsonInner(options.negative),
    __PI_WIDTH__: String(size.width),
    __PI_HEIGHT__: String(size.height),
    __PI_STEPS__: String(options.steps),
    __PI_SEED__: String(Math.floor(Math.random() * 2 ** 32)),
    __PI_CKPT__: jsonInner(options.ckpt),
  };
  const template = options.workflow ?? DEFAULT_WORKFLOW;
  let filled = template;
  for (const [token, value] of Object.entries(tokens)) {
    filled = filled.split(token).join(value);
  }
  try {
    return JSON.parse(filled);
  } catch (error) {
    throw bridgeError(500, `workflow template is not valid JSON after substitution: ${error.message}`);
  }
}

/** First image output of a finished ComfyUI history entry, or null. */
function firstImageOutput(entry) {
  const outputs = entry?.outputs;
  if (!outputs || typeof outputs !== "object") return null;
  for (const node of Object.values(outputs)) {
    const images = node?.images;
    if (Array.isArray(images) && images.length && images[0]?.filename) return images[0];
  }
  return null;
}

async function fetchViewBase64(options, image, signal) {
  const query = new URLSearchParams({
    filename: image.filename,
    ...(image.subfolder ? { subfolder: image.subfolder } : {}),
    ...(image.type ? { type: image.type } : {}),
  });
  const response = await fetch(`${options.upstream}/view?${query}`, {
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw bridgeError(502, `ComfyUI answered ${response.status} fetching the output image`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw bridgeError(502, "ComfyUI returned an empty image");
  return bytes.toString("base64");
}

async function renderWithComfy(options, prompt, size, signal) {
  const graph = buildWorkflow(options, prompt, size);
  const clientId = randomUUID();
  const submit = await fetch(`${options.upstream}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal,
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
  });
  if (!submit.ok) {
    const detail = await submit.text().catch(() => "");
    await submit.body?.cancel();
    throw bridgeError(
      502,
      `ComfyUI rejected the workflow (${submit.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  let submitted;
  try {
    submitted = await submit.json();
  } catch {
    throw bridgeError(502, "ComfyUI returned a non-JSON response to /prompt");
  }
  const promptId = submitted?.prompt_id;
  if (typeof promptId !== "string" || !promptId) {
    throw bridgeError(502, "ComfyUI did not return a prompt_id");
  }
  // Poll until the entry appears; the shared budget aborts a stuck queue.
  for (;;) {
    await delay(1000, signal);
    const history = await fetch(`${options.upstream}/history/${promptId}`, {
      redirect: "error",
      signal,
    });
    if (!history.ok) {
      await history.body?.cancel();
      continue; // A 404 just means "not finished yet" for some builds.
    }
    let data;
    try {
      data = await history.json();
    } catch {
      continue;
    }
    const entry = data?.[promptId];
    if (!entry) continue;
    const image = firstImageOutput(entry);
    if (!image) {
      throw bridgeError(502, "ComfyUI finished without an image output (check the workflow's SaveImage node)");
    }
    return await fetchViewBase64(options, image, signal);
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
async function handleGenerations(req, res, options) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return sendError(res, 400, `invalid JSON body: ${error.message}`, "invalid_request_error", "invalid_request");
  }
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required", "invalid_request_error", "invalid_request");
  }
  let size;
  try {
    size = sizeFor(options, body?.size);
  } catch (error) {
    return sendError(res, error.status ?? 400, error.message, "invalid_request_error", error.code ?? "invalid_size");
  }

  try {
    const b64 = await withBudget(options.timeoutMs, (signal) =>
      options.backend === "sd"
        ? renderWithSd(options, prompt.trim(), size, signal)
        : renderWithComfy(options, prompt.trim(), size, signal),
    );
    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: b64 }],
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return sendError(
        res,
        504,
        `the ${options.backend} backend did not finish within ${options.timeoutMs} ms`,
        "server_error",
        "timeout",
      );
    }
    const status = error?.status ?? 502;
    return sendError(res, status, error?.message ?? String(error), "server_error", error?.code ?? "bridge_upstream_error");
  }
}

function handleModels(res, options) {
  sendJson(res, 200, {
    object: "list",
    data: [
      {
        id: options.model,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "local-bridge",
      },
    ],
  });
}

function createServer(options) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return handleModels(res, options);
    }
    if (req.method === "POST" && path === "/v1/images/generations") {
      return void handleGenerations(req, res, options);
    }
    if (req.method === "POST" && path === "/v1/images/edits") {
      // The app only reaches here with reference images attached; those are not
      // translated, and a 501 says so instead of a confusing 404.
      return sendError(
        res,
        501,
        "reference images and edits are not supported by this bridge; run without reference images",
        "invalid_request_error",
        "not_implemented",
      );
    }
    if (req.method === "POST" && path === "/v1/videos") {
      return sendError(
        res,
        501,
        "video generation is not supported by this bridge; use a video-capable service",
        "invalid_request_error",
        "not_implemented",
      );
    }
    sendError(res, 404, `no route for ${req.method} ${path}`, "invalid_request_error", "not_found");
  });
}

// ---------------------------------------------------------------------------
function main() {
  let options;
  try {
    options = resolveOptions();
  } catch (error) {
    process.stderr.write(`local-bridge: ${error.message}\n`);
    process.exit(2);
  }
  const server = createServer(options);
  server.on("error", (error) => {
    process.stderr.write(`local-bridge: cannot listen on ${options.host}:${options.port}: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    process.stdout.write(
      `local-bridge: ${options.backend} -> ${options.upstream}\n` +
        `local-bridge: listening on http://${options.host}:${options.port} (model "${options.model}")\n` +
        `local-bridge: point a custom provider in QianNing Agent at http://${options.host}:${options.port}/v1\n`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
