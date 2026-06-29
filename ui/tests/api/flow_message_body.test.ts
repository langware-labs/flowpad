/**
 * Vitest mirror of ``tests/api/test_flow_message_body_actions.py``.
 *
 * Runs against the minihub (zero-auth in-process server). Covers the no-hub
 * surface of the new body actions:
 *
 *   GET  /api/v1/graph/flow_message/<id>/has_body  — pure predicate, no hub I/O
 *   POST /api/v1/graph/flow_message/<id>/download_body  — refusal states only
 *                                                         (READY happy path
 *                                                         touches the hub and
 *                                                         is covered by
 *                                                         ``ui/tests/hub/body_upload_download.test.ts``)
 *
 * The pytest version mocks ``flow_sdk.utils.hub`` directly. From JS we can't
 * monkey-patch Python — so the live-hub happy paths live in the ``hub`` vitest
 * project and this file only asserts the API contract that doesn't touch
 * the hub (predicate + 4xx refusals).
 */
import { config, dataManager } from '@sdk';
import {
  Attachment,
  AttachmentType,
  BodyStatus,
  FlowMessage,
  type IFlowMessage,
} from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/** Build an id locally and POST the full FM payload via raw fetch — the
 *  SDK's ``FlowMessage.save()`` serializer drops undefined-default fields
 *  like ``text``/``attachment`` and the local-backend create gate rejects
 *  the resulting half-empty row. Going through the raw graph endpoint puts
 *  the full row in the local DB so the body actions can resolve it. */
async function saveLocalFm(init: Partial<IFlowMessage>): Promise<string> {
  const id = crypto.randomUUID();
  const payload: Record<string, unknown> = {
    id,
    type: FlowMessage.type,
    text: 't',
    ...init,
  };
  const r = await fetch(`${config.SERVER_URL}/graph/flow_message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`saveLocalFm failed: ${r.status} ${await r.text()}`);
  return id;
}

async function callHasBody(fmId: string): Promise<boolean> {
  const action = new ActionInfo('has_body', FlowMessage.type, fmId, 'GET');
  const res = await dataManager.callAction<unknown, { has_body: boolean }>(action);
  return !!res?.has_body;
}

async function callDownloadBody(fmId: string): Promise<unknown> {
  const action = new ActionInfo('download_body', FlowMessage.type, fmId, 'POST');
  return dataManager.callAction<unknown, unknown>(action);
}

describe('api: flow_message body actions', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('has_body returns true for a FILE attachment', async () => {
    const fmId = await saveLocalFm({
      attachment: [{ attachment_type: AttachmentType.FILE, data: 'data/x.png' } as Attachment],
    });
    expect(await callHasBody(fmId)).toBe(true);
  }, 10_000);

  it('has_body returns true for a TYPE_ID attachment', async () => {
    const fmId = await saveLocalFm({
      attachment: [
        { attachment_type: AttachmentType.TYPE_ID, data: 'skill-deadbeef-0000-0000-0000-000000000001' } as Attachment,
      ],
    });
    expect(await callHasBody(fmId)).toBe(true);
  }, 10_000);

  it('has_body returns false for text-only', async () => {
    const fmId = await saveLocalFm({ text: 'plain text, no attachments' });
    expect(await callHasBody(fmId)).toBe(false);
  }, 10_000);

  it('has_body returns false for a URL-only attachment', async () => {
    const fmId = await saveLocalFm({
      attachment: [{ attachment_type: AttachmentType.URL, data: 'https://example.com' } as Attachment],
    });
    expect(await callHasBody(fmId)).toBe(false);
  }, 10_000);

  it('download_body refuses when body_status is UPLOADING (still being staged)', async () => {
    const fmId = await saveLocalFm({
      attachment: [{ attachment_type: AttachmentType.FILE, data: 'data/x' } as Attachment],
      body_status: BodyStatus.UPLOADING,
    });
    await expect(callDownloadBody(fmId)).rejects.toThrow();
  }, 10_000);

  it('download_body refuses when body_status is NA (no body to fetch)', async () => {
    const fmId = await saveLocalFm({ body_status: BodyStatus.NA });
    await expect(callDownloadBody(fmId)).rejects.toThrow();
  }, 10_000);

  it('has_body 404s for an unknown FM id', async () => {
    const bogus = '00000000-0000-0000-0000-000000000abc';
    await expect(callHasBody(bogus)).rejects.toThrow();
  }, 10_000);
});
