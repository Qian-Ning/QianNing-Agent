---
name: logging-and-observability
description: logging, metrics, tracing, or alerting is being written or reviewed
---

# Logging so that a future incident can be solved

Every log line should be able to justify itself with a question it answers. The
question to design for is the only one that matters at 3 a.m.: **why did this
happen, to this user, at this time?**

## Design for that question

Answering it needs four things in the record, and they are almost always the
four that are missing:

- **Which operation** — the action being attempted, not the function it lives in.
- **Whose** — the user, session, project, account, or request it belongs to.
- **What happened** — the outcome, not the intention.
- **The correlation id** — the one value that ties every line of one request
  together across processes, so you can read the story in order instead of
  grepping by timestamp.

Add the identifiers you would have wished for during the last incident. They are
cheap; reconstructing them afterwards costs a day.

## Levels are a contract, not a mood

- **error** — something a person may need to act on. Keep this level honest, or
  nobody will read it.
- **warn** — it worked, but a degraded or unexpected path was taken; worth seeing
  in aggregate, not worth waking anyone.
- **info** — normal milestones: started, finished, published, connected.
- **debug** — detail for diagnosis, off in production by default, and switchable
  at runtime without a redeploy.

The common failure is logging expected failures — a bad password, a 404, a
validation rejection — at `error`. Once a level is full of noise, the real alert
is buried in it, and the team responds by muting the alert. **Muted alerts are
worse than no alerts**, because everyone believes they are covered.

## Structured, so it can be queried

- Key-value pairs, not prose. `event=upload.failed size=1048576 retry=2`
  is searchable; "Failed to upload the file after retrying" is only greppable.
- One event per line, with a stable event name. The name is the schema; changing
  it silently breaks every dashboard and alert that uses it.
- Do not build strings by concatenation, and do not log a whole object and hope
  it serializes readably. Choose the fields.
- Field names are an interface. Keep the same name for the same thing, and
  document the event names somewhere the next person will find.

## Never log secrets or personal data

- Credentials, tokens, cookies, connection strings, keys, full request bodies,
  file contents, email addresses, and anything a user would object to finding in
  a log.
- **Redact at the point of logging**, in a helper, not by remembering. A logging
  API that takes a whitelist of fields is a design that makes the mistake hard.
- Errors are the usual leak: an exception message containing a URL with a token,
  or an object whose `toString` includes the payload. Log the error's type and
  message deliberately, not by dumping it.
- Logs get shipped to third parties, indexed, and kept for years. Treat every
  line as if it will be read by someone you did not intend.

## Cost and volume

- A log line inside a loop, or per item in a batch, becomes an outage by volume —
  filling disks, drowning the index, and slowing the request it was meant to
  diagnose.
- Aggregate per batch: one line with a count beats a thousand lines with a
  detail.
- **Sample** high-frequency events (a percentage, or first-N then a summary) when
  the volume is inherent, and say in the line that it was sampled, or the counts
  will be read as totals.
- Rate-limit repeated errors so a broken dependency does not produce a million
  identical lines. Include how many were suppressed.

## Logs, metrics, and traces answer different questions

- **Metrics**: is it getting worse, and since when? Cheap, aggregated, good for
  alerting and trends, bad for explaining a single case.
- **Logs**: what exactly happened in this one case? Detailed, expensive, good for
  diagnosis, bad for alerting.
- **Traces**: where did the time go across services? Good for latency and
  structure, useless without sampling decisions made deliberately.

Putting diagnosis in metrics or alerting on logs is how both become useless.
Alerts should fire on **symptoms** — the thing users feel, like error rate or
latency — and not on **causes** like CPU percentage, which is a diagnosis
hypothesis that will be wrong sometimes.

## Verify it works

- After shipping a change, do the thing it changed and **read the logs** it
  produced. Logging code that is never read is where the missing field is
  discovered at the worst time.
- Once per quarter, take a real question from a real incident and try to answer
  it from logs alone. If you cannot, that gap is the finding.
- Alerts: every one should have a documented action. An alert nobody acts on is
  noise that trains people to ignore the page.

## Correlation across processes

When the work crosses a boundary — another process, a worker, a plugin, a shell
command — the correlation id has to travel with it, in the message, the
environment, or the child's arguments. A trace that stops at the boundary is a
trace that stops exactly where the bugs are.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
