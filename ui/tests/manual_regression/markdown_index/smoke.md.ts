import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

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

const REBUILD_CAP_MS = 120_000;
// The folders S2 seeds; each gets an index.md from the rebuild ('' is the root).
const INDEX_FOLDERS = ['', 'auth', 'auth/oauth', 'billing'];

/** `<flow home>/instances/<name>/records_data`, beside the instance's preferences.json. */
async function recordsDataRoot(request: APIRequestContext): Promise<string> {
  const boot = await (await request.get(`${API}/api/v1/graph/bootstrap`)).json();
  const prefs: string = boot.data.desktop_info.paths.preferences;
  return path.join(path.dirname(prefs.startsWith('/') ? prefs : `/${prefs}`), 'records_data');
}

function readIndexFrontmatter(folder: string): Record<string, string> {
  const text = fs.readFileSync(path.join(TMP_DOCS, folder, 'index.md'), 'utf8');
  const block = /^---\n([\s\S]*?)\n---/.exec(text);
  expect(block, `${folder || '<root>'}/index.md has YAML frontmatter`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of block![1].split('\n')) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const typeid = (ref: string | undefined) => (ref && !ref.startsWith('markdown_index-') ? `markdown_index-${ref}` : ref ?? '');

function walk(root: string, acc = { files: [] as string[], dirs: [] as string[] }) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      acc.dirs.push(p);
      walk(p, acc);
    } else acc.files.push(p);
  }
  return acc;
}

async function clickRun(page: Page, id: string) {
  const run = page.locator(`[data-testid="llm-indexer-run-${id}"]`);
  await expect(run, 'the smoke row has a Run button').toBeVisible({ timeout: 15_000 });
  await run.click();
  await expect(page.getByText('Rebuild started').first(), 'toast confirms the rebuild started').toBeVisible({ timeout: 10_000 });
}

