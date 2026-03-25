import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, ensureActiveSession, sendInstruction } from './helpers';

test.describe('Send Multiple Messages', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
  });

  test('send several messages and validate responses', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'first question');
    await ensureActiveSession(page);

    // send first message
    await sendInstruction(page, 'What is 2 + 2?');
    await expect(page.getByText('What is 2 + 2?')).toBeVisible();

    // validate first AI response
    const assistantBlocks = page.locator('text=◂ assistant');
    await expect(assistantBlocks.first()).toBeVisible();

    // send second message (counts include 1 from submitFromLanding)
    await sendInstruction(page, 'Now multiply that by 3');
    await expect(page.getByText('Now multiply that by 3')).toBeVisible();
    await expect(assistantBlocks).toHaveCount(3, { timeout: 10_000 });

    // send third message
    await sendInstruction(page, 'Summarize our conversation');
    await expect(page.getByText('Summarize our conversation')).toBeVisible();
    await expect(assistantBlocks).toHaveCount(4, { timeout: 10_000 });
  });

  test('scroll behavior - newest message visible', async ({ page }) => {
    test.setTimeout(120_000);

    await gotoLanding(page);
    await submitFromLanding(page, 'scroll test');
    await ensureActiveSession(page);

    // send several messages to fill the view
    for (const msg of ['Message one', 'Message two', 'Message three']) {
      await sendInstruction(page, msg);
    }

    // the last message should be scrolled into view
    await expect(page.getByText('Message three', { exact: true })).toBeInViewport();
  });
});
