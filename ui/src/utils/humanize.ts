/**
 * `humanizeType` — the app's title-caser for machine identifiers.
 *
 * Lives here rather than in `tabs/provider-meta.tsx` (its original home)
 * because it is a pure string function and that module is a React surface:
 * it pulls entity hooks, a store and four icon components. Importing it from a
 * leaf just to title-case a word dragged all of that into the leaf's module
 * graph — which broke a component test whose mock of `useDockNavigation` was
 * suddenly reached transitively. `provider-meta` re-exports it, so its existing
 * callers are unchanged.
 */

/** `google_chat` → `Google Chat`. Separators become spaces; each word caps. */
export function humanizeType(s: string): string {
  return s
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
