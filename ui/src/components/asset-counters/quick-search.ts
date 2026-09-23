/** A query's lower-cased, whitespace-separated terms — split once per keystroke. */
export function quickSearchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term appears in `haystack`, which the caller has already lower-cased. */
export function matchesQuickSearch(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}
