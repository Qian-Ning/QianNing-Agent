---
name: file-and-path-handling
description: code builds paths, reads or writes files, or accepts a path from outside
---

# Files and paths

A path is not a string, and the operating system will disagree with your
assumptions in ways that only show up on someone else's machine.

## Never build a path by concatenation

Use the platform's join and resolve helpers. String concatenation breaks on:

- **Separators**: `/` and `\` differ, and both appear in real inputs. Never
  hardcode either one.
- **Doubled separators** and trailing separators, which some APIs treat as a
  different path and some normalize away when you were not expecting it.
- **Absolute paths** on the right: joining `C:\a` with `D:\b` is not what string
  addition says it is.
- **Windows drive-relative and UNC forms**: `C:foo` is not `C:\foo`, and
  `\\server\share` has its own rules.

`a + "/" + b` is the line that later becomes a bug report about one platform.

## Case sensitivity, and the bug that hides until production

- Linux distinguishes `File` from `file`; the common macOS and Windows
  filesystems often do not. A hardcoded import or lookup that works on your
  laptop can fail on the server, or the reverse, and never in both places.
- Never rely on case-insensitive matching working. Where a user-supplied name
  must be unique, compare case-insensitively **and** say so — otherwise you have
  two files that collide on one platform and not the other.
- Do not use a path as a map key, or as a cache key, without normalizing it
  first; `./a`, `a`, and `/full/a` are the same file and three different strings.

## Normalize and resolve before comparing or trusting

- Resolve to an absolute, normalized form **before** any comparison, dedupe, or
  permission decision.
- Symlinks, junctions, and mount points mean the path you were given and the file
  you will actually touch are different things. Resolve when that distinction
  matters — and know that a delete or a recursive walk that follows them can
  leave the tree you intended to operate on.
- **On Windows, remove the link before deleting a tree.** A junction deleted by a
  recursive removal can take the target with it.

## Traversal: the classic security failure

A path that came from outside — a request, a plugin, a config, an archive entry,
a model response — can contain `..`, an absolute path, or a symlink pointing out.

- Resolve the candidate, then verify it is **inside** the intended root. Compare
  with the resolved root, not with a string prefix: `/data/foo` is a prefix of
  `/data/foobar`, so prefix checks pass things they should not.
- Reject absolute paths from untrusted input unless the operation is explicitly
  about an absolute path.
- Do the check after resolution and before opening, and check every path used for
  a write, delete, or read that escapes the sandbox's purpose.
- Sanitizing by removing `../` is not enough — encoded, doubled, and
  platform-specific forms slip through. Resolve, then compare.

## Platform rules that bite

- **Reserved names on Windows**: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
  `LPT1`–`LPT9`, with or without an extension, in any directory. A user who names
  a project `aux` gets a case that works everywhere except one platform.
- **Illegal characters** differ: `: * ? " < > |` are invalid on Windows, and `:`
  is valid and common on Unix. A title used as a filename needs a defined
  sanitization, applied consistently.
- **Trailing dot or space** in a Windows path is silently stripped, so two names
  can collapse into one.
- **Path length limits**: Windows still has a traditional 260-character limit,
  and the workaround prefix (`\\?\`) disables some normalization and must be an
  absolute path. Deep directory structures hit this, not long filenames.
- **Encoding**: a path is bytes to the OS. Non-ASCII filenames, and paths
  containing characters that do not round-trip, cause failures that look like
  "file not found" for a file you can see.

## Reading and writing safely

- **Check the mode you open with.** Truncating a file you meant to append, or
  appending to a file you meant to replace, is a one-line data loss.
- **Write atomically** where a reader may see the file: write to a temporary file
  in the same directory, flush it, then rename over the target. A rename within a
  filesystem is atomic; writing in place is not, and a crash leaves a truncated
  file that looks valid.
- **Flush and close** before declaring success, and handle partial writes — a
  write can return fewer bytes than you gave it.
- Locking is advisory on some platforms and mandatory on others. Where two
  processes may touch the same file, say which mechanism you rely on and what
  happens when the lock is unavailable.
- Treat the file as changing **during** your read: check that it still exists and
  still has the size you expect where the reasoning depends on it.

## Relative paths and the working directory

A relative path is interpreted against a current directory that the process, a
parent, or a scheduled task can change. Prefer absolute paths resolved once, at
startup, from a defined base — and never depend on the working directory being
where you think it is when a process is launched by something else.

## Before shipping

- Test on both a case-sensitive and a case-insensitive filesystem if the code can
  run on both.
- Test with a path containing a space, a non-ASCII character, and a very long
  segment.
- Test the traversal cases explicitly: `..`, an absolute path, an encoded form,
  and a symlink pointing outside the root. These are the ones a bypass hides in.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
