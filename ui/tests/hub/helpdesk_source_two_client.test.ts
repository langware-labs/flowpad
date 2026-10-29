/**
 * Help desk as a MESSAGE SOURCE, two real SDK clients in one process
 * (realm per instance — see `_instances.ts`):
 *
 *   dev-1 = GUEST (opens a ticket)   dev-2 = STAFF (owns a desk, attaches it)
 *
 * The sibling `helpdesk_two_client.test.ts` proves the pool + pickup contract.
 * This one proves the stream inbox contract that replaced the Help Desk pill:
 *   1. Staff attach the desk as a `helpdesk` DataSource (the "+" on the
 *      channels line does the same create), owned by the staff user.
 *   2. The guest opens a ticket; after the staff source polls it, the ticket is
 *      an ORDINARY stream inbox conversation on the staff side — the hub conversation
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
// The state chips' labels go through Lingui: activate the source locale, as main.tsx does.
import '@src/i18n-init';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDesk,
  getAliceCreds,
  getBobCreds,
  hubAvailable,
  hubDefaultDeskId,
  hubJson,
  hubLogin,
  HELPDESK_DISPLAY_NAME,
} from './_hub';
import {
  conversationFacets,
  deskChipLabel,
  ticketChip,
  type CategoryInputs,
} from '@src/components/conversation/conversation-category';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as GUEST_INSTANCE,
  HUB_INST_2 as STAFF_INSTANCE,
  getInstance,
  instanceAvailable,
  postApi,
  queryConversationMessages,
  type ResolvedInstance,
  heldDeskSourceId,
} from './_instances';

const DISPLAY_NAME = 'Source Test Support';

let skipReason: string | null = null;
let guest: ResolvedInstance;
let staff: ResolvedInstance;
let staffToken = '';
let staffUserId = '';
let guestToken = '';
let guestUserId = '';
let deskId = '';
let disposeDesk: () => Promise<void> = async () => {};
let defaultDeskId: string | null = null;

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
  guestUserId = guestAuth.user.id;

  // Staff's own desk for this run.
  ({ deskId, dispose: disposeDesk } = await createDesk(staffToken, DISPLAY_NAME));
  // The deployment's own desk — its case runs only when this hub advertises one.
  defaultDeskId = await hubDefaultDeskId();
}, 30_000);

afterAll(() => disposeDesk());

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

const messagesOf = (convId: string): Promise<any[]> => queryConversationMessages(staff, convId);
describe('help desk as a message source', () => {
  it('a guest ticket lands in the staff stream inbox as a conversation; the composer reply comes back masked', async () => {
    const ts = Date.now();

    // 1. Staff attach the desk — the same create the "+" on the channels line does.
    let source = new staff.sdk.DataSource({
      name: 'test desk',
      provider: 'helpdesk',
      config: { desk_project_id: deskId },
      status: 'new',
      owner: `user-${staffUserId}`,
    });
    // Staff already hold their desk's source (ensure_sources): the create answers with that row.
    // A create for a desk staff already hold answers with THEIR row (ensure_sources made it):
    // only a source this test made is this test's to delete.
    const heldId = await heldDeskSourceId(staff.apiUrl, String(source.config?.desk_project_id ?? ''));
    const ownSource = !heldId;
    source = heldId ? ((await staff.sdk.DataSource.getById(heldId)) ?? source) : ((await source.save()) ?? source);

    try {
      // 2. The guest opens a ticket over the hub, as a requester's app does.
      const ticket = await hubJson(guestToken, `/graph/project/${deskId}/start_guest_conversation`, {
        text: `my printer is broken ${ts}`,
      });
      const convId: string = ticket.id;
      expect(convId).toBeTruthy();

      // The staff source polls it — `request_poll` is the attention lane (5s), `poll_now` only queues for the next heartbeat.
      await postApi(staff.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
      const conv: any = await pollUntil(
        () => staff.sdk.Conversation.getById(convId),
        15_000,
        'ticket projected into the staff stream inbox as the hub conversation',
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
          const msgs: any[] = await hubJson(staffToken, `/graph/conversation/${convId}/messages`);
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
      if (ownSource) await source.delete();
    }
  });
});

// ── State chips, both sides: waiting → picked → closed, and a reply after close (D6/D7) ──
// The chips are derived by the SAME pure rules the rows render (`conversationFacets` →
// `ticketChip`, `deskChipLabel` for the source chip), fed the real data each side holds.

/** The pool row for one ticket — closed ones included, as the staff source reads it. */
async function poolRow(desk: string, convId: string): Promise<any> {
  const rows: any[] = await hubJson(staffToken, `/graph/project/${desk}/helpdesk_conversations?include_closed=true`);
  return rows.find((r) => r.conversation_id === convId) ?? null;
}

