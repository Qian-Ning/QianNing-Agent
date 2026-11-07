# ADR 0343: The pairing link and the listener that survives a restart

- Status: Accepted
- Date: 2026-11-07
- Related: `packages/host-runtime/src/remote/listener.ts`,
  `packages/shared/src/pairing-link.ts`,
  `apps/desktop/electron/main/bootstrap/startup.ts`,
  `apps/desktop/src/features/settings/RemoteAccessCard.tsx`,
  `apps/mobile/src/remote/computers.ts`

## Context

Remote access grew two pieces of state that nothing recorded.

The listener was a socket created when the user opened Settings and switched it
on. A socket is process state: quitting the app closed it, while the phone kept
the pairing it had been given and dialled a port nobody answered on. The phone
showed `failed to connect to /192.168.10.104 (port 6838) … after 15000ms`, which
is true and useless — nothing on either screen said that remote access had
quietly turned itself off at the last restart.

Pairing was two fields. The desktop card already copied one string —
`https://<ip>:<port>/app#t=<token>`, the address in the origin and the device
token in the fragment — but the phone asked for the address and the token
separately, so a person had to take one string apart by hand. A second copy of
the format lived in the phone's own parser, and the two could drift apart by a
fragment key without anything failing loudly.

## Decision

**The listener records the user's choice and restores it at boot.** A successful
start writes `remote/enabled.json` with the exposure it used; `stop()` removes
it, so the file means "the user wants this listening" rather than "it happened
to be listening once". `resume()` reads it at startup and binds, retrying over
roughly half a minute because a laptop finishes launching before its network
associates — an absent address a second after boot is a timing fact, not a
decision. A failed bind closes the half-built server so the retry does not stack
a second one.

**One definition of the pairing link, in `packages/shared`.** `parsePairingLink`
accepts the desktop's link, the same link without the shell path, and the two
values a chat client may leave on one line. It refuses plaintext origins and a
link without a port or token, returning null rather than throwing, because a
paste that is not a link is an ordinary thing for a person to do. The QR code the
desktop draws carries the same string, so scanning and pasting take the same code
path.

## Consequences

- Remote access now survives a restart, including an app update. A user who
  turned it off is not turned back on: the file is gone.
- The data directory carries one more file, and a reinstall of the app into the
  same profile inherits the previous choice. That is the same posture as the
  device records beside it.
- The phone has one input for pairing. Manual entry survives behind a switch for
  people who prefer it.
- `resume()` may log a warning and give up when no usable address exists (an
  offline laptop, a host with no LAN). Remote access then reads as off in
  Settings, which is visible, unlike the previous silence.
