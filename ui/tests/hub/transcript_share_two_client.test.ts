/**
 * Two-instance e2e for receive_policy='auto' — a shared ClaudeTranscript rides
 * the ONE staged→install pipeline with the review gate waived (feat b1e88c7a).
 *
 * Sender (INST_1) shares a real on-disk claude session into a conversation via
 * the production send path (`add_message` + `asset_references`, then
 * `upload_body`). Receiver (INST_2) accepts the invitation, downloads the
 * bundle, and the assertions below pin the auto-install contract.
 *
 * Requires the local hub (8093) + two instances launched via instance_ctl and
 * named through SHARE_INST_1/SHARE_INST_2 (+ ALICE/BOB creds). Skips otherwise.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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

describe('transcript share — auto-install pipeline across two instances', () => {
  it('receiver auto-installs the staged claude_session row (no review gate, no project)', async () => {
    const sessionId = pickLocalSessionId();
    expect(sessionId, 'a real ~/.claude session transcript is required').toBeTruthy();

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
    const receivedFm = await pollUntil(async () => {
      const fm = (await rcv.sdk.FlowMessage.getById(fmId).catch(() => null)) as any;
      return fm && fm.body_status === 'ready' ? fm : null;
    }, 20_000, 'shared message READY on receiver');
    await postApi(rcv.apiUrl, `/graph/flow_message/${receivedFm.id}/download_body`, {});

    // Both observations follow the same download/install event — poll them
    // concurrently so wall time is the slower poll, not the sum.
    const [ma, sess] = await Promise.all([
      pollUntil(async () => {
        const rows = await queryMessageAttachments(rcv, fmId);
        return rows.find((r) => r.asset_type === 'claude_session' && r.asset_id === sessionId) ?? null;
      }, 10_000, 'auto-installed MessageAttachment on receiver'),
      pollUntil(
        async () =>
          (await rcv.sdk.dataManager
            .getByTypeId(new rcv.sdk.TypeId('claude_session', sessionId!))
            .catch(() => null)) as any,
        10_000,
        'claude_session row on receiver',
      ),
    ]);

    // 'auto' waives review, not the pipeline: the MA is already installed at
    // user scope with NO project (scope inherits live via the parent-chain
    // fallback), and the row materialized with the receive overrides (the
    // chip-flip/live-announce surface itself is covered by
    // asset_share_index_matrix + the chip unit tests).
    expect(ma.scope).toBe('user');
    expect(ma.project_id || null).toBeNull();
    expect(sess.received).toBe(true);
    expect(sess.remote).toBe(false);
    expect(sess.project_id || null).toBeNull();
  });
});
