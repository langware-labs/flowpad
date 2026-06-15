import { expect, test, type Page } from '@playwright/test';
import * as fs from 'fs';
import { apiBase } from '../_shared/api';

// Knowledge Atlas — index status, real-fs change detection, line diffs.
// Structural-only flow (native scan/stamp, no LLM) — never gated on API keys.

const API = apiBase();
// Unique per run: stamped baselines live in the instance data dir keyed by the
// vault PATH, so reusing a fixed path would leak the previous run's baseline
// into T1's "everything unindexed" assertion.
const TMP_DOCS = process.env.TMP_DOCS || `/tmp/qa_atlas_docs_${process.pid}_${Date.now()}`;
// Canonical pointer form: the leading "/" of the absolute path is stripped by
// DockPointer.forKnowledgeBrowser (react-router collapses "//") and re-added by
// the parser — so the URL has a SINGLE slash after `vfs`. This is exactly the
// form the vault-root button produces.
const ATLAS_URL = `/dock/k-browser/vfs${TMP_DOCS}`;

const badge = '[data-testid="kb-status-badge"]';
const stampBtn = '[data-testid="kb-stamp"]';
const changedChip = '[data-testid="kb-changed-chip"]';
const changesTab = '[data-testid="kb-changes-tab"]';
const diffPanel = '[data-testid="kb-diff-panel"]';

function seedVault() {
  fs.rmSync(TMP_DOCS, { recursive: true, force: true });
  fs.mkdirSync(`${TMP_DOCS}/sub`, { recursive: true });
  fs.writeFileSync(`${TMP_DOCS}/alpha.md`, '# Alpha\n\nIntro doc, see [[gamma]].\n');
  fs.writeFileSync(`${TMP_DOCS}/beta.md`, '# Beta\n\nWill be removed.\n');
  fs.writeFileSync(`${TMP_DOCS}/sub/gamma.md`, '# Gamma\n\nWill be renamed.\n');
  fs.writeFileSync(`${TMP_DOCS}/sub/delta.md`, '# Delta\n\nStays untouched.\n');
}

async function openAtlas(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', '1');
  });
  await page.goto(ATLAS_URL);
  const skip = page.getByRole('button', { name: /Skip( for now)?/ });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.locator('.kb-atlas .node.doc').first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function rescan(page: Page) {
  await page.locator('button[title="Rescan docs"]').click();
  // the rescan replaces the node set; wait for the canvas to settle
  await page.locator('.kb-atlas .node.doc').first().waitFor({ state: 'visible', timeout: 15_000 });
}

test.describe('Knowledge Atlas — status + real-fs change detection + diff', () => {
  test('T1–T5: seed → stamp → mutate fs → detect → diff → re-stamp clears', async ({ page, request }) => {
    test.setTimeout(60_000);
    seedVault();

    try {
      // ── T1: fresh vault, no baseline → everything unindexed ────────────────
      await openAtlas(page);
      await expect(page.locator('.kb-atlas .node.doc')).toHaveCount(4);
      await expect(page.locator(badge)).toHaveCount(4); // hollow unindexed pips
      await expect(page.locator(`${badge}.st-unindexed`)).toHaveCount(4);
      await expect(page.locator(changedChip)).toHaveCount(0);

      // ── T2: stamp baseline — badges clear, vault stays untouched ───────────
      await page.locator(stampBtn).click();
      await expect(page.locator(badge)).toHaveCount(0, { timeout: 20_000 });
      expect(fs.existsSync(`${TMP_DOCS}/index.md.json`)).toBe(false);
      expect(fs.existsSync(`${TMP_DOCS}/sub/index.md.json`)).toBe(false);
      // idempotent: a second stamp writes nothing
      const restamp = await (await request.post(
        `${API}/api/v1/docs-graph/stamp?root=${encodeURIComponent(TMP_DOCS)}`,
      )).json();
      expect(restamp.data.folders_stamped).toBe(0);

      // ── T3: real fs mutations detected on rescan ────────────────────────────
      fs.appendFileSync(`${TMP_DOCS}/alpha.md`, '\nNEW LINE appended after stamp.\n');
      fs.writeFileSync(`${TMP_DOCS}/epsilon.md`, '# Epsilon\n\nBrand new doc.\n');
      fs.rmSync(`${TMP_DOCS}/beta.md`);
      fs.renameSync(`${TMP_DOCS}/sub/gamma.md`, `${TMP_DOCS}/sub/gamma2.md`);

      await rescan(page);
      await expect(page.locator(`${badge}.st-modified`)).toHaveCount(1);
      await expect(page.locator(`${badge}.st-added`)).toHaveCount(2); // epsilon + renamed gamma2
      await expect(page.locator('.kb-atlas .node.ghost')).toHaveCount(2); // beta + old gamma
      await expect(page.locator(changedChip)).toContainText('5 changed');

      // changes-highlight mode fades the untouched nodes (e.g. delta.md)
      await page.locator(changedChip).click();
      await expect(page.locator('.kb-atlas .node.faded').first()).toBeVisible();
      await page.locator(changedChip).click(); // toggle off

      // backend manifest agrees with the UI (rename paired 1:1)
      const changes = await (await request.get(
        `${API}/api/v1/docs-graph/changes?root=${encodeURIComponent(TMP_DOCS)}`,
      )).json();
      expect(changes.data.modified.map((m: { rel: string }) => m.rel)).toEqual(['alpha.md']);
      expect(changes.data.renamed[0]).toMatchObject({ from_rel: 'sub/gamma.md', to_rel: 'sub/gamma2.md' });

      // ── T4: line diff in the drawer ─────────────────────────────────────────
      await page.locator('.kb-atlas .node.doc', { hasText: 'Alpha' }).click();
      await expect(page.locator('.kb-atlas .drawer.open')).toBeVisible();
      await page.locator(changesTab).click();
      await expect(page.locator(diffPanel)).toBeVisible();
      await expect(page.locator(diffPanel)).toContainText('NEW LINE appended', { timeout: 15_000 });
      await page.keyboard.press('Escape');

      // removed doc: drawer lands on Changes directly, old content visible
      await page.locator('.kb-atlas .node.ghost', { hasText: 'Beta' }).click();
      await expect(page.locator(diffPanel)).toBeVisible();
      await expect(page.locator(diffPanel)).toContainText('Will be removed', { timeout: 15_000 });
      await page.keyboard.press('Escape');

      // ── T5: no false positives; stamping again clears everything ────────────
      await rescan(page);
      await expect(page.locator(changedChip)).toContainText('5 changed'); // unchanged count
      await page.locator(stampBtn).click();
      await expect(page.locator(badge)).toHaveCount(0, { timeout: 20_000 });
      await expect(page.locator(changedChip)).toHaveCount(0);
    } finally {
      fs.rmSync(TMP_DOCS, { recursive: true, force: true });
    }
  });
});
