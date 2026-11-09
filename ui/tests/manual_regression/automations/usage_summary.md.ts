/**
 * The Daily usage summary, walked in a browser: a standard automation Flowpad ships OFF, whose result is a
 * message in its own conversation on the Automations channel (the Diagnosis pattern).
 *
 *   1. Automations → "Daily usage summary" is Flowpad's own, off, and its switch is enabled;
 *   2. Run once now → the run succeeds;
 *   3. Stream inbox → its conversation (Automations chip) holds the headline, Ask about this / Open automation,
 *      the report chip and `usage.summary.value.json`; the file opens in the usage viewer;
 *   4. Open automation lands back on the rule; a second run lands in the SAME conversation;
 *   5. the switch turns on and off and the backend agrees.
 *
 *   scripts/instance_ctl.sh launch usage-7
 *   cd ui && FLOW_INSTANCE=usage-7 VITE_PORT=5007 npx playwright test --config tests/manual_regression/automations/playwright.config.ts usage_summary
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiContext } from '../_shared/api';
import { dismissSetupModal } from '../triggers/helpers';

const NAME = 'Daily usage summary';
let api: APIRequestContext;

async function graph<T>(method: 'get' | 'post', route: string, data?: unknown): Promise<T> {
  const res = await api[method](`/api/v1${route}`, data === undefined ? undefined : { data });
  const json = await res.json();
  expect(res.ok() && json.status === 'SUCCESS', `${method} ${route}: ${JSON.stringify(json).slice(0, 300)}`).toBeTruthy();
  return json.data as T;
}

interface Summary { id: string; name: string; enabled: boolean; switchable?: boolean }
const rule = async () => (await graph<Summary[]>('post', '/graph/trigger/overview', {})).find((a) => a.name === NAME)!;
const messages = async () => {
  const convs = await graph<Array<{ id: string; channel?: string; title?: string; message_count?: number }>>('get', '/graph/conversation');
  return convs.filter((c) => c.channel === 'automations' && c.title === NAME);
};
/** Messages the automation has posted so far (0 before its conversation exists). */
const posted = async () => (await messages())[0]?.message_count ?? 0;

test.beforeAll(async () => {
  api = await apiContext();
});

test('the Daily usage summary answers in its conversation', async ({ page }) => {
  await dismissSetupModal(page);
  const r = await rule();
  expect(r.switchable, 'Flowpad ships it off and lets the person turn it on').toBe(true);

  await page.goto(`/dock/automations?trigger=${r.id}`);
  const toggle = page.getByTestId('automation-page-toggle');
  await expect(toggle).toBeEnabled();
  const before = await posted();
  await page.getByTestId('test-run-once').click();
  await expect(page.getByTestId('test-run-started')).toBeVisible();

  await expect.poll(posted, { timeout: 60_000 }).toBe(before + 1);
  expect((await messages()).length).toBe(1);
  const [conv] = await messages();
  await page.goto(`/dock/conversation/${conv.id}`);
  await expect(page.getByTestId('automation-message-actions').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('usage.summary.value.json').last()).toBeVisible();

  await page.getByText('usage.summary.value.json').last().click();
  await expect(page.getByTestId('usage-report-viewer')).toBeVisible({ timeout: 30_000 });
  await page.goBack();

  await page.getByTestId('automation-open').last().click();
  await expect(page).toHaveURL(new RegExp(`trigger=${r.id}`));

  await page.getByTestId('test-run-once').click();
  await expect.poll(posted, { timeout: 60_000 }).toBe(before + 2);
  expect((await messages()).length, 'a second run lands in the SAME conversation').toBe(1);

  await toggle.click();
  await expect.poll(async () => (await rule()).enabled).toBe(!r.enabled);
  await toggle.click();
  await expect.poll(async () => (await rule()).enabled).toBe(r.enabled);
});
