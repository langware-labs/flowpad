import { AgenticProcess, type ExpressionNode, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { mostRecentProcess } from '@src/utils/process-recency';

/** The latest real Chat that was opened in this project (the project home page's
 *  agent resume uses it).
 *  `target` narrows it to one entity's chats — an agent's sessions carry the
 *  agent's TypeId as `target_typeid_str` (`Deployment.use`). */
export function lastVibeChatQuery(projectId: string, target?: string): QueryRequest {
  const operands: Partial<ExpressionNode>[] = [
    { op: '$EQ', operands: ['project_id', projectId] },
    { op: '$EQ', operands: ['process_type', ProcessKind.Chat] },
    { op: '$IS_NOT_NULL', operands: ['last_active_at'] },
  ];
  if (target) operands.push({ op: '$EQ', operands: ['target_typeid_str', target] });
  return new QueryRequest({
    type: AgenticProcess.type,
    scope: [],
    name: `lastVibeChat:${projectId}${target ? `:${target}` : ''}`,
    query: new QueryFilter({ match: { op: '$AND', operands } }),
  });
}

export const pickLastVibeChat = mostRecentProcess;
