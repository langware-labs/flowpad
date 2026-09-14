/** Real PTY output → xterm hit testing → backend resolution → focused dock tab. */
import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

const sdkModule = `/@fs${resolve(dirname(fileURLToPath(import.meta.url)), '../../../../ts_sdk/src/index.ts')}`;
let root: string;
let outside: string;
let webUrl: string;
let server: Server;

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flowpad-link-project-')));
  outside = await mkdtemp(join(tmpdir(), 'flowpad-link-outside-'));
  await mkdir(join(root, '.claude/skills/link-probe'), { recursive: true });
  await writeFile(join(root, 'probe.py'), '# Python link fixture\nprint("python-link-content")\n');
  await writeFile(join(root, '.claude/skills/link-probe/SKILL.md'), '---\nname: link-probe\ndescription: Terminal link browser fixture\n---\n# Skill link content\n');
  await writeFile(join(outside, 'outside.txt'), 'Temporary file link content\n');
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/blocked') res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end('<!doctype html><title>Link browser fixture</title><h1>Web link content</h1>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  webUrl = `http://127.0.0.1:${address.port}/page?next=%2Fdocs#section`;
});

test.afterAll(async () => {
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});

async function openFixtureTerminal(page: Page) {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await page.goto('/dock/shell/new_terminal?viewMode=advanced');
  await expect(page).toHaveURL(/\/dock\/shell\/shell-/);
  const shellId = await page.evaluate(async ({ sdkModule, root }) => {
    const sdk = await import(sdkModule);
    const project = await sdk.Project.getProjectByPath(root) ??
      await new sdk.Project({ name: 'Terminal link project', fs_storage_mount_path: root }).save();
    const cn = sdk.dataContext.computeNode;
    const shell = sdk.Shell.create(cn, { name: 'Link terminal', workdir: root });
    shell.project_id = project.id;
    await shell.save(cn.typeId);
    await (window as any).navigation.openShell(shell.id);
    return shell.id;
  }, { sdkModule, root });
  await expect(page).toHaveURL(new RegExp(shellId));
  await expect(page.locator('.xterm-rows:visible').first()).toContainText(/[%>$]/);
  return { shellId, terminalUrl: page.url() };
}

async function printLink(page: Page, shellId: string, link: string, osc = false) {
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

async function printedLinkPoint(page: Page, text: string, host = '') {
  // xterm renders spans, not anchors. Click the actual glyph's DOM position.
  const row = page.locator(`${host} .xterm-rows:visible > div`).filter({ hasText: text }).last();
  await expect(row).toBeVisible();
  return row.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let index = element.textContent?.replace(/\u00a0/g, ' ').indexOf(text) ?? -1;
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
    throw new Error(`No glyph for ${text}`);
  }, text);
}

async function clickPrintedLink(page: Page, text: string, host = '') {
  const point = await printedLinkPoint(page, text, host);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(`${host} .xterm-screen:visible`).last()).toHaveClass(/xterm-cursor-pointer/);
  await page.mouse.click(point.x, point.y);
}

