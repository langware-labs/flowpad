/**
 * Live-hub validation of the new header/body interface from the TS SDK side.
 *
 * Companion to tests/hub_tests/test_body_upload_download.py — same contract,
 * different language. Hits the hub at config.HUB_URL via the SDK plus a few
 * direct alice-token POSTs to exercise the attachment-bearing add_message
 * shape (the SDK's addMessage helper only carries text today; that surface
 * grows in Phase B).
 */
import { config, dataContext, dataManager } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import {
  BODY_FILENAME,
  BodyStatus,
  FlowMessage,
  type IFlowMessage,
} from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import {
  HUB_URL,
  getAliceCreds,
  getBobCreds,
  hubAvailable,
  hubLogin,
  localBackendIsCloudLoggedIn,
} from './_hub';

let skipReason: string | null = null;
let aliceToken: string | null = null;
let bobEmail: string | null = null;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    return;
  }
  if (!(await localBackendIsCloudLoggedIn(config.SERVER_URL))) {
    skipReason = 'local backend is not cloud-logged-in';
    return;
  }
  const alice = await getAliceCreds();
  const bob = await getBobCreds();
  if (!alice || !bob) {
    skipReason = 'missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD}';
    return;
  }
  aliceToken = (await hubLogin(alice.email, alice.password)).token;
  bobEmail = bob.email;
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

async function hubGetFm(fmId: string): Promise<IFlowMessage> {
  const r = await fetch(`${HUB_URL}/api/v1/graph/flow_message/${fmId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  if (!r.ok) throw new Error(`hub GET FM ${fmId} returned ${r.status}: ${await r.text()}`);
  return (await r.json()).data as IFlowMessage;
}

describe('hub: FlowMessage body upload/download', () => {
  it('text-only addMessage → body_status=NA, hasBody()=false', async () => {
    const conv = new Conversation({ title: `body-text-${Date.now()}` });
    await conv.save();
    await conv.share([bobEmail!]);
    expect(conv.remote).toBe(true);

    const data = await conv.addMessage('text only');
    const fm = new FlowMessage(data as IFlowMessage);

    expect(fm.hasBody()).toBe(false);
    expect(fm.body_status).toBe(BodyStatus.NA);

    const onHub = await hubGetFm(fm.id!);
    expect(onHub.body_status).toBe('na');

    void dataContext;
    void dataManager;
  });

  it(
    'attachment-bearing message → hub stamps UPLOADING; uploadBody() flips to READY',
    async () => {
      const conv = new Conversation({ title: `body-attach-${Date.now()}` });
      await conv.save();
      await conv.share([bobEmail!]);

      // SDK addMessage now carries attachments — the local backend threads
      // them to the hub, which stamps body_status from has_body() and
      // mirrors the FM in alice's local DB so subsequent body actions can
      // resolve the entity at /flow_message/<id>/<action>.
      const data = await conv.addMessage('with body', {
        attachment: [
          {
            attachment_type: 'type_id',
            data: 'skill-deadbeef-0000-0000-0000-000000000001',
          },
        ],
      });
      expect(data.body_status).toBe('uploading');

      const fm = new FlowMessage(data);
      expect(fm.hasBody()).toBe(true);
      expect(fm.body_status).toBe(BodyStatus.UPLOADING);

      // uploadBody routes through alice's local backend → handle_upload_body
      // → hub_get fallback (FM not in alice's local DB on sender side) →
      // fm.upload_body() (PUT UPLOADING → fs/upload → PUT READY).
      await fm.uploadBody();

      const onHub = await hubGetFm(fm.id!);
      expect(onHub.body_status).toBe('ready');
      expect(onHub.attachment_filename).toBe(BODY_FILENAME);
    },
    15_000,
  );

  it('has_body local-backend action mirrors the Python predicate', async () => {
    const conv = new Conversation({ title: `body-has-${Date.now()}` });
    await conv.save();
    await conv.share([bobEmail!]);
    const data = await conv.addMessage('plain');
    const fmId = (data as IFlowMessage).id!;

    const action = new ActionInfo('has_body', FlowMessage.type, fmId, 'GET');
    const res = await dataManager.callAction<unknown, { has_body: boolean }>(action);
    expect(res?.has_body).toBe(false);
  });
});
