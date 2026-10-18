/**
 * The desktop main process's one messaging-gateway registry.
 *
 * The registry itself lives in `@pi-desktop/host-runtime`
 * (`messaging-gateway-registry.ts`), beside the supervisor that starts and stops
 * the loops it tracks, so the two can be exercised together by a test
 * (`packages/host-runtime/src/messaging-inbound-supervisor.test.ts`). This module
 * stays as the process-wide instance the desktop composition root and the IPC
 * handler share: a second instance would answer "stopped" forever, which is
 * exactly the bug the registry replaced.
 *
 * Read the registry's own module note for what `running` means: the lifetime of
 * the loop, never a guess from the stored record.
 */

import { MessagingGatewayRegistry } from "@pi-desktop/host-runtime";

export type {
  MessagingGatewayChannel,
  MessagingGatewayHandle,
  MessagingGatewayPort,
  MessagingGatewaySnapshot,
} from "@pi-desktop/host-runtime";

export { MessagingGatewayRegistry };

/** The process-wide registry. */
export const messagingGateway = new MessagingGatewayRegistry();
