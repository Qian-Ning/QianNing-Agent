# ADR 0333 — A network entry point for the desktop Agent Host

- **Status:** Proposed
- **Date:** 2026-10-27

## Context

`05-remote-agent-control.md` already specifies a control-plane protocol for
driving an Agent Host from another client, and `19-remote-agent-control-protocol.md`
makes that contract normative. Two topologies have shipped from it: the desktop
driving a headless `pi-host` on another machine over an SSH tunnel, and an
outbound messaging integration that runs beside the Host. The document is
explicit that the remaining two — gateway routing and browser access — are
*fully specified but unscheduled until a product decision schedules them*.

This ADR makes that decision. The product now needs a phone and a browser as
first-class clients, because every comparable tool ships one, and a desktop-only
agent reads as unfinished next to them.

Two facts shape what can be built:

1. **The logical Agent Host is already Electron Main** (`05-remote-agent-control.md`
   §5.1, phase one). `pi-host` is the same module deployed elsewhere. The
   desktop therefore does not need to become a client of a second Host on
   `localhost`; it needs a transport on the Host it already is.
2. **Nothing in the desktop listens today.** `bindRacpWebSocket` has zero call
   sites under `apps/desktop`; every RACP connection originates from the desktop
   as a client. Authentication is nonetheless complete on the server side:
   single-use pairing tokens, long-lived device tokens stored as SHA-256, roles,
   `timingSafeEqual`, no credential in a URL.

The gap is transport, a client, and an exposure policy — not a protocol.

## Decision

### 1. Transport: implement `RACP-HTTP`, not a second protocol

`RACP-HTTP` maps each existing operation to one HTTP request with a JSON body
and carries events over `text/event-stream`. It is already normative, so the
desktop gains a transport, not a dialect: one operation table, one conformance
suite, two bindings.

The WebSocket binding stays the transport for machine-to-machine links (desktop →
remote `pi-host`, install bootstrap). The HTTP binding is what a browser and a
phone can actually hold open.

### 2. Host placement: Electron Main grows a listener; the desktop does not become a client

The network transport is attached to the Agent Host that already exists in
Electron Main, reaching sessions through the existing router's local branch.
Sessions keep one owner and the renderer keeps using IPC — no renderer path
changes, and no second Host process appears on a user's machine.

Rejected alternative: retargeting desktop sessions onto a `localhost` `pi-host`.
It would unify the topologies at the cost of rewriting session ownership,
persistence hand-off, and startup supervision — a core rewrite to avoid adding a
transport.

### 3. Client: a responsive Web client first; an installable shell is a later stage

The first client is a responsive Web UI served by the Host, usable from a phone
browser in a normal tab. It is deliberately **not** a native app and **not** a
reuse of the desktop renderer:

- A native app is an order of magnitude more work than the transport it would
  exercise, and cannot be justified before the transport has proven itself.
- Reusing the renderer would force every IPC call through a transport-neutral
  abstraction before anything ships. The consistent-UI payoff is real but it is
  a second project; the duplicated-UI cost is bounded because the client is
  intentionally small (sessions, conversation, approvals).

**Installing it on a phone home screen requires a secure context.** A plain
`http://` LAN address cannot register the service worker that makes a Web app
installable. TLS is therefore a prerequisite for the *installable* form and is
scheduled with the exposure work, not with the client. A phone browser tab is
the honest minimum, and it is what the first stage must deliver.

### 4. Exposure: loopback by default, LAN only by explicit action, no built-in tunnel

- The listener binds `127.0.0.1` unless the user turns network access on.
- Turning it on is a deliberate, confirmed action in settings, which shows the
  bound address, generates a pairing QR code, and requires an unexpired
  single-use pairing token for the first device.
- **No built-in public tunnel.** Shipping a tunnel means a third-party binary,
  its updates, certificate handling, and a public surface the product then owns.
  Users who need off-LAN access get two documented paths: their own overlay
  network, or their own reverse proxy with TLS. This keeps the product's
  security promise equal to what a user configured themselves.

### 5. Stages, each ending in a demonstrable artifact

| Stage | Deliverable | Proof |
| --- | --- | --- |
| P1 | `RACP-HTTP` binding on the desktop Host | A script drives one turn end to end and receives events over SSE |
| P2 | Minimal Web client: sessions, conversation, approvals | A turn is run and a tool approval answered from a browser |
| P3 | Exposure controls + TLS + pairing QR | A phone pairs, connects over TLS, and resumes after a reconnect |
| P4 | Phone layout, and the installable form | The same session is driven from a phone home-screen icon |

No stage ships a layer with nothing to demonstrate. P1 does not wait for a UI;
P2 does not wait for TLS.

## Consequences

**Positive**

- A phone and a browser become clients of the same Host, with the same
  permission, workspace, secret, and tool boundaries — because it is the same
  Host, not a second one.
- The wire contract, auth model, and event replay already exist; the new code is
  a binding plus a client.
- Reconnect and event replay are protocol features already, so mobile networks
  do not require a new durability design.

**Negative / costs**

- The desktop gains a network listener where it previously had none. This is the
  single largest security-surface change in the product's history and it is why
  the default is off, the bind is loopback, and the first device pairs.
- Two clients means two surfaces to keep honest. The mitigation is scope: the Web
  client stays small until the transport is proven.
- TLS brings certificate handling into the product for the first time. Self-signed
  material and its trust prompt are a support burden, and the ADR does not
  pretend otherwise.
- Rate limiting, failed-attempt lockout, SSE CSRF/CSP rules, and an audit trail of
  paired devices are **required companions** to the first listening release, not
  follow-ups.

## Alternatives considered

- **Built-in public tunnel.** Rejected: third-party binary, update path, and a
  public surface the product owns. Users who need it can bring their own.
- **Native mobile app.** Rejected for now: cost is dominated by the shell, not by
  the capability, and the transport has not yet proven itself.
- **Reusing the desktop renderer for the Web client.** Rejected for the first
  stage: it requires transport-neutral IPC before any user-visible value ships.
  Revisit once the client's feature set stabilizes.
- **A separate relay process.** Rejected: it would add a listener, a trust
  boundary, and a failure mode per request to solve a problem the Host can solve
  in-process.

## Follow-ups

- Rate limiting, lockout, and paired-device audit as part of P3, not after it.
- A capability statement the client can read, so a browser does not offer what the
  Host cannot do.
- Revisit renderer reuse in P4 with the client's real feature set in hand.
- Documentation for the two supported off-LAN paths (overlay network, reverse
  proxy) written when P3 lands, not before.
