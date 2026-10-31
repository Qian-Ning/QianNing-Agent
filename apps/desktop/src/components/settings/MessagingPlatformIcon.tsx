import type { ReactNode } from "react";

import { cx } from "../ui";
import type { MessagingPlatformId } from "../../lib/messaging-platforms";

/**
 * The brand tile a platform card leads with.
 *
 * A list of channel names is unreadable at a glance; a list of marks is not.
 * Each tile carries the platform's own colour and a mark, and the ones this
 * build has no faithful mark for fall back to the platform's first letter in a
 * neutral tile — an honest placeholder rather than an invented logo.
 *
 * The marks are drawn for 24×24 and scaled by CSS, so one tile size serves the
 * rail, the detail header and the phone list.
 */

/** Colour only — the mark comes from `GLYPHS` or the letter fallback. */
const BRAND_COLORS: Partial<Record<MessagingPlatformId, { background: string; color: string }>> = {
  telegram: { background: "#229ED9", color: "#fff" },
  discord: { background: "#5865F2", color: "#fff" },
  slack: { background: "#FFFFFF", color: "#4A154B" },
  matrix: { background: "#0DBD8B", color: "#fff" },
  mattermost: { background: "#1E325C", color: "#fff" },
  signal: { background: "#3A76F0", color: "#fff" },
  whatsapp: { background: "#25D366", color: "#fff" },
  whatsappCloud: { background: "#25D366", color: "#fff" },
  email: { background: "#8B8F97", color: "#fff" },
  irc: { background: "#2B2B2B", color: "#fff" },
  ntfy: { background: "#317F43", color: "#fff" },
  homeAssistant: { background: "#41BDF5", color: "#fff" },
  sms: { background: "#34C759", color: "#fff" },
  line: { background: "#06C755", color: "#fff" },
  teams: { background: "#6264A7", color: "#fff" },
  googleChat: { background: "#1A73E8", color: "#fff" },
  blueBubbles: { background: "#2E7CF6", color: "#fff" },
  imessagePhone: { background: "#34C759", color: "#fff" },
  weixin: { background: "#07C160", color: "#fff" },
  wecomGroup: { background: "#3370FF", color: "#fff" },
  wecomApp: { background: "#3370FF", color: "#fff" },
  feishu: { background: "#3370FF", color: "#fff" },
  dingtalk: { background: "#1677FF", color: "#fff" },
  qqBot: { background: "#1EBAFC", color: "#fff" },
  apiServer: { background: "linear-gradient(145deg, #12213F, #3964FE)", color: "#fff" },
  webhooks: { background: "linear-gradient(145deg, #2B2F3A, #5B6472)", color: "#fff" },
  a2a: { background: "linear-gradient(145deg, #1F3A2E, #2F7D5B)", color: "#fff" },
  relay: { background: "linear-gradient(145deg, #2A2140, #6A4CC9)", color: "#fff" },
  raft: { background: "linear-gradient(145deg, #33240F, #A9661F)", color: "#fff" },
  simplex: { background: "linear-gradient(145deg, #10222E, #2A6E8F)", color: "#fff" },
  buzz: { background: "linear-gradient(145deg, #3A2A00, #B07A00)", color: "#fff" },
  yuanbao: { background: "linear-gradient(145deg, #3A1F2A, #A64B6B)", color: "#fff" },
  microsoftGraph: { background: "#0078D4", color: "#fff" },
};

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const GLYPHS: Partial<Record<MessagingPlatformId, ReactNode>> = {
  telegram: (
    <path
      fill="currentColor"
      d="M23 4.7 19.8 20c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L7.4 13.2 2.6 11.7c-1-.3-1-1 .2-1.5l19-7.3c.9-.3 1.6.2 1.2 1.8Z"
    />
  ),
  discord: (
    <path
      fill="currentColor"
      d="M19.3 5.3A16 16 0 0 0 15.4 4l-.3.6c1.3.3 2.5.8 3.6 1.5a12.8 12.8 0 0 0-11.4 0C8.4 5.4 9.6 4.9 11 4.6L10.6 4a16 16 0 0 0-3.9 1.3C4.2 9 3.4 12.6 3.8 16.2c1.5 1.1 3 1.8 4.4 2.2l.9-1.5c-.8-.3-1.6-.7-2.3-1.2l.5-.4a11.4 11.4 0 0 0 9.4 0l.5.4c-.7.5-1.5.9-2.3 1.2l.9 1.5c1.5-.4 2.9-1.1 4.4-2.2.5-4.2-.8-7.8-2.9-10.9ZM9.2 14c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Zm5.6 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.6.8 1.6 1.8-.7 1.8-1.6 1.8Z"
    />
  ),
  slack: (
    <path
      fill="currentColor"
      d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Zm2-8a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 0 1 0 4H4a2 2 0 1 1 0-4h5Zm8 2a2 2 0 1 1 2 2h-2V10Zm-1 0a2 2 0 0 1-4 0V5a2 2 0 1 1 4 0v5Zm-2 8a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z"
    />
  ),
  matrix: (
    <>
      <path {...stroke} d="M4 5v14M20 5v14M7 9h4M7 12h7M7 15h4" />
      <circle cx="17.5" cy="12" r="2" fill="currentColor" />
    </>
  ),
  mattermost: (
    <path
      fill="currentColor"
      d="M12 3a9 9 0 0 0-6.4 15.3l-1 3.7 3.9-1A9 9 0 1 0 12 3Zm-3 7h1.8v4H9V10Zm5.2 0H16v4h-1.8v-4Z"
    />
  ),
  signal: (
    <>
      <path {...stroke} d="M12 4a8 8 0 0 1 0 16H5l1.4-3.4A8 8 0 0 1 12 4Z" />
      <path {...stroke} d="M9.5 10.5h5M9.5 13.5h3" />
    </>
  ),
  email: (
    <>
      <rect {...stroke} x="3" y="5.5" width="18" height="13" rx="2.4" />
      <path {...stroke} d="m4.5 8 7.5 5.6L19.5 8" />
    </>
  ),
  irc: <path {...stroke} d="m4 7 6 5-6 5M12.5 17H20" />,
  ntfy: (
    <>
      <path {...stroke} d="M12 4a5.5 5.5 0 0 1 5.5 5.5V13l1.5 3H5l1.5-3V9.5A5.5 5.5 0 0 1 12 4Z" />
      <path {...stroke} d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  homeAssistant: (
    <>
      <path {...stroke} d="m3.5 11 8.5-7 8.5 7" />
      <path {...stroke} d="M6 10.5V20h12v-9.5" />
      <circle cx="12" cy="14.5" r="2" {...stroke} />
    </>
  ),
  apiServer: (
    <>
      <rect {...stroke} x="3.5" y="5.5" width="17" height="13" rx="2.4" />
      <path {...stroke} d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2" />
    </>
  ),
  webhooks: (
    <>
      <path {...stroke} d="M4 12h9" />
      <path {...stroke} d="m10 8 4 4-4 4" />
      <rect {...stroke} x="16.5" y="7" width="4" height="10" rx="1.4" />
    </>
  ),
  whatsapp: (
    <>
      <path
        fill="currentColor"
        d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Z"
      />
      <path
        fill="none"
        stroke="#25D366"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M9 8.6c.3-.6 1.2-.6 1.5 0l.6 1.2c.2.4.1.8-.2 1l-.5.4c.5 1.1 1.4 2 2.5 2.5l.4-.5c.2-.3.6-.4 1-.2l1.2.6c.6.3.6 1.2 0 1.5-1.8.9-4-.3-5.6-1.9s-2.8-3.8-1.9-5.6Z"
      />
    </>
  ),
  weixin: (
    <>
      <path
        fill="currentColor"
        d="M9.2 4C5.8 4 3 6.2 3 8.9c0 1.5.9 2.9 2.3 3.8l-.5 1.7 2-.9c.4.1.9.2 1.4.2h.4a4.6 4.6 0 0 1-.2-1.3c0-2.6 2.6-4.7 5.8-4.7h.5C14.2 5.5 12 4 9.2 4Zm-2.1 3.4a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm4.2 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z"
      />
      <path
        fill="currentColor"
        opacity=".72"
        d="M15.6 8.5c-2.9 0-5.2 1.8-5.2 4s2.3 4 5.2 4c.5 0 .9 0 1.4-.2l1.8.8-.5-1.5c1.2-.8 2-2 2-3.3 0-2.1-2.3-3.8-4.7-3.8Zm-1.8 2.6a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3.6 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"
      />
    </>
  ),
  wecomGroup: <path {...stroke} d="M9 4.5h6v4H9zM4.5 15h5v4h-5zM14.5 15h5v4h-5zM12 8.5V15M12 11H7v4M12 11h5v4" />,
  wecomApp: (
    <>
      <rect {...stroke} x="4" y="4.5" width="16" height="15" rx="3" />
      <path {...stroke} d="M8 10h8M8 14h5" />
    </>
  ),
  feishu: (
    <>
      <path {...stroke} d="m5 6 6 4-6 4" />
      <path {...stroke} d="m12 6 6 4-6 4" opacity=".6" />
      <path {...stroke} d="M6 18h12" />
    </>
  ),
  dingtalk: (
    <>
      <path {...stroke} d="M13 3 6 13h5l-1 8 8-11h-5l0-7Z" />
    </>
  ),
  qqBot: (
    <>
      <path {...stroke} d="M12 3.5c-3.2 0-5.2 2.4-5.2 5.5 0 2 .6 3.4 1.4 4.6-.5 1.6-1 2.6-1.9 3.4 1.4.6 2.6.2 3.4-.6h4.6c.8.8 2 1.2 3.4.6-.9-.8-1.4-1.8-1.9-3.4.8-1.2 1.4-2.6 1.4-4.6 0-3.1-2-5.5-5.2-5.5Z" />
      <circle cx="10" cy="9" r=".9" fill="currentColor" />
      <circle cx="14" cy="9" r=".9" fill="currentColor" />
    </>
  ),
  teams: (
    <>
      <rect {...stroke} x="3.5" y="7" width="9" height="9" rx="2" />
      <path {...stroke} d="M6 7 8 4.5 10 7M12.5 10h5a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 1-2.5 2.5H14" />
    </>
  ),
  googleChat: (
    <>
      <path {...stroke} d="M4 6.5h16v10.5H10l-4 3.5v-3.5H4z" />
      <path {...stroke} d="M8.5 11.5h7" />
    </>
  ),
  line: (
    <>
      <path {...stroke} d="M12 4c-4.4 0-8 2.8-8 6.3 0 3.1 2.8 5.7 6.4 6.2l-.4 3 3.2-3c3.6-.6 6.8-3.2 6.8-6.2C20 6.8 16.4 4 12 4Z" />
      <path {...stroke} d="M9 9v3M12 9v3M15 9v3" />
    </>
  ),
  sms: (
    <>
      <path {...stroke} d="M4 6h16v10H11l-4 3.5V16H4z" />
      <path {...stroke} d="M8 11h8" />
    </>
  ),
  blueBubbles: (
    <>
      <path {...stroke} d="M4 5.5h16v11H9l-5 4z" />
      <path {...stroke} d="M8 10h8M8 13h4" />
    </>
  ),
  imessagePhone: (
    <>
      <rect {...stroke} x="6" y="3" width="12" height="18" rx="3" />
      <path {...stroke} d="M10 6.5h4M6 17h12" />
    </>
  ),
  a2a: (
    <>
      <circle {...stroke} cx="7" cy="12" r="3" />
      <circle {...stroke} cx="17" cy="12" r="3" />
      <path {...stroke} d="M10 12h4" />
    </>
  ),
  relay: (
    <>
      <path {...stroke} d="M12 4v5M12 15v5M4.5 12h5M14.5 12h5" />
      <circle {...stroke} cx="12" cy="12" r="2.6" />
    </>
  ),
  raft: <path {...stroke} d="M12 4v16M6 8h12M4.5 20h15" />,
  simplex: (
    <>
      <path {...stroke} d="m12 3 8 6-3 12H7L4 9z" />
    </>
  ),
  buzz: (
    <>
      <path {...stroke} d="M4 6h10l6 6-6 6H4z" />
      <path {...stroke} d="M8 12h6" />
    </>
  ),
  yuanbao: (
    <>
      <path {...stroke} d="M4 9h16M6 9c0 5 2.5 8 6 8s6-3 6-8" />
      <path {...stroke} d="M9.5 12h5" />
    </>
  ),
  microsoftGraph: (
    <>
      <path {...stroke} d="M4 7.5 12 4l8 3.5M4 7.5V17l8 3 8-3V7.5" />
      <path {...stroke} d="M4 12.5h16" opacity=".6" />
    </>
  ),
};

export function MessagingPlatformIcon({
  id,
  label,
  size = 30,
  className,
}: {
  id: MessagingPlatformId;
  label: string;
  size?: number;
  className?: string;
}) {
  const colors = BRAND_COLORS[id];
  const glyph = GLYPHS[id];
  return (
    <span
      className={cx("settings-messaging-logo", className)}
      data-brand={id}
      style={{
        width: size,
        height: size,
        ...(colors
          ? {
              background: colors.background,
              color: colors.color,
              ...(colors.background === "#FFFFFF" ? { border: "1px solid var(--ds-border-subtle)" } : {}),
            }
          : {}),
      }}
      aria-hidden="true"
    >
      {glyph ? (
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)}>
          {glyph}
        </svg>
      ) : (
        <span className="settings-messaging-logo-letter">{label.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
