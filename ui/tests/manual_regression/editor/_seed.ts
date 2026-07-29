import type { APIRequestContext } from '@playwright/test';
import { apiBase } from '../_shared/api';

const API = apiBase();

/** Create a markdown doc in the active project and return its entity id.
 *
 * Uses the SCOPED create (`/graph/project/<id>/markdown`) — the unscoped form
 * materializes under $HOME instead of the project (owns_main_ref scoping). */
export async function ensureProjectMarkdown(request: APIRequestContext): Promise<string> {
  const boot = await (await request.get(`${API}/api/v1/graph/bootstrap?domain=localhost`)).json();
  const projectId =
    boot?.data?.default_project?.id ??
    boot?.data?.local_project?.id ??
    boot?.data?.project?.id;
  if (!projectId) throw new Error('bootstrap returned no default project id');
  const name = `qa-md-${Date.now()}`;
  const r = await request.post(`${API}/api/v1/graph/project/${projectId}/markdown`, {
    data: { name },
  });
  if (!r.ok()) throw new Error(`seed markdown failed: ${r.status()} ${await r.text()}`);
  const id = (await r.json())?.data?.id;
  if (!id) throw new Error('seed markdown returned no entity id');
  return id;
}
