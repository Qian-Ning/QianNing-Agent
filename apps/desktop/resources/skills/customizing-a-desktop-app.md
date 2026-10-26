---
name: customizing-a-desktop-app
description: an installed desktop app you did not write has to change, and the change must survive an update
---

# Changing a desktop application you did not write

You have a packaged application, a directory of resources, and a request to make
it behave differently. Most of the work is deciding which layer to touch, and
almost all of the risk lives in the things that look like names but are
addresses.

## Read the package before you plan the change

A packaged desktop application usually has three parts:

- a **binary** (or a small launcher) that the operating system starts;
- an **archive of application resources** — scripts, HTML, translations,
  sometimes the whole UI — often a single ASAR file next to the binary;
- a **per-user data directory** holding settings, caches, databases, and
  credentials, whose path is derived from an application identifier.

List the archive before assuming anything about how the app is built:

```bash
asar list resources/app.asar | head -40
asar extract-file resources/app.asar package.json
```

Verified on a packed probe archive: the listing came back as `\lib`,
`\lib\util.js`, `\main.js` — **backslash-separated, with a leading separator, on
Windows**. A filter written against `/lib/` matches nothing and silently reports
"no such file", which reads exactly like "the file is not in the build". Normalise
separators before matching, and check the filter against a path you know is
present.

Second verified property, and the one that matters for verification: the archive
is a **snapshot**. A file added to the source directory after packing did not
appear in a subsequent listing — the archive was unchanged. So the folder you
built from is not evidence of what shipped, in either direction: it can contain
files the archive lacks, and the archive can contain files the folder no longer
has.

## Find the boundary: three rings

Sort every possible change into one of three rings, and know which ring you are
in before editing.

**Ring 1 — yours.** Plugins, user configuration, themes, external scripts,
OS-level automation, a wrapper that starts the app with different flags. Safe,
survives updates, and is where most customisation should end up.

**Ring 2 — supported extension points.** A documented plugin API, a local HTTP or
IPC endpoint, a command-line flag, a config schema with unknown-key tolerance, a
protocol handler. Safe *because it is documented*; if you are guessing at it from
the code, you are in ring 3 with extra steps.

**Ring 3 — contract surfaces.** Anything another component, the operating system,
an update server, or a user's existing data refers to by value. Editing these is
sometimes necessary and always a compatibility decision.

The practical rule: **if changing it would orphan something that already exists
on a user's machine, it is a contract.** That is a test you can apply without
understanding the architecture — ask what else already knows this value.

## Identifiers that must not be renamed

These look like branding or tidying opportunities. They are addresses. Renaming
any of them breaks something that is not in the repository.

| identifier | what breaks |
|---|---|
| application id / bundle id | settings directory, install registration, update channel, OS permissions already granted |
| protocol scheme (`app://`, deep links) | every link ever shared, and the OS association |
| user-data directory name | the user's existing profile, settings, and local database |
| keychain / credential-store service name | saved credentials stop being found; the user is silently logged out |
| update feed URL and channel name | updates stop arriving, or arrive from the wrong place |
| file associations and MIME declarations | double-click stops opening the app |
| plugin ids and persisted setting keys | user configuration is ignored and rewritten as defaults |
| IPC channel names shared with a preload bridge | the renderer calls a handler nobody registered |
| database filename and schema version | the app opens an empty database beside the real one |

The distinction that saves you: **the display name is a label; the identity is an
address.** Changing what the window title or the menu says is cosmetic. Changing
the id, the scheme, the profile directory, or a channel name is a migration, and
it needs a compatibility path — read the old location, write the new one, and
keep reading the old one for at least a release.

A cheap guard before any rename: search the whole tree, including tests, build
scripts, installers, and platform manifests, for the literal string. If it
appears in more than one layer, it is an address.

## Process and trust boundaries

Desktop applications split into a privileged process (filesystem, network,
native APIs) and one or more unprivileged view processes. The boundary between
them is the security model, not a code-organisation preference.

