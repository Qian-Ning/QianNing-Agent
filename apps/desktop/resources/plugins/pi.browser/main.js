/**
 * Browser — bundled first-party plugin (ADR 0170).
 *
 * The view is chrome only. The guest page and debugger stay host-owned and are
 * reached through the public `pi.browser.*` API gated by `browser.cdp`.
 */

const ACTIONS = [
  "navigate",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "evaluate",
  "console",
  "cdp",
];

// Read-only actions that stay available in Plan and Goal modes (ADR 0211).
// navigate visits a URL/path; snapshot reads the accessibility tree;
// screenshot captures the visible page; console returns existing console
// messages. The mutating actions (click/fill/evaluate/cdp) remain
// Agent-only.
const PLAN_SAFE_ACTIONS = ["navigate", "snapshot", "screenshot", "console"];

// A delivered input is not an applied change. Every mutating action reports the
// page's outcome as `effect`, so a caller never reads `ok: true` as "it worked":
// `confirmed` means a value was read back from the page, `unverifiable` means
// the call landed but the page's response was not, `suspected_noop` means the
// page ignored it, and `refused` means nothing was sent. `verified` is true
// only for a read-back. Read-only actions (snapshot/screenshot/console) carry
// no `effect` — they observe the page instead of changing it (D654).
function effectOf(result) {
  if (!result || typeof result !== "object") return { effect: "unverifiable", verified: false };
  const out = {
    effect: typeof result.effect === "string" ? result.effect : "unverifiable",
    verified: result.verified === true,
  };
  if (typeof result.code === "string") out.code = result.code;
  if (result.escalation && typeof result.escalation === "object") out.escalation = result.escalation;
  if (typeof result.observed === "string") out.observed = result.observed;
  return out;
}

// A navigation hands back the state it committed to, so it is confirmable: a
// load error is a refusal, and a null state is a navigation queued for another
// session's tab, which this call never observed.
function navigateEffect(state) {
  if (state && state.loadError) {
    return {
      effect: "refused",
      verified: false,
      code: "NAVIGATION_FAILED",
      escalation: {
        recommended: "snapshot",
        reason: "the navigation did not commit; check the target and snapshot",
      },
    };
  }
  if (state && state.url) return { effect: "confirmed", verified: true };
  return {
    effect: "unverifiable",
    verified: false,
    escalation: {
      recommended: "snapshot",
      reason: "the navigation was queued for a background tab and is not observed here",
    },
  };
}

export async function onLoad() {
  await pi.agent.registerTool({
    name: "Browser",
    description:
      "Drive QianNing Agent's work-panel browser via CDP: snapshot the accessibility tree, click/fill by uid, screenshot, evaluate JavaScript, read console output, or send an allowlisted raw CDP method. Mutating actions (navigate/click/fill/evaluate/cdp) report an `effect` — a dispatched input is not a confirmed one, so check `effect`/`verified` and follow `escalation` instead of assuming success. Call ToolSearch for \"browser\" or \"cdp\" to load this tool. Use BrowserPreview to open a workspace HTML file with live reload.",
    risk: "medium",
    planSafeActions: PLAN_SAFE_ACTIONS,
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "Operation to run against the visible work-panel guest.",
        },
        url: { type: "string", description: "http(s) URL for action=navigate." },
        path: {
          type: "string",
          description: "Workspace-relative HTML file for action=navigate.",
        },
        uid: {
          type: "string",
          description: "Snapshot uid (e1, e2, …) for click/fill.",
        },
        text: { type: "string", description: "Text to type for action=fill." },
        expression: {
          type: "string",
          description: "JavaScript for action=evaluate.",
        },
        method: { type: "string", description: "Allowlisted CDP method for action=cdp." },
        params: {
          type: "object",
          description: "CDP parameters for action=cdp.",
        },
        fullPage: {
          type: "boolean",
          description: "Capture the full page for action=screenshot.",
        },
        limit: {
          type: "number",
          description: "Max console messages for action=console.",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action ?? "").trim();
      switch (action) {
        case "navigate": {
          const state = await pi.browser.navigate({
            url: args?.url ? String(args.url) : undefined,
            path: args?.path ? String(args.path) : undefined,
          });
          return { ok: true, action, state, ...navigateEffect(state) };
        }
        case "snapshot":
          return { ok: true, action, ...(await pi.browser.snapshot()) };
        case "screenshot": {
          const shot = await pi.browser.screenshot({
            fullPage: args?.fullPage === true,
          });
          return {
            ok: true,
            action,
            text: shot.path
              ? `Captured screenshot (${shot.mimeType}) saved at ${shot.path}.`
              : `Captured screenshot (${shot.mimeType}).`,
            path: shot.path,
            mimeType: shot.mimeType,
            images: [{ mimeType: shot.mimeType, data: shot.data }],
          };
        }
        case "click":
          return {
            ok: true,
            action,
            uid: args?.uid,
            ...effectOf(await pi.browser.click({ uid: String(args?.uid ?? "") })),
          };
        case "fill":
          return {
            ok: true,
            action,
            uid: args?.uid,
            ...effectOf(
              await pi.browser.fill({
                uid: String(args?.uid ?? ""),
                text: String(args?.text ?? ""),
              }),
            ),
          };
        case "evaluate":
          return {
            ok: true,
            action,
            // `confirmed` here means the expression ran and its value came
            // back. A mutation the expression performs is the caller's own
            // read-back to make, not something this layer observed.
            effect: "confirmed",
            verified: true,
            result: await pi.browser.evaluate({
              expression: String(args?.expression ?? ""),
            }),
          };
        case "console":
          return {
            ok: true,
            action,
            ...(await pi.browser.console({
              limit: typeof args?.limit === "number" ? args.limit : undefined,
            })),
          };
        case "cdp":
          return {
            ok: true,
            action,
            // Raw passthrough: whether the method changed anything depends on
            // the method, which this layer does not interpret.
            effect: "unverifiable",
            verified: false,
            result: await pi.browser.cdp({
              method: String(args?.method ?? ""),
              params: args?.params,
            }),
          };
        default:
          return {
            ok: false,
            error: `unknown action "${action}"; use ${ACTIONS.join(", ")}`,
          };
      }
    },
  });
}

export async function onUnload() {
  await pi.agent.unregisterTool("Browser");
}
