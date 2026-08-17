import { v5 as uuidv5 } from 'uuid';

/** Mirror of backend ``Project.derive_id_for_path``.
 *  This is a legacy fs-record ``project_id`` value, not a Project entity id.
 *  Use only when matching rows already stamped with record.project_id. */
export function recordProjectIdForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return uuidv5(`project:${path}`, uuidv5.DNS);
}

/** @deprecated Use recordProjectIdForPath, and never for ScopeFilter.projects. */
export const projectIdForPath = recordProjectIdForPath;
