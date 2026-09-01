/**
 * Context-folder share over Git, end-to-end across TWO instances via the real hub.
 *
 * Alice adds a git-backed folder as a context folder and shares it. Git is the
 * POLICY for folders (never copied bytes), so this asserts the whole wire:
 *
 *   preflight(folder) available  → the share gate's "ready" state, and the proof
 *                                  that git_share_preflight resolves a FOLDER at
 *                                  all (it has no asset_ref — it resolves via its
 *                                  own local `path`)
 *   share → hub → Bob            → staged MessageAttachment carrying a GitOrigin
 *   install                      → Folder row on Bob, path unset (NO clone here)
 *   resolve-location             → Bob CLONES from the origin — the pull
 *   index                        → the pulled content is indexed on Bob's side
 *
 * The origin is a local bare repo over `file://`, which GitOrigin supports as a
 * first-class provider (`parse_git_origin_url` / `git_origin_clone_url`), so no
 * GitHub and no auth are involved.
 *
 * Requires the local hub (8093) + dev-1/dev-2 launched via
 *   scripts/instance_ctl.sh launch dev-1 && … dev-2
 * Skips otherwise.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { trackForCleanup } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  syncAssignedConversation,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const post = (apiUrl: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const get = (apiUrl: string, p: string) => fetch(`${apiUrl}/api/v1${p}`).then((r) => r.json());

/** A bare `file://` remote + a pushed worktree: a folder in the only state that
 *  preflights as eligible (in a repo, real origin, clean, everything pushed). */
function makeGitFolder(token: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowpad-folder-share-'));
  tempRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const worktree = path.join(root, 'alice-worktree');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'clone', '-q', pathToFileURL(remote).href, worktree);
  git(worktree, 'checkout', '-q', '-b', 'main');
  git(worktree, 'config', 'user.email', 'alice@example.test');
  git(worktree, 'config', 'user.name', 'Alice');
  const skillDir = path.join(worktree, '.claude', 'skills', 'shared-kit');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: shared-kit\ndescription: ${token}\n---\n\n# shared-kit\n\n${token}\n`,
    'utf-8',
  );
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'kit');
  git(worktree, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote, worktree };
}

/** Attach `dir` to a fresh project as a context folder; return the Folder typeid
 *  the backend minted for it (context_dir_infos carries it). */
