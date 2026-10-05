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
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { apiBase, apiContext } from '../_shared/api';
import { clickPrintedLink, printLink } from '../_shared/xterm';

const API = apiBase();
let root: string;
let server: Server;
let origin: string;

/** A solid red 4×4 PNG, so the lightbox has real bytes to show. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP47+AARwzEcQB6ohfxQHZOgQAAAABJRU5ErkJggg==', 'base64');

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flowpad-message-links-')));
  await writeFile(join(root, 'probe.py'), '# probe\nprint("message-link-probe")\n');
  server = createServer((req, res) => {
    if (req.url === '/shot.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
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
  await printLink(page, shellId, web);
  await clickPrintedLink(page, web);
  await expect(page.frameLocator('[data-testid="web-url-frame"]').getByRole('heading')).toHaveText('Web link content');
  expect(dockPath(page)).toBe(fromMessage);
});
