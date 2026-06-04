/**
 * CollaborationRoom: add_process flow (HTTP contract).
 * Source: collaboration_room_add_process.md
 *
 * Pure-API: ensure-collaboration-code → join → create room → join room →
 * createProcess → add_process → GET room → negative (missing/bogus id).
 * The graph instance-action router resolves by entity id (not uname). API base
 * from QA_API_URL (default 6003).
 */
import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';

const API = process.env.QA_API_URL || 'http://localhost:6003';

async function firstId(rq: APIRequestContext, path: string): Promise<string> {
  const d = (await (await rq.get(`${API}/api/v1/graph/${path}`)).json()).data;
  const id = Array.isArray(d) ? d[0]?.id : d?.id;
  expect(id, `${path} id`).toBeTruthy();
  return id;
}

test('collaboration_room add_process end-to-end HTTP contract', async () => {
  test.setTimeout(60_000);
  const rq = await pwRequest.newContext();

  const projId = await firstId(rq, 'project');
  const nodeId = await firstId(rq, 'compute_node');

  // 1. ensure collaboration code (idempotent)
  const ensure1 = await (await rq.post(`${API}/api/v1/graph/project/${projId}/ensure-collaboration-code`, {
    data: { host_name: 'QA Tester', host_member_id: 'qa-member-001' },
  })).json();
  expect(ensure1.status).toBe('SUCCESS');
  expect(typeof ensure1.data?.session_code).toBe('string');
  expect(ensure1.data.session_code.length).toBeGreaterThan(0);
  expect(ensure1.data.host_member_id).toBe('qa-member-001');
  const code1 = ensure1.data.session_code;
  // Idempotent: re-run does not rotate the code.
  const ensure2 = await (await rq.post(`${API}/api/v1/graph/project/${projId}/ensure-collaboration-code`, {
    data: { host_name: 'QA Tester', host_member_id: 'qa-member-001' },
  })).json();
  expect(ensure2.data.session_code).toBe(code1);

  // 2. join project collaboration
  const join = await (await rq.post(`${API}/api/v1/graph/project/${projId}/join-collaboration`, {
    data: { member_id: 'qa-member-002', name: 'QA Joiner' },
  })).json();
  expect(join.status).toBe('SUCCESS');
  const memberIds = (join.data?.members ?? []).map((m: { member_id: string }) => m.member_id);
  expect(memberIds).toContain('qa-member-001');
  expect(memberIds).toContain('qa-member-002');

  // 3. create CollaborationRoom entity
  const room = await (await rq.post(`${API}/api/v1/graph/collaboration_room`, {
    data: { project_id: projId, host_name: 'QA Tester', host_member_id: 'qa-member-001', name: 'QA Regression Room' },
  })).json();
  expect(room.status).toBe('SUCCESS');
  const rid: string = room.data.id;
  expect(rid).toMatch(/^[0-9a-f-]{36}$/);
  expect(room.data.status).toBe('active');

  // 4. join the room entity
  const joinRoom = await (await rq.post(`${API}/api/v1/graph/collaboration_room/${rid}/join`, {
    data: { member_id: 'qa-member-002', name: 'QA Joiner' },
  })).json();
  expect(joinRoom.status).toBe('SUCCESS');
  expect((joinRoom.data?.members ?? []).some((m: { member_id: string }) => m.member_id === 'qa-member-002')).toBe(true);

  // 5. create a minimal AgenticProcess on the compute node
  const proc = await (await rq.post(`${API}/api/v1/graph/compute_node/${nodeId}/createProcess`, {
    data: { context: { project_id: projId }, visible: true },
  })).json();
  expect(proc.status).toBe('SUCCESS');
  expect(proc.data.type).toBe('agentic_process');
  const pid: string = proc.data.id;
  expect(pid).toMatch(/^[0-9a-f-]{36}$/);

  // 6. add_process — first add ok=true; the response echoes the room's linked
  // processes as shared_context_entities (typeid strings `agentic_process-<id>`).
  const add1 = await (await rq.post(`${API}/api/v1/graph/collaboration_room/${rid}/add_process`, {
    data: { agentic_process_id: pid },
  })).json();
  expect(add1.status).toBe('SUCCESS');
  expect(add1.data?.ok).toBe(true);
  expect(add1.data?.shared_context_entities ?? []).toContain(`agentic_process-${pid}`);
  // repeated add → ok=false
  const add2 = await (await rq.post(`${API}/api/v1/graph/collaboration_room/${rid}/add_process`, {
    data: { agentic_process_id: pid },
  })).json();
  expect(add2.data?.ok).toBe(false);

  // 7. GET room — process list populated
  const got = (await (await rq.get(`${API}/api/v1/graph/collaboration_room/${rid}`)).json()).data;
  expect(got.agentic_process_ids).toContain(pid);
  expect((got.members ?? []).some((m: { member_id: string }) => m.member_id === 'qa-member-002')).toBe(true);

  // 8. Negative: missing agentic_process_id → FAIL mentioning agentic_process_id
  const missingRes = await rq.post(`${API}/api/v1/graph/collaboration_room/${rid}/add_process`, { data: {} });
  const missing = await missingRes.json();
  expect(missing.status, 'missing agentic_process_id must FAIL').toBe('FAIL');
  expect(String(missing.message)).toMatch(/agentic_process_id/i);

  // 9. Negative: bogus agentic_process_id → must be rejected (FAIL). The .md
  // requires add_process to validate existence; if the server appends the
  // unknown id with SUCCESS, that is a real bug and this assertion FAILS.
  const bogusRes = await rq.post(`${API}/api/v1/graph/collaboration_room/${rid}/add_process`, {
    data: { agentic_process_id: '00000000-dead-beef-0000-000000000000' },
  });
  const bogus = await bogusRes.json();
  expect(bogus.status, 'bogus agentic_process_id must be rejected (add_process must validate existence)').toBe('FAIL');

  await rq.dispose();
});
