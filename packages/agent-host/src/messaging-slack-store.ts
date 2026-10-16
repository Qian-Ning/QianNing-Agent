import {
  MESSAGING_SLACK_SECTION,
  SLACK_HANDLED_CAPACITY,
  type SlackInboundHandledStore,
  type SlackSettingsSurface,
} from "./messaging-slack-inbound.js";

/**
 * The settings-backed replay guard for the inbound Slack channel (ADR 0326).
 *
 * The durable [`SlackInboundHandledStore`] a composition root installs. The
 * event ids ride the existing `app` settings row, under the Slack channel's own
 * section (`messagingSlack.inbound.handledEventIds`), so the guard needs no new
 * store, no new namespace and no schema change — exactly as the Telegram cursor
 * rides `messagingTelegram.inbound.pollOffset`. The list is bounded to
 * [`SLACK_HANDLED_CAPACITY`], oldest evicted first, so a chatty or hostile
 * platform cannot grow it without limit.
 *
 * It is the one store that makes the Slack ack discipline real: the client
 * acknowledges an envelope only after `record` here has resolved, so a
 * redelivery Slack sends after a *restart* — when the client's own in-memory
 * state is gone — is still recognised by `has` and never acted on twice.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Slack section of the settings row, or `null` when absent or not an object. */
function readSlackSection(settings: unknown): Record<string, unknown> | null {
  if (!isRecord(settings)) return null;
  const section = settings[MESSAGING_SLACK_SECTION];
  return isRecord(section) ? section : null;
}

/** The stored handled-event ids, filtered to non-empty strings. */
function readHandledIds(settings: unknown): string[] {
  const section = readSlackSection(settings);
  const inbound = section && isRecord(section.inbound) ? section.inbound : null;
  const raw = inbound?.handledEventIds;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/**
 * Replace the Slack section's `inbound.handledEventIds` through `settings.set`.
 * `settings.set` merges at the top level, so the whole Slack section is written
 * back with the one field changed and no neighbouring app setting is touched.
 * A section that is absent leaves nothing to write into, so the write is a
 * no-op (an unconfigured channel has no field for the guard to occupy).
 */
async function patchSlackSection(settings: SlackSettingsSurface, handledEventIds: string[]): Promise<void> {
  const section = readSlackSection(await settings.read());
  if (!section) return;
  const inbound = isRecord(section.inbound) ? section.inbound : {};
  await settings.write({
    [MESSAGING_SLACK_SECTION]: { ...section, inbound: { ...inbound, handledEventIds } },
  });
}

export function createSettingsSlackHandledStore(
  settings: SlackSettingsSurface,
): SlackInboundHandledStore {
  // `record` is a read-modify-write over the whole Slack section: it reads the
  // ids, appends, and writes the section back. Frames are not serialized by the
  // client, so a burst of envelopes runs `record` concurrently, and two reads
  // that interleave start from the same snapshot — the later write then drops
  // the earlier id. A dropped id means a later Slack redelivery is re-applied
  // (a duplicate), which is exactly what this store exists to prevent.
  //
  // A single tail promise serializes the writes through this store: each record
  // runs only after the previous one has settled. It is deliberately here
  // rather than in the client because the window is inside `record` itself (the
  // read, the append and the write), and it is the smaller honest change — one
  // module, the one that owns the read-modify-write. The chain is bounded by
  // the callers already awaiting `record` (each envelope's handling holds one),
  // so it cannot grow beyond them, and it holds no signal or timer, so it can
  // never deadlock a shutdown: a record settles on its own.
  let tail: Promise<void> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    async has(eventId: string): Promise<boolean> {
      const ids = readHandledIds(await settings.read());
      return ids.includes(eventId);
    },
    record(eventId: string): Promise<void> {
      return serialize(async () => {
        const settingsState = await settings.read();
        if (!readSlackSection(settingsState)) return;
        const ids = readHandledIds(settingsState);
        if (ids.includes(eventId)) return;
        const next = [...ids, eventId].slice(-SLACK_HANDLED_CAPACITY);
        await patchSlackSection(settings, next);
      });
    },
  };
}
