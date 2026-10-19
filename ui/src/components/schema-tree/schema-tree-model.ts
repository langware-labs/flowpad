/**
 * What the schema tree shows: projects, the schemas each defines and its data sources — and where
 * following a link lands. No React here.
 */
import { dataManager, DataSource, Project, projectSchemas, QueryRequest, splitNamespace, TypeId, type SchemaNode } from '@sdk';

/** One project in the tree: its schemas and its data sources. */
export interface SchemaRoot {
  id: string;
  name: string;
  folder: string;
  schemas: SchemaNode[];
  sources: { id: string; name: string; provider?: string }[];
}

export const homeOf = (model: SchemaRoot[], kind: string) =>
  model.find((root) => root.schemas.some((node) => node.kind === kind));
export const nodeOf = (model: SchemaRoot[], kind: string) =>
  homeOf(model, kind)?.schemas.find((node) => node.kind === kind);

/** The entity type of a data schema — the SDK ships no class for it. */
export const DATA_SCHEMA_TYPE = 'data_schema';

/** A kind without its namespace (`--sales_desk--.crm.lead` → `crm.lead`). */
export const bareKind = (kind: string) => splitNamespace(kind)[1];

/** The schemas, in any shown project, whose fields name `kind`. */
export function usedBy(model: SchemaRoot[], kind: string): SchemaNode[] {
  return model.flatMap((root) => root.schemas.filter((node) => node.uses.some((use) => use.kind === kind)));
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
  const root: SchemaRoot = { id: projectId, name: projectId, folder: '', schemas: [], sources: [] };
  model.push(root); // claimed before the first await, so a project two schemas use is loaded once
  const [project, tree, sources] = await Promise.all([
    dataManager.getByTypeId<Project>(new TypeId(Project.type, projectId)),
    projectSchemas(projectId),
    dataManager.query<DataSource>(
      new QueryRequest({
        type: DataSource.type,
        query: { match: { project_id: projectId } },
        scope: [],
        name: `schema-tree-sources-${projectId}`,
      }),
    ),
  ]);
  root.name = project?.name ?? projectId;
  root.folder = project?.fs_storage_mount_path ?? '';
  root.schemas = tree.schemas;
  root.sources = (sources ?? []).map((s) => ({ id: s.id, name: s.name, provider: s.provider }));
  const used = new Set(tree.schemas.flatMap((node) => node.uses.map((use) => use.project_id)));
  await Promise.all([...used].map((id) => loadSchemaRoots(id, model)));
  return model;
}
