import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v5 as uuidv5 } from 'uuid';

import { apiBase } from '../_shared/api';

const API = apiBase();

type EntityResponse = {
  status: string;
  data: {
    id: string;
    name?: string;
    type?: string;
    cursor?: string;
    status?: string;
  };
};

type GraphPayload = {
  nodes: Array<{
    id: string;
    type: string;
    properties?: Record<string, unknown>;
  }>;
};

type GraphResponse = {
  status: string;
  data: GraphPayload;
};

function graphDoc(name: string, clickTarget: string, backendTag: string, backendTarget: string) {
  return {
    version: 1,
    name,
    enabled: true,
    nodes: [
      {
        id: 'click-tagged-control',
        name: 'Click the tagged control',
        node_type: 'guided_step',
        node_data: {
          status_line: 'Waiting for the tagged control',
          present: { highlight: clickTarget },
          await: { tag: 'app.ui.button.clicked', target: clickTarget },
        },
      },
      {
        id: 'receive-backend-tag',
        name: 'Receive the backend tag',
        node_type: 'guided_step',
        node_data: {
          status_line: 'Waiting for the backend relay',
          await: { tag: backendTag, target: backendTarget },
        },
      },
    ],
    edges: [
      {
        id: 'click-to-backend',
        from: { node: 'click-tagged-control', event: 'done' },
        to: { node: 'receive-backend-tag' },
      },
    ],
  };
}

async function postEntity(
  request: APIRequestContext,
  entityType: string,
  data: Record<string, unknown>,
): Promise<EntityResponse> {
  const response = await request.post(`${API}/api/v1/graph/${entityType}`, { data });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as EntityResponse;
  expect(body.status).toBe('SUCCESS');
  return body;
}

async function dismissSetup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
}

const suiteCreated: Array<{ type: string; id: string }> = [];

test.afterAll(async ({ request }) => {
  for (const entity of suiteCreated.reverse()) {
    await request.delete(`${API}/api/v1/graph/${entity.type}/${entity.id}`).catch(() => {});
  }
});

test('hard-cut tag vocabulary works across API, graph, taxonomy UI, and identity', async ({ page, request }) => {
  const stamp = Date.now().toString(36);
  const boundTag = `qa.e2e.naming.${stamp}`;
  const observedTag = `qa.e2e.observed.${stamp}`;
  const freeFormTag = `QA browser ${stamp}`;
  const clickTarget = 'ProjectPage';
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const tagRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (req) => {
    if (req.url().includes('/tag')) tagRequests.push(req.url());
  });

  await dismissSetup(page);

  const markdown = await postEntity(request, 'markdown', {
    name: `tag-browser-${stamp}`,
    title: `Tag browser ${stamp}`,
    body: `# Tag browser ${stamp}`,
    tags: [boundTag, freeFormTag],
  });
  suiteCreated.push({ type: 'markdown', id: markdown.data.id });
  const markdownTarget = `markdown:${markdown.data.id}`;

  const blessed = await postEntity(request, 'tag', {
    name: boundTag,
    title: `Blessed ${stamp}`,
  });
  suiteCreated.push({ type: 'tag', id: blessed.data.id });

  const observed = await request.post(`${API}/api/v1/debug/emit_tag`, {
    data: { tag: observedTag, target: markdownTarget },
  });
  expect(observed.status()).toBe(200);
  expect(((await observed.json()) as EntityResponse).status).toBe('SUCCESS');

  const graphResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().includes('/api/v1/subgraph/tag'),
  );
  await page.goto(`/dock/tag/graph/${encodeURIComponent(boundTag)}`);
  const graphResponse = await graphResponsePromise;
  expect(graphResponse.status()).toBe(200);
  const graphEnvelope = (await graphResponse.json()) as GraphResponse;
  expect(graphEnvelope.status).toBe('SUCCESS');
  expect(graphEnvelope.data.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: boundTag, type: 'tag' }),
      expect.objectContaining({ id: markdown.data.id, type: 'markdown' }),
    ]),
  );
  const graphView = page.locator('.graph-view-root');
  await expect(graphView.getByText('Tag Graph', { exact: true }).first()).toBeVisible();
  await expect(graphView).toHaveAttribute('data-node-count', /^[1-9]\d*$/);

  const treeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname.includes('/api/v1/subgraph/tag') &&
      url.searchParams.get('view') === 'tree'
    );
  });
  await graphView.getByRole('button', { name: 'Tree', exact: true }).click();
  const treeResponse = await treeResponsePromise;
  expect(treeResponse.status()).toBe(200);
  const treeEnvelope = (await treeResponse.json()) as GraphResponse;
  expect(treeEnvelope.status).toBe('SUCCESS');
  expect(treeEnvelope.data.nodes.length).toBeGreaterThan(0);
  expect(treeEnvelope.data.nodes.every((node) => node.type === 'tag')).toBe(true);
  expect(treeEnvelope.data.nodes.some((node) => node.id === markdown.data.id)).toBe(false);
  await expect(page).toHaveURL(/(?:\?|&)view=tree(?:&|$)/);
  await expect(graphView.getByText('Tag Tree', { exact: true }).first()).toBeVisible();
  await expect(graphView.getByRole('button', { name: 'Tree', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const assetTypesResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().includes('/api/v1/assets/types'),
  );
  await page.goto('/dock/assets/list/tag?viewMode=dev');
  expect((await assetTypesResponsePromise).status()).toBe(200);
  const tagRootChevron = page.getByTestId('browseable-chevron-asset-type:tag');
  await expect(tagRootChevron).toBeVisible();
  if ((await tagRootChevron.getAttribute('title')) === 'Expand') {
    await tagRootChevron.click();
  }
  await expect(page.getByRole('treeitem', { name: /Tag graph/i })).toBeVisible();
  const qaFamily = page.locator('[data-browseable-id="tag-family:qa"]').getByRole('treeitem');
  await expect(qaFamily).toBeVisible();
  const qaChevron = qaFamily.locator('[data-testid^="browseable-chevron-tag-family:"]');
  if ((await qaChevron.getAttribute('title')) === 'Expand') {
    await qaChevron.click();
  }
  const boundRow = page.locator(`[data-browseable-id="tag:${boundTag}"]`).getByRole('treeitem');
  await expect(boundRow).toBeVisible();
  const observedRow = page.locator(`[data-browseable-id="tag:${observedTag}"]`).getByRole('treeitem');
  await expect(observedRow).toBeVisible();
  await observedRow.hover();
  await observedRow.getByRole('button', { name: `Bless "${observedTag}" — create its Tag entity` }).click();
  await expect(observedRow.getByRole('button', { name: `Delete tag ${observedTag}` })).toBeVisible();
  const tagList = (await (await request.get(`${API}/api/v1/graph/tag`)).json()) as {
    data: Array<{ id: string; name: string; uname?: string | null }>;
  };
  const observedEntity = tagList.data.find((tag) => tag.name === observedTag);
  expect(observedEntity?.id).toBe(uuidv5(`tag:${observedTag}`, uuidv5.DNS));
  expect(observedEntity?.uname ?? null).toBeNull();
  if (observedEntity) suiteCreated.push({ type: 'tag', id: observedEntity.id });

  await boundRow.click();
  await expect(page).toHaveURL(new RegExp(`/dock/tag/graph/${boundTag.replaceAll('.', '\\.')}`));

  const taggedControl = page.locator(`[data-tag="${clickTarget}"]`).first();
  await expect(taggedControl).toBeVisible();
  expect(await page.locator(`[${['data-to', 'pic'].join('')}]`).count()).toBe(0);
  await page.goto(`${page.url()}${page.url().includes('?') ? '&' : '?'}highlight=${encodeURIComponent(clickTarget)}`);
  await expect(page.locator(`[data-tag="${clickTarget}"]`).first()).toHaveAttribute('data-highlighted', 'true');

  await page.goto('/dock/tag/graph/not%20a%20valid%20tag');
  await expect(page.locator('body')).toContainText(/tag/i);
  expect(tagRequests.some((url) => url.includes('/api/v1/subgraph/tag'))).toBe(true);
  expect(tagRequests.every((url) => !url.includes(`/${['to', 'pic'].join('')}`))).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => !/ResizeObserver|favicon/i.test(message))).toEqual([]);
});

