/**
 * Inviting to a Project is a MEMBERSHIP grant, not a publish.
 *
 *   admin  — brand-new project; the first Invite shows the publish popup INSTEAD
 *            of the invite pane, and only publishing unlocks inviting.
 *   admin  → invites editor: one `share` call on the published project, which the
 *            backend runs as a plain membership grant (no publish step) that
 *            also opens a new conversation between them holding the invite message.
 *   editor — opens that conversation and installs from the message's
 *            Install project chip (no popup offers it), then dirties its checkout.
 *   editor → invites member: no publish popup and no publish gate, even though
 *            that gate would refuse this dirty tree.
 *   member — installs from their own invite conversation: a brand-new clone of
 *            what was PUBLISHED, none of the editor's uncommitted changes.
 *
 * Needs three instances with SEPARATE homes — see playwright.config.ts. The
 * clone target is `<home>/Flowpad workspace`; with a shared home the editor's
 * and member's clones land in one folder and the assertions below are
 * meaningless, so the suite refuses to run in that setup.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

interface User {
  name: string;
  email: string;
  fe: string;
  be: string;
  workspace: string;
}

interface ProjectRow {
  id: string;
  remote?: boolean;
  fs_storage_mount_path?: string | null;
}

const RUN = `invite-e2e-${Date.now()}`;

function repoRoot(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'scripts', 'instance_ctl.sh'))) return dir;
    if (dirname(dir) === dir) throw new Error('run from inside the flowpad checkout');
  }
}

/** A running instance, from the env file `instance_ctl.sh launch` wrote. */
function instance(name: string): User {
  const file = join(repoRoot(), `.env.${name}.local`);
  if (!existsSync(file)) throw new Error(`${file} missing — launch '${name}' first (see playwright.config.ts)`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const home =
    process.env[`INVITE_HOME_${name.replace(/-/g, '_').toUpperCase()}`] ?? join(homedir(), `flowpad-${name}-home`);
  return {
    name,
    email: env.FLOWPAD_CLOUD_USER_EMAIL,
    fe: `http://localhost:${env.VITE_PORT}`,
    be: `http://localhost:${env.LOCAL_SERVER_PORT}`,
    workspace: join(home, 'Flowpad workspace'),
  };
}

const admin = instance(process.env.INVITE_ADMIN ?? 'admin-7');
const editor = instance(process.env.INVITE_EDITOR ?? 'editor-5');
const member = instance(process.env.INVITE_MEMBER ?? 'member-6');

async function graph<T = Record<string, unknown>>(u: User, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${u.be}/api/v1/graph/${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${u.name} ${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: T }).data;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const isUnder = (child: string, parent: string) =>
  resolve(child)
    .toLowerCase()
    .startsWith(resolve(parent).toLowerCase() + sep);
const lf = (s: string) => s.replace(/\r\n/g, '\n');

async function openAs(browser: Browser, u: User): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: u.fe });
  await context.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  return { context, page: await context.newPage() };
}

/** Every non-GET `share` / `members` call this page makes on the project, in order. */
function trackProjectCalls(page: Page, projectId: string): string[] {
  const calls: string[] = [];
  const re = new RegExp(`/graph/project/${projectId}/(share|members)(?:[/?]|$)`);
  page.on('request', (r) => {
    const m = re.exec(r.url());
    if (m && r.method() !== 'GET') calls.push(`${r.method()} ${m[1]}`);
  });
  return calls;
}

async function gotoProjectHome(page: Page, projectId: string) {
  await page.goto(`/dock/assets/project-home?scope-mode=project&scope-activeProjectId=${projectId}`);
  await expect(page.getByTestId('members-invite-button')).toBeVisible();
}

/**
 * Invite through the members popover; the pane must open (no publish popup).
 * Returns the invite conversation the hub opened between the inviter and the invitee.
 */
async function invite(page: Page, projectId: string, email: string, role: string): Promise<string> {
  await page.getByTestId('members-invite-button').click();
  await expect(page.getByTestId('members-invite-form')).toBeVisible();
  await expect(page.getByTestId('publish-project-dialog')).toBeHidden();
  await page.getByTestId('members-invite-input').fill(email);
  await page.getByTestId('members-invite-role').selectOption(role);
  await page.getByTestId('members-invite-add').click();
  const posted = page.waitForResponse(
    (r) => r.url().includes(`/graph/project/${projectId}/share`) && r.request().method() === 'POST',
  );
  await page.getByTestId('members-invite-submit').click();
  const response = await posted;
  expect(response.ok(), `invite ${email} as ${role}`).toBe(true);
  // A project invite carries `notify_by_message`: the share answers with each
  // person's outcome, the new conversation included.
  const body = (await response.json()) as {
    data?: { share_result?: { invited?: { conversation_id?: string | null }[]; skipped?: unknown[] } };
  };
  const shareResult = body.data?.share_result;
  expect(shareResult?.skipped ?? [], `invite ${email} was skipped`).toEqual([]);
  const conversationId = shareResult?.invited?.[0]?.conversation_id ?? '';
  expect(conversationId, `invite ${email} opened no conversation: ${JSON.stringify(body)}`).not.toBe('');
  return conversationId;
}

