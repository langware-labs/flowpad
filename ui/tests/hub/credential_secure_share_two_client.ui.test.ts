/**
 * Secured transfer — the person's journey in the real UI, two instances, the real hub (the approved mock,
 * `mock-secure-send`): Alice opens a credential → Share → "Share values" (Secured transfer) → Share secrets →
 * picks Bob → Share; Bob opens the conversation → the card → Fill in; Bob's credential holds the value and Alice's
 * card reads "Filled in". Screenshots of each step go to FLOWPAD_SHOTS (default: a temp folder).
 *
 * Same launch recipe as credential_secure_share_two_client.test.ts (SHARE_INST_1/2 and the ALICE_ / BOB_ credentials).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { driveShareDialog, launchBrowser, openConversation, openInstancePage, type InstancePage } from './_browser';
import { getAliceCreds, getBobCreds, hubAvailable, syncAssignedConversationAt } from './_hub';
import { pollUntil } from './_matrix';
import { HUB_INST_1 as INST_1, HUB_INST_2 as INST_2, instanceAvailable, jsonApi, postApi } from './_instances';

const SECRET = `sk-ui-${Math.random().toString(36).slice(2)}-SUPERSECRET`;
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const CRED = `acme-gmail-ui-${RUN.toLowerCase()}`;
const CREDS = '/graph/compute_node/@local/credentials';
const SHOTS = process.env.FLOWPAD_SHOTS || path.join(os.tmpdir(), `secure-share-ui-${Date.now()}`);

let skipReason: string | null = null;
let browser: Browser;
let alice: InstancePage;
let bob: InstancePage;
let credId = '';
let bobProject: any;

const shot = async (inst: InstancePage, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  await inst.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

async function ok(p: Promise<any>, what: string) {
  const body = await p;
  if (!/success/i.test(String(body?.status))) throw new Error(`${what}: ${JSON.stringify(body)}`);
  return body.data;
}

async function firstProject(apiUrl: string, name: string) {
  const rows: any[] = (await jsonApi(apiUrl, '/graph/project')).data ?? [];
  return rows.find((p) => p.fs_storage_mount_path?.includes(`/instances/${name}/`)) ?? rows[0];
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) return void (skipReason = `launch ${INST_1} + ${INST_2}`);
  if (!(await getAliceCreds()) || !(await getBobCreds())) return void (skipReason = 'set ALICE_*/BOB_* env');
  browser = await launchBrowser();
  alice = await openInstancePage(browser, INST_1);
  bob = await openInstancePage(browser, INST_2);
  for (const inst of [alice, bob]) await ok(postApi(inst.apiUrl, `${CREDS}/sealed/publish`, {}), `publish ${inst.name}`);

  const manifest = { name: CRED, title: 'Acme Gmail (UI)', setup: 'manual', vars: { [`UI${RUN}_ADDRESS`]: {}, [`UI${RUN}_PASSWORD`]: {} } };
  const aliceProject = await firstProject(alice.apiUrl, INST_1);
  bobProject = await firstProject(bob.apiUrl, INST_2);
  const saved = await ok(postApi(alice.apiUrl, `${CREDS}/save`, {
    scope: 'project', project_id: aliceProject.id, manifest,
    values: { [`UI${RUN}_ADDRESS`]: 'ui@acme.test', [`UI${RUN}_PASSWORD`]: SECRET },
  }), 'alice declares');
  credId = String(saved.typeid).replace(/^credential-/, '');
  await ok(postApi(bob.apiUrl, `${CREDS}/save`, { scope: 'project', project_id: bobProject.id, manifest }), 'bob declares');
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

describe('secured transfer — the journey in the UI', () => {
  it('Alice shares values securely; Bob fills them in with one click', async () => {
    // ── Alice: the credential's page → Share ──
    await alice.page.goto(`${alice.feUrl}/dock/assets/credential-${credId}`, { waitUntil: 'domcontentloaded' });
    await alice.page.getByTestId('entity-actions-share').first().click();
    const step = alice.page.getByTestId('share-preshare-step');
    await step.waitFor({ timeout: 20_000 });
    await shot(alice, '01-share-description-only');

    // "Share values" → Secured transfer (the default) → Share secrets
    await alice.page.getByTestId('share-values-checkbox').click();
    expect(await alice.page.getByTestId('share-values-route-note').textContent()).toMatch(/only they can open them/);
    await shot(alice, '02-share-values-secured');
    await alice.page.getByTestId('share-preshare-continue').click();

    // The standard recipient step, with the secured line; pick Bob, new conversation, Share.
    await alice.page.getByTestId('share-secured-line').waitFor({ timeout: 20_000 }).catch(() => undefined);
    await driveShareDialog(alice.page, { recipientEmail: process.env.BOB_EMAIL!.trim() });
    const outcome = alice.page.getByTestId('share-sealed-outcome');
    await outcome.waitFor({ timeout: 30_000 });
    await shot(alice, '03-shared-values-sealed');
    expect(await outcome.textContent()).toMatch(/sealed for 1/);

    // The conversation the share created (Alice's newest).
    const convs: any[] = (await jsonApi(alice.apiUrl, '/graph/conversation')).data ?? [];
    const conv = convs.sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)))[0];
    expect(conv?.id).toBeTruthy();

    // ── Bob: the conversation → the card → Fill in ──
    await syncAssignedConversationAt(`${bob.apiUrl}/api/v1`, conv.id, INST_2);
    await openConversation(bob, conv.id);
    const card = bob.page.getByTestId('sealed-card').first();
    await card.waitFor({ timeout: 30_000 });
    expect(await card.getAttribute('data-state')).toBe('pending');
    expect(await card.textContent()).not.toContain(SECRET);
    await shot(bob, '04-bob-card');
    await bob.page.getByTestId('sealed-fill').first().click();
    await pollUntil(async () => ((await card.getAttribute('data-state')) === 'filled' ? true : null), 20_000, 'Bob filled');
    await shot(bob, '05-bob-filled');

    const envFile = path.join(bobProject.fs_storage_mount_path, '.env.local');
    expect(existsSync(envFile) && readFileSync(envFile, 'utf-8')).toContain(SECRET);

    // ── Alice: the card turns "Filled in" ──
    await openConversation(alice, conv.id);
    const sent = alice.page.getByTestId('sealed-sent').first();
    await pollUntil(async () => {
      await alice.page.reload({ waitUntil: 'domcontentloaded' });
      await sent.waitFor({ timeout: 10_000 }).catch(() => undefined);
      return /Filled in by 1/.test((await sent.textContent().catch(() => '')) ?? '') ? true : null;
    }, 30_000, 'Alice sees Filled in');
    await shot(alice, '06-alice-filled-in');
  }, 180_000);
});
