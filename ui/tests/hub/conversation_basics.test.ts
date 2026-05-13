/**
 * Conversation lifecycle round-trip against a live local hub — TypeScript
 * mirror of ``tests/hub_tests/test_conversation_basics.py::test_share_in_cloud``.
 *
 * Same flow, same interface signatures:
 *
 *   const conv = new Conversation({ title: 'basic-share-<ts>' });
 *   await conv.share();
 *   expect(conv.remote).toBe(true);
 *   GET hub /graph/conversation/<id>  →  data.id === conv.id
 *
 * No ``ts_sdk/cloud_client`` — the TS SDK invokes the standard graph action
 * ``POST /api/v1/graph/conversation/<id>/share``; the LOCAL backend's
 * ``share`` action handler forwards to the hub via the stored cloud
 * credentials. The verification GET goes straight at the hub to prove the
 * mirror exists by the same id.
 */
import { config, dataContext } from '@sdk';
import { Conversation } from '@sdk/entities/conversation';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import { HUB_URL, getAliceCreds, hubAvailable, hubLogin, localBackendIsCloudLoggedIn } from './_hub';

let skipReason: string | null = null;
let hubToken: string | null = null;

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
  const alice = await getAliceCreds();
  if (!alice) {
    skipReason = 'missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-oss/.env.local';
    return;
  }
  hubToken = (await hubLogin(alice.email, alice.password)).token;
});

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  if (skipReason) context.skip();
  await apiTestSetup(signupInfo, context.task.name);
});

describe('hub: Conversation.share', () => {
  it('shares a new conversation to the hub and flips remote=true', async () => {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const title = `basic-share-${ts}`;

    const conv = new Conversation({ title });
    expect(conv.id).toBeTruthy();
    expect(conv.remote).toBeFalsy();

    // The TS share path POSTs to ``/graph/conversation/<id>/share`` on the
    // local backend; the action dispatcher requires the target entity to
    // exist locally first.
    await conv.save();
    await conv.share();

    expect(conv.remote).toBe(true);

    // Hub-side mirror: same id, same title.
    const url = `${HUB_URL}/api/v1/graph/conversation/${conv.id}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (hubToken) headers.Authorization = `Bearer ${hubToken}`;
    const r = await fetch(url, { headers });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; data: any };
    expect(body.status).toBe('SUCCESS');
    expect(body.data.id).toBe(conv.id);
    expect(body.data.title).toBe(title);
    expect(body.data.type).toBe('conversation');

    // Silence unused-import warnings — dataContext is part of the @sdk barrel
    // and ensures the SDK side-effects (registry init) run before assertions.
    void dataContext;
  });
});
