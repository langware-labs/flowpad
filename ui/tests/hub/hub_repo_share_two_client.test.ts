/**
 * Sharing through the project's hub-hosted repository, end to end, alice ↔ bob.
 *
 *   alice's desk (a project folder that is NOT a git repo)
 *     ── publish ──▶ pushes the skill into the project's repo ON THE HUB
 *                    (the hub is the only git remote; with GIT_REPO_DEFAULT_PROVIDER=github_app
 *                     that repo is a real private repo on github.com)
 *   bob (a member, no GitHub) ── reads the document on the hub, installs it on his desk
 *   alice edits on the hub ── her next publish pulls the edit back into her folder
 *   both edit ── the publish refuses with asset_conflict and neither side is overwritten
 *
 * Requires a local hub and two launched instances:
 *   scripts/instance_ctl.sh launch <alice> --hub $FLOWPAD_HUB_URL && … <bob>
 *   SHARE_INST_1=<alice> SHARE_INST_2=<bob> ALICE_EMAIL/ALICE_PW BOB_EMAIL/BOB_PW
 * Skips otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable, hubLogin, HUB_URL } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as ALICE,
  HUB_INST_2 as BOB,
  WORKTREE_ROOT,
  instanceAvailable,
  jsonApi,
  postApi,
  resolveLaunchedInstance,
  type LaunchedInstance,
} from './_instances';

let skipReason: string | null = null;
let alice: LaunchedInstance;
let bob: LaunchedInstance;
let aliceToken = '';
let bobToken = '';
let projectId = '';
let skillId = '';
let root = '';
let bobRoot = '';
const skillName = `hubrepo-${Math.random().toString(36).slice(2, 8)}`;
const typeid = () => `skill-${skillId}`;
const localSkill = () => path.join(root, '.claude', 'skills', skillName, 'SKILL.md');

async function hub(token: string, p: string, body?: unknown, method?: string): Promise<Response> {
  return fetch(`${HUB_URL}/api/v1${p}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function hubDoc(token: string): Promise<string> {
  const r = await hub(token, `/graph/skill/${skillId}/fs/download/SKILL.md`);
  expect(r.status, 'document readable on the hub').toBe(200);
  return r.text();
}

async function hubWrite(token: string, content: string): Promise<void> {
  const r = await hub(token, `/graph/skill/${skillId}/fs/write/SKILL.md`, { content });
  expect(r.status, await r.clone().text()).toBe(200);
}

async function publish(): Promise<void> {
  const r = await postApi(alice.apiUrl, `/graph/skill/${skillId}/set-published`, { published: true, project_id: projectId });
  expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('SUCCESS');
}

async function hubBody(): Promise<{ status?: string; code?: string | null } | undefined> {
  const view = await jsonApi(alice.apiUrl, `/graph/project/${projectId}/published`);
  return view.data?.rows?.find((r: { typeid: string }) => r.typeid === typeid())?.hub_body;
}

function gitViaHub(token: string, args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    },
  });
}

beforeAll(async () => {
  const h = await hubAvailable();
  if (!h.ok) return void (skipReason = h.reason ?? 'hub unreachable');
  if (!instanceAvailable(ALICE) || !instanceAvailable(BOB)) {
    return void (skipReason = `launch ${ALICE || 'SHARE_INST_1'} + ${BOB || 'SHARE_INST_2'} via scripts/instance_ctl.sh`);
  }
  alice = resolveLaunchedInstance(ALICE)!;
  bob = resolveLaunchedInstance(BOB)!;
  aliceToken = (await hubLogin(alice.email, process.env.ALICE_PW || '')).token;
  bobToken = (await hubLogin(bob.email, process.env.BOB_PW || '')).token;

  const ws = path.join(homedir(), 'Flowpad workspace');
  root = path.join(ws, `hubrepo-share-${skillName}`);
  bobRoot = path.join(ws, `hubrepo-install-${skillName}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(bobRoot, { recursive: true });
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) {
    console.warn(`[hub_repo_share] skipped: ${skipReason}`);
    context.skip();
  }
});

afterAll(async () => {
  try {
    if (aliceToken && projectId) await hub(aliceToken, `/graph/project/${projectId}`, undefined, 'DELETE').catch(() => undefined);
    if (alice && projectId) await jsonApi(alice.apiUrl, `/graph/project/${projectId}`, 'DELETE').catch(() => undefined);
  } finally {
    for (const p of [root, bobRoot]) if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe('sharing through the project hub repo', () => {
  it('alice links a git-less project and publishes; the skill lands in the hub repo at its real path', async () => {
    expect(existsSync(path.join(root, '.git'))).toBe(false);
    const created = await postApi(alice.apiUrl, '/graph/project', { type: 'project', name: path.basename(root), fs_storage_mount_path: root });
    projectId = created.data.id;
    const linked = await postApi(alice.apiUrl, `/graph/project/${projectId}/share`, {});
    expect(linked.status, JSON.stringify(linked).slice(0, 300)).toBe('SUCCESS');

    const skill = await postApi(alice.apiUrl, `/graph/project/${projectId}/skill`, { type: 'skill', name: skillName });
    skillId = skill.data.id;
    await publish();
    await pollUntil(async () => ((await hubBody())?.status === 'published' ? true : null), 60_000, 'hub body published');

    const repo = (await (await hub(aliceToken, `/graph/project/${projectId}/hosted_repo`)).json()).data;
    expect(repo.clone_url).toContain(`/git_repo/`);
    const clone = mkdtempSync(path.join(tmpdir(), 'hubrepo-clone-'));
    gitViaHub(aliceToken, ['clone', '-q', repo.clone_url, clone]);
    expect(gitViaHub(aliceToken, ['ls-files'], clone).split('\n')).toContain(`.claude/skills/${skillName}/SKILL.md`);
    rmSync(clone, { recursive: true, force: true });
  }, 120_000);

  it('bob, a reader without GitHub, reads the document on the hub and installs it', async () => {
    const link = await (await hub(aliceToken, `/graph/project/${projectId}/members/link`, {
      invitation_targets: [{ typeid: `project-${projectId}`, role: 'reader' }],
    })).json();
    const token = String(link.data.url).split('/').pop();
    expect((await (await hub(bobToken, '/graph/members/redeem', { token })).json()).status).toMatch(/success/i);

    expect(await hubDoc(bobToken)).toContain(`id: ${skillId}`);

    const env = { ...process.env, FLOW_INSTANCE: BOB, FLOWPAD_HUB_URL: HUB_URL };
    delete (env as Record<string, string | undefined>).LOCAL_SERVER_PORT;
    const out = execFileSync('uv', ['run', '--project', WORKTREE_ROOT, 'flow', 'asset', 'install', typeid()], { cwd: bobRoot, env, encoding: 'utf8' });
    const result = JSON.parse(out.trim().split('\n').pop() as string);
    expect(result.ok, out.slice(-400)).toBe(true);
    expect(result.installed.origin.kind).toBe('hub_repo');
    const installed = path.join(bobRoot, '.claude', 'skills', skillName, 'SKILL.md');
    expect(readFileSync(installed, 'utf8')).toContain(`id: ${skillId}`);
  }, 180_000);

  it("alice's edit on the hub is pulled back into her folder by her next publish", async () => {
    await hubWrite(aliceToken, `${(await hubDoc(aliceToken)).trimEnd()}\n\nEdited on the hub.\n`);
    await publish();
    await pollUntil(() => (readFileSync(localSkill(), 'utf8').includes('Edited on the hub.') ? true : null), 60_000, 'hub edit pulled back');
  }, 90_000);

  it('edits on both sides refuse with asset_conflict and overwrite nothing', async () => {
    await hubWrite(aliceToken, `${(await hubDoc(aliceToken)).trimEnd()}\nHub side.\n`);
    writeFileSync(localSkill(), `${readFileSync(localSkill(), 'utf8').trimEnd()}\nDesk side.\n`);
    await publish();
    await pollUntil(async () => ((await hubBody())?.code === 'asset_conflict' ? true : null), 60_000, 'asset_conflict reported');
    const onHub = await hubDoc(aliceToken);
    expect(onHub).toContain('Hub side.');
    expect(onHub).not.toContain('Desk side.');
    expect(readFileSync(localSkill(), 'utf8')).toContain('Desk side.');
  }, 90_000);
});
