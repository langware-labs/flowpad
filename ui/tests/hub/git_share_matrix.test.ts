/**
 * Git share over the REAL hub, between two REAL instances (Alice → Bob).
 *
 * The asset lives in a git repo whose remote both machines reach (a bare
 * `file://` repo on this host). Alice shares it in GIT mode: the `.flowmsg`
 * carries a pointer (remote + commit + path), never the bytes; the hub carries
 * the message. The share comes into Bob's OWN checkout of the repo:
 *   - nothing is written until Bob says yes to the plan (a cherry-pick of the
 *     asset's commits onto his branch, or a pull on the shared branch);
 *   - then the shared version is in his project folder — even after Alice
 *     pushed more — his branch and his uncommitted edits are kept, and no
 *     `.shared` copy exists;
 *   - the asset is on his live data layer AND findable by free-text search.
 * Plus the sender's one-click fix (commit just this file), the receiver's
 * "N newer commits → update", and a shared credential landing in Bob's project
 * setup.
 *
 * Per-step timings are written to $GIT_SHARE_HUB_REPORT (JSON) when set.
 *
 *   scripts/instance_ctl.sh launch gshare-1 && scripts/instance_ctl.sh launch gshare-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 SHARE_INST_1=gshare-1 SHARE_INST_2=gshare-2 \
 *      npx vitest run --project hub git_share_matrix)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { trackForCleanup, testEntityName } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
const tmpDirs: string[] = [];
const created: Array<{ apiUrl: string; path: string }> = [];
const report: Array<{ case: string; steps: Record<string, number>; total_ms: number }> = [];

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000); // do not increase timeout without approval

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(async () => {
  for (const c of created) await fetch(`${c.apiUrl}/api/v1${c.path}`, { method: 'DELETE' }).catch(() => undefined);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  const out = process.env.GIT_SHARE_HUB_REPORT;
  if (out && report.length) writeFileSync(out, JSON.stringify({ cases: report }, null, 2));
});

// ---------------------------------------------------------------- helpers ---

const api = (apiUrl: string, method: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
const post = (apiUrl: string, p: string, body?: unknown) => api(apiUrl, 'POST', p, body);
const get = (apiUrl: string, p: string) => api(apiUrl, 'GET', p);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

class Timer {
  steps: Record<string, number> = {};
  private t0 = performance.now();
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const s = performance.now();
    try {
      return await fn();
    } finally {
      this.steps[name] = Math.round(performance.now() - s);
    }
  }
  done(name: string) {
    report.push({ case: name, steps: this.steps, total_ms: Math.round(performance.now() - this.t0) });
  }
}

/** A shared asset family: where it sits in the repo and what its file says. */
interface Family {
  type: string;
  rel: string; // the asset's own path in the repo
  main: string; // main file under rel ('' when rel is the file)
  body: (id: string, token: string) => string;
}

const FAMILIES: Family[] = [
  {
    type: 'skill',
    rel: 'tools/kit/.claude/skills/kit',
    main: 'SKILL.md',
    body: (id, tok) => `---\nid: ${id}\nname: kit-${id.slice(0, 6)}\ndescription: kit\n---\n\n# kit\n\n${tok}\n`,
  },
  {
    type: 'markdown',
    rel: 'product/docs/shared.md',
    main: '',
    body: (id, tok) => `---\nid: ${id}\ntitle: Shared ${id.slice(0, 6)}\n---\n\n# Shared\n\n${tok}\n`,
  },
  {
    type: 'subagent',
    rel: '.claude/agents/reviewer.md',
    main: '',
    body: (id, tok) => `---\nid: ${id}\nname: reviewer-${id.slice(0, 6)}\ndescription: reviews\n---\n\n${tok}\n`,
  },
  {
    type: 'chart',
    rel: 'docs/network/net',
    main: 'CHART.md',
    body: (id, tok) => `---\nid: ${id}\nname: net-${id.slice(0, 6)}\n---\n\n# net\n\n${tok}\n`,
  },
];

const BRANCH = 'feature/share';

interface World {
  root: string;
  remote: string;
  sender: string;
  id: string;
  token: string;
  fam: Family;
  senderProject: string;
}

function mainFile(fam: Family, repo: string): string {
  return fam.main ? path.join(repo, fam.rel, fam.main) : path.join(repo, fam.rel);
}

