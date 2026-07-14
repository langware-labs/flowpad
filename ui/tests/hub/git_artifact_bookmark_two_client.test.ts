/**
 * "Create bookmark" share opt-in, end-to-end over the hub with two real SDK
 * clients (one realm per instance).
 *
 * Alice creates a git-backed webapp artifact and shares it with Bob with the
 * "create bookmark" flag ON. Bob accepts + downloads: the artifact must be
 * STAGED (no Artifact row yet), like a file-backed asset. Bob installs: the
 * Artifact graph row materialises (path='' — checkout resolves later at open)
 * AND a FAVORITE Bookmark pointing at the artifact appears. With the flag OFF,
 * no favorite is minted. Proves the flag channel (share_options.json →
 * MessageAttachment.create_bookmark → install mint) + the artifact
 * staged→install reception.
 *
 * The git CLONE is not exercised here (it happens at OPEN, via the git wizard —
 * see git_artifact_share_wizard for that); install only materialises the row +
 * mints the favorite.
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { trackForCleanup } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

const REL_PATH = 'apps/shared-webapp';
const BRANCH = 'feature/git-artifact-bookmark';

let skipReason: string | null = null;
let dev1: ResolvedInstance;
let dev2: ResolvedInstance;
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

/** A real bare remote + a pushed worktree so the artifact carries a complete,
 *  valid GitOrigin (the receiver only needs it to pack/stage in git mode). */
function makeGitFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowpad-artifact-bookmark-'));
  tempRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const senderRepo = path.join(root, 'alice-worktree');
  const appDir = path.join(senderRepo, REL_PATH);
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'clone', '-q', pathToFileURL(remote).href, senderRepo);
  git(senderRepo, 'checkout', '-q', '-b', BRANCH);
  git(senderRepo, 'config', 'user.email', 'alice@example.test');
  git(senderRepo, 'config', 'user.name', 'Alice');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'index.html'), `<html><body>hi ${randomUUID()}</body></html>\n`, 'utf-8');
  git(senderRepo, 'add', '-A');
  git(senderRepo, 'commit', '-qm', 'webapp');
  git(senderRepo, 'push', '-q', '-u', 'origin', BRANCH);
  return {
    appDir,
    gitOrigin: {
      provider: 'file',
      owner: path.dirname(remote),
      name: path.basename(remote, '.git'),
      branch: BRANCH,
      rel_path: REL_PATH,
    },
  };
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  dev1 = await getInstance(INST_1);
  dev2 = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

async function favoriteFor(inst: ResolvedInstance, entityId: string): Promise<any | null> {
  const rows = (await inst.sdk.Bookmark.query(
    new inst.sdk.QueryRequest({
      type: 'bookmark',
      query: { bookmark_type: 'favorite' },
      name: 'favorites (test)',
    }),
    true,
  ).catch(() => [])) as any[];
  return rows.find((b) => (b.data ?? {})?.entity_id === entityId) ?? null;
}

/** Share one git artifact with a given create_bookmark flag; return ids. */
async function shareArtifact(createBookmark: boolean) {
  const fixture = makeGitFixture();
  const artifactId = randomUUID();
  const artifact = trackForCleanup(
    new dev1.sdk.Artifact({
      id: artifactId,
      name: `shared app ${artifactId.slice(0, 8)}`,
      ref_type: 'FOLDER',
      path: fixture.appDir,
      artifact_type: 'WEBAPP',
      port: '45678',
      git_origin: fixture.gitOrigin,
    } as any),
  );
  await artifact.save();

  const conv = trackForCleanup(new dev1.sdk.Conversation({ title: `bm conv ${artifactId.slice(0, 8)}` }));
  await conv.save();
  await conv.share([dev2.email]);

  const fmId = (
    await post(dev1.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
      message: 'a webapp for you',
      asset_references: [`artifact-${artifactId}`],
      share_config: { transfer_mode: 'git', create_bookmark: createBookmark },
    })
  ).data.flow_message_id as string;
  await post(dev1.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});
  return { conv, fmId, artifactId };
}

async function receiveAndStage(conv: any, fmId: string, artifactId: string) {
  const invitation = await pollUntil(
    () => findPendingInvitation(dev2, conv.id!),
    20_000,
    'pending invitation on dev-2',
  );
  await dev2.sdk.acceptInvitation({ invitation_id: invitation.id! });
  const receivedFm = await pollUntil(async () => {
    const fm = await dev2.sdk.FlowMessage.getById(fmId).catch(() => null);
    return fm && (fm as any).body_status === 'ready' ? fm : null;
  }, 20_000, 'shared message READY on dev-2');
  await post(dev2.apiUrl, `/graph/flow_message/${receivedFm.id}/download_body`, {});

  const stagedMa = await pollUntil(async () => {
    const rows = (await dev2.sdk.MessageAttachment.query(
      new dev2.sdk.QueryRequest({ type: 'message_attachment', query: { flow_message_id: fmId }, name: 'staged (test)' }),
      true,
    ).catch(() => [])) as any[];
    return rows.find((r) => r.asset_id === artifactId) ?? null;
  }, 15_000, 'staged artifact MessageAttachment on dev-2');
  return stagedMa;
}

describe('git artifact share — create bookmark opt-in', () => {
  it('flag ON: staged at download, Artifact + favorite at install', async () => {
    const { conv, fmId, artifactId } = await shareArtifact(true);
    const stagedMa = await receiveAndStage(conv, fmId, artifactId);

    // Staged, not materialized: no Artifact row yet, flag carried on the MA.
    expect(stagedMa.asset_type).toBe('artifact');
    expect(stagedMa.transfer_mode).toBe('git');
    expect(stagedMa.create_bookmark).toBe(true);
    expect(stagedMa.scope ?? null).toBeNull();
    expect(await dev2.sdk.Artifact.getById(artifactId).catch(() => null)).toBeFalsy();
    expect(await favoriteFor(dev2, artifactId)).toBeNull();

    // Install → graph row materialises (path='') + favorite minted.
    const install = await post(dev2.apiUrl, `/graph/message_attachment/${stagedMa.id}/install`, { scope: 'user' });
    expect(String(install.status)).toMatch(/success/i);

    const received = await pollUntil(
      () => dev2.sdk.Artifact.getById(artifactId).catch(() => null),
      10_000,
      'artifact materialised on dev-2 after install',
    );
    expect(received!.id).toBe(artifactId);
    expect((received as any).path ?? '').toBe('');

    const fav = await pollUntil(() => favoriteFor(dev2, artifactId), 10_000, 'favorite minted on dev-2');
    expect(fav.bookmark_type).toBe('favorite');
    expect((fav.data ?? {}).entity_type).toBe('artifact');
    expect((fav.data ?? {}).nav?.asset_ref ?? '').toBe('');
  }, 90_000);

  it('flag OFF: no favorite at install', async () => {
    const { conv, fmId, artifactId } = await shareArtifact(false);
    const stagedMa = await receiveAndStage(conv, fmId, artifactId);
    expect(stagedMa.create_bookmark ?? false).toBe(false);

    const install = await post(dev2.apiUrl, `/graph/message_attachment/${stagedMa.id}/install`, { scope: 'user' });
    expect(String(install.status)).toMatch(/success/i);
    await pollUntil(() => dev2.sdk.Artifact.getById(artifactId).catch(() => null), 10_000, 'artifact on dev-2');
    expect(await favoriteFor(dev2, artifactId)).toBeNull();
  }, 90_000);
});
