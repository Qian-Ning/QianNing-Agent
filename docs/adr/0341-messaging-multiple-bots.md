# ADR: More than one bot per messaging channel

- Status: Accepted
- Date: 2026-11-01
- Related: `packages/host-runtime/src/messaging-gateway-registry.ts` (the
  registry and snapshot); [messaging settings](../spec/04-ux/06-settings-ia.md);
  [process card](0340-messaging-process-card.md)

## Context

One platform, one bot. That assumption is not written down anywhere, but it is
baked into three contracts:

- **The registry** keys a running loop by channel *type*: `running:
  Set<MessagingGatewayChannel>` holds `"telegram"`, not "this Telegram bot".
  A second Telegram loop cannot exist without replacing the key.
- **The snapshot** is twelve flat booleans (`telegram: boolean`, `slack:
  boolean`, …) going through IPC to the settings page. There is no place in the
  shape for a second bot of the same platform, and no place for its label,
  status, or failure reason.
- **Settings** hold one record per platform section (`messagingTelegram`, …)
  and one secret ref per channel. A second bot would overwrite the first.

Users who want a work bot and a personal bot on the same platform currently run
a second instance of the app, which also means a second database, second
sessions, and a second set of credentials.

## Decision

**1. Identity is `channelId = <platform>:<botId>`.** `botId` is a UUID minted
when a bot is first saved, stable for that bot's lifetime. Every existing record
projects to `<platform>:default`, so nothing in the running system needs a new
identity to keep working on upgrade.

**2. The registry keys by `channelId`.** `running` becomes a map from
`channelId` to that bot's loop, failure state and start generation. Lifecycle
operations (start, stop, restart-after-settings-write) address a `channelId`.
This is the change that makes two loops of the same type coexist, and it is the
only place where "one per type" is enforced today.

**3. The snapshot grows a per-bot list and keeps the booleans as a derived view.**
`MessagingGatewaySnapshot` gains:

```ts
channels: Array<{
  id: string;            // "<platform>:<botId>"
  platform: MessagingGatewayChannel;
  label: string;         // the user's name for this bot, or the platform's
  running: boolean;
  failure: string | null;
}>;
```

The twelve booleans stay, each meaning "any bot of this platform is running",
for one release. The settings page reads `channels` when it is present and falls
back to the booleans otherwise, so an older renderer against a newer Host keeps
working. Removing the booleans is a separate change with its own ADR.

**4. Persistence is additive, and the existing section stays the first bot.**
`messagingTelegram` (and its siblings) keep their current shape and become the
record of the bot with `botId: "default"`. Additional bots live in a new
`messaging.bots` array, each entry carrying `{ platform, botId, label,
section, secretRef }`. A migration at startup copies nothing: absence of
`messaging.bots` means one bot per platform, which is exactly today's meaning.
Downgrading the app ignores `messaging.bots` and keeps running the default bot.

**5. Each bot owns its own secret.** The ref is
`messaging.<platform>.<botId>.token`; the default bot keeps the existing ref so
upgrade does not ask for the token again. Credentials are never shared between
bots implicitly, because two bots of the same platform usually belong to
different accounts.

**6. Limits are explicit.** At most 8 bots per platform and 24 in total, refused
at save time with a typed error the page can render. The limit exists because
every bot is a live loop, a socket and a polling budget.

**7. The webhook receiver routes by `channelId`.** It is the one surface two
bots can share: one port, one listener. A route becomes
`/webhook/<platform>/<botId>`, and the receiver resolves the signing secret from
that `channelId`. A request for an unknown `botId` is answered 404 without
revealing which ids exist. The local API server binds its own port per bot and
is out of scope for this ADR.

## Alternatives considered

- **Keep one bot per platform and let users pick which account.** Rejected: it
  solves nothing for the work/personal case, which is the actual request.
- **Key the registry by platform and let the bot be a property of the loop.**
  Rejected: two loops of one platform would still collide on the key, so the
  collision just moves one layer down.
- **Put every bot in `messaging.bots` and migrate the old sections into it.**
  Rejected for now: rewriting the live settings row on upgrade is a data
  migration with a rollback risk, for a shape the new code does not need.
- **Share one secret across bots of a platform.** Rejected: the common case is
  two different accounts, and a shared ref invites a silent cross-account send.

## Consequences

- The registry, the snapshot and the settings writers change together; none of
  them can ship alone without leaving a half-addressed contract.
- The settings page groups by platform and shows a row per bot with its own
  status. The card list from the cards work becomes a list of *bots*, not of
  platforms, with the platform as the group heading.
- Inbound bindings move from per-section to per-bot: a second bot on the same
  platform must not inherit the first bot's linked chat.
- The webhook route change is visible to anyone who configured a webhook by
  hand. The old path stays as an alias for the default bot for one release.
- Tests to add: two bots of one platform both run; stopping one leaves the other
  untouched; a snapshot with `channels` renders in an old page; a settings row
  without `messaging.bots` still starts one bot.

## Rulings

1. **Eight per platform, twenty-four in total, as constants.** Anyone who wants a
   ninth bot wants a different product, and a setting for the cap costs a field,
   a validation path and a test for a case nobody has.
2. **A re-upgraded app starts its bots silently.** They were running before the
   downgrade; asking the user to confirm what the app already decided once is
   noise, and the card list shows what is running either way.
3. **The local API server stays one instance per machine.** It binds a port and
   exists to be reached from outside; a second one is a second port, which is a
   different feature, not a second bot.
