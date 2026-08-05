/**
 * `tagit share` end to end, against a REAL GitHub repo and a REAL hub.
 *
 * This is the only test that proves the whole chain, and it exists because
 * nothing cheaper can. A `file://` origin cannot stand in: `AssetGitWorktree`
 * hard-requires an `https://github.com/...` origin (assets/git_worktree.py),
 * so the asset-publish leg is unreachable without a real repo. And the hub
 * serves the document's bytes by cloning from GitHub server-side with the
 * *viewer's* token, so "the reviewer can read it" is only true if a real clone
 * really happens.
 *
 * It therefore does NOT stub. `q_git_share_cloud_edit.spec.ts` intercepts the
 * share call and fulfils a fake response — that is a fine UI-contract test and
 * a useless cloud test. Anything mocked here would defeat the point.
 *
 * ── What a human must provision once ──
 *   1. A throwaway GitHub repo, e.g. https://github.com/<you>/flowpad-tagit-e2e.git
 *      Seed it with one commit on `main`. No user/pass/port/query in the URL —
 *      `publish` rejects those.
 *   2. A PAT with contents:read+write on that repo. Verify with a manual
 *      `git push` once; a scope problem otherwise surfaces as two different
 *      confusing failures (PUSH_REJECTED here, a clone 403 on the hub).
 *
 * ── Bring-up ──
 *   cd ../test_flowpad/FlowPad && uv run python flowpad/run.py      # hub :8093
 *   scripts/instance_ctl.sh launch tagit-1                          # FE 500X / BE 600X
 *   cd ui && npx vite --mode hubtest --port 4096 --strictPort       # hub UI
 *
 * The `--port 4096 --strictPort` is not cosmetic: `.env.hubtest.local` uses
 * 4098 and so does `helpers.ts`'s ALICE_UI_URL default. A silent collision
 * would have this asserting against the desktop runtime and passing for the
 * wrong reason — which is why step 6 verifies `supported_pages` rather than
 * trusting the port.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.env.TAGIT_E2E_REPO ?? '';
const TOKEN = process.env.TAGIT_E2E_GITHUB_TOKEN ?? '';
const BACKEND = process.env.TAGIT_E2E_BACKEND_URL ?? '';
const UI = process.env.TAGIT_E2E_UI_URL ?? '';
const HUB_UI = process.env.TAGIT_E2E_HUB_UI_URL ?? '';
const HUB = process.env.FLOWPAD_HUB_URL ?? 'http://localhost:8093';
const HUB_EMAIL = process.env.TAGIT_E2E_HUB_EMAIL ?? '';
const HUB_PASSWORD = process.env.TAGIT_E2E_HUB_PASSWORD ?? '';

const CONFIGURED = Boolean(REPO && TOKEN && BACKEND && UI && HUB_UI && HUB_EMAIL && HUB_PASSWORD);

/** Per-run marker. Only a real server-side clone can put this on screen. */
const RUN_ID = `e2e-${Date.now()}`;
const BRANCH = `tagit-e2e/${RUN_ID}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test.describe('tagit share → a reviewer opens the rules doc on the hub', () => {
  test.skip(!CONFIGURED, 'needs a real GitHub repo + token — see this file’s header for the runbook');
  // Real git over the network plus a server-side hub clone. The suite default
  // (10s) is tuned for sub-second realtime assertions, not for this.
  test.setTimeout(180_000);

  let clone = '';
  let projectId = '';
  let markdownId = '';
  let hubKey = '';

  test.beforeAll(async ({ request }) => {
    // Preconditions. Deliberately NOT helpers.assertPreconditions(), which
    // demands both alice and bob backends; this scenario is one instance.
    for (const url of [`${HUB}/api/v1/health/status`, `${BACKEND}/api/v1/health/status`]) {
      expect((await request.get(url)).ok(), `not up: ${url}`).toBe(true);
    }
    const cloud = await (await request.get(`${BACKEND}/api/v1/cloud/status`)).json();
    expect(cloud?.data?.logged_in, 'instance is not cloud-logged-in').toBe(true);

    clone = mkdtempSync(path.join(tmpdir(), 'tagit-e2e-'));
    git(clone, 'clone', REPO, '.');
    expect(git(clone, 'remote', 'get-url', 'origin'), 'refusing to touch an unexpected repo').toBe(REPO);
    git(clone, 'config', 'user.email', 'tagit-e2e@example.com');
    git(clone, 'config', 'user.name', 'tagit e2e');
    git(clone, 'checkout', '-b', BRANCH);

    // A crashed earlier run leaves its branch behind; sweep anything stale so
    // this is self-healing rather than slowly accumulating.
    for (const line of git(clone, 'ls-remote', '--heads', 'origin', 'tagit-e2e/*').split('\n')) {
      const ref = line.split('\t')[1]?.replace('refs/heads/', '');
      const stamp = Number(ref?.split('-')[1]);
      if (ref && ref !== BRANCH && stamp && Date.now() - stamp > 24 * 3600 * 1000) {
        try { git(clone, 'push', 'origin', '--delete', ref); } catch { /* already gone */ }
      }
    }

    // Seed the GitHub token on BOTH sides. The instance needs it to satisfy the
    // backend gate and to push; the hub needs it because it clones as the viewer.
    const localUser = (await (await request.get(`${BACKEND}/api/v1/graph/bootstrap?domain=localhost`)).json())
      ?.data?.user?.id;
    expect(localUser, 'bootstrap returned no user').toBeTruthy();
    await request.post(`${BACKEND}/api/v1/graph/user/${localUser}/env-var`, {
      data: { name: 'github_credentials', var_type: 'oauth_token', value: TOKEN },
    });

    const login = await (await request.post(`${HUB}/api/v1/login`, {
      data: { email: HUB_EMAIL, password: HUB_PASSWORD },
    })).json();
    hubKey = login?.data?.api_key ?? login?.api_key ?? '';
    expect(hubKey, 'hub login returned no api key').toBeTruthy();
    const hubUser = login?.data?.user?.id ?? login?.user?.id;
    await request.post(`${HUB}/api/v1/graph/user/${hubUser}/env-var`, {
      headers: { Authorization: `Bearer ${hubKey}` },
      data: { name: 'GITHUB_OAUTH_USER_TOKEN', var_type: 'oauth_token', value: TOKEN },
    });
  });

  test.afterAll(async ({ request }) => {
    const attempt = async (fn: () => unknown) => {
      try { await fn(); } catch { /* teardown is best-effort, every step runs */ }
    };
    if (markdownId) {
      await attempt(() => request.delete(`${BACKEND}/api/v1/graph/markdown/${markdownId}`));
      await attempt(() => request.delete(`${HUB}/api/v1/graph/markdown/${markdownId}`,
        { headers: { Authorization: `Bearer ${hubKey}` } }));
    }
    if (projectId) {
      await attempt(() => request.delete(`${BACKEND}/api/v1/graph/project/${projectId}`));
      await attempt(() => request.delete(`${HUB}/api/v1/graph/project/${projectId}`,
        { headers: { Authorization: `Bearer ${hubKey}` } }));
    }
    // Never touch `main`.
    if (clone) {
      await attempt(() => git(clone, 'push', 'origin', '--delete', BRANCH));
      await attempt(() => rmSync(clone, { recursive: true, force: true }));
    }
    // The seeded env-vars stay: they are idempotent, and deleting them makes
    // the next run fail confusingly.
  });

  test('the whole chain, unstubbed', async ({ browser, request }) => {
    // ── the project, rooted at the real clone ──
    const created = await (await request.post(`${BACKEND}/api/v1/graph/project`, {
      data: { type: 'project', name: `tagit-e2e-${RUN_ID}`, fs_storage_mount_path: clone },
    })).json();
    projectId = created?.data?.id;
    expect(projectId).toBeTruthy();

    // ── the breadcrumb: a rules doc plus a capsule'd test, committed together ──
    mkdirSync(path.join(clone, 'docs', 'breadcrumbs'), { recursive: true });
    const docRel = `docs/breadcrumbs/${RUN_ID}.md`;
    writeFileSync(
      path.join(clone, docRel),
      `---\ntitle: ${RUN_ID}\n---\n# ${RUN_ID}\n\n${RUN_ID} marker body\n`,
      'utf8',
    );
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', `seed ${RUN_ID}`);
    git(clone, 'push', '-u', 'origin', BRANCH);

    const indexed = await (await request.post(
      `${BACKEND}/api/v1/graph/compute_node/@local/fs-records/index`,
      { params: { path: path.join(clone, docRel), type: 'markdown' } },
    )).json();
    markdownId = (indexed?.data?.typeids ?? []).find((t: string) => t.startsWith('markdown-'))?.split('-').slice(1).join('-');
    expect(markdownId, 'the rules doc did not index').toBeTruthy();

    // ── the preflight must be green before the UI can link ──
    const pre = await (await request.get(
      `${BACKEND}/api/v1/graph/project/${projectId}/git_share_preflight`)).json();
    expect(pre?.data?.available, `preflight: ${pre?.data?.reason}`).toBe(true);

    // ── link the project THROUGH THE UI ──
    const desktop = await browser.newContext({ baseURL: UI });
    // The Publish control mounts only when the resolved project IS the active
    // one (ProjectHome reads dataContext.project). A prior QA run of exactly
    // this scenario reported "zero Publish controls" for want of this line.
    await desktop.addInitScript(
      ([pid]) => {
        localStorage.setItem('llm-setup-modal-seen', 'true');
        localStorage.setItem('flowpad-state', JSON.stringify({ CurrentProjectTypeId: `project-${pid}` }));
      },
      [projectId],
    );
    const page: Page = await desktop.newPage();
    await page.goto(`/dock/assets/project-home?scope-mode=project&scope-activeProjectId=${projectId}`);

    const link = page.locator('[data-testid="project-publish"]');
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute('data-state', 'local');
    await link.click();
    await expect(link).toHaveAttribute('data-state', 'published', { timeout: 60_000 });

    // ── the three canonical markers must survive a reload ──
    const local = await (await request.get(`${BACKEND}/api/v1/graph/project/${projectId}`)).json();
    expect(local?.data?.remote).toBe(true);
    // Regression pin: this was null once because share_action skipped the save.
    expect(local?.data?.hub_published_at).toBeTruthy();
    expect(local?.data?.git_origin).toBeTruthy();

    const onHub = await request.get(`${HUB}/api/v1/graph/project/${projectId}`, {
      headers: { Authorization: `Bearer ${hubKey}` },
    });
    expect(onHub.ok(), 'the project never reached the hub').toBe(true);

    // ── share the doc: commits the two paths, pushes, registers with the hub ──
    const shared = await (await request.post(`${BACKEND}/api/v1/assets/share`, {
      data: { path: path.join(clone, docRel), with_paths: [], dry_run: false },
    })).json();
    expect(shared?.status, JSON.stringify(shared)).toBe('SUCCESS');
    expect(shared?.data?.url).toContain(`/dock/hub/project/${projectId}/editor/markdown/typeid/markdown-${markdownId}`);

    const hubAsset = await request.get(`${HUB}/api/v1/graph/markdown/${markdownId}`, {
      headers: { Authorization: `Bearer ${hubKey}` },
    });
    expect(hubAsset.ok()).toBe(true);
    const assetRow = (await hubAsset.json())?.data ?? {};
    expect(assetRow.git_origin, 'the hub row carries no git coordinates').toBeTruthy();
    // Metadata and coordinates only — the bytes stay in git.
    for (const byteField of ['body', 'content', 'text']) expect(assetRow[byteField]).toBeUndefined();

    // ── the payoff: a reviewer opens the link and sees the document ──
    const hubCtx = await browser.newContext({ baseURL: HUB_UI });
    await hubCtx.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
    const hubPage = await hubCtx.newPage();
    await hubPage.goto('/dock/hub/home');
    // Verify the RUNTIME, not the port — 4098 collides with the desktop UI.
    const pages = await hubPage.evaluate(async () => {
      const r = await fetch('/api/v1/graph/bootstrap');
      return (await r.json())?.data?.supported_pages;
    });
    expect(pages, 'not the hub runtime — check --port/--strictPort').toEqual(['hub']);

    await hubPage.goto(`/dock/hub/project/${projectId}/editor/markdown/typeid/markdown-${markdownId}`);
    // Only a real server-side clone from GitHub can put this on screen.
    await expect(hubPage.locator('.ProseMirror')).toContainText(RUN_ID, { timeout: 60_000 });

    await hubCtx.close();
    await desktop.close();
  });
});
