/**
 * BOB side of the two-process HTTP+WS reflection proxy test.
 * Companion: ``rename.alice.test.ts``.
 *
 * Bob is a member (not owner), so he cannot rename the shared conversation — the
 * hub authorizes field updates to the owner only. Bob plays two roles:
 *
 *   (a) Independent cross-validator — he reads the **hub** directly and confirms
 *       that each of alice's renames (one reflected over HTTP, one over WS)
 *       landed on the hub. This proves the proxy carried the write. [passes]
 *
 *   (b) Cross-user receiver (spec point 6) — he taps his OWN local conversation
 *       entity and asserts the new title arrives over **his own UI WS**, with no
 *       hub read and no re-fetch: hub fan-out → bob's bridge → save(notify) →
 *       local data_op → SDK cache. This is the true end-to-end chain
 *       (alice → alice local server → hub → bob local server → bob client).
 *       It FAILS today: the hub fans membership + flow_message events to
 *       participants but NOT generic conversation field updates, so the rename
 *       never becomes a data_op_msg on bob's bridge. The assertion is kept (not
 *       skipped) precisely so the gap is visible and flips to green the day the
 *       hub fans conversation updates. Mirrors how matrix.bob receives alice's
 *       *messages* over the same path (which the hub does fan).
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
import { hubConversationTitle, hubConversationWatchers, hubLogin } from './_hub';
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

    // Materialize locally, then tap bob's LOCAL conversation entity for live
    // updates pushed over his own UI WS. ``watch()`` registers the backend-side
    // watch so the local data_op routes to this connection; ``subscribe()``
    // records each pushed entity version. A cross-user rename only lands here if
    // the hub fans the field update to bob and his bridge materializes it.
    const conv = await pollUntil(
      () => Conversation.getById<Conversation>(convId),
      10_000,
      'conversation materialized',
    );
    const offWatch = await conv.watch();
    let observedTitle: string | null = null;
    const offSub = conv.subscribe((u) => {
      if (u) observedTitle = (u as Conversation).title ?? observedTitle;
    });

    // Put the conversation in bob's browser context as the active entity — the
    // exact call the real app makes on conversation open (load-conversation.ts).
    // The SDK's (now self-contained) context reporter mirrors it to bob's
    // backend, where BrowserContextWatch registers a HUB watch for this remote
    // conversation so the hub will fan alice's update back to bob. Barrier on
    // the hub's watcher list so the watch is live BEFORE we signal JOINED (i.e.
    // before alice renames) — closes the register-vs-rename race.
    await dataContext.setActiveEntityTypeId(conv.typeId);
    await pollUntil(
      async () => {
        const w = await hubConversationWatchers(bobToken!, convId);
        return (w?.length ?? 0) > 0;
      },
      15_000,
      'bob backend registered a hub watch (ConnectedThrough) on the conversation',
    );
    console.log('[rename.bob] hub watch registered via browser context');

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

    // ── (b) The real cross-user assertion (spec point 6). ─────────────────
    // Bob must RECEIVE alice's rename over his OWN local WS — no hub read, no
    // re-fetch — purely via hub fan-out → bob's bridge → save(notify) → local
    // data_op → SDK cache (``observedTitle``). The hub already proved it holds
    // ``wsName`` (above), so a failure here isolates the missing hop exactly:
    // the hub is NOT fanning the conversation field update to participants.
    let receivedOverWs: string | null = null;
    try {
      // 6s grace: by the time bob's hub-GET above returned wsName, the hub had
      // already processed alice's update — so any participant fan-out would have
      // been emitted already; this only needs to cover bridge → local broadcast
      // → SDK. Kept well under the 30s testTimeout cap (do not raise either).
      receivedOverWs = await pollUntil(
        () => (observedTitle === wsName ? observedTitle : null),
        6_000,
        'bob received alice rename over his local WS (cross-user push)',
      );
    } finally {
      offSub();
      await offWatch().catch(() => {});
    }
    expect(receivedOverWs).toBe(wsName);
    console.log(`[rename.bob] received alice's rename over local WS → ${receivedOverWs}`);

    void dataContext;
  });
});
