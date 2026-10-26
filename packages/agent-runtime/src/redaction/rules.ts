/**
 * The rule table that decides what counts as a secret.
 *
 * Kept deliberately narrow. Every rule that fires on ordinary prose costs the
 * model context it needed — a project name rewritten to `{{EMAIL_…}}` makes the
 * conversation unreadable — so the built-ins cover shapes that are specific
 * enough to be unambiguous, and the loudest one (email) ships disabled.
 *
 * Rules are data, not code: a caller can add, disable or reprioritise them
 * without touching this module, and the settings surface stores the same shape.
 */

/** One matcher. `pattern` is a regex source compiled with `g` and `d`. */
export interface RedactionRule {
  id: string;
  /** Placeholder type written into the token, uppercase. */
  type: string;
  pattern: string;
  /** Capture group holding the secret; 0 means the whole match. */
  captureGroup?: number;
  ignoreCase?: boolean;
  enabled: boolean;
  /** Higher wins when two rules claim overlapping spans. */
  priority: number;
  description: string;
}

export interface RedactionHit {
  start: number;
  end: number;
  text: string;
  type: string;
  ruleId: string;
}

export interface RuleSetOptions {
  rules: RedactionRule[];
  /**
   * Substrings that mark a value as public. A hit whose text contains any entry
   * is left alone, so `docs@example.com` in a fixture stays readable.
   */
  allowlist?: string[];
}

const DEFAULT_ALLOWLIST = ["example.com", "example.org", "example.net", "localhost", "127.0.0.1"];

/**
 * The shipped rule set.
 *
 * `phone` and `idcard` are Chinese formats because that is the shape of the
 * data this app is used on; a deployment with different identifier formats adds
 * rules rather than editing these. `email` stays disabled by default: addresses
 * appear in ordinary conversation far more often than they appear as the secret
 * the user is protecting.
 */
export function builtinRules(): RedactionRule[] {
  return [
    {
      id: "pem-private-key",
      type: "PEM",
      pattern: String.raw`-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----`,
      enabled: true,
      priority: 220,
      description: "PEM 私钥块",
    },
    {
      id: "connection-string",
      type: "CONNSTR",
      // Only the password segment is replaced: the scheme, user and host stay
      // readable, so the model can still reason about what it is looking at.
      pattern: String.raw`\b[a-z][a-z0-9+.-]*://[^\s:/@]+:([^\s@/]{3,})@`,
      captureGroup: 1,
      ignoreCase: true,
      enabled: true,
      priority: 180,
      description: "连接串中的密码段",
    },
    {
      id: "api-credential",
      type: "APIKEY",
      pattern: String.raw`(?<![A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|ghs_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
      enabled: true,
      priority: 170,
      description: "常见服务商的 API key、令牌与 JWT",
    },
    {
      id: "cn-id-card",
      type: "IDCARD",
      pattern: String.raw`(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)`,
      enabled: true,
      priority: 150,
      description: "18 位身份证号",
    },
    {
      id: "cn-mobile",
      type: "PHONE",
      pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
      enabled: true,
      priority: 140,
      description: "中国大陆手机号",
    },
    {
      id: "email",
      type: "EMAIL",
      pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
      enabled: false,
      priority: 80,
      description: "邮箱地址（默认关闭）",
    },
  ];
}

/** Compiles one rule for a scan. Never cached across calls, never shared. */
function compile(rule: RedactionRule): RegExp {
  const flags = `gd${rule.ignoreCase ? "i" : ""}`;
  return new RegExp(rule.pattern, flags);
}

/**
 * Applies the rule table to one string.
 *
 * Overlaps are resolved by priority, then by earliest start, so `sk-…` inside a
 * connection string is claimed by the connection string's password span and not
 * emitted twice. Zero-width matches are ignored: a rule that can match nothing
 * would otherwise loop the global regex forever.
 */
export class RuleSet {
  private readonly rules: RedactionRule[];
  private readonly allowlist: string[];

  constructor(options: RuleSetOptions) {
    this.rules = options.rules.map((rule) => ({ ...rule }));
    this.allowlist = (options.allowlist ?? DEFAULT_ALLOWLIST).map((entry) => entry.toLowerCase());
  }

  findHits(text: string): RedactionHit[] {
    const candidates: Array<RedactionHit & { priority: number }> = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const pattern = compile(rule);
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        const group = rule.captureGroup ?? 0;
        const indices = (match as RegExpMatchArray & { indices?: [number, number][] }).indices;
        const span = indices?.[group];
        const value = match[group];
        if (!span || value === undefined || value.length === 0) continue;
        if (this.allowed(value)) continue;
        candidates.push({
          start: span[0],
          end: span[1],
          text: value,
          type: rule.type,
          ruleId: rule.id,
          priority: rule.priority,
        });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority || a.start - b.start);
    const taken: Array<[number, number]> = [];
    const accepted: RedactionHit[] = [];
    for (const candidate of candidates) {
      const overlaps = taken.some(([start, end]) => candidate.start < end && candidate.end > start);
      if (overlaps) continue;
      taken.push([candidate.start, candidate.end]);
      accepted.push({
        start: candidate.start,
        end: candidate.end,
        text: candidate.text,
        type: candidate.type,
        ruleId: candidate.ruleId,
      });
    }
    accepted.sort((a, b) => a.start - b.start);
    return accepted;
  }

  private allowed(value: string): boolean {
    const lower = value.toLowerCase();
    return this.allowlist.some((entry) => entry.length > 0 && lower.includes(entry));
  }
}
