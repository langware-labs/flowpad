/**
 * BOB side of the two-process HTTP+WS reflection proxy test.
 * Companion: ``rename.alice.test.ts``.
 *
 * Bob is a member (not owner), so he cannot rename the shared conversation — the
 * hub authorizes field updates to the owner only. Bob's role here is the
 * independent cross-validator: he reads the **hub** directly and confirms that
 * each of alice's renames — one reflected over HTTP, one over WS — landed on the
 * hub. Two clients, two transports, hub-verified.
 *
 * Run:
 *   VITE_API_URL=http://localhost:<bob-be> RENAME_BOB_EMAIL=<bob>@local.test \
 *     RENAME_BOB_PASSWORD=<pw> npm run test:vitest:hub -- rename.bob
 */
import { promises as fsp } from 'node:fs';

import { config, dataContext } from '@sdk';
import { Conversation, acceptInvitation, fetchConversations } from '@sdk/entities/conversation';
import { Invitation } from '@sdk/entities/invitation';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { hubConversationTitle, hubLogin } from './_hub';
import { pollUntil, probeHub, probeLocalBackendLoggedIn, readRendezvous, waitMarker } from './_matrix';

const JOINED = '/tmp/flowpad_rename_joined.txt';
const HTTP_DONE = '/tmp/flowpad_rename_http_done.txt';
const HTTP_CONFIRMED = '/tmp/flowpad_rename_http_confirmed.txt';
const WS_DONE = '/tmp/flowpad_rename_ws_done.txt';

let skipReason: string | null = null;
let bobEmail: string | null = null;
let bobToken: string | null = null;

beforeAll(async () => {
  const hub = await probeHub();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    console.log('[rename.bob] skip:', skipReason);
    return;
  }
  const backend = await probeLocalBackendLoggedIn(config.SERVER_URL);
  if (!backend.ok) {
    skipReason = `bob backend (${config.SERVER_URL}) is not cloud-logged-in`;
    console.log('[rename.bob] skip:', skipReason);
    return;
  }
  bobEmail = process.env.RENAME_BOB_EMAIL || backend.email || null;
  const bPass = process.env.RENAME_BOB_PASSWORD;
  if (!bobEmail || !bPass) {
    skipReason = 'set RENAME_BOB_EMAIL + RENAME_BOB_PASSWORD';
    console.log('[rename.bob] skip:', skipReason);
    return;
  }
  bobToken = (await hubLogin(bobEmail, bPass)).token;
  console.log(`[rename.bob] ready: backend=${bobEmail}`);
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

async function findPendingInvitation(convId: string): Promise<Invitation | null> {
  await fetchConversations();
  const all = await Invitation.query<Invitation>({ query: {} }, true);
  const exact = all.find((inv) => !inv.accepted && (inv.target_url_path || '').includes(convId));
  if (exact) return exact;
  const mine = all
    .filter((inv) => !inv.accepted && inv.recipient_email === bobEmail)
    .sort((a, b) => String(b.created_date ?? '').localeCompare(String(a.created_date ?? '')));
  return mine[0] ?? null;
}

describe('hub: rename two-process — BOB (cross-validates HTTP + WS on the hub)', () => {
  it('confirms both of alice\'s renames (HTTP, then WS) on the hub', async () => {
    const convId = await readRendezvous(25_000);
    const httpName = `http-${convId.slice(0, 8)}`;
    const wsName = `ws-${convId.slice(0, 8)}`;
    console.log(`[rename.bob] conv id: ${convId.slice(0, 8)}`);

    const invitation = await pollUntil(
      () => findPendingInvitation(convId),
      25_000,
      'pending invitation for conv',
    );
    const accepted = await acceptInvitation({ invitation_id: invitation.id! });
    expect(accepted.invitation_id).toBe(invitation.id);
    console.log('[rename.bob] invitation accepted + joined');

    // Materialize locally (sanity), then signal alice that bob is a participant.
    await pollUntil(() => Conversation.getById<Conversation>(convId), 10_000, 'conversation materialized');
    await fsp.writeFile(JOINED, convId, 'utf-8');

    // ── Confirm alice's HTTP rename on the hub. ───────────────────────────
    await waitMarker(HTTP_DONE, convId, 'alice http-done marker');
    expect(
      await pollUntil(
        async () => ((await hubConversationTitle(bobToken!, convId)) === httpName ? httpName : null),
        15_000,
        `hub holds alice's HTTP rename ${httpName}`,
      ),
    ).toBe(httpName);
    console.log(`[rename.bob] confirmed alice's HTTP rename on hub → ${httpName}`);
    // Tell alice it's safe to do the WS rename (which overwrites the title).
    await fsp.writeFile(HTTP_CONFIRMED, convId, 'utf-8');

    // ── Confirm alice's WS rename on the hub. ─────────────────────────────
    await waitMarker(WS_DONE, convId, 'alice ws-done marker');
    expect(
      await pollUntil(
        async () => ((await hubConversationTitle(bobToken!, convId)) === wsName ? wsName : null),
        15_000,
        `hub holds alice's WS rename ${wsName}`,
      ),
    ).toBe(wsName);
    console.log(`[rename.bob] confirmed alice's WS rename on hub → ${wsName} — done`);

    void dataContext;
  });
});
