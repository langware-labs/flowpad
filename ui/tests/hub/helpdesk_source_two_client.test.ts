/**
 * Help desk as a MESSAGE SOURCE, two real SDK clients in one process
 * (realm per instance — see `_instances.ts`):
 *
 *   dev-1 = GUEST (opens a ticket)   dev-2 = STAFF (owns a desk, attaches it)
 *
 * The sibling `helpdesk_two_client.test.ts` proves the pool + pickup contract.
 * This one proves the inbox contract that replaced the Help Desk pill:
 *   1. Staff attach the desk as a `helpdesk` DataSource (the "+" on the
 *      channels line does the same create), owned by the staff user.
 *   2. The guest opens a ticket; after the staff source polls it, the ticket is
 *      an ORDINARY inbox conversation on the staff side — the hub conversation
 *      id itself, with the guest's message carrying `origin.kind === 'helpdesk'`.
 *   3. Staff reply the way the composer does — `sendToChannel` → send_external →
 *      the driver — which picks the ticket up and posts; the hub masks the
 *      reply to the desk brand.
 *   4. The staff source ingests its own reply onto the hub's message id: one
 *      row per message, no twin beside the hub mirror.
 *
 * The desk is created by staff for this run and deleted after, so nothing here
 * depends on HELPDESK_STAFF_EMAILS or the deployment's canonical desk.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDesk, getAliceCreds, getBobCreds, hubAvailable, hubJson, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as GUEST_INSTANCE,
  HUB_INST_2 as STAFF_INSTANCE,
  getInstance,
  instanceAvailable,
  postApi,
  type ResolvedInstance,
} from './_instances';

const DISPLAY_NAME = 'Source Test Support';

let skipReason: string | null = null;
let guest: ResolvedInstance;
let staff: ResolvedInstance;
let staffToken = '';
let staffUserId = '';
let guestToken = '';
let deskId = '';
let disposeDesk: () => Promise<void> = async () => {};

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(GUEST_INSTANCE) || !instanceAvailable(STAFF_INSTANCE)) {
    return void (skipReason = `launch ${GUEST_INSTANCE} + ${STAFF_INSTANCE} via scripts/instance_ctl.sh`);
  }
  const guestCreds = await getAliceCreds();
  const staffCreds = await getBobCreds();
  if (!guestCreds || !staffCreds) return void (skipReason = 'missing canonical ALICE/BOB credentials');
  // Order matters: each call re-evaluates the SDK graph into its own realm.
  guest = await getInstance(GUEST_INSTANCE);
  staff = await getInstance(STAFF_INSTANCE);
  const staffAuth = await hubLogin(staff.email, staffCreds.password);
  const guestAuth = await hubLogin(guest.email, guestCreds.password);
  staffToken = staffAuth.token;
  staffUserId = staffAuth.user.id;
  guestToken = guestAuth.token;

  // Staff's own desk for this run.
  ({ deskId, dispose: disposeDesk } = await createDesk(staffToken, DISPLAY_NAME));
}, 30_000);

afterAll(() => disposeDesk());

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

/** The staff instance's rows for a conversation, read fresh (cache bypassed). */
const messagesOf = (convId: string): Promise<any[]> =>
  staff.sdk.FlowMessage.query(new staff.sdk.QueryRequest({ query: { conversation_id: convId }, scope: [] }), true);

describe('help desk as a message source', () => {
  it('a guest ticket lands in the staff inbox as a conversation; the composer reply comes back masked', async () => {
    const ts = Date.now();

    // 1. Staff attach the desk — the same create the "+" on the channels line does.
    const source = new staff.sdk.DataSource({
      name: 'test desk',
      provider: 'helpdesk',
      config: { desk_project_id: deskId },
      status: 'new',
      owner: `user-${staffUserId}`,
    });
    await source.save();

    try {
      // 2. The guest opens a ticket over the hub, as a requester's app does.
      const ticket = await hubJson(guestToken, `/graph/project/${deskId}/start_guest_conversation`, { text: `my printer is broken ${ts}` });
      const convId: string = ticket.id;
      expect(convId).toBeTruthy();

      // The staff source polls it — `request_poll` is the attention lane (5s), `poll_now` only queues for the next heartbeat.
      await postApi(staff.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
      const conv: any = await pollUntil(
        () => staff.sdk.Conversation.getById(convId),
        15_000,
        'ticket projected into the staff inbox as the hub conversation',
      );
      expect(conv.id).toBe(convId);
      const inbound: any = await pollUntil(
        async () => {
          const rows: any[] = await messagesOf(convId);
          return rows.find((m) => m.origin?.kind === 'helpdesk') ?? null;
        },
        10_000,
        'the guest message carries origin.kind=helpdesk',
      );
      expect(inbound.sender_id).toBeTruthy();

      // 3. Reply the way the composer does: the channel path (`send_external`,
      //    what `sendToChannel` calls).
      const replyText = `try restarting it ${ts}`;
      const sent = await postApi(staff.apiUrl, `/graph/conversation/${convId}/send_external`, { text: replyText });
      expect(sent.status, JSON.stringify(sent).slice(0, 200)).toBe('SUCCESS');
      const reply: any = await pollUntil(
        async () => {
          const msgs: any[] = await hubJson(staffToken, `/graph/conversation/${convId}/flow_message`);
          return msgs.find((m) => m.text === replyText) ?? null;
        },
        10_000,
        'the reply reached the hub',
      );
      expect(reply.sender_id).toBe(staffUserId);
      expect(reply.sender_name).toBe(DISPLAY_NAME);
      const pool: any[] = await hubJson(staffToken, `/graph/project/${deskId}/helpdesk_conversations`);
      expect(pool.find((r) => r.conversation_id === convId)?.picked_up).toBe(true);

      // 4. The sent copy ingests onto the hub's id — no twin.
      await postApi(staff.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
      const rows: any[] = await pollUntil(
        async () => {
          const all: any[] = await messagesOf(convId);
          return all.some((m) => m.id === reply.id) ? all : null;
        },
        15_000,
        'the sent copy landed on the hub message id',
      );
      expect(rows.map((m) => m.id).sort()).toEqual([inbound.id, reply.id].sort());
    } finally {
      await source.delete();
    }
  });
});
