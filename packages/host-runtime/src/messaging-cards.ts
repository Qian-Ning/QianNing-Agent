import type { MessageDeliverySummary } from "@pi-desktop/agent-host";

import { MessagingCard } from "./messaging-card.js";

/**
 * The cards a channel has open, one per turn.
 *
 * A card is identified by its turn, not by its channel: two sessions can run at
 * once, and a second turn in the same session starts with a card of its own. The
 * opening kind creates the card; a terminal kind replaces it and the entry is
 * dropped, so the map cannot grow past the turns that are actually running.
 *
 * # Absorb, or say you did not
 *
 * {@link absorb} answers whether the event became part of a card. A turn whose
 * opening was never seen — the relay started mid-turn, or the card is off — is
 * not a card event, and the caller must deliver it the way it always has rather
 * than lose it. Silence here would drop a finished turn's answer.
 */
export class MessagingCards {
  private readonly open = new Map<string, MessagingCard>();

  constructor(private readonly make: () => MessagingCard) {}

  /** How many cards are open right now. */
  get size(): number {
    return this.open.size;
  }

  /**
   * Route one summary into a card.
   *
   * Returns `true` when the summary became part of a card — created it, updated
   * it, or finished it — and `false` when there was no card for it.
   */
  absorb(summary: MessageDeliverySummary): boolean {
    const key = `${summary.sessionId ?? "-"}:${summary.turnId ?? "-"}`;
    if (summary.kind === "turn.started") {
      const existing = this.open.get(key);
      if (existing !== undefined) {
        existing.frame(summary);
        return true;
      }
      const card = this.make();
      this.open.set(key, card);
      card.open(summary);
      return true;
    }
    const card = this.open.get(key);
    if (card === undefined) return false;
    if (summary.kind === "turn.completed" || summary.kind === "turn.failed") {
      card.close(summary);
      this.open.delete(key);
      return true;
    }
    card.frame(summary);
    return true;
  }
}
