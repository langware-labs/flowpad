import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal, ILink } from '@xterm/xterm';
import { TerminalLinkProvider, fileLinkMatches, linkAtCell } from '@src/components/terminal/interactive-terminal/terminal-links';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { DockPointer } from '@src/navigation/DockPointer';

describe('terminal links', () => {
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

  it('finds the file reference or web URL under a buffer cell, without relying on hover', async () => {
    const terminal = new HeadlessTerminal({ cols: 80, rows: 5, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write('see ui/a.ts:3 and https://example.com/x?y=1. ok', resolve));
      const term = terminal as unknown as Terminal;
      expect(linkAtCell(term, 5, 1)).toBe('ui/a.ts:3');
      expect(linkAtCell(term, 13, 1)).toBe('ui/a.ts:3');
      expect(linkAtCell(term, 19, 1)).toBe('https://example.com/x?y=1');
      expect(linkAtCell(term, 1, 1)).toBeNull();
      expect(linkAtCell(term, 15, 1)).toBeNull();
    } finally {
      terminal.dispose();
    }
  });

  it('maps wrapped paths after wide characters to actual terminal cells', async () => {
    const terminal = new HeadlessTerminal({ cols: 20, rows: 5, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write('界 /tmp/long-directory/file.py:12:3', resolve));
      const provider = new TerminalLinkProvider(terminal as unknown as Terminal, () => {});
      let links: ILink[] | undefined;
      provider.provideLinks(2, (value) => { links = value; });
      expect(links?.[0].text).toBe('/tmp/long-directory/file.py:12:3');
      expect(links?.[0].range.start).toEqual({ x: 4, y: 1 });
      expect(links?.[0].range.end).toEqual({ x: 15, y: 2 });
    } finally {
      terminal.dispose();
    }
  });

  it('joins a URL a TUI broke across rows itself (full row, cursor move, indented rest)', async () => {
    // What Claude Code writes at 40 cols: it fills each row from col 3 to the edge and
    // positions the cursor on the next row; no row is soft-wrapped.
    const url = 'http://localhost:9007/dock/shell/agentic_process-aeb31b55?scope-mode=project&viewMode=advanced';
    const terminal = new HeadlessTerminal({ cols: 40, rows: 6, allowProposedApi: true });
    try {
      const rows = ['⏺ ' + url.slice(0, 38), '  ' + url.slice(38, 76), '  ' + url.slice(76)];
      await new Promise<void>((resolve) => terminal.write(rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join('') + '\x1b[5;1Hnext', resolve));
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false);
      const term = terminal as unknown as Terminal;
      for (const y of [1, 2, 3]) {
        const provider = new TerminalLinkProvider(term, () => {});
        let links: ILink[] | undefined;
        provider.provideLinks(y, (value) => { links = value; });
        expect(links?.map((link) => link.text)).toEqual([url]);
        expect(links?.[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 2 + url.length - 76, y: 3 } });
      }
      expect(linkAtCell(term, 10, 2)).toBe(url);
      // A row that stops short of the edge ends the line.
      expect(linkAtCell(term, 1, 5)).toBeNull();
    } finally {
      terminal.dispose();
    }
  });

  it('joins across the one blank margin cell Claude Code leaves when echoing the prompt', async () => {
    const url = 'https://example.com/a-long/path?with=query&and=more';
    const terminal = new HeadlessTerminal({ cols: 30, rows: 4, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write(`\x1b[1;1H  ${url.slice(0, 27)}\x1b[2;1H  ${url.slice(27)}`, resolve));
      expect(linkAtCell(terminal as unknown as Terminal, 5, 2)).toBe(url);
    } finally {
      terminal.dispose();
    }
  });

  it('does not join a row that ends before the last column', async () => {
    const terminal = new HeadlessTerminal({ cols: 40, rows: 4, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write('see https://example.com/a\r\n  b/c.ts:3', resolve));
      const term = terminal as unknown as Terminal;
      expect(linkAtCell(term, 6, 1)).toBe('https://example.com/a');
      expect(linkAtCell(term, 4, 2)).toBe('b/c.ts:3');
    } finally {
      terminal.dispose();
    }
  });

  it('preserves URL identity and query/fragment across URL and persisted-tab round trips', () => {
    const url = 'https://example.org/a%20b?next=%2Fdocs#section';
    const dock = dockForDisplayTarget({ kind: 'url', url })!;
    expect(dock.webUrl).toBe(url);
    expect(DockPointer.fromUrl(dock.toUrl())?.webUrl).toBe(url);
    expect(DockPointer.fromJSON(dock.toJSON())?.webUrl).toBe(url);
    expect(dock.tabHash).not.toBe(DockPointer.forWebUrl('https://example.org/other').tabHash);
    expect(dock.targetTypeId).toBeNull();
    expect(() => DockPointer.forWebUrl('javascript:alert(1)')).toThrow();
  });

  it('carries file positions through the shared dock mapper', () => {
    expect(dockForDisplayTarget({ kind: 'vfs', path: '/tmp/a.py', line: 12, column: 3 })?.options).toMatchObject({ line: '12', column: '3' });
    expect(dockForDisplayTarget({ kind: 'vfs', path: '/tmp/a.md', line: 12 })?.options).toMatchObject({ initialLine: '12' });
  });
});
