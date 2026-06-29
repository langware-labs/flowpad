import { ActionInfo, dataManager } from '@sdk';
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

/** Check if an MCP server is available. */
export async function isMcpAvailable(serverName: string): Promise<boolean> {
  try {
    const actionInfo = new ActionInfo('mcp-available', 'compute_node', '@local', 'GET');
    actionInfo.queryParameters = { server: serverName };
    const result = await dataManager.callAction<null, { available: boolean }>(actionInfo);
    return (result as { available: boolean })?.available ?? false;
  } catch {
    return false;
  }
}

/** Enable an MCP server. */
export async function enableMcp(serverName: string, scope: 'user' | 'project'): Promise<void> {
  const actionInfo = new ActionInfo('mcp-enable', 'compute_node', '@local', 'POST');
  actionInfo.bodyParameters = { server: serverName, scope };
  await dataManager.callAction(actionInfo);
}
