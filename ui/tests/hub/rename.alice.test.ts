/**
 * ALICE side of the two-process HTTP+WS reflection proxy test.
 * Companion: ``rename.bob.test.ts``.
 *
 * Alice OWNS the conversation, so she drives both renames — one per transport —
 * because the hub authorizes conversation field updates to the owner only (a
 * member's reflected PUT is correctly rejected 401, which itself proves the proxy
 * carried the request to the hub). Bob, a member, cross-validates each rename by
 * reading the hub independently.
 *
 *   1. alice creates + shares a conversation, inviting bob.
 *   2. alice renames over **HTTP** (Hub-Reflect header) → HTTP proxy reflects the
 *      PUT to the hub. (bob confirms it on the hub — companion file.)
 *   3. alice renames over **WS** (rest_api_msg + hub_reflect) → WS proxy reflects
 *      the PUT to the hub. (bob confirms it on the hub.)
 *
 * Hub state is the assertion surface (a proxy's job is to land the write on the
 * hub); the local backend↔backend fan-out bridge is orthogonal and not relied on.
 *
 * Run:
 *   VITE_API_URL=http://localhost:<alice-be> RENAME_BOB_EMAIL=<bob>@local.test \
 *     RENAME_ALICE_EMAIL=<alice>@local.test RENAME_ALICE_PASSWORD=<pw> \
 *     npm run test:vitest:hub -- rename.alice
 */
import { promises as fsp } from 'node:fs';

import { config, dataContext } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testEntityName, trackForCleanup } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { hubConversationTitle, hubLogin } from './_hub';
import {
  clearRendezvous,
  pollUntil,
  probeHub,
  probeLocalBackendLoggedIn,
  waitMarker,
  writeRendezvous,
} from './_matrix';

const JOINED = '/tmp/flowpad_rename_joined.txt';
const HTTP_DONE = '/tmp/flowpad_rename_http_done.txt';
const HTTP_CONFIRMED = '/tmp/flowpad_rename_http_confirmed.txt'; // bob → alice (saw HTTP rename)
const WS_DONE = '/tmp/flowpad_rename_ws_done.txt';

let skipReason: string | null = null;
let bobEmail: string | null = null;
let aliceToken: string | null = null;

beforeAll(async () => {
  const hub = await probeHub();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    console.log('[rename.alice] skip:', skipReason);
    return;
  }
  const backend = await probeLocalBackendLoggedIn(config.SERVER_URL);
  if (!backend.ok) {
    skipReason = `alice backend (${config.SERVER_URL}) is not cloud-logged-in`;
    console.log('[rename.alice] skip:', skipReason);
    return;
  }
  bobEmail = process.env.RENAME_BOB_EMAIL || null;
  const aEmail = process.env.RENAME_ALICE_EMAIL;
  const aPass = process.env.RENAME_ALICE_PASSWORD;
  if (!bobEmail || !aEmail || !aPass) {
    skipReason = 'set RENAME_BOB_EMAIL + RENAME_ALICE_EMAIL + RENAME_ALICE_PASSWORD';
    console.log('[rename.alice] skip:', skipReason);
    return;
  }
  aliceToken = (await hubLogin(aEmail, aPass)).token;
  console.log(`[rename.alice] ready: backend=${backend.email} inviting=${bobEmail}`);
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

describe('hub: rename two-process — ALICE (owner: HTTP + WS reflect, hub-verified)', () => {
  it('renames over HTTP then WS; both reflect to the hub', async () => {
    await clearRendezvous();
    for (const f of [JOINED, HTTP_DONE, HTTP_CONFIRMED, WS_DONE]) await fsp.unlink(f).catch(() => {});

    const conv = trackForCleanup(new Conversation({ title: testEntityName('conv') }));
    await conv.save();
    await conv.share([bobEmail!]);
    expect(conv.remote).toBe(true);

    const httpName = `http-${conv.id.slice(0, 8)}`;
    const wsName = `ws-${conv.id.slice(0, 8)}`;

    await writeRendezvous(conv.id);
    console.log(`[rename.alice] conv ${conv.id.slice(0, 8)} shared + published`);

    // Wait for bob to join (so he can read the conv on the hub).
    await waitMarker(JOINED, conv.id, 'bob-joined marker');

    // ── HTTP rename → HTTP proxy (reflection). ────────────────────────────
    await conv.rename(httpName); // HTTP PUT, Hub-Reflect: true
    expect(
      await pollUntil(
        async () => ((await hubConversationTitle(aliceToken!, conv.id)) === httpName ? httpName : null),
        15_000,
        `hub holds HTTP rename ${httpName}`,
      ),
    ).toBe(httpName);
    console.log(`[rename.alice] HTTP rename reflected to hub → ${httpName}`);
    await fsp.writeFile(HTTP_DONE, conv.id, 'utf-8');

    // Gate: wait until bob has observed the HTTP rename on the hub before the WS
    // rename overwrites the title (otherwise bob can miss the intermediate value).
    await waitMarker(HTTP_CONFIRMED, conv.id, 'bob confirmed HTTP rename');

    // ── WS rename → WS proxy (rest_api_msg reflection). ───────────────────
    await conv.rename(wsName, { overWs: true }); // WS rest_api_msg, hub_reflect: true
    expect(
      await pollUntil(
        async () => ((await hubConversationTitle(aliceToken!, conv.id)) === wsName ? wsName : null),
        15_000,
        `hub holds WS rename ${wsName}`,
      ),
    ).toBe(wsName);
    console.log(`[rename.alice] WS rename reflected to hub → ${wsName} — done`);
    await fsp.writeFile(WS_DONE, conv.id, 'utf-8');

    void dataContext;
  });
});
