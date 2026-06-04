import { expect, test, type APIRequestContext } from '@playwright/test';

const API = process.env.API_URL || 'http://localhost:6002';

// Sniffer is OPT-IN, default OFF. With the instance gate off there is no
// sniffer_hook and therefore no event-capture surface — correct app behavior,
// not a failure. The sniffer hook is an `agent_hook` named "Hooks Sniffer"
// (uname "sniffer"); the canonical gate check is the hooks-sniffer status action.
test.describe('Sniffer — no capture surface when default-off', () => {
  test('1: no sniffer hook means no capture surface', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/graph/bootstrap`);
    expect(res.status()).toBe(200);
    const data = (await res.json()).data as Record<string, unknown>;
    expect(data.sniffer_hook, 'default-off: the capture hook is not installed').toBeNull();
  });

  test('2: no sniffer agent_hook entity is present by default', async ({ request }) => {
    // hooks-sniffer status: the gate is off, no hook id.
    const statusRes = await request.get(`${API}/api/v1/graph/hooks-sniffer`);
    expect(statusRes.status()).toBe(200);
    const status = (await statusRes.json()).data as { enabled: boolean; hook_id: string | null };
    expect(status.enabled, 'sniffer gate disabled by default').toBe(false);
    expect(status.hook_id, 'no sniffer hook installed by default').toBeNull();

    // agent_hook list: no "Hooks Sniffer" entry auto-created.
    const listRes = await request.get(`${API}/api/v1/graph/agent_hook`);
    expect(listRes.status()).toBe(200);
    const list = (await listRes.json()).data as Array<{ name?: string }>;
    expect(Array.isArray(list), 'agent_hook returns a data array').toBe(true);
    expect(
      list.some((h) => h.name === 'Hooks Sniffer'),
      'default-off: the sniffer hook is not auto-created',
    ).toBe(false);
  });
});