/** Sender repo on BRANCH with the asset committed + pushed, registered on Alice. */
async function seed(fam: Family): Promise<World> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gshare-'));
  tmpDirs.push(root);
  const remote = path.join(root, 'remote.git');
  const sender = path.join(root, 'alice', 'repo');
  git(root, 'init', '--bare', '-q', '-b', 'main', remote);
  mkdirSync(path.dirname(sender), { recursive: true });
  git(root, 'clone', '-q', `file://${remote}`, sender);
  git(sender, 'config', 'user.email', 'alice@t.co');
  git(sender, 'config', 'user.name', 'alice');
  writeFileSync(path.join(sender, 'README.md'), 'seed\n');
  git(sender, 'add', '-A');
  git(sender, 'commit', '-qm', 'seed');
  git(sender, 'push', '-q', '-u', 'origin', 'HEAD:main');
  git(sender, 'checkout', '-q', '-b', BRANCH);
  const id = randomUUID();
  const token = `gsh${id.replace(/-/g, '').slice(0, 12)}`;
  const f = mainFile(fam, sender);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, fam.body(id, token));
  if (fam.type === 'chart') {
    // A chart is CHART.md + its board (what the editor's first save writes).
    writeFileSync(path.join(path.dirname(f), 'board.json'), JSON.stringify({ kind: 'excalidraw', version: 1, data: { elements: [] } }));
  }
  git(sender, 'add', '-A');
  git(sender, 'commit', '-qm', 'asset');
  git(sender, 'push', '-q', '-u', 'origin', BRANCH);

  const proj = await post(alice.apiUrl, '/graph/project', { name: testEntityName('gshare-src'), fs_storage_mount_path: sender });
  const senderProject = proj.body?.data?.id;
  expect(senderProject, 'sender project').toBeTruthy();
  created.push({ apiUrl: alice.apiUrl, path: `/graph/project/${senderProject}` });
  await post(alice.apiUrl, '/graph/compute_node/@local/fs-records/invalidate', { paths: [f] });
  await pollUntil(
    async () => ((await get(alice.apiUrl, `/graph/${fam.type}/${id}`)).body?.data?.id === id ? true : null),
    15_000,
    `${fam.type} indexed on Alice`,
  );
  return { root, remote, sender, id, token, fam, senderProject };
}

function senderCommit(w: World, token: string): string {
  writeFileSync(mainFile(w.fam, w.sender), w.fam.body(w.id, token));
  git(w.sender, 'commit', '-qam', token);
  git(w.sender, 'push', '-q', 'origin', BRANCH);
  return git(w.sender, 'rev-parse', 'HEAD');
}

/** Alice shares `ref` in git mode into a fresh conversation with Bob. */
async function shareByGit(ref: string): Promise<{ convId: string; fmId: string }> {
  const conv = trackForCleanup(new alice.sdk.Conversation({ title: testEntityName('gshare') }));
  await conv.save();
  created.push({ apiUrl: alice.apiUrl, path: `/graph/conversation/${conv.id}` });
  await conv.share([bob.email]);
  const add = await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
    message: 'shared over git',
    asset_references: [ref],
    share_config: { transfer_mode: 'git' },
  });
  const fmId = add.body.data?.flow_message_id as string;
  expect(fmId, `flow_message_id (got ${JSON.stringify(add.body?.message)})`).toBeTruthy();
  const up = await post(alice.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});
  expect(up.body.data?.body_status, 'body READY').toBe('ready');
  return { convId: conv.id, fmId };
}

/** Bob receives the message over the hub, downloads (stages) and installs it into his
 *  project: first without consent (the plan comes back, nothing is written), then with it. */
async function receive(convId: string, fmId: string, assetId: string, project: { id: string; dir: string }) {
  const sync = await post(bob.apiUrl, '/graph/conversation-message-sync', { conversation_id: convId });
  expect(sync.status, 'conversation sync').toBeLessThan(400);
  await pollUntil(
    async () => ((await get(bob.apiUrl, `/graph/flow_message/${fmId}`)).body?.data?.body_status === 'ready' ? true : null),
    20_000,
    'message on Bob',
  );
  created.push({ apiUrl: bob.apiUrl, path: `/graph/conversation/${convId}` });
  const dl = await post(bob.apiUrl, `/graph/flow_message/${fmId}/download_body`, {});
  expect(dl.status, `download (got ${JSON.stringify(dl.body?.message)})`).toBeLessThan(400);
  const staged = await pollUntil(
    async () => {
      const rows = ((await get(bob.apiUrl, '/graph/message_attachment')).body?.data ?? []) as any[];
      return rows.find((m) => m.flow_message_id === fmId && m.asset_id === assetId) ?? null;
    },
    10_000,
    'staged attachment',
  );
  expect(staged.transfer_mode, 'staged as a git pointer, not a copy').toBe('git');
  // The pointer IS the attachment: the message must not read "arrived short".
  const fm = await get(bob.apiUrl, `/graph/flow_message/${fmId}`);
  expect(fm.body?.data?.body_missing_attachments ?? [], 'no missing attachments after download').toEqual([]);
  const before = checkoutState(project.dir);
  const install = (apply: boolean) =>
    post(bob.apiUrl, `/graph/message_attachment/${staged.id}/install`, { scope: 'project', project_id: project.id, apply });
  const asked = await install(false);
  expect(asked.status, `plan (got ${JSON.stringify(asked.body?.message)})`).toBeLessThan(400);
  expect(asked.body?.data?.needs, 'Bob is asked before his checkout is written').toBe('apply');
  expect(checkoutState(project.dir), 'the plan step wrote nothing').toBe(before);
  const done = await install(true);
  return { ...done, plan: asked.body.data.plan as { action: string; commits: string[]; branch: string } };
}

