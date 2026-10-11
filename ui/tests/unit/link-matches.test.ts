/** The one definition of a link in plain text, shared by the terminal and message bodies. */
import { describe, expect, it } from 'vitest';
import { fileLinkMatches, linkMatches, linkSegments, webLinkMatches } from '@src/lib/link-matches';

/** The file links in `line`, each at an offset that slices back to its own text. */
function expectFileLinks(line: string, expected: string[]): void {
  const matches = fileLinkMatches(line);
  expect(matches.map((match) => match.text)).toEqual(expected);
  for (const match of matches) expect(line.slice(match.index, match.index + match.text.length)).toBe(match.text);
}

describe('link matches', () => {
  it('recognizes paths, positions, quoted spaces, and entity references without stealing web URLs', () => {
    const line = 'src/main.py:12:3 "/tmp/my file.txt" file:///tmp/a.txt skill-@link-probe https://example.org/src/main.py ordinary';
    expectFileLinks(line, [
      'src/main.py:12:3', '/tmp/my file.txt', 'file:///tmp/a.txt', 'skill-@link-probe',
    ]);
  });

  it('unwraps references that prose puts in brackets, keeping cell offsets exact', () => {
    const line = 'see (ui/src/a-b.ts:49) and [a.ts:3], {src/b.py:1:2}: ((main.c:7))';
    expectFileLinks(line, [
      'ui/src/a-b.ts:49', 'a.ts:3', 'src/b.py:1:2', 'main.c:7',
    ]);
  });

  it('reads quote marks inside a word as part of it, not as quotes that swallow the paths between them', () => {
    const line = "I've written docs/navigation/navigation_medium.md, it isn't committed; the users' 'notes/my a.md' and don't 'x.ts:3'";
    expectFileLinks(line, [
      'docs/navigation/navigation_medium.md', 'notes/my a.md', 'x.ts:3',
    ]);
    // Hebrew geresh and gershayim: צ'אט, צה"ל.
    expectFileLinks(`כתבתי צ'אט ב-docs/a.md וגם ג'ירה`, ['docs/a.md']);
    expectFileLinks(`צה"ל כתב docs/a.md לרמטכ"ל`, ['docs/a.md']);
  });

  it('keeps the brackets, signs and non-English letters a real path carries', () => {
    const line = 'ui/app/[slug]/page.tsx (ui/app/(marketing)/layout.tsx) build/a+b/c=d/out.txt routes/$id/route.ts data/a,b.csv, docs/50%_done.md docs/café/résumé.md docs/מדריך/קובץ.md docs/日本語/ファイル名.md';
    expectFileLinks(line, [
      'ui/app/[slug]/page.tsx', 'ui/app/(marketing)/layout.tsx', 'build/a+b/c=d/out.txt', 'routes/$id/route.ts',
      'data/a,b.csv', 'docs/50%_done.md', 'docs/café/résumé.md', 'docs/מדריך/קובץ.md', 'docs/日本語/ファイル名.md',
    ]);
  });

  it('links the file of a test id, a folder written with its slash, and a local address without a scheme', () => {
    const line = 'tests/unit/test_a.py::TestA::test_b[1] failed, see agentic-assets/data_driver/gmail/ and localhost:5001/dock/hub/home.';
    expectFileLinks(line, ['tests/unit/test_a.py', 'agentic-assets/data_driver/gmail/', 'localhost:5001/dock/hub/home']);
  });

  it('keeps a parenthesis that belongs to a web URL and drops one that wraps it', () => {
    const line = 'https://en.wikipedia.org/wiki/Rust_(programming_language) (https://en.wikipedia.org/wiki/Rust_(programming_language)).';
    expect(webLinkMatches(line).map((match) => match.text)).toEqual([
      'https://en.wikipedia.org/wiki/Rust_(programming_language)', 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
    ]);
  });

  it('does not link placeholders, bare schemes, or abbreviations', () => {
    const line = '- /dock/... and file://, e.g. i.e., x / y ~ ... … mailto: vscode: path:line:col http(s)://host/...';
    expect(fileLinkMatches(line)).toEqual([]);
  });

  it('ends a web URL before prose punctuation and keeps its query and fragment', () => {
    const line = 'PR: https://github.com/langware-labs/flowpad/pull/544. see (https://x.test/a?b=1#c), or https://y.test/z:';
    expect(webLinkMatches(line).map((match) => match.text)).toEqual([
      'https://github.com/langware-labs/flowpad/pull/544', 'https://x.test/a?b=1#c', 'https://y.test/z',
    ]);
  });

  it('orders file references and URLs by position, never overlapping', () => {
    const line = 'https://example.org/src/main.py then src/a.ts:3 and task-@probe';
    expect(linkMatches(line).map((match) => match.text)).toEqual([
      'https://example.org/src/main.py', 'src/a.ts:3', 'task-@probe',
    ]);
  });

  it('cuts Hebrew text around a URL into runs that join back to the text', () => {
    const text = 'היי ערן, התיקון כאן\nPR: https://github.com/langware-labs/flowpad/pull/544 תודה';
    const segments = linkSegments(text);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments.filter((segment) => segment.link).map((segment) => segment.text)).toEqual([
      'https://github.com/langware-labs/flowpad/pull/544',
    ]);
  });

  it('leaves text without links as one run', () => {
    expect(linkSegments('just words, e.g. this.')).toEqual([{ text: 'just words, e.g. this.', link: false }]);
    expect(linkSegments('')).toEqual([]);
  });
});
