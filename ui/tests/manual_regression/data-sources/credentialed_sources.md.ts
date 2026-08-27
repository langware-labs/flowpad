/**
 * The four sources that need a credential — the MACHINE-CHECKABLE half.
 *
 * The sibling `.md` is deliberate about its scope: each of these sources needs
 * "a secret a test cannot mint" (a Slack workspace, a logged-in worker CLI, an
 * AgentMail key, a Google OAuth client), so the credentialed ROUND-TRIPS —
 * verify/poll/records — stay manual and are recorded per its "Recording a run"
 * section. What CAN be proven without any secret is everything the spec's own
 * step 1s assert about the manifests and the Add form, and that is exactly what
 * this file covers:
 *   - the provider grid serves all four credentialed manifests (the spec's
 *     precondition: "if slack or agent is missing … nothing below is meaningful"),
 *   - slack: the form asks for channel ids and does NOT ask for an account key
 *     ("the workspace belongs to the connection, not the form"), and a value
 *     that is not a channel id is rejected by the manifest's pattern before the
 *     button enables,
 *   - agent: the `connector` field exists (it is what names the channel),
 *   - agentmail: the key never appears in the form — the `inbox` field is
 *     account-bound (`account_key: true`) and the secret lives on the connection.
 */
import { expect, test, type Page } from '@playwright/test';
import { apiOrigin } from '../_shared/api';

interface SpecField {
  type?: string;
  kind?: string;
  label?: string;
  required?: boolean;
  pattern?: string;
}
interface Spec {
  id: string;
  name: string;
  config_schema?: Record<string, SpecField>;
}

let specs: Spec[] = [];
const specNamed = (name: string): Spec => {
  const found = specs.find((s) => s.name === name);
  expect(found, `no ${name} spec is installed — the manifest did not index`).toBeTruthy();
  return found as Spec;
};

test.beforeAll(async ({ request }) => {
  const res = await request.get(`${apiOrigin()}/api/v1/graph/data_source_spec`);
  expect(res.ok(), 'the backend did not serve data_source_spec').toBeTruthy();
  specs = (((await res.json()) as { data?: Spec[] }).data ?? []);
});

async function openProvider(page: Page, provider: string) {
  await page.goto('/dock/data-sources');
  await expect(page.getByTestId('data-sources-view')).toBeVisible();
  await page.getByTestId('add-data-source').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add a data source' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`provider-${provider}`).click();
  return dialog;
}

test('the four credentialed manifests are indexed and offered', async () => {
  for (const name of ['slack', 'agent', 'agentmail', 'cloud_email']) specNamed(name);
});

test('slack: channel ids only — no account key in the form; a non-channel-id fails closed', async ({ page }) => {
  const schema = specNamed('slack').config_schema ?? {};
  const keys = Object.keys(schema);
  const channelKey = keys.find((k) => /channel/i.test(k));
  expect(channelKey, `slack schema has a channel-ids field (got: ${keys.join()})`).toBeTruthy();
  expect(
    keys.find((k) => /token|key|secret|account/i.test(k)),
    'the account credential is deliberately NOT a form field — it belongs to the connection',
  ).toBeFalsy();

  const dialog = await openProvider(page, 'slack');
  await dialog.locator('#ds-name').fill('e2etest-slack-gate');
  await dialog.locator(`#ds-${channelKey}`).fill('definitely-not-a-channel-id');
  await expect(
    dialog.getByRole('button', { name: 'Add source' }),
    "the manifest's pattern must reject a non-channel-id before the button enables",
  ).toBeDisabled();
});

test('agent: the connector field is what names the channel', async ({ page }) => {
  const schema = specNamed('agent').config_schema ?? {};
  expect(Object.keys(schema)).toContain('connector');
  const dialog = await openProvider(page, 'agent');
  await expect(dialog.locator('#ds-connector')).toBeVisible();
});

test('agentmail: the API key never appears in the form — the inbox is account-bound', async ({ page }) => {
  // The manifest moved the key OUT of the form (same contract as slack): the
  // `inbox` field carries `account_key: true` and the secret lives on the
  // connection. A key-shaped plaintext field reappearing here is the regression.
  const schema = specNamed('agentmail').config_schema as Record<string, { account_key?: boolean }>;
  const accountField = Object.entries(schema).find(([, f]) => f.account_key)?.[0];
  expect(accountField, 'agentmail schema binds a field to the account connection').toBeTruthy();
  expect(
    Object.keys(schema).find((k) => /api.?key|token|secret/i.test(k)),
    'no plaintext API-key field in the form',
  ).toBeFalsy();
  const dialog = await openProvider(page, 'agentmail');
  await expect(dialog.locator(`#ds-${accountField}`)).toBeVisible();
});