/** No `.shared` copy anywhere under the share's temp root or Bob's workspace. */
function noSharedCopies(root: string): void {
  const found = execFileSync('find', [root, '-type', 'd', '-name', '.shared'], { encoding: 'utf8' }).trim();
  expect(found, 'a .shared copy was made').toBe('');
}

/** Bob's own clone of the repo — on `main`, with uncommitted edits of his own. */
async function bobsOwnCheckout(w: World): Promise<{ dir: string; id: string; before: string }> {
  const dir = path.join(w.root, 'bob', 'repo');
  mkdirSync(path.dirname(dir), { recursive: true });
  git(w.root, 'clone', '-q', '--branch', 'main', `file://${w.remote}`, dir);
  writeFileSync(path.join(dir, 'README.md'), "bob's own uncommitted edit\n");
  writeFileSync(path.join(dir, 'bob-notes.txt'), 'untracked\n');
  const proj = await post(bob.apiUrl, '/graph/project', { name: testEntityName('gshare-dst'), fs_storage_mount_path: dir });
  const id = proj.body?.data?.id;
  expect(id, 'receiver project').toBeTruthy();
  created.push({ apiUrl: bob.apiUrl, path: `/graph/project/${id}` });
  return { dir, id, before: checkoutState(dir) };
}

function checkoutState(dir: string): string {
  const porcelain = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8' });
  const files = porcelain
    .split('\n')
    .filter(Boolean)
    .map((l) => `${l}:${readFileSync(path.join(dir, l.slice(3)), 'utf8')}`);
  return JSON.stringify({ head: git(dir, 'rev-parse', 'HEAD'), branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), files });
}

async function bobRow(type: string, id: string): Promise<any> {
  return pollUntil(async () => (await get(bob.apiUrl, `/graph/${type}/${id}`)).body?.data ?? null, 10_000, `${type} on Bob`);
}

async function bobFinds(token: string, id: string, recordType?: string): Promise<boolean> {
  const q = `/search?q=${encodeURIComponent(token)}${recordType ? `&record_type=${recordType}` : ''}`;
  return !!(await pollUntil(
    async () => (((await get(bob.apiUrl, q)).body?.data?.results ?? []) as any[]).some((r) => r.record_id === id) || null,
    10_000,
    `search ${token} on Bob`,
  ).catch(() => null));
}

function mainOf(fam: Family, assetRef: string): string {
  return fam.main ? path.join(assetRef, fam.main) : assetRef;
}

// ------------------------------------------------------------------ cases ---

