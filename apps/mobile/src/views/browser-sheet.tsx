import { useEffect, useRef, useState } from "react";
import type { Translate } from "../lib/i18n";
import { hasBrowser, openBrowser } from "../lib/shell";

type Props = {
  t: Translate;
  /** Prefilled when the sheet is opened from a link rather than a blank ask. */
  initialUrl?: string;
  onClose: () => void;
};

const RECENT_KEY = "qn.browser.recent";
const MAX_RECENT = 6;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function remember(url: string, current: string[]): string[] {
  const next = [url, ...current.filter((entry) => entry !== url)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Losing the recent list costs nothing; the page still opens.
  }
  return next;
}

/**
 * The address bar for the in-app browser.
 *
 * The browser itself is a native window, so this sheet only answers one
 * question — where to go — and remembers the last few answers, because a phone
 * address bar is the worst place to retype a URL.
 */
export function BrowserSheet({ t, initialUrl, onClose }: Props) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const go = async (raw: string) => {
    const target = raw.trim();
    if (!target) return;
    const opened = await openBrowser(target);
    if (!opened) return;
    setRecent(remember(target, recent));
    onClose();
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <header className="sheet-bar">
          <h2>{t("browser.title")}</h2>
          <button className="ghost" onClick={onClose} aria-label={t("settings.close")}>
            ✕
          </button>
        </header>

        {!hasBrowser() ? <p className="muted">{t("browser.unavailable")}</p> : null}

        <form
          className="sheet-form"
          onSubmit={(event) => {
            event.preventDefault();
            void go(url);
          }}
        >
          <input
            ref={field}
            className="search"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t("browser.placeholder")}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="primary" type="submit" disabled={url.trim().length === 0}>
            {t("browser.open")}
          </button>
        </form>

        {recent.length > 0 ? (
          <div className="sheet-list">
            {recent.map((entry) => (
              <button key={entry} className="row" onClick={() => void go(entry)}>
                <span className="row-title">{entry}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