/** Open the invite conversation on `u`'s own instance, URL-first. */
async function openInviteConversation(page: Page, u: User, conversationId: string) {
  // The grant pushes the conversation row; the sync pulls its messages (the
  // same step `syncAssignedConversationAt` takes in the hub tests).
  await expect
    .poll(
      async () =>
        (
          await fetch(`${u.be}/api/v1/graph/conversation-message-sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversationId }),
          }).catch(() => null)
        )?.ok ?? false,
      { timeout: 60_000, message: `${u.name} never received the invite conversation` },
    )
    .toBe(true);
  await page.goto(`/dock/conversation/${conversationId}?viewMode=advanced`);
}

/**
 * Install from the invite message's chip. Returns the clone path.
 *
 * The dashed chip opens the review popup, whose project branch offers Install
 * project; nothing pops up on its own. Once installed, the chip is the installed one.
 */
async function installShared(page: Page, u: User, projectId: string, conversationId: string): Promise<string> {
  await expect
    .poll(async () => (await graph<ProjectRow>(u, `project/${projectId}`).catch(() => null))?.remote ?? false, {
      timeout: 60_000,
      message: `${u.name} never received the project row`,
    })
    .toBe(true);
  await openInviteConversation(page, u, conversationId);
  const chip = page.getByTestId('project-chip');
  await expect(chip).toContainText(RUN, { timeout: 60_000 });
  await expect(page.getByTestId('incoming-project-dialog')).toHaveCount(0);
  // The dashed chip opens the review popup; its project branch offers Install project.
  await chip.getByRole('button').click();
  await page.getByTestId('asset-review-dialog').getByTestId('project-install-button').click();
  await expect
    .poll(async () => (await graph<ProjectRow>(u, `project/${projectId}`)).fs_storage_mount_path ?? '', {
      timeout: 120_000,
      message: `${u.name} never finished installing`,
    })
    .not.toBe('');
  // Installing lands in the project; back in the conversation the chip is the installed one.
  await openInviteConversation(page, u, conversationId);
  await expect(page.getByTestId('project-chip')).toHaveAttribute('data-state', 'installed', { timeout: 30_000 });
  return String((await graph<ProjectRow>(u, `project/${projectId}`)).fs_storage_mount_path);
}

test.describe('project invite = membership, not publish', () => {
  const originRoot = join(homedir(), 'flowpad-invite-e2e', RUN);
  const adminDir = join(admin.workspace, RUN);
  let projectId = '';
  let publishedSha = '';
  const clones: string[] = [];

  test.beforeAll(async () => {
    // The pitfall this suite exists around: one shared workspace means one clone folder.
    const workspaces = [admin, editor, member].map((u) => u.workspace);
    expect(new Set(workspaces.map((w) => w.toLowerCase())).size, 'each instance needs its own home').toBe(3);
    for (const u of [admin, editor, member]) {
      const bootstrap = await (await fetch(`${u.be}/api/v1/graph/bootstrap`)).text();
      expect(bootstrap, `${u.name} is not running on its own home (${u.workspace})`).toContain(
        dirname(u.workspace).split(sep).pop(),
      );
    }

    // A brand-new repository behind a file:// origin: no GitHub involved.
    const bare = join(originRoot, `${RUN}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, 'init', '--bare', '-q', '-b', 'main');
    mkdirSync(adminDir, { recursive: true });
    git(adminDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(adminDir, 'README.md'), `# ${RUN}\n\npublished content\n`);
    git(adminDir, 'add', '-A');
    git(adminDir, '-c', 'user.name=admin', '-c', `user.email=${admin.email}`, 'commit', '-qm', 'initial');
    git(adminDir, 'remote', 'add', 'origin', pathToFileURL(bare).href);
    git(adminDir, 'push', '-q', '-u', 'origin', 'main');

    const project = await graph<ProjectRow>(admin, 'project', {
      method: 'POST',
      body: JSON.stringify({ type: 'project', name: RUN, fs_storage_mount_path: adminDir.replace(/\\/g, '/') }),
    });
    projectId = String(project.id);

    // Activating the project (what opening it in the UI does) indexes it, and the
    // indexer stamps an `id:` into README.md's frontmatter — a dirty tree.
    // Committing that is the publish gate's "Commit & continue", which is not what
    // this suite is about, so land it here: publishing is then one click.
    await graph(admin, `project/${projectId}/activate`, { method: 'POST', body: '{}' });
    await expect
      .poll(() => lf(readFileSync(join(adminDir, 'README.md'), 'utf8')).startsWith('---\nid:'), {
        message: 'the indexer never stamped README.md',
      })
      .toBe(true);
    git(adminDir, 'add', '-A');
    git(adminDir, '-c', 'user.name=admin', '-c', `user.email=${admin.email}`, 'commit', '-qm', 'flowpad ids');
    git(adminDir, 'push', '-q');
    const preflight = await graph<{ available: boolean }>(admin, `project/${projectId}/git_share_preflight`);
    expect(preflight, 'admin checkout clean and pushed before publishing').toMatchObject({ available: true });
  });

  test.afterAll(async () => {
    if (projectId) {
      for (const u of [member, editor, admin]) {
        await graph(u, `project/${projectId}`, { method: 'DELETE' }).catch(() => undefined);
      }
    }
    for (const dir of [...clones, adminDir, originRoot]) rmSync(dir, { recursive: true, force: true });
  });

  test('first invite publishes; invitees install from the invite message; the member clones what was published', async ({
    browser,
  }) => {
    // ── admin: the first Invite asks to publish INSTEAD of opening the pane ──
    const a = await openAs(browser, admin);
    const adminCalls = trackProjectCalls(a.page, projectId);
    // A file:// origin needs no GitHub (backend), but "Link to cloud" still asks for it.
    await a.page.route('**/oauth/github/status**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'SUCCESS', message: 'success', data: { has_token: true } }),
      }),
    );
    await gotoProjectHome(a.page, projectId);
    await a.page.getByTestId('members-invite-button').click();
    const publishDialog = a.page.getByTestId('publish-project-dialog');
    await expect(publishDialog).toBeVisible();
    await expect(a.page.getByTestId('members-invite-form')).toBeHidden();

    await publishDialog.getByTestId('project-publish').click();
    await expect(publishDialog).toBeHidden({ timeout: 60_000 }); // closes itself once published
    expect((await graph<ProjectRow>(admin, `project/${projectId}`)).remote).toBe(true);
    publishedSha = git(adminDir, 'rev-parse', 'HEAD');
    expect(git(adminDir, 'rev-parse', 'origin/main')).toBe(publishedSha);
    const publishedReadme = lf(readFileSync(join(adminDir, 'README.md'), 'utf8'));
    expect(adminCalls).toEqual(['POST share']);

    // ── admin → editor: now a plain membership grant ──
    const editorConversation = await invite(a.page, projectId, editor.email, 'editor');
    expect(adminCalls).toEqual(['POST share', 'POST share']);

    // ── editor: install from the invite message, then make the checkout dirty ──
    const e = await openAs(browser, editor);
    const editorClone = await installShared(e.page, editor, projectId, editorConversation);
    clones.push(editorClone);
    expect(isUnder(editorClone, editor.workspace), `editor clone ${editorClone}`).toBe(true);
    // Edit the body, keep the frontmatter — a header-less README is re-stamped by the indexer.
    const editorReadme = `${lf(readFileSync(join(editorClone, 'README.md'), 'utf8'))}\neditor local edit\n`;
    writeFileSync(join(editorClone, 'README.md'), editorReadme);
    writeFileSync(join(editorClone, 'editor-scratch.txt'), 'never pushed\n');
    expect(git(editorClone, 'status', '--porcelain')).not.toBe('');
    // The publish gate WOULD refuse this tree — which is why inviting must not run it.
    const preflight = await graph<{ available: boolean }>(editor, `project/${projectId}/git_share_preflight`);
    expect(preflight.available).toBe(false);

    // ── editor → member: no publish popup, no publish gate — the one share call invites ──
    const editorCalls = trackProjectCalls(e.page, projectId);
    await gotoProjectHome(e.page, projectId);
    const memberConversation = await invite(e.page, projectId, member.email, 'member');
    expect(editorCalls).toEqual(['POST share']);
    // Every invite opens a conversation of its own (R8).
    expect(memberConversation).not.toBe(editorConversation);

    // ── member: a brand-new clone of what was published, installed from their own message ──
    const m = await openAs(browser, member);
    const memberClone = await installShared(m.page, member, projectId, memberConversation);
    clones.push(memberClone);
    expect(isUnder(memberClone, member.workspace), `member clone ${memberClone}`).toBe(true);
    expect(samePath(memberClone, editorClone)).toBe(false);
    expect(lf(readFileSync(join(memberClone, 'README.md'), 'utf8'))).toBe(publishedReadme);
    expect(existsSync(join(memberClone, 'editor-scratch.txt'))).toBe(false);
    expect(git(memberClone, 'status', '--porcelain')).toBe('');
    expect(git(memberClone, 'rev-parse', 'HEAD')).toBe(publishedSha);
    // …and the member's install did not touch the editor's working tree.
    expect(lf(readFileSync(join(editorClone, 'README.md'), 'utf8'))).toBe(editorReadme);

    for (const ctx of [a.context, e.context, m.context]) await ctx.close();
  });
});
