import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  FONT_FAMILY,
  FONT_SIZE_PX,
  applyRtlGridContract,
} from '../../src/components/terminal/interactive-terminal/terminalConfig';

const here = dirname(fileURLToPath(import.meta.url));
const XTERM_JS = resolve(here, '../../node_modules/@xterm/xterm/lib/xterm.js');
const APP_XTERM_CSS = resolve(here, '../../src/styles/xterm.css');

const HEBREW = /[֐-׿]/;

/**
 * Terminals reach RTL by one of two mutually exclusive contracts, and which
 * one applies is decided by the PTY host, not by the viewer:
 *
 *   browser-bidi — macOS PTY apps emit LOGICAL order (native terminals there
 *     have real bidi engines), so the browser must reorder the row.
 *   buffer-order — Windows PTY apps pre-reverse into VISUAL order for
 *     bidi-less conhost/Windows Terminal, so the row must paint as-is;
 *     applyRtlGridContract() tags those terminals `.xterm-rtl-grid`.
 *
 * Both are exercised here explicitly rather than through the host platform, so
 * the suite asserts the same thing whether it runs on macOS, Linux or Windows.
 * The gate that chooses between them is asserted separately, below.
 */
const WORDS = ['בשעה', 'שהשמש', 'שוקעת', 'העולם', 'משנה', 'את', 'צבעיו'];

/**
 * A row of Claude Code's real macOS output, byte-for-byte as recorded from the
 * PTY of a live session (`~/.flow/instances/<name>/records_data/shell/<id>/
 * <id>.pty`): logical order, each word placed at an absolute column with CHA
 * (`ESC [ <n> G`).
 */
const LOGICAL_ROW = '[3Gבשעה[8Gשהשמש[14Gשוקעת[21Gהעולם' + '[27Gמשנה[32Gאת[35Gצבעיו';

/** The same sentence as a Windows PTY app emits it: pre-reversed for painting. */
const VISUAL_ROW = WORDS.map((w) => [...w].reverse().join(''))
  .reverse()
  .join(' ');

/** The sentence in the order it was written, letters only. */
const SENTENCE = WORDS.join('');

type Painted = { buffer: string; leftToRight: string; spansInRow: number };

async function paintRow(
  page: import('@playwright/test').Page,
  ptyRow: string,
  contract: 'browser-bidi' | 'buffer-order',
): Promise<Painted | null> {
  await page.setContent('<div id="term" style="width:900px;height:400px"></div>');
  await page.addStyleTag({ path: APP_XTERM_CSS });
  await page.addScriptTag({ path: XTERM_JS });

  return page.evaluate(
    async ({ fontFamily, fontSize, ptyRow, contract }) => {
      const hebrew = /[֐-׿]/;
      const container = document.getElementById('term')!;
      const { Terminal } = window as unknown as { Terminal: new (o: unknown) => any };

      // Same construction sequence as InteractiveTerminal.tsx.
      const term = new Terminal({
        scrollback: 50000,
        convertEol: true,
        cursorBlink: true,
        scrollOnUserInput: true,
        disableStdin: false,
        cursorStyle: 'block',
        fontFamily,
        fontSize,
        fontWeight: '400',
        fontWeightBold: '700',
        allowTransparency: true,
        allowProposedApi: true,
      });
      term.open(container);
      if (contract === 'buffer-order') container.classList.add('xterm-rtl-grid');

      await new Promise<void>((done) => term.write(ptyRow, done));
      await new Promise<void>((done) => requestAnimationFrame(() => done()));

      const row = [...container.querySelectorAll('.xterm-rows > div')].find((r) => hebrew.test(r.textContent ?? ''));
      if (!row) return null;

      // Where each glyph actually landed, measured on the painted row.
      const glyphs: { ch: string; x: number }[] = [];
      const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walk.nextNode())) {
        const text = (node as Text).data;
        for (let i = 0; i < text.length; i++) {
          if (!hebrew.test(text[i])) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          glyphs.push({ ch: text[i], x: range.getBoundingClientRect().left });
        }
      }

      return {
        buffer: glyphs.map((g) => g.ch).join(''),
        leftToRight: [...glyphs]
          .sort((a, b) => a.x - b.x)
          .map((g) => g.ch)
          .join(''),
        spansInRow: row.querySelectorAll('span').length,
      };
    },
    { fontFamily: FONT_FAMILY, fontSize: FONT_SIZE_PX, ptyRow, contract },
  );
}

/** Sweeping the painted row right-to-left must yield the emitted sentence. */
function expectReadsRightToLeft(painted: Painted | null): void {
  expect(painted, 'no Hebrew row was painted').not.toBeNull();
  const rightToLeft = [...painted!.leftToRight].reverse().join('');
  expect(
    rightToLeft,
    `row is painted left-to-right — on screen it reads "${painted!.leftToRight}" ` +
      `(${painted!.spansInRow} spans in the row)`,
  ).toBe(SENTENCE);
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.terminal_bidi.rules: FAILING? read this tag's rules before editing
//       — do NOT relax the assertion or the CSS; a row must stay one bidi paragraph
// flowpad:endcapsule tag
test.describe('xterm row rendering — RTL', () => {
  test('logical-order stream reads right-to-left (browser-bidi contract)', async ({ page }) => {
    const painted = await paintRow(page, LOGICAL_ROW, 'browser-bidi');
    expect(painted!.buffer, 'buffer should hold the emitted logical order').toBe(SENTENCE);
    expectReadsRightToLeft(painted);
  });

  test('visual-order stream reads right-to-left (buffer-order contract)', async ({ page }) => {
    const painted = await paintRow(page, VISUAL_ROW, 'buffer-order');
    expectReadsRightToLeft(painted);
  });

  test('applyRtlGridContract selects buffer-order only on Windows', async ({ page }) => {
    const decided = await page.evaluate(
      ({ source }) => {
        const el = document.createElement('div');
        (0, eval)(`(${source})`)(el);
        return { tagged: el.classList.contains('xterm-rtl-grid'), platform: navigator.platform };
      },
      { source: applyRtlGridContract.toString() },
    );
    expect(decided.tagged).toBe(decided.platform.toLowerCase().includes('win'));
  });
});
