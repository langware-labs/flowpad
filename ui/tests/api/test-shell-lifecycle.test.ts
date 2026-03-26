// ui/tests/api/test-shell-lifecycle.test.ts
import { describe, it, expect } from 'vitest';

describe('Shell lifecycle (API)', () => {
  const API = `${window.location.origin}/api/v1/graph`;

  it('create -> entity exists with status=created', async () => {
    const resp = await fetch(`${API}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Shell', status: 'created', workdir: '/tmp' }),
    });
    const body = await resp.json();
    expect(body.status).toBe('SUCCESS');
    expect(body.data.status).toBe('created');
    expect(body.data.name).toBe('Test Shell');
  });

  it('close -> status=closed, gone from list', async () => {
    // Create
    const createResp = await fetch(`${API}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To Close', status: 'created' }),
    });
    const { data: created } = await createResp.json();

    // Close
    const closeResp = await fetch(`${API}/shell/${created.id}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const closeBody = await closeResp.json();
    expect(closeBody.status).toBe('SUCCESS');

    // List
    const listResp = await fetch(`${API}/compute_node/@local/list-shell-sessions`);
    const listBody = await listResp.json();
    const ids = (listBody.data || []).map((s: any) => s.id);
    expect(ids).not.toContain(created.id);
  });

  it('Close All -> refresh -> no tabs (bug scenario)', async () => {
    // Create two sessions
    const s1 = await fetch(`${API}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tab 1', status: 'created' }),
    }).then(r => r.json());

    const s2 = await fetch(`${API}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tab 2', status: 'created' }),
    }).then(r => r.json());

    // Close both
    await fetch(`${API}/shell/${s1.data.id}/close`, { method: 'POST' });
    await fetch(`${API}/shell/${s2.data.id}/close`, { method: 'POST' });

    // List should be empty (for these sessions)
    const listResp = await fetch(`${API}/compute_node/@local/list-shell-sessions`);
    const listBody = await listResp.json();
    const ids = (listBody.data || []).map((s: any) => s.id);
    expect(ids).not.toContain(s1.data.id);
    expect(ids).not.toContain(s2.data.id);
  });
});