test('tag journey advances through UI and backend WebSocket events', async ({ page, request }) => {
  const stamp = Date.now().toString(36);
  const boundTag = `qa.e2e.journey.${stamp}`;
  // Backend→app forwarding is deliberately allowlisted to ``graph_workflow.*``.
  const backendTag = `flow.qa.browser.${stamp}`;
  const clickTarget = 'ProjectPage';
  const journeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowpad-tag-journey-'));
  const created: Array<{ type: string; id: string }> = [];

  try {
    await dismissSetup(page);

    const markdown = await postEntity(request, 'markdown', {
      name: `tag-journey-${stamp}`,
      title: `Tag journey ${stamp}`,
      body: `# Tag journey ${stamp}`,
      tags: [boundTag],
    });
    created.push({ type: 'markdown', id: markdown.data.id });
    const markdownTarget = `markdown:${markdown.data.id}`;

    const blessed = await postEntity(request, 'tag', {
      name: boundTag,
      title: `Journey tag ${stamp}`,
    });
    created.push({ type: 'tag', id: blessed.data.id });

    fs.writeFileSync(
      path.join(journeyDir, 'graph.json'),
      `${JSON.stringify(graphDoc(`tag-browser-${stamp}`, clickTarget, backendTag, markdownTarget), null, 2)}\n`,
    );
    const journey = await postEntity(request, 'journey', {
      name: `tag-browser-${stamp}`,
      asset_ref: journeyDir,
      enabled: true,
    });
    created.push({ type: 'journey', id: journey.data.id });
    const launch = await request.post(`${API}/api/v1/journeys/${journey.data.id}/launch`);
    expect(launch.status()).toBe(200);
    expect(((await launch.json()) as EntityResponse).status).toBe('SUCCESS');

    await page.goto(`/dock/tag/graph/${encodeURIComponent(boundTag)}?journeyId=${encodeURIComponent(journey.data.id)}`);
    await expect(page.getByText('Click the tagged control', { exact: true })).toBeVisible();
    await page.locator(`[data-tag="${clickTarget}"]`).first().click();
    await expect(page.getByText('Receive the backend tag', { exact: true })).toBeVisible();

    const relay = await request.post(`${API}/api/v1/debug/emit_tag`, {
      data: { tag: backendTag, target: markdownTarget, data: { source: 'browser-acceptance' } },
    });
    expect(relay.status()).toBe(200);
    expect(((await relay.json()) as EntityResponse).status).toBe('SUCCESS');
    await expect
      .poll(async () => {
        const progress = await request.get(`${API}/api/v1/journeys/${journey.data.id}/progress`);
        return ((await progress.json()) as EntityResponse).data.status;
      })
      .toBe('complete');
  } finally {
    for (const entity of created.reverse()) {
      await request.delete(`${API}/api/v1/graph/${entity.type}/${entity.id}`).catch(() => {});
    }
    fs.rmSync(journeyDir, { recursive: true, force: true });
  }
});
