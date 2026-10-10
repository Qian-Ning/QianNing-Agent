#!/usr/bin/env node
/** A finished clip keeps a poster frame, and the library keeps nothing else.
 *
 * Uses a throwaway profile, a throwaway data directory, the production preload
 * and the built application. The clip is served over the real `media-asset://`
 * scheme, drawn to a canvas the way the renderer draws it, and handed back over
 * the real save channel.
 *
 * This exists because the path crosses a boundary no unit test can join: the
 * scheme has to hand the renderer a clip it may both play and draw, a real
 * decoder has to produce a frame, and the channel that keeps it has to refuse
 * everything outside the library while leaving the render it came from untouched
 * when it does. The renderer's own tests cover the decisions around a capture;
 * only a real Chromium can answer what the scheme actually gives a `<video>`
 * element and a canvas, and it is the only automated cover this path has.
 *
 * Note what this is not: removing the scheme's `Access-Control-Allow-Origin`
 * header does not make it fail (measured under a `file://` and an `http://`
 * renderer alike), so it is not a guard on that header. The product path that
 * *triggers* a capture — a run finishing, the frame being handed over — is
 * covered by the renderer's own tests. The host core is deliberately not
 * started, because the scheme, the preload bridge and the channel under test all
 * live in the main process and the window opens without it.
 *
 * Requires a build first: `pnpm build`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { appDir } = assertDesktopBuild(root);
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-media-poster-"));
const dataDir = join(temp, "data");
const port = Number(process.env.PI_DESKTOP_CHROME_CDP_PORT || 9352);

/** Named the way the library names a render, and 320x240 so the copy's height
 *  is a number the assertion can disagree with if the frame is ever wrong. */
const CLIP = "generated-11111111-1111-1111-1111-111111111111.mp4";
const CLIP_URL = `media-asset://library/video/${CLIP}`;
const THUMB = { width: 64, height: 48 };
const pending = new Map();
let sequence = 0;
let socket;
let child;
let output = "";
let failed = false;

async function waitFor(predicate, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
/** PNG width and height are big-endian 32-bit fields in the IHDR chunk. */
function pngSize(bytes) {
  assert.ok(bytes.length > 24, "the copy is too short to be a PNG");
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "the copy does not carry a PNG signature",
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

try {
  await mkdir(join(dataDir, "generated", "video"), { recursive: true });
  await copyFile(
    join(root, "scripts", "e2e", "fixtures", "poster-frame.mp4"),
    join(dataDir, "generated", "video", CLIP),
  );

  const env = {
    ...process.env,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_DESKTOP_HOST_BIN;
  // Its own process group on POSIX. Electron leaves helpers behind -- a crashpad
  // handler is the usual one -- and a surviving helper holds the X connection the
  // display is waiting on, so `xvfb-run` never returns and the CI step hangs
  // after the probe has already printed every PASS. Killing the group is what
  // lets the display exit with the probe.
  child = spawn(
    electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, "profile")}`, "."],
    {
      cwd: appDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-4000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-4000);
  });

  let target;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      target = (await response.json()).find(
        (entry) =>
          entry.type === "page" &&
          entry.url.includes("out/renderer/index.html") &&
          !entry.url.includes("surface="),
      );
      return !!target;
    } catch {
      return false;
    }
  }, "renderer target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  await waitFor(
    () => evaluate(`!!window.piDesktop && typeof window.piDesktop.invoke === "function"`),
    "preload bridge",
  );
  console.log("PASS preload bridge");

  const clipAbsolute = join(dataDir, "generated", "video", CLIP).replace(/\\/g, "/");
  const outsideAbsolute = join(temp, "outside.mp4").replace(/\\/g, "/");
  const report = await evaluate(`(async () => {
  const url = ${JSON.stringify(CLIP_URL)};
  const clipAbsolute = ${JSON.stringify(clipAbsolute)};
  const outsideAbsolute = ${JSON.stringify(outsideAbsolute)};
  const out = { capture: null, saveInside: null, saveOutside: null, saveNotPng: null };
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("media error code " + (video.error && video.error.code)));
      setTimeout(() => reject(new Error("loadeddata timeout")), 15000);
    });
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(new Error("seek media error"));
      video.currentTime = 0.1;
      setTimeout(() => reject(new Error("seek timeout")), 15000);
    });
  } catch (error) {
    out.capture = { ok: false, error: String(error) };
    return out;
  }
  const canvas = document.createElement("canvas");
  canvas.width = ${THUMB.width};
  canvas.height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * ${THUMB.width}));
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  let dataUrl;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch (error) {
    out.capture = { ok: false, error: String(error) };
    return out;
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const colours = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    colours.add(((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]).toString(16));
  }
  out.capture = {
    ok: true,
    source: video.videoWidth + "x" + video.videoHeight,
    drawn: canvas.width + "x" + canvas.height,
    length: dataUrl.length,
    colours: colours.size,
  };
  out.saveInside = await window.piDesktop.invoke("pi-desktop/workbench/saveThumbnail", {
    capability: "video",
    path: clipAbsolute,
    dataUrl,
  });
  out.saveOutside = await window.piDesktop.invoke("pi-desktop/workbench/saveThumbnail", {
    capability: "video",
    path: outsideAbsolute,
    dataUrl,
  });
  out.saveNotPng = await window.piDesktop.invoke("pi-desktop/workbench/saveThumbnail", {
    capability: "video",
    path: clipAbsolute,
    dataUrl: "data:image/png;base64,QUJD",
  });
  return out;
})()`);

  assert.equal(report.capture.ok, true, `capture failed: ${report.capture.error}`);
  assert.equal(report.capture.source, "320x240", `clip did not decode: ${report.capture.source}`);
  assert.ok(
    report.capture.colours > 1,
    `the canvas holds a single colour (${report.capture.colours}): no frame was drawn`,
  );
  console.log("PASS frame taken from the clip over media-asset://");

  assert.equal(report.saveInside?.ok, true, "the save channel failed outright");
  const inside = report.saveInside?.data;
  assert.ok(inside, `the save channel answered nothing: ${JSON.stringify(report.saveInside)}`);
  assert.equal(inside.ok, true, "the frame was not kept");
  const thumbPath = inside.path;
  assert.ok(
    typeof thumbPath === "string" && thumbPath.includes("thumbs"),
    `unexpected copy path: ${thumbPath}`,
  );
  const size = pngSize(await readFile(thumbPath));
  assert.deepEqual(size, THUMB, `the copy is ${size.width}x${size.height}`);
  console.log(`PASS poster frame kept beside the clip at ${THUMB.width}x${THUMB.height}`);

  // A refusal is the handler's answer, not a failure of the call: the invocation
  // itself must have succeeded, or these would pass on a broken channel.
  assert.equal(report.saveOutside?.ok, true, "the outside-path probe failed outright");
  assert.equal(report.saveOutside?.data?.ok, false, "a path outside the library was accepted");
  assert.equal(report.saveNotPng?.ok, true, "the non-PNG probe failed outright");
  assert.equal(report.saveNotPng?.data?.ok, false, "a payload that is not a PNG was accepted");
  console.log("PASS refusals: outside the library, and a payload that is not a PNG");
} catch (error) {
  failed = true;
  console.error(error);
  console.error(output);
} finally {
  socket?.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    if (process.platform === "win32") {
      await exited;
    } else {
      // Bounded. A helper that ignores the signal must not be able to hold the
      // step open, and the group kill below is what takes the strays with it.
      await Promise.race([exited, delay(5000)]);
    }
  }
  if (child && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone, which is the normal case.
    }
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = failed ? 1 : 0;
