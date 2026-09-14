import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal, ILink } from '@xterm/xterm';
import { FileLinkProvider, fileLinkMatches } from '@src/components/terminal/interactive-terminal/terminal-links';
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

  it('maps wrapped paths after wide characters to actual terminal cells', async () => {
    const terminal = new HeadlessTerminal({ cols: 20, rows: 5, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write('界 /tmp/long-directory/file.py:12:3', resolve));
      const provider = new FileLinkProvider(terminal as unknown as Terminal, () => {});
      let links: ILink[] | undefined;
      provider.provideLinks(2, (value) => { links = value; });
      expect(links?.[0].text).toBe('/tmp/long-directory/file.py:12:3');
      expect(links?.[0].range.start).toEqual({ x: 4, y: 1 });
      expect(links?.[0].range.end).toEqual({ x: 15, y: 2 });
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
