/**
 * Browser scenario — a cloud deployment's token allocation offers the models its source allows.
 *
 * Precondition (seeded outside): the desktop instance (`TAM_FE_PORT`/`TAM_BE_PORT`) is signed
 * in to a hub; `TAM_AGENT_ID` is an agent it holds, and `TAM_SOURCE_ID` a hub LLM endpoint its
 * user administers that reaches more than one model.
 *
 * The desk holds no row for a hub endpoint, so the list is the hub's own, relayed by the desk
 * (`llm_endpoint/<id>/models`). The picker must show exactly that list, narrow it as the user
 * types, and leave the allocation complete once a model is picked. Nothing is launched.
 */
import { expect, test } from '@playwright/test';

const BE = `http://localhost:${process.env.TAM_BE_PORT || '6004'}`;
const AGENT_ID = process.env.TAM_AGENT_ID?.trim() ?? '';
const SOURCE_ID = process.env.TAM_SOURCE_ID?.trim() ?? '';

const AGENT_PATH = `/dock/assets/editor/agent/typeid/agent-${AGENT_ID}`;
const MODELS_URL = `${BE}/api/v1/graph/llm_endpoint/${SOURCE_ID}/models`;

test.beforeAll(async () => {
  if (!AGENT_ID || !SOURCE_ID) {
    test.skip(true, 'TAM_AGENT_ID and TAM_SOURCE_ID name a seeded agent and an LLM endpoint its user administers');
  }
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `backend not up on ${BE} — launch a disposable instance first`);
  }
  const bootstrap = await (await fetch(`${BE}/api/v1/graph/bootstrap`, { signal: AbortSignal.timeout(20_000) })).json();
  expect(bootstrap?.data?.supported_pages, 'this must be the DESKTOP runtime').toContain('desk');
});

test('the desk relays the hub model list for an endpoint it holds no row for', async () => {
  const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(20_000) });
  expect(response.status, 'the desk answers for a hub endpoint').toBe(200);
  const models: { id: string }[] = (await response.json()).data;
  expect(models.length, 'the seeded source reaches more than one model').toBeGreaterThan(1);
});

test('the model is picked from a searchable list of the models the source offers', async ({ page }) => {
  const relayed = await fetch(MODELS_URL, { signal: AbortSignal.timeout(20_000) });
  expect(relayed.status, 'the desk answers for a hub endpoint').toBe(200);
  const offered = [...new Set(((await relayed.json()).data as { id: string }[]).map((m) => m.id))].sort();

  await page.goto(AGENT_PATH);
  await page.getByRole('button', { name: 'New deployment' }).click();
  const dialog = page.getByTestId('new-deployment-dialog');
  await dialog.getByTestId('new-deployment-type-sm').click();
  await dialog.getByTestId('token-allocation-toggle').click();
  await dialog.getByTestId('token-allocation-source').selectOption(`llm_endpoint-${SOURCE_ID}`);

  // A picker, not a text box: the user cannot be asked to know a model slug by heart.
  const picker = dialog.getByTestId('token-allocation-model');
  await expect(picker).toHaveAttribute('role', 'combobox');
  await picker.click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(offered.length);
  expect(await options.allTextContents()).toEqual(offered);

  // Typing narrows it to the models that contain what was typed.
  const pick = offered[offered.length - 1];
  const needle = pick.slice(pick.indexOf('/') + 1);
  const matching = offered.filter((id) => id.toLowerCase().includes(needle.toLowerCase()));
  await page.getByPlaceholder('Filter models…').fill(needle);
  await expect(options).toHaveCount(matching.length);
  expect(await options.allTextContents()).toEqual(matching);

  // Picking one fills the allocation: Configure, gated on a source AND a model, is offered.
  await page.getByTestId(`token-allocation-model-${pick}`).click();
  await expect(picker).toHaveText(pick);
  await expect(dialog.getByTestId('token-allocation-configure')).toBeEnabled();
});
