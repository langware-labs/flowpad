/** Drive real PTY output in the running app: print a link, find its glyph, click it like a user. */
import { expect, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The TS SDK as the dev server serves it, for `page.evaluate` imports. */
export const sdkModule = `/@fs${resolve(dirname(fileURLToPath(import.meta.url)), '../../../../ts_sdk/src/index.ts')}`;

export async function printLink(page: Page, shellId: string, link: string, osc = false) {
  // Quote an actual shell command; the displayed output remains ordinary PTY bytes.
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const output = osc ? `\\033]8;;${link}\\007OSC destination\\033]8;;\\007` : link;
  await page.evaluate(async ({ sdkModule, shellId, command }) => {
    const sdk = await import(sdkModule);
    const shell = await sdk.Shell.getById(shellId);
    await shell.sendInput(command);
  }, { sdkModule, shellId, command: `printf '%b\\n' ${quote(output)}\n` });
  await expect(page.locator('.xterm-rows:visible').first()).toContainText(osc ? 'OSC destination' : link);
}

/**
 * The screen point of `text` (or the first match of a pattern) on its newest row. `scrollBack`:
 * only the rows on screen are drawn, so scroll up, as a person would, until it shows.
 */
export async function printedLinkPoint(page: Page, text: string | RegExp, host = '', { scrollBack = false } = {}) {
  // xterm renders spans, not anchors. Click the actual glyph's DOM position.
  const rows = page.locator(`${host} .xterm-rows:visible > div`).filter({ hasText: text });
  for (let up = 0; scrollBack && (await rows.count()) === 0 && up < 20; up++) {
    await page.locator(`${host} .xterm-screen:visible`).last().hover();
    await page.mouse.wheel(0, -200);
  }
  const row = rows.last();
  await expect(row).toBeVisible();
  const pattern = text instanceof RegExp ? text.source : null;
  return row.evaluate((element, { text, pattern }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const content = element.textContent?.replace(/\u00a0/g, ' ') ?? '';
    let index = pattern === null ? content.indexOf(text) : content.search(new RegExp(pattern));
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (index >= length) { index -= length; continue; }
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`No glyph for ${pattern ?? text}`);
  }, { text: String(text), pattern });
}

export async function clickPrintedLink(page: Page, text: string, host = '') {
  const point = await printedLinkPoint(page, text, host);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(`${host} .xterm-screen:visible`).last()).toHaveClass(/xterm-cursor-pointer/);
  await page.mouse.click(point.x, point.y);
}
