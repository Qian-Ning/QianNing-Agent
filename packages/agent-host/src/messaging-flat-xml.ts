/**
 * The one-level XML several Chinese platforms post.
 *
 * WeCom and the WeChat Official Account both send a single `<xml>` root with
 * plain scalar children, some wrapped in CDATA, and neither nests anything a
 * message needs. A general XML parser would be a dependency and an attack
 * surface this Host does not need for that shape, so this reads exactly it and
 * ignores anything nested.
 *
 * It is deliberately not a parser for arbitrary XML: a tag containing another
 * tag is not matched, which means a hostile body cannot talk this into building
 * a structure the callers would then trust.
 */

/** Read flat `<tag>value</tag>` pairs, CDATA or plain, into a record. */
export function parseFlatXml(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<([A-Za-z_][\w.-]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? "";
    if (name) fields[name] = value;
  }
  return fields;
}

/** One field, trimmed, or null when absent or blank. */
export function flatXmlField(fields: Record<string, string>, name: string): string | null {
  const value = fields[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