for (const kind of ['python', 'skill', 'url', 'temp'] as const) {
  test(`${kind}: click opens, focuses, highlights, restores and reuses its tab`, async ({ page }, testInfo) => {
    const { shellId, terminalUrl } = await openFixtureTerminal(page);
    const link = kind === 'python' ? 'probe.py:2:3'
      : kind === 'skill' ? '.claude/skills/link-probe/SKILL.md'
      : kind === 'url' ? webUrl : join(outside, 'outside.txt');
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/resolve-display-target')) requests.push(request.url());
    });
    // Record the real highlight animation even if the destination mounts afterwards.
    await page.evaluate(() => {
      (window as any).__linkGlows = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const id = this.getAttribute('data-testid');
        if (id?.startsWith('tab-')) (window as any).__linkGlows.push(id);
        return animate.apply(this, args);
      };
    });
    await printLink(page, shellId, link);
    expect(requests).toHaveLength(0);
    await clickPrintedLink(page, link);
    await expect(page).not.toHaveURL(terminalUrl);
    expect(requests).toHaveLength(1);

    const assertContent = async () => {
      if (kind === 'url') {
        await expect(page.frameLocator('[data-testid="web-url-frame"]').getByRole('heading', { name: 'Web link content' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open in browser', exact: true })).toBeVisible();
      } else if (kind === 'skill') {
        await expect(page).toHaveURL(/typeid\/skill-/);
        await expect(page.getByText('Skill link content', { exact: true }).first()).toBeVisible();
      } else {
        await expect(page.locator('.monaco-editor:visible .view-lines').first()).toContainText(
          kind === 'python' ? 'python-link-content' : 'Temporary file link content',
        );
      }
    };
    await assertContent();
    if (kind === 'python') {
      await expect(page).toHaveURL(/line=2.*column=3/);
      await expect.poll(() => page.evaluate(() => (window as any).monaco?.editor.getEditors()
        .find((editor: any) => editor.getModel()?.getValue().includes('python-link-content'))?.getPosition(),
      )).toEqual({ lineNumber: 2, column: 3 });
    }
    const dockUrl = page.url();
    const targetKey = await page.evaluate(async () => {
      const { DockPointer } = await import('/src/navigation/DockPointer.ts');
      return DockPointer.fromUrl(location.pathname + location.search).tabHash;
    });
    const tab = page.getByTestId(`tab-content-${targetKey}`);
    await expect(tab).toBeVisible();
    await expect(tab).toContainText(kind === 'python' ? 'probe.py' : kind === 'temp' ? 'outside.txt' : kind === 'skill' ? 'link-probe' : '127.0.0.1');
    await expect.poll(() => page.getByTestId(`tab-shell|shell-${shellId}`).evaluate((source, targetId) => {
      const chips = [...source.closest('[data-testid="terminal-tabs-row"]')!.querySelectorAll('[data-testid^="tab-content-"], [data-testid^="tab-shell|"]')];
      return chips[chips.indexOf(source) + 1]?.getAttribute('data-testid') === targetId;
    }, `tab-content-${targetKey}`)).toBe(true);
    await expect.poll(() => page.evaluate((id) => (window as any).__linkGlows.includes(id), `tab-content-${targetKey}`)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${kind}.png`) });
    await page.reload();
    await assertContent();
    await page.getByTestId(`tab-shell|shell-${shellId}`).click();
    await expect(page).toHaveURL(new RegExp(shellId));
    await expect(page.locator('.xterm-rows:visible').first()).toContainText(link);
    await clickPrintedLink(page, link);
    await expect(page).toHaveURL(dockUrl);
    await expect(tab).toHaveCount(1);
    await assertContent();
  });
}

test('OSC 8, invalid references and web URL identity', async ({ page }) => {
  const { shellId } = await openFixtureTerminal(page);
  await printLink(page, shellId, webUrl, true);
  page.once('dialog', (dialog) => dialog.accept());
  await clickPrintedLink(page, 'OSC destination');
  await expect(page.frameLocator('[data-testid="web-url-frame"]').getByRole('heading')).toHaveText('Web link content');
  await page.getByTestId(`tab-shell|shell-${shellId}`).click();
  const second = webUrl.replace('/page?', '/second?');
  await printLink(page, shellId, second);
  await clickPrintedLink(page, second);
  await expect(page.locator('[data-testid^="tab-content-web-app|url/"]')).toHaveCount(2);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open in browser', exact: true }).click();
  await (await popup).close();
  await page.getByTestId(`tab-shell|shell-${shellId}`).click();
  const missing = '/tmp/flowpad-definitely-missing-link.txt';
  await printLink(page, shellId, missing);
  const terminalUrl = page.url();
  await clickPrintedLink(page, missing);
  await expect(page.getByText('Could not open link', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(terminalUrl);
});

test('sidecar uses the same file resolution and real app navigation', async ({ page }) => {
  const { shellId } = await openFixtureTerminal(page);
  await page.evaluate(async (shellId) => {
    const { mountSidecar } = await import('/tests/manual_regression/terminal/sidecar-link-harness.tsx');
    (window as any).__unmountSidecar = mountSidecar(shellId);
  }, shellId);
  const host = '[data-testid="sidecar-link-harness"]';
  await expect(page.locator(`${host} .xterm-rows`)).toBeVisible();
  await printLink(page, shellId, 'probe.py:2:3');
  await expect(page.locator(`${host} .xterm-rows`)).toContainText('probe.py:2:3');
  await clickPrintedLink(page, 'probe.py:2:3', host);
  await expect(page).toHaveURL(/\/dock\/editor\//);
  await page.evaluate(() => (window as any).__unmountSidecar());
  await expect(page.locator('.monaco-editor:visible .view-lines').first()).toContainText('python-link-content');
  await expect(page.locator('[data-testid^="tab-content-editor|"]').filter({ hasText: 'probe.py' })).toBeVisible();
});

test('hover and selection do not resolve; a wrapped file link still opens', async ({ page }) => {
  const { shellId, terminalUrl } = await openFixtureTerminal(page);
  let resolutions = 0;
  page.on('request', (request) => { if (request.url().includes('/resolve-display-target')) resolutions++; });
  await printLink(page, shellId, 'probe.py:2:3');
  const point = await printedLinkPoint(page, 'probe.py:2:3');
  await page.mouse.move(point.x, point.y);
  await expect(page.locator('.xterm-screen:visible').first()).toHaveClass(/xterm-cursor-pointer/);
  expect(resolutions).toBe(0);
  await page.mouse.down();
  await page.mouse.move(point.x + 160, point.y, { steps: 8 });
  await page.mouse.up();
  await expect(page).toHaveURL(terminalUrl);
  expect(resolutions).toBe(0);
  const folder = join(root, 'long-directory-'.repeat(10));
  await mkdir(folder);
  const file = join(folder, 'wrapped-probe.txt');
  await writeFile(file, 'Wrapped link content');
  await printLink(page, shellId, file);
  await clickPrintedLink(page, 'wrapped-probe.txt');
  await expect(page.locator('.monaco-editor:visible .view-lines').first()).toContainText('Wrapped link content');
  expect(resolutions).toBe(1);
});

test('a site that refuses embedding retains its external-open escape', async ({ page }) => {
  const { shellId } = await openFixtureTerminal(page);
  const url = new URL('/blocked', webUrl).href;
  await printLink(page, shellId, url);
  await clickPrintedLink(page, url);
  await expect(page.locator('[data-testid="web-url-frame"]')).toHaveAttribute('src', url);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open in browser', exact: true }).click();
  const external = await popup;
  await expect(external.getByRole('heading')).toHaveText('Web link content');
  await external.close();
});
