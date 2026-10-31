/** `! cmd` command links: detection on every surface, and what a click / the menu offers. */
import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { ILink, Terminal } from '@xterm/xterm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { commandLinkMatches, linkMatches } from '@src/lib/link-matches';
import { commandOf, linkKind } from '@src/lib/link-kind';
import { linkActions, type LinkContext } from '@src/components/links/link-actions';
import remarkLinkRefs from '@src/lib/remark-link-refs';
import { TerminalLinkProvider } from '@src/components/terminal/interactive-terminal/terminal-links';

const texts = (line: string) => linkMatches(line).map((m) => m.text);

describe('command link detection', () => {
  it('finds `! cmd` alone on a line, indented or as a list item', () => {
    expect(texts('Please run this in the prompt:\n\n  ! gcloud auth login\n')).toEqual(['! gcloud auth login']);
    expect(texts('- !./run.sh --fast')).toEqual(['!./run.sh --fast']);
  });

  it('finds a quoted command in prose, at the offset of its text', () => {
    const line = 'action: you run "! gcloud auth login" in the prompt, then `! gh auth login`.';
    const found = commandLinkMatches(line);
    expect(found.map((m) => m.text)).toEqual(['! gcloud auth login', '! gh auth login']);
    for (const m of found) expect(line.slice(m.index, m.index + m.text.length)).toBe(m.text);
  });

  it('holds the paths inside a command as part of it', () => {
    expect(texts('! cat src/a.ts:3 https://x.test/y')).toEqual(['! cat src/a.ts:3 https://x.test/y']);
  });

  it('leaves prose that merely starts with ! alone', () => {
    expect(texts('! Important: read docs/a.md')).toEqual(['docs/a.md']);
    expect(texts('wow! that worked')).toEqual([]);
  });

  it('is its own link kind, and runs without the !', () => {
    expect(linkKind('! gcloud auth login', 'http://app.test')).toBe('command');
    expect(commandOf('! gcloud auth login')).toBe('gcloud auth login');
    expect(commandOf('!./run.sh')).toBe('./run.sh');
  });
});

describe('command links in markdown', () => {
  const links = (md: string) => {
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkLinkRefs).runSync(unified().use(remarkParse).parse(md)) as Root;
    const out: string[] = [];
    const walk = (node: { type: string; url?: string; children?: unknown[] }) => {
      if (node.type === 'link') out.push(node.url!);
      for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
    };
    walk(tree as never);
    return out;
  };

  it('links inline code that is one command, and a command line', () => {
    expect(links('run `! gcloud auth login`, then tell me')).toEqual(['! gcloud auth login']);
    expect(links('Please run:\n\n! gcloud auth login')).toEqual(['! gcloud auth login']);
  });

  it('leaves a code span that is a plain shell command alone', () => {
    expect(links('`cat a/b.txt`')).toEqual([]);
  });
});

describe('command links in a terminal', () => {
  async function lineLinks(data: string): Promise<string[]> {
    const terminal = new HeadlessTerminal({ cols: 120, rows: 4, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      let links: ILink[] | undefined;
      new TerminalLinkProvider(terminal as unknown as Terminal, () => {}).provideLinks(1, (v) => {
        links = v;
      });
      return links?.map((l) => l.text) ?? [];
    } finally {
      terminal.dispose();
    }
  }

  it("ends Claude Code's colored inline code where its color ends", async () => {
    // How Claude Code draws "run `! gcloud auth login`, and tell me": no backticks, fg 153.
    expect(await lineLinks('run \x1b[38;5;153m! gcloud auth login\x1b[39m, and tell me')).toEqual(['! gcloud auth login']);
  });

  it('finds a plain command line', async () => {
    expect(await lineLinks('  ! gcloud auth login')).toEqual(['! gcloud auth login']);
  });

  it('a colored ! that starts no command is not a link', async () => {
    expect(await lineLinks('(The \x1b[38;5;153m!\x1b[39m prefix runs it)')).toEqual([]);
  });
});

describe('command link actions', () => {
  const ctx = (over: Partial<LinkContext>): LinkContext => ({
    kind: 'command',
    media: false,
    surface: 'tab',
    host: true,
    here: true,
    localNode: true,
    trusted: true,
    ...over,
  });

  it('runs in chat by default, and lists every mode, the browser and copy', () => {
    expect(linkActions(ctx({}))).toEqual({
      primary: 'run-here',
      menu: ['run-here', 'run-flowpad', 'run-external', 'command-browser', 'copy'],
    });
  });

  it('a click runs the last mode picked', () => {
    expect(linkActions(ctx({ lastMode: 'run-external' })).primary).toBe('run-external');
    expect(linkActions(ctx({ lastMode: 'run-flowpad', surface: 'vibe' })).primary).toBe('run-flowpad');
  });

  it('without a session to run in, in chat is gone and the click falls back to a Flowpad terminal', () => {
    const plan = linkActions(ctx({ here: false, lastMode: 'run-here' }));
    expect(plan.primary).toBe('run-flowpad');
    expect(plan.menu).not.toContain('run-here');
  });

  it("on another machine, no external terminal and no browser: nobody would see them", () => {
    expect(linkActions(ctx({ localNode: false })).menu).toEqual(['run-here', 'run-flowpad', 'copy']);
  });

  it("a command someone else wrote opens the menu instead of running", () => {
    expect(linkActions(ctx({ trusted: false })).primary).toBeNull();
  });
});
