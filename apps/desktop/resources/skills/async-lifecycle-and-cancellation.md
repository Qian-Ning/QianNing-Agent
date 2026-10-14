---
name: async-lifecycle-and-cancellation
description: code awaits, spawns background work, or owns a long-lived resource
---

# Asynchrony, cancellation, and who cleans up

Every `await` is a place where the world can change underneath you. Almost every
hard bug in asynchronous code is a version of forgetting that.

## Never assume state is unchanged across an await

Between the start of an operation and its result, the user can navigate, the
session can switch, the window can close, the process can restart, the component
can unmount, and a second request can arrive. Treat all of it as likely.

- After every `await`, re-check the things you depended on before it: is this
  still the same session, project, document, request, or connection?
- The classic failure is a **stale result**: a response arrives after the user
  moved on and writes to the place they left. Guard with an identity check — a
  token, an id, a generation counter — not with a boolean you set on the way in.
- A boolean flag is not a generation counter. The second request flips it back,
  and the first response now passes a check it should have failed.

## Cancel, and make cancellation mean something

- **Propagate it.** If the caller cancels, everything it started should learn
  about it. Accept an abort/cancel signal and pass it down; do not invent a
  private mechanism the callers cannot see.
- **A cancelled operation must not write.** Check the signal after the last
  `await` and before any state change, or the cancellation is decorative.
- **Cancellation is not failure.** Distinguish "the user left" from "it broke",
  and do not log, alert, or retry the first one.
- **Timeouts are mandatory** on anything that can hang: network, disk, another
  process, a queue. A missing timeout turns a slow dependency into an outage
  rather than a degraded feature.

## Expect to run twice

Double clicks, retries, a message redelivered, a reconnect that resumes: assume
the operation can arrive more than once.

- Make state-changing operations **idempotent**, or guard them with a key that
  makes the second attempt a no-op.
- A retry without idempotency duplicates a write. A retry with a timeout and no
  idempotency duplicates a write *and* reports a failure.
- Guard the trigger too: disable the button, drop the duplicate event, dedupe on
  a request id. Both ends, because neither alone is sufficient.

## Locking

- **Never hold a lock across an `await`** unless you know exactly what that lock
  protects and that nothing inside the awaited region can block on the same lock.
  This is the standard way a deadlock is born.
- Prefer narrowing the critical section to a pure computation between reads and
  writes, over holding anything across I/O.
- If you must serialize access to a resource, decide the policy explicitly:
  **queue** the second request, **reject** it, or **supersede** the first. All
  three are reasonable; the accident where a second call silently interleaves
  with the first is not.

## Every long-lived resource has an owner and a teardown

Listeners, timers, intervals, watchers, sockets, subscriptions, child processes,
sidecars, connections, workers. Each of them needs the same three things written
down:

1. **Who creates it** — and whether a second creation is possible.
2. **Who owns it** — a single owner, not "someone".
3. **Where it is destroyed** — a specific place, in the same change that creates
   it.

Then check the teardown against every way life can end:

- reload / hot reload
- disable or uninstall (plugins especially — nothing keeps running after the
  feature is off)
- switching project, session, account, or workspace
- window or view close
- normal stop, forced stop, and restart
- process exit, including the crash path

## Prove there is no leak

Cleanup that is never tested rots immediately.

- Keep a counter of live resources and assert it returns to its baseline at the
  end of a scenario. A number that trends upward across runs is a leak, and it is
  almost always found this way and not by reading.
- In tests, assert the teardown ran — not that the code "should" call it. Check
  the observable effect: no pending timer, no open handle, no listener still
  registered.
- Test the interrupted path, not only the happy one: cancel mid-flight, close the
  window mid-operation, kill the worker while it holds something.

## Error handling crosses all of this

- A rejection inside a fire-and-forget call is an unhandled rejection waiting to
  crash something later. Every detached promise needs a terminal handler.
- A failure during cleanup must not leave the rest of the cleanup undone — do the
  steps that matter first, and keep going past a failure.
- Distinguish "this operation failed" from "this resource is now unusable". The
  first is a retry; the second needs the resource recreated.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
