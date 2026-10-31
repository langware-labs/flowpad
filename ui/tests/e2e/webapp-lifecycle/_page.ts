/** Browser helpers: open an app on its dock route, reach into its frame, count backend calls. */
import type { FrameLocator, Page, Request } from '@playwright/test';

export const FRAME = '[data-testid="vibe-app-frame"]';
export const READY = '[data-testid="stub-ready"]';

export const appUrl = (typeid: string) => `/dock/app/${typeid}`;

export async function openApp(page: Page, typeid: string): Promise<void> {
  await page.goto(appUrl(typeid));
}

export function frame(page: Page): FrameLocator {
  return page.frameLocator(FRAME).first();
}

/** Visible-ready inside the app frame; resolves to the ms it took, or null when the budget ran out. */
export async function timeToReady(page: Page, budgetMs: number): Promise<number | null> {
  const t0 = Date.now();
  try {
    await frame(page).locator(READY).first().waitFor({ state: 'visible', timeout: budgetMs });
    return Date.now() - t0;
  } catch {
    return null;
  }
}

export interface CallCounter {
  reset(): void;
  readonly count: number;
  readonly urls: string[];
  stop(): void;
}

/** Every `/api/v1/` HTTP request the page makes (websockets excluded), resettable. */
export function countBackendCalls(page: Page): CallCounter {
  let urls: string[] = [];
  const on = (req: Request) => {
    const url = req.url();
    if (!url.includes('/api/v1/')) return;
    if (url.startsWith('ws:') || url.startsWith('wss:') || req.resourceType() === 'websocket') return;
    urls.push(`${req.method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  };
  page.on('request', on);
  return {
    reset: () => {
      urls = [];
    },
    get count() {
      return urls.length;
    },
    get urls() {
      return [...urls];
    },
    stop: () => page.off('request', on),
  };
}

/** What the visible app area shows when the frame never got ready — for the report, not an assertion. */
export async function visibleState(page: Page): Promise<string> {
  for (const id of ['webapp-setup-gate', 'app-not-installed', 'project-load-gate', 'app-opens-in-tab', 'webapp-header']) {
    if (await page.getByTestId(id).first().isVisible().catch(() => false)) return id;
  }
  if (await page.locator(FRAME).first().isVisible().catch(() => false)) return 'frame (not ready)';
  return (await page.locator('main').first().innerText().catch(() => '')).slice(0, 160) || 'blank';
}
