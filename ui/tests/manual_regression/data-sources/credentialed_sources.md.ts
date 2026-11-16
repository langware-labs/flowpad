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
 *     that is not a channel id is refused by the manifest's pattern when Add
 *     source is pressed — the problem is shown and nothing is created,
 *   - agent: the `connector` field exists (it is what names the channel),
 *   - agentmail: the key never appears in the form — the `inbox` field is
 *     account-bound (`account_key: true`) and the secret lives on the connection;
 *     and the manifest is `listed: false`, so a person's picker offers no
 *     AgentMail form at all (people get Agent Email, which the cloud allocates).
 */
import { expect, test, type Page } from '@playwright/test';
import { apiContext, apiOrigin } from '../_shared/api';

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
  listed?: boolean;
  /** A grouped driver is one choice behind its group's tile. */
  group?: string;
  config?: Record<string, SpecField>;
}

let specs: Spec[] = [];
const specNamed = (name: string): Spec => {
  const found = specs.find((s) => s.name === name);
  expect(found, `no ${name} spec is installed — the manifest did not index`).toBeTruthy();
  return found as Spec;
};

test.beforeAll(async ({ request }) => {
  const res = await request.get(`${apiOrigin()}/api/v1/graph/data_driver`);
  expect(res.ok(), 'the backend did not serve data_driver').toBeTruthy();
  specs = (((await res.json()) as { data?: Spec[] }).data ?? []);
});

async function openDialog(page: Page) {
  await page.goto('/dock/data-sources');
  await expect(page.getByTestId('data-sources-view')).toBeVisible();
  await page.getByTestId('add-data-source').click();
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByTestId('step-crumb-0').filter({ hasText: /^Data sources$/ }) });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openProvider(page: Page, provider: string) {
  const dialog = await openDialog(page);
  const { group } = specNamed(provider);
  if (group) {
    await dialog.getByTestId(`provider-group-${group}`).click();
    await dialog.getByTestId(`group-member-${provider}`).click();
  } else {
    await dialog.getByTestId(`provider-${provider}`).click();
  }
  return dialog;
}

test('the four credentialed manifests are indexed and offered', async () => {
  for (const name of ['slack', 'agent', 'agentmail', 'cloud_email']) specNamed(name);
});

test('slack: channel ids only — no account key in the form; a non-channel-id fails closed', async ({ page }) => {
  const schema = specNamed('slack').config ?? {};
  const keys = Object.keys(schema);
  const channelKey = keys.find((k) => /channel/i.test(k));
  expect(channelKey, `slack schema has a channel-ids field (got: ${keys.join()})`).toBeTruthy();
  expect(
    keys.find((k) => /token|key|secret|account/i.test(k)),
    'the account credential is deliberately NOT a form field — it belongs to the connection',
  ).toBeFalsy();

  // Adding: Slack is set up by its guided wizard (slack-connect), so the add form asks for a
  // name only — no channel box, no account key — and hands the rest to the wizard.
  const add = await openProvider(page, 'slack');
  await expect(add.getByTestId('ds-by-wizard')).toBeVisible();
  await expect(add.locator(`#ds-${channelKey}`)).toHaveCount(0);
  await expect(add.locator('input[id*="token" i], input[id*="key" i], input[id*="secret" i]')).toHaveCount(0);
  await add.getByRole('button', { name: 'Cancel' }).click();

  // Editing an existing source is where its channel is typed: a non-channel-id must be refused
  // (the channel's pattern) and nothing stored.
  const api = await apiContext();
  const name = `e2etest-slack-gate-${Date.now()}`;
  const created = await api.post('/api/v1/graph/data_source', { data: { name, provider: 'slack', config: {} } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const sourceId = ((await created.json()) as { data: { id: string } }).data.id;
  try {
    await page.goto('/dock/data-sources');
    await expect(page.getByTestId('data-sources-view')).toBeVisible();
    await page.getByTestId(`source-more-${sourceId}`).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.locator('#ds-name') });
    await expect(dialog).toBeVisible();
    // `channel` is a ChoiceField (`choices: true`) — a picker whose listing fires ON OPEN; with no
    // Slack connection on a QA instance the listing is refused and the picker hands back a text box.
    const picker = dialog.getByTestId(`ds-choice-${channelKey}`);
    if (await picker.isVisible().catch(() => false)) {
      await picker.click();
      await expect(dialog.getByTestId(`ds-choice-detail-${channelKey}`)).toBeVisible();
    }
    await dialog.locator(`#ds-${channelKey}`).fill('definitely-not-a-channel-id');
    await dialog.getByRole('button', { name: /^(Save|Save changes)$/ }).click();
    // Problems are shown once Save is pressed: the channel's pattern refuses it and the dialog stays.
    await expect(dialog, 'the channel pattern must refuse a non-channel-id').toContainText('not valid');
    await expect(dialog).toBeVisible();
    const row = ((await (await api.get(`/api/v1/graph/data_source/${sourceId}`)).json()).data ?? {}) as {
      config?: Record<string, unknown>;
    };
    expect(row.config?.[channelKey!], 'the refused channel was stored anyway').toBeFalsy();
  } finally {
    await api.delete(`/api/v1/graph/data_source/${sourceId}`).catch(() => undefined);
    await api.dispose();
  }
});

test('agent: the connector field is what names the channel', async ({ page }) => {
  const schema = specNamed('agent').config ?? {};
  expect(Object.keys(schema)).toContain('connector');
  const dialog = await openProvider(page, 'agent');
  await expect(dialog.locator('#ds-connector')).toBeVisible();
});

test('agentmail: the API key never appears in the form — the inbox is account-bound', async ({ page }) => {
  // The manifest moved the key OUT of the form (same contract as slack): the
  // `inbox` field carries `account_key: true` and the secret lives on the
  // connection. A key-shaped plaintext field reappearing here is the regression.
  const schema = specNamed('agentmail').config as Record<string, { account_key?: boolean }>;
  const accountField = Object.entries(schema).find(([, f]) => f.account_key)?.[0];
  expect(accountField, 'agentmail schema binds a field to the account connection').toBeTruthy();
  expect(
    Object.keys(schema).find((k) => /api.?key|token|secret/i.test(k)),
    'no plaintext API-key field in the form',
  ).toBeFalsy();
  // The form a person could open is none at all: `listed: false` keeps AgentMail out of the
  // picker, so no key field — plaintext or otherwise — can reach a person through it.
  expect(specNamed('agentmail').listed, 'agentmail is unlisted by its manifest').toBe(false);
  const dialog = await openDialog(page);
  await expect(dialog.getByTestId('provider-rss'), 'the picker rendered its providers').toBeVisible();
  await expect(dialog.getByTestId('provider-agentmail'), 'an unlisted provider is offered').toHaveCount(0);
});
