/**
 * Asset seeding for the assets category.
 *
 * The asset tree (/dock/assets/list/<type>) lists indexed records; after a
 * desktop-db/clear there are ZERO agents/skills (the indexer only runs on an
 * explicit user click, by design), so every popover scenario dies at setup
 * waiting for a level-2 tree row. Seed via the scoped create — the project
 * scope is what materializes the asset under the project mount (an unscoped
 * create lands under $HOME and may not surface in the tree).
 */
import { expect, type Page } from '@playwright/test';

async function defaultProjectId(page: Page): Promise<string> {
  const boot = await page.request.get('/api/v1/graph/bootstrap');
  expect(boot.status()).toBe(200);
  const dp = (await boot.json()).data.default_project;
  return typeof dp === 'string' ? dp : dp.id;
}

async function ensureAsset(page: Page, type: 'agent' | 'skill', name: string): Promise<void> {
  const list = await page.request.get(`/api/v1/graph/${type}`);
  expect(list.status()).toBe(200);
  const rows: Array<{ name?: string }> = (await list.json()).data ?? [];
  if (rows.length > 0) return;

  const projectId = await defaultProjectId(page);
  const res = await page.request.post(`/api/v1/graph/project/${projectId}/${type}`, {
    data: { name },
  });
  expect(res.status(), `seed ${type} "${name}"`).toBe(200);

  // The asset tree lists INDEXED records and indexing is explicit-only (no
  // auto-index on create). Without this the created asset never surfaces as a
  // tree row. Index the just-created type under its project scope.
  const idx = await page.request.post(
    `/api/v1/graph/compute_node/@local/fs-records/index?type=${type}&projects=${projectId}&user=false&force=true`,
  );
  expect(idx.status(), `index ${type} after seed`).toBe(200);
}

/** Guarantee at least one agent (tree target) and one skill (attach candidate). */
export async function ensureAgentAndSkill(page: Page): Promise<void> {
  await ensureAsset(page, 'agent', 'qa-seed-agent');
  await ensureAsset(page, 'skill', 'qa-seed-skill');
}
