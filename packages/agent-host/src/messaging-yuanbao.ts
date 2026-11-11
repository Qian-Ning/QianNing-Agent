/**
 * Yuanbao's settings section and record shape.
 *
 * The channel's loop runs in host-core (ADR `yuanbao-inbound-in-host-core`), so
 * this package carries no transport for it. What lives here is the naming both
 * sides have to agree on: the section a record is written under, and the format
 * string that makes a foreign record visibly foreign.
 */
export const YUANBAO_SETTINGS_SECTION = "messagingYuanbao";

export const YUANBAO_FORMAT = "pi-desktop-messaging-yuanbao";

export const YUANBAO_FORMAT_VERSION = 1;
