---
name: node-inspect-debugger
description: a Node process produces a wrong value and prints are not enough - run or attach to the inspector, break, and read the actual locals
---

# Stepping through a Node process

A print statement tells you a value at a place you already suspected. A
breakpoint tells you every local at a place you did not. Reach for the debugger
when the question is "what *is* this object here", not "did this line run".

## Two ways in: start it paused, or attach

```bash
node --inspect-brk=127.0.0.1:9229 dist/main.js     # pauses before the first line
node --inspect=127.0.0.1:9229 dist/main.js         # runs, inspector listening
node inspect dist/main.js                          # run it under the built-in CLI
node inspect 127.0.0.1:9229                        # attach to a listening process
```

- `--inspect-brk` is the one you want for a short-lived script: the process is
  frozen before user code runs, so a breakpoint set after connecting can still
  fire. With plain `--inspect`, a script that finishes in 200 ms is already gone
  by the time you attach, and the debugger reports a closed connection.
- Bind loopback explicitly. Anything bound to `0.0.0.0` on the inspector port
  hands arbitrary code execution to whoever can reach the port; there is no
  authentication in the protocol.
- The process prints a `ws://127.0.0.1:9229/<uuid>` line at startup. That URL is
  the session identity: a proxy or tunnel that strips the WebSocket upgrade
  breaks attachment even though the TCP port is open.

## The built-in CLI, and the commands worth memorising

`node inspect <script>` drops you at a `debug>` prompt. Verified command set:

- `sb(12)` — breakpoint at line 12 of the current file; `sb('dist/db.js', 12)`
  for another file; `cb(12)` clears; `breakpoints` lists them.
- `c` resume, `n` next line in this frame, `s` step into, `o` step out,
  `bt` backtrace, `list` source around the current line.
- `exec <expr>` (or `p <expr>`) evaluates in the paused frame.
  `exec JSON.stringify(row, null, 2)` is the way to read an object; a bare
  `exec row` prints something unhelpful.
- `watch(expr)` / `watchers` / `unwatch(expr)` — re-evaluated at every stop.
- `breakOnException`, `breakOnUncaught`, `breakOnNone` — pause where it throws
  instead of where it fails later.
- `scripts` — every loaded script with its id, which is how you discover the
  real path of a bundled file.
- `repl` opens a fuller expression prompt; `run` / `restart` restarts the
  process; `kill` disconnects.

A session that answers a question looks like this:

```
debug> sb('dist/app.js', 42)
debug> c
break in dist/app.js:42
debug> bt
#0 handler dist/app.js:42:18
#1 (anonymous) dist/app.js:9:5
debug> exec req.body.items.length
0
```

The value at the breakpoint is `0` while the caller believes it sent three
items: the bug is upstream of line 42, and the next breakpoint belongs in the
parser.

## Reading state without changing it

`exec` runs code in the paused frame. That has consequences:

- A getter or a proxy trap **executes**. Reading `exec user.profile` can hit the
  database, mutate a cache, or throw. Prefer reading the field you need.
- Assignments are allowed and persist: `exec cache.clear()` is a real call, not
  a preview.
- `Object.keys(x)` and `exec x.constructor.name` are cheap ways to find out what
  a value actually is when a stack trace claimed it was something else.

## Source maps

If the process runs compiled output, `--enable-source-maps` makes the reported
file and line refer to the original source. Without it, `sb(12)` means line 12
of the bundle, and you will set breakpoints on the wrong statements while the
stack trace looks correct. Turn it on for the debugging run and note that it
changes startup cost.

## When the process is already running

- **POSIX:** `kill -USR1 <pid>` opens the inspector on the default port without a
  restart. This is the only way to debug a process you did not launch.
- **Windows:** there is no `SIGUSR1`, so a process that was not started with
  `--inspect` cannot be attached to after the fact. Plan for it: start the
  launcher with `--inspect`, or set `NODE_OPTIONS=--inspect=127.0.0.1:9229` for
  the child, so the flag is present before the failure.
- `node inspect -p <pid>` attaches by pid on platforms that support it; on this
  project's Windows hosts it fails with an `OpenFileMappingW` error, so attach by
  `host:port` instead.
- **In a container:** listen on `0.0.0.0` *inside* the container, publish the
  port, and attach to `127.0.0.1:<published>` from outside. Keep the publish
  scoped to your own machine.

## When it is not a logic problem

The same session takes the two measurements a profiler would:

```
debug> profile
debug> c
debug> profileEnd
debug> profiles[0].save('cpu.cpuprofile')
debug> takeHeapSnapshot('heap.heapsnapshot')
```

`--cpu-prof` and `--heap-prof` do the same from launch and write on exit, which
is better for a process that dies. Use these before rewriting anything for
speed; see the performance investigation procedure for what to do with the file.

## The failure modes people actually hit

- **The breakpoint never fires.** Three causes, in order of likelihood: the line
  is in a branch that does not run; the file is the bundled path, not the source
  path (see source maps); the module was already loaded before you attached, so
  its top-level code has executed. Breakpoints on a function body still work
  after load — breakpoints on module initialisation do not.
- **The port is taken.** Node prints `Starting inspector on 127.0.0.1:9229
  failed: address already in use` and then **keeps running without a debugger**.
  A second run of the same script, or an editor holding the port, produces a
  process that looks normal and is unsteppable.
- **Two clients on one session.** A CLI attach and an editor attach to the same
  process fight; the second connection can displace the first, and the first
  silently stops receiving events.
- **`debugger;` left in the source.** Harmless without an inspector attached,
  fatal to a batch job when someone later runs it with `--inspect-brk`, because
  the job now stops forever at a line nobody remembers adding.
- **Stepping into async.** `s` on an `await` descends into the runtime's promise
  machinery, which is rarely what you want. Set a breakpoint inside the async
  function and `c` to it instead.

## Leave the process as you found it

Remove the `--inspect` flag from any committed start script; it is a debugging
affordance, not a feature. If a breakpoint or a snapshot was needed to find a
bug, say so in the commit message — the next person will want the same route,
and the value that was wrong is usually the missing test.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
