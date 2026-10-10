/**
 * The sessions automations started on this conversation's messages, by message id — the chip on a
 * message rides the `AgenticProcess` (an entity, live over the socket), never the automation's run row
 * (`trigger.*` is not forwarded to the app). One live query per conversation, grouped client-side by the
 * `flow_message-<id>` chip the launch stamped, the same shape as `useMessageTasks`.
 */
import { useMemo } from 'react';
import { AgenticProcess, FlowMessage, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';

const NONE: AgenticProcess[] = [];

/** What a session says about the rule that started it (`context_data["automation"]`, Python side). */
export interface AutomationLineage {
  trigger_id?: string;
  run_id?: string | null;
  name?: string;
  reason?: string;
  confidence?: number;
  subject_id?: string;
}

export function automationLineage(process: AgenticProcess | null | undefined): AutomationLineage | null {
  const raw = (process?.context_data as { automation?: AutomationLineage } | undefined)?.automation;
  return raw && typeof raw === 'object' ? raw : null;
}

/** The message a session was started on — its `flow_message-` context chip. */
export function sessionMessageId(process: AgenticProcess): string | null {
  const chip = (process.sharedContextEntities ?? []).find((tid) => tid.type === FlowMessage.type);
  return chip ? String(chip.id) : null;
}

/** The newest automation session per key (newest wins: a rule run twice on one message shows its latest). */
function newestBy(processes: readonly AgenticProcess[], keyOf: (p: AgenticProcess) => string | null): Map<string, AgenticProcess> {
  const out = new Map<string, AgenticProcess>();
  const ordered = [...processes].sort((a, b) => String(a.created_date ?? '').localeCompare(String(b.created_date ?? '')));
  for (const process of ordered) {
    if (!automationLineage(process)) continue;
    const key = keyOf(process);
    if (key) out.set(key, process);
  }
  return out;
}

export function useMessageAutomationSessions(
  conversationId: string | null | undefined,
): ReadonlyMap<string, AgenticProcess> {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        name: `automationSessions:${conversationId ?? 'none'}`,
        query: new QueryFilter({ match: { target_typeid_str: `conversation-${conversationId || '__none__'}` } }),
      }),
    [conversationId],
  );
  const { data: processes = NONE } = useEntitiesQuery<AgenticProcess>(request, { enabled: !!conversationId });
  return useMemo(() => newestBy(processes, sessionMessageId), [processes]);
}

const NO_IDS: readonly string[] = [];

/** The newest automation session per conversation, for a list of conversations (the stream inbox rows) — ONE
 *  `$IN` query over `target_typeid_str`, the way the rows' messages are batched. */
export function useConversationAutomationMarks(conversationIds: readonly string[]): ReadonlyMap<string, AgenticProcess> {
  const key = [...new Set(conversationIds)].sort().join(',');
  const request = useMemo(() => {
    const ids = key ? key.split(',').map((id) => `conversation-${id}`) : NO_IDS;
    return new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `automationMarks:${ids.length}:${key.slice(0, 64)}`,
      // The same plain `$IN` form the row hydrator sends (`EntityBatchHydrator`).
      query: { match: { op: '$IN', operands: ['target_typeid_str', [...ids]] } },
    });
  }, [key]);
  const { data: processes = NONE } = useEntitiesQuery<AgenticProcess>(request, { enabled: !!key });
  return useMemo(
    () =>
      newestBy(processes, (p) => {
        const target = String(p.target_typeid_str ?? '');
        return target.startsWith('conversation-') ? target.slice('conversation-'.length) : null;
      }),
    [processes],
  );
}
