/**
 * Group-task ATTACHMENTS across TWO instances via the real hub.
 *
 * Alice attaches both kinds of attachment to a task and assigns it to Bob:
 *
 *   a FILE          → bytes must reach the hub and be readable on Bob's disk
 *   a GIT folder    → only the ORIGIN travels; the repo bytes never do
 *
 * The file half is the one no single-instance test can prove, because the whole
 * failure mode was "looks fine locally, nothing on the hub":
 *
 *   attach → task VFS          the copy onto the entity (not a path reference)
 *   share  → hub               push_entity_files_to_hub — the file predates the
 *                              hub twin, so per-upload reflection has NOT fired
 *   sync   → Bob's mirror      the artifacts DECLARATIONS reach the member
 *   open   → Bob's disk        fs/download misses locally, falls back to the
 *                              hub, caches, and reports a real local_path
 *
 * Attach happens BEFORE the share on purpose: that ordering is what shipped
 * broken (reflection only fires once the entity is already ``remote``), and it
 * is also the natural create → attach → assign flow.
 *
 * Bob reading the bytes IS the proof they are on the hub — his instance has no
 * other source for them.
 *
 * Requires the local hub + dev-1/dev-2 launched via
 *   scripts/instance_ctl.sh launch dev-1 && … dev-2
 * Skips otherwise.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { trackForCleanup } from '../_cleanup';
import { hubAvailable } from './_hub';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';
import { pollUntil } from './_matrix';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
const tempRoots: string[] = [];

const git = (cwd: string, ...args: string[]) => void execFileSync('git', args, { cwd, stdio: 'pipe' });

const post = (apiUrl: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const get = (apiUrl: string, p: string) => fetch(`${apiUrl}/api/v1${p}`).then((r) => r.json());

/** A bare `file://` remote + a pushed worktree — the only state in which a
 *  folder carries a transportable GitOrigin. */
function makeGitFolder(token: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowpad-gt-folder-'));
  tempRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const worktree = path.join(root, 'alice-worktree');
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'clone', '-q', pathToFileURL(remote).href, worktree);
  git(worktree, 'checkout', '-q', '-b', 'main');
  git(worktree, 'config', 'user.email', 'alice@example.test');
  git(worktree, 'config', 'user.name', 'Alice');
  writeFileSync(path.join(worktree, 'notes.md'), `# notes\n\n${token}\n`, 'utf-8');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'notes');
  git(worktree, 'push', '-q', '-u', 'origin', 'main');
  return worktree;
}

/** Register a folder as a project context dir and return its minted GitOrigin —
 *  the same value the attachment UI reads off the Folder entity at attach time. */
