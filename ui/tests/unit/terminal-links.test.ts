import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal, ILink } from '@xterm/xterm';
import { TerminalLinkProvider, linkAtCell } from '@src/components/terminal/interactive-terminal/terminal-links';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { DockPointer } from '@src/navigation/DockPointer';

describe('terminal links', () => {
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

  it('links a path in a Claude Code reply whose prose has contractions on both sides of it', async () => {
    const terminal = new HeadlessTerminal({ cols: 120, rows: 5, allowProposedApi: true });
    try {
      const row = "⏺ I've written docs/navigation/navigation_medium.md with all 200 sentences. It isn't committed";
      await new Promise<void>((resolve) => terminal.write(row, resolve));
      expect(linkAtCell(terminal as unknown as Terminal, 20, 1)).toBe('docs/navigation/navigation_medium.md');
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

  // What Claude Code writes at 40 cols: it fills each row from col 3 to the edge and
  // positions the cursor on the next row; no row is soft-wrapped. Its question dialog
  // prefixes every row with the box's left border instead of indentation.
  it.each([
    ['indented rest', '⏺ ', '  '],
    ['bordered box', '│ ', '│ '],
  ])('joins a URL a TUI broke across rows itself (full row, cursor move, %s)', async (_, first, rest) => {
    const url = 'http://localhost:9007/dock/shell/agentic_process-aeb31b55?scope-mode=project&viewMode=advanced';
    const terminal = new HeadlessTerminal({ cols: 40, rows: 6, allowProposedApi: true });
    try {
      const rows = [first + url.slice(0, 38), rest + url.slice(38, 76), rest + url.slice(76)];
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

  /** Rows drawn the way a TUI draws them: each at its own cursor position, never soft-wrapped. */
  async function drawn(cols: number, rows: string[]): Promise<HeadlessTerminal> {
    const terminal = new HeadlessTerminal({ cols, rows: 8, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write(rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(''), resolve));
    return terminal;
  }

  it('joins a path a fullscreen TUI broke across rows after the terminal was narrowed', async () => {
    const path = '/private/tmp/claude-501/43be7b79-ac3c/scratchpad/memory_todo.md';
    const terminal = new HeadlessTerminal({ cols: 42, rows: 8, allowProposedApi: true });
    try {
      // The alternate screen keeps a row at its old length through a shrink; the edge is the terminal's width.
      await new Promise<void>((resolve) => terminal.write('\x1b[?1049h' + 'x'.repeat(42), resolve));
      terminal.resize(40, 8);
      const rows = ['  ' + path.slice(0, 38), '  ' + path.slice(38)];
      await new Promise<void>((resolve) => terminal.write('\x1b[2J' + rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(''), resolve));
      expect(terminal.buffer.active.getLine(0)?.length).toBe(42);
      expect(linkAtCell(terminal as unknown as Terminal, 10, 1)).toBe(path);
      expect(linkAtCell(terminal as unknown as Terminal, 4, 2)).toBe(path);
    } finally {
      terminal.dispose();
    }
  });

  it.each([
    ['a box with a right border too', (piece: string) => `│ ${piece} │`, 4],
    ['an ascii bar', (piece: string) => `| ${piece}`, 2],
    ['two blank cells before the edge', (piece: string) => `  ${piece}`, 4],
  ])('joins a URL broken across rows inside %s', async (_, frame, layout) => {
    const url = 'https://example.com/a-long/path/that/does-not/fit/in-two-rows?with=query&and=more#end';
    const room = 40 - layout;
    const terminal = await drawn(40, [frame(url.slice(0, room)), frame(url.slice(room, 2 * room)), frame(url.slice(2 * room))]);
    try {
      for (const y of [1, 2, 3]) expect(linkAtCell(terminal as unknown as Terminal, 3, y)).toBe(url);
    } finally {
      terminal.dispose();
    }
  });

  it.each([
    ['prose that ends at the edge, then a row starting with a path', ['  lorem ipsum dolor sit amet consectetur', '  src/app/main.ts is it'], 5, 2],
    ['a full-width rule above an indented path', ['─'.repeat(40), '  src/app/main.ts'], 5, 2],
  ])('keeps a row that merely happens to be full apart from the next: %s', async (_, rows, x, y) => {
    const terminal = await drawn(40, rows);
    try {
      expect(linkAtCell(terminal as unknown as Terminal, x, y)).toBe('src/app/main.ts');
    } finally {
      terminal.dispose();
    }
  });

  /** A path of exactly `length` characters. */
  const pathOf = (length: number, end = '.md') => `docs/navigation/${'x'.repeat(length - 16 - end.length)}${end}`;
  it.each([
    ['a word a sentence goes on with', pathOf(76), '', 'for details.'],
    ['a short one, after a file extension', pathOf(76), '', 'is the file'],
    ['the other script', pathOf(76), '', 'לפרטים נוספים'],
    ['a plain word, after a closing bracket', pathOf(75), ')', 'worked'],
    ['a capital, after a full stop', pathOf(75), '.', 'It worked'],
    ['a plain word, after a line position', pathOf(76, '.md:49'), '', 'worked'],
    ['a plain word, after an id', pathOf(76, '/96a2122d-8f4a-4e39-a6ad-55e372a8b82b'), '', 'worked'],
  ])('ends a long reference that stops exactly at the edge when the next row resumes the prose with %s', async (_, path, after, prose) => {
    const written = path + after;
    const terminal = await drawn(40, ['  ' + written.slice(0, 38), '  ' + written.slice(38), '  ' + prose]);
    try {
      expect(written).toHaveLength(76);
      for (const y of [1, 2]) expect(linkAtCell(terminal as unknown as Terminal, 5, y)).toBe(path);
      expect(linkAtCell(terminal as unknown as Terminal, 3, 3)).toBeNull();
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

/**
 * On Windows, Claude Code writes RTL lines pre-reversed into VISUAL order, so a sentence's
 * trailing `.`/`:` lands in front of the path and a Hebrew prefix (`ב-`) is glued to its end.
 * These rows are the buffer cells of a real Claude Code 2.1.289 reply, captured through a
 * Windows PTY and replayed into xterm.
 */
describe('terminal links in pre-reversed RTL rows', () => {
  async function linksOnRow(row: string): Promise<string[]> {
    const terminal = new HeadlessTerminal({ cols: 200, rows: 3, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write(row, resolve));
      let links: ILink[] | undefined;
      new TerminalLinkProvider(terminal as unknown as Terminal, () => {}).provideLinks(1, (value) => { links = value; });
      return (links ?? []).map((link) => link.text);
    } finally {
      terminal.dispose();
    }
  }

  it.each([
    ['plain path, sentence period moved in front',
      '● 1. .Notepad-ב םג ותוא חותפל רשפא .lectures/02-web-basics/docs/README.md :׳א ץבוק תא םיחתופ הז ירחא :שרושהמ אלמ ביתנ',
      'lectures/02-web-basics/docs/README.md'],
    ['backticked path (not drawn), sentence period moved in front',
      '  2. .git-ה תודוקפ לכ תא ללוכ אוה .lectures/05-git-basics/docs/git-basics.md :ןאכ אצמנ ׳ב ץבוק :backticks ךותב אלמ ביתנ',
      'lectures/05-git-basics/docs/git-basics.md'],
    ['Hebrew prefix glued by a hyphen',
      '  3. .ותוא ךל חתפא .docs/git-basics.md-ב אצמנ ץבוקה :)ךלש םוליצב ומכ( האצרהה תייקית ילב /docs-ב ליחתמש ביתנ',
      'docs/git-basics.md'],
    ['colon moved in front',
      '  4. .2 האצרה לש ץבוקה הז :docs/README.md :הרושה תליחתב ביתנ',
      'docs/README.md'],
  ])('case: %s', async (_name, row, path) => {
    expect(await linksOnRow(row)).toEqual(expect.arrayContaining([path]));
  });
});
