import { expect, test, type APIRequestContext } from '@playwright/test';

import { apiBase } from '../_shared/api';

const API = apiBase();

// The sniffer state (sniffer_hook / sniffer_installed) is served by the deferred
// /api/v1/graph/info route, not /graph/bootstrap (split out of bootstrap so boot
// does not wait on it; see docs/boot.md).

async function snifferHook(request: APIRequestContext) {
  const res = await request.get(`${API}/api/v1/graph/info`);
  expect(res.status()).toBe(200);
  return (await res.json()).data.sniffer_hook;
}

// Sniffer is OPT-IN, default OFF. The default-off bootstrap contract must be
// consistent and idempotent across repeated calls — no per-call auto-install,
// no drift.
test.describe('Sniffer — default-off bootstrap is idempotent', () => {
  test('1: bootstrap sniffer state is consistent across two calls', async ({ request }) => {
    expect(await snifferHook(request), 'first call: sniffer_hook null').toBeNull();
    expect(await snifferHook(request), 'second call: still null (no per-call side effect)').toBeNull();
  });
});
