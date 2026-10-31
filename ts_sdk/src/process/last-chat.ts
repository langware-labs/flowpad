/**
 * "The chat I was last in": one rule for every caller — the app's agent launcher and Home, and a
 * served page's `<flowpad-agent>` panel — so they always land on the same chat.
 */
import { ExpressionNode, QueryFilter, QueryRequest } from '../FlowSync/query';
import type { AgenticProcess } from './agentic-process';
import { ProcessKind } from './process-types';

/** Epoch-ms from an epoch number, a Date, or an ISO string, else 0. */
export function toMs(value: number | string | Date | null | undefined): number {
  if (typeof value === 'number') return value;
  const n = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

/** Recency key for picking "the" process when more than one is linked —
 *  most-recently-active wins, falling back to created_at, then 0. */
export function recencyOf(p: AgenticProcess): number {
  return toMs(p.last_active_at) || toMs((p as { created_at?: string }).created_at);
}

/** Pick the most-recently-active process, or null for an empty list. */
export function mostRecentProcess(processes: readonly AgenticProcess[]): AgenticProcess | null {
  if (!processes.length) return null;
  return processes.reduce((a, b) => (recencyOf(b) > recencyOf(a) ? b : a));
}

/** The latest real Chat that was opened in this project.
 *  `target` narrows it to one entity's chats — an agent's sessions carry the
 *  agent's TypeId as `target_typeid_str` (`Deployment.use`).
 *  `openedOnly` (default) keeps only chats that were opened; Discuss on an asset
 *  passes false — a chat made by Discuss is the asset's even before its first turn. */
export function lastChatQuery(
  /** Null = a project-less chat (the chat-scratch folder): matches `project_id` unset. */
  projectId: string | null,
  target?: string,
  { openedOnly = true }: { openedOnly?: boolean } = {},
): QueryRequest {
  const operands: Partial<ExpressionNode>[] = [
    projectId ? { op: '$EQ', operands: ['project_id', projectId] } : { op: '$IS_NULL', operands: ['project_id'] },
    { op: '$EQ', operands: ['process_type', ProcessKind.Chat] },
  ];
  if (openedOnly) operands.push({ op: '$IS_NOT_NULL', operands: ['last_active_at'] });
  if (target) operands.push({ op: '$EQ', operands: ['target_typeid_str', target] });
  return new QueryRequest({
    type: 'agentic_process',
    scope: [],
    name: `lastVibeChat:${projectId ?? 'scratch'}${target ? `:${target}` : ''}${openedOnly ? '' : ':any'}`,
    query: new QueryFilter({ match: { op: '$AND', operands } }),
  });
}
