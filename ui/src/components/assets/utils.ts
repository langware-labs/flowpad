import { ActionInfo, dataManager } from '@sdk';

/** Derive the prepared file path from a source path. */
export function derivePreparedPath(sourcePath: string): string {
  return sourcePath.replace(/\.md$/, '.prepared.md');
}

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
