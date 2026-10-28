# ADR 0336: A foreground service keeps a running turn alive

- Status: Accepted for implementation
- Date: 2026-10-28
- Related: [The phone runs the agent itself](0335-mobile-agent-host.md);
  [The phone client is an app, not a page in a string](0334-mobile-client-as-an-app.md)

## Context

ADR 0335 put the agent loop inside the phone's WebView. That loop streams an
answer over seconds to minutes, and Android freezes a backgrounded app's
WebView: the moment the reader switches away, the stream stalls and the answer
arrives truncated or not at all. Nothing in the client can prevent that — the
freeze happens below the app, in the process scheduler.

The platform's supported answer is a foreground service: a process-level claim
that real work is happening, paired with an ongoing notification the user can
see. The claim has to be honest. A notification that says "working" while
nothing is running is a lie the user cannot dismiss.

## Decision

Start a foreground service when a turn starts and stop it when the turn
settles. The lifecycle follows `turnId` in the conversation view — `turn.started`
or `turn.queued` acquires, `turn.completed` / `interrupted` / `failed` /
`canceled` releases — not the HTTP call that requested the turn, which returns
long before the work ends.

Three properties make this safe to ship:

1. **Reference counted in the client.** `src/agent/keepalive.ts` counts
   acquires; the service starts at one and stops at zero. Overlapping or
   re-entrant turns cannot stop a service another turn still needs.
2. **`START_NOT_STICKY`.** If Android kills the process, the service is not
   resurrected into a phantom "working" state; the turn is already lost at that
   point and the UI shows it on next open.
3. **Fail-open.** A refused foreground start (`ForegroundServiceStartNotAllowed`)
   is swallowed: the turn still runs while the app is visible. Losing the
   notification is better than failing the request.

The service type is `specialUse` with subtype `agent task execution`. `dataSync`
was rejected: Android 15 caps it at six hours per day, and an agent turn is not
a sync. The notification uses a dedicated low-importance channel, is ongoing,
does not alert repeatedly, and opens the running conversation on tap.

`POST_NOTIFICATIONS` is requested the first time a turn starts (Android 13+).
Denial does not block anything; the service runs and the notification simply is
not shown.

## Consequences

- A turn now survives backgrounding, screen-off (the process stays foreground),
  and app switching. It does not survive an app kill, which is correct.
- The app gains a persistent notification while working. That is the visible
  cost of the guarantee, and it disappears when the turn ends.
- The service declaration, the `specialUse` subtype, and the permission live in
  `AndroidManifest.xml`; the JS side never sees Android types.
- Distribution outside the debug build would need the `specialUse` declaration
  in the store listing. The debug APK needs nothing.
- No wake lock is taken. The service prevents the freeze; it does not keep the
  screen or CPU awake beyond what the foreground state implies.

## Alternatives considered

- **WorkManager / JobScheduler** — built for deferrable background work, not for
  streaming a live answer the user is watching.
- **Partial wake lock alone** — keeps the CPU up but does not lift WebView
  throttling; the stream still stalls.
- **Keep the screen on** — punishes the battery and does not survive the app
  being backgrounded.
- **Rely on the desktop host** — only works when connected to a desktop, and the
  phone is its own host since ADR 0335.