async function gitOriginForFolder(inst: ResolvedInstance, folderPath: string, token: string) {
  const project = trackForCleanup(new inst.sdk.Project({ name: `gt-proj-${token.slice(-8)}` }));
  await project.save();
  const res = await post(inst.apiUrl, `/graph/project/${project.id}/add-context-dir`, {
    path: folderPath,
    scope: 'private',
  });
  expect(res.status, JSON.stringify(res)).toBe('SUCCESS');

  const typeid = await pollUntil(
    async () => {
      const p = await get(inst.apiUrl, `/graph/project/${project.id}`);
      const infos = (p?.data?.context_dir_infos ?? []) as Array<{ path: string; typeid?: string }>;
      return infos.find((i) => i.origin_kind === 'git')?.typeid || null;
    },
    15_000,
    'context_dir_infos carries a git-backed Folder typeid',
  );
  const folderId = typeid.split('-').slice(1).join('-');
  const folder = await get(inst.apiUrl, `/graph/folder/${folderId}`);
  expect(folder?.data?.origin?.kind, JSON.stringify(folder?.data?.origin)).toBe('git');
  return folder.data.origin;
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

describe('group task attachments — file + git folder across two instances', () => {
  it('a file reaches the hub and Bob’s disk; a git folder travels as an origin only', async () => {
    const token = `gt-${randomUUID()}`;
    const fileBody = `# instructions\n\n${token}\n`;
    const fileName = 'task_inst.md';

    // ── Alice: task + BOTH attachment kinds, all BEFORE the share ──
    const gitOrigin = await gitOriginForFolder(alice, makeGitFolder(token), token);

    const task = trackForCleanup(new alice.sdk.Task({ title: `gt task ${token.slice(-8)}` }));
    await task.save();

    // The file is COPIED onto the task (an fs/upload), not referenced by path —
    // a sender-local path is meaningless on Bob's machine.
    // Keep the multipart body in the Node fetch realm. Vitest's jsdom
    // `FormData` only accepts jsdom `Blob` instances, while Node fetch expects
    // its own multipart objects; mixing the two fails before the request.
    const boundary = `----flowpad-${randomUUID()}`;
    const form = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="uploaded_file"; filename="${fileName}"`,
      'Content-Type: text/markdown',
      '',
      fileBody,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const up = await fetch(`${alice.apiUrl}/api/v1/graph/task/${task.id}/fs/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: form,
    }).then((r) => r.json());
    expect(up.status, JSON.stringify(up)).toBe('SUCCESS');

    task.artifacts = [
      { label: fileName, vfs: fileName },
      { label: 'ctx-repo', git_origin: gitOrigin },
    ] as any;
    await task.save();

    // ── Assign to Bob. The task becomes remote HERE, after the file already
    //    exists — so this is what must carry the bytes up. ──
    const created = await post(alice.apiUrl, `/graph/task/${task.id}/create-group-task`, {
      members: [{ email: bob.email }],
    });
    expect(created.status, JSON.stringify(created)).toBe('SUCCESS');
    const memberTaskIds = ((created?.data?.children ?? []) as string[])
      .map((typeid) => typeid.replace(/^task-/, ''))
      .filter(Boolean);
    expect(memberTaskIds.length, JSON.stringify(created?.data)).toBeGreaterThan(0);

    // ── Bob: observe an auto-accepted assignment, or accept it explicitly ──
    // Current hubs auto-accept task-only assignments between same-org users.
    // Older hubs retain the pending-invitation path, so exercise it when present.
    let acceptedInvitation: string | null = null;
    const memberTask = await pollUntil(
      async () => {
        const rows = (await bob.sdk.Task.query(
          new bob.sdk.QueryRequest({ type: 'task', query: { parent_id: task.id }, name: 'member task (test)' }),
          true,
        ).catch(() => [])) as any[];
        if (rows[0]) return rows[0];

        const synced = await post(bob.apiUrl, '/graph/invitation-sync', {});
        expect(synced.status, JSON.stringify(synced)).toBe('SUCCESS');
        const all: any[] = await (bob.sdk.Invitation as any).query({ query: {} }, true).catch(() => []);
        const invitation = all.find(
          (inv) =>
            !inv.accepted &&
            [task.id, ...memberTaskIds].some(
              (targetId) =>
                inv.target_id === targetId || (inv.target_url_path || '').includes(targetId),
            ),
        );
        if (invitation && acceptedInvitation !== invitation.id) {
          acceptedInvitation = invitation.id!;
          await bob.sdk.acceptInvitation({ invitation_id: invitation.id! });
        }
        return null;
      },
      30_000,
      'group-task assignment materialized on bob',
    );

    // The member task is Bob's own child; the attachments live on the PARENT.
    // `sync-group` is what pulls the parent's display fields + artifacts.
    await post(bob.apiUrl, `/graph/task/${memberTask.id}/sync-group`, {});

    // ── 1. The DECLARATIONS reached Bob ──
    const parent = await pollUntil(
      async () => {
        const p = await get(bob.apiUrl, `/graph/task/${task.id}`);
        const arts = (p?.data?.artifacts ?? []) as any[];
        return arts.length >= 2 ? p.data : null;
      },
      30_000,
      "parent mirror carries the owner's artifacts on bob",
    );
    const fileEntry = (parent.artifacts as any[]).find((a) => a.vfs === fileName);
    const gitEntry = (parent.artifacts as any[]).find((a) => a.git_origin);
    expect(fileEntry, JSON.stringify(parent.artifacts)).toBeTruthy();
    expect(gitEntry, JSON.stringify(parent.artifacts)).toBeTruthy();

    // ── 2. The GIT folder travelled as an ORIGIN, never as bytes ──
    expect(gitEntry.git_origin.kind).toBe('git');
    expect(gitEntry.git_origin.provider).toBe('file');
    expect(gitEntry.vfs, 'a git folder must NOT be copied onto the task').toBeUndefined();

    // ── 3. The FILE's bytes are fetchable on Bob — which can only be true if
    //       they are on the hub, since his instance has no other source ──
    const dl = await fetch(`${bob.apiUrl}/api/v1/graph/task/${task.id}/fs/download/${fileName}`);
    expect(dl.status, 'bob downloads the attachment').toBe(200);
    expect(await dl.text()).toContain(token);

    // ── 4. …and it is CACHED on his disk with a server-reported local_path.
    //       The UI opens that path; deriving it client-side yielded "/<name>"
    //       at the filesystem root. ──
    const browsed = await get(bob.apiUrl, `/graph/task/${task.id}/fs/browse`);
    const item = ((browsed?.data ?? []) as any[]).find((i) => i.display_name === fileName);
    expect(item, JSON.stringify(browsed?.data)).toBeTruthy();
    expect(item.local_path, 'server reports where the bytes landed').toBeTruthy();
    expect(path.isAbsolute(item.local_path)).toBe(true);
    expect(readFileSync(item.local_path, 'utf-8')).toContain(token);
  }, 180_000);
});
