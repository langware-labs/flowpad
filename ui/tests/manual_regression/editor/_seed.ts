import type { APIRequestContext } from '@playwright/test';
import { apiBase } from '../_shared/api';

const API = apiBase();

export interface SeededMarkdown {
  id: string;
  /** Absolute path of the doc's body file, for tests that write content. */
  assetRef: string;
}

/** The active project's id and filesystem mount path.
 *
 * Two calls, not one: bootstrap's `default_project` is a thin summary
 * (id/uname/name) and only the full entity carries `fs_storage_mount_path`. */
export async function activeProject(
  request: APIRequestContext,
): Promise<{ id: string; root: string }> {
  const boot = await (await request.get(`${API}/api/v1/graph/bootstrap?domain=localhost`)).json();
  const id =
    boot?.data?.default_project?.id ??
    boot?.data?.local_project?.id ??
    boot?.data?.project?.id;
  if (!id) throw new Error('bootstrap returned no default project id');

  const full = await (await request.get(`${API}/api/v1/graph/project/${id}`)).json();
  const root = full?.data?.fs_storage_mount_path;
  if (!root) throw new Error(`project ${id} has no fs_storage_mount_path`);
  return { id, root };
}

/** Create a markdown doc in the active project.
 *
 * Uses the SCOPED create (`/graph/project/<id>/markdown`) — the unscoped form
 * materializes under $HOME instead of the project (owns_main_ref scoping). */
export async function createProjectMarkdown(
  request: APIRequestContext,
  name = `qa-md-${Date.now()}`,
): Promise<SeededMarkdown> {
  const { id: projectId } = await activeProject(request);
  const r = await request.post(`${API}/api/v1/graph/project/${projectId}/markdown`, {
    data: { name },
  });
  if (!r.ok()) throw new Error(`seed markdown failed: ${r.status()} ${await r.text()}`);
  const entity = (await r.json())?.data;
  if (!entity?.id) throw new Error('seed markdown returned no entity id');
  return { id: entity.id, assetRef: entity.asset_ref };
}

/** Delete a seeded doc's entity. Removing only its file leaves an orphan row
 *  whose `asset_ref` points at nothing — once per test, every run, forever. */
export async function deleteMarkdown(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`${API}/api/v1/graph/markdown/${id}`);
}

/** Create a markdown doc in the active project and return its entity id. */
export async function ensureProjectMarkdown(request: APIRequestContext): Promise<string> {
  return (await createProjectMarkdown(request)).id;
}
