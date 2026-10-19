/**
 * The wiki-pointer grammar: how `wiki/<space>/<word>` is read, in ONE place.
 *
 * A wiki route names its subject instead of identifying it — no typeid, no path
 * — so anything that wants to say where such a route points has to parse it.
 * That used to happen twice with different answers: the tab strip took the LAST
 * path segment while the resolver takes the FIRST, so one wiki URL could name
 * two different pages on screen at once.
 *
 * Lives in the SDK because both consumers do: the frontend's DockPointer and
 * the SDK's own tab naming.
 */

/** The project-scoped wiki alias. Not a Wiki id — resolved per project. */
export const DEFAULT_WIKI_SPACE = '@local';

export interface AssetWikiRef {
  /** Wiki UUID / `@uname`, or the project-scoped `@local` alias. */
  space: string;
  /** Exactly as written in the URL, decoded. The key the resolve store is
   *  filed under, so readers must pass THIS, not the canonical form. */
  name: string;
  /** What actually gets looked up — see `canonicalWikiWord`. Use this to LABEL
   *  the route; `name` can say `Docs/Child` while `Docs` is what resolved. */
  word: string;
}

/**
 * The word a wiki route really resolves, mirroring the backend's
 * ``canonicalize_word`` (`flow_sdk/wiki/parser.py`).
 *
 * A wiki word carries link decorations the resolver strips: an alias after
 * `|`, a heading after `#`, a block after `^`, a `.md` suffix, and — the
 * surprising one — everything past the FIRST path segment. So
 * `Docs/Nested Child Page` resolves `Docs`, and a UI that echoes the raw URL
 * segment names a page that was never opened.
 *
 * Case and Unicode are preserved, exactly as the backend does.
 */
export function canonicalWikiWord(name: string): string {
  const stripped = name.trim().split('|')[0].split('#')[0].split('^')[0];
  const withoutExt = stripped.endsWith('.md') ? stripped.slice(0, -3) : stripped;
  const parts = withoutExt.split('/').filter((p) => p && p !== '.' && p !== '..');
  // The backend throws on an empty word; a URL is not ours to reject, so fall
  // back to the raw text and let the resolver answer 'missing'.
  return parts[0] || withoutExt.trim() || name;
}

/**
 * Split the `<space>/<word…>` half of a wiki pointer.
 *
 * Only the FIRST separator divides them: the space never contains one, the
 * name may. A single segment is the historical `wiki/<word>` deep link, which
 * means the project-scoped `@local` wiki.
 */
export function splitWikiValue(value: string): AssetWikiRef {
  const cut = value.indexOf('/');
  const space = cut < 0 ? DEFAULT_WIKI_SPACE : value.slice(0, cut);
  const name = cut < 0 ? value : value.slice(cut + 1);
  return { space, name, word: canonicalWikiWord(name) };
}

/**
 * Read a full `wiki/<space>/<word>` pointer, or null when it isn't one.
 *
 * Tolerates the historical two-segment form. Callers holding an already-parsed
 * asset pointer should use `splitWikiValue` on its value instead.
 */
export function parseWikiPointer(pointer?: string | null): AssetWikiRef | null {
  if (!pointer) return null;
  const parts = pointer.split('/');
  if (parts[0] !== 'wiki' || parts.length < 2) return null;
  return splitWikiValue(parts.slice(1).join('/'));
}
