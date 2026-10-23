import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const UI = resolve(here, '../..');
const XTERM_JS = resolve(UI, 'node_modules/@xterm/xterm/lib/xterm.js');
const XTERM_CSS = resolve(UI, 'node_modules/@xterm/xterm/css/xterm.css');

/** The real production module, bundled for the page: it is what InteractiveTerminal calls after `open()`. */
async function bundleTerminalLinks(): Promise<string> {
  const out = await build({
    stdin: {
      contents: "export { registerTerminalLinks } from '@src/components/terminal/interactive-terminal/terminal-links';",
      resolveDir: UI,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'TerminalLinks',
    alias: { '@src': resolve(UI, 'src'), '@sdk': resolve(UI, '../ts_sdk/src') },
    // link-kind needs only `isLightboxMedia` from the lightbox component; serve that file's own
    // helpers (up to and including it) so the bundle doesn't drag in the React app behind it.
    plugins: [
      {
        name: 'lightbox-helpers-only',
        setup(b) {
          b.onLoad({ filter: /media-lightbox\.tsx$/ }, async (a) => {
            const src = await readFile(a.path, 'utf8');
            const body = src.slice(src.indexOf('const VIDEO_EXTS'), src.indexOf('// A <source>'));
            return { contents: `import { isImagePath } from '@sdk/utils/utils';\n${body}`, loader: 'ts' };
          });
        },
      },
    ],
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

test('a link click held across a TUI repaint still opens the link', async ({ page }) => {
  await page.setContent('<div id="term" style="width:900px;height:400px"></div>');
  await page.addStyleTag({ path: XTERM_CSS });
  await page.addScriptTag({ path: XTERM_JS });
  await page.addScriptTag({ content: await bundleTerminalLinks() });

  const link = await page.evaluate(async () => {
    const w = window as unknown as {
      Terminal: new (o: unknown) => any;
      TerminalLinks: { registerTerminalLinks: (t: unknown, h: unknown) => void };
      opened: string[];
    };
    const term = new w.Terminal({ fontSize: 14, allowProposedApi: true });
    term.open(document.getElementById('term'));
    w.opened = [];
    w.TerminalLinks.registerTerminalLinks(term, {
      activate: (_e: unknown, uri: string) => w.opened.push(uri),
      openMenu: () => {},
    });
    await new Promise<void>((done) => term.write('/Users/me/project/README.md\r\n\r\n\r\n\r\n', done));
    // A running Claude Code session repaints its spinner with an absolute cursor move
    // (`ESC[H` + `ESC[<n>B`, as recorded from the live PTY); xterm re-renders the whole
    // viewport on each one, including the link's row.
    let n = 0;
    setInterval(() => term.write(`\x1b[s\x1b[H\x1b[5BDetermining… ${++n}\x1b[u`), 30);
    const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: r.left + (r.width / term.cols) * 10, y: r.top + (r.height / term.rows) * 0.5 };
  });

  // A human click: the pointer rests on the link, then press and release ~120 ms apart.
  await page.mouse.move(link.x, link.y);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(100);

  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    '/Users/me/project/README.md',
  ]);
});
