---
name: python-debugpy
description: a Python process raises, returns a wrong value, or hangs — step it, or attach debugpy to a process you cannot restart
---

# Debugging Python at a breakpoint

Two tools, two jobs. The standard library debugger runs a script you own, in the
terminal you already have. `debugpy` attaches to a process you did not start —
a container, a service, another user's worker — and speaks the debugger protocol
to a client. Pick by problem, not by preference.

## pdb: the local script

```bash
python -m pdb app.py
python -X faulthandler -m pdb app.py
```

The commands you actually need at the `(Pdb)` prompt:

- `b app/db.py:42` or `b save_note` — breakpoint by line or by function.
  `tbreak ...` is the same but removes itself after the first hit.
- `c` continue, `n` next line (over calls), `s` step into, `r` run to return.
- `u` / `d` move up and down the stack; the prompt then shows that frame's
  source and evaluates in its locals.
- `w` where — the current stack with the frame you are standing in marked.
- `l` list source around the line; `ll` the whole function.
- `p expr` prints, `pp expr` pretty-prints, `!stmt` executes a statement
  (`!pending.clear()`). `interact` opens a full interpreter in the current frame
  when you need more than one expression.
- `q` quit.

`breakpoint()` in the source does the same thing where it sits, provided
`PYTHONBREAKPOINT` is unset — the default hook is this debugger. Set
`PYTHONBREAKPOINT=0` to neuter every `breakpoint()` call in a batch run without
editing code.

## Post-mortem: the failure already happened

When the traceback is the interesting part, stop at the frame that raised
instead of guessing where to break:

```python
import pdb

try:
    compute(row)
except Exception:
    pdb.post_mortem()   # no argument: the exception currently being handled
```

That lands in `compute`'s frame with its locals intact. `pdb.post_mortem(tb)`
takes an explicit traceback, which is what you use when you kept it from an
earlier failure.

**Do not reach for `pdb.pm()` inside a script.** It reads `sys.last_traceback`,
which only the interactive interpreter sets, so in a file it fails with
`AttributeError: module 'sys' has no attribute 'last_traceback'` — right at the
moment you needed the debugger most. `pdb.pm()` is for the REPL after an
uncaught exception.

`python -m pdb app.py` also stops at the death frame, which is the quickest route
when you have no handler of your own. Note that after the post-mortem prompt
exits, this mode restarts the program rather than exiting — useful for iterating,
confusing if you expected the shell back.

For a hard crash with no Python-level traceback, run with `PYTHONFAULTHANDLER=1`
(or call `faulthandler.enable()` at startup). The interpreter then dumps every
thread's stack on a fatal signal, which is often the only evidence a segmentation
fault leaves.

## debugpy: launch a process under the debugger

```bash
python -m pip install debugpy
python -m debugpy --listen 127.0.0.1:5678 --wait-for-client app.py
python -m debugpy --listen 127.0.0.1:5678 -m pytest tests/test_api.py -x
```

The CLI surface is: `--listen <host>:<port>` or `--connect`, `--wait-for-client`,
`-m <module>`, `-c <code>`, `--pid <pid>`, `--log-to <path>`, and
`--configure-<name> <value>`.

- `debugpy` is an adapter, not a terminal UI. It listens on the port and speaks
  the debugger protocol; something has to connect and talk to it. Without a
  client, `--wait-for-client` waits forever.
- **`--wait-for-client` blocks before any of your code runs and prints nothing.**
  It looks exactly like a hang. That is the intended behaviour, and it is the
  first thing to check when "the debugger will not attach and the app never
  starts".
- On 3.11 and newer, start the interpreter as `python -Xfrozen_modules=off` or
  the adapter warns that frozen modules are in use and breakpoints in startup
  code are missed. Set `PYDEVD_DISABLE_FILE_VALIDATION=1` when files are
  generated or rewritten while the session is live.
- Confirm the listener before blaming the client:

```bash
python -c "import socket; s=socket.socket(); s.settimeout(1); print(s.connect_ex(('127.0.0.1', 5678)) == 0)"
```

## Attaching to a process that is already running

```bash
python -m debugpy --listen 127.0.0.1:5679 --pid <pid>
```

- **Linux and macOS:** works when the target is the same user and the kernel
  permits it. A hardened ptrace scope (`/proc/sys/kernel/yama/ptrace_scope` set to
  2 or 3) blocks the attach; a container without `SYS_PTRACE` blocks it too. The
  failure is usually reported as a permission error, not as "unsupported".
- **Windows:** verified on this project's hosts that the attach injects a DLL
  into the target (`Injecting attach dll: attach_amd64.dll into pid: ...`). It
  needs a matching 32/64-bit interpreter, takes seconds, and endpoint protection
  can refuse the injection. When you control the launch, start the process under
  `-m debugpy` instead of attaching afterwards.
- The target pauses when a client connects, which is the point: you see where it
  actually was, not where you assumed.

## Breakpoints that actually get hit

- Put `import debugpy; debugpy.breakpoint()` on the line you care about. This
  registers with the adapter directly; a plain `breakpoint()` goes to the
  standard debugger, not to `debugpy`, unless `PYTHONBREAKPOINT` says otherwise.
- Break inside a function, not at module top level, if the module is imported
  before your client connects. Code that ran before the connection cannot be
  stopped retroactively.
- `python -O` removes `assert` statements and anything under `if __debug__:`. A
  breakpoint there is not "flaky", it is gone.
- Breakpoints bind to the file path the adapter validated. A container that sees
  `/app/src/x.py` where your client says `/Users/you/src/x.py` needs a path
  mapping, or the breakpoint lands on an unrelated line — or nowhere.

## The hung process

A hang has no traceback, so get one:

```python
import faulthandler
faulthandler.dump_traceback_later(30, repeat=True)   # every thread, 30 s from now
```

Registered at startup, this turns "it stopped responding" into a stack dump.
On POSIX, `faulthandler.register(signal.SIGUSR1)` plus `kill -USR1 <pid>` gives
you a dump on demand, with no debugger and no restart. Windows has neither
`SIGUSR1` nor `SIGALRM`: use the timer route, or attach and read the stack.

Read the dump from the top frame down and name the wait: a lock, a socket read, a
queue `get`, a `join` on a thread that will never finish. If the top frame is
inside the standard library, the caller is the answer, so keep reading down.

## Where this goes wrong

- Leaving `--wait-for-client` in a start script. The service never starts, and
  nothing in its output says why.
- Starting a second listener on a port that is already bound. The import fails
  or the adapter exits; check the port before re-running the command with more
  flags.
- Attaching to a worker pool by pid and expecting the children. The debugger is
  in the process you attached to; each child needs its own listener, launched at
  fork time.
- Debugging with a breakpoint in a hot loop and then judging performance from
  that run. The debugger costs orders of magnitude; measure without it.
- Trusting a client's "connected" indicator without confirming the target paused.
  An adapter that is listening and a session that is stepping are different
  states.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
