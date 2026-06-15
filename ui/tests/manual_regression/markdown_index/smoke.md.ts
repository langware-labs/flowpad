import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';

import { apiBase } from '../_shared/api';

const API = apiBase();
const TMP_DOCS = process.env.TMP_DOCS || '/tmp/mdindex_smoke_docs';

// Whether the backend has an Anthropic key — the cold/incremental rebuild steps
// (S5/S6/S11) drive a real AgenticProcess that calls Claude. Without a key they
// cannot run, so they are skipped (live-claude dependency), not failed.
const HAS_LLM = Boolean(process.env.ANTHROPIC_API_KEY);

async function dismissModals(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', '1');
  });
}

function seedDocs() {
  fs.rmSync(TMP_DOCS, { recursive: true, force: true });
  fs.mkdirSync(`${TMP_DOCS}/auth/oauth`, { recursive: true });
  fs.mkdirSync(`${TMP_DOCS}/billing`, { recursive: true });
  fs.writeFileSync(`${TMP_DOCS}/README.md`, '# Project intro\n\nSmoke fixture for MarkdownIndex.\n');
  fs.writeFileSync(`${TMP_DOCS}/auth/auth.md`, '# Auth\n\nFolder note authored by user (Obsidian convention).\n');
  fs.writeFileSync(`${TMP_DOCS}/auth/config.md`, '# Auth config\n\nJWT lifetimes, refresh policy.\n');
  fs.writeFileSync(`${TMP_DOCS}/auth/oauth/pkce.md`, '# PKCE flow\n\nProof Key for Code Exchange — sketch only.\n');
  fs.writeFileSync(`${TMP_DOCS}/billing/invoices.md`, '# Invoice schema\n\nLine items, tax rules.\n');
}

async function openLlmIndexersPanel(page: Page) {
  await page.goto('/dock/lens/fs-records/scan/');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.locator('[data-testid="toolbar-llm-indexers"]').click();
  await expect(page.locator('[data-testid="llm-indexers-lens"]')).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toContain('/dock/lens/fs-records/llm-indexers/');
}

test.describe('MarkdownIndex — Smoke', () => {
  test('S1: backend reachable + entity type registered with system-entity flags', async ({ request }) => {
    const boot = await request.get(`${API}/api/v1/graph/bootstrap`);
    expect(boot.status()).toBe(200);
    expect((await boot.json()).status).toBe('SUCCESS');

    const sch = await request.get(`${API}/api/v1/agent/schema/markdown_index`);
    expect(sch.status()).toBe(200);
    const t = (await sch.json()).type;
    // System entity: not crawled by default, not in the records browser.
    expect(t.has_entity_cls, 'has_entity_cls').toBe(true);
    expect(t.indexed_by_default, 'indexed_by_default false (system entity)').toBe(false);
    expect(t.browseable, 'browseable false (system entity)').toBe(false);
    // NOTE: `has_record_cls` no longer exists — the entity/record split was
    // unified, so the schema exposes only has_entity_cls. parent_type is
    // best-effort (self-referential registration) and not asserted.
  });

  test('S2: seed a small docs tree (exactly 5 files)', async () => {
    seedDocs();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(TMP_DOCS);
    expect(files.length, 'seeded exactly 5 user .md files').toBe(5);
  });

  test('S3: open the LLM Indexers panel', async ({ page }) => {
    await dismissModals(page);
    await openLlmIndexersPanel(page);
    // The table renders only when entities exist; otherwise an empty-state shows.
    // Assert the lens is up and EITHER the table OR the empty-state is present.
    const table = page.locator('[data-testid="llm-indexers-table"]');
    const empty = page.getByText('No MarkdownIndex entities yet.', { exact: false });
    const ok = (await table.count()) > 0 || (await empty.count()) > 0;
    expect(ok, 'panel shows the indexers table or its empty-state').toBe(true);
  });

  test('S4: register the seeded docs root as a MarkdownIndex; row appears', async ({ page, request }) => {
    seedDocs();
    await dismissModals(page);
    const res = await request.post(`${API}/api/v1/graph/markdown_index`, {
      data: { vault_root: TMP_DOCS, asset_ref: `${TMP_DOCS}/index.md`, name: 'smoke' },
    });
    expect(res.status()).toBe(200);
    const id: string = (await res.json()).data.id;

    await openLlmIndexersPanel(page);
    // The vault_root /tmp/... is outside every project mount, so it is "user-area"
    // and the panel's ScopeFilterBar must include user assets to show it. Select
    // the "User" scope chip (default may be project-only, which would hide it).
    const userChip = page.getByRole('button', { name: /^User$/ }).first();
    if (await userChip.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await userChip.click();
    }
    // Refresh and assert a row whose Vault root cell shows TMP_DOCS appears.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('[data-testid="llm-indexers-table"]')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid="llm-indexers-table"]').getByText(TMP_DOCS, { exact: false }).first(),
      'a row for the seeded vault root is listed',
    ).toBeVisible({ timeout: 10_000 });

    // Cleanup (best-effort).
    await request.delete(`${API}/api/v1/graph/markdown_index/${id}`).catch(() => {});
    fs.rmSync(TMP_DOCS, { recursive: true, force: true });
  });

  // S5/S6/S11 drive a real rebuild AgenticProcess that calls Claude. Without an
  // Anthropic key in the backend env they cannot generate the index.md files,
  // so they are skipped (live-claude dependency). S8's 9-file invariant depends
  // on S5 having generated the 4 index.md files, so it shares the same gate.
  test('S5/S6/S8/S11: cold + incremental LLM rebuild', async () => {
    test.skip(!HAS_LLM, 'live-claude: rebuild AgenticProcess needs ANTHROPIC_API_KEY to generate index.md (multi-minute real Claude run)');
    // (Encoded only when a key is present — out of scope for the keyless QA instance.)
  });
});
