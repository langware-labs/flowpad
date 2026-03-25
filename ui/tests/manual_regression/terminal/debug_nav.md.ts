import { test, expect } from '@playwright/test';

test('debug new_terminal navigation', async ({ page }) => {
  test.setTimeout(60_000);
  
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });

  const requests: Array<{url: string, method: string, status?: number}> = [];
  
  page.on('request', req => {
    if (req.url().includes('9007')) {
      requests.push({ url: req.url(), method: req.method() });
    }
  });
  page.on('response', resp => {
    const match = requests.find(r => r.url === resp.url() && !r.status);
    if (match) match.status = resp.status();
  });

  await page.goto('/dock/shell/new_terminal');
  await page.waitForTimeout(5_000);
  
  console.log('API requests/responses:');
  requests.forEach(r => console.log(`  ${r.method} ${r.url.replace('http://localhost:9007', '')} -> ${r.status}`));
  console.log('Current URL:', page.url());
});