- **The bridge is the only door.** A preload script exposes a narrow, named API.
  Exposing the raw IPC object — "so plugins can do anything" — hands every
  renderer, including any injected content, the privileged process's authority.
- **Validate on the privileged side.** A handler that accepts a path, a shell
  command, or a URL from the renderer and acts on it is a privilege escalation
  with a friendly name. The renderer's checks are UX; the privileged checks are
  security.
- **Assume the renderer can be compromised.** Any remote content rendered in a
  view, any plugin loaded into it, any XSS, all run with whatever the bridge
  exposes.
- **Respect the isolation settings you find.** If context isolation is on and
  node integration is off, that combination is load-bearing. Turning either off
  to make a customisation easier converts a contained app into a scripting host.

For customisation this means: prefer adding a handler the bridge already exposes
a call for, over widening the bridge. If the change genuinely requires a new
capability across the boundary, add one narrow, named, validated method — not a
generic `invoke(channel, ...args)`.

## Verifying without breaking the installed copy

The installed copy is the user's working environment. Treat it as production:
change a copy, prove the change there, then decide about the original.

1. **Back up the artefact, not the folder.** Copy the archive and the binary with
   their hashes recorded. The installed tree includes generated files that you
   cannot reconstruct.
2. **Run from a separate profile.** Most applications accept a flag or an
   environment variable that redirects the user-data directory. Use it for every
   experiment; otherwise your test run migrates the real database, and the
   rollback is now a data problem.
3. **Test the upgrade path, not just a fresh start.** Install the previous
   version, let it create a profile, then apply your change. A change that works
   on an empty profile and fails on a real one is the normal case, not the edge
   case.
4. **Check the archive, not the build folder.** After re-packing, list the archive
   and confirm your file is present and the excluded files are absent. Verified
   above: the source directory and the archive diverge in both directions.
5. **Check what the app reports about itself.** Version string, update channel,
   and signature status. A modified archive often reports the old version while
   containing new code, and that mismatch is how a "fixed" build gets reported as
   still broken.
6. **Verify the uninstall and the update.** Does removing the app leave the user
   data? Does the updater replace your change, or fail signature verification and
   leave the app half-updated? Both are user-visible outcomes of your change.

If the app is code-signed, patching the archive invalidates the signature. On
some platforms the app will refuse to launch, on others the update will be
refused, and on others it will run fine until the next release. Know which of
those applies before you ship the patch to anyone else.

## Prefer a reproducible patch to a hand edit

A hand-edited archive is unreproducible, unbisectable, and gone at the next
update. If the change cannot be made through a supported extension point:

- keep the original artefact;
- write the change as a script that takes the original, applies a named
  transformation, and produces a new artefact with a recorded hash;
- keep the transformation small and reviewable, and re-apply it after each
  upstream update rather than editing the new build by hand;
- record which upstream version the patch applies to, and fail loudly when the
  input does not match. A patch applied to an unexpected version produces a
  corrupted app with no error.

That last point is the difference between a patch and a fork in spirit: a patch
states its input, a fork becomes a second product that nobody updates.

## Where this goes wrong

- Renaming the application id while "cleaning up" the branding, and orphaning
  every user's settings, saved logins, and local database.
- Turning off context isolation to make a renderer change easier, converting a
  contained app into one where any rendered content can reach the filesystem.
- Testing on a fresh profile, declaring success, and shipping a change that
  crashes for everyone with existing data.
- Editing the installed archive in place with no backup and no record of what
  changed, so the next update either reverts it silently or fails.
- Writing a path filter with `/` separators against an archive listing that uses
  `\`, concluding the resource is missing, and rebuilding to "fix" it.
- Widening the preload bridge with a generic invoke so a plugin can call
  anything, which is the same as removing the boundary.
- Patching the archive and assuming updates still work; on a signed build the
  update is exactly what stops working.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
