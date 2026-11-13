/**
 * Browser scenario — a person adds a Google Vertex root on the hub from the desktop's LLM Endpoints tab,
 * through the one shared "New endpoint" dialog, and the hub proves the key against Google:
 * the row's Test answers, and the Models tab lists Gemini 4 Carbon.
 *
 * Needs VERTEX_API_KEY (an API key bound to a service account). Deletes the endpoint at the end.
 */
import { expect, test, type Page } from '@playwright/test';

const KEY = process.env.VERTEX_API_KEY ?? '';
const PROJECT = process.env.VERTEX_PROJECT ?? 'flowpad-vertex-1111';
const BASE_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global`;
const NAME = `vertex-e2e-${Date.now()}`;

let createdId = '';

test.skip(!KEY, 'needs VERTEX_API_KEY');

async function api(page: Page, method: string, path: string): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ([m, p]) => {
      const r = await fetch(p as string, { method: m as string });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [method, path] as const,
  );
}

async function endpointNamed(page: Page, name: string): Promise<string> {
  const listed = await api(page, 'GET', '/api/v1/graph/llm_endpoint?expand=permissions');
  const rows = (listed.body?.data?.items ?? listed.body?.data ?? []) as { id: string; name: string }[];
  return rows.find((r) => r.name === name)?.id ?? '';
}

test.afterAll(async ({ browser }) => {
  if (!createdId) return;
  const page = await browser.newPage();
  await page.goto('/dock/llm-sources/endpoints');
  await expect
    .poll(async () => (await api(page, 'DELETE', `/api/v1/graph/llm_endpoint/${createdId}`)).status)
    .toBeLessThan(300);
  await page.close();
});

test('a Vertex root made in the shared dialog is tested against Google and lists Gemini 4 Carbon', async ({ page }) => {
  page.on('response', async (r) => {
    if (r.url().endsWith('/credential') && r.request().method() === 'POST' && r.status() >= 400) {
      console.log('credential upload refused:', r.status(), await r.text());
    }
  });
  await page.goto('/dock/llm-sources/endpoints');
  await page.getByTestId('llm-new-endpoint').click();

  const dialog = page.getByTestId('llm-endpoint-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'New endpoint' })).toBeVisible();
  // On the hub: Vertex is offered there (not on this machine).
  await dialog.getByTestId('destination-hub').click();
  await dialog.getByTestId('provider-vertex').click();
  await dialog.getByTestId('llm-name').fill(NAME);
  await dialog.getByTestId('llm-base-url').fill(BASE_URL);
  await dialog.getByTestId('credential-input').fill(KEY);
  await expect(dialog.getByTestId('credential-shape-problem')).toHaveCount(0);
  await dialog.getByTestId('llm-submit').click();
  await expect(dialog).toBeHidden();
  // The key was stored with the endpoint: a refused key would leave this toast instead.
  await expect(page.getByText(`Added ${NAME} and stored its key`)).toBeVisible();
  await expect(page.getByText('the key was not saved', { exact: false })).toHaveCount(0);
  // The toast sits over the last row's buttons; it has said what it had to.
  await page.getByText(`Added ${NAME} and stored its key`).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText(`Added ${NAME} and stored its key`)).toBeHidden();

  await expect.poll(async () => (createdId = await endpointNamed(page, NAME))).not.toBe('');

  // The row's Test is the hub's credential probe: one real call to Google.
  const testButton = page.getByTestId(`llm-test-${createdId}`);
  await expect(testButton).toBeVisible();
  await testButton.click();
  await expect(testButton).toHaveClass(/text-emerald-600/);

  await page.goto(`/dock/hub/llm-endpoints/${createdId}/models`);
  await expect(page.getByTestId('models-list')).toContainText('google/gemini-4-carbon');
});
