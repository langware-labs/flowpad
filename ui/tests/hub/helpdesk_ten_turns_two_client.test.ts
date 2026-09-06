/**
 * A support conversation, ten turns each way, two real SDK clients in one
 * process (realm per instance — see `_instances.ts`):
 *
 *   SHARE_INST_1 = the REQUESTER (opens the ticket, keeps asking)
 *   SHARE_INST_2 = the HELPER   (a member of the deployment's desk, answers)
 *
 * Every hop is the SDK call the product makes:
 *   - the requester opens the ticket with `startHelpdeskTicket` and follows
 *     up with `sendReply` — the composer on a hub-mirrored conversation;
 *   - the helper reads the ticket through a `helpdesk` DataSource (the "+"
 *     on the channels line) and answers with `sendToChannel` — the composer
 *     on a channel conversation, which picks the ticket up and posts;
 *   - the requester catches up with `fetchConversations`.
 *
 * What it proves, per turn: the requester's line reaches the helper's inbox
 * as a channel message (`origin.kind === 'helpdesk'`), the helper's answer
 * reaches the hub masked to the desk brand, and the requester sees that
 * answer under the brand, never the helper's name. At the end both inboxes
 * hold the same twenty hub messages, one row each.
 *
 * Uses the deployment's canonical desk (`/health/version`), because a
 * requester's `startHelpdeskTicket` resolves the desk server-side; the helper
 * must therefore be on `HELPDESK_STAFF_EMAILS`. Set HELPDESK_KEEP=1 to leave
 * the helper's source (and so the projected rows) in place for a look in the
 * browser afterwards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getAliceCreds,
  getBobCreds,
  HELPDESK_DISPLAY_NAME,
  hubAvailable,
  hubDefaultDeskId,
  hubJson,
  hubLogin,
} from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as REQUESTER_INSTANCE,
  HUB_INST_2 as HELPER_INSTANCE,
  getInstance,
  instanceAvailable,
  postApi,
  queryConversationMessages,
  type ResolvedInstance,
} from './_instances';

const TURNS = 10;
const KEEP = process.env.HELPDESK_KEEP === '1';

const REQUESTER_LINES = [
  'my printer jams on every second page',
  'it is an HP LaserJet, the tray-2 one',
  'yes, the paper is the 80gsm we always use',
  'I opened the back door, there is nothing stuck',
  'the rollers look shiny, is that bad?',
  'ok, I wiped them with a damp cloth',
  'better: now it jams every fifth page',
  'firmware says 2024.09 — is that current?',
  'updating now, it is rebooting',
  'ten pages in a row, no jam. thank you!',
];
const HELPER_LINES = [
  'sorry to hear that — which model is it?',
  'thanks. is the paper in tray 2 the usual weight?',
  'good. can you open the rear door and check for scraps?',
  'then it is likely the pickup rollers — do they look glossy?',
  'glossy means worn. wipe them with a damp lint-free cloth first',
  'great — try a ten-page print and tell me what happens',
  'progress. one more thing: what firmware is it on?',
  'no, there is a 2025.03 with a feed fix — please update',
  'take your time, it takes about four minutes',
  'glad it is sorted. I will close the ticket — write back any time',
];

let skipReason: string | null = null;
let requester: ResolvedInstance;
let helper: ResolvedInstance;
let helperToken = '';
let helperUserId = '';
let requesterUserId = '';
let deskId = '';

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(REQUESTER_INSTANCE) || !instanceAvailable(HELPER_INSTANCE)) {
    return void (skipReason = `launch ${REQUESTER_INSTANCE} + ${HELPER_INSTANCE} via scripts/instance_ctl.sh`);
  }
  const requesterCreds = await getAliceCreds();
  const helperCreds = await getBobCreds();
  if (!requesterCreds || !helperCreds) return void (skipReason = 'missing canonical ALICE/BOB credentials');
  // Order matters: each call re-evaluates the SDK graph into its own realm.
  requester = await getInstance(REQUESTER_INSTANCE);
  helper = await getInstance(HELPER_INSTANCE);
  const helperAuth = await hubLogin(helper.email, helperCreds.password);
  helperToken = helperAuth.token;
  helperUserId = helperAuth.user.id;
  requesterUserId = (await hubLogin(requester.email, requesterCreds.password)).user.id;

  deskId = (await hubDefaultDeskId()) ?? '';
  if (!deskId) return void (skipReason = 'the hub advertises no help desk');
  // The helper must be desk staff: the pool route is members-only.
  await hubJson(helperToken, `/graph/project/${deskId}/helpdesk_conversations`).catch(() => {
    skipReason = `${helper.email} is not a member of the canonical desk (HELPDESK_STAFF_EMAILS)`;
  });
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

const rowsOf = queryConversationMessages;

const hubMessages = (convId: string): Promise<any[]> => hubJson(helperToken, `/graph/conversation/${convId}/flow_message`);

const fromRequester = (m: any): boolean => [requesterUserId, `helpdesk:${requesterUserId}`].includes(m.sender_id);

let source: any = null;
afterAll(async () => {
  if (source && !KEEP) await source.delete();
});

/** Shared across the turn tests: one ticket, one helper source. Each turn
 *  is its own test so the file honours the hub tier's per-test cap without
 *  touching it — a turn is a few seconds, ten of them are not. */
