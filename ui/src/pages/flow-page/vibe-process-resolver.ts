import { AgenticProcess, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { mostRecentProcess } from '@src/utils/process-recency';

/** Rail-resume contract: the latest real Chat that was opened in this project. */
export function lastVibeChatQuery(projectId: string): QueryRequest {
  return new QueryRequest({
    type: AgenticProcess.type,
    scope: [],
    name: `lastVibeChat:${projectId}`,
    query: new QueryFilter({
      match: {
        op: '$AND',
        operands: [
          { op: '$EQ', operands: ['project_id', projectId] },
          { op: '$EQ', operands: ['process_type', ProcessKind.Chat] },
          { op: '$IS_NOT_NULL', operands: ['last_active_at'] },
        ],
      },
    }),
  });
}

export const pickLastVibeChat = mostRecentProcess;
