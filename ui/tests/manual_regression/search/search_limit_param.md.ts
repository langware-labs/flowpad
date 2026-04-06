import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
});

test('Search limit parameter constrains result count', async ({ page }) => {
  const apiUrl = process.env.API_URL || 'http://localhost:9007';

  // Request with limit=1
  const response = await page.request.get(`${apiUrl}/api/v1/search?q=test&limit=1`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('SUCCESS');
  expect(body.data.results.length).toBeLessThanOrEqual(1);

  // Request with limit=0 — should return empty or be handled gracefully
  const response0 = await page.request.get(`${apiUrl}/api/v1/search?q=test&limit=0`);
  expect(response0.status()).not.toBe(500);

  // Request with negative limit — should not crash
  const responseNeg = await page.request.get(`${apiUrl}/api/v1/search?q=test&limit=-1`);
  expect(responseNeg.status()).not.toBe(500);
});