let convId = '';
const ts = Date.now();

describe('a ten-turn support conversation', () => {
  it('the helper attaches the desk', async () => {
    // The create the "+" on the channels line does: no explicit owner, so the
    // backend files it under the local user — whose channels line then wears
    // the desk's mark.
    source = new helper.sdk.DataSource({
      name: 'desk (ten turns)',
      provider: 'helpdesk',
      config: { desk_project_id: deskId },
      status: 'new',
    });
    await source.save();
    expect(source.id).toBeTruthy();
  });

  for (let turn = 1; turn <= TURNS; turn++) {
    it(`turn ${turn}: the requester asks, the helper answers, both see it`, async () => {
      expect(source?.id, 'the desk source exists').toBeTruthy();
      const ask = `[${ts}] ${REQUESTER_LINES[turn - 1]}`;
      const answer = `[${ts}] ${HELPER_LINES[turn - 1]}`;

      // Requester: open the ticket, then follow up in it.
      if (turn === 1) {
        convId = (await requester.sdk.startHelpdeskTicket(ask)).conversation_id;
      } else {
        expect(convId, 'the ticket exists').toBeTruthy();
        await requester.sdk.sendReply({ conversationId: convId }, ask);
      }

      // Helper: the line lands in the inbox — through the hub mirror once the
      // ticket is picked up, and the desk source's poll stamps the channel on
      // it (or projects it outright on the first turn). Wait for the stamp.
      await postApi(helper.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
      const inbound: any = await pollUntil(
        async () => (await rowsOf(helper, convId)).find((m) => m.text === ask && m.origin?.kind === 'helpdesk') ?? null,
        15_000,
        `turn ${turn}: the requester's line reached the helper's inbox as a channel message`,
      );
      // The projection names an external sender `<channel>:<id>`; the hub
      // mirror writes the bare hub id. Either way it is the requester.
      expect(fromRequester(inbound), `turn ${turn}: sent by the requester`).toBe(true);

      // Helper answers from the composer; the hub masks it to the desk brand.
      await helper.sdk.sendToChannel(convId, answer);
      const onHub: any = await pollUntil(
        async () => (await hubMessages(convId)).find((m) => m.text === answer) ?? null,
        10_000,
        `turn ${turn}: the answer reached the hub`,
      );
      expect(onHub.sender_id).toBe(helperUserId);
      expect(onHub.sender_name).toBe(HELPDESK_DISPLAY_NAME);

      // Requester sees the answer under the brand, not the helper's name.
      const seen: any = await pollUntil(
        async () => {
          await requester.sdk.fetchConversations();
          return (await rowsOf(requester, convId)).find((m) => m.text === answer) ?? null;
        },
        15_000,
        `turn ${turn}: the answer reached the requester`,
      );
      expect(seen.sender_name).toBe(HELPDESK_DISPLAY_NAME);
    });
  }

  it('both inboxes hold exactly the hub\'s twenty messages, one row each', async () => {
    expect(convId, 'the ticket exists').toBeTruthy();
    const hubIds = (await hubMessages(convId)).map((m) => m.id).sort();
    expect(hubIds).toHaveLength(TURNS * 2);

    await postApi(helper.apiUrl, `/graph/data_source/${source.id}/request_poll`, {});
    const helperRows: any[] = await pollUntil(
      async () => {
        const rows = await rowsOf(helper, convId);
        return rows.length === hubIds.length ? rows : null;
      },
      15_000,
      "the helper's inbox holds every hub message",
    );
    expect(helperRows.map((m) => m.id).sort()).toEqual(hubIds);

    const requesterIds = await pollUntil(
      async () => {
        await requester.sdk.fetchConversations();
        const ids = (await rowsOf(requester, convId)).map((m) => m.id).sort();
        return ids.length === hubIds.length ? ids : null;
      },
      15_000,
      "the requester's inbox holds every hub message",
    );
    expect(requesterIds).toEqual(hubIds);

    // …and ten of them are the requester's, arrived through the channel.
    expect(helperRows.filter((m) => m.origin?.kind === 'helpdesk' && fromRequester(m))).toHaveLength(TURNS);
    if (KEEP) console.log(`[helpdesk_ten_turns] kept: conversation ${convId}, source ${source.id}`);
  });
});
