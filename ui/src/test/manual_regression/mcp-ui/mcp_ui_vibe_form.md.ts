import { test, expect, type Page } from '@playwright/test';

const PROMPT = 'use mcp ui to show me a open quesiton, multi select question and file uplaod request';
const OPEN_ANSWER = 'I prefer async collaboration with clear acceptance criteria.';
const UPLOAD_NAME = 'mcp-ui-demo-upload.txt';
const UPLOAD_TEXT = 'Upload proof from Playwright for the MCP UI demo.';
const LIVE_AGENT_UNAVAILABLE =
  /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded|unauthenticated|login required|api key)/i;

async function dismissWelcomeModal(page: Page) {
  const skipForNow = page.getByRole('button', { name: 'Skip for now' });
  if (await skipForNow.isVisible({ timeout: 12_000 }).catch(() => false)) {
    await skipForNow.click({ force: true, timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function skipIfLiveAgentUnavailable(page: Page, reason: string) {
  const text = await page.locator('body').textContent({ timeout: 2_000 }).catch(() => '');
  if (LIVE_AGENT_UNAVAILABLE.test(text ?? '')) {
    test.skip(true, `${reason}: ${(text ?? '').slice(0, 240)}`);
  }
}

test.describe('MCP UI Vibe demo', () => {
  test('renders an MCP App form and delivers its submission to the agent', async ({ page }) => {
    await page.goto('/dock/home');
    await page.waitForFunction(() => typeof window.setView === 'function', null, { timeout: 60_000 });
    await page.evaluate(() => window.setView('vibe'));
    await dismissWelcomeModal(page);

    const promptInput = page.locator('textarea[aria-label^="What would you like to work on"], textarea[placeholder^="What would you like to work on"]').first();
    await promptInput.waitFor({ state: 'visible', timeout: 30_000 });
    await promptInput.fill(PROMPT);
    await promptInput.press('Enter');

    const startResult = await Promise.race([
      page.waitForURL(/\/dock\/shell\//, { timeout: 45_000 }).then(() => 'started' as const),
      page.getByText(/Project Required/i).waitFor({ timeout: 45_000 }).then(() => 'no-project' as const),
    ]).catch(async (e) => {
      await skipIfLiveAgentUnavailable(page, 'Vibe agent did not start');
      throw e;
    });
    if (startResult === 'no-project') {
      test.skip(true, 'No current project is selected, so Vibe cannot start a live agent process.');
    }

    const preview = page.locator('[data-testid="mcp-app-preview"]');
    await preview.waitFor({ state: 'visible', timeout: 180_000 }).catch(async (e) => {
      await skipIfLiveAgentUnavailable(page, 'MCP UI did not appear');
      throw e;
    });

    const app = page
      .frameLocator('[data-testid="mcp-app-preview"] iframe')
      .frameLocator('iframe#root');
    await app.locator('[data-testid="mcp-ui-root"]').waitFor({ state: 'visible', timeout: 60_000 });

    await app.locator('[data-testid="mcp-ui-open-question"]').fill(OPEN_ANSWER);
    await app.locator('[data-testid="mcp-ui-multiselect-planning"]').click();
    await app.locator('[data-testid="mcp-ui-multiselect-design"]').click();
    await app.locator('[data-testid="mcp-ui-file-upload"]').setInputFiles({
      name: UPLOAD_NAME,
      mimeType: 'text/plain',
      buffer: Buffer.from(UPLOAD_TEXT),
    });
    await app.locator('[data-testid="mcp-ui-submit"]').click();
    await expect(app.locator('[data-testid="mcp-ui-submission-status"]')).toContainText(/submitted/i, {
      timeout: 15_000,
    });

    const panel = page.locator('[data-testid="flow-page"] [data-testid="entity-execution-panel"]').first();
    await expect(panel).toContainText('MCP_UI_RECEIVED', { timeout: 180_000 }).catch(async (e) => {
      await skipIfLiveAgentUnavailable(page, 'Agent did not acknowledge MCP UI submission');
      throw e;
    });
    await expect(panel).toContainText(OPEN_ANSWER);
    await expect(panel).toContainText('planning');
    await expect(panel).toContainText('design');
    await expect(panel).toContainText(UPLOAD_NAME);
    await expect(panel).toContainText('Upload proof from Playwright');
  });
});
