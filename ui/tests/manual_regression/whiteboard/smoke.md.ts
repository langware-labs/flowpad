import { expect, test, type APIRequestContext } from '@playwright/test';

// API base for this instance (frontend is baseURL on VITE_PORT; backend on :6002).
const API = process.env.API_URL || 'http://localhost:6002';

async function createWhiteboard(request: APIRequestContext, name: string, description = '') {
  const res = await request.post(`${API}/api/v1/graph/whiteboard`, { data: { name, description } });
  expect(res.status(), 'whiteboard create POST').toBe(200);
  const body = await res.json();
  return { id: body.data.id as string, assetRef: body.data.asset_ref as string };
}

test.describe('Whiteboard — Smoke (S1–S3)', () => {
  test('S1: backend reachable', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/graph/bootstrap`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
  });

  test('S2: whiteboard type registered', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/graph/whiteboard`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('Unknown entity type');
    const body = JSON.parse(text);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('S3: excalidraw bundle lazy-loads + editor mounts', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const { id } = await createWhiteboard(request, 'smoke-s3', 'smoke s3');
    // AssetDocPointer grammar requires an explicit typeid/ method segment.
    await page.goto(`/dock/assets/editor/whiteboard/typeid/whiteboard-${id}`);
    await page.locator('[data-testid="whiteboard-editor"]').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(1_500);

    // Excalidraw container healthy height (CSS-missing regression inflates to 33,554,432).
    const containerH = await page.evaluate(() => {
      const el = document.querySelector('[class*="excalidraw-container"]') as HTMLElement | null;
      return el?.clientHeight ?? -1;
    });
    expect(containerH).toBeGreaterThan(100);
    expect(containerH).toBeLessThan(100_000);

    // No React error boundary.
    const hasError = await page
      .getByRole('heading', { name: /^Error$/ })
      .count();
    expect(hasError).toBe(0);

    // No uncaught excalidraw / undefined-access console errors.
    const real = errors.filter(
      (e) =>
        /excalidraw/i.test(e) || /Cannot read properties of undefined/.test(e),
    );
    expect(real, `Excalidraw console errors: ${real.join('\n')}`).toHaveLength(0);

    // Cleanup (best-effort; folder remains on disk by design).
    await request.delete(`${API}/api/v1/graph/whiteboard/${id}`).catch(() => {});
  });
});
