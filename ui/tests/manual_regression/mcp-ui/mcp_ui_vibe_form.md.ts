import { test, expect } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import path from 'node:path';

import { API, createVibeFixture, destroyVibeFixture, openVibe, showPath } from '../vibe/_helpers';

const OPEN_ANSWER = 'I prefer async collaboration with clear acceptance criteria.';
const UPLOAD_NAME = 'mcp-ui-demo-upload.txt';
const UPLOAD_TEXT = 'Upload proof from Playwright for the MCP UI demo.';

test.describe('MCP UI Vibe demo', () => {
  test('renders an MCP App form and delivers its submission to the agent prompt boundary', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'mcp-ui-form');
    try {
      const mcpPath = path.join(fixture.root, 'questions.mcp.html');
      copyFileSync(path.resolve(process.cwd(), 'tests/manual_regression/mcp-ui/_fixtures/questions.mcp.html'), mcpPath);
      await showPath(request, fixture.processId, mcpPath);

      const promptUrl = `${API}/api/v1/graph/agentic_process/${fixture.processId}/prompt`;
      await page.route(promptUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/xml',
          body: '',
        });
      });
      await openVibe(page, fixture.processId);

      const preview = page.locator('[data-testid="mcp-app-preview"]');
      await expect(preview).toBeVisible();
      const app = page.frameLocator('[data-testid="mcp-app-preview"] iframe').frameLocator('iframe#root');
      await expect(app.locator('[data-testid="mcp-ui-root"]')).toBeVisible();

      await app.locator('[data-testid="mcp-ui-open-question"]').fill(OPEN_ANSWER);
      await app.locator('[data-testid="mcp-ui-multiselect-planning"]').click();
      await app.locator('[data-testid="mcp-ui-multiselect-design"]').click();
      await app.locator('[data-testid="mcp-ui-file-upload"]').setInputFiles({
        name: UPLOAD_NAME,
        mimeType: 'text/plain',
        buffer: Buffer.from(UPLOAD_TEXT),
      });

      const delivered = page.waitForRequest(
        (candidate) => candidate.url() === promptUrl && candidate.method() === 'POST',
      );
      await app.locator('[data-testid="mcp-ui-submit"]').click();
      await expect(app.locator('[data-testid="mcp-ui-submission-status"]')).toContainText(/submitted/i);

      const promptRequest = await delivered;
      const prompt = String(promptRequest.postDataJSON()?.message ?? '');
      expect(prompt).toContain('MCP_UI_SUBMISSION');
      expect(prompt).toContain(OPEN_ANSWER);
      expect(prompt).toContain('planning');
      expect(prompt).toContain('design');
      expect(prompt).toContain(UPLOAD_NAME);
      expect(prompt).toContain(UPLOAD_TEXT);
      expect(prompt).toContain('Reply with the exact marker MCP_UI_RECEIVED');
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });
});
