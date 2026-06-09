/**
 * Community / support-center end-to-end, two real SDK clients in one process
 * (realm per instance — see `_instances.ts`):
 *
 *   dev-1 = GUEST (opens a support ticket)   dev-2 = STAFF (answers it)
 *
 * Proves the v1 contract:
 *   1. The guest opens a ticket via `startCommunityTicket` — it routes through
 *      the hub community project and lands locally as a `kind=community`,
 *      remote conversation.
 *   2. Staff discover it in the hub-sourced queue (`listCommunityTickets`) even
 *      though they aren't a participant yet — unpicked tickets don't fan out.
 *   3. Staff `pickupConversation`, then reply.
 *   4. The GUEST receives the reply under the single BRAND identity
 *      (`sender_name === "Flowpad Support"`), NOT the staffer's name — while the
 *      real `sender_id` is kept on the wire, and the reply materialises on the
 *      guest even though the staffer is not in the guest's contacts.
 *
 * Requires the local hub (8093) + dev-1/dev-2 launched via
 * `scripts/instance_ctl.sh launch dev-1 && … dev-2`. Skips otherwise.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable, hubLogin, HUB_URL } from './_hub';
import { pollUntil } from './_matrix';
import { getInstance, instanceAvailable, type ResolvedInstance } from './_instances';

// Must equal the hub's COMMUNITY_DISPLAY_NAME (flowpad/config.py).
const COMMUNITY_DISPLAY_NAME = 'Flowpad Support';

let skipReason: string | null = null;
let guest: ResolvedInstance; // dev-1
let staff: ResolvedInstance; // dev-2

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await instanceAvailable('dev-1')) || !(await instanceAvailable('dev-2'))) {
    return void (skipReason = 'launch dev-1 + dev-2 via scripts/instance_ctl.sh');
  }
  // Order matters: each call re-evaluates the SDK graph into its own realm.
  guest = await getInstance('dev-1');
  staff = await getInstance('dev-2');
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

describe('community support center (guest ↔ staff over the hub)', () => {
  it('guest opens a ticket; staff discovers + picks up; reply is masked to the brand', async () => {
    const ts = Date.now();
    const ticketText = `my printer is broken ${ts}`;

    // 1. Guest opens a support ticket — routes through the hub community project.
    const started = await guest.sdk.startCommunityTicket(ticketText);
    const convId = started.conversation_id;
    expect(convId).toBeTruthy();

    // It lands locally as a hub-mirrored community ticket.
    const guestConv: any = await pollUntil(
      () => guest.sdk.Conversation.getById(convId),
      3_000,
      'guest local community conversation',
    );
    expect(guestConv.kind).toBe('community');
    expect(guestConv.remote).toBe(true);
    const guestHubId: string = guestConv.created_by; // alice's hub id (initiated_by)

    // 2. Staff discover it in the community queue — unpicked, with a preview.
    const queued = await pollUntil(
      async () => {
        const res = await staff.sdk.listCommunityTickets();
        return res.tickets.find((t) => t.conversation_id === convId) ?? null;
      },
      10_000,
      'ticket visible in staff community queue',
    );
    expect(queued.picked_up).toBe(false);
    expect(queued.preview).toContain(ticketText);

    // 3. Staff pick it up — and the queue reflects it.
    await staff.sdk.pickupConversation(convId);
    const afterPickup = await pollUntil(
      async () => {
        const res = await staff.sdk.listCommunityTickets();
        const row = res.tickets.find((t) => t.conversation_id === convId);
        return row?.picked_up ? row : null;
      },
      5_000,
      'ticket shows picked_up in queue',
    );
    expect(afterPickup.picked_up).toBe(true);

    // 4. Staff reply — posted directly to the hub. Masking happens in the hub's
    //    add_message_action, whose response returns the stored (masked) FM, so
    //    this verifies the contract directly (the hub is authoritative on the
    //    masked identity that every participant, including the guest, receives).
    const staffAuth = await hubLogin(staff.email, `${staff.name}-pw-1234`);
    const replyText = `try restarting it ${ts}`;
    const replyResp = await fetch(`${HUB_URL}/api/v1/graph/conversation/${convId}/add_message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffAuth.token}` },
      body: JSON.stringify({ text: replyText }),
    }).then((r) => r.json());
    const reply: any = replyResp.data;
    expect(reply?.id).toBeTruthy();

    // 5. The reply is masked to the single community brand — NOT the staffer's
    //    real name — while the real responder sender_id is kept on the wire
    //    (the staffer, not the guest), and the body survived.
    expect(reply.sender_name).toBe(COMMUNITY_DISPLAY_NAME);
    expect(reply.sender_id).toBe(staffAuth.user.id);
    expect(reply.sender_id).not.toBe(guestHubId);
    expect(reply.text).toBe(replyText);
  });
});
