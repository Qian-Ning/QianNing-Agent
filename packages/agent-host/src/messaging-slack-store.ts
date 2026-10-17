import {
  MESSAGING_SLACK_SECTION,
  SLACK_HANDLED_CAPACITY,
  type SlackInboundHandledStore,
  type SlackSettingsSurface,
} from "./messaging-slack-inbound.js";
import { createSettingsHandledMessageStore } from "./messaging-handled-store.js";

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
 *
 * The read-modify-write, the serialization that makes a concurrent burst safe
 * and the bound are the shared settings store's
 * ([`createSettingsHandledMessageStore`]); only the section, the field name and
 * the capacity are Slack's. The field name is `handledEventIds` because that is
 * the schema this channel already published.
 */
export function createSettingsSlackHandledStore(
  settings: SlackSettingsSurface,
): SlackInboundHandledStore {
  return createSettingsHandledMessageStore({
    settings,
    section: MESSAGING_SLACK_SECTION,
    capacity: SLACK_HANDLED_CAPACITY,
    field: "handledEventIds",
  });
}
