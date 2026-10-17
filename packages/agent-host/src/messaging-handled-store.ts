/**
 * The settings-backed replay guard for a push channel that keys its
 * redeliveries on the platform's own message id.
 *
 * Slack's guard (`messaging-slack-store.ts`) is keyed on an event id and lives
 * in its own module; this one is the same mechanism with the section and the
 * key field as parameters, for the channels that have no event id of their own
 * (Discord's message id, Mattermost's post id). The ids ride the existing `app`
 * settings row under the channel's own section
 * (`<section>.inbound.handledMessageIds`), so the guard needs no new store, no
 * new namespace and no schema change — exactly as Slack's event ids ride
 * `messagingSlack.inbound.handledEventIds` and Telegram's cursor rides
 * `messagingTelegram.inbound.pollOffset`.
 *
 * The list is bounded, oldest evicted first, so a chatty or hostile platform
 * cannot grow it without limit. The read-modify-write is serialized through one
 * tail promise: frames are not serialized by the client, so two records can
 * interleave and the later write would otherwise drop the earlier id — and a
 * dropped id is a duplicate the guard exists to prevent.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings surface the guard rides. */
export type MessagingHandledSettingsSurface = {
  read(): Promise<unknown>;
  write(patch: Record<string, unknown>): Promise<void>;
};

export type SettingsHandledMessageStoreOptions = {
  settings: MessagingHandledSettingsSurface;
  /** The channel's section key inside the shared `app` row. */
  section: string;
  /** The most ids remembered before the oldest is evicted. */
  capacity: number;
  /**
   * The field inside `<section>.inbound` that carries the ids. It is the
   * channel's published schema, so it is not renamed: Slack's guard has always
   * written `handledEventIds` and the sockets' guards `handledMessageIds`.
   */
  field?: string;
};

export type MessagingHandledMessageStore = {
  has(id: string): Promise<boolean>;
  record(id: string): Promise<void>;
};

/** The field inside `<section>.inbound` that carries the ids, by default. */
const FIELD = "handledMessageIds";

function readSection(settings: unknown, sectionKey: string): Record<string, unknown> | null {
  if (!isRecord(settings)) return null;
  const section = settings[sectionKey];
  return isRecord(section) ? section : null;
}

function readIds(settings: unknown, sectionKey: string, field: string): string[] {
  const section = readSection(settings, sectionKey);
  const inbound = section && isRecord(section.inbound) ? section.inbound : null;
  const raw = inbound?.[field];
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

export function createSettingsHandledMessageStore(
  options: SettingsHandledMessageStoreOptions,
): MessagingHandledMessageStore {
  const { settings, section: sectionKey } = options;
  const field = options.field ?? FIELD;
  const capacity = Math.max(1, Math.floor(options.capacity));
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
    async has(id: string): Promise<boolean> {
      return readIds(await settings.read(), sectionKey, field).includes(id);
    },
    record(id: string): Promise<void> {
      return serialize(async () => {
        const state = await settings.read();
        const section = readSection(state, sectionKey);
        // An unconfigured channel has no field for the guard to occupy.
        if (!section) return;
        const ids = readIds(state, sectionKey, field);
        if (ids.includes(id)) return;
        const next = [...ids, id].slice(-capacity);
        const inbound = isRecord(section.inbound) ? section.inbound : {};
        await settings.write({
          [sectionKey]: { ...section, inbound: { ...inbound, [field]: next } },
        });
      });
    },
  };
}
