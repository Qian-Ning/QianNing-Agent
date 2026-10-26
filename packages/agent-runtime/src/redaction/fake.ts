/**
 * Format-preserving stand-ins.
 *
 * A model that sees `{{PHONE_01M5…}}` reads a privacy filter and starts
 * explaining it instead of doing the task — reproduced twice against a live
 * provider, once with a "template placeholder" answer and once with a "local
 * privacy filter" answer. A same-shaped fake carries no such tell: the model
 * treats it as an ordinary number, and the reply is mapped back to the real one
 * before anyone reads it.
 *
 * Only phone numbers get a fake today. Every other rule keeps the typed
 * placeholder, because a fake credential invites the model to *use* it against a
 * real service, while a fake phone number is inert.
 */

/** Assignable mainland mobile prefixes; a stand-in must not look reserved. */
const MOBILE_PREFIXES = [
  "130", "131", "132", "133", "135", "136", "137", "138", "139",
  "150", "151", "152", "155", "156", "158", "159",
  "170", "171", "176", "177", "178",
  "180", "181", "182", "183", "184", "185", "186", "187", "188", "189",
  "199",
];

function digits(count: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < count; i += 1) out += String(Math.floor(random() * 10) % 10);
  return out;
}

/**
 * A phone number with the same shape as the one it replaces.
 *
 * `taken` rejects candidates the table already knows — both real values a user
 * pasted and stand-ins already issued. Colliding with an unseen real number is
 * possible in principle (one in a hundred million) and harmless in practice: the
 * table maps the stand-in back to whichever value it was issued for.
 */
export function synthesizePhone(taken: (candidate: string) => boolean, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const prefix = MOBILE_PREFIXES[Math.floor(random() * MOBILE_PREFIXES.length) % MOBILE_PREFIXES.length] as string;
    const candidate = `${prefix}${digits(8, random)}`;
    if (!taken(candidate)) return candidate;
  }
  return `199${digits(8, random)}`;
}

/** Types that get a same-shaped stand-in instead of a typed placeholder. */
export function usesFakeValue(type: string): boolean {
  return type === "PHONE";
}

/** The stand-in for `type`, or undefined when that type keeps its placeholder. */
export function synthesizeStandIn(
  type: string,
  taken: (candidate: string) => boolean,
  random: () => number = Math.random,
): string | undefined {
  return usesFakeValue(type) ? synthesizePhone(taken, random) : undefined;
}