/** The newest rebuild AgenticProcess for ``indexId`` not in ``seen``, polled until its turn ends (cap 120 s). */
async function waitForRebuild(request: APIRequestContext, indexId: string, seen: Set<string>) {
  const deadline = Date.now() + REBUILD_CAP_MS;
  let ap: Record<string, any> | undefined;
  let sawBusy = false;
  while (Date.now() < deadline) {
    if (!ap) {
      const filter = JSON.stringify({ match: {}, limit: 20, order_by: [{ created_date: 'desc' }] });
      const list = await (await request.get(`${API}/api/v1/graph/agentic_process`, { params: { filter } })).json();
      ap = (list.data ?? []).find((p: any) => p.context_data?.markdown_index_id === indexId && !seen.has(p.id));
      if (ap) seen.add(ap.id);
    } else {
      ap = (await (await request.get(`${API}/api/v1/graph/agentic_process/${ap.id}`)).json()).data;
      if (ap!.status === 'failed') throw new Error(`rebuild process ${ap!.id} failed`);
      if (ap!.status === 'stopped') return ap!;
      if (ap!.busy) sawBusy = true;
      else if (sawBusy) return ap!; // a headless turn that ended: the process idles, it does not stop
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`rebuild did not finish within ${REBUILD_CAP_MS / 1000} s; last: ${JSON.stringify({ id: ap?.id, status: ap?.status, busy: ap?.busy })}`);
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
    expect(t.browseable_by, 'browseable_by null (system entity)').toBeNull();
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
  // so they are skipped (live-claude dependency). S8's 13-file invariant depends
  // on S5 having generated the 4 index.md files, so it shares the same gate.
  test('S5/S6/S8/S11: cold + incremental LLM rebuild', async ({ page, request }) => {
    test.skip(!HAS_LLM, 'live-claude: rebuild AgenticProcess needs ANTHROPIC_API_KEY to generate index.md (multi-minute real Claude run)');
    // smoke.md caps each rebuild at 120 s (S5, S11); the test's budget is those two caps plus the panel loads.
    test.setTimeout(2 * REBUILD_CAP_MS + 120_000);

    seedDocs();
    await dismissModals(page);
    const res = await request.post(`${API}/api/v1/graph/markdown_index`, {
      data: { vault_root: TMP_DOCS, asset_ref: `${TMP_DOCS}/index.md`, name: 'smoke' },
    });
    expect(res.status()).toBe(200);
    const id: string = (await res.json()).data.id;
    const summariesDir = path.join(await recordsDataRoot(request), 'markdown_index', id, 'file_summaries');

    try {
      // S5: cold build — click Run, wait for the rebuild process to finish.
      await openLlmIndexersPanel(page);
      const userChip = page.getByRole('button', { name: /^User$/ }).first();
      if (await userChip.isVisible({ timeout: 5_000 }).catch(() => false)) await userChip.click();
      await page.getByRole('button', { name: 'Refresh' }).click();
      const runStart = Date.now();
      const seen = new Set<string>();
      await clickRun(page, id);
      await waitForRebuild(request, id, seen);

      // S6: every folder got an index.md with correct frontmatter.
      const fm = Object.fromEntries(INDEX_FOLDERS.map((f) => [f, readIndexFrontmatter(f)]));
      for (const folder of INDEX_FOLDERS) {
        const m = fm[folder];
        expect(m.type, `${folder || '<root>'}: type`).toBe('markdown_index');
        expect(m.inputs_hash, `${folder || '<root>'}: inputs_hash`).toMatch(/^(sha256:)?[0-9a-f]{64}$/);
        const at = Date.parse(m.generated_at);
        expect(Number.isNaN(at), `${folder || '<root>'}: generated_at is ISO (${m.generated_at})`).toBe(false);
        expect(at, `${folder || '<root>'}: generated_at not before the run`).toBeGreaterThanOrEqual(runStart - 5_000);
        expect(Date.now() - at, `${folder || '<root>'}: generated_at within the last 130 s`).toBeLessThanOrEqual(130_000);
        const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : folder ? '' : null;
        if (parent === null) expect(m.parent_ref ?? '', 'root parent_ref is empty').toBe('');
        else expect(typeid(m.parent_ref), `${folder}: parent_ref -> parent's index`).toBe(typeid(fm[parent].id));
        const dir = path.join(TMP_DOCS, folder);
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // A folder note (`auth/auth.md`, Obsidian convention) represents the folder, so it is not one of its files.
        const note = `${path.basename(dir)}.md`;
        const sources = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md' && e.name !== note);
        const subfolders = entries.filter((e) => e.isDirectory());
        expect(Number(m.file_count), `${folder || '<root>'}: file_count`).toBe(sources.length);
        expect(Number(m.subfolder_count), `${folder || '<root>'}: subfolder_count`).toBe(subfolders.length);
      }

      // S8: user docs stay clean — the only sidecar is one index.md.json beside each generated index.md
      // (the panel and parent folders read it); no other *.json, no cache dirs; the summary cache lives in the record folder.
      // Soft: an S8 violation still fails the test, but S11 is checked too.
      const all = walk(TMP_DOCS);
      const indexMds = all.files.filter((f) => path.basename(f) === 'index.md');
      expect.soft(all.files.filter((f) => f.endsWith('.json')).sort(), 'only index.md.json beside each index.md')
        .toEqual(indexMds.map((f) => `${f}.json`).sort());
      for (const bad of ['.markdown_index', '.cache', '.flowpad']) {
        expect.soft(all.dirs.filter((d) => path.basename(d) === bad), `no ${bad} dir in user docs`).toEqual([]);
      }
      expect.soft(fs.existsSync(summariesDir) ? fs.readdirSync(summariesDir).length : 0, `summaries in ${summariesDir}`).toBeGreaterThanOrEqual(1);
      expect.soft(all.files.length, `5 user .md + 4 index.md + 4 index.md.json: ${all.files.join(', ')}`).toBe(13);

      // S11: incremental rebuild — only the edited leaf's chain regenerates.
      const before = Object.fromEntries(INDEX_FOLDERS.map((f) => [f, fm[f].generated_at]));
      const summariesBefore = fs.readdirSync(summariesDir).length;
      await page.waitForTimeout(2_000);
      fs.appendFileSync(`${TMP_DOCS}/auth/oauth/pkce.md`, '\nAdditional context for incrementality test.\n');
      await clickRun(page, id);
      await waitForRebuild(request, id, seen);
      const after = Object.fromEntries(INDEX_FOLDERS.map((f) => [f, readIndexFrontmatter(f).generated_at]));
      for (const f of ['auth/oauth', 'auth', '']) {
        expect(Date.parse(after[f]), `${f || '<root>'} regenerated`).toBeGreaterThan(Date.parse(before[f]));
      }
      expect(after.billing, 'billing untouched').toBe(before.billing);
      expect(fs.readdirSync(summariesDir).length - summariesBefore, 'at most 1 new file summary').toBeLessThanOrEqual(1);
    } finally {
      await request.delete(`${API}/api/v1/graph/markdown_index/${id}`).catch(() => {});
      fs.rmSync(TMP_DOCS, { recursive: true, force: true });
    }
  });
});