async function addContextFolder(inst: ResolvedInstance, dir: string): Promise<{ projectId: string; folderId: string }> {
  // The backend canonicalizes the path (realpath), and on macOS a tmpdir is a
  // symlink (/tmp → /private/tmp) — compare against the resolved path or the
  // match never lands.
  const real = realpathSync(dir);
  const project = trackForCleanup(
    new inst.sdk.Project({ name: `folder-share-${randomUUID().slice(0, 8)}`, fs_storage_mount_path: real } as any),
  );
  await project.save();
  const res = await post(inst.apiUrl, `/graph/project/${project.id}/add-context-dir`, {
    path: real,
    scope: 'private',
  });
  expect(res.status, JSON.stringify(res)).toBe('SUCCESS');

  const typeid = await pollUntil(async () => {
    const p = await get(inst.apiUrl, `/graph/project/${project.id}`);
    const infos = (p?.data?.context_dir_infos ?? []) as Array<{ path: string; typeid?: string }>;
    return infos.find((i) => i.path === real)?.typeid || null;
  }, 15_000, 'context_dir_infos carries the minted Folder typeid');

  return { projectId: project.id, folderId: typeid.split('-').slice(1).join('-') };
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

describe('context folder share over git — two instances', () => {
  it('state 1: a folder with no git reports not-in-repo (the "Setup git" gate)', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'flowpad-plain-folder-'));
    tempRoots.push(plain);
    writeFileSync(path.join(plain, 'notes.md'), '# local only\n', 'utf-8');
    const { folderId } = await addContextFolder(alice, plain);

    const pre = await get(alice.apiUrl, `/graph/folder/${folderId}/git_share_preflight`);
    expect(pre.data, JSON.stringify(pre.data)).toMatchObject({ available: false, code: 'not-in-repo' });
  }, 60_000);

  it('states 2→3: dirty commits+pushes to ready, then the receiver pulls + indexes', async () => {
    const token = `folder-token-${randomUUID()}`;
    const fixture = makeGitFolder(token);
    const { folderId } = await addContextFolder(alice, fixture.worktree);
    const workdir = realpathSync(fixture.worktree);

    // STATE 2 — uncommitted changes. Adding the folder ALSO dirties it for real
    // (the indexer stamps a `.flow/` id capsule into the skill dir), but write
    // our own file so "dirty" is deterministic rather than incidental.
    writeFileSync(path.join(workdir, 'pending.md'), `# pending\n\n${token}\n`, 'utf-8');
    const dirty = await get(alice.apiUrl, `/graph/folder/${folderId}/git_share_preflight`);
    expect(dirty.data, JSON.stringify(dirty.data)).toMatchObject({ available: false, code: 'dirty' });

    // "Commit & continue" — the exact call useGitPush makes: stage-all → commit
    // → pull --rebase → push. One action, because the receiver clones the origin
    // and an unpushed commit would be unreachable.
    const pushed = await post(alice.apiUrl, '/graph/compute_node/@local/git-ops/push', { workdir });
    expect(pushed.data?.ok, JSON.stringify(pushed.data)).toBe(true);

    // STATE 3 — clean + pushed. A FOLDER has no asset_ref, so this is also the
    // assertion that the backend resolves it via its local path at all.
    const pre = await get(alice.apiUrl, `/graph/folder/${folderId}/git_share_preflight`);
    expect(pre.data, JSON.stringify(pre.data)).toMatchObject({ available: true, code: null });
    expect(pre.data.git_origin.provider).toBe('file');

    // 2. Share it over git, exactly as folderShareSource pins it.
    const conv = trackForCleanup(new alice.sdk.Conversation({ title: `folder conv ${token.slice(-8)}` }));
    await conv.save();
    await conv.share([bob.email]);
    const fmId = (
      await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
        message: 'a folder for you',
        asset_references: [`folder-${folderId}`],
        shared_context_entities: [`folder-${folderId}`],
        share_config: { transfer_mode: 'git' },
      })
    ).data.flow_message_id as string;
    await post(alice.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});

    // 3. Bob receives the assignment + downloads → the attachment STAGES with a GitOrigin.
    await syncAssignedConversation(bob, conv.id);
    const receivedFm = await pollUntil(async () => {
      const fm = await bob.sdk.FlowMessage.getById(fmId).catch(() => null);
      return fm && (fm as any).body_status === 'ready' ? fm : null;
    }, 20_000, 'shared message READY on bob');
    await post(bob.apiUrl, `/graph/flow_message/${receivedFm.id}/download_body`, {});

    const staged = await pollUntil(async () => {
      const rows = (await bob.sdk.MessageAttachment.query(
        new bob.sdk.QueryRequest({ type: 'message_attachment', query: { flow_message_id: fmId }, name: 'staged (test)' }),
        true,
      ).catch(() => [])) as any[];
      return rows.find((r) => r.asset_id === folderId) ?? null;
    }, 20_000, 'staged folder MessageAttachment on bob');
    // The origin travelled; the repository bytes did NOT.
    expect(staged.origin?.provider).toBe('file');
    expect(staged.transfer_mode).toBe('git');

    // 4. Install → the row materializes. Deliberately NO clone at this gate.
    const install = await post(bob.apiUrl, `/graph/message_attachment/${staged.id}/install`, { scope: 'user' });
    expect(install.status, JSON.stringify(install)).toBe('SUCCESS');
    const bobFolder = await pollUntil(
      async () => (await get(bob.apiUrl, `/graph/folder/${folderId}`))?.data ?? null,
      15_000,
      'folder row on bob',
    );
    expect(bobFolder.origin.kind).toBe('git');

    // 5. Resolve → Bob CLONES from the origin. This is the pull.
    const resolved = await post(bob.apiUrl, `/graph/folder/${folderId}/resolve-location`, {});
    expect(resolved.data, JSON.stringify(resolved.data)).toMatchObject({ kind: 'ready' });
    const bobPath = (await get(bob.apiUrl, `/graph/folder/${folderId}`)).data.path as string;
    expect(bobPath, 'receiver resolved a local checkout').toBeTruthy();
    // The sender's content actually arrived on the receiver's disk.
    expect(existsSync(path.join(bobPath, '.claude', 'skills', 'shared-kit', 'SKILL.md'))).toBe(true);

    // 6. Index the pulled checkout → the content is searchable on Bob's side.
    //    `invalidate` reindexes an explicit changed-path set (resolving an inner
    //    file to its owning folder asset), so this indexes exactly what arrived
    //    rather than rescanning Bob's whole corpus.
    const pulledSkill = path.join(bobPath, '.claude', 'skills', 'shared-kit', 'SKILL.md');
    const indexed = await post(bob.apiUrl, '/graph/compute_node/@local/fs-records/invalidate', {
      paths: [pulledSkill],
    });
    expect(indexed.status, JSON.stringify(indexed)).toBe('SUCCESS');
    const skill = await pollUntil(async () => {
      const rows = (await bob.sdk.Skill.query(
        new bob.sdk.QueryRequest({ type: 'skill', query: { name: 'shared-kit' }, name: 'pulled skill (test)' }),
        true,
      ).catch(() => [])) as any[];
      return rows.find((s) => (s.asset_ref ?? '').startsWith(bobPath)) ?? null;
    }, 20_000, 'pulled skill indexed on bob');
    expect(skill.description).toContain(token);
  }, 120_000);
});
