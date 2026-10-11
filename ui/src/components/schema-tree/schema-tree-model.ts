/**
 * What the schema tree shows: projects, the schemas each defines and its data sources — and where
 * following a link lands. No React here.
 */
import { dataManager, projectKinds, QueryRequest, TypeId, type SchemaNode } from '@sdk';

/** One project in the tree: its schemas and its data sources. */
export interface SchemaRoot {
  id: string;
  name: string;
  folder: string;
  kinds: SchemaNode[];
  sources: { id: string; name: string; provider?: string }[];
}

export const homeOf = (model: SchemaRoot[], kind: string) =>
  model.find((root) => root.kinds.some((node) => node.kind === kind));
export const nodeOf = (model: SchemaRoot[], kind: string) =>
  homeOf(model, kind)?.kinds.find((node) => node.kind === kind);

/** A kind without its namespace (`--gtm_studio--.gtm.icp` → `gtm.icp`). */
export const bareKind = (kind: string) => kind.replace(/^--.+?--\./, '');

/** The schemas, in any shown project, whose fields name `kind`. */
export function usedBy(model: SchemaRoot[], kind: string): SchemaNode[] {
  return model.flatMap((root) => root.kinds.filter((node) => node.uses.some((use) => use.kind === kind)));
}

/** Where following a link to `kind` from the selection at `path` lands: under the selected kind
 *  when it names `kind` (the tree unfolds there), back up the path when `kind` is already on it,
 *  else at the kind itself. The same path when nobody shown defines it. A path holds kinds only:
 *  the project is the address's scope. */
export function pathAfterLink(model: SchemaRoot[], path: string[], kind: string): string[] {
  const at = path.indexOf(kind);
  if (at >= 0) return path.slice(0, at + 1);
  const selected = path.length ? nodeOf(model, path[path.length - 1]) : undefined;
  if (selected?.uses.some((use) => use.kind === kind) && nodeOf(model, kind)) return [...path, kind];
  return nodeOf(model, kind) ? [kind] : path;
}

/** `projectId`'s root, then the root of every project that defines a kind it uses. */
export async function loadSchemaRoots(projectId: string, model: SchemaRoot[] = []): Promise<SchemaRoot[]> {
  if (!projectId || model.some((root) => root.id === projectId)) return model;
  const [project, tree, sources] = await Promise.all([
    dataManager.getByTypeId(new TypeId('project', projectId)) as Promise<any>,
    projectKinds(projectId),
    dataManager.query<any>(
      new QueryRequest({
        type: 'data_source',
        query: { match: { project_id: projectId } },
        scope: [],
        name: `schema-tree-sources-${projectId}`,
      }),
    ),
  ]);
  model.push({
    id: projectId,
    name: project?.name ?? projectId,
    folder: project?.fs_storage_mount_path ?? '',
    kinds: tree.kinds,
    sources: (sources ?? []).map((s: any) => ({ id: s.id, name: s.name, provider: s.provider })),
  });
  for (const used of new Set(tree.kinds.flatMap((node) => node.uses.map((use) => use.project_id)))) {
    await loadSchemaRoots(used, model);
  }
  return model;
}
