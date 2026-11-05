/**
 * Deterministic browser coverage for the Vibe Workspace matrix.
 * Source: vibe_workspace_matrix.md
 *
 * Natural-language creation/run quality remains a live-Claude matrix. These
 * tests guard the product-owned rails beneath it: canonical workspace routing,
 * one-tab identity, `flow show` target rendering/history/restore, and the
 * project-local skill/image viewers. They require no model response.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';

import {
  API,
  createVibeFixture,
  destroyVibeFixture,
  displayUrlRe,
  openVibe,
  processUrlRe,
  registerWebappArtifact,
  showApp,
  showPath,
  showPort,
  showTypeId,
} from './_helpers';


/** Create a markdown in the fixture project and append a grep-able marker to its
 * file. Shared by the VW-17/18 and VW-19/20 suites — one definition, one drift
 * point; each suite passes its own fixture project and cleanup list. */
async function seedMarkedMarkdown(
  request: APIRequestContext,
  projectId: string,
  createdIds: string[],
  name: string,
  marker: string,
): Promise<{ id: string; asset_ref: string }> {
  const response = await request.post(`${API}/api/v1/graph/project/${projectId}/markdown`, {
    data: { name },
  });
  expect(response.status()).toBe(200);
  const entity = (await response.json()).data as { id: string; asset_ref: string };
  createdIds.push(entity.id);
  const scaffold = readFileSync(entity.asset_ref, 'utf8');
  writeFileSync(entity.asset_ref, `${scaffold}\n# ${marker}\n`, 'utf8');
  return entity;
}

