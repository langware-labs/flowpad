/**
 * Playwright encoding of `helpdesk_source_round_trip.md` — the BINDING criterion
 * (steps 4–5): a staff reply sent through the staff instance's channel path
 * reaches the hub masked to the desk brand, the ticket is picked up, and the
 * staff instance's copy of the conversation holds exactly the two hub message
 * ids (no twin). Steps 1, 3 (the mark and the chip) and 6–7 are browser-visual
 * and stay in the runbook.
 *
 * In scope: hub REST as both identities; the STAFF instance's backend API for
 * the source and the conversation. Requires QA_HUB_URL (no localhost fallback),
 * QA_STAFF_API_URL (the staff instance backend), and QA_STAFF_* / QA_GUEST_*
 * credentials; skips when the staff backend is not named.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';

const HUB = process.env.QA_HUB_URL || '';
const STAFF_API = process.env.QA_STAFF_API_URL || '';
const STAFF_EMAIL = process.env.QA_STAFF_EMAIL || 'dev-2@local.test';
const STAFF_PW = process.env.QA_STAFF_PW || 'dev-2-pw-1234';
const GUEST_EMAIL = process.env.QA_GUEST_EMAIL || 'dev-1@local.test';
const GUEST_PW = process.env.QA_GUEST_PW || 'dev-1-pw-1234';
const DISPLAY_NAME = 'Manual Support';

async function hubLogin(rq: APIRequestContext, email: string, pw: string): Promise<{ token: string; id: string }> {
  const res = await rq.post(`${HUB}/api/v1/login`, { data: { email, password: pw } });
  expect(res.status(), `hub login ${email}`).toBe(200);
  const d = (await res.json()).data;
  return { token: d.token ?? d.api_key, id: d.user.id };
}

/** A conversation's pointers are `{typeid: "flow_message-<id>", ts}`; the ids alone, sorted. */
const pointerIds = (raw: unknown): string[] =>
  JSON.parse((raw as string) || '[]').map((p: any) => String(p.typeid || '').replace(/^flow_message-/, '')).sort();

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

async function until<T>(fn: () => Promise<T | null>, label: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out: ${label}`);
}

test('binding criterion: a guest ticket answered from the staff inbox through the desk source', async () => {
  test.skip(!STAFF_API, 'set QA_STAFF_API_URL to the staff instance backend (e.g. http://localhost:6002) to run.');
  if (!HUB) throw new Error('QA_HUB_URL is not set — no localhost fallback.');
  test.setTimeout(60_000);
  // Each identity owns its own cookie jar (the hub accepts JWT cookies too).
  const staffRq = await pwRequest.newContext();
  const guestRq = await pwRequest.newContext();
  const staff = await hubLogin(staffRq, STAFF_EMAIL, STAFF_PW);
  const guest = await hubLogin(guestRq, GUEST_EMAIL, GUEST_PW);
  const ts = Date.now();

  // Setup: the desk is staff's own project for this run.
  const desk = (await (await staffRq.post(`${HUB}/api/v1/graph/project`, { ...auth(staff.token), data: { name: `desk-manual-${ts}` } })).json()).data.id;
  expect((await staffRq.post(`${HUB}/api/v1/graph/project/${desk}/enable_helpdesk`, { ...auth(staff.token), data: { enabled: true, display_name: DISPLAY_NAME, mode: 'human' } })).status()).toBe(200);
  let sourceId = '';
  try {
    // Step 1 (API form): staff attach the desk — what the "+" on the inbox line creates.
    const created = await (await staffRq.post(`${STAFF_API}/api/v1/graph/data_source`, { data: { name: 'desk-manual', provider: 'helpdesk', config: { desk_project_id: desk }, status: 'new', owner: `user-${staff.id}` } })).json();
    sourceId = created.data.id;

    // Step 2: the guest opens a ticket.
    const ticket = (await (await guestRq.post(`${HUB}/api/v1/graph/project/${desk}/start_guest_conversation`, { ...auth(guest.token), data: { text: `my printer is broken ${ts}` } })).json()).data.id;

    // Step 3: the staff instance polls it; the ticket is a local conversation with the hub's id.
    await staffRq.post(`${STAFF_API}/api/v1/graph/data_source/${sourceId}/request_poll`, { data: {} });
    await until(async () => {
      const r = await staffRq.get(`${STAFF_API}/api/v1/graph/conversation/${ticket}`);
      if (r.status() !== 200) return null;
      // The conversation appears first; the reply needs the guest's MESSAGE projected too.
      const body: any = await r.json();
      return JSON.parse(body.data?.message_ids || '[]').length > 0 ? body : null;
    }, 'ticket projected on the staff instance');

    // Step 4: reply through the channel path (what the composer calls).
    const replyText = `try restarting it ${ts}`;
    const sent = await staffRq.post(`${STAFF_API}/api/v1/graph/conversation/${ticket}/send_external`, { data: { text: replyText } });
    expect(sent.status()).toBe(200);
    const reply = await until(async () => {
      const msgs: any[] = (await (await staffRq.get(`${HUB}/api/v1/graph/conversation/${ticket}/flow_message`, auth(staff.token))).json()).data ?? [];
      return msgs.find((m) => m.text === replyText) ?? null;
    }, 'reply reached the hub');
    expect(reply.sender_name).toBe(DISPLAY_NAME);
    expect(reply.sender_id).toBe(staff.id);
    const pool: any[] = (await (await staffRq.get(`${HUB}/api/v1/graph/project/${desk}/helpdesk_conversations`, auth(staff.token))).json()).data ?? [];
    expect(pool.find((r) => r.conversation_id === ticket)?.picked_up).toBe(true);

    // Step 5: the sent copy converges — exactly the two hub ids, no twin.
    await staffRq.post(`${STAFF_API}/api/v1/graph/data_source/${sourceId}/request_poll`, { data: {} });
    const hubIds = ((await (await staffRq.get(`${HUB}/api/v1/graph/conversation/${ticket}/flow_message`, auth(staff.token))).json()).data ?? []).map((m: any) => m.id).sort();
    const local = await until(async () => {
      const r: any = await (await staffRq.get(`${STAFF_API}/api/v1/graph/conversation/${ticket}`)).json();
      const ids: string[] = pointerIds(r.data?.message_ids);
      return ids.length === hubIds.length ? ids : null;
    }, 'local conversation holds both hub messages');
    expect(local).toEqual(hubIds);
  } finally {
    if (sourceId) await staffRq.delete(`${STAFF_API}/api/v1/graph/data_source/${sourceId}`);
    await staffRq.delete(`${HUB}/api/v1/graph/project/${desk}`, { ...auth(staff.token), data: {} });
  }
});
