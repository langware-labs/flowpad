/** The one definition of a link in plain text, shared by the terminal and message bodies. */
import { describe, expect, it } from 'vitest';
import { fileLinkMatches, linkMatches, linkSegments, webLinkMatches } from '@src/lib/link-matches';

describe('link matches', () => {
  it('recognizes paths, positions, quoted spaces, and entity references without stealing web URLs', () => {
    const line = 'src/main.py:12:3 "/tmp/my file.txt" file:///tmp/a.txt skill-@link-probe https://example.org/src/main.py ordinary';
    expect(fileLinkMatches(line).map((match) => match.text)).toEqual([
      'src/main.py:12:3', '/tmp/my file.txt', 'file:///tmp/a.txt', 'skill-@link-probe',
    ]);
    for (const match of fileLinkMatches(line)) expect(line.slice(match.index, match.index + match.text.length)).toBe(match.text);
  });

  it('unwraps references that prose puts in brackets, keeping cell offsets exact', () => {
    const line = 'see (ui/src/a-b.ts:49) and [a.ts:3], {src/b.py:1:2}: ((main.c:7))';
    expect(fileLinkMatches(line).map((match) => match.text)).toEqual([
      'ui/src/a-b.ts:49', 'a.ts:3', 'src/b.py:1:2', 'main.c:7',
    ]);
    for (const match of fileLinkMatches(line)) expect(line.slice(match.index, match.index + match.text.length)).toBe(match.text);
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
    expect(segments.filter((segment) => segment.link).map((segment) => segment.link)).toEqual([
      'https://github.com/langware-labs/flowpad/pull/544',
    ]);
  });

  it('leaves text without links as one run', () => {
    expect(linkSegments('just words, e.g. this.')).toEqual([{ text: 'just words, e.g. this.' }]);
    expect(linkSegments('')).toEqual([]);
  });
});
