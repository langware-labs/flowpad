/**
 * From nothing to a streaming, specced, annotated source — see the .md runbook.
 * Serial gates, each under the 60 s cap; no live Claude (that is the long test).
 */
import { createServer, type Server } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiContext } from '../_shared/api';
import { createVibeFixture, destroyVibeFixture, openVibe, type VibeFixture } from '../vibe/_helpers';

const SCREEN = '/dock/data-sources';
const stamp = `${Date.now()}`.slice(-6);
const SOURCE_NAME = `e2e feed ${stamp}`;

let feed: Server;
let feedUrl = '';
let fixture: VibeFixture;
let sourceId = '';
let specId = '';
/** The rss definition's nested editor app — `micro_app-<uuid>`, its own address. */
let editorTypeId = '';
let datasetId = '';
let datasetFolder = '';

function atom(): string {
  const now = new Date();
  const entry = (i: number) => {
    const at = new Date(now.getTime() - i * 60_000).toISOString();
    return `<entry><id>urn:e2e:${stamp}:${i}</id><title>Entry ${i} ${stamp}</title><updated>${at}</updated><published>${at}</published><author><name>qa</name></author><content type="text">body ${i} zebrafish</content><link href="http://127.0.0.1/e/${i}"/></entry>`;
  };
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>e2e</title><updated>${now.toISOString()}</updated>${[1, 2, 3].map(entry).join('')}</feed>`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  feed = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(atom());
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
  const addr = feed.address();
  feedUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/feed.xml`;
  fixture = await createVibeFixture(request, 'ds-e2e');
});

test.afterAll(async ({ request }) => {
  const api = await apiContext();
  if (sourceId) await api.delete(`/api/v1/graph/data_source/${sourceId}`).catch(() => undefined);
  if (datasetId) await api.delete(`/api/v1/graph/dataset/${datasetId}`).catch(() => undefined);
  await api.dispose();
  if (datasetFolder && existsSync(datasetFolder)) rmSync(datasetFolder, { recursive: true, force: true });
  await destroyVibeFixture(request, fixture);
  await new Promise<void>((r) => feed.close(() => r()));
});

async function openScreen(page: Page) {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await page.goto(SCREEN);
  await expect(page.getByTestId('data-sources-view')).toBeVisible();
}

test('1. from scratch: the screen is empty and offers the agent', async ({ page }) => {
  await openScreen(page);
  await expect(page.getByTestId('add-data-source')).toBeVisible();
  const cards = page.locator('[data-testid="source-card"]');
  if ((await cards.count()) === 0) {
    await expect(page.getByTestId('data-sources-ask-agent')).toBeVisible();
  }
});

