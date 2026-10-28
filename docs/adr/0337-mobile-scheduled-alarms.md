# ADR 0337: Scheduled tasks ring, the app runs them

- Status: Accepted for implementation
- Date: 2026-10-28
- Related: [The phone runs the agent itself](0335-mobile-agent-host.md);
  [A foreground service keeps a running turn alive](0336-mobile-foreground-service.md)

## Context

Scheduled prompts exist (ADR 0335's client, `settings → 定时任务`) and fire while
the app is open. That is not what a user means by "every morning at eight". The
schedule needs to be honoured when the app is closed, which raises the question
this ADR exists to answer: **what executes at that moment?**

The agent loop lives in the WebView (ADR 0335). A closed app has no WebView, and
Android will not let a background receiver start an Activity to create one.
There are only two shapes available:

1. Waking the process to run an agent turn headlessly — requires the agent core
   to move out of the WebView into a runtime a `Service` can host (Node, QuickJS,
   or native), plus a home for the provider key outside the WebView's storage.
2. Waking the process just enough to **tell the reader**, and doing the work when
   they open the app.

## Decision

Ship (2). An alarm fires at the scheduled moment, posts a notification, and the
tap opens the app. `runDueSchedules` — already the code path used while the app is
open — picks the task up on the first tick after resume, so the work is real by
the time the screen paints.

Mechanics:

- One `AlarmManager` alarm per enabled task, keyed by a stable request code.
- `setExactAndAllowWhileIdle` when the platform permits; `setAndAllowWhileIdle`
  otherwise, with `canScheduleExactAlarms()` checked before every placement.
  Late, never broken.
- A sync is `cancelAll` then place-current, driven by the client after every
  edit and after every run. Two sources of truth are a bug waiting to happen.
- An overdue task rings at its **next period**, not immediately: the in-app
  runner is about to handle the current window, and two events for one window
  would double-run the prompt.
- A mirror of pending alarms lives in `SharedPreferences`, because Android drops
  every alarm on reboot and a boot receiver cannot read the WebView's storage.
  `BootReceiver` re-arms from the mirror; a task whose window passed while the
  phone was off is announced once rather than silently skipped.

## Consequences

- A schedule now survives the app being closed and the phone rebooting — up to
  the moment of firing.
- The reminder is not the execution. The user must tap. This is stated on the
  settings page in user language, not hidden behind a promise the build cannot
  keep.
- Exact alarms need `SCHEDULE_EXACT_ALARM`, which Android 14+ grants by default
  for this use but a user can revoke. Revocation degrades to "a few minutes
  late", and the page says so (`alarmInfo().exact === false`).
- Nothing runs without the app; a phone in a drawer all day executes nothing.
  Option (1) is the real fix, and it is a separate piece of work with its own
  ADR — it needs a headless agent runtime and a key store that does not depend
  on the WebView.

## Alternatives considered

- **WorkManager periodic work** — minimum interval 15 minutes, batched with the
  system's own work, and still cannot run the agent without the WebView.
- **Keep a foreground service alive permanently** to hold the WebView — defeats
  the point of a phone, and Android would kill it anyway without a visible
  ongoing task.
- **Run the agent in the receiver** — a broadcast receiver gets ~10 seconds; a
  turn takes far longer, and starting an Activity from the background is
  blocked.
