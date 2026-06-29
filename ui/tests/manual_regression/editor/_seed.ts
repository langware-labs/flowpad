import type { APIRequestContext } from '@playwright/test';

const API = process.env.API_URL || `http://localhost:${process.env.LOCAL_SERVER_PORT || '9008'}`;

/** Ensure the ACTIVE project has at least one markdown doc and return its name.
 *
 * The browseable tree is project-scoped; a fresh/cleared instance has an empty
 * docs folder, so tests that open "the first .md leaf" must seed their own.
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
  // The browseable tree lists INDEXED records and indexing is explicit-only (no
  // auto-index on create). Index the new doc under its project so "the first .md
  // leaf" actually surfaces in the tree.
  const idx = await request.post(
    `${API}/api/v1/graph/compute_node/@local/fs-records/index?type=markdown&projects=${projectId}&user=false&force=true`,
  );
  if (!idx.ok()) throw new Error(`index markdown after seed failed: ${idx.status()}`);
  return `${name}.md`;
}
