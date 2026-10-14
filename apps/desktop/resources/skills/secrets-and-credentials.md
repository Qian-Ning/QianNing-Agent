---
name: secrets-and-credentials
description: handling API keys, tokens, passwords, or any credential in code
---

# Secrets and credentials

A secret's whole value is that it stays in one place. Every path below is a way
it ends up somewhere else.

## The rules that have no exceptions

- **Never commit one.** Not in source, not in a test, not in a fixture, not in a
  comment, not in an example, not in documentation, not in a screenshot pasted
  into an issue. Not even temporarily, and not even in a branch you will delete.
- **Never print one.** Not to a log, not to standard output, not into a bug
  report, not into a chat message, not into a summary of what you did. When a
  value must be referred to, write a placeholder (`[REDACTED]`) and the location
  it comes from.
- **Never paste one into a form or a prompt** to make something work. If a tool
  needs to authenticate, use the tool's own credential path.
- **Never echo a secret back to whoever supplied it**, not even as confirmation
  that it was received.

If you need to know whether a secret is *present*, check that it is non-empty, or
its length, or its last four characters if the format allows. Never the value.

## Reading one without exposing it

- Load from the environment, a secret manager, or a file outside the repository
  that the process is granted access to.
- Error messages must name the **variable or key that is missing**, never the
  value that was found. A config dump is the classic way a credential reaches a
  log aggregator.
- Do not build diagnostic output by serialising a settings object. Choose the
  fields, and let the secret be one you never included.
- Redact at the point of logging, in a shared helper, so the safe path is the
  default one. Relying on remembering is relying on the day you are busiest.

## Storing

- **Environment variables are not secret storage.** They are better than a
  committed file, and they leak through process listings, crash dumps, and child
  processes that inherit them.
- Prefer a secret manager where one exists: it gives you access control, audit,
  and — most importantly — **rotation**.
- File permissions matter: a secret file readable by every user on the machine is
  a secret shared with every user on the machine.
- Nothing in memory is fully protected. Accept that, and keep the lifetime short
  rather than pretending.

## Design for rotation from the start

- **A credential you cannot rotate is a credential you will have to replace by
  hand at the worst possible moment.**
- Support two valid credentials at once during a rotation window, so a rotation
  does not require simultaneous change on both sides.
- Decide who rotates, how, and how you would notice it needs doing — an expiry
  warning long before the expiry.
- Where possible, prefer short-lived credentials obtained from a longer-lived
  identity, so the blast radius of a leak is bounded by time.

## Scope, and separation

- **Least privilege**: the token gets the permissions the task needs, not the
  ones the account has.
- **Separate environments.** Development
  credentials must not be usable against production, and production credentials
  must not be sitting on a developer's machine.
- One credential per consumer where practical. A single shared key means a
  rotation is a coordinated outage, and an audit cannot tell who used it.
- **Do not collect what you do not need.** A credential you never store cannot
  leak, and personal data collected "in case" is a liability with a database.

## Identifiers are not secrets, and are treated like secrets anyway

Machine identifiers, serial numbers, MAC addresses, and hostnames are not
credentials, and they are still worth keeping out of public output: they are
identifying, and they are the first thing an attacker uses to look up a known
vulnerability for your exact hardware or version.

Distinguish the two categories in your own writing. Conflating them either
protects something that does not need it, or exposes something that did.

## When one leaks

Order matters, and it is counterintuitive:

1. **Revoke and replace it first.** Everything else — understanding, notifying,
   writing the report — waits. Do not investigate while it is still live.
2. **Then find the exposure path**: where it was written, who could read it, how
   long it was exposed.
3. **Then fix the path**, so the next one does not leak the same way.
4. **Then write it down**, honestly, including how long you did not know.

Two things that are not steps:

- **A secret that was committed stays in the repository's history**, in every
  clone, forever. Rewriting history does not clean the clones that already
  exist, and it breaks everyone who has pulled. **Rotate it. That is the fix.**
- **Deleting the message, the file, or the log line does not un-send it.**
  Assume anything that was transmitted is compromised.

## Guardrails worth having

- A pre-commit or CI scan for credential-shaped strings, so the accident is
  caught before it is pushed. It catches patterns, not judgement, so it is a
  backstop rather than permission to be careless.
- **A `.gitignore` entry is not a security control.** It prevents the accident
  where you are careful; it does nothing about the day someone uses `add -A`.
- Secrets never baked into a build artifact. Build outputs get archived, cached,
  shipped, and read by people you did not intend.
- Nothing in a URL that is logged by default. Query strings and paths end up in
  access logs, proxies, and error reports.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
