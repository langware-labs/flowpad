/**
 * Wiki link layer end-to-end regression coverage.
 * Source: wiki_link_layer.md
 *
 * Exercises the real HTTP action, parser, resolver/lifecycle store, and the
 * Milkdown search/insert UI. All backend URLs resolve through the shared test
 * config, never a baked port.
 */
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

import { apiBase } from '../_shared/api';

const API = apiBase();
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface MarkdownEntity {
  id: string;
  name: string;
  asset_ref: string;
}

interface WikiEdge {
  src_type: string;
  src_id: string;
  raw: string;
  target_type: string | null;
  target_id: string | null;
  line: number;
}

async function data<T = unknown>(response: APIResponse): Promise<T> {
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('SUCCESS');
  return body.data as T;
}

async function createMarkdown(
  request: APIRequestContext,
  name: string,
  projectId?: string,
): Promise<MarkdownEntity> {
  const route = projectId
    ? `${API}/api/v1/graph/project/${projectId}/markdown`
    : `${API}/api/v1/graph/markdown`;
  return data(await request.post(route, { data: { name } }));
}

test.describe('Wiki link layer', () => {
  test('backend actions and parser handle ghost, wiki URL, and invalid sub-path contracts', async ({
    request,
  }) => {
    expect(await data(await request.get(
      `${API}/api/v1/graph/skill/${UNKNOWN_ID}/wiki/links`,
    ))).toEqual([]);
    expect(await data(await request.get(
      `${API}/api/v1/graph/skill/${UNKNOWN_ID}/wiki/backlinks`,
    ))).toEqual([]);

    const edges = await data<WikiEdge[]>(
      await request.post(`${API}/api/v1/graph/skill/${UNKNOWN_ID}/wiki/reindex`, {
        data: {
          body:
            'hello [[world]]\nSee [my-process](/dock/assets/wiki/my-process).\n' +
            'See [my proc](/dock/assets/wiki/my%20proc).',
        },
      }),
    );
    expect(edges.map((edge) => edge.raw)).toEqual([
      'world',
      'my-process',
      'my proc',
    ]);
    expect(edges[0]).toMatchObject({
      src_type: 'skill',
      src_id: UNKNOWN_ID,
      raw: 'world',
      target_type: null,
      target_id: null,
      line: 1,
    });
    expect(await data(await request.get(
      `${API}/api/v1/graph/skill/${UNKNOWN_ID}/wiki/links`,
    ))).toEqual(edges);

    const invalid = await request.get(
      `${API}/api/v1/graph/skill/${UNKNOWN_ID}/wiki/garbage`,
    );
    expect(invalid.status()).toBe(404);
    expect((await invalid.json()).status).toBe('FAIL');
  });

  test('three backlinks converge through source edit/delete and target delete without rewriting source text', async ({
    request,
  }) => {
    const stamp = Date.now();
    const target = await createMarkdown(request, `bl-target-${stamp}`);
    const sources = await Promise.all(
      [0, 1, 2].map((index) => createMarkdown(request, `bl-src-${index}-${stamp}`)),
    );
    const literal = `See [[${target.name}]] from source two.`;
    writeFileSync(sources[2].asset_ref, `${literal}\n`, 'utf8');

    try {
      for (const [index, source] of sources.entries()) {
        await data(
          await request.post(
            `${API}/api/v1/graph/markdown/${source.id}/wiki/reindex`,
            { data: { body: `See [[${target.name}]] from ${index}.` } },
          ),
        );
      }
      const backlinks = await data<WikiEdge[]>(
        await request.get(`${API}/api/v1/graph/markdown/${target.id}/wiki/backlinks`),
      );
      expect(backlinks).toHaveLength(3);
      expect(new Set(backlinks.map((edge) => edge.src_id))).toEqual(
        new Set(sources.map((source) => source.id)),
      );

      expect((await request.delete(
        `${API}/api/v1/graph/markdown/${sources[0].id}`,
      )).status()).toBe(200);
      expect(await data(
        await request.get(`${API}/api/v1/graph/markdown/${target.id}/wiki/backlinks`),
      )).toHaveLength(2);

      expect(await data(
        await request.post(
          `${API}/api/v1/graph/markdown/${sources[1].id}/wiki/reindex`,
          { data: { body: 'No more wiki link here.' } },
        ),
      )).toEqual([]);
      const lastBacklink = await data(
        await request.get(`${API}/api/v1/graph/markdown/${target.id}/wiki/backlinks`),
      );
      expect(lastBacklink).toHaveLength(1);
      expect(lastBacklink[0].src_id).toBe(sources[2].id);

      expect((await request.delete(
        `${API}/api/v1/graph/markdown/${target.id}`,
      )).status()).toBe(200);
      expect(await data(
        await request.get(`${API}/api/v1/graph/markdown/${sources[2].id}/wiki/links`),
      )).toEqual([]);
      expect(readFileSync(sources[2].asset_ref, 'utf8')).toContain(literal);
    } finally {
      for (const source of sources) {
        await request
          .delete(`${API}/api/v1/graph/markdown/${source.id}`)
          .catch(() => undefined);
      }
      await request
        .delete(`${API}/api/v1/graph/markdown/${target.id}`)
        .catch(() => undefined);
    }
  });

  test('editor-only toolbar searches, filters, and inserts a real named wiki anchor', async ({
    page,
    request,
  }) => {
    const bootstrap = await data(
      await request.get(`${API}/api/v1/graph/bootstrap?domain=localhost`),
    );
    const projectId =
      bootstrap.default_project?.id ??
      bootstrap.local_project?.id ??
      bootstrap.project?.id;
    expect(projectId).toBeTruthy();
    const stamp = Date.now();
    const target = await createMarkdown(request, `wiki-target-${stamp}`, projectId);
    const source = await createMarkdown(request, `wiki-source-${stamp}`, projectId);

    try {
      await page.addInitScript(() => {
        localStorage.setItem('llm-setup-modal-seen', 'true');
        localStorage.setItem('viewMode', 'advanced');
      });
      await page.goto(`/dock/assets/editor/markdown/typeid/markdown-${source.id}`);
      await expect(page.getByTestId('editor-mode-chip-view')).toBeVisible();
      await page.evaluate(() => window.setView('advanced'));
      await page.getByTestId('editor-mode-chip-editor').click();

      const wikiButton = page.getByTestId('wiki-toolbar-add-link');
      await expect(wikiButton).toBeVisible();
      await expect(wikiButton).toBeEnabled();
      const classes = (await wikiButton.getAttribute('class')) ?? '';
      for (const expectedClass of [
        'flex',
        'h-7',
        'w-7',
        'items-center',
        'justify-center',
        'rounded',
        'hover:bg-muted',
      ]) {
        expect(classes.split(/\s+/)).toContain(expectedClass);
      }

      await wikiButton.click();
      const input = page.getByTestId('wiki-link-search-input');
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await expect(page.getByTestId('wiki-link-type-filter')).toContainText('All types');
      await input.fill(target.name);
      const results = page.getByTestId('wiki-link-search-result');
      await expect(results).not.toHaveCount(0);
      const targetResult = results.filter({ hasText: target.name }).first();
      await expect(targetResult).toContainText('markdown');
      await targetResult.click();

      await expect(input).toHaveCount(0);
      const anchor = page.locator(
        `.ProseMirror a[href="/dock/assets/wiki/${encodeURIComponent(target.name)}"]`,
      );
      await expect(anchor).toHaveText(target.name);
      await expect(page.locator('.ProseMirror')).not.toContainText('[[');

      for (const mode of ['view', 'review', 'markdown']) {
        await page.getByTestId(`editor-mode-chip-${mode}`).click();
        await expect(page.getByTestId('wiki-toolbar-add-link')).toHaveCount(0);
      }
    } finally {
      await request
        .delete(`${API}/api/v1/graph/markdown/${source.id}`)
        .catch(() => undefined);
      await request
        .delete(`${API}/api/v1/graph/markdown/${target.id}`)
        .catch(() => undefined);
    }
  });
});
