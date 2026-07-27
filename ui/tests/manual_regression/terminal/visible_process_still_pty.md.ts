/**
 * visible=true AgenticProcess created via createProcess stays on the PTY path,
 * and its /prompt turn is routed through that PTY (transcript-streamed) path.
 * Source: visible_process_still_pty.md
 *
 * Pure API test (no browser): exercises the lifecycle-routing.
 *   - createProcess({visible:true}) → SUCCESS, agentic_process entity.
 *   - GET → visible=true, pty_mode=true (stays on the PTY path),
 *     target_typeid_str=null (none sent), workdir echoed, instruction_content="",
 *     worker_status null (no transcript yet — realigned status model).
 *   - POST /prompt → 200: the transport is picked by pty_mode (NOT visible), so a
 *     pty_mode=true process routes the turn into the PTY-transcript streaming path
 *     and streams a flow-result. (The old print-mode 409 admission gate on
 *     `visible` was removed by design: `visible` only controls tab visibility and
 *     must never reroute a turn — see agentic_process._http_prompt.)
 *   - DELETE → 200.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

test('test 1: visible=true createProcess stays on the PTY path; /prompt routes to PTY stream', async () => {
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
  // A visible=true process reserves a PTY on creation. When the host is out of
  // PTY devices (kern.tty.ptmx_max=511 saturated by ~150 external claude/codex
  // sessions on this machine) the backend returns 500 "out of pty devices".
  // That is a host-capacity condition, not a lifecycle-routing regression — the
  // gate this test asserts is unreachable without a real PTY, so take the
  // sanctioned live-env skip (conditional: only when the exact signal appears).
  if (createRes.status() === 500) {
    const body = await createRes.json().catch(() => ({}));
    if (/out of pty devices/i.test(String(body?.message))) {
      await api.dispose();
      test.skip(true, 'live-env: host out of PTY devices — createProcess(visible=true) cannot reserve a PTY. Passes when PTYs are free. skip_challenge_required.');
    }
  }
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
    // "Stays on the PTY path" is now carried by pty_mode (the transport intent),
    // which a visible=true createProcess sets to true.
    expect(got.pty_mode).toBe(true);
    expect(got.target_typeid_str ?? null).toBeNull(); // none sent in context
    expect(got.workdir).toBe('/tmp');
    expect(got.instruction_content ?? '').toBe('');
    // PTY not yet attached (attach happens on shell mount) and no transcript has
    // been written yet, so per the realigned status model worker_status is null
    // ("nothing found" — never coerced to a placeholder). Older attached-but-idle
    // states (idle/initializing) are also acceptable; an active turn state is not.
    expect([null, 'idle', 'initializing']).toContain(got.worker_status ?? null);

    // /prompt routes on pty_mode (NOT visible): a pty_mode=true process is admitted
    // and the turn streams through the PTY-transcript path, returning 200 with a
    // flow-result stream (no live PTY yet ⇒ closes on transcript-inactivity).
    const promptRes = await api.post(`${API}/api/v1/graph/agentic_process/${pid}/prompt`, {
      data: { message: 'hello from qa' },
    });
    expect(promptRes.status()).toBe(200);
    const promptText = await promptRes.text();
    expect(promptText).toMatch(/<flow-result/);
  } finally {
    // Cleanup.
    const del = await api.delete(`${API}/api/v1/graph/agentic_process/${pid}`);
    expect(del.status()).toBe(200);
  }

  await api.dispose();
});
