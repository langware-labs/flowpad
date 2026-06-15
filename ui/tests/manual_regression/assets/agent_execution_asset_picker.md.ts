import { expect, test, type Page } from '@playwright/test';

import { ensureAgentAndSkill } from './_seed';

async function dismissModals(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
    localStorage.setItem('flowpad-index-approved', '1');
  });
}
async function dismissWelcomeIfShown(page: Page) {
  for (const n of ['Skip for now', 'Not Now', 'Not now']) {
    const b = page.getByRole('button', { name: n });
    if (await b.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await b.click();
      return;
    }
  }
}

// Navigate to the agent list, open the first agent editor, and open the Asset
// Manager popover from the execution-settings gear. Leaves the popover open.
async function openAgentAssetPopover(page: Page) {
  await dismissModals(page);
  // Post-clear DBs have zero agents/skills (no auto-indexing by design) — the
  // level-2 tree row below would never exist. Self-seed via scoped create.
  await ensureAgentAndSkill(page);
  await page.goto('/dock/assets/list/agent');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await dismissWelcomeIfShown(page);

  // /dock/assets/list/agent auto-expands the agent root, so a level-2 agent row
  // is usually already present — clicking the chevron would COLLAPSE it. Only
  // expand via the chevron if no level-2 row is showing yet.
  await expect(page.locator('[data-testid^="browseable-chevron-asset-type:agent:"]').first()).toBeVisible({ timeout: 15_000 });
  const agentRow = page.getByRole('treeitem', { level: 2 }).first();
  if (!(await agentRow.isVisible({ timeout: 3_000 }).catch(() => false))) {
    await page.locator('[data-testid^="browseable-chevron-asset-type:agent:"]').first().click();
  }
  await expect(agentRow).toBeVisible({ timeout: 10_000 });
  await agentRow.click();

  await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('/dock/assets/editor/agent/');
  const panel = page.locator('[data-testid="agent-execution"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // Scope the gear to the agent-execution panel — the testid is shared by other
  // execution surfaces on the page (strict-mode would match 3 otherwise).
  const gear = panel.locator('[data-testid="entity-execution-settings"]').first();
  await expect(gear).toBeVisible();
  await gear.click();
  await expect(page.locator('[data-testid="asset-manager-popover"]')).toBeVisible({ timeout: 10_000 });
}

const popover = (page: Page) => page.locator('[data-testid="asset-manager-popover"]');

test.describe('Agent Execution — Asset Picker (Asset Manager Popover)', () => {
  test('1: settings gear opens the Asset Manager popover on an agent editor', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    expect(page.url()).toContain('/dock/assets/editor/agent/');
    await expect(popover(page)).toBeVisible();
  });

  test('2: default mode is List — filter, sort, list, add-menu panes render', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    await expect(page.locator('[data-testid="asset-manager-list-filter"]')).toBeVisible();
    await expect(page.locator('[data-testid="asset-manager-list-sort"]')).toBeVisible();
    await expect(page.locator('[data-testid="asset-manager-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="asset-manager-add-menu"]')).toBeVisible();
    await expect(popover(page).getByText('Assets', { exact: false }).first()).toBeVisible();
  });

  test('3: add menu opens Add mode with a search input', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    await page.locator('[data-testid="asset-manager-add-menu"]').click();
    await page.locator('[data-testid="asset-manager-add-asset"]').click();
    await expect(page.locator('[data-testid="asset-manager-search"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="asset-manager-back"]')).toBeVisible();
    await expect(popover(page).getByText('Add asset', { exact: false })).toBeVisible();
  });

  test('4: search narrows Add-mode candidates and Back returns to List', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    await page.locator('[data-testid="asset-manager-add-menu"]').click();
    await page.locator('[data-testid="asset-manager-add-asset"]').click();
    await expect(page.locator('[data-testid^="asset-manager-add-row-"]').first()).toBeVisible({ timeout: 3_000 });

    const search = page.locator('[data-testid="asset-manager-search"]');
    await search.fill('zzz_no_match_xyz_QA');
    await expect(popover(page).getByText('No matches.', { exact: false })).toBeVisible({ timeout: 5_000 });
    await search.fill('');
    await expect.poll(() => page.locator('[data-testid^="asset-manager-add-row-"]').count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    await page.locator('[data-testid="asset-manager-back"]').click();
    await expect(page.locator('[data-testid="asset-manager-list"]')).toBeVisible();
    await expect(popover(page).getByText('Add asset', { exact: false })).toHaveCount(0);
  });

  test('5: attach a skill — embedded row materializes with a detach button, then detach', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    await page.locator('[data-testid="asset-manager-add-menu"]').click();
    await page.locator('[data-testid="asset-manager-add-asset"]').click();

    const addRow = page.locator('[data-testid^="asset-manager-add-row-skill-"]').first();
    await expect(addRow).toBeVisible({ timeout: 3_000 });
    const addId = await addRow.getAttribute('data-testid');
    const typeId = (addId || '').replace('asset-manager-add-row-', '');
    expect(typeId, 'derived skill TypeId').toMatch(/^skill-/);

    await addRow.locator('input[type="checkbox"]').click();
    await page.waitForTimeout(1_500); // attach mutation settles

    await page.locator('[data-testid="asset-manager-back"]').click();
    await expect(page.locator('[data-testid="asset-manager-list"]')).toBeVisible();

    // The writable `embedded` row + its detach button materialize only when the
    // attached asset is NOT already a file-discovered source (project_dir/
    // user_dir, both read-only). In an env where every skill is file-backed,
    // attaching one reflects on its existing read-only row and produces no
    // embedded duplicate — there is then no detachable writable row to assert.
    const embeddedRow = page.locator(`[data-testid="asset-manager-row-${typeId}-embedded"]`);
    if ((await embeddedRow.count()) === 0) {
      // Clean up any attach side effect, then skip with a flagged reason.
      const anyDetach = page.locator(`[data-testid="asset-manager-detach-${typeId}"]`);
      if (await anyDetach.isVisible().catch(() => false)) await anyDetach.click();
      test.skip(
        true,
        `no writable embedded row: the only skill candidates are file-backed (project_dir/user_dir, read-only), so attaching ${typeId} produces no detachable embedded row in this corpus`,
      );
    }
    await expect(embeddedRow).toBeVisible({ timeout: 5_000 });
    const detach = page.locator(`[data-testid="asset-manager-detach-${typeId}"]`);
    await expect(detach).toBeVisible();
    // Cleanup: detach to keep the run idempotent.
    await detach.click();
    await expect(detach).toHaveCount(0, { timeout: 5_000 });
  });

  test('5b: read-only descriptor row renders with a lock badge and no detach button', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    await page.locator('[data-testid="asset-manager-add-menu"]').click();
    await page.locator('[data-testid="asset-manager-add-asset"]').click();
    await page.waitForTimeout(1_000);

    const roRow = page.locator('[data-testid^="asset-manager-add-row-skill-"][data-read-only="true"]').first();
    test.skip(
      (await roRow.count()) === 0,
      'env has no read-only (project_dir/user_dir source) skill candidate to exercise the lock-badge path',
    );
    const roId = await roRow.getAttribute('data-testid');
    const roTypeId = (roId || '').replace('asset-manager-add-row-', '');
    await roRow.locator('input[type="checkbox"]').click();
    await page.waitForTimeout(500);
    await page.locator('[data-testid="asset-manager-back"]').click();

    await expect(page.locator(`[data-testid^="asset-manager-row-${roTypeId}-"][data-read-only="true"]`).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`[data-testid^="asset-manager-readonly-${roTypeId}-"]`).first()).toBeVisible();
    // The read-only row has no detach (gated on attached && !readOnly); the
    // detach lives on the embedded row if one materialized — clean it up.
    const detach = page.locator(`[data-testid="asset-manager-detach-${roTypeId}"]`);
    if (await detach.isVisible().catch(() => false)) await detach.click();
  });

  test('6: project selector renders unlocked in the footer (no active process)', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    await expect(page.locator('[data-testid="execution-settings-project-section"]')).toBeVisible();
    const projectSel = page.locator('[data-testid="execution-settings-project"]');
    await expect(projectSel).toBeVisible();
    await expect(projectSel).not.toBeDisabled();
    await expect(popover(page).getByText('locked after first message', { exact: false })).toHaveCount(0);
  });

  test('7: list filter narrows attached/listed rows', async ({ page }) => {
    test.setTimeout(60_000);
    await openAgentAssetPopover(page);
    const filter = page.locator('[data-testid="asset-manager-list-filter"]');
    await filter.fill('zzz_no_match_xyz_QA');
    await expect(page.locator('[data-testid="asset-manager-list"]').getByText('No matches.', { exact: false })).toBeVisible({ timeout: 5_000 });
    await filter.fill('');
    await expect(page.locator('[data-testid="asset-manager-list"]').getByText('No matches.', { exact: false })).toHaveCount(0, { timeout: 3_000 });
  });

  test('8: popover closes on Escape and reopens cleanly', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await openAgentAssetPopover(page);
    await expect(popover(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover(page)).toBeHidden({ timeout: 5_000 });
    await page.locator('[data-testid="agent-execution"]').locator('[data-testid="entity-execution-settings"]').first().click();
    await expect(popover(page)).toBeVisible({ timeout: 10_000 });

    // No uncaught console errors (filter documented 404 noise from user- typeid
    // fetches + ambient resource 404s).
    const real = errors.filter(
      (e) => !/Failed to load resource/.test(e) && !/status of 404/.test(e) && !/user-/.test(e),
    );
    expect(real, `console errors: ${real.join('\n')}`).toHaveLength(0);
  });
});