test.describe('Claude Vibe Workspace browser matrix', () => {
  test('VW-01/VW-15: legacy display links canonicalize to one shell workspace tab', async ({ page, request }) => {
    const fixture = await createVibeFixture(request, 'vibe-entry');
    try {
      await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
      await page.goto(`/dock/display/agentic_process-${fixture.processId}?viewMode=vibe&matrix=legacy`);

      await expect(page).toHaveURL(processUrlRe(fixture.processId));
      expect(new URL(page.url()).searchParams.get('matrix')).toBe('legacy');
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      await expect(page.getByTestId('workspace-display-tab')).toHaveAttribute('aria-current', 'true');
      await expect(page.getByTestId('session-surface-vibe')).toHaveAttribute('aria-checked', 'true');

      const tabsResponse = await request.get(`${API}/api/v1/graph/tab/list_all`);
      expect(tabsResponse.status()).toBe(200);
      const tabs = (await tabsResponse.json()).data?.tabs ?? [];
      const processTabs = tabs.filter((tab: { target_id?: string }) => tab.target_id === fixture.processId);
      expect(processTabs).toHaveLength(1);
      expect(processTabs[0].parent_tab_id ?? null).toBeNull();
      const processPointer =
        processTabs[0].pointer ??
        processTabs[0].dock_pointer ??
        processTabs[0].dockPointer;
      expect(JSON.stringify(processPointer)).toContain('shell');
      expect(JSON.stringify(processPointer)).not.toContain('display');
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-02/VW-03/VW-07/VW-14: shown files render, history is newest-first, and Display restores', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-display-files');
    try {
      const docs = path.join(fixture.root, 'docs');
      const publicDir = path.join(fixture.root, 'public');
      mkdirSync(docs, { recursive: true });
      mkdirSync(publicDir, { recursive: true });
      const markdownPath = path.join(docs, 'open-me.md');
      const htmlPath = path.join(publicDir, 'open-me.html');
      writeFileSync(markdownPath, '# VW02_MARKDOWN_READY\n', 'utf8');
      writeFileSync(
        htmlPath,
        '<!doctype html><button id="activate" onclick="this.textContent=\'VW03_HTML_CLICKED\'">VW03_HTML_READY</button>',
        'utf8',
      );

      await showPath(request, fixture.processId, markdownPath);
      await showPath(request, fixture.processId, htmlPath);
      await openVibe(page, fixture.processId);

      // Restore is a redirect now: a cold landing on the process URL lands on the
      // NEWEST pin's own address, rather than rehydrating it into pane state.
      await expect(page).toHaveURL(displayUrlRe(fixture.projectId, fixture.processId));
      const htmlPreview = page.getByTestId('html-preview');
      await expect(htmlPreview).toBeVisible();
      const htmlFrame = page.frameLocator('[data-testid="html-preview"]');
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_READY');
      await htmlFrame.locator('#activate').click();
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_CLICKED');

      await page.getByTestId('display-history').click();
      const history = page.getByTestId('display-history-row');
      await expect(history).toHaveCount(2);
      await expect(history.nth(0)).toContainText('open-me.html');
      await expect(history.nth(1)).toContainText('open-me.md');
      await history.nth(1).click();
      // A document shown from a workspace carries its host in the URL:
      // `/dock/project/<P>/process/<typeid>/display/<tail>` (DockPointer
      // HOST_PARAM) — the document's identity is still the editor tail.
      await expect(page).toHaveURL(displayUrlRe(fixture.projectId, fixture.processId, 'editor/markdown/'));
      await expect(page.getByText('VW02_MARKDOWN_READY')).toBeVisible();
      await expect(page.getByTestId('workspace-child-strip')).toBeVisible();

      // VW-22: the square Display header navigates to the process, and entering
      // the process ALWAYS restores its last-shown item — no once-per-session
      // memory (7505e8574, FLOWPAD-2096). So from an older history entry it lands
      // on the newest show (the HTML), not on the bare process.
      await page.getByTestId('workspace-display-tab').click();
      await expect(page).toHaveURL(displayUrlRe(fixture.projectId, fixture.processId, 'editor/html/'));
      // The shown page is a parked frame: coming back to it does not reload it (FLOWPAD-2305), so the
      // click made before the round trip is still there.
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_CLICKED');

      // A hard reload is a new session, so restore fires again and returns the
      // user to the deliverable.
      await page.reload();
      await expect(page).toHaveURL(displayUrlRe(fixture.projectId, fixture.processId));
      await expect(htmlFrame.locator('#activate')).toHaveText('VW03_HTML_READY');
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-04/VW-05/VW-06: one running app target remains interactive and refreshes in place', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-running-app');
    let marker = 'VW04_EXISTING_APP';
    let countStep = 1;
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<!doctype html>
        <p id="marker">${marker}</p>
        <button id="count" onclick="this.textContent=String(Number(this.textContent)+${countStep})">0</button>`,
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('app fixture has no TCP port');
      await showPort(request, fixture.processId, address.port);
      await openVibe(page, fixture.processId);

      // A shown port is registered as a ServiceEndpoint and rendered by the app
      // dock (2ff1abbb4); its frame is `vibe-app-frame`, as in VW-25.
      const app = page.frameLocator('[data-testid="vibe-app-frame"]');
      await expect(app.locator('#marker')).toHaveText('VW04_EXISTING_APP');
      await app.locator('#count').click();
      await expect(app.locator('#count')).toHaveText('1');

      marker = 'VW06_VERSION_TWO';
      countStep = 2;
      await page.reload();
      await expect(app.locator('#marker')).toHaveText('VW06_VERSION_TWO');
      await app.locator('#count').click();
      await expect(app.locator('#count')).toHaveText('2');

      const process = (await (await request.get(`${API}/api/v1/graph/agentic_process/${fixture.processId}`)).json())
        .data;
      expect(process.context_data.display_stack).toHaveLength(1);
      // The port was registered as an endpoint; the display holds THAT, not the port.
      expect(process.context_data.last_shown).toMatchObject({ kind: 'app', runtime: 'dev' });
      expect(String(process.context_data.last_shown.typeid)).toMatch(/^service_endpoint-/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-08/VW-09/VW-13: project skill and image targets use their real viewers and survive reload', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-skill-image');
    try {
      const skillResponse = await request.post(`${API}/api/v1/graph/project/${fixture.projectId}/skill`, {
        data: { name: 'vibe-qa-greeter' },
      });
      expect(skillResponse.status()).toBe(200);
      const skill = (await skillResponse.json()).data;
      const skillDir = String(skill.asset_ref).replace(/\/SKILL\.md$/, '');
      mkdirSync(path.join(skillDir, 'references'), { recursive: true });
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: vibe-qa-greeter\ndescription: QA greeter\n---\n\nVIBE_GREETER_RAN\n',
        'utf8',
      );
      writeFileSync(path.join(skillDir, 'references', 'checklist.md'), 'VW09_REFERENCE\n', 'utf8');

      await showTypeId(request, fixture.processId, `skill-${skill.id}`);
      await openVibe(page, fixture.processId);
      await expect(page.getByText('VIBE_GREETER_RAN')).toBeVisible();
      await expect(page.getByText(/File is missing/i)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText('VIBE_GREETER_RAN')).toBeVisible();

      const imagePath = path.join(fixture.root, 'vibe-dog.png');
      writeFileSync(
        imagePath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xQAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      await showPath(request, fixture.processId, imagePath);
      // Await the show LANDING before reloading. A show is a navigation now, so a
      // reload fired in the same breath reloads the previous address — the display
      // no longer re-derives itself from `last_shown` on every mount, which is what
      // used to paper over this race.
      const image = page.getByTestId('media-viewer-image');
      await expect(image).toBeVisible();
      await page.reload();
      await expect(image).toBeVisible();
      expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
      await page.reload();
      await expect(page.getByTestId('media-viewer-image')).toBeVisible();
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-17/VW-18: asset entry stays URL-first and updates live', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-asset-origin');
    const createdIds: string[] = [];
    let discussProcessId: string | null = null;
    try {
      const source = await seedMarkedMarkdown(request, fixture.projectId, createdIds, 'vibe-origin-source', 'VW17_ORIGINAL');

      await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
      // A project's document outside its project (the bare `/dock/assets/…` form). Since 983df222b the
      // viewer's own Chat toggle replaced the top-bar Discuss icon, and it needs no project: a chat runs in
      // the doc's project, else the active one, else a per-instance scratch folder. So it is offered here.
      await page.goto(`/dock/assets/editor/markdown/typeid/markdown-${source.id}?viewMode=standard`);
      const globalChat = page.getByTestId('viewer-chat-toggle');
      await expect(globalChat).toBeEnabled();
      await expect(globalChat).toHaveAccessibleName('Chat about this file');

      // Opened inside its project — the address the app itself places a project's
      // document at (`rebaseAssetsOntoProject`: /dock/project/<P>/<editor tail>).
      await page.goto(`/dock/project/${fixture.projectId}/editor/markdown/typeid/markdown-${source.id}?viewMode=standard`);
      // The file's identity lives in the top bar's current crumb (the editor
      // has no header row of its own); the navigator tree also lists the file
      // under more than one root, so a bare text match is ambiguous.
      const crumb = page.getByTestId('top-nav-crumb-details-trigger');
      await expect(crumb).toHaveAttribute('title', 'vibe-origin-source.md');
      // The viewer's Chat toggle is the one in/out control for "chat with this doc" (983df222b).
      await expect(page.getByTestId('viewer-chat-toggle')).toBeVisible();
      await expect(page.getByTestId('viewer-chat-toggle')).toHaveAttribute('data-active', 'false');
      expect(await page.locator('[data-panel-id="asset-vibe-chat"]').getAttribute('data-panel-size')).toBe('0.0');
      expect(await page.locator('[data-panel-id="asset-vibe-content"]').getAttribute('data-panel-size')).toBe('100.0');
      const before = new URL(page.url());
      await page.getByTestId('viewer-chat-toggle').click();

      // Entering the chat opens a Vibe HOST tab with the document as its child (bd2e5b0d1,
      // `navigation.discussAsset`): the document keeps its own editor tail, now
      // addressed under the session that discusses it.
      const tail = before.pathname.slice(`/dock/project/${fixture.projectId}/`.length);
      await expect(page).toHaveURL(
        new RegExp(
          `/dock/project/${fixture.projectId}/process/agentic_process-[0-9a-f-]+/display/${tail}\\?.*viewMode=vibe`,
        ),
      );
      discussProcessId = new URL(page.url()).pathname.match(/\/process\/agentic_process-([0-9a-f-]+)\/display\//)![1];
      // No chat about this document existed, so one was created FOR it — in the
      // document's project, targeted at the document — not borrowed from the
      // project's unrelated session.
      expect(discussProcessId).not.toBe(fixture.processId);
      const host = (await (await request.get(`${API}/api/v1/graph/agentic_process/${discussProcessId}`)).json()).data;
      expect(host.project_id).toBe(fixture.projectId);
      expect(host.target_typeid_str).toContain(source.id);
      // The chat beside the document is that session (nothing left to start),
      // and the document is a child of its workspace.
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      await expect(page.getByTestId('vibe-start-new-chat')).toHaveCount(0);
      await expect(crumb).toHaveAttribute('title', 'vibe-origin-source.md');
      await expect(page.getByTestId('workspace-child-strip')).toBeVisible();
      expect(await page.locator('[data-panel-id="asset-vibe-chat"]').getAttribute('data-panel-size')).toBe('36.0');
      expect(await page.locator('[data-panel-id="asset-vibe-content"]').getAttribute('data-panel-size')).toBe('64.0');

      writeFileSync(source.asset_ref, `${readFileSync(source.asset_ref, 'utf8')}\n# VW18_LIVE_UPDATE\n`, 'utf8');
      const reindex = await request.post(`${API}/api/v1/graph/compute_node/@local/fs-records/invalidate`, {
        data: { paths: [source.asset_ref], deleted_paths: [] },
      });
      expect(reindex.status()).toBe(200);
      await expect(page.getByText('VW18_LIVE_UPDATE')).toBeVisible();

    } finally {
      if (discussProcessId) {
        await request.delete(`${API}/api/v1/graph/agentic_process/${discussProcessId}`).catch(() => undefined);
      }
      for (const id of createdIds) {
        await request.delete(`${API}/api/v1/graph/markdown/${id}`).catch(() => undefined);
      }
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VW-19/VW-20: shown related assets pin in the Display and reopen as workspace children', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-asset-related');
    const createdIds: string[] = [];
    try {
      const source = await seedMarkedMarkdown(request, fixture.projectId, createdIds, 'vibe-origin-source', 'VW17_ORIGINAL');
      const related = await seedMarkedMarkdown(request, fixture.projectId, createdIds, 'vibe-origin-related', 'VW20_RELATED');

      // A `flow show` steers only the workspace of the process that shows, and it
      // does so by NAVIGATING: the URL becomes the target's own display address,
      // named by the host (`.../process/<typeid>/display/...`). Since 5f383111f there
      // is no `activeDisplay` marker: each shown target is its own workspace child
      // tab (keyed `|@<host>`), and a prior target reopened from the history popover
      // returns to that same address.
      const hosted = (id: string) =>
        new RegExp(
          `/dock/project/${fixture.projectId}/process/agentic_process-${fixture.processId}/display/editor/markdown/typeid/markdown-${id}`,
        );
      await openVibe(page, fixture.processId);
      await showTypeId(request, fixture.processId, `markdown-${source.id}`);
      await expect(page.getByText('VW17_ORIGINAL')).toBeVisible();
      await expect(page).toHaveURL(hosted(source.id));

      await showTypeId(request, fixture.processId, `markdown-${related.id}`);
      await expect(page.getByText('VW20_RELATED')).toBeVisible();
      await expect(page).toHaveURL(hosted(related.id));
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();

      await page.getByTestId('display-history').click();
      const history = page.getByTestId('display-history-row');
      await expect(history).toHaveCount(2);
      // Entity targets are listed as `<type> · <id8>`, newest first.
      await expect(history.nth(0)).toContainText(related.id.slice(0, 8));
      await expect(history.nth(1)).toContainText(source.id.slice(0, 8));
      await history.nth(1).click();
      // Reopened at its own hosted address.
      await expect(page).toHaveURL(hosted(source.id));
      await expect(page.getByText('VW17_ORIGINAL')).toBeVisible();
      await expect(page.getByTestId('workspace-child-strip')).toBeVisible();
      await page.reload();
      await expect(page.getByText('VW17_ORIGINAL')).toBeVisible();
      await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
      expect(await page.locator('[data-panel-id="asset-vibe-chat"]').getAttribute('data-panel-size')).toBe('36.0');
      expect(await page.locator('[data-panel-id="asset-vibe-content"]').getAttribute('data-panel-size')).toBe('64.0');
    } finally {
      for (const id of createdIds) {
        await request.delete(`${API}/api/v1/graph/markdown/${id}`).catch(() => undefined);
      }
      await destroyVibeFixture(request, fixture);
    }
  });
  test('VW-21/VW-23/VW-24: the display is an address — one re-pointing row, Back-safe, promotable', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-display-address');
    try {
      const docs = path.join(fixture.root, 'docs');
      mkdirSync(docs, { recursive: true });
      const first = path.join(docs, 'vw21-first.md');
      const second = path.join(docs, 'vw21-second.md');
      writeFileSync(first, '# VW21_FIRST\n', 'utf8');
      writeFileSync(second, '# VW21_SECOND\n', 'utf8');

      await openVibe(page, fixture.processId);
      await expect(page).toHaveURL(processUrlRe(fixture.processId));

      // VW-21: a show NAVIGATES. The URL names the deliverable. Since 5f383111f there is no
      // `activeDisplay` marker and no single re-pointing row: each shown target is its own child tab
      // of the workspace (keyed `|@<host>`), under the session's one top-level tab.
      await showPath(request, fixture.processId, first);
      await expect(page).toHaveURL(displayUrlRe(fixture.projectId, fixture.processId));
      await expect(page.getByText('VW21_FIRST')).toBeVisible();
      // The address names the RESOLVED target, not the path: a shown file that the
      // display verb indexed resolves to its entity, so assertions compare URLs
      // rather than filenames.
      const firstUrl = page.url();

      await showPath(request, fixture.processId, second);
      await expect(page.getByText('VW21_SECOND')).toBeVisible();
      const secondUrl = page.url();
      expect(secondUrl).not.toBe(firstUrl);
      await expect(page).toHaveURL(displayUrlRe(fixture.projectId, fixture.processId));

      const workspaceRows = async () => {
        const tabs = (await (await request.get(`${API}/api/v1/graph/tab/list_all`)).json()).data?.tabs ?? [];
        const processTabs = tabs.filter((t: { target_id?: string }) => t.target_id === fixture.processId);
        const host = processTabs[0];
        const children = host ? tabs.filter((t: { parent_tab_id?: string }) => t.parent_tab_id === host.id) : [];
        return { processTabs, children };
      };
      // ONE top-level tab for the session, and each show a child of it; the newest show is a child.
      const secondTail = new URL(secondUrl).pathname.split('/display/')[1].split('/').pop()!;
      const { processTabs, children } = await workspaceRows();
      expect(processTabs).toHaveLength(1);
      expect(processTabs[0].parent_tab_id ?? null).toBeNull();
      expect(children).toHaveLength(2);
      expect(children.some((t: { pointer?: string }) => (t.pointer ?? '').includes(secondTail))).toBe(true);

      // VW-23: Back returns to the first show and Forward to the second (Back-safe).
      await page.goBack();
      await expect(page).toHaveURL(firstUrl);
      await page.goForward();
      await expect(page).toHaveURL(secondUrl);

      // VW-24: a shown target is already a durable tab of its own — nothing to promote (the display's
      // "Open in a new tab" is not offered on a workspace child) — and it survives a reload as one.
      await expect(page.getByTestId('display-open-in-tab')).toHaveCount(0);
      await page.reload();
      await expect(page.getByText('VW21_SECOND')).toBeVisible();
      const afterReload = await workspaceRows();
      expect(afterReload.processTabs).toHaveLength(1);
      expect(afterReload.children).toHaveLength(2);
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });
  test('VW-25/VW-26: an app is addressed by its artifact, and the host is vibe-only', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-app-address');
    // The artifact's port must be held by a program serving FROM the artifact's folder (a stranger on the port is
    // refused), so the fixture app is its own process with the fixture root as its cwd.
    const server = spawn(
      process.execPath,
      [
        '-e',
        "require('http').createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><p id=\"marker\">VW25_APP_READY</p>')}).listen(0,'127.0.0.1',function(){process.stdout.write(this.address().port+'\\n')})",
      ],
      { cwd: fixture.root, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        // The port as plain digits: the worker's FORCE_COLOR made a console.log'd number arrive as
        // '\u001b[33m37385\u001b[39m', which Number() reads as NaN (an artifact registered with no port).
        server.stdout.once('data', (chunk) => resolve(Number(/\d+/.exec(String(chunk))?.[0])));
      });
      const address = { port };

      const artifactId = await registerWebappArtifact(
        request,
        fixture.processId,
        fixture.root,
        address.port,
        'vw25-app',
      );
      await openVibe(page, fixture.processId);

      // VW-25: the ARTIFACT is the address. The port is deliberately absent — it is
      // a companion of the dev runtime, re-resolved on load, so a server that dies
      // between visits never becomes the app's identity.
      await expect(page).toHaveURL(new RegExp(`/dock/app/artifact-${artifactId}`));
      await expect(page).not.toHaveURL(/[?&]port=/);
      const app = page.frameLocator('[data-testid="vibe-app-frame"]');
      await expect(app.locator('#marker')).toHaveText('VW25_APP_READY');

      // Re-showing the same app is idempotent, and still one row.
      await showApp(request, fixture.processId, artifactId);
      await expect(app.locator('#marker')).toHaveText('VW25_APP_READY');
      // One row for the app: a child of the session's tab (5f383111f: each shown target is its own
      // workspace child; there is no host-keyed active-display row any more).
      const tabs = (await (await request.get(`${API}/api/v1/graph/tab/list_all`)).json()).data?.tabs ?? [];
      const host = tabs.find((t: { target_id?: string }) => t.target_id === fixture.processId);
      const appRows = tabs.filter((t: { pointer?: string }) => (t.pointer ?? '').includes(`artifact-${artifactId}`));
      expect(appRows).toHaveLength(1);
      expect(appRows[0].parent_tab_id).toBe(host?.id);

      // VW-26: leaving vibe strips the host — it only means something while a display pane is on
      // screen to be one — and the app keeps its artifact address. The session's own switch
      // (5a67651f9 retired the footer toggle) re-points the SESSION tab to Chat, so the page shows the
      // session; the app's row is carried out as a top-level tab (docs/tab-management.md "Leaving
      // Vibe carries children out"), still addressed by its artifact.
      await page.getByTestId('session-surface-chat').click();
      await expect(page).not.toHaveURL(/[?&]host=/);
      await expect(page).toHaveURL(new RegExp(`/dock/shell/[^?]*${fixture.processId}[^?]*\\?(.*&)?viewMode=standard`));
      const appRowAfter = async () => {
        const all = (await (await request.get(`${API}/api/v1/graph/tab/list_all`)).json()).data?.tabs ?? [];
        const rows = all.filter((t: { pointer?: string }) => (t.pointer ?? '').includes(`artifact-${artifactId}`));
        return rows.map((t: { parent_tab_id?: string | null; pointer?: string }) => ({
          top: !t.parent_tab_id,
          hosted: /[?&]host=/.test(t.pointer ?? ''),
        }));
      };
      await expect.poll(appRowAfter).toEqual([{ top: true, hosted: false }]);
    } finally {
      server.kill();
      await destroyVibeFixture(request, fixture);
    }
  });
});
