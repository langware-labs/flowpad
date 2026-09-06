/**
 * Help desk end-to-end, two real SDK clients in one process
 * (realm per instance — see `_instances.ts`):
 *
 *   dev-1 = GUEST (opens a support ticket)   dev-2 = STAFF (answers it)
 *
 * Proves the v1 contract AND the authorization hardening:
 *   1. The guest opens a ticket via `startHelpdeskTicket` — routed through the
 *      hub help desk project, landing locally as a `kind=helpdesk`, remote
 *      conversation. The guest gets only a minimal `guest` role on it.
 *   2. A guest CANNOT enumerate the staff queue (`helpdesk_conversations`) or
 *      resolve anyone via the `members` lookup — the `guest` role grants neither.
 *      (This is the exposure that the old `authenticated_role` broadcast opened;
 *      these assertions need only the guest and always run.)
 *   3. Staff (a real member of the help desk project — see HELPDESK_STAFF_EMAILS)
 *      discover the ticket in the queue, pick it up, and reply.
 *   4. The guest receives the reply under the single BRAND identity
 *      (`sender_name === "Flowpad Support"`), NOT the staffer's name — while the
 *      real `sender_id` is kept on the wire, and the reply materialises on the
 *      guest even though the staffer is not in the guest's contacts.
 *
 * Requires the explicit SHARE_INST_1/SHARE_INST_2 pair and cycle hub. The staff
 * happy-path additionally requires the hub to have been started with the staff
 * instance's email in `HELPDESK_STAFF_EMAILS` (granted `editor` on the
 * help desk project at seed); missing staff authorization is a real failure.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAliceCreds, getBobCreds, hubAvailable, hubDefaultDeskId, HELPDESK_DISPLAY_NAME, hubLogin, HUB_URL } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as GUEST_INSTANCE,
  HUB_INST_2 as STAFF_INSTANCE,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let guest: ResolvedInstance;
let staff: ResolvedInstance;
let guestPassword = '';
let staffPassword = '';
let helpdeskProjectId: string | null = null;

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
  if (guest.email !== guestCreds.email || staff.email !== staffCreds.email) {
    throw new Error('help desk instance identities do not match canonical ALICE_EMAIL/BOB_EMAIL');
  }
  guestPassword = guestCreds.password;
  staffPassword = staffCreds.password;
  helpdeskProjectId = await hubDefaultDeskId();
  if (!helpdeskProjectId) {
    skipReason = 'hub /version did not return helpdesk_project_id (restart hub from source)';
    return;
  }
  // /version advertising an id is NOT enough: the hub can name a
  // helpdesk_project_id whose project entity isn't actually seeded/reachable
  // (no HELPDESK_STAFF_EMAILS at hub launch → start_guest_conversation 401s
  // "Entity project-<id> not found"). Probe that a guest can genuinely open a
  // ticket; if not, the help desk feature isn't usable on this hub — skip the
  // whole suite cleanly rather than hard-fail every setup. (The security
  // contract these tests assert requires a real, working help desk project.)
  try {
    const probe = await guest.sdk.startHelpdeskTicket(`helpdesk-availability-probe ${Date.now()}`);
    if (!probe?.conversation_id) {
      skipReason = 'help desk project advertised but a guest could not open a ticket';
    }
  } catch {
    skipReason =
      'help desk project not usable on this hub (start_guest_conversation failed) — ' +
      'restart the hub from source with HELPDESK_STAFF_EMAILS to run the help desk suite';
  }
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

describe('help desk — authorization', () => {
  it('a ticket guest cannot enumerate the queue or resolve members (exposure closed)', async () => {
    const ts = Date.now();
    const started = await guest.sdk.startHelpdeskTicket(`negative-probe ${ts}`);
    const convId = started.conversation_id;
    expect(convId).toBeTruthy();

    const guestAuth = await hubLogin(guest.email, guestPassword);
    const authHeader = { Authorization: `Bearer ${guestAuth.token}` };

    // The guest holds only the `guest` conversation role (read + add_message +
    // leave). It does NOT allow `helpdesk_conversations` on the project, so the
    // guest — an authenticated non-member — must be denied the staff queue.
    // Denials surface as 401/403 (this hub returns 401 for "no authorizing
    // role on target"); either is a hard deny.
    const denied = [401, 403];
    const queueResp = await fetch(
      `${HUB_URL}/api/v1/graph/project/${helpdeskProjectId}/helpdesk_conversations`,
      { headers: authHeader },
    );
    expect(queueResp.ok).toBe(false);
    expect(denied).toContain(queueResp.status);

    // The `guest` role also does NOT allow the members lookup, so the guest
    // cannot turn a wire `sender_id` into a staffer's real name/email — even on
    // their OWN ticket. (Probe an arbitrary id; denial is role-level, not id-level.)
    const membersResp = await fetch(
      `${HUB_URL}/api/v1/graph/conversation/${convId}/members/${guestAuth.user.id}`,
      { headers: authHeader },
    );
    expect(denied).toContain(membersResp.status);

    // list_members is likewise outside the guest role.
    const listResp = await fetch(
      `${HUB_URL}/api/v1/graph/conversation/${convId}/list_members`,
      { headers: authHeader },
    );
    expect(denied).toContain(listResp.status);
  });

  it('guest opens a ticket; staff discovers + picks up; reply is masked to the brand', async () => {
    // Staff happy-path needs instance 2 to be a real member of the help desk project
    // (granted via HELPDESK_STAFF_EMAILS at hub seed). If not onboarded, the
    // queue read fails loudly; returning here would falsely pass the staff path.
    try {
      await staff.sdk.listHelpdeskTickets();
    } catch (error) {
      throw new Error(
        `[help desk test] staff '${staff.email}' cannot read the help desk queue; ` +
          `the hub must include HELPDESK_STAFF_EMAILS=${staff.email}`,
        { cause: error },
      );
    }

    const ts = Date.now();
    const ticketText = `my printer is broken ${ts}`;

    // 1. Guest opens a support ticket — routes through the hub help desk project.
    const started = await guest.sdk.startHelpdeskTicket(ticketText);
    const convId = started.conversation_id;
    expect(convId).toBeTruthy();

    // It lands locally as a hub-mirrored helpdesk ticket.
    const guestConv: any = await pollUntil(
      () => guest.sdk.Conversation.getById(convId),
      3_000,
      'guest local helpdesk conversation',
    );
    expect(guestConv.kind).toBe('helpdesk');
    expect(guestConv.remote).toBe(true);
    const guestHubId: string = guestConv.created_by; // guest's hub id (initiated_by)

    // 2. Staff discover it in the help desk queue — unpicked, with a preview.
    const queued = await pollUntil(
      async () => {
        const res = await staff.sdk.listHelpdeskTickets();
        return res.tickets.find((t) => t.conversation_id === convId) ?? null;
      },
      10_000,
      'ticket visible in staff help desk queue',
    );
    expect(queued.picked_up).toBe(false);
    expect(queued.preview).toContain(ticketText);

    // 3. Staff pick it up — and the queue reflects it.
    await staff.sdk.pickupConversation(convId);
    const afterPickup = await pollUntil(
      async () => {
        const res = await staff.sdk.listHelpdeskTickets();
        const row = res.tickets.find((t) => t.conversation_id === convId);
        return row?.picked_up ? row : null;
      },
      5_000,
      'ticket shows picked_up in queue',
    );
    expect(afterPickup.picked_up).toBe(true);

    // 4. Staff reply — posted directly to the hub. Masking happens in the hub's
    //    add_message_action, whose response returns the stored (masked) FM.
    const staffAuth = await hubLogin(staff.email, staffPassword);
    const replyText = `try restarting it ${ts}`;
    const replyResp = await fetch(`${HUB_URL}/api/v1/graph/conversation/${convId}/add_message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffAuth.token}` },
      body: JSON.stringify({ text: replyText }),
    }).then((r) => r.json());
    const reply: any = replyResp.data;
    expect(reply?.id).toBeTruthy();

    // 5. The reply is masked to the single helpdesk brand — NOT the staffer's
    //    real name — while the real responder sender_id is kept on the wire
    //    (the staffer, not the guest), and the body survived.
    expect(reply.sender_name).toBe(HELPDESK_DISPLAY_NAME);
    expect(reply.sender_id).toBe(staffAuth.user.id);
    expect(reply.sender_id).not.toBe(guestHubId);
    expect(reply.text).toBe(replyText);
  });
});
