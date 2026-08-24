/**
 * Base-direction resolution for rendered markdown blocks.
 *
 * Replaces `dir="auto"`, whose two failure modes both surfaced as RTL bugs in
 * a Hebrew-locale app (FLOWPAD-2015):
 *
 *  1. `dir="auto"` picks the direction from the block's FIRST STRONG
 *     CHARACTER. A Hebrew list item that merely opens with an English term —
 *     `Persian – חתול רגוע…` — has a Latin first-strong char, so the whole
 *     block flipped to LTR: marker on the wrong side, punctuation and
 *     alignment with it. One leading word decided a paragraph of Hebrew.
 *  2. HTML's `dir="auto"` algorithm SKIPS the text inside descendant subtrees
 *     that carry their own `dir` attribute. The renderer put `dir="auto"` on
 *     `<li>` as well as on `<ol>`/`<ul>`, so the list element could see none
 *     of its items' text, found no strong character at all, and fell back to
 *     LTR — for EVERY list, including all-Hebrew ones. `ms-6` then resolved
 *     to `margin-left` and the list indented from the wrong side.
 *
 * So: count the WORDS of each script across the block's own subtree and let
 * the majority win, with the UI locale as the tiebreaker. Majority beats
 * first-strong (fixing 1), and reading the subtree ourselves is unaffected by
 * descendant `dir` attributes (fixing 2). Blocks with no strong characters at
 * all (`42`, `—`, emoji) follow the locale instead of silently going LTR.
 *
 * Code is excluded from the count: identifiers are Latin by nature and a
 * single inline `snake_case` token should not flip a Hebrew sentence.
 */

/** Text direction, matching `SupportedLocale['dir']`. */
export type TextDirection = 'ltr' | 'rtl';

/**
 * Strong right-to-left characters: Hebrew, Arabic, Syriac, Thaana, NKo, plus
 * the Arabic/Hebrew presentation forms. Deliberately excludes the neutrals
 * (digits, punctuation, whitespace) — they belong to neither side and would
 * only add noise to the comparison.
 */
const RTL_STRONG = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\u07C0-\u07FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** Strong left-to-right characters: Latin (incl. extended), Greek, Cyrillic. */
const LTR_STRONG = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

/** Subtrees whose text is not prose and must not vote on direction. */
const NON_PROSE_TAGS: ReadonlySet<string> = new Set(['code', 'pre', 'kbd', 'samp']);

/** Minimal structural shape of a hast node, as react-markdown passes it. */
type HastLike = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: unknown[];
};

/**
 * Concatenate the prose text of a hast subtree, skipping code.
 *
 * Exported for tests; callers want {@link resolveTextDirection}.
 */
export function hastText(node: unknown): string {
  const n = node as HastLike | null | undefined;
  if (!n || typeof n !== 'object') return '';
  if (n.type === 'text') return n.value ?? '';
  if (n.tagName && NON_PROSE_TAGS.has(n.tagName)) return '';
  if (!Array.isArray(n.children)) return '';
  let out = '';
  for (const child of n.children) out += hastText(child);
  return out;
}

/** The direction of one word: its first strong character decides, or none. */
function wordDirection(word: string): TextDirection | null {
  for (const ch of word) {
    if (RTL_STRONG.test(ch)) return 'rtl';
    if (LTR_STRONG.test(ch)) return 'ltr';
  }
  return null;
}

/**
 * The base direction for a block, decided by which script owns more of its
 * WORDS. Ties — including "no strong characters at all" — go to `localeDir`,
 * so an app in Hebrew stays Hebrew-shaped by default.
 *
 * Words, not characters, because character counts are biased by how compactly
 * a script writes. A Hebrew glossary line reads `פרסי (Persian)` — plainly
 * Hebrew-led, yet Latin wins on raw character count (7 vs 4) and the list
 * flips. Counting words scores that 1-1 and lets the locale break the tie,
 * and scores `Persian - <ten Hebrew words>` decisively RTL.
 */
export function directionOfText(text: string, localeDir: TextDirection): TextDirection {
  let rtl = 0;
  let ltr = 0;
  for (const word of text.split(/\s+/)) {
    const dir = wordDirection(word);
    if (dir === 'rtl') rtl++;
    else if (dir === 'ltr') ltr++;
  }
  if (rtl > ltr) return 'rtl';
  if (ltr > rtl) return 'ltr';
  return localeDir;
}

/** {@link directionOfText} over a react-markdown `node`. */
export function resolveTextDirection(node: unknown, localeDir: TextDirection): TextDirection {
  return directionOfText(hastText(node), localeDir);
}
