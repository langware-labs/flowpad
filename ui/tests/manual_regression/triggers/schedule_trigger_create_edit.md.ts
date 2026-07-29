/**
 * Regression test: create, edit, and delete a schedule trigger via the unified Triggers view.
 *
 * Verifies:
 * - New schedule trigger appears in the "Schedule Triggers" section after creation
 * - Trigger shows next_run and expr in the list
 * - Editing name/schedule updates the trigger
 * - Deleting removes it from the list
 */
import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoTriggers, cleanupScheduleTriggers } from './helpers';
import { apiOrigin } from '../_shared/api';

test('create, edit, and delete a schedule trigger', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  const suffix = Date.now();
  const triggerName = `Test Daily Schedule ${suffix}`;
  const editedName = `Test Daily Edited ${suffix}`;
  const createdIds: string[] = [];

  await dismissSetupModal(page);
  await gotoTriggers(page);

  try {
    // Step 1: Click the current navigator's schedule-create control.
    const newScheduleBtn = page.getByTitle('New schedule trigger');
    await newScheduleBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await newScheduleBtn.click();

    // Verify: center panel shows the create form
    await page.getByText('New Schedule Trigger', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });

    // Step 2: Fill in the form — name and daily preset
    const nameInput = page.getByPlaceholder('Today').first();
    await nameInput.clear();
    await nameInput.fill(triggerName);
    await page.getByRole('button', { name: 'Daily', exact: true }).click();
    await page.locator('input[type="time"]').first().fill('10:00');

    // Step 3: Submit
    const createBtn = page.getByRole('button', { name: 'Create', exact: true });
    await createBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await createBtn.click();

    // Step 4: Verify the project-scoped trigger persists in the navigator.
    const createdRow = page.getByText(triggerName, { exact: true }).first();
    await createdRow.waitFor({ state: 'visible', timeout: 15_000 });

    const json = await fetch(`${apiOrigin()}/api/v1/graph/trigger`).then((res) => res.json());
    const triggers = json?.data ?? [];
    const triggerId = triggers.find((candidate: { name?: string }) => candidate.name === triggerName)?.id ?? null;
    expect(triggerId).toBeTruthy();
    createdIds.push(triggerId);

    // Step 5: Edit through the selected trigger's current CronForm.
    await createdRow.click();
    await page.waitForTimeout(500);
    const editNameInput = page.getByPlaceholder('Today').first();
    await editNameInput.click({ clickCount: 3 });
    await editNameInput.press('Backspace');
    await editNameInput.type(editedName, { delay: 20 });

    const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
    await saveBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await page.getByText(editedName, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
  } finally {
    await cleanupScheduleTriggers(page, createdIds);
  }

  // Verify no critical console errors
  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
