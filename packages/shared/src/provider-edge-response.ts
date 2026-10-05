/**
 * Recognizing an edge intermediary's answer.
 *
 * A provider sits behind CDNs and WAFs that may answer a request themselves
 * instead of forwarding it: a Cloudflare "Attention Required!" challenge, a
 * country block, a bot rule. Those answers arrive as an HTML document carrying
 * an error status, which is indistinguishable from "the API rejected your key"
 * if only the status is read — and the difference matters, because re-entering
 * a working key cannot fix a path rule on someone else's edge.
 *
 * The rule lives here, in one place, because two surfaces have to agree on it:
 * the provider connection test in the Electron main process (which reads the
 * raw response) and the agent error classifier in the runtime (which usually
 * sees the failure already folded into a `"<status>: <body>"` string). If the
 * two disagreed, a connection test could pass on a provider whose every turn is
 * blocked — the exact failure this exists to prevent.
 */

/** An intermediary's block, as much of it as is safe to report back. */
export type EdgeBlock = {
  /** Short label for the intermediary when it identifies itself. */
  edge?: string;
  /** The status the edge answered with. */
  status?: number;
};

export type EdgeBlockEvidence = {
  status?: number;
  /** Raw response body, or the failure text a layer folded it into. */
  body?: string;
  /** `content-type` response header, when the caller has it. */
  contentType?: string | null;
  /** `server` response header, when the caller has it. */
  server?: string | null;
};

/**
 * Statuses an edge uses for a block, and on which its answer is taken as the
 * verdict. Not "every status an edge could return": the point is that a block on
 * one of these is reported as a block, so the list stays narrow enough that a
 * provider's own 4xx keeps its own meaning.
 */
const BLOCK_STATUSES: ReadonlySet<number> = new Set([403, 503]);

/**
 * Statuses that are always the API's own verdict about the credential, never an
 * edge's. 401 is the only one: a WAF challenge is never a 401, so a 401 stays an
 * authentication verdict even when its body is a document. Excluding it is the
 * conservative choice — telling a user their working key is fine when it is
 * actually rejected is worse than the reverse.
 */
const NON_EDGE_STATUSES: ReadonlySet<number> = new Set([401]);

/**
 * Markup anywhere in the payload.
 *
 * Every wire failure the provider could legitimately send is JSON, and JSON
 * cannot contain a bare `<html ` — a literal `<` inside a JSON string is
 * escaped to `\u003c`. So the presence of an unescaped document tag means the
 * API did not produce this body, whatever the content type claims.
 *
 * Membership rather than a prefix check because the classifier's copy of the
 * body is prefixed with the status (`"403: <!DOCTYPE html>..."`).
 */
const MARKUP_PATTERN = /<!doctype\s+html|<html[\s>]|<\/html>|<head[\s>]|<body[\s>]/i;

/** Intermediaries that sign their refusals, most specific first. */
const EDGE_SIGNATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/cloudflare/i, "cloudflare"],
  [/cloudfront/i, "cloudfront"],
  [/akamai/i, "akamai"],
  [/incapsula|imperva/i, "imperva"],
  [/sucuri/i, "sucuri"],
  [/aws-waf|\bawselb\b/i, "aws-waf"],
  [/fastly/i, "fastly"],
  [/varnish/i, "varnish"],
];

/** Body phrases that only ever appear in an interstitial. */
const CHALLENGE_PHRASES: ReadonlyArray<RegExp> = [
  /attention required/i,
  /enable javascript and cookies to continue/i,
  /checking your browser/i,
  /just a moment/i,
  /cf-error-details|cf-wrapper|cf-browser-verification|cf-chl-/i,
  /access denied.{0,40}reference #/i,
];

function detectEdgeName(evidence: EdgeBlockEvidence, body: string): string | undefined {
  const server = (evidence.server ?? "").trim();
  for (const [pattern, name] of EDGE_SIGNATURES) {
    if (server && pattern.test(server)) return name;
  }
  for (const [pattern, name] of EDGE_SIGNATURES) {
    if (pattern.test(body)) return name;
  }
  return undefined;
}

/**
 * Whether a failed response is an intermediary's own page rather than the API's
 * reply. Returns the identifying details, or `undefined` when the response is
 * not an edge block and the caller's normal classification should stand.
 *
 * Two conditions, both required:
 *
 * - the payload is markup (a document, or a content type that claims one); and
 * - either the status is one an edge uses for a block (403 / 503), or the page
 *   carries a challenge phrase.
 *
 * Each condition rules out a different mistake. Requiring markup is what keeps a
 * provider's own JSON 403 — a real permission verdict, which some gateways
 * return for a key that lacks a model — an authorization failure, and what keeps
 * a healthy but oddly-typed 200 from being reported as a block. Requiring a
 * block status or a challenge phrase is what keeps a 401 page, or an HTML 404,
 * from being reported as one — a page that merely mentions an intermediary in
 * its markup or its headers is not evidence that the intermediary answered.
 *
 * A block with no self-identifying intermediary is still a block: the API never
 * answers a failure with a document. `edge` is then absent and the caller
 * reports the status alone.
 */
export function detectEdgeBlock(evidence: EdgeBlockEvidence): EdgeBlock | undefined {
  const status = evidence.status;
  if (status !== undefined && NON_EDGE_STATUSES.has(status)) return undefined;
  const body = evidence.body ?? "";
  const htmlContentType = /text\/html|application\/xhtml/i.test(evidence.contentType ?? "");
  if (!MARKUP_PATTERN.test(body) && !htmlContentType) return undefined;

  const challenged = CHALLENGE_PHRASES.some((pattern) => pattern.test(body));
  const blockStatus = status !== undefined && BLOCK_STATUSES.has(status);
  if (!blockStatus && !challenged) return undefined;

  const edge = detectEdgeName(evidence, body);
  return {
    ...(edge ? { edge } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * The same verdict read from a folded failure message, where only the text of
 * the body survives and no headers are available. The caller has already
 * established the status.
 *
 * No content type is passed: a message-only caller cannot see one, and treating
 * the missing header as `text/html` would reclassify a provider's own JSON 403
 * as an edge block. Markup in the text is the whole test here.
 */
export function detectEdgeBlockInMessage(
  status: number | undefined,
  message: string,
): EdgeBlock | undefined {
  return detectEdgeBlock({ status, body: message });
}

/** Phrases that are worth surfacing verbatim as the reason, when present. */
export function edgeBlockReason(body: string): string | undefined {
  for (const pattern of CHALLENGE_PHRASES) {
    const match = body.match(pattern);
    if (match) return match[0].replace(/\s+/g, " ").trim();
  }
  return undefined;
}
