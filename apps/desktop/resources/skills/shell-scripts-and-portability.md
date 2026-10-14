---
name: shell-scripts-and-portability
description: writing or debugging a shell script, or it fails on another machine
---

# Shell scripts

A shell script is a program with a runtime that silently changes meaning based on
the words around it. Most of what follows is about making that happen
deliberately.

## Start with the interpreter, then set the failure behaviour

```sh
#!/usr/bin/env bash
set -euo pipefail
```

- **`set -e`** — exit on an unchecked command failure.
- **`set -u`** — treat an unset variable as an error instead of an empty string.
- **`set -o pipefail`** — a pipeline fails if **any** stage fails, not only the
  last. Without it, `cmd | tail` reports the exit code of `tail`, which succeeds
  even when `cmd` failed. This is the single most common way a script reports
  success for work that did not happen.
- Know the gaps in `set -e`: it does not fire for a command whose failure is
  tested (`if`, `&&`, `||`, `!`), and it does not fire inside a subshell the same
  way. Where the outcome matters, check explicitly: `cmd || exit 1`.

## Quoting is not optional, and the default is surprising

A shell splits words and expands globs **after** variable substitution unless you
quote. That is backwards from most languages, and it is the source of most shell
bugs.

- `"$var"` — always. `$var` unquoted breaks on spaces, glob characters, and empty
  values.
- `"$@"` — always, when forwarding arguments. Unquoted `$@` re-splits the caller's
  arguments; this is how a wrapper script corrupts the arguments it was given.
- `"${var:-default}"` for a fallback, `"${var:?message}"` to **fail** when a
  variable is unset. Use the second one in front of anything destructive.
- Use `$(command)` rather than backticks: it nests, and it reads correctly.
- **Do not parse `ls`.** Use a glob, or `find` with `-print0` and a read loop.
  Filenames can contain newlines.

## Know which shell you are actually writing for

- `#!/bin/sh` promises POSIX and nothing more. `#!/usr/bin/env bash` promises
  bash, and says so. Pick one deliberately, and do not write bash features under a
  `sh` shebang.
- Not POSIX, and therefore wrong under `sh`: `[[ ]]`, arrays, `local`, `$'...'`,
  process substitution `<(...)`, `+=`, and `echo -e`.
- **`echo -e` is not portable.** Use `printf`, which also handles the cases where
  `echo` interprets a leading dash or a backslash.
- **`read` without `-r` eats backslashes.** Always `read -r`.
- `[ ]` and `[[ ]]` differ in how they handle empty strings and pattern matching.
  Use `[ ]` if you need portable, `[[ ]]` if you have named bash.

## Make failure loud and cleanup automatic

- **Check that the tools you need exist**, before you need them:
  `command -v git >/dev/null || { echo "git not found" >&2; exit 1; }`
- **`cd` can fail.** `cd "$dir" || exit 1`, then work relative to a known place.
  A script that continues in the wrong directory does something worse than fail.
- **Temporary files:** create with `mktemp`, and clean up on every exit path:
  `trap 'rm -f "$tmp"' EXIT INT TERM`.
- **Never `rm -rf` on an unvalidated variable.** `rm -rf "${dir:?}"` refuses to
  expand an empty value; `rm -rf "$dir/"` with an empty variable expands to
  `rm -rf /`, and there is no recovering from that. Validate the path exists and is
  the shape you expect before anything destructive.
- **Write the guard for the failure you are afraid of.** If the risk is deleting
  the wrong directory, the guard checks the directory is the right one — not just
  that the variable is set.

## Paths, and this repository's environment in particular

- **A Windows shell running a POSIX emulation does not translate paths for native
  programs.** Git, Node, and other native binaries want a native path; a path that
  works for `cd` may fail when passed to them. Convert explicitly when crossing
  that boundary.
- **MSYS-style paths are not readable by native tools**, and the temporary
  directory is often one of them. Convert before passing.
- **Line endings matter.** A script with CRLF endings fails on a POSIX system with
  errors about `\r` that name the wrong thing. Let the repository's attributes
  decide, and never let an editor change them silently.
- Prefer forward slashes in paths inside scripts; they work where backslashes do
  not.

## Other people's machines

- **State the assumptions.** A script that needs a specific tool version should
  check it and say what it found.
- **Idempotence is worth the effort**: a script that can be run twice without
  harm is a script people will run without fear. Guard the steps that are not
  naturally repeatable — appends, registrations, and installs.
- **Print what you are doing and to where.** A silent script that fails is worse
  than a loud one that works, because nobody can tell which happened.
- **Where output is piped**, remember `pipefail`: the exit code you are relying on
  is the one at the end of the pipe unless you have set it.

## Testing a shell script

- Run it through a linter if one is available for the shell you chose; it finds
  unquoted expansions and non-portable constructs faster than reading will.
- **Check the exit code, never the output.** A script can print a perfect success
  message and still have failed, and it can exit zero while printing a message
  about what it could not do.
- Test the paths that fail: a missing tool, an unset variable, a path with a
  space in it, an already-existing output file, a second consecutive run.
- Test it in the shell it declares, not the shell you happen to be sitting in.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
