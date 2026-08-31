/**
 * The one YAML-frontmatter splitter.
 *
 * A frontmatter document opens with `---` on its own line, closes with `---`
 * on its own line, and everything after the close fence is the body. Both
 * fences tolerate trailing spaces/tabs and CRLF; the close fence may end the
 * file without a trailing newline.
 *
 * Callers own their body-whitespace policy (SkillParser trims, the markdown
 * editors keep the body verbatim so a save round-trips byte-for-byte) and
 * their own typed reading of `yaml` — this module only finds the boundary and
 * offers a flat `key: value` read for the simple cases.
 */

const OPEN_FENCE = /^---[ \t]*\r?\n/;
const CLOSE_FENCE = /\r?\n---[ \t]*(?:\r?\n|$)/;

export interface ParsedFrontmatter {
  /** Whether a complete `---` … `---` fence pair was found. */
  has: boolean;
  /** Raw YAML between the fences ('' when `has` is false). */
  yaml: string;
  /** Flat `key: value` pairs, surrounding quotes stripped. */
  fields: Record<string, string>;
  /** Everything after the close fence — or the whole input when `has` is false. */
  body: string;
  /** 0-based line index at which `body` starts, for editors that map offsets. */
  bodyStartLine: number;
}

const EMPTY = (raw: string): ParsedFrontmatter => ({
  has: false,
  yaml: '',
  fields: {},
  body: raw,
  bodyStartLine: 0,
});

export function parseFrontmatterDoc(raw: string): ParsedFrontmatter {
  const open = OPEN_FENCE.exec(raw);
  if (!open) return EMPTY(raw);

  const afterOpen = raw.slice(open[0].length);
  const close = CLOSE_FENCE.exec(afterOpen);
  if (!close) return EMPTY(raw);

  const yaml = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length);
  const consumed = raw.length - body.length;

  return {
    has: true,
    yaml,
    fields: parseFrontmatterFields(yaml),
    body,
    bodyStartLine: raw.slice(0, consumed).split('\n').length - 1,
  };
}

/** Flat `key: value` reader — one level, no nesting, quotes stripped. */
export function parseFrontmatterFields(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const val = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) fields[key] = val;
  }
  return fields;
}
