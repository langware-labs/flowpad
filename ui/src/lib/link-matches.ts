/**
 * What counts as a link in plain text — the one definition every surface shares.
 * The terminal maps these matches onto buffer cells; a message renders them as spans.
 * Candidate recognition only: the backend decides whether a reference exists.
 */
export interface LinkMatch {
  text: string;
  index: number;
}

/** WebLinksAddon's default URL pattern; one provider serves click and right-click alike. */
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;
const POSITION = String.raw`(?::\d+(?::\d+)?|#L\d+)`;
const BARE_FILE = new RegExp(String.raw`^[\w@.-]+\.(?:[A-Za-z][\w-]+${POSITION}?|[A-Za-z]${POSITION})$`);

export function fileLinkMatches(text: string): LinkMatch[] {
  const links: LinkMatch[] = [];
  const tokens = /"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|[^\s"'`<>]+/g;
  for (const match of text.matchAll(tokens)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    // Prose wraps references in brackets: `(src/a.ts:49)`.
    const lead = quoted === undefined ? /^[([{]*/.exec(match[0])![0].length : 0;
    const value = quoted ?? match[0].slice(lead).replace(/[.,;:!?)\]}]+$/, '');
    // webLinkMatches owns HTTP links, including their path portions.
    if (!value || /^https?:/i.test(value)) continue;
    // Placeholders (`/dock/...`) and bare punctuation or schemes name nothing.
    // Checked on the raw token: trailing-punctuation stripping would eat the `...`.
    if (/\.\.\.|…/.test(quoted ?? match[0]) || /^[./\\~]*$/.test(value) || /^file:\/*$/i.test(value)) continue;
    if (
      /^(?:file:\/\/|\.{0,2}\/|~\/|[A-Za-z]:[/\\])/.test(value) ||
      /^[\w@.-]+(?:[/\\][\w@. -]+)+(?:[:#]\w+(?::\d+)?)?$/.test(value) ||
      // A one-letter extension (`e.g`) is prose unless a position proves it is code (`main.c:3`).
      BARE_FILE.test(value) ||
      /^[a-z_]+-(?:@[\w.-]+|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value)
    ) links.push({ text: value, index: match.index + (quoted === undefined ? lead : 1) });
  }
  return links;
}

/** WebLinksAddon's check: the match must parse as a URL whose origin it starts with. */
function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
    return text.toLowerCase().startsWith(`${url.protocol}//${auth}${url.host}`.toLowerCase());
  } catch {
    return false;
  }
}

export function webLinkMatches(text: string): LinkMatch[] {
  return [...text.matchAll(new RegExp(URL_REGEX.source, 'g'))]
    .filter((match) => isUrl(match[0]))
    .map((match) => ({ text: match[0], index: match.index }));
}

/** Every file reference and web URL in `text`, in order, never overlapping. */
export function linkMatches(text: string): LinkMatch[] {
  const sorted = [...fileLinkMatches(text), ...webLinkMatches(text)].sort((a, b) => a.index - b.index);
  const links: LinkMatch[] = [];
  let end = 0;
  for (const match of sorted) {
    if (match.index < end) continue;
    links.push(match);
    end = match.index + match.text.length;
  }
  return links;
}

/** `text` cut into plain runs and links, for a surface that renders DOM. Joined, the runs are `text`. */
export function linkSegments(text: string): Array<{ text: string; link: boolean }> {
  const segments: Array<{ text: string; link: boolean }> = [];
  let at = 0;
  for (const match of linkMatches(text)) {
    if (match.index > at) segments.push({ text: text.slice(at, match.index), link: false });
    segments.push({ text: match.text, link: true });
    at = match.index + match.text.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at), link: false });
  return segments;
}
