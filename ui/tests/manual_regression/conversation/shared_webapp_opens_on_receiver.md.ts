/**
 * A shared webapp opens on the receiver — source: shared_webapp_opens_on_receiver.md.
 * Two instances on one hub; skips unless both are named.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const SENDER_URL = process.env.SENDER_URL || '';
const SENDER_API = process.env.SENDER_API || '';
const RECEIVER_URL = process.env.RECEIVER_URL || '';
const RECEIVER_EMAIL = process.env.RECEIVER_EMAIL || '';

test('Alice installs the webapp Bob shared and Open shows it', async ({ browser, request }) => {
  test.skip(
    !SENDER_URL || !SENDER_API || !RECEIVER_URL || !RECEIVER_EMAIL,
    'two-instance: set SENDER_URL, SENDER_API, RECEIVER_URL and RECEIVER_EMAIL',
  );
  const name = `shop-${Date.now()}`;

  // Seed: one webapp in Bob's first project.
  const projects = (await (await request.get(`${SENDER_API}/api/v1/graph/project`)).json()).data as Array<{
    fs_storage_mount_path: string;
  }>;
  const folder = join(projects[0].fs_storage_mount_path, 'agentic-assets', 'webapp', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'webapp.json'), JSON.stringify({ name, title: name, build: '.' }));
  writeFileSync(join(folder, 'index.html'), `<h1>${name}</h1>`);
  const path = encodeURIComponent(folder);
  expect(
    (await request.post(`${SENDER_API}/api/v1/graph/compute_node/%40local/fs-records/index?type=micro_app&path=${path}`)).ok(),
  ).toBe(true);
  const appId: string = (await (await request.get(`${SENDER_API}/api/v1/assets/entity?path=${path}`)).json()).data.id;

  // Bob shares it with Alice.
  const bob = await (await browser.newContext()).newPage();
  await bob.goto(`${SENDER_URL}/dock/app/micro_app-${appId}`);
  await bob.getByTestId('entity-actions-share').click();
  const skip = bob.getByTestId('share-skip-link');
  await expect(skip.or(bob.getByTestId('share-contact-picker'))).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await bob.getByTestId('share-contact-picker').fill(RECEIVER_EMAIL);
  await bob.getByTestId('share-contact-picker').press('Enter');
  await bob.getByTestId('share-submit').click();
  await expect(bob.getByText('Shared', { exact: true })).toBeVisible();

  // Alice opens the message, installs the app, presses Open.
  const alice = await (await browser.newContext()).newPage();
  await alice.goto(`${RECEIVER_URL}/dock/stream_inbox`);
  await alice.getByTestId('stream-inbox-row-subject-line').filter({ hasText: name }).click();
  await alice.getByTestId(`entity-chip-micro_app-${appId}`).click();
  await alice.getByTestId('asset-install-project').click();
  await alice.getByTestId('asset-open-entity').click();

  // The app's own page (its Definition tab) — the dead end shows "Missing asset" instead.
  const page = alice.getByText('Definition', { exact: true }).first();
  await expect(page.or(alice.getByText('Missing asset'))).toBeVisible();
  await expect(alice.getByText('Missing asset')).toHaveCount(0);
  await expect(page).toBeVisible();
});
