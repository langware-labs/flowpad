/**
 * Conversation session lifecycle — launch, open-reuse, no duplication.
 * Source: conversation_view_three_spawn_branches.md
 *
 * Encodes the ACTUALLY-SHIPPED conversation-session lifecycle
 * (`useConversationSession.ts` + `ConversationHeaderSession.tsx`), NOT the dead
 * `useMyProcess`/`task.my_process_id` path (which renders nowhere — reported as
 * a finding). The session is keyed to the CONVERSATION: one AgenticProcess with
 * `process_type === 'conversation'` (ProcessKind.Conversation), linked onto
 * `conversation.shared_context_entities`, workdir/project from
 * `conversation.project_id`.
 *
 * Self-seeding: each test creates its own Conversation (mapped to the bootstrap
 * default_project, whose fs_storage_mount_path is a real workdir) via REST, so
 * the file survives a per-file DB clear and any --repeat-each ordering. Real
 * Claude spawns on launch (allowed on this instance); the entity/linkage/dock
 * assertions do not depend on a successful assistant turn, only on the process
 * ENTITY being created + linked + navigated — so no worker-turn wait is needed.
 *
 * API requests go through apiContext() (QA_API_URL/API_URL override, else the
 * app's own backend via the Vite proxy); never hardcode a port. baseURL for the
 * page comes from VITE_PORT.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { apiContext } from '../_shared/api';
import { dismissSetupModal } from './_ap_helpers';

/** Resolve the bootstrap default project's id + real workdir (mount path). */
async function defaultProject(rq: APIRequestContext): Promise<{ id: string; workdir: string }> {
  const boot = (await (await rq.get('/api/v1/graph/bootstrap')).json()).data;
  const dp = boot.default_project;
  const id = typeof dp === 'string' ? dp : dp?.id;
  expect(id, 'bootstrap default_project id').toBeTruthy();
  const proj = (await (await rq.get(`/api/v1/graph/project/${id}`)).json()).data;
  const workdir = proj?.fs_storage_mount_path;
  expect(workdir, 'default project fs_storage_mount_path (real workdir)').toBeTruthy();
  return { id, workdir };
}

/** Seed a task-less Conversation mapped to the given project. */
async function createConversation(rq: APIRequestContext, projectId: string): Promise<string> {
  const r = await rq.post('/api/v1/graph/conversation', {
    data: { project_id: projectId, title: 'QA Conversation Session' },
  });
  expect(r.status()).toBe(200);
  const conv = (await r.json()).data;
  expect(conv.project_id, 'seeded conversation project_id').toBe(projectId);
  return conv.id;
}

/** Current set of agentic_process ids. */
async function processIds(rq: APIRequestContext): Promise<string[]> {
  const d = (await (await rq.get('/api/v1/graph/agentic_process')).json()).data ?? [];
  return (Array.isArray(d) ? d : []).map((p: { id: string }) => p.id).filter(Boolean);
}

/** GET one agentic_process row. */
async function getProcess(rq: APIRequestContext, id: string) {
  return (await (await rq.get(`/api/v1/graph/agentic_process/${id}`)).json()).data ?? {};
}

/**
 * Terminate a launched session — the `exit` action kills the worker AND frees
 * its PTY (same call as AgenticProcess.stop()). Real Claude launches hold a live
 * PTY; without this, a --repeat-each run accumulates PTYs and the next real spawn
 * can't allocate one on a saturated host. This is test hygiene (free what the
 * test allocated), NOT a timeout/retry workaround. Best-effort.
 */
