import type { MessageDeliverySummary } from "@pi-desktop/agent-host";

import { MESSAGING_ENQUEUE_METHOD } from "@pi-desktop/agent-host";

/**
 * One process card (ADR 0340): a single message a channel creates when a turn
 * starts, rewrites while the turn runs, and replaces with the final answer.
 *
 * The card owns no state machine of its own. Every frame is an ordinary ledger
 * delivery: the first is a `send` whose id this class mints, and each later one
 * is an `edit` addressed to that id through `cardOf`, so the platform's own
 * message id never has to leave the host and no reply has to be waited on.
 *
 * # Why frames are merged
 *
 * A turn can emit a tool step every few hundred milliseconds, and each frame
 * would be one API call to the channel, rate limits included. Frames are
 * therefore held for {@link CARD_MERGE_MS} and the newest one replaces the one
 * still waiting: a burst of ten steps costs one edit, and the frame that lands
 * is the latest state rather than a replay of the burst. The delay is a floor,
 * not a target — a card that is already idle edits immediately.
 *
 * # What a card never does
 *
 * It never invents text: every frame it enqueues is the summary the redactor
 * built, cut to three fields at the source. It never retries: an edit is bounded
 * to one attempt by the ledger. And it never blocks a turn — a failed hand-off
 * costs a log line through `onError` and nothing else.
 */
export class MessagingCard {
  private id: string | undefined;
  private pending: MessageDeliverySummary | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly port: { call(method: string, params: unknown): Promise<unknown> },
    private readonly channel: string,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly seed: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  /** The delivery id of the message this card created, once it has one. */
  get deliveryId(): string | undefined {
    return this.id;
  }

  /**
   * Create the card. The id is minted here, before the delivery exists, because
   * every later edit has to name it without a reply to learn it from.
   */
  open(summary: MessageDeliverySummary): void {
    if (this.closed || this.id !== undefined) return;
    this.id = this.seed();
    void this.handOff({
      channel: this.channel,
      payload: summary,
      id: this.id,
      operation: "send",
    });
  }

  /**
   * Show a newer state. Frames that arrive while one is already waiting replace
   * it: the older state is not worth an API call once a newer one exists.
   */
  frame(summary: MessageDeliverySummary): void {
    if (this.closed || this.id === undefined) return;
    this.pending = summary;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, CARD_MERGE_MS);
    this.timer.unref?.();
  }

  /**
   * Replace the card with the turn's final answer.
   *
   * The last frame is sent immediately rather than merged: it is the answer, and
   * it must not wait behind a merge window that exists for progress noise.
   */
  close(summary: MessageDeliverySummary): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelTimer();
    this.pending = undefined;
    if (this.id === undefined) return;
    void this.handOff({
      channel: this.channel,
      payload: summary,
      id: this.seed(),
      operation: "edit",
      cardOf: this.id,
    });
  }

  /** Send whatever is waiting, if anything. */
  private flush(): void {
    const summary = this.pending;
    this.pending = undefined;
    if (summary === undefined || this.id === undefined) return;
    void this.handOff({
      channel: this.channel,
      payload: summary,
      id: this.seed(),
      operation: "edit",
      cardOf: this.id,
    });
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async handOff(params: Record<string, unknown>): Promise<void> {
    try {
      await this.port.call(MESSAGING_ENQUEUE_METHOD, params);
    } catch (error) {
      this.onError(error);
    }
  }
}

/**
 * How long a progress frame waits before it is allowed to cost an API call.
 * ADR 0340 fixes this as the merge floor rather than a target.
 */
export const CARD_MERGE_MS = 1_500;
