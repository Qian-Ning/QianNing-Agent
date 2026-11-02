import type { ReactNode } from "react";
import { hasBrowser, openBrowser } from "./shell";

/**
 * A small Markdown renderer for agent output.
 *
 * Not a parser library on purpose: the phone renders code the agent wrote, and a
 * full CommonMark implementation is 30 kB gzipped for headings and fences. What
 * this handles is what agents actually emit — fences, inline code, emphasis,
 * links, lists, quotes — and everything else falls through as plain text, which
 * is always readable.
 */

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

function splitBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("> ")) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trimStart().startsWith("> ")) {
        body.push((lines[index] ?? "").trimStart().slice(2));
        index += 1;
      }
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+/.test(line);
    const bullet = /^\s*[-*+]\s+/.test(line);
    if (ordered || bullet) {
      const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(pattern, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const body: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim()) break;
      if (/^\s*(```|>|#{1,4}\s|\d+[.)]\s|[-*+]\s)/.test(next)) break;
      body.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }

  return blocks;
}

export const splitBlocksForTest = splitBlocks;

/** Inline spans: `code`, **bold**, *italic*, [label](url), bare newlines. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const lines = value.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) nodes.push(<br key={keyPrefix + "-br-" + part++} />);
      if (line) nodes.push(line);
    });
  };

  while ((match = pattern.exec(text)) !== null) {
    pushText(text.slice(cursor, match.index));
    const token = match[0];
    const key = keyPrefix + "-i" + part++;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      const href = label?.[2] ?? "#";
      const safe = /^https?:\/\//i.test(href);
      nodes.push(
        safe ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => {
              // A link in a reply opens the app's own browser window: the
              // conversation stays behind it, and back returns in one gesture.
              if (!hasBrowser()) return;
              event.preventDefault();
              void openBrowser(href);
            }}
          >
            {label?.[1] ?? href}
          </a>
        ) : (
          <span key={key}>{label?.[1] ?? token}</span>
        ),
      );
    }
    cursor = match.index + token.length;
  }
  pushText(text.slice(cursor));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        const key = "b" + index;
        switch (block.kind) {
          case "code":
            return (
              <pre key={key} className="code-block" data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case "heading": {
            const Tag = (block.level <= 2 ? "h3" : "h4") as "h3" | "h4";
            return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
          }
          case "quote":
            return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
          case "list":
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={key + "-" + itemIndex}>{renderInline(item, key + "-" + itemIndex)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={key + "-" + itemIndex}>{renderInline(item, key + "-" + itemIndex)}</li>
                ))}
              </ul>
            );
          case "rule":
            return <hr key={key} />;
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
