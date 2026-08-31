import { AgenticProcess, ProcessKind, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo } from 'react';

/**
 * The conversational sessions of a PROJECT, whatever entity each one is keyed to.
 *
 * The counterpart to `useProcessesForTarget`, and deliberately a different
 * question. `target_typeid_str` answers "what is this session ABOUT" — it is the
 * dedupe/reconnect key its launcher stamps, so a diagnosis terminal
 * (`open-in-terminal-button`) is keyed to its FlowpadDiagnosis and a wizard run
 * to its subject entity. Keying a project's chat history on that field files
 * every such session under an entity that owns no other chat, so it vanishes
 * from the history list purely because of where it was launched from.
 *
 * `project_id` answers "whose session is this", which is what a project-level
 * history list actually wants. The type filter is what keeps it a CHAT list:
 * `Chat` is a conversation by definition, and `Analysis` covers the
 * hand-driven sessions launched from a diagnosis/transcript that the user then
 * talks to. `Execution` / `Wizard` / `Conversation` stay out — those are
 * machine-driven runs, not sessions to come back to.
 */
const CONVERSATIONAL_KINDS: ProcessKind[] = [ProcessKind.Chat, ProcessKind.Analysis];

export function useProcessesForProject(projectId: string | null | undefined, options?: { enabled?: boolean }) {
  const key = projectId || '';
  const query = useMemo(
    () =>
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        name: `processesForProject:${key || 'none'}`,
        query: new QueryFilter({
          match: {
            op: '$AND',
            operands: [
              { op: '$EQ', operands: ['project_id', key] },
              // `$OR` of `$EQ`, never a scalar `$IN` — same reason spelled out
              // in `useChatHistory` and `use-project-agents`: the client-side
              // re-validator that keeps a watched query live (`QueryFilter.
              // validate` → `isValid(..., mustContainsPROP)`) only evaluates
              // `$IN` in its array-field `$PROP` form and returns false for a
              // scalar one. The REST fetch would still be right, and then the
              // first `update` data_op would splice every row back out.
              {
                op: '$OR',
                operands: CONVERSATIONAL_KINDS.map((kind) => ({ op: '$EQ', operands: ['process_type', kind] })),
              },
            ],
          },
        }),
      }),
    [key],
  );

  const enabled = (options?.enabled ?? true) && !!key;
  const { data, isLoading, error } = useEntitiesQuery<AgenticProcess>(query, { enabled });

  return { processes: data ?? [], isLoading, error };
}