describe('git share over the real hub (Alice → Bob)', () => {
  for (const fam of FAMILIES) {
    it(`${fam.type}: Bob says yes, the shared commit is cherry-picked into his checkout (branch + own edits kept); live; searchable`, async () => {
      const t = new Timer();
      const w = await t.step('seed', () => seed(fam));
      const pinned = git(w.sender, 'rev-parse', 'HEAD');
      const mine = await t.step('receiver_checkout', () => bobsOwnCheckout(w));
      const { convId, fmId } = await t.step('share', () => shareByGit(`${fam.type}-${w.id}`));
      await t.step('sender_moves_on', async () => senderCommit(w, 'alice-kept-going'));
      // The chip asks for the asset before it is installed: prime that miss, so
      // the live check below proves install ANNOUNCES the row (no reload).
      const tid = new bob.sdk.TypeId(fam.type, w.id);
      expect(await bob.sdk.dataManager.getByTypeId(tid).catch(() => null), 'not on Bob before install').toBeNull();
      const install = await t.step('receive_install', () => receive(convId, fmId, w.id, mine));
      expect(install.status, `install (got ${JSON.stringify(install.body?.message)})`).toBeLessThan(400);
      expect(install.plan.action).toBe('cherry_pick');
      expect(install.plan.commits, 'only the asset commit that was shared').toEqual([pinned]);

      const row = await t.step('row', () => bobRow(fam.type, w.id));
      expect(realpathSync(row.asset_ref), 'in Bob\'s project folder').toBe(realpathSync(path.join(mine.dir, fam.rel)));
      const file = mainOf(fam, row.asset_ref);
      expect(readFileSync(file, 'utf8')).toContain(w.token);
      expect(git(mine.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), "Bob's branch kept").toBe('main');
      expect(git(mine.dir, 'log', '-1', '--format=%B')).toContain(`cherry picked from commit ${pinned}`);
      expect(readFileSync(path.join(mine.dir, 'README.md'), 'utf8'), "Bob's own edit kept").toBe("bob's own uncommitted edit\n");
      noSharedCopies(w.root);
      const live = await t.step('live', () =>
        pollUntil(async () => (await bob.sdk.dataManager.getByTypeId(tid).catch(() => null)) ?? null, 10_000, 'live (CREATE data_op)'),
      );
      expect(live?.id).toBe(w.id);
      expect(await t.step('search', () => bobFinds(w.token, w.id, fam.type)), 'findable by text on Bob').toBe(true);
      created.push({ apiUrl: bob.apiUrl, path: `/graph/${fam.type}/${w.id}` });
      t.done(`${fam.type}:pinned+untouched+searchable`);
    }, 60_000); // do not increase timeout without approval
  }

  it('markdown: Bob sees 1 newer version, updates, and search finds the new text', async () => {
    const t = new Timer();
    const fam = FAMILIES[1];
    const w = await t.step('seed', () => seed(fam));
    const mine = await t.step('receiver_checkout', () => bobsOwnCheckout(w));
    const { convId, fmId } = await t.step('share', () => shareByGit(`${fam.type}-${w.id}`));
    const install = await t.step('receive_install', () => receive(convId, fmId, w.id, mine));
    expect(install.status).toBeLessThan(400);
    senderCommit(w, 'gshnewversiontok');
    const st = await t.step('status', () => get(bob.apiUrl, `/graph/${fam.type}/${w.id}/git_share_status`));
    expect(st.body?.data?.behind, JSON.stringify(st.body)).toBe(1);
    const asked = await t.step('plan', () => post(bob.apiUrl, `/graph/${fam.type}/${w.id}/git_share_update`, {}));
    expect(asked.body?.data?.needs, JSON.stringify(asked.body)).toBe('apply');
    const up = await t.step('update', () => post(bob.apiUrl, `/graph/${fam.type}/${w.id}/git_share_update`, { apply: true }));
    expect(up.body?.data?.updated, JSON.stringify(up.body)).toBe(true);
    expect(readFileSync(mainFile(fam, mine.dir), 'utf8')).toContain('gshnewversiontok');
    expect(await t.step('search', () => bobFinds('gshnewversiontok', w.id, fam.type))).toBe(true);
    created.push({ apiUrl: bob.apiUrl, path: `/graph/${fam.type}/${w.id}` });
    t.done('markdown:update');
  }, 60_000); // do not increase timeout without approval

  it("credential: Bob brings a shared credential into his project and its setup asks for it", async () => {
    const t = new Timer();
    const w = await t.step('seed', () => seed(FAMILIES[1]));
    const dir = path.join(w.sender, 'agentic-assets/credential/bright_data');
    const credId = randomUUID();
    mkdirSync(path.join(dir, '.flow/capsules'), { recursive: true });
    writeFileSync(path.join(dir, '.flow/capsules/identity.json'), JSON.stringify({ data: { id: credId }, version: 1 }));
    writeFileSync(
      path.join(dir, 'credential.json'),
      JSON.stringify({ name: 'bright_data', title: 'Bright Data', schema: 2, vars: { BRIGHT_DATA_API_KEY: {} } }, null, 2),
    );
    git(w.sender, 'add', '-A');
    git(w.sender, 'commit', '-qm', 'bright data credential');
    git(w.sender, 'push', '-q', 'origin', BRANCH);
    await post(alice.apiUrl, '/graph/compute_node/@local/fs-records/invalidate', { paths: [path.join(dir, 'credential.json')] });
    await pollUntil(
      async () => ((await get(alice.apiUrl, `/graph/credential/${credId}`)).body?.data?.id === credId ? true : null),
      15_000,
      'credential indexed on Alice',
    );
    const mine = await t.step('receiver_checkout', () => bobsOwnCheckout(w));
    const { convId, fmId } = await t.step('share', () => shareByGit(`credential-${credId}`));
    expect((await t.step('receive_install', () => receive(convId, fmId, credId, mine))).status).toBeLessThan(400);
    const row = await bobRow('credential', credId);
    expect(realpathSync(row.asset_ref)).toBe(realpathSync(path.join(mine.dir, 'agentic-assets/credential/bright_data')));
    const ready = await t.step('setup', () => get(bob.apiUrl, `/graph/project/${mine.id}/setup-requirements`));
    const todo = ((ready.body?.data?.to_do ?? []) as any[]).map((r) => r.name);
    expect(todo, JSON.stringify(ready.body?.data)).toContain('bright_data');
    noSharedCopies(w.root);
    created.push({ apiUrl: bob.apiUrl, path: `/graph/credential/${credId}` });
    t.done('credential:setup');
  }, 60_000); // do not increase timeout without approval

  it('markdown: an uncommitted edit is committed (only it) by the one-click fix, then shared', async () => {
    const t = new Timer();
    const fam = FAMILIES[1];
    const w = await t.step('seed', () => seed(fam));
    writeFileSync(mainFile(fam, w.sender), fam.body(w.id, 'gshuncommittedtok'));
    writeFileSync(path.join(w.sender, 'alice-wip.txt'), 'not for sharing\n');
    const pre = await t.step('preflight', () => get(alice.apiUrl, `/graph/${fam.type}/${w.id}/git_share_preflight`));
    expect(pre.body?.data?.fix, JSON.stringify(pre.body)).toBe('commit');
    const fix = await t.step('fix', () => post(alice.apiUrl, `/graph/${fam.type}/${w.id}/git_share_fix`, { fix: 'commit' }));
    expect(fix.body?.data?.preflight?.available, JSON.stringify(fix.body)).toBe(true);
    expect(git(w.sender, 'status', '--porcelain'), "Alice's other work stays uncommitted").toBe('?? alice-wip.txt');
    const mine = await t.step('receiver_checkout', () => bobsOwnCheckout(w));
    const { convId, fmId } = await t.step('share', () => shareByGit(`${fam.type}-${w.id}`));
    expect((await t.step('receive_install', () => receive(convId, fmId, w.id, mine))).status).toBeLessThan(400);
    expect(await t.step('search', () => bobFinds('gshuncommittedtok', w.id, fam.type))).toBe(true);
    created.push({ apiUrl: bob.apiUrl, path: `/graph/${fam.type}/${w.id}` });
    t.done('markdown:fix_commit');
  }, 60_000); // do not increase timeout without approval

  it('html page: travels as a git pointer into Bob\'s checkout and Bob finds it by name', async () => {
    const t = new Timer();
    const w = await t.step('seed', () => seed(FAMILIES[1]));
    const page = path.join(w.sender, 'platform/docs/nudge_backoffice_mock.html');
    mkdirSync(path.dirname(page), { recursive: true });
    writeFileSync(page, `<html><body>${w.token}</body></html>\n`);
    git(w.sender, 'add', '-A');
    git(w.sender, 'commit', '-qm', 'mock');
    git(w.sender, 'push', '-q', 'origin', BRANCH);
    const pinned = git(w.sender, 'rev-parse', 'HEAD');
    const art = await t.step('artifact', () => post(alice.apiUrl, '/graph/shared-file-artifact', { path: page }));
    const ref = art.body?.data?.type_id as string;
    expect(ref, JSON.stringify(art.body)).toMatch(/^artifact-/);
    const id = ref.slice('artifact-'.length);
    created.push({ apiUrl: alice.apiUrl, path: `/graph/artifact/${id}` });
    const mine = await t.step('receiver_checkout', () => bobsOwnCheckout(w));
    const { convId, fmId } = await t.step('share', () => shareByGit(ref));
    senderCommit(w, 'later-doc-change');
    expect((await t.step('receive_install', () => receive(convId, fmId, id, mine))).status).toBeLessThan(400);
    const row = await bobRow('artifact', id);
    expect(realpathSync(row.asset_ref)).toBe(realpathSync(path.join(mine.dir, 'platform/docs/nudge_backoffice_mock.html')));
    expect(readFileSync(row.asset_ref, 'utf8')).toContain(w.token);
    expect(git(mine.dir, 'log', '-1', '--format=%B')).toContain(`cherry picked from commit ${pinned}`);
    expect(await t.step('search', () => bobFinds('nudge_backoffice_mock', id, 'artifact'))).toBe(true);
    created.push({ apiUrl: bob.apiUrl, path: `/graph/artifact/${id}` });
    t.done('html:artifact');
  }, 60_000); // do not increase timeout without approval
});