async function stopSession(rq: APIRequestContext, pid: string) {
  try {
    await rq.post(`/api/v1/graph/agentic_process/${pid}/exit`, { data: {} });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * The conversation's linked conversation-processes: `agentic_process-*` typeids
 * on `shared_context_entities` whose process_type is `conversation`. This is the
 * "one conversation-session per conversation" set the contract bounds to size 1.
 */
async function convProcessIds(rq: APIRequestContext, convId: string): Promise<string[]> {
  const conv = (await (await rq.get(`/api/v1/graph/conversation/${convId}`)).json()).data ?? {};
  const linked: string[] = (conv.shared_context_entities ?? [])
    .filter((s: string) => typeof s === 'string' && s.startsWith('agentic_process-'))
    .map((s: string) => s.slice('agentic_process-'.length));
  const out: string[] = [];
  for (const id of linked) {
    const p = await getProcess(rq, id);
    if (p.process_type === 'conversation') out.push(id);
  }
  return out;
}

const SHELL_URL = /\/dock\/shell\/agentic_process-(?!new)([\w-]+)/;

function pidFromUrl(page: Page): string {
  const m = page.url().match(SHELL_URL);
  if (!m) throw new Error(`No agentic_process id in URL: ${page.url()}`);
  return m[1];
}

/**
 * Open the conversation surface and launch its session via the header worker
 * toolbar's claude_code button. Returns the launched process id (from the shell
 * URL launch navigates to) once the conversation links it. Waits are the
 * category-standard budgets — never raised.
 */
async function launchSession(page: Page, rq: APIRequestContext, convId: string): Promise<string> {
  await page.goto(`/dock/conversation/${convId}`);
  // The header worker toolbar defaults to `lastOpened` mode in Standard view:
  // only the last-used worker shows up front, the rest behind a "Show other
  // workers" chevron. Expand it when claude_code isn't already surfaced so this
  // test always launches claude_code regardless of the persisted last worker.
  const toolbar = page.locator('[data-testid="conversation-launch-toolbar"]');
  await toolbar.waitFor({ state: 'visible', timeout: 30_000 });
  const claudeBtn = toolbar.locator('[data-testid="conversation-launch-claude_code"]');
  if (!(await claudeBtn.isVisible().catch(() => false))) {
    await toolbar.locator('[data-testid="conversation-launch-more"]').click();
  }
  await claudeBtn.click();
  await page.waitForURL(SHELL_URL, { timeout: 60_000 });
  const pid = pidFromUrl(page);
  // Launch links the process onto the conversation AFTER navigating (startSession
  // order), so poll until the linkage lands.
  await expect(async () => {
    expect(await convProcessIds(rq, convId)).toEqual([pid]);
  }).toPass({ timeout: 30_000 });
  return pid;
}

test.beforeEach(async ({ page }) => {
  await dismissSetupModal(page);
});

// Serial: test 2 asserts the reuse of the SAME session test 1 launched (the .md's
// "with test 1's state" — one process per conversation, no dup on second open).
// Chaining is faithful to the contract AND avoids a second real Claude spawn.
// repeat-each re-runs the pair in order, so test 1 always re-seeds fresh state
// for test 2; test 1 failing skips test 2 (serial semantics).
test.describe.serial('conversation session lifecycle', () => {
  let launched: { convId: string; projectId: string; workdir: string; pid: string } | null = null;

  test('launch spawns a visible conversation-process, links it, opens its dock', async ({ page }) => {
    test.setTimeout(60_000);
    const rq = await apiContext();
    try {
      // Defensive: free a leftover session if a prior pair's test 2 didn't run
      // (e.g. test 1 failed under serial), so this launch starts with PTYs free.
      if (launched) {
        await stopSession(rq, launched.pid);
        launched = null;
      }
      const { id: projectId, workdir } = await defaultProject(rq);
      const convId = await createConversation(rq, projectId);
      const baseline = new Set(await processIds(rq));

      const pid = await launchSession(page, rq, convId);

      // Exactly ONE new agentic_process vs the baseline, and it is the launched one.
      const created = (await processIds(rq)).filter((id) => !baseline.has(id));
      expect(created, 'exactly one new agentic_process').toEqual([pid]);

      // It is a visible conversation-process filed under the conversation's project.
      const proc = await getProcess(rq, pid);
      expect(proc.visible).toBe(true);
      expect(proc.process_type).toBe('conversation');
      expect(proc.project_id).toBe(projectId);
      expect(proc.workdir).toBe(workdir);

      // The dock navigated to the process's terminal dockPointer.
      expect(page.url()).toMatch(new RegExp(`/dock/shell/agentic_process-${pid}`));

      // The conversation now links exactly this conversation-process.
      expect(await convProcessIds(rq, convId)).toEqual([pid]);

      launched = { convId, projectId, workdir, pid };
    } finally {
      await rq.dispose();
    }
  });

  test('opening again reuses the existing session — no duplicate', async ({ page }) => {
    test.setTimeout(60_000);
    expect(launched, 'test 1 must have launched a session first').not.toBeNull();
    const { convId, pid } = launched!;
    const rq = await apiContext();
    try {
      // Back on the conversation, the header collapses to the single Open button.
      await page.goto(`/dock/conversation/${convId}`);
      const openBtn = page.locator('[data-testid="conversation-open-session"]');
      await openBtn.waitFor({ state: 'visible', timeout: 30_000 });
      const countBefore = (await processIds(rq)).length;

      // Click Open → same dockPointer, no second process.
      await openBtn.click();
      await page.waitForURL(new RegExp(`/dock/shell/agentic_process-${pid}`), { timeout: 60_000 });
      expect(pidFromUrl(page)).toBe(pid);

      const countAfter = (await processIds(rq)).length;
      expect(countAfter, 'no second process created on reuse').toBe(countBefore);
      expect(await convProcessIds(rq, convId), 'still exactly the one conversation-session').toEqual([pid]);
    } finally {
      // Free this pair's PTY before the next --repeat-each pair launches.
      await stopSession(rq, pid);
      launched = null;
      await rq.dispose();
    }
  });
});
