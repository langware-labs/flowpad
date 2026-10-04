/**
 * A link in a conversation message behaves exactly like the same link in a terminal —
 * one implementation (`lib/link-matches` + `components/links/LinkMenu`), two surfaces.
 * Real app, real backend: the message is sent through the composer, every click resolves
 * through `resolve-display-target` against the FlowMessage, and the same URL printed
 * by a real PTY must land on the very same dock tab.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { deflateSync } from 'node:zlib';
import { apiBase, apiContext } from '../_shared/api';

const sdkModule = `/@fs${resolve(dirname(fileURLToPath(import.meta.url)), '../../../../ts_sdk/src/index.ts')}`;
const API = apiBase();
let root: string;
let server: Server;
let origin: string;

/** A solid 4×4 PNG, so the lightbox has real bytes to show. */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(4).fill([255, 64, 64]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flowpad-message-links-')));
  await writeFile(join(root, 'probe.py'), '# probe\nprint("message-link-probe")\n');
  const image = png();
  server = createServer((req, res) => {
    if (req.url === '/shot.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(image);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Message link fixture</title><h1>Web link content</h1>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  await rm(root, { recursive: true, force: true });
});

async function sendMessage(page: Page, lines: string[]): Promise<string> {
  const rq = await apiContext();
  const created = await (await rq.post(`${API}/api/v1/graph/conversation`, { data: { title: `message-links-${Date.now()}` } })).json();
  await rq.dispose();
  const convId: string = created.data.id;
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await page.goto(`/dock/conversation/${convId}`);
  const composer = page.getByPlaceholder(/Reply to/);
  await composer.click();
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Shift+Enter');
    await page.keyboard.insertText(line);
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid^="message-bubble-"]')).toHaveCount(1);
  return page.url();
}

/** The dock address a click landed on, without the scope/view query the shell adds. */
const dockPath = (page: Page) => new URL(page.url()).pathname;

test('message links: same matches, click, menu, lightbox and dock tab as the terminal', async ({ page }) => {
  const web = `${origin}/page?next=%2Fdocs#section`;
  const file = join(root, 'probe.py');
  const conversationUrl = await sendMessage(page, [
    'היי ערן, לידיעתך בלבד, אין צורך לעשות כלום',
    `PR: ${web}`,
    `הקובץ: ${file}:2`,
    `תמונה: ${origin}/shot.png`,
  ]);
  const bubble = page.locator('[data-testid^="message-bubble-"]');

  // 1. The same matches the terminal finds — and nothing else.
  const links = bubble.locator('[data-link]');
  const linkTo = (text: string) => bubble.locator(`[data-link="${text}"]`);
  await expect(links).toHaveText([web, `${file}:2`, `${origin}/shot.png`]);
  await expect(links.first()).toHaveAttribute('role', 'link');
  await expect(links.first()).toHaveAttribute('dir', 'ltr');

  // 2. Selecting text across a link is a selection, not a click.
  const link = links.first();
  const box = (await link.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page).toHaveURL(conversationUrl);

  // 3. An image previews in place.
  await linkTo(`${origin}/shot.png`).click();
  await expect(page.getByTestId('media-lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('media-lightbox')).toHaveCount(0);

  // 4. A file reference resolves against the message and opens at its line.
  await linkTo(`${file}:2`).click();
  await expect(page).toHaveURL(/\/dock\/editor\/.*probe\.py\?line=2/);
  await page.goto(conversationUrl);

  // 5. The right-click menu is the terminal's menu; no process, so no Vibe.
  await linkTo(web).click({ button: 'right' });
  const menu = page.getByTestId('link-menu');
  await expect(menu).toContainText('Copy');
  await expect(menu).toContainText('Open in Flowpad');
  await expect(menu).toContainText('Open in browser');
  await expect(page.getByTestId('link-menu-vibe')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 6. A web URL opens as a Flowpad web tab.
  await linkTo(web).click();
  await expect(page.frameLocator('[data-testid="web-url-frame"]').getByRole('heading')).toHaveText('Web link content');
  const fromMessage = dockPath(page);
  expect(fromMessage).toMatch(/^\/dock\/web-app\/url\//);

  // 7. The same URL printed by a real terminal lands on the very same dock tab.
  await page.goto('/dock/shell/new_terminal?viewMode=advanced');
  await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
  const shellId = new URL(page.url()).pathname.split('/').pop()!.replace(/^shell-/, '');
  await page.evaluate(async ({ sdkModule, shellId, command }) => {
    const sdk = await import(sdkModule);
    await (await sdk.Shell.getById(shellId)).sendInput(command);
  }, { sdkModule, shellId, command: `printf '%s\\n' '${web}'\n` });
  const row = page.locator('.xterm-rows:visible > div').filter({ hasText: web }).last();
  await expect(row).toBeVisible();
  const point = await row.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let index = element.textContent?.replace(/\u00a0/g, ' ').indexOf(text) ?? -1;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (index >= length) { index -= length; continue; }
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`No glyph for ${text}`);
  }, web);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(page.frameLocator('[data-testid="web-url-frame"]').getByRole('heading')).toHaveText('Web link content');
  expect(dockPath(page)).toBe(fromMessage);
});
