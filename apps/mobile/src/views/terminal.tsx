import { useEffect, useRef, useState } from "react";
import type { Translate } from "../lib/i18n";
import { hasShell, runShell, shellInfo, type ShellInfo } from "../lib/shell";

type Props = {
  t: Translate;
  onClose: () => void;
};

type Line =
  | { kind: "command"; text: string }
  | { kind: "output"; text: string }
  | { kind: "status"; text: string; failed?: boolean };

const HISTORY_KEY = "qn.shell.history";
const MAX_HISTORY = 40;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
  } catch {
    // A full or locked storage only costs the history, never the command.
  }
}

/**
 * The phone's terminal.
 *
 * A real shell, not a command palette: `ls`, `cd`, pipes, `grep` — everything
 * `/system/bin/sh` can do inside this app's sandbox. Output is a log rather
 * than a TTY, because a phone keyboard has no Ctrl-C: each command is bounded
 * by the plugin's timeout instead of by an interrupt, and a command that
 * printed something before the ceiling still shows it.
 */
export function TerminalView({ t, onClose }: Props) {
  const [lines, setLines] = useState<Line[]>([
    { kind: "status", text: t("terminal.hint") },
  ]);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => setInfo(await shellInfo()))();
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setCommand("");
    setHistoryIndex(-1);
    setBusy(true);
    setLines((prev) => [...prev, { kind: "command", text }]);

    const next = [text, ...history.filter((entry) => entry !== text)].slice(0, MAX_HISTORY);
    setHistory(next);
    saveHistory(next);

    // The shell is persistent, so `cd` needs no special handling: the plugin
    // reports the session's directory after every command and the prompt
    // simply follows it.
    const result = await runShell(text);
    setBusy(false);
    if (result.cwd) setInfo((prev) => (prev ? { ...prev, cwd: result.cwd } : prev));
    const body = result.output.replace(/\s+$/, "");
    if (body) setLines((prev) => [...prev, { kind: "output", text: body }]);
    if (result.error) {
      setLines((prev) => [...prev, { kind: "status", text: result.error ?? "", failed: true }]);
    }
    if (result.code !== 0 || result.truncated) {
      const bits = [`退出码 ${result.code}`];
      if (result.truncated) bits.push("输出已截断（超时或过长）");
      setLines((prev) => [...prev, { kind: "status", text: bits.join(" · "), failed: result.code !== 0 }]);
    }
  };

  const recall = (step: number) => {
    if (history.length === 0) return;
    const next = Math.min(history.length - 1, Math.max(0, historyIndex + step));
    setHistoryIndex(next);
    setCommand(history[next] ?? "");
  };

  return (
    <div className="terminal">
      <header className="terminal-bar">
        <button className="ghost" aria-label={t("terminal.close")} onClick={onClose}>
          ‹
        </button>
        <div className="terminal-path" title={info?.cwd ?? ""}>
          {info ? info.cwd.replace(/^.*\/files/, "~") : t("terminal.title")}
        </div>
        <button
          className="ghost"
          onClick={() => setLines([])}
          disabled={lines.length === 0}
        >
          {t("terminal.clear")}
        </button>
      </header>

      {!hasShell() ? <p className="terminal-empty">{t("terminal.unavailable")}</p> : null}

      <div className="terminal-log" ref={scroller}>
        {lines.map((line, index) => (
          <div key={index} className={`terminal-line ${line.kind}${"failed" in line && line.failed ? " failed" : ""}`}>
            {line.kind === "command" ? <span className="terminal-prompt">$ </span> : null}
            <span>{line.text}</span>
          </div>
        ))}
        {busy ? <div className="terminal-line status">{t("terminal.running")}</div> : null}
      </div>

      <form
        className="terminal-input"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(command);
        }}
      >
        <button
          type="button"
          className="terminal-recall"
          aria-label={t("terminal.history")}
          onClick={() => recall(-1)}
          disabled={history.length === 0}
        >
          ↑
        </button>
        <input
          ref={input}
          className="terminal-field"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={t("terminal.placeholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
        />
        <button className="primary" type="submit" disabled={busy || command.trim().length === 0}>
          {t("terminal.run")}
        </button>
      </form>
    </div>
  );
}
