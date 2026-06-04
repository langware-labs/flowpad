import { expect, test, type APIRequestContext } from '@playwright/test';

const API = process.env.API_URL || 'http://localhost:6002';

async function bootstrapData(request: APIRequestContext) {
  const res = await request.get(`${API}/api/v1/graph/bootstrap`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.data as Record<string, unknown>;
}

// Sniffer is OPT-IN, default OFF (InstanceSettings.sniffer_enabled defaults false).
// bootstrap returns sniffer_hook=null unless the per-instance gate is enabled;
// there is no HTTP endpoint that flips the instance gate. These tests assert the
// shipped default-off contract.
test.describe('Sniffer — bootstrap default-off contract', () => {
  test('1: bootstrap reflects the default-off sniffer contract', async ({ request }) => {
    const data = await bootstrapData(request);
    expect(data, 'bootstrap has a data object').toBeTruthy();
    expect('sniffer_hook' in data, 'data has a sniffer_hook key').toBe(true);
    expect(data.sniffer_hook, 'sniffer_hook is null when the instance gate is off').toBeNull();
  });

  test('2: bootstrap is stable across calls (no auto-install side effect)', async ({ request }) => {
    const first = await bootstrapData(request);
    expect(first.sniffer_hook).toBeNull();
    const second = await bootstrapData(request);
    expect(second.sniffer_hook, 'reading bootstrap never silently enables the sniffer').toBeNull();
  });
});
