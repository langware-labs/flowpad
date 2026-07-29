import { AgenticProcess, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { mostRecentProcess } from '@src/utils/process-recency';

function vibeChatQuery(
  projectId: string,
  options: { targetVfsPath?: string; openedOnly: boolean },
): QueryRequest {
  const operands: Record<string, unknown>[] = [
    { op: '$EQ', operands: ['project_id', projectId] },
    { op: '$EQ', operands: ['process_type', ProcessKind.Chat] },
  ];
  if (options.targetVfsPath) {
    operands.push({ op: '$EQ', operands: ['target_typeid_str', options.targetVfsPath] });
  }
  if (options.openedOnly) {
    operands.push({ op: '$IS_NOT_NULL', operands: ['last_active_at'] });
  }
  return new QueryRequest({
    type: AgenticProcess.type,
    scope: [],
    name: options.targetVfsPath
      ? `lastVibeChat:${projectId}:${options.targetVfsPath}`
      : `lastVibeChat:${projectId}`,
    query: new QueryFilter({ match: { op: '$AND', operands } }),
  });
}

/** Rail-resume contract: the latest real Chat that was opened in this project. */
export function lastVibeChatQuery(projectId: string): QueryRequest {
  return vibeChatQuery(projectId, { openedOnly: true });
}

/**
 * Asset workspace contract: every Chat keyed to the exact asset and project.
 * Headlessly-created hosts are included even before their process dock opens.
 */
export function targetVibeChatQuery(projectId: string, targetVfsPath: string): QueryRequest {
  return vibeChatQuery(projectId, { targetVfsPath, openedOnly: false });
}

export const pickLastVibeChat = mostRecentProcess;

export async function resolveTargetVibeChat(
  projectId: string,
  targetVfsPath: string,
): Promise<AgenticProcess | null> {
  const candidates = await AgenticProcess.query<AgenticProcess>(
    targetVibeChatQuery(projectId, targetVfsPath),
  );
  return pickLastVibeChat(candidates);
}
