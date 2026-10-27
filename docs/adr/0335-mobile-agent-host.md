# ADR 0335: The phone runs the agent itself

- Status: Accepted
- Date: 2026-10-27

## Context

ADR 0334 made the phone client a real app instead of a page in a template
string, but the agent still ran on the desktop: the phone was a remote control
with a nicer surface. Users read that correctly and asked for the obvious thing
— the phone should be the product, and reaching the desktop should be one of its
capabilities, not its definition.

Two ways to get there were considered.

**A. Ship a runtime.** Cross-compile `host-core` to `aarch64-linux-android` and
embed a Node build (nodejs-mobile) to run `agent-runtime` unchanged. This buys
plugin execution, local MCP servers that spawn processes, and true background
execution. It costs 80–150 MB of APK, 100–200 MB of resident memory, a second
process lifecycle to keep alive across Doze, a pinned Node 18, and a second
copy of the agent harness that drifts from the desktop's.

**B. Ship the loop.** Run `@earendil-works/pi-agent-core` — the desktop's own
agent loop — inside the WebView the app already has, and implement the tools
with Android-native APIs.

The deciding measurement: `pi-agent-core` is 329 KB and imports **zero** `node:`
modules. `pi-ai`'s only `node:` uses are in OAuth callback servers, which an
API-key provider never touches. Bundling both for a browser platform produces
708 KB (200 KB gzipped) with no polyfills and no errors.

A's runtime buys capabilities Android cannot honour anyway: there is no `/bin/sh`,
no desktop filesystem, no `git` binary to spawn. The one capability that is real
— surviving in the background — is reachable with a foreground service.

## Decision

The phone runs the agent in-process, and exposes it through the same RACP paths a
desktop Host serves.

- `apps/mobile/src/agent/host.ts` owns sessions and turns, built on
  `pi-agent-core` with a configurable OpenAI-compatible provider.
- `apps/mobile/src/agent/local-client.ts` answers the RACP subset the screens
  already call (`/v1/sessions`, `/v1/sessions/{id}/history`,
  `/v1/sessions/{id}/turns`, `/v1/turns/{id}:interrupt`,
  `/v1/sessions/{id}:delete`, `/v1/projects`) from that local Host.
- `apps/mobile/src/lib/racp.ts` exposes `HostClient`, the two-method contract
  both the HTTP client and the local client satisfy. Screens depend on the
  contract, not on the transport.
- The desktop is unchanged. `apps/desktop` keeps serving `/app` from
  `apps/mobile/dist` as it does today; that build now also contains the
  on-device agent, which simply goes unused when the client is served remotely.

## Consequences

- One agent loop, one set of event kinds, one UI. A fix to the loop reaches both
  surfaces because there is only one.
- The phone needs no NDK, no cross-compiled Rust, no embedded Node. The APK grows
  by the bundle (200 KB gzipped) and nothing else.
- The tool set differs, deliberately and visibly: `list_files`, `read_file`,
  `write_file` (app storage) and `fetch_url`. There is no shell tool, because
  claiming one would be a lie on this platform.
- Session state lives in the app's own storage. The agent's transcript is kept
  beside the rendered messages so a restart continues the conversation instead of
  silently starting from an empty context.
- Provider keys live in the app's private storage and travel only as a request
  header. Moving them behind Android Keystore is follow-up work, not a
  precondition for a first usable build.
- Background execution is not solved here. A turn that is running when Android
  freezes the WebView stops. A foreground service is the intended remedy and is
  not part of this decision.
- Desktop-only surfaces degrade honestly: `workspace/diff` answers
  `CAPABILITY_UNAVAILABLE` because there is no project root to diff.
