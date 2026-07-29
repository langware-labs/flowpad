/**
 * Two-instance e2e for the normal staged → review → project-install contract
 * used by shared Claude transcripts.
 *
 * Sender (INST_1) shares a real on-disk claude session into a conversation via
 * the production send path (`add_message` + `asset_references`, then
 * `upload_body`). Receiver (INST_2) accepts the invitation, downloads the
 * bundle, and the assertions below pin the explicit project-install contract.
 *
 * Requires the local hub (8093) + two instances launched via instance_ctl and
 * named through SHARE_INST_1/SHARE_INST_2 (+ ALICE/BOB creds). Skips otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { testEntityName, trackForCleanup } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  postApi,
  queryMessageAttachments,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let snd: ResolvedInstance;
let rcv: ResolvedInstance;
const receiverProjects: Array<{ id: string; dir: string }> = [];
const receiverSessionIds = new Set<string>();

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    return;
  }
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`;
    return;
  }
  snd = await getInstance(INST_1);
  rcv = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(async () => {
  if (rcv) {
    for (const id of receiverSessionIds) {
      await fetch(`${rcv.apiUrl}/api/v1/graph/claude_session/${id}`, { method: 'DELETE' }).catch(() => null);
    }
    for (const project of receiverProjects) {
      await fetch(`${rcv.apiUrl}/api/v1/graph/project/${project.id}`, { method: 'DELETE' }).catch(() => null);
    }
  }
  for (const project of receiverProjects) {
    rmSync(project.dir, { recursive: true, force: true });
  }
});

/** A real session id from this machine's ~/.claude/projects (any non-empty
 *  JSONL). The share path indexes it on the sender (`_ensure_claude_session_rows`)
 *  and packs its whitelisted header. */
function pickLocalSessionId(): string | null {
  const root = path.join(homedir(), '.claude', 'projects');
  try {
    for (const dir of readdirSync(root)) {
      const abs = path.join(root, dir);
      for (const f of readdirSync(abs)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(abs, f);
        if (statSync(p).size > 10_000) return path.basename(f, '.jsonl');
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function receiverSession(id: string): Promise<any | null> {
  const response = await fetch(`${rcv.apiUrl}/api/v1/graph/claude_session/${id}`);
  const body = await response.json().catch(() => null);
  return response.ok && body?.status === 'SUCCESS' ? body.data : null;
}

describe('transcript share — staged project-install pipeline across two instances', () => {
  it('receiver stages, reviews, and installs the claude_session into a project', async () => {
    const sessionId = pickLocalSessionId();
    expect(sessionId, 'a real ~/.claude session transcript is required').toBeTruthy();
    receiverSessionIds.add(sessionId!);

    // ── Sender: share a conversation carrying the transcript ref. ──
    const conv = trackForCleanup(new snd.sdk.Conversation({ title: testEntityName('transcript-conv') }));
    await conv.save();
    await conv.share([rcv.email]);
    expect(conv.remote).toBe(true);

    const fmId = (
      await postApi(snd.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
        message: 'a transcript for you',
        asset_references: [`claude_session-${sessionId}`],
      })
    ).data.flow_message_id as string;
    const upload = await postApi(snd.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {});
    expect(upload.data?.body_status).toBe('ready');

    // ── Receiver: accept, wait for READY, download the bundle. ──
    const invitation = await pollUntil(
      () => findPendingInvitation(rcv, conv.id),
      20_000,
      'pending invitation on receiver',
    );
    await rcv.sdk.acceptInvitation({ invitation_id: invitation.id! });
    const receivedFm = await pollUntil(
      async () => {
        const fm = (await rcv.sdk.FlowMessage.getById(fmId).catch(() => null)) as any;
        return fm && fm.body_status === 'ready' ? fm : null;
      },
      20_000,
      'shared message READY on receiver',
    );
    await postApi(rcv.apiUrl, `/graph/flow_message/${receivedFm.id}/download_body`, {});

    // Download only stages the attachment. Claude sessions have no
    // receive_policy='auto', so the review gate must choose a project before
    // the entity is materialized.
    const ma = await pollUntil(
      async () => {
        const rows = await queryMessageAttachments(rcv, fmId);
        return rows.find((r) => r.asset_type === 'claude_session' && r.asset_id === sessionId) ?? null;
      },
      10_000,
      'staged MessageAttachment on receiver',
    );
    expect(ma.scope || null).toBeNull();
    expect(ma.project_id || null).toBeNull();
    expect(ma.installed_at || null).toBeNull();
    expect(await receiverSession(sessionId!)).toBeNull();

    const projectDir = mkdtempSync(path.join(tmpdir(), 'flowpad-e2e-transcript-'));
    const project = new rcv.sdk.Project({
      name: testEntityName('transcript-project'),
      fs_storage_mount_path: projectDir,
    } as any);
    await project.save();
    receiverProjects.push({ id: project.id!, dir: projectDir });

    const install = await postApi(rcv.apiUrl, `/graph/message_attachment/${ma.id}/install`, {
      scope: 'project',
      project_id: project.id,
    });
    expect(install.status).toBe('SUCCESS');

    const sess = await pollUntil(
      () => receiverSession(sessionId!),
      10_000,
      'claude_session row on receiver after explicit install',
    );
    const installedMa = await pollUntil(
      async () => {
        const rows = await queryMessageAttachments(rcv, fmId);
        const row = rows.find((r) => r.id === ma.id);
        return row?.scope === 'project' ? row : null;
      },
      10_000,
      'installed MessageAttachment on receiver',
    );

    expect(installedMa.project_id).toBe(project.id);
    expect(installedMa.installed_at).toBeTruthy();
    expect(sess.received).toBe(true);
    expect(sess.remote).toBe(false);
    expect(sess.project_id).toBe(project.id);
    expect(existsSync(path.join(projectDir, '.claude', 'transcripts', `${sessionId}.jsonl`))).toBe(true);
  });
});
