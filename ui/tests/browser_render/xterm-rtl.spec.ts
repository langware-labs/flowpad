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
 * Terminals reach RTL by one of two mutually exclusive contracts, and which one
 * applies is decided by the PTY side — never by the viewer:
 *
 *   browser-bidi — the app emits LOGICAL order, so the browser must reorder
 *     the row. Every app on macOS/Linux, and codex everywhere.
 *   buffer-order — the app pre-reverses into VISUAL order for bidi-less
 *     conhost/Windows Terminal, so the row must paint as-is;
 *     applyRtlGridContract() tags those terminals `.xterm-rtl-grid`.
 *     Claude Code on Windows is the one app proven to do this.
 *
 * So the choice is a function of BOTH host platform and CLI vendor — two apps
 * on the same Windows host want opposite contracts.
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

/**
 * A row of the REAL codex TUI, byte-for-byte from a live macOS session: one CUP
 * (`ESC [ <row> ; <col> H`) followed by the whole sentence in LOGICAL order.
 *
 * Codex links `unicode-width` but no bidi crate and has no reordering path, so
 * this is what it emits on EVERY platform — it never pre-reverses the way
 * Claude Code does on Windows. Which is why the contract cannot be chosen by
 * the host platform alone.
 */
const CODEX_ROW = '[11;3Hשלום עולם זה משפט ארוך בעברית';

/** The codex sentence in the order it was written, letters only. */
const CODEX_SENTENCE = 'שלוםעולםזהמשפטארוךבעברית';

type Painted = { buffer: string; leftToRight: string; spansInRow: number };

/**
 * How the terminal picks its contract.
 *
 * A plain string drives one contract explicitly (host-platform independent).
 * `gate` instead runs the REAL applyRtlGridContract() with `platform` as the
 * value of `navigator.platform` it reads, and `vendor` as the PTY app in the
 * terminal — so the spec asserts the decision the product would actually make
 * on that host for that app, from a mac, a linux box or a Windows CI runner.
 */
type Contract = 'browser-bidi' | 'buffer-order' | { gate: { source: string; platform: string; vendor: string } };

async function paintRow(
  page: import('@playwright/test').Page,
  ptyRow: string,
  contract: Contract,
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
      if (contract === 'buffer-order') {
        container.classList.add('xterm-rtl-grid');
      } else if (typeof contract === 'object') {
        // Run the real gate against the host platform it is being asked about.
        Object.defineProperty(navigator, 'platform', {
          value: contract.gate.platform,
          configurable: true,
        });
        (0, eval)(`(${contract.gate.source})`)(container, contract.gate.vendor);
      }

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
function expectReadsRightToLeft(painted: Painted | null, sentence: string = SENTENCE): void {
  expect(painted, 'no Hebrew row was painted').not.toBeNull();
  const rightToLeft = [...painted!.leftToRight].reverse().join('');
  expect(
    rightToLeft,
    `row is painted left-to-right — on screen it reads "${painted!.leftToRight}" ` +
      `(${painted!.spansInRow} spans in the row)`,
  ).toBe(sentence);
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

  /**
   * The contract is a property of the PTY APP, not of the host: on Windows
   * Claude Code pre-reverses (buffer-order) while codex emits logical order
   * (browser-bidi). Both apps run on the same Windows host, so a gate that
   * reads only navigator.platform must get one of them wrong.
   */
  test('a codex terminal on Windows reads right-to-left', async ({ page }) => {
    const painted = await paintRow(page, CODEX_ROW, {
      gate: { source: applyRtlGridContract.toString(), platform: 'Win32', vendor: 'codex' },
    });
    expectReadsRightToLeft(painted, CODEX_SENTENCE);
  });

  test('a Claude Code terminal on Windows still reads right-to-left', async ({ page }) => {
    const painted = await paintRow(page, VISUAL_ROW, {
      gate: { source: applyRtlGridContract.toString(), platform: 'Win32', vendor: 'claude' },
    });
    expectReadsRightToLeft(painted);
  });

  /**
   * The gate's whole decision matrix, driven explicitly so it asserts the same
   * thing on macOS, Linux and a Windows CI runner. `claudeThenCodex` covers the
   * re-decide path: worker_type arrives after term.open(), so the contract is
   * applied again once the vendor resolves and must CLEAR a stale class.
   */
  test('applyRtlGridContract selects buffer-order only for a pre-reversing app on Windows', async ({ page }) => {
    const decided = await page.evaluate(
      ({ source }) => {
        const gate = (0, eval)(`(${source})`);
        const on = (platform: string) =>
          Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
        const decide = (platform: string, ...vendors: string[]) => {
          on(platform);
          const el = document.createElement('div');
          for (const vendor of vendors) gate(el, vendor);
          return el.classList.contains('xterm-rtl-grid');
        };
        return {
          winClaude: decide('Win32', 'claude'),
          winCodex: decide('Win32', 'codex'),
          winUnknown: decide('Win32', 'unknown'),
          winClaudeThenCodex: decide('Win32', 'claude', 'codex'),
          macClaude: decide('MacIntel', 'claude'),
          macCodex: decide('MacIntel', 'codex'),
        };
      },
      { source: applyRtlGridContract.toString() },
    );
    expect(decided).toEqual({
      winClaude: true,
      winCodex: false,
      winUnknown: false,
      winClaudeThenCodex: false,
      macClaude: false,
      macCodex: false,
    });
  });
});
