# Spike 003 — can the agent core leave the WebView?

Question: the agent loop lives in the WebView (ADR 0335). Before committing to a
headless runtime, prove the loop itself does not need a browser.

## What was run

`entry.ts` imports the phone's real host (`apps/mobile/src/agent/host.ts`) and its
store, points it at a local OpenAI-compatible stub (`fake-provider.mjs`, one
streamed answer, no tool calls), and sends one turn. A `localStorage` shim stands
in for the WebView's storage.

```sh
node_modules/.bin/esbuild spikes/003-headless-agent-runtime/entry.ts \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile=spikes/003-headless-agent-runtime/bundle.mjs

node spikes/003-headless-agent-runtime/fake-provider.mjs &
node spikes/003-headless-agent-runtime/bundle.mjs
```

## Result — validated

```json
{ "completed": true,
  "browserGlobals": { "window": "undefined", "document": "undefined" },
  "history": 2 }
```

The streamed answer arrived in six deltas and landed as
`{"role":"assistant","content":[{"type":"text","text":"你好，这是离线测试。"}]}`.

- **Bundle: 1,920,167 bytes** (1.9 MB) for host + `pi-ai` + `pi-agent-core` +
  store, one file, no `node_modules` at runtime.
- **Browser surface used: none.** `window` and `document` never exist.
- **Node built-ins used: one.** `node:fs` appears once, reading
  `/proc/self/environ` for env-var fallback inside a `try`. Everything else is
  portable JS.

## What this settles

The blocker was never the agent core — it was the host. Any runtime that can
stream HTTP responses can run a turn, so the choice is about the engine, not a
rewrite of the agent.

## What it does not settle

Tool execution (the phone's four tools need a bridge to native file access), the
provider key's home outside the WebView, and how a Service reports progress back
to a UI that may not be open. Those are ADR 0338's subject.
