/**
 * Browser scenario — a standard user funds an agent's deployment from a SUB-endpoint of their own allowance,
 * running the `lg` size, entirely through the hub page:
 *   hub home → Deployments → the deployment's page → Funding → Change allocation (my allowance, lg) → Save,
 * then the list, the deployment page and the token plan all show who pays and which model `lg` is.
 *
 * Seeded through the page's own session (the state a user arrives with): an org root whose sizes are
 * Gemini, an allowance carved from it, and an agent set to `lg` with a deployment planned on its owner's
 * default. Deleted at the end. Nothing is launched; the root's key is a dummy.
 */
import { expect, test, type Page } from '@playwright/test';

const FLASH = 'google/gemini-3.1-flash-lite';
const PRO = 'google/gemini-3.1-pro-preview';
const STAMP = `funding-e2e-${Date.now()}`;

const ids = { root: '', allowance: '', agent: '', deployment: '' };

type Answer = { status: number; body: { data?: Record<string, unknown> } };

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

async function ready(page: Page, path = '/dock/hub/home') {
  await page.goto(path);
  await expect
    .poll(async () => (await api(page, 'GET', '/api/v1/graph/llm_endpoint?expand=permissions')).status, {
      timeout: 30_000,
    })
    .toBe(200);
}

function ok(answer: Answer): Record<string, unknown> {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 400)).toBe(200);
  return answer.body.data as Record<string, unknown>;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await ready(page);
  const root = ok(
    await api(page, 'POST', '/api/v1/graph/llm_endpoint', {
      name: `${STAMP} org`,
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api',
      models: [FLASH, PRO],
      tiers: { sm: FLASH, md: PRO, lg: PRO },
    }),
  );
  ids.root = String(root.id);
  ok(await api(page, 'POST', `/api/v1/graph/llm_endpoint/${ids.root}/credential`, { key: 'sk-or-e2e-dummy' }));
  const allowance = ok(
    await api(page, 'POST', `/api/v1/graph/llm_endpoint/${ids.root}/allocate`, {
      name: `${STAMP} my allowance`,
      limits: { cost_usd_per_day: 50 },
    }),
  );
  ids.allowance = String(allowance.id);
  const agent = ok(
    await api(page, 'POST', '/api/v1/graph/agent', {
      name: `${STAMP} procurement`,
      worker_type: 'claude',
      model: 'lg',
    }),
  );
  ids.agent = String(agent.id);
  const planned = ok(
    await api(page, 'POST', `/api/v1/graph/agent/${ids.agent}/plan_deployment`, {
      provider: 'e2b',
      environment: 'production',
    }),
  );
  ids.deployment = String((planned.deployment as Record<string, unknown>).id);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await ready(page);
  if (ids.deployment) await api(page, 'DELETE', `/api/v1/graph/deployment/${ids.deployment}`);
  if (ids.agent) await api(page, 'DELETE', `/api/v1/graph/agent/${ids.agent}`);
  if (ids.allowance) await api(page, 'DELETE', `/api/v1/graph/llm_endpoint/${ids.allowance}`);
  if (ids.root) await api(page, 'DELETE', `/api/v1/graph/llm_endpoint/${ids.root}`);
  await page.close();
});

test('a user moves a deployment onto an lg sub-budget of their own allowance, from the hub page', async ({ page }) => {
  // Hub home → Deployments: the deployment and who pays for it.
  await ready(page);
  await page.getByTestId('hub-tab-hub-deployments').click();
  // Seen on its card (the default view) and in the list view.
  await expect(page.getByTestId(`funded-by-${ids.deployment}`)).toContainText('owner default');
  await page.getByTestId('hub-items-view-list').click();
  const row = page.getByTestId('hub-items-row').filter({ hasText: `${STAMP} procurement` });
  await expect(row).toBeVisible();
  await expect(row.getByTestId(`funded-by-${ids.deployment}`)).toContainText('owner default');
  await page.screenshot({ path: 'test-results/funding-1-hub-deployments.png', fullPage: true });

  // Its page: the funding card, then Change allocation → my allowance, lg, $5/day → Save.
  await row.click();
  await page.waitForURL(/\/child\/deployment\//);
  await page.waitForLoadState('networkidle');
  const card = page.getByTestId('deployment-funding');
  await expect(card).toBeVisible();
  // On its owner's default, which declares no lg model: red, and the user was told.
  await expect(card.getByTestId('deployment-funding-problem')).toContainText("'lg'");
  await card.getByTestId('deployment-change-allocation').click();
  const editor = page.getByTestId('deployment-allocation-editor');
  await editor.getByTestId('token-allocation-toggle').click();
  await editor.getByTestId('token-allocation-source').selectOption(`llm_endpoint-${ids.allowance}`);
  await editor.getByTestId('token-allocation-model').click();
  await expect(page.getByTestId('token-allocation-size-lg')).toContainText(PRO);
  await page.getByTestId('token-allocation-size-lg').click();
  await page.screenshot({ path: 'test-results/funding-2-allocation.png' });
  await editor.getByTestId('deployment-allocation-save').click();

  await expect(card.getByTestId('deployment-funding-source')).toContainText('tokens');
  await expect(card.getByTestId('deployment-funding-model')).toHaveText(`lg → ${PRO}`);
  await expect(card.getByTestId('deployment-funding-problem')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/funding-3-deployment-page.png', fullPage: true });

  // The hub's own answer agrees: a sub-endpoint of my allowance, lg resolved to Pro.
  const funding = ok(await api(page, 'GET', `/api/v1/graph/deployment/${ids.deployment}/funding`));
  expect(funding.kind).toBe('allocation');
  expect([funding.size, funding.model, funding.exhausted]).toEqual(['lg', PRO, '']);
  const chain = ok(
    await api(
      page,
      'GET',
      `/api/v1/${String(funding.endpoint_typeid).replace('llm_endpoint-', 'graph/llm_endpoint/')}/chain`,
    ),
  );
  expect((chain.paths as string[][])[0]).toContain(`llm_endpoint-${ids.allowance}`);

  // Token plan: the sub-endpoint sits under my allowance, running lg on Pro.
  await page.goto('/dock/hub/token-plan');
  await page.getByTestId(`allocated-count-${ids.root}`).click();
  await page.getByTestId(`allocated-count-${ids.allowance}`).click();
  const sub = String(funding.endpoint_typeid).replace('llm_endpoint-', '');
  await expect(page.getByTestId(`sizes-${sub}`)).toContainText('lg gemini-3.1-pro-preview');
  await page.screenshot({ path: 'test-results/funding-4-token-plan.png', fullPage: true });
});
