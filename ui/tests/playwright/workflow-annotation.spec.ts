import { test, expect } from '@playwright/test';

/**
 * Workflow Annotation Gutter E2E tests
 *
 * Full verification (steps 3-10 in the plan) requires a live backend with a
 * workflow file and Claude running. These tests cover what is verifiable in a
 * standard CI environment (app loads, annotation gutter absent without a run).
 *
 * Steps that require live Claude output are documented as manual tests below.
 */
test.describe('WorkflowAnnotationGutter', () => {
  test('annotation gutter is absent when no run is active', async ({ page }) => {
    await page.goto('http://localhost:4097');
    // Allow app to settle
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {/* ignore */});

    // The gutter must NOT appear until a workflow run starts
    const gutter = page.locator('[data-testid="workflow-annotation-gutter"]');
    await expect(gutter).toHaveCount(0);
  });

  /**
   * Manual / CI-with-backend tests (documented steps from the plan):
   *
   * 1. Navigate to WorkflowsPage (/workflows or via sidebar)
   * 2. Select a workflow that uses step headings (e.g. counter.md)
   * 3. Click Run → wait for InteractiveTerminal PTY output
   * 4. Assert [data-testid="workflow-annotation-gutter"] appears
   * 5. Wait for ≥1 workflow_trace event chip (pollForSelector('.annotation-chip'))
   * 6. Assert chip text matches a step name from the workflow markdown
   * 7. Assert chip top (getBoundingClientRect().top) is within ±40px of the
   *    corresponding heading in the editor
   * 8. Click Run again → assert old events moved to history dropdown,
   *    annotation column cleared
   * 9. Select "Run 1" from history dropdown → assert first-run events shown
   */
});
