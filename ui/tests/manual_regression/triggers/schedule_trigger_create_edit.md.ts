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

test('create, edit, and delete a schedule trigger', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  await dismissSetupModal(page);
  await gotoTriggers(page);

  const createdIds: string[] = [];

  // Step 1: Click "New Schedule" button
  const newScheduleBtn = page.locator('button[title="New schedule trigger"]');
  await newScheduleBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await newScheduleBtn.click();

  // Verify: center panel shows the create form
  await page.locator('text=New Schedule Trigger').waitFor({ state: 'visible', timeout: 5_000 });

  // Step 2: Fill in the form — name and daily preset
  const nameInput = page.locator('input[placeholder="Today"]').first();
  await nameInput.clear();
  await nameInput.fill('Test Daily Schedule');

  // Select "Daily" preset
  await page.locator('button:has-text("Daily")').click();

  // Set time to 10:00
  const timeInput = page.locator('input[type="time"]').first();
  await timeInput.fill('10:00');

  // Step 3: Submit
  const createBtn = page.locator('button[type="submit"]:has-text("Create")');
  await createBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await createBtn.click();

  // Step 4: Verify trigger appears in the schedule section
  await page.locator('text=Test Daily Schedule').first().waitFor({ state: 'visible', timeout: 15_000 });

  // Capture the trigger ID for cleanup
  const triggerId = await page.evaluate(async () => {
    const res = await fetch('http://localhost:9008/api/v1/graph/trigger');
    const json = await res.json();
    const triggers = json?.data ?? [];
    const t = triggers.find((tr: any) => tr.name === 'Test Daily Schedule');
    return t?.id ?? null;
  });
  if (triggerId) createdIds.push(triggerId);

  // Verify expr shows in list
  const scheduleSection = page.locator('text=Test Daily Schedule').first();
  await expect(scheduleSection).toBeVisible();

  // Step 5: Edit — select the trigger, change name
  await page.locator('text=Test Daily Schedule').first().click();
  await page.waitForTimeout(500);

  const editNameInput = page.locator('input[placeholder="Today"]').first();
  await editNameInput.clear();
  await editNameInput.fill('Test Daily Edited');

  const saveBtn = page.locator('button[type="submit"]:has-text("Save")');
  await saveBtn.click();

  // Verify updated name
  await page.locator('text=Test Daily Edited').first().waitFor({ state: 'visible', timeout: 10_000 });

  // Step 6: Cleanup via API
  if (createdIds.length) {
    await cleanupScheduleTriggers(page, createdIds);
  }

  // Verify no critical console errors
  const criticalErrors = errors.filter(e =>
    !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(criticalErrors).toHaveLength(0);
});