function chipLabel(inp: CategoryInputs): string | null {
  const f = conversationFacets(inp);
  return f.ticket ? ticketChip(f.ticket).label : null;
}

describe.each([
  { label: 'customer desk', deskName: DISPLAY_NAME, desk: () => deskId },
  { label: 'default Flowpad desk', deskName: HELPDESK_DISPLAY_NAME, desk: () => defaultDeskId },
])("help desk state chips — $label", ({ desk }) => {
  it('staff: desk chip + Not picked up → Picked up by you → Closed; requester: Waiting → Picked up → Closed; a reply after close stays Closed and unread', async (context: any) => {
    const theDesk = desk();
    if (!theDesk) return context.skip();
    const ts = Date.now();
    const staffViewer = { email: staff.email, cloudUserId: staffUserId, localUserId: null };

    // Staff already hold the desk's source, named after the desk (ensure_sources); a create under
    // another name answers with that row, so its name is the desk's.
    let source = new staff.sdk.DataSource({
      name: `state chips ${ts}`,
      provider: 'helpdesk',
      config: { desk_project_id: theDesk },
      status: 'new',
      owner: `user-${staffUserId}`,
    });
    // A create for a desk staff already hold answers with THEIR row (ensure_sources made it):
    // only a source this test made is this test's to delete.
    const heldId = await heldDeskSourceId(staff.apiUrl, String(source.config?.desk_project_id ?? ''));
    const ownSource = !heldId;
    source = heldId ? ((await staff.sdk.DataSource.getById(heldId)) ?? source) : ((await source.save()) ?? source);
    // The staff row's source chip names the desk — never the bare "Support".
    const deskLabel = deskChipLabel(String(source.name ?? ''));
    expect(deskLabel).toMatch(/ help desk$/);
    expect(deskLabel).not.toBe('Support');

    const ticket = await hubJson(guestToken, `/graph/project/${theDesk}/start_guest_conversation`, {
      text: `state chips ${ts}`,
    });
    const convId: string = ticket.id;
    try {
      const guestConv = async () => (await hubJson(guestToken, `/graph/conversation/${convId}`));
      const staffConv = async () => {
        await postApi(staff.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
        return pollUntil(() => staff.sdk.Conversation.getById(convId), 15_000, 'ticket on the staff side');
      };
      const staffLabel = async () => {
        const row = await poolRow(theDesk, convId);
        const conv: any = await staffConv();
        return chipLabel({ conv, viewer: staffViewer, staffView: true, pickedUpBy: row?.picked_up_by ?? [] });
      };
      const guestLabel = async () =>
        chipLabel({
          conv: await guestConv(),
          viewer: { email: guest.email, cloudUserId: guestUserId, localUserId: null },
          staffView: false,
        });

      // 1. Unpicked.
      expect(await staffLabel()).toBe('Not picked up');
      expect(await guestLabel()).toBe('Waiting for pickup');

      // 2. Staff pick it up.
      await hubJson(staffToken, `/graph/conversation/${convId}/pickup`, {});
      expect(
        await pollUntil(
          async () => ((await staffLabel()) === 'Picked up by you' ? true : null),
          15_000,
          'staff: Picked up by you',
        ),
      ).toBe(true);
      expect(
        await pollUntil(
          async () => ((await guestLabel()) === 'Picked up' ? true : null),
          10_000,
          'requester: Picked up',
        ),
      ).toBe(true);

      // 3. Closed — both sides say so, and the ticket is still listed (D7).
      await hubJson(guestToken, `/graph/conversation/${convId}/close`, {});
      expect(
        await pollUntil(async () => ((await staffLabel()) === 'Closed' ? true : null), 15_000, 'staff: Closed'),
      ).toBe(true);
      expect(await guestLabel()).toBe('Closed');
      expect(await poolRow(theDesk, convId)).not.toBeNull();

      // 4. D6: the guest replies to the closed ticket — it stays closed, and the reply
      //    arrives on the staff side as a new, unread message.
      const replyText = `one more thing ${ts}`;
      await hubJson(guestToken, `/graph/conversation/${convId}/add_message`, { text: replyText });
      const latest: any = await pollUntil(
        async () => {
          await postApi(staff.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
          return (await messagesOf(convId)).find((m) => m.text === replyText) ?? null;
        },
        15_000,
        'the post-close reply reached the staff side',
      );
      const conv: any = await staffConv();
      const f = conversationFacets({ conv, latestMessage: latest, viewer: staffViewer, staffView: true });
      expect(f.isUnread).toBe(true);
      expect(f.ticket && ticketChip(f.ticket).label).toBe('Closed');
    } finally {
      await hubJson(guestToken, `/graph/conversation/${convId}/close`, {}).catch(() => undefined);
      if (ownSource) await source.delete();
    }
  }, 120_000);
});
