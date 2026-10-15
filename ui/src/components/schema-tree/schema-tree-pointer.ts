/**
 * The schema tree's pointer: the selection, as a path of kinds. The project is the
 * address's scope (`?scope-mode=project&scope-activeProjectId=<id>`), like every project screen.
 *
 *   /dock/schema-tree                          the project
 *   /dock/schema-tree/<kind>                   one schema
 *   /dock/schema-tree/<kind>/<kind>…           a schema reached through the ones that use it
 *   /dock/schema-tree/source:<id>              one of the project's data sources
 *
 * A kind is spelled in full (`--sales_desk--.crm.lead`): its characters need no escaping.
 * No React here: the parser is shared by the view and the address bar.
 */
export const SOURCE_SEGMENT = 'source:';

export function parseSchemaTreePointer(pointer: string | null | undefined): string[] {
  return pointer ? pointer.split('/').filter(Boolean) : [];
}

export function schemaTreePointer(path: string[]): string | undefined {
  return path.length ? path.join('/') : undefined;
}
