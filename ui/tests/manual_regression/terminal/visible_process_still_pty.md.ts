/**
 * visible=true AgenticProcess created via createProcess stays on the PTY path,
 * and the print-mode /prompt action rejects it with 409.
 * Source: visible_process_still_pty.md
 *
 * Pure API test (no browser): exercises the lifecycle-routing admission gate.
 *   - createProcess({visible:true}) → SUCCESS, agentic_process entity.
 *   - GET → visible=true, target_typeid_str=null (none sent), workdir echoed,
 *     instruction_content="", worker_status not-yet-attached (idle/initializing).
 *   - POST /prompt → 409 (PTY owns the session; prompt requires visible=false).
 *   - DELETE → 200.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

test('test 1: visible=true createProcess stays on the PTY path; /prompt → 409', async () => {
  const api = await apiContext();

  // default @local compute node id from bootstrap.
  const boot = await (await api.get(`${API}/api/v1/graph/bootstrap`)).json();
  const cn = boot?.data?.default_compute_node ?? boot?.data?.compute_node;
  const cnId = typeof cn === 'string' ? cn : cn?.id;
  expect(cnId, 'default compute node id').toBeTruthy();

  // createProcess with visible:true and an explicit workdir.
  const createRes = await api.post(`${API}/api/v1/graph/compute_node/${cnId}/createProcess`, {
    data: { context: { workdir: '/tmp' }, visible: true },
  });
  expect(createRes.status()).toBe(200);
  const created = await createRes.json();
  expect(created.status).toBe('SUCCESS');
  expect(created.data?.type).toBe('agentic_process');
  const pid: string = created.data?.id;
  expect(pid).toMatch(/^[0-9a-f-]{36}$/);

  try {
    // GET the entity → lifecycle fields.
    const got = (await (await api.get(`${API}/api/v1/graph/agentic_process/${pid}`)).json()).data;
    expect(got.visible).toBe(true);
    expect(got.target_typeid_str ?? null).toBeNull(); // none sent in context
    expect(got.workdir).toBe('/tmp');
    expect(got.instruction_content ?? '').toBe('');
    // PTY not yet attached (attach happens on shell mount): not a running state.
    expect(['idle', 'initializing'].includes(String(got.worker_status))).toBeTruthy();

    // /prompt (print-mode) must reject a visible=true process with 409.
    const promptRes = await api.post(`${API}/api/v1/graph/agentic_process/${pid}/prompt`, {
      data: { message: 'hello from qa' },
    });
    expect(promptRes.status()).toBe(409);
    const promptBody = await promptRes.json();
    expect(promptBody.status).toBe('FAIL');
    expect(String(promptBody.message)).toMatch(/PTY-interactive; prompt action requires visible=false/i);
  } finally {
    // Cleanup.
    const del = await api.delete(`${API}/api/v1/graph/agentic_process/${pid}`);
    expect(del.status()).toBe(200);
  }

  await api.dispose();
});
