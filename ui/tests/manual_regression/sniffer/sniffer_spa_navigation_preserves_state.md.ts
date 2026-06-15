import { expect, test, type APIRequestContext } from '@playwright/test';

import { apiBase } from '../_shared/api';

const API = apiBase();

async function snifferHook(request: APIRequestContext) {
  const res = await request.get(`${API}/api/v1/graph/bootstrap`);
  expect(res.status()).toBe(200);
  return (await res.json()).data.sniffer_hook;
}

// Sniffer is OPT-IN, default OFF. The default-off state must hold across SPA
// navigation — neither client-side routing nor the per-user localStorage pref
// flips the per-instance gate.
test.describe('Sniffer — default-off survives SPA navigation', () => {
  test('1: default-off sniffer state is unchanged after SPA navigation', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // home → shell → home, waiting for the app shell to render at each stop.
    await page.goto('/dock/home');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.goto('/dock/shell');
    await page.locator('[data-testid="agent-layout"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.goto('/dock/home');
    await page.locator('[data-testid="flow-page"]').waitFor({ state: 'visible', timeout: 30_000 });

    // The per-instance gate is still off after all the routing.
    expect(await snifferHook(request), 'SPA navigation never enables the sniffer gate').toBeNull();

    // No SNIFFER-RELATED console errors during navigation. Ignore ambient noise
    // unrelated to the sniffer: resource 404s and in-flight use-claude-projects
    // fetches aborted by the full-page route transition ("Failed to list
    // projects: TypeError: Failed to fetch") — neither is a sniffer regression.
    const real = errors.filter(
      (e) => !/Failed to load resource/.test(e) && !/Failed to list projects/.test(e),
    );
    expect(real, `sniffer-related console errors during SPA nav: ${real.join('\n')}`).toHaveLength(0);
  });
});
