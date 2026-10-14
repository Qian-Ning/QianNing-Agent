---
name: configuration-and-defaults
description: adding a setting, changing a default value, or loading configuration
---

# Configuration, and the ones people get wrong

**A default is behavior.** Every caller who did not supply the value gets the
default, so changing one changes behavior for them — even when the diff shows no
logic change at all. Treat it as a behavior change, in the message and in the
review.

## Decide precedence, then write it down

Any nontrivial program ends up with several sources. Pick an order and state it,
in the documentation and in the code:

```
explicit argument  >  environment variable  >  project config file  >  user config file  >  built-in default
```

Once chosen, implement it in **one** place. When each source is merged ad hoc at
its point of use, the effective value depends on which code path reads it first,
and debugging becomes archaeology.

Where precedence matters, provide a way to **print the effective configuration**
with the source of each value. The first question in any configuration bug is
"which one won", and printing it answers it in seconds.

## Validate at load, not at use

- Parse and validate every value **when the configuration is read**, at startup,
  and fail with a clear message naming the key and the expected form.
- A bad value discovered hours later, on the code path that first needs it, is an
  outage that a startup check would have caught.
- Fail **loudly** on a missing required value. A silent fallback to something
  "reasonable" is how a misconfiguration survives to production and produces
  wrong answers instead of an error.
- Validate types, ranges, and enumerated values, not just presence. `timeout = 0`
  and `timeout = -1` usually mean "never" by accident.

## Unknown keys: decide and say

- **Ignore unknown keys** — friendly to forward compatibility, and silently
  swallows typos, which is exactly how a setting "does not work".
- **Reject unknown keys** — catches typos immediately, and breaks every older
  version reading a newer file.

Choose one deliberately, and make the failure mode visible either way: warn on
unknown keys even if they are tolerated, and say which.

## The parsing traps

- **Booleans.** In many environments every string is truthy, so `"false"`,
  `"0"`, and `"no"` all mean **true** if parsed naively. Parse explicitly, and
  accept only the forms you document.
- **Numbers as strings.** `"08"`, `"1e3"`, and locale-formatted decimals all
  parse unexpectedly. State the accepted format.
- **Empty versus unset.** An empty string is not the same as a missing key. Decide
  which means "not configured", and handle a key set to empty everywhere.
- **Lists and nested structures.** Environment variables cannot express them
  well. If a value needs structure, it belongs in a file, not in an environment
  variable that callers will join with commas and escape differently each time.
- **Units.** Every numeric setting should have its unit in the name: `_seconds`,
  `_bytes`, `_ms`. A bare `timeout` is a guess someone will get wrong.

## Secrets do not belong in configuration that gets committed

- No keys, tokens, or passwords in a file tracked by version control, including
  in examples and fixtures. Point at where they come from instead.
- Environment variables are not secret storage either, but they are at least not
  committed. Prefer a secret store where the project has one.
- Never log the effective configuration wholesale. A config dump is the classic
  way a credential reaches a log aggregator.

## Runtime-changeable, or restart-required

Say which, for each setting, because callers will assume the convenient one.

- Most settings are read once at startup. Changing the file then does nothing
  until a restart, and an operator will believe it took effect.
- A setting that can change at runtime needs a defined behavior for **in-flight**
  work: does the change apply to what is already running? To new requests only?
- Hot-reload needs a failure story: a bad edit must not take the running process
  down, and must be reported.

## Do not make everything configurable

Every knob is a promise that both settings will be supported, tested, and
explained. A setting nobody ever changes is a maintenance cost and a support
surface, and it doubles the states your tests would need to cover.

Prefer a **good default and no knob**. Add the setting when someone actually
needs the other value, and record why.

## Configuration is data; migrate it like data

- A renamed or restructured setting needs a migration path, or every existing
  installation silently reverts to the default — which, per the first line of
  this document, is a behavior change.
- Support the old name with a deprecation warning for a release before removing
  it, and say in the warning what to use instead.
- Version the file where the shape changes, and refuse to guess when the version
  is not one you understand.

## Test the configuration, not just the code

- Cover the precedence order with a test, so it does not drift.
- Cover the parse failures: a bad boolean, a missing required value, an unknown
  key. These are the paths that only run in production otherwise.
- Exercise the app in a configuration resembling a real one, not in the one your
  development environment happens to have. Config bugs live in the difference.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
