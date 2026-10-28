# ADR 0338: The agent runs outside the WebView

- Status: Proposed
- Date: 2026-10-28
- Related: [The phone runs the agent itself](0335-mobile-agent-host.md);
  [A foreground service keeps a running turn alive](0336-mobile-foreground-service.md);
  [Scheduled tasks ring, the app runs them](0337-mobile-scheduled-alarms.md);
  spike `spikes/003-headless-agent-runtime/`

## Context

ADR 0337 stops one step short of what "scheduled" means: the alarm rings, the
reader taps, the app runs the task. The reason is mechanical — the agent loop
lives in the WebView, and a closed app has none.

Spike 003 removes the uncertainty under that claim: the phone's host, bundled
with `pi-ai` and `pi-agent-core`, runs a complete streamed turn in 1.9 MB of
portable JS with `window` and `document` undefined and a single `node:fs` touch
(an env fallback inside a `try`). The agent core was never the obstacle; the host
was.

So the question is now an engine choice, not a feasibility question.

## Decision

Move the agent runtime out of the WebView and into a **foreground Service hosting
an embedded Node.js runtime** (nodejs-mobile, Node 18 ABI). The same bundle the
WebView loads is built a second time for `platform=node` and shipped as an asset;
the Service starts it on a scheduled alarm, runs the turn, writes the result
through the existing store schema, and posts a notification.

Rules the implementation must keep:

1. **One agent, two hosts.** `apps/mobile/src/agent/host.ts` stays the only
   implementation. A headless entry point wraps it; it does not reimplement the
   loop, the tools, or the event shapes.
2. **The key leaves the WebView.** The provider secret moves to Android Keystore,
   read by the Service. A key that only the WebView can unlock cannot serve a
   task that runs without it.
3. **A headless turn is invisible until it finishes.** Progress goes to the
   notification, not to a UI that may not exist; the transcript is written to
   storage so the app shows it on next open.
4. **The app's tool set is the same four tools** (`list_files`, `read_file`,
   `write_file`, `fetch_url`), bridged to native file access through the same
   policy the WebView build uses. No new capability comes with the new host.
5. **Failure is a notification, not a silence.** A failed turn writes the error
   to storage and tells the reader, exactly as `runDueSchedules` already does.

## Consequences

- Scheduled tasks actually execute with the app closed, once the phone is
  unlocked at least once after boot (Keystore requirement).
- **The APK grows by roughly 20–30 MB** for a single ABI. This is the price of a
  real runtime and the reason this ADR is Proposed rather than Accepted.
- Two builds of the same source must stay in step; CI has to build both or the
  headless bundle silently rots.
- The WebView remains the interactive host. It does not become a wrapper around
  the Node process — a second, long-lived IPC surface between them would be a new
  boundary to police for no gain.

## Alternatives considered

- **QuickJS** (~2 MB): would keep the APK near its current size, but ships no
  `fetch`, no streams, and no `AbortController`. Streaming a provider response
  over a hand-written native HTTP bridge, then keeping `pi-ai`'s cancellation
  semantics intact, is more code and more failure modes than the megabyte buys.
  Revisit if APK size becomes the binding constraint.
- **WebView inside the Service**: Android does not allow a WebView to run without
  a window it belongs to; overlaying a 1×1 one is a hack that breaks across
  versions and would not survive review.
- **Delegate the turn to the desktop host** over RACP: works only when a desktop
  is paired and awake, which is exactly the case the feature exists to avoid.
- **Do nothing, keep 0337's reminder**: honest and shipped, but it is a reminder,
  not a schedule.

## Open questions for the user

- Is a ~25 MB APK increase acceptable? If not, QuickJS becomes the candidate and
  the estimate above changes from "megabytes" to "weeks of bridge work".
- Ship `arm64-v8a` only, or all ABIs? Universal would triple the growth.
