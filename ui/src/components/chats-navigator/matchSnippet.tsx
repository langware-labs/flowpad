/**
 * Where a quick-search hit matched, as highlighted parts: from the session FTS
 * `snippet` (`…text <mark>hit</mark> text…`) or, for an instant match on the
 * loaded row, a window around the query in the field that matched. Parsed
 * into parts — never injected as HTML.
 */
export interface MatchPart {
  text: string;
  mark: boolean;
}

const CONTEXT_CHARS = 60;

const squash = (s: string) => s.replace(/\s+/g, ' ');

/** Parse the FTS snippet's `<mark>` spans; everything else is plain text. */
export function partsFromFtsSnippet(snippet: string | null | undefined): MatchPart[] | null {
  if (!snippet) return null;
  const parts: MatchPart[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: squash(snippet.slice(last, m.index)), mark: false });
    parts.push({ text: squash(m[1]), mark: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: squash(snippet.slice(last)), mark: false });
  return parts.some((p) => p.mark) ? parts : null;
}

/** A window of `text` around the first case-insensitive `query` match. */
export function partsAroundQuery(text: string | null | undefined, query: string): MatchPart[] | null {
  if (!text || !query) return null;
  const flat = squash(text);
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(flat.length, at + query.length + CONTEXT_CHARS);
  return [
    { text: (start > 0 ? '…' : '') + flat.slice(start, at), mark: false },
    { text: flat.slice(at, at + query.length), mark: true },
    { text: flat.slice(at + query.length, end) + (end < flat.length ? '…' : ''), mark: false },
  ].filter((p) => p.text);
}

export function MatchSnippet({ parts }: { parts: MatchPart[] }) {
  return (
    <span data-testid="chat-history-row-match">
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-sm bg-amber-400/25 px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
