---
name: error-handling-design
description: error paths, failures, or exception handling are being written or reviewed
---

# Designing error handling

An error is a value with a meaning. Almost every bad error path comes from
changing its meaning, or from handling a failure the handler cannot actually
handle.

## Sort failures into three kinds, first

The distinctions below only work if you know which kind you are looking at.

1. **Expected failures.** Invalid input, a missing record, a user cancelling, a
   permission denied. These are part of normal operation. They get a defined
   result and a defined message, and they are not logged as errors.
2. **Operational failures.** A timeout, a network blip, a dependency down, a
   disk full. Transient or environmental. These are the ones a retry or a
   degradation is for, and they need a real story about what the caller sees.
3. **Defects.** A null where the code promises a value, a state that cannot
   happen, an invariant broken. These are bugs. The correct handling is to fail
   loudly with enough context to fix it, not to continue as if nothing happened.

Conflating these is the root of most bad error handling: a defect is swallowed
because it looked like a transient failure, or a transient failure crashes the
process because it looked like a defect.

## Never swallow

- A `catch` that does nothing — or only logs — is a bug that has been hidden.
  The failure does not go away because it was recorded.
- **A handler must do at least one of four things**: retry it, degrade to a
  defined worse behavior, report it to the caller, or fail the operation. "Log
  and continue" is a fifth option that only exists for genuinely optional work,
  and it needs to say so.
- If the same unexpected error is caught in three places, none of them can tell
  you what happened. Handle it where you have enough context to decide.

## Do not catch what you cannot handle

Catching broad is the standard mistake: `catch (e)` around a large block, which
hides defects and unrelated failures alike. Catch the specific thing you know how
to handle, let the rest propagate, and add a top-level handler only where you can
actually make a decision — a request boundary, a job runner, a process entry.

## Preserve the cause

- When wrapping, **attach the original**, not a string built from it. Losing the
  cause throws away the stack and the detail that would have explained it.
- Do not rewrite the message at each layer into something vaguer. A chain where
  every layer says "failed to process request" is worse than no chain.
- Add context as you go up — which item, which file, which id — without replacing
  what was there.

## Boundaries: validate on entry, once

- **Untrusted input is validated where it enters** — a request, a file, a
  plugin, a model response, a message from another process. After that,
  downstream code can rely on the shape, and does not need to re-check.
- Validating in the middle means some paths were never validated. Validating
  everywhere means no one knows what is guaranteed.
- A validation failure is an **expected** failure: a clear message, no stack, no
  alert. A validation that can crash the process is a defect.

## Return or throw, but consistently

- Pick one style per boundary and keep it. A function that returns `null` for
  "not found" and throws for "database down" is fine, if the difference is
  documented. One that randomly does either is not.
- Do not use exceptions for ordinary control flow. "Not found" is not
  exceptional if it happens constantly.
- An error type that carries machine-readable information is worth more than a
  message: a code, a retryable flag, the field that failed. Callers will switch
  on something; give them something stable.

## Retries

- **Only retry idempotent operations**, or make them idempotent first. A retried
  write is a duplicate.
- Retry **transient** failures: timeouts, connection resets, 5xx, rate limits
  with a hint. Never retry a validation error or a permission failure — the
  answer will not change, and you will multiply the load.
- Use exponential backoff **with jitter**. Without jitter, every client retries
  in step and finishes off a dependency that was recovering.
- Cap attempts and total time, and let the last failure surface. An infinite
  retry loop turns one failure into an outage and hides the original error.

## What the user sees, and what the log holds

- User-facing messages: what happened, what they can do, nothing internal. No
  stack traces, no file paths from your machine, no raw database errors.
- Logs: the opposite. The full chain, the identifiers, the inputs that caused it,
  and the operation being attempted. Logs that say only "error" cost an hour each.
- Do not put secrets or personal data in either. Redact at the point of logging,
  not in the hope that nobody reads it.

## Asynchronous failures

- Every detached promise needs a terminal handler. A rejection nobody awaits is
  an unhandled rejection that surfaces later, somewhere unrelated.
- A failure during cleanup must not leave the rest of the cleanup undone: do the
  steps that matter first, and continue past a failure rather than aborting.
- Distinguish "this call failed" from "this resource is now unusable". The first
  can be retried; the second needs the resource recreated.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