test('2. connect: an rss source over the dialog, pointed at the loopback feed', async ({ page }) => {
  await openScreen(page);
  await page.getByTestId('add-data-source').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add a data source' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('provider-rss').click();
  await dialog.locator('#ds-name').fill(SOURCE_NAME);
  await dialog.locator('#ds-feed_urls').fill(feedUrl);
  const submit = dialog.getByRole('button', { name: 'Add source' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  const card = page.locator('[data-testid="source-card"][data-provider="rss"]').filter({ hasText: SOURCE_NAME });
  await expect(card).toBeVisible();

  const api = await apiContext();
  const rows = ((await (await api.get('/api/v1/graph/data_source')).json()).data ?? []) as { id: string; name: string }[];
  sourceId = rows.find((r) => r.name === SOURCE_NAME)?.id ?? '';
  expect(sourceId, 'the source row exists').toBeTruthy();
  const specs = ((await (await api.get('/api/v1/graph/data_source_spec')).json()).data ?? []) as { id: string; name: string }[];
  specId = specs.find((s) => s.name === 'rss')?.id ?? '';
  expect(specId, 'the rss definition is indexed').toBeTruthy();
  // The editor is a webapp asset NESTED in the definition, so finding it is a
  // containment query — there is no registry of editors to read.
  const apps = ((await (await api.get(
    `/api/v1/graph/micro_app?filter=${encodeURIComponent(JSON.stringify({ parent_type_id: `data_source_spec-${specId}` }))}`,
  )).json()).data ?? []) as { id: string; kind?: string }[];
  editorTypeId = `micro_app-${apps.find((a) => a.kind === 'application.web.editor')?.id ?? ''}`;
  expect(editorTypeId, "the definition's editor is indexed as its child").not.toBe('micro_app-');
  const polled = await (await api.post(`/api/v1/graph/data_source/${sourceId}/poll_now`)).json();
  expect(polled.data?.status).toBe('due');
  await api.dispose();
});

test('3. streaming: items land on the heartbeat', async () => {
  // The heartbeat is ≤60 s after poll_now (test 2, ~10 s ago); sample, never hurry.
  const filter = encodeURIComponent(JSON.stringify({ data_source_id: sourceId }));
  await expect(async () => {
    const api = await apiContext();
    const rows = ((await (await api.get(`/api/v1/graph/source_item?filter=${filter}&limit=10`)).json()).data ?? []) as unknown[];
    await api.dispose();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 55_000, intervals: [5_000] });
});

function editorFrame(page: Page) {
  // PersistentIframe parks the real <iframe> in a body-level portal (the host
  // div only positions it), so locate the frame by its served URL. The editor is
  // served like any other webapp — `/graph/micro_app/<id>/view/`.
  return page.frameLocator('iframe[src*="/micro_app/"]');
}

test('4. the editor: config form + live items in the asset dock', async ({ page }) => {
  await openScreen(page);
  await page.getByTestId(`source-more-${sourceId}`).click();
  await page.getByTestId('source-open-editor-editor').click();
  await expect(page).toHaveURL(/\/dock\/app\/micro_app-[0-9a-f-]+/);
  const frame = editorFrame(page);
  await expect(frame.getByTestId('spec-editor-field-feed_urls')).toHaveValue(feedUrl);
  await expect(frame.getByTestId('spec-editor-items').locator('li').nth(1)).toBeVisible();
  // The editor is a CHILD of the definition, so the address bar says so. This is
  // the whole reason it is addressed by its own row rather than through its parent.
  await expect(page.getByTestId('top-nav-address')).toContainText('rss');
  await expect(page.getByTestId('top-nav-address')).toContainText('editor');
});

test('5. define + annotate: a dataset bound to the source, one labelled example', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await page.goto(`/dock/app/${editorTypeId}?source=${sourceId}&project=${fixture.projectId}`);
  const frame = editorFrame(page);
  await expect(frame.getByTestId('spec-editor-dataset-create')).toBeVisible();
  await frame.getByTestId('spec-editor-dataset-name').fill(`labels ${stamp}`);
  await frame.getByTestId('spec-editor-shape-field-0').fill('sentiment');
  await frame.getByTestId('spec-editor-dataset-create').click();
  await expect(frame.getByTestId('spec-editor-dataset-counts')).toHaveText(/0 examples · 0 labelled/);

  const firstPromote = frame.locator('[data-testid^="spec-editor-promote-"]').first();
  await firstPromote.click();
  await frame.getByTestId('spec-editor-label-sentiment').fill('positive');
  await frame.getByTestId('spec-editor-annotate-save').click();
  await expect(frame.getByTestId('spec-editor-annotated')).toHaveText(/labelled \(1 total\)/);
  await expect(frame.getByTestId('spec-editor-dataset-counts')).toHaveText(/1 examples · 1 labelled/);

  const api = await apiContext();
  const rows = ((await (await api.get(`/api/v1/graph/dataset?filter=${encodeURIComponent(JSON.stringify({ source_id: sourceId }))}`)).json()).data ?? []) as {
    id: string; num_examples: number; num_annotated: number; asset_ref: string; spec: unknown;
  }[];
  await api.dispose();
  expect(rows).toHaveLength(1);
  datasetId = rows[0].id;
  datasetFolder = rows[0].asset_ref;
  expect(rows[0].num_examples).toBe(1);
  expect(rows[0].num_annotated).toBe(1);
  expect(rows[0].spec).toEqual({ examples: [{ input: 'ingest.source_item', output: { sentiment: 'string' } }] });
  for (const rel of ['input/item.json', 'ground_truth/label.json', 'example.json']) {
    expect(existsSync(path.join(datasetFolder, 'examples', '0001', rel)), rel).toBeTruthy();
  }
});

test('6. the agent surface: the persona rides the session and the pane shows the editor', async ({ page }) => {
  const api = await apiContext();
  const subagents = ((await (await api.get('/api/v1/graph/subagent?include_system=true')).json()).data ?? []) as {
    id: string; name: string; kind?: string; scope?: string; asset_ref?: string;
  }[];
  const persona = subagents.find((s) => s.name === 'data-integrations' && s.scope === 'system');
  expect(persona?.kind, 'the data-integrations persona is a system kind:vibe subagent').toBe('vibe');
  const vibe = subagents.find((s) => s.name === 'vibe' && s.scope === 'system');
  for (const ref of [vibe?.asset_ref, persona?.asset_ref]) {
    if (ref) await api.post(`/api/v1/graph/agentic_process/${fixture.processId}/load-embedded-subagent`, { data: { asset_ref: ref } });
  }
  const proc = (await (await api.get(`/api/v1/graph/agentic_process/${fixture.processId}`)).json()).data as {
    embedded_asset_refs?: string[];
  };
  expect(proc.embedded_asset_refs ?? []).toContain(`subagent-${persona?.id}`);

  // `flow show view <editor address>` must RESOLVE to the source's editor dock
  // — the address the persona presents with. Where the workspace then paints it
  // is the display router's business (and is proven by tests 4-5, which open
  // that same address directly).
  const shown = await api.post(`/api/v1/graph/agentic_process/${fixture.processId}/show`, {
    data: { view: `app/${editorTypeId}?source=${sourceId}` },
  });
  expect(shown.ok(), await shown.text()).toBeTruthy();
  const target = (await shown.json()).data as { kind?: string; view_type?: string; pointer?: string; options?: Record<string, string> };
  expect(target.kind).toBe('dock');
  expect(target.view_type).toBe('app');
  expect(target.pointer).toBe(editorTypeId);
  expect(target.options?.source).toBe(sourceId);
  await api.dispose();

  await openVibe(page, fixture.processId);
  await expect(page.locator('[data-testid="flow-page"] [data-testid="entity-execution-input"]')).toBeVisible();
});
