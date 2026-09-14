/**
 * A chat on an agent's REMOTE deployment, from the desktop backend.
 *
 * The verbs are the ordinary ones — `useDeployment`, `getById`, `prompt`,
 * `loadHistory`, the queue — and the SDK never learns the process is remote:
 * the local backend opened it through the hub and adopted the hub's process at
 * its id as a route row (`remote: true`), relaying every action from there.
 *
 * Needs a live hub with an agent already deployed on it, seeded OUTSIDE this
 * test (a deploy is a real box: create + boot + clone + index — tens of
 * seconds, never a test's job). Skips cleanly without the two ids:
 *
 *   REMOTE_AGENT_ID=<agent uuid> REMOTE_DEPLOYMENT_ID=<deployment uuid>
 *   FLOW_INSTANCE=<owned instance, cloud-logged-in> npm run test:vitest:long -- remote_agent_chat
 *
 * Backend = FLOW_INSTANCE. Spawns no local worker — the turn runs on the box.
 */
import { Agent, AgenticProcess, QueryRequest, isBusy } from '@sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const AGENT_ID = process.env.REMOTE_AGENT_ID?.trim() ?? '';
const DEPLOYMENT_ID = process.env.REMOTE_DEPLOYMENT_ID?.trim() ?? '';
const TURN_MS = 60_000;

describe.skipIf(!AGENT_ID || !DEPLOYMENT_ID)('remote agent chat — the same verbs, one tier away', () => {
  let ap: AgenticProcess | null = null;
  let unwatch: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo());
  }, 60_000);

  afterAll(async () => {
    try {
      await unwatch?.();
    } catch {
      /* best-effort */
    }
  });

  it(
    'opens the session through the hub and adopts the process at the hub id',
    async () => {
      const agent = await Agent.getById<Agent>(AGENT_ID);
      expect(agent, `agent ${AGENT_ID} on this backend`).toBeTruthy();

      const receipt = await agent!.useDeployment(DEPLOYMENT_ID);
      expect(receipt.deployment_id).toBe(DEPLOYMENT_ID);

      ap = await AgenticProcess.getById<AgenticProcess>(receipt.process_id);
      expect(ap, 'the route row is readable at the id the hub minted').toBeTruthy();
      expect((ap as any).hub_route, 'a route row, not a local worker').toBe(true);
      expect(ap!.deployment_id).toBe(DEPLOYMENT_ID);
      expect(ap!.pty_mode).toBe(false);
      unwatch = ap!.watch ? await ap!.watch() : null;
    },
    120_000,
  );

  it(
    'streams a relayed turn and settles back to ready',
    async () => {
      const token = `PONG${ap!.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
      const before = ap!.flowDataStream.items.length;
      await ap!.prompt(`Reply with exactly the word ${token} and nothing else.`);

      // The ASSISTANT's rows only: the prompt itself carries the token, so a
      // reply that is an error would still match a dump of every item.
      const replies = () =>
        ap!.flowDataStream.items
          .slice(before)
          .filter((i: any) => i.elementType === 'chat' && (i.attributes?.role ?? i.role) === 'assistant')
          .map((i: any) => String(i.content ?? ''))
          .join('\n');
      await vi.waitFor(() => expect(replies()).toContain(token), { timeout: TURN_MS, interval: 500 });
      // the projection refresh after the stream is the WS data_op the panel keys on
      await vi.waitFor(() => expect(isBusy(ap!)).toBe(false), { timeout: TURN_MS, interval: 500 });

      const liveChat = ap!.flowDataStream.items.filter((i: any) => i.elementType === 'chat').length;
      await ap!.loadHistory({ force: true });
      await ap!.loadHistory({ force: true }); // twice on purpose: a reload must be idempotent
      const afterChat = ap!.flowDataStream.items.filter((i: any) => i.elementType === 'chat').length;
      expect(afterChat, `history reload converged (live=${liveChat}, after=${afterChat})`).toBe(liveChat);
    },
    120_000,
  );

  it('is listed as a past session of that exact deployment', async () => {
    const rows = await AgenticProcess.query<AgenticProcess>(
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        query: { deployment_id: DEPLOYMENT_ID },
        name: 'remote-agent-chat-sessions',
      }),
      true,
    );
    expect(rows.map((r) => r.id)).toContain(ap!.id);
  });
});
