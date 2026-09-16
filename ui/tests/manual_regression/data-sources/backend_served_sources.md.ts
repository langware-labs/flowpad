/**
 * The Add-a-data-source dialog, checked against the manifests the backend indexed.
 *
 * The point of every assertion here is that nothing in `ui/` decides what a provider is.
 * So the expected values are FETCHED from `/api/v1/graph/data_source_spec` and compared to
 * what rendered — writing them out as literals would just recreate `provider-catalog.ts`,
 * which this work deleted.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiContext } from '../_shared/api';

const SCREEN = '/dock/data-sources';

/** Ids of everything these tests created, torn down over the API in afterAll. */
const created: string[] = [];

interface SpecField {
  type?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  advanced?: boolean;
}
interface Spec {
  id: string;
  name: string;
  title?: string;
  config?: Record<string, SpecField>;
}

let specs: Spec[] = [];

function specNamed(name: string): Spec {
  const found = specs.find((s) => s.name === name);
  expect(found, `no ${name} spec is installed — the manifest did not index`).toBeTruthy();
  return found as Spec;
}

test.beforeAll(async () => {
  const api = await apiContext();
  const res = await api.get('/api/v1/graph/data_source_spec');
  expect(res.ok(), 'the backend did not serve data_source_spec').toBeTruthy();
  specs = ((await res.json()).data ?? []) as Spec[];
  expect(specs.length, 'no data_source_spec assets indexed').toBeGreaterThan(0);
  await api.dispose();
});

test.afterAll(async () => {
  if (!created.length) return;
  const api = await apiContext();
  for (const id of created) await api.delete(`/api/v1/graph/data_source/${id}`);
  await api.dispose();
});

async function openScreen(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  await page.goto(SCREEN);
  await expect(page.getByTestId('data-sources-view')).toBeVisible();
}

async function openDialog(page: Page, provider: string) {
  await page.getByTestId('add-data-source').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add a data source' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`provider-${provider}`).click();
  return dialog;
}

/** Create one source through the dialog and remember it for teardown. */
async function createSource(
  page: Page,
  provider: string,
  name: string,
  fields: Record<string, string> = {},
) {
  const dialog = await openDialog(page, provider);
  await dialog.locator('#ds-name').fill(name);
  for (const [key, value] of Object.entries(fields)) {
    await dialog.locator(`#ds-${key}`).fill(value);
  }
  const submit = dialog.getByRole('button', { name: 'Add source' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();

  const card = page.locator(`[data-testid="source-card"][data-provider="${provider}"]`).filter({
    hasText: name,
  });
  await expect(card).toBeVisible();

  // Remember the row so afterAll can remove it — matched by the name we just typed,
  // which is unique per run.
  const api = await apiContext();
  const rows = ((await (await api.get('/api/v1/graph/data_source')).json()).data ?? []) as {
    id: string;
    name: string;
  }[];
  const row = rows.find((r) => r.name === name);
  if (row) created.push(row.id);
  await api.dispose();
}

const stamp = () => `${Date.now()}`.slice(-6);

test.describe('Data sources are served by the backend', () => {
  test('the screen renders with an add affordance', async ({ page }) => {
    await openScreen(page);
    await expect(page.getByTestId('add-data-source')).toBeVisible();
  });

  test('every installed spec is offered as a provider', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('add-data-source').click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Add a data source' });
    await expect(dialog).toBeVisible();

    for (const spec of specs) {
      await expect(
        dialog.getByTestId(`provider-${spec.name}`),
        `${spec.name} is installed but the dialog does not offer it`,
      ).toBeVisible();
    }
  });

  test('the rss form is the rss manifest', async ({ page }) => {
    await openScreen(page);
    const dialog = await openDialog(page, 'rss');

    const schema = specNamed('rss').config ?? {};
    expect(Object.keys(schema).length).toBeGreaterThan(0);

    for (const [key, field] of Object.entries(schema)) {
      if (field.advanced) continue;
      const input = dialog.locator(`#ds-${key}`);
      await expect(input, `${key} did not render`).toBeVisible();
      if (field.placeholder) await expect(input).toHaveAttribute('placeholder', field.placeholder);
      if (field.label) {
        await expect(dialog.locator(`label[for="ds-${key}"]`)).toContainText(field.label);
      }
    }
  });

  test('a bad feed url blocks submission', async ({ page }) => {
    await openScreen(page);
    const dialog = await openDialog(page, 'rss');
    await dialog.locator('#ds-name').fill(`rejected-${stamp()}`);
    await dialog.locator('#ds-feed_urls').fill('not-a-url');

    // The manifest's `pattern` is doing this. No RSS-specific validator survives in ui/.
    await expect(dialog.getByRole('button', { name: 'Add source' })).toBeDisabled();
    await expect(dialog).toContainText('not valid');
  });

  test('an rss source can be created', async ({ page }) => {
    await openScreen(page);
    await createSource(page, 'rss', `rss-${stamp()}`, {
      feed_urls: 'https://hnrss.org/frontpage',
    });
  });

  test('hacker news needs nothing but a name', async ({ page }) => {
    await openScreen(page);
    await createSource(page, 'hackernews', `hn-${stamp()}`);
  });

  test('a local folder can be created', async ({ page }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ds-folder-'));
    writeFileSync(path.join(root, 'note.md'), '# hello\n');

    await openScreen(page);
    await createSource(page, 'folder', `folder-${stamp()}`, { root });
  });

  /**
   * Drive is the one source whose credential half cannot be automated — but its
   * UNCREDENTIALED half can, and it is the half that would silently regress:
   * the source must be creatable, land in `setup` rather than `active`, and say
   * what is missing. A driver with a `verify` step that resolved straight to
   * active would start polling against no token and report config errors on a
   * heartbeat forever.
   */
  test('a drive source lands in setup and names the missing credential', async ({ page }) => {
    await openScreen(page);
    const name = `drive-${stamp()}`;
    await createSource(page, 'gdrive', name);

    const card = page.locator('[data-testid="source-card"][data-provider="gdrive"]').filter({
      hasText: name,
    });
    await expect(card).toHaveAttribute('data-status', 'setup');

    await card.locator('[data-testid^="source-verify-"]').click();
    await expect(card).toContainText(/Google/i);
  });

  test('a git repository can be created', async ({ page }) => {
    const repo = mkdtempSync(path.join(tmpdir(), 'ds-git-'));
    writeFileSync(path.join(repo, 'note.md'), '# hello\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '-q');
    git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'add', 'note.md');
    git('-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-qm', 'seed');

    await openScreen(page);
    await createSource(page, 'git', `git-${stamp()}`, { repo });
  });
});
