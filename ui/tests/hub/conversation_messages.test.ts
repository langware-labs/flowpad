/**
 * Alice side of the two-vitest ping-pong: share + invite + counter loop.
 *
 * Identical loop on both sides: rx number → tx number+1. Alice ignites with
 * "1". Stops when STOP_AT is reached. Companion is
 * flowpad-app/ui/tests/hub/bob_accept.test.ts.
 *
 * Pure SDK on this side — no raw hub fetches. Alice drives everything via
 * her local backend (config.SERVER_URL → 9008):
 *   - ``new Conversation().save() + .share([bobEmail])`` for create + invite
 *   - ``conv.on('message', cb)`` for the receive tap
 *   - ``conv.addMessage(text)`` for sends
 */
import { config, dataContext, dataManager } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import type { FlowMessage } from '@sdk/entities/flow-message';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { testEntityName, trackForCleanup } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { getBobCreds, hubAvailable, localBackendIsCloudLoggedIn } from './_hub';

const STOP_AT = 20;
let skipReason: string | null = null;
let bobEmail: string | null = null;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    return;
  }
  if (!(await localBackendIsCloudLoggedIn(config.SERVER_URL))) {
    skipReason = 'local backend is not cloud-logged-in (run `flowpad cloud login`)';
    return;
  }
  const bob = await getBobCreds();
  if (!bob) {
    skipReason = 'missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-app/.env.local';
    return;
  }
  bobEmail = bob.email;
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

describe(`hub: alice + bob ping-pong loop to ${STOP_AT}`, () => {
  it('alice ignites and increments on every reply from bob', async () => {
    // 1. Create conv + invite bob via the SDK. The companion bob test polls
    //    his pending invitations and accepts this one within ~seconds.
    const conv = trackForCleanup(new Conversation({ title: testEntityName('conv') }));
    await conv.save();
    await conv.share([bobEmail!]);
    expect(conv.remote).toBe(true);

    // Publish the conv id via a rendezvous file so bob's vitest can target
    // THIS run's invitation, not a stale one with matching recipient email
    // from a prior run.
    const fs = await import('node:fs/promises');
    await fs.writeFile('/tmp/flowpad_pingpong_conv.txt', conv.id, 'utf-8');

    // 2. Reactive tap on incoming flow_messages for THIS conversation. Alice
    //    increments bob's number and sends back. Loop exits at STOP_AT.
    const log: { who: string; kind: string; n: number; t: number }[] = [];
    const tStart = Date.now();
    const seen = new Set<number>();
    const done = new Promise<void>((resolve) => {
      const off = conv.on('message', (m: FlowMessage) => {
        const text = (m.text || '').trim();
        if (!/^\d+$/.test(text)) return;
        const n = parseInt(text, 10);
        // De-dupe: each hub frame is delivered to the local TS SDK twice
        // (the fanout CREATE and the bridge's explicit local CREATE
        // emission). Acting on the dup makes the loop send each reply
        // twice and confuses the symmetric counter.
        if (seen.has(n)) return;
        seen.add(n);
        // Sender-echo awareness: the SDK delivers alice's OWN sends back on
        // this tap too (the local materialize CREATE the UI renders own
        // messages from). Alice's numbers are odd — react only to bob's
        // evens, otherwise each echo forks a parallel counter chain. The "0"
        // handshake is the ready-gate's job, not the counter's.
        if (n % 2 !== 0 || n === 0) return;
        log.push({ who: 'alice', kind: 'rx', n, t: Date.now() - tStart });
        if (n >= STOP_AT) {
          off();
          resolve();
          return;
        }
        const next = n + 1;
        log.push({ who: 'alice', kind: 'tx', n: next, t: Date.now() - tStart });
        // Await the final send so bob has time to receive STOP_AT before
        // vitest tears the WS down.
        (async () => {
          await conv.addMessage(String(next));
          if (next >= STOP_AT) {
            off();
            resolve();
          }
        })();
      });
    });

    // 3. Ignite — but only after bob has joined as a hub-side participant.
    //    We can't see participants via GET (api_invisible), so we wait for
    //    bob to publish his presence as the first non-ignite ``add_message``
    //    he sends after accepting. Workaround: bob is configured to send a
    //    handshake "0" right after his join. Alice waits for that, then
    //    ignites with "1". (Bob's "0" arrives via her own ``on('message')``
    //    tap, so this is consistent with the realtime path.)
    const ready = new Promise<void>((resolve) => {
      const offReady = conv.on('message', (m: FlowMessage) => {
        if ((m.text || '').trim() === '0') {
          offReady();
          resolve();
        }
      });
    });
    await ready;
    log.push({ who: 'alice', kind: 'tx', n: 1, t: Date.now() - tStart });
    await conv.addMessage('1');

    await done;

    const rxNums = log.filter((e) => e.kind === 'rx').map((e) => e.n);
    expect(Math.max(...rxNums)).toBeGreaterThanOrEqual(STOP_AT - 1);
    expect(rxNums.every((n) => n % 2 === 0)).toBe(true);

    console.log(`\nping-pong reached ${Math.max(...rxNums)} in ${Date.now() - tStart}ms`);
    console.log(`alice rx: [${rxNums.join(', ')}]`);

    void dataContext; void dataManager;
  }, 10_000);
});
