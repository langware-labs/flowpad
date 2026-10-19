import { expect, type Page } from '@playwright/test';

export type QaViewMode = 'vibe' | 'standard' | 'advanced' | 'dev';

/** Placeholder base for parsing a relative app path. One definition, so the
 *  convention (and any future real host) lives in a single place. */
const PATH_BASE = 'http://flowpad.test';

/** The pathname of a relative app path, ignoring query and hash. */
export function toPathname(path: string): string {
  return new URL(path, PATH_BASE).pathname;
}

/**
 * Put view mode on the dock URL, the same contract used by the footer toggle.
 * The route loader adopts this into the backend-owned preference and the
 * current project's remembered mode.
 */
export function withViewMode(path: string, mode: QaViewMode): string {
  const url = new URL(path, PATH_BASE);
  url.searchParams.set('viewMode', mode);
  return `${url.pathname}${url.search}${url.hash}`;
}

const SURFACE: Record<QaViewMode, string> = { vibe: 'vibe', standard: 'chat', advanced: 'terminal', dev: 'terminal' };

/**
 * Select a mode through the session's own switch (the only mode control: a mode
 * belongs to a session tab) and wait for its URL-backed state to commit. On a
 * page that is not a session there is nothing to select — pages have one look —
 * so this is a no-op there.
 */
export async function selectViewMode(page: Page, mode: QaViewMode): Promise<void> {
  const segment = page.locator(`[data-testid="session-surface-${SURFACE[mode]}"]:visible`).first();
  if (!(await segment.isVisible().catch(() => false))) return;
  if ((await segment.getAttribute('aria-checked')) !== 'true') {
    await segment.click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-view', mode === 'dev' ? 'advanced' : mode);
}
