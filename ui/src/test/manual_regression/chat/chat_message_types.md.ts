import { test, expect } from '@playwright/test';
import { dismissSetupModal, gotoLanding, submitFromLanding, ensureActiveSession, sendInstruction } from './helpers';

test.describe('Chat Message Types', () => {
  test.beforeEach(async ({ page }) => {
    await dismissSetupModal(page);
    await gotoLanding(page);
    await submitFromLanding(page, 'message types test');
    await ensureActiveSession(page);
  });

  test('plain text message with USER and ASSISTANT blocks', async ({ page }) => {
    test.setTimeout(60_000);

    await sendInstruction(page, 'What is the capital of France?');

    // validate USER block appears
    await expect(page.getByText('What is the capital of France?')).toBeVisible();
    await expect(page.locator('text=▸ user').first()).toBeVisible();

    // validate ASSISTANT block appears
    await expect(page.locator('text=◂ assistant').first()).toBeVisible();

    // validate DONE status
    await expect(page.getByText('DONE')).toBeVisible();
  });

  test('thinking block appears and is expandable', async ({ page }) => {
    test.setTimeout(60_000);

    await sendInstruction(page, 'What is the capital of France?');

    // validate THINKING block appears (rendered as lowercase "thinking" with CSS uppercase)
    const thinkingButton = page.locator('button', { hasText: 'thinking' }).first();
    await expect(thinkingButton).toBeVisible();

    // thinking block is collapsed by default after completion (auto-collapses)
    // click to expand
    await thinkingButton.click();

    // validate reasoning content is visible inside expanded block
    const reasoningContent = thinkingButton.locator('..').locator('pre');
    await expect(reasoningContent).toBeVisible();

    // click to collapse
    await thinkingButton.click();

    // validate content is hidden
    await expect(reasoningContent).not.toBeVisible();
  });

  test('tool use produces multiple thinking blocks', async ({ page }) => {
    test.setTimeout(90_000);

    await sendInstruction(page, 'Run the shell command: echo hello world');

    // validate USER block
    await expect(page.getByText('Run the shell command: echo hello world')).toBeVisible();

    // validate at least 2 thinking blocks appear (tool reasoning + result processing)
    const thinkingBlocks = page.locator('button', { hasText: 'thinking' });
    const count = await thinkingBlocks.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // validate ASSISTANT block with response
    await expect(page.locator('text=◂ assistant').last()).toBeVisible();
  });
});
