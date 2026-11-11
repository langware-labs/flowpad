/**
 * Browser scenario — an endpoint declares which model serves each size (sm/md/lg), a child endpoint
 * inherits them, the hub page shows and edits them, and the LLM preferences persist.
 *
 * Seeds a root (catalog + sizes) and a child allocated from it, through the page's own hub
 * session, and deletes both at the end. The root's key is a dummy: nothing is invoked.
 */
import { expect, test, type Page } from '@playwright/test';

const FLASH = 'google/gemini-3.1-flash-lite';
const PRO = 'google/gemini-3.1-pro-preview';
const STAMP = `tiers-e2e-${Date.now()}`;

let rootId = '';
let childId = '';

type Answer = { status: number; body: { data?: Record<string, unknown>; message?: string } };

async function api(page: Page, method: string, path: string, body?: unknown): Promise<Answer> {
  return page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p as string, {
        method: m as string,
        headers: { 'content-type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [method, path, body] as const,
  );
}

/** Open the token plan and wait until the page's hub session answers (it is set up just after load). */
async function ready(page: Page) {
  await page.goto('/dock/hub/token-plan');
  await expect
    .poll(async () => (await api(page, 'GET', '/api/v1/graph/llm_endpoint?expand=permissions')).status, {
      timeout: 30_000,
    })
    .toBe(200);
}

const ep = (id: string, ...rest: string[]) => ['/api/v1/graph/llm_endpoint', id, ...rest].join('/');

async function chainTiers(page: Page, id: string) {
  const chain = await api(page, 'GET', ep(id, 'chain'));
  expect(chain.status, JSON.stringify(chain.body)).toBe(200);
  return chain.body.data?.effective_tiers as Record<string, { model: string | null; set_by: string; reason: string }>;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await ready(page);
  const root = await api(page, 'POST', '/api/v1/graph/llm_endpoint', {
    name: `${STAMP} root`,
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api',
    models: [FLASH, PRO],
    tiers: { sm: FLASH, md: PRO, lg: PRO },
  });
  expect(root.status, JSON.stringify(root.body)).toBe(200);
  rootId = String(root.body.data?.id);
  const key = await api(page, 'POST', ep(rootId, 'credential'), { key: 'sk-or-e2e-dummy' });
  expect(key.status, JSON.stringify(key.body)).toBe(200);
  const child = await api(page, 'POST', ep(rootId, 'allocate'), {
    name: `${STAMP} team`,
    limits: { cost_usd_total: 1 },
  });
  expect(child.status, JSON.stringify(child.body)).toBe(200);
  childId = String(child.body.data?.id);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await ready(page);
  if (childId) await api(page, 'DELETE', ep(childId));
  if (rootId) await api(page, 'DELETE', ep(rootId));
  await page.close();
});

test("the token plan shows each row's sizes: the root's own, and the child's inherited", async ({ page }) => {
  await ready(page);
  const expected = 'sm gemini-3.1-flash-lite · md gemini-3.1-pro-preview · lg gemini-3.1-pro-preview';
  await expect(page.getByTestId(`sizes-${rootId}`)).toHaveText(expected);
  await page.getByTestId(`allocated-count-${rootId}`).click();
  await expect(page.getByTestId(`sizes-${childId}`)).toHaveText(expected);
  // On its own line: the row's other columns keep their place.
  const nameCell = await page.getByTestId(`source-row-${rootId}`).locator('td').first().boundingBox();
  const chip = await page.getByTestId(`sizes-${rootId}`).boundingBox();
  expect(chip && nameCell && chip.x + chip.width <= nameCell.x + nameCell.width + 1).toBe(true);
  await page.screenshot({ path: 'test-results/llm-tiers-token-plan.png', fullPage: true });
});

test('the endpoint page shows who set each size, and editing one changes only that size', async ({ page }) => {
  await page.goto(`/dock/hub/llm-endpoints/${childId}`);
  const sizes = page.getByTestId('model-sizes');
  await expect(sizes.getByTestId('model-size-sm')).toContainText(FLASH);
  await expect(sizes.getByTestId('model-size-sm')).toContainText(`${STAMP} root`);

  await page.getByTestId('llm-detail-edit').click();
  const dialog = page.getByTestId('llm-endpoint-dialog');
  await expect(dialog.getByTestId('tier-sm-inherited')).toHaveText(`Inherits ${FLASH}`);
  await dialog.getByTestId('tier-sm').selectOption(PRO);
  await page.screenshot({ path: 'test-results/llm-tiers-dialog.png' });
  await dialog.getByTestId('llm-submit').click();
  await expect(dialog).toBeHidden();

  const tiers = await chainTiers(page, childId);
  expect(tiers.sm.model).toBe(PRO);
  expect(tiers.sm.set_by).toBe(`llm_endpoint-${childId}`);
  expect(tiers.md.model).toBe(PRO);
  await page.reload();
  await expect(page.getByTestId('model-sizes').getByTestId('model-size-sm')).toContainText(`${STAMP} team`);
  await page.screenshot({ path: 'test-results/llm-tiers-detail.png', fullPage: true });
});

test('a size outside the root catalog is refused, and the refusal names it', async ({ page }) => {
  await ready(page);
  const refused = await api(page, 'PUT', ep(childId), { tiers: { lg: 'openai/gpt-5' } });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain('catalog');
  expect((await chainTiers(page, childId)).lg.model).toBe(PRO);
});

// The LLM preferences (default size, source order) are covered by unit tests: the Preferences screen
// is not reachable from the hub page (its menu entry lands on Home in hub mode).
