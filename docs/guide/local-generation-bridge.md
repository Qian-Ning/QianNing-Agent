---
title: Local generation bridge
description: Run ComfyUI or Stable Diffusion WebUI behind an OpenAI-compatible shim so the media workbench can reach it by address.
---

# Local generation bridge

The media workbench talks to image services in the OpenAI shape: it sends `POST /v1/images/generations` and reads the image back from `data[0].b64_json`. ComfyUI and Stable Diffusion WebUI do not speak that shape — their native routes are `POST /prompt` and `POST /sdapi/v1/txt2img` — so pointing the workbench straight at `http://127.0.0.1:8188` gets a 404 or a 400, and the app can only report the HTTP code it saw. The bridge is a small script that sits in front of the native server and translates one shape into the other.

It is one dependency-free file, `docs/public/local-bridge.mjs` in this repository. Copy it anywhere and run it with Node 18 or newer; it uses only the Node standard library.

[中文版本](/zh-CN/guide/local-generation-bridge)

## Why the workbench needs a bridge

A native server is a live HTTP server, so nothing stops you typing its address into a provider — the request really does leave the machine. What comes back is a `404` (ComfyUI has no `/v1/images/generations`) or a `400` (Stable Diffusion WebUI reads an OpenAI body as a missing prompt). The workbench has no field for "this endpoint is not OpenAI-shaped", so the translation happens outside the app, in front of the server.

The bridge is deliberately the smallest thing that makes that possible: it exposes the two routes the workbench actually calls and forwards the work to the native API.

## Run the bridge

Pick the backend and point `--upstream` at the native server. The bridge prints the address to enter in the app.

```bash
# Stable Diffusion WebUI (its API is on by default at :7860)
node docs/public/local-bridge.mjs --backend sd --upstream http://127.0.0.1:7860
```

```bash
# ComfyUI (its API listens at :8188)
node docs/public/local-bridge.mjs --backend comfy --upstream http://127.0.0.1:8188 --ckpt v1-5-pruned-emaonly.safetensors
```

`--help` lists every flag: `--port` (default `8787`), `--model` (the id the app will show), `--steps`, `--default-size`, `--negative`, `--timeout`, and `--workflow` for a ComfyUI graph of your own. A ComfyUI graph is read as a template, so it is not tied to one checkpoint: the tokens `__PI_PROMPT__`, `__PI_NEGATIVE__`, `__PI_WIDTH__`, `__PI_HEIGHT__`, `__PI_STEPS__`, `__PI_SEED__` and `__PI_CKPT__` are filled from the request and the flags. In a custom graph, keep the string tokens (`prompt`, `negative`, `ckpt`) inside quotes and the numeric tokens (`width`, `height`, `steps`, `seed`) bare, as the built-in graph does.

You can check it is up without any image generation:

```bash
curl -s http://127.0.0.1:8787/v1/models
```

## Point QianNing Agent at the bridge

Add the bridge as a **custom** provider and name it something you will recognize:

- **Base URL**: `http://127.0.0.1:8787/v1` — the same address the bridge printed.
- **API format**: any OpenAI-compatible format; the shape does not matter, because the workbench always sends the OpenAI body to `/v1/images/generations`.
- **API key**: leave it empty. A loopback address is stored without a key, so no secret is required.
- **Model**: the id the bridge reports from `/v1/models` (`sd-webui` or `comfyui`, or whatever `--model` set). A loopback address is marked **Local** and is exempt from the name-based image/video family check, because a self-hosted server names its models after files.

Then open the media workbench, pick the model, and generate. The bridge is what makes the run succeed.

## What the bridge does and does not do

| Capability | Supported | Notes |
|---|---|---|
| Text to image | Yes | One image per request; `POST /sdapi/v1/txt2img` or a `POST /prompt` graph |
| A concrete pixel size | Yes | `WIDTHxHEIGHT` is passed straight through to width and height |
| Smart / provider default size | Approximate | No size is sent, so the bridge uses `--default-size` (default `512x512`) |
| Aspect ratio | Implicit | The workbench composes a fixed `WIDTHxHEIGHT`, so the ratio travels as pixels |
| Reference images / edits | No | `POST /v1/images/edits` answers `501`; img2img and inpainting are not translated |
| Video | No | `POST /v1/videos` answers `501`; use a video-capable service |
| Returned image | Base64 | Always `data[0].b64_json`; a `url`-only client gets no link |

The honest summary: a plain prompt and a pixel size work end to end; "Smart" size falls back to a default; a run that attaches a reference image, or asks for a video, fails with a clear error rather than silently producing something else.

## Troubleshooting

- **The bridge starts but generation fails.** Check the native server is actually running: open `http://127.0.0.1:7860/docs` (SD WebUI) or `http://127.0.0.1:8188` (ComfyUI) in a browser.
- **The app shows `IMAGE_HTTP_404`.** The request reached an OpenAI route on the bridge but the bridge is not the one you think, or you pointed the provider at the native server instead of the bridge. Confirm the base URL ends in `/v1` and the port matches the bridge's own output.
- **The app shows `IMAGE_HTTP_400`.** The request reached a native server directly, not the bridge — a native server reads the OpenAI body as malformed.
- **ComfyUI returns "no image output".** The graph finished but produced no `SaveImage` output. The built-in graph saves through node `9`; a custom `--workflow` must contain a `SaveImage` node.
- **A timeout.** The app aborts a single image at 180 seconds; the bridge's own budget defaults to 150 seconds. Raise `--timeout` only up to that ceiling, and lower `--steps` otherwise.

There is no CORS problem to solve: the workbench's request runs in the Electron main process, not a browser page, so the bridge is never asked for an `Access-Control-Allow-Origin` header. Keep it bound to loopback (`--host 127.0.0.1`, the default); it checks no credentials and forwards none.

## Go deeper

| Your next task | Read |
|---|---|
| How the workbench and model binding work | [Media workbench](/guide/media-workbench) |
| Add a provider or a local server | [Your first project session](/guide/first-session) |
| Where files and secrets live | [Data, privacy, and security](/guide/data-and-security) |
| The request and error-code contract | [Video generation](/spec/03-runtime/24-video-generation) |
