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
import { HUB_URL, hubAvailable, localBackendIsCloudLoggedIn } from './_hub';

let skipReason: string | null = null;
let hubToken: string | null = null;

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) {
    skipReason = hub.reason ?? 'hub unreachable';
    return;
  }
  // SERVER_URL is e.g. http://localhost:9008/api/v1 — strip /api/v1 then re-add
  // explicitly when probing the local /cloud/status route.
  const localApiBase = config.SERVER_URL;
  const loggedIn = await localBackendIsCloudLoggedIn(localApiBase);
  if (!loggedIn) {
    skipReason =
      'local backend is not cloud-logged-in — run `flowpad cloud login` (or the UI) first';
    return;
  }
  // Pull the hub bearer token from the local /cloud/status response so the
  // verification GET can authenticate without re-logging.
  try {
    const r = await fetch(`${localApiBase}/cloud/status`);
    const body = (await r.json()) as { data?: { api_key?: string; token?: string } };
    hubToken = body.data?.api_key || body.data?.token || null;
  } catch {
    /* swallow — handled below */
  }
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
