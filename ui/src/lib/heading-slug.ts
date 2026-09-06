/**
 * The GitHub-flavored-markdown heading slug — what a `#fragment` link and the
 * wiki deep-link scroll (`?wikiFragment=`) match a rendered heading by. One
 * rule, exported, so a caller that wants to land on a heading names the
 * heading's TEXT and lets this derive the slug, rather than hand-slugging it
 * and drifting when the heading or the rule changes.
 */
export function gfmSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
