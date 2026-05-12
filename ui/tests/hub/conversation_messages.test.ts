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
    const conv = new Conversation({ title: `pong-${Date.now()}` });
    await conv.save();
    await conv.share([bobEmail!]);
    expect(conv.remote).toBe(true);

    // 2. Reactive tap on incoming flow_messages for THIS conversation. Alice
    //    increments bob's number and sends back. Loop exits at STOP_AT.
    const log: { who: string; kind: string; n: number; t: number }[] = [];
    const tStart = Date.now();
    const done = new Promise<void>((resolve) => {
      const off = conv.on('message', (m: FlowMessage) => {
        const text = (m.text || '').trim();
        if (!/^\d+$/.test(text)) return;
        const n = parseInt(text, 10);
        log.push({ who: 'alice', kind: 'rx', n, t: Date.now() - tStart });
        if (n >= STOP_AT) {
          off();
          resolve();
          return;
        }
        const next = n + 1;
        log.push({ who: 'alice', kind: 'tx', n: next, t: Date.now() - tStart });
        void conv.addMessage(String(next));
        if (next >= STOP_AT) {
          off();
          resolve();
        }
      });
    });

    // 3. Ignite. Wait briefly for bob to accept+join before firing the
    //    first message — bob's polling cycle is ~500ms.
    await new Promise((r) => setTimeout(r, 2000));
    log.push({ who: 'alice', kind: 'tx', n: 1, t: Date.now() - tStart });
    await conv.addMessage('1');

    await done;

    const rxNums = log.filter((e) => e.kind === 'rx').map((e) => e.n);
    expect(Math.max(...rxNums)).toBeGreaterThanOrEqual(STOP_AT - 1);
    expect(rxNums.every((n) => n % 2 === 0)).toBe(true);

    console.log(`\nping-pong reached ${Math.max(...rxNums)} in ${Date.now() - tStart}ms`);
    console.log(`alice rx: [${rxNums.join(', ')}]`);

    void dataContext; void dataManager;
  }, 30_000);
});
