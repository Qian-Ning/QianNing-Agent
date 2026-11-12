/**
 * Prompt Lab — swap the system prompt for a session.
 *
 * An agent extension for prompt-engineering work: compare how the same request
 * behaves with the harness prompt present, trimmed, or absent. Off by default;
 * with the command never run, nothing is read from disk and the prompt a session
 * sends is exactly the one it would have sent anyway.
 *
 * State is per session and in memory only. Nothing is persisted, so quitting the
 * app cannot leave a session running with a prompt the user forgot about.
 *
 * The composition rules are exported as plain functions so they can be tested
 * without the extension kernel.
 */

const EMBEDDED_PERSONA = [
  "# Persona (example)",
  "",
  "You are a helpful assistant. Answer the user's request directly and keep the",
  "reply short.",
  "",
  "This text ships with Prompt Lab so a fresh install works immediately. Replace",
  "it with your own instructions:",
  "",
  "    /promptlab source C:/path/to/your-prompt.md",
  "",
  "and /promptlab source embedded comes back to this example.",
].join("\n");

const EMBEDDED = "embedded";

export const MODES = ["append", "replace", "strict"];

/** What the harness says about itself, oldest wording last. */
const IDENTITY_LINES = [
  "You are a coding assistant running inside",
  "You are an expert coding assistant operating inside",
];

/**
 * Remove the harness's self-description: the first line that introduces it.
 * Returns the text unchanged when no phrasing matches, so a harness rewording
 * degrades to "nothing was cut" instead of cutting the wrong line.
 */
export function stripIdentityLine(text) {
  const lines = text.split("\n");
  for (const prefix of IDENTITY_LINES) {
    const index = lines.findIndex((line) => line.startsWith(prefix));
    if (index !== -1) {
      const without = [...lines.slice(0, index), ...lines.slice(index + 1)];
      return { text: without.join("\n"), found: true };
    }
  }
  return { text, found: false };
}

/**
 * Remove the bundled documentation section, delimited by `<docs>` tags when the
 * harness ships them. Without tags the section is left alone: a guessed boundary
 * cuts prose the user may still need.
 */
export function stripDocsBlock(text) {
  const open = text.indexOf("<docs>");
  const close = text.indexOf("</docs>");
  if (open === -1 || close === -1 || close < open) return { text, found: false };
  const lineStart = text.lastIndexOf("\n", open) + 1;
  const lineEnd = text.indexOf("\n", close);
  const end = lineEnd === -1 ? text.length : lineEnd + 1;
  return { text: text.slice(0, lineStart) + text.slice(end), found: true };
}

/** `{{cwd}}` in a persona file becomes the session's directory. */
export function interpolate(text, cwd) {
  if (!text.includes("{{cwd}}")) return text;
  if (!cwd) return text.replace(/[ \t]*\{\{cwd\}\}[ \t]*/g, " ").replace(/[ \t]+\n/g, "\n");
  return text.split("{{cwd}}").join(cwd);
}

/**
 * Build the prompt for one turn.
 *
 * `append` keeps the harness prompt and puts the persona in front of it —
 * `replace` keeps the harness prompt with its identity line and documentation
 * removed — `strict` sends the persona and the working directory only.
 */
export function composeSystemPrompt({ mode, persona, base, cwd }) {
  const own = interpolate(persona, cwd);
  if (mode === "strict") {
    return cwd ? `${own}\n\nCurrent working directory: ${cwd}` : own;
  }
  if (mode === "append") {
    return own ? `${own}\n\n${base}` : base;
  }
  // replace: keep the harness's tools and guidelines, drop what frames it as a
  // particular product.
  const identity = stripIdentityLine(base);
  const docs = stripDocsBlock(identity.text);
  const kept = docs.text.replace(/\n{3,}/g, "\n\n").trim();
  const fallback = identity.found ? own : `${own}\n\n${base}`;
  return kept ? `${own}\n\n${kept}` : fallback;
}

/** The extension entry: one instance per session. */
export default function promptLab(pi) {
  let enabled = false;
  let mode = "strict";
  let source = EMBEDDED;
  let body = EMBEDDED_PERSONA;
  let lastError = "";

  const say = (message) => {
    try {
      pi.ui?.notify?.(message);
    } catch {
      /* a missing UI surface must not break the command */
    }
  };

  const load = async (path) => {
    try {
      // Loaded lazily so an unused extension reads nothing.
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(path, "utf8");
      if (!text.trim()) return "the file is empty";
      body = text;
      lastError = "";
      return "";
    } catch (error) {
      return String(error && error.message ? error.message : error);
    }
  };

  pi.on("before_agent_start", (event) => {
    if (!enabled) return undefined;
    const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    const cwd = String(event?.systemPromptOptions?.cwd ?? "").replace(/\\/g, "/");
    return { systemPrompt: composeSystemPrompt({ mode, persona: body, base, cwd }) };
  });

  pi.registerCommand("promptlab", {
    description: "Swap the system prompt for this session",
    handler: async (args) => {
      const [verb, ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      switch (verb) {
        case undefined:
        case "toggle":
          enabled = !enabled;
          say(enabled ? `Prompt Lab on (${mode})` : "Prompt Lab off");
          return;
        case "on":
          enabled = true;
          say(`Prompt Lab on (${mode})`);
          return;
        case "off":
          enabled = false;
          say("Prompt Lab off");
          return;
        case "mode":
          if (!MODES.includes(value)) {
            say(`mode must be one of ${MODES.join(", ")}`);
            return;
          }
          mode = value;
          say(`Prompt Lab mode ${mode}`);
          return;
        case "source": {
          if (!value) {
            say(`source: ${source}`);
            return;
          }
          if (value === EMBEDDED) {
            source = EMBEDDED;
            body = EMBEDDED_PERSONA;
            say("source: embedded example");
            return;
          }
          const failure = await load(value);
          if (failure) {
            lastError = failure;
            say(`could not read that file: ${failure}`);
            return;
          }
          source = value;
          say(`source: ${source}`);
          return;
        }
        case "status":
          say(
            [
              `enabled: ${enabled}`,
              `mode: ${mode}`,
              `source: ${source}`,
              `size: ${body.length} chars`,
              lastError ? `last error: ${lastError}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          );
          return;
        default:
          say("usage: /promptlab [on|off|status|mode append|replace|strict|source <path|embedded>]");
      }
    },
  });
}
