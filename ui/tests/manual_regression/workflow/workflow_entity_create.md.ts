/**
 * Workflow — Entity Create Smoke (WorkflowRecord default file_path regression).
 * Source: workflow_entity_create.md
 *
 * Creating a minimal Workflow entity via POST /api/v1/graph/workflow/ must
 * return 200 + SUCCESS (no 500 TypeError around WorkflowRecord.__init__), and
 * GET must echo the entity with asset_ref exposed (null acceptable). Pure API.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

const API = apiBase();

test('Workflow entity create smoke (no WorkflowRecord file_path 500)', async () => {
  const rq = await apiContext();

  // 1. Server reachable.
  const boot = await rq.get(`${API}/api/v1/graph/bootstrap`);
  expect(boot.status()).toBe(200);

  // 2. Create a minimal workflow (trailing slash; router strips it).
  const createRes = await rq.post(`${API}/api/v1/graph/workflow/`, {
    data: { name: 'qa_regression_workflow_entity_create', description: 'QA smoke' },
  });
  expect(createRes.status(), 'POST /graph/workflow/ status').toBe(200);
  const created = await createRes.json();
  expect(created.status).toBe('SUCCESS');
  const wid: string = created.data?.id;
  expect(wid).toMatch(/^[0-9a-f-]{36}$/);
  expect(created.data?.type).toBe('workflow');
  expect(created.data?.name).toBe('qa_regression_workflow_entity_create');
  // Regression: no WorkflowRecord.__init__ file_path TypeError surfaced.
  expect(JSON.stringify(created)).not.toMatch(/missing 1 required positional argument: 'file_path'/);

  // 3. GET the created workflow.
  const getRes = await rq.get(`${API}/api/v1/graph/workflow/${wid}`);
  expect(getRes.status()).toBe(200);
  const got = await getRes.json();
  expect(got.status).toBe('SUCCESS');
  expect(got.data?.id).toBe(wid);
  expect(got.data?.type).toBe('workflow');
  expect(got.data?.name).toBe('qa_regression_workflow_entity_create');
  // asset_ref exposed on the shape (null acceptable for a record-less workflow).
  expect('asset_ref' in (got.data ?? {})).toBe(true);

  await rq.dispose();
});
