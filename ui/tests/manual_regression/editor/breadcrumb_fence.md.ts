/**
 * The `breadcrumb` fence in a real browser — see breadcrumb_fence.md.
 *
 * jsdom already pins the card's DOM and its cache
 * (ui/tests/unit/fence-render-breadcrumb*.test.ts). What only exists here: the
 * renderer being registered in the shipped editor at all, a real
 * `POST /api/v1/tags/context` walking a real project root, and a chip click
 * opening the real FilePreviewSheet.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { activeProject, createProjectMarkdown, deleteMarkdown } from './_seed';

const TAG = 'breadcrumb.test.qa_fence_probe.rules';
const NOTE = 'FAILING? read this tag rules before editing';

/** A test file carrying a real `tag` capsule — byte-for-byte what
 *  the `tagit` skill's `insert_breadcrumb.py` writes. The capsule sits
 *  at column 0 above the def; its own line is what `scan_code_capsules`
 *  reports, and therefore what the fence's `line` must say. */
const CAPSULE_LINE = 1;
const TARGET_PY = `# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     ${TAG}: ${NOTE}
# flowpad:endcapsule tag
def test_qa_fence_probe():
    assert True
`;

interface Fixture {
  markdownId: string;
  relPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Seed a rules doc whose fence names a real capsule-carrying file.
 *
 * Both files go inside the active project's mount path, because the card
 * resolves a site against the DOCUMENT's project root and the tag index walks
 * that same root — a fixture outside it would render disabled chips and an
 * empty join, i.e. would test nothing.
 */
async function seed(page: Page): Promise<Fixture> {
  const { root: projectRoot } = await activeProject(page.request);

  const stamp = Date.now();
  const dir = path.join(projectRoot, `qa-breadcrumb-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const pyPath = path.join(dir, 'test_qa_fence_probe.py');
  writeFileSync(pyPath, TARGET_PY, 'utf8');
  const relPath = path.relative(projectRoot, pyPath).split(path.sep).join('/');

  const doc = await createProjectMarkdown(page.request, `qa-breadcrumb-${stamp}`);
  if (!doc.assetRef) throw new Error('seed markdown returned no asset_ref');

  writeFileSync(
    doc.assetRef,
    [
      '# QA breadcrumb probe',
      '',
      '## Bound tests',
      '',
      '```breadcrumb',
      `tag: ${TAG}`,
      'sites:',
      `  - rel_path: ${JSON.stringify(relPath)}`,
      `    line: ${CAPSULE_LINE}`,
      `    note: ${JSON.stringify(NOTE)}`,
      '```',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    markdownId: doc.id,
    relPath,
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(doc.assetRef, { force: true });
      // The entity too — deleting only the file leaves an orphan row per run.
      await deleteMarkdown(page.request, doc.id);
    },
  };
}

/** Open the doc. Mirrors milkdown_selection_toolbar.md.ts — the view chip is
 *  the mode-agnostic open signal, and Advanced comes from the live app API
 *  because the backend pref outranks the localStorage seed. */
async function openDoc(page: Page, markdownId: string) {
  await page.goto(`/dock/assets/editor/markdown/typeid/markdown-${markdownId}`);
  await expect(page.locator('[data-testid="editor-mode-chip-view"]')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => window.setView('advanced'));
  await expect(page.locator('[data-testid="editor-mode-chip-review"]')).toBeVisible({ timeout: 10_000 });
}

async function setMode(page: Page, mode: 'view' | 'editor') {
  const chip = page.locator(`[data-testid="editor-mode-chip-${mode}"]`);
  await page.locator('.ProseMirror, [data-testid="review-surface"]').first().waitFor({ state: 'visible', timeout: 15_000 });
  await expect(chip).toBeEnabled({ timeout: 10_000 });
  if ((await chip.getAttribute('data-mode-active')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('data-mode-active', 'true', { timeout: 10_000 });
}

test.describe('breadcrumb fence', () => {
  let fixture: Fixture;

  test.beforeEach(async ({ page }) => {
    fixture = await seed(page);
    await openDoc(page, fixture.markdownId);
  });

  test.afterEach(async () => {
    await fixture?.cleanup();
  });

  test('renders the authored sites as a card', async ({ page }) => {
    const card = page.locator('[data-testid="breadcrumb-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="breadcrumb-tag"]')).toHaveText(TAG);
    await expect(page.locator('[data-testid="breadcrumb-site-0"]')).toContainText(
      `${fixture.relPath}:${CAPSULE_LINE}`,
    );
    await expect(card).toContainText(NOTE);
  });

  /* The whole point of the feature: one click from the rules to the test. */
  test('a site chip peeks at the test', async ({ page }) => {
    const chip = page.locator('[data-testid="breadcrumb-site-0"]');
    await expect(chip).toBeEnabled({ timeout: 15_000 });
    await chip.click();
    await expect(page.getByText(path.basename(fixture.relPath)).first()).toBeVisible({ timeout: 10_000 });
  });

  /* Deliberately not gated on editability — a regression here would most
   * likely come from someone "correctly" gating the card on ctx.editable. */
  test('stays clickable on a read-only surface', async ({ page }) => {
    await setMode(page, 'view');
    const chip = page.locator('[data-testid="breadcrumb-site-0"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toBeEnabled();
  });

  /* The half jsdom cannot fake: a real tag-context call, a real capsule scan. */
  test('refreshes from the live tag index', async ({ page }) => {
    await expect(page.locator('[data-testid="breadcrumb-provenance"]')).toHaveAttribute(
      'data-provenance',
      'live',
      { timeout: 15_000 },
    );
    await expect(page.locator('[data-testid="breadcrumb-site-0"]')).toContainText(fixture.relPath);
  });

  /* The plugin adds no schema, parser or serializer: rendering must not
   * change a single byte of the document. */
  test('keeps the fence source byte-identical', async ({ page }) => {
    await setMode(page, 'editor');
    const block = page.locator('[data-testid="fence-render-block"][data-language="breadcrumb"]');
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.getByRole('tab', { name: 'Code' }).click();
    await expect(block.locator('pre.fence-render-source')).toContainText(`tag: ${TAG}`);
    await expect(block.locator('pre.fence-render-source')).toContainText(fixture.relPath);
  });
});
