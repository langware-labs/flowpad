import { expect, type Page } from '@playwright/test';

export type QaViewMode = 'vibe' | 'standard' | 'advanced' | 'dev';

/**
 * Put view mode on the dock URL, the same contract used by the footer toggle.
 * The route loader adopts this into the backend-owned preference and the
 * current project's remembered mode.
 */
export function withViewMode(path: string, mode: QaViewMode): string {
  const url = new URL(path, 'http://flowpad.test');
  url.searchParams.set('viewMode', mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Select a mode through the real footer control and wait for its URL-backed
 * state to commit. This also replaces a conflicting viewMode already present
 * on the current URL.
 */
export async function selectViewMode(page: Page, mode: QaViewMode): Promise<void> {
  const toggle = page.getByTestId(`view-toggle-${mode}`);
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-view', mode);
}
