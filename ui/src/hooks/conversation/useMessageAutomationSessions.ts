/**
 * The sessions automations started on this conversation's messages, by message id — the chip on a
 * message rides the `AgenticProcess` (an entity, live over the socket), never the automation's run row
 * (`trigger.*` is not forwarded to the app). One live query per conversation, grouped client-side by the
 * `flow_message-<id>` chip the launch stamped, the same shape as `useMessageTasks`.
 */
import { useMemo, useRef } from 'react';
import { AgenticProcess, FlowMessage, QueryFilter, QueryRequest, isProcessFailed, isProcessLive } from '@sdk';
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

/** Where an automation's session stands: its turn in flight (`busy`), done, or failed — the run's own state,
 *  never inferred from what it returned. */
export type AutomationState = 'working' | 'done' | 'failed';

export function automationState(process: AgenticProcess): AutomationState {
  const status = String(process.status ?? '');
  if (isProcessFailed(status)) return 'failed';
  return isProcessLive(status) && process.busy ? 'working' : 'done';
}

/** What the session handed back — its declared output, kept as `<output>/<kind>.value.json` (`output_value`,
 *  Python `process_io.keep_value`) — as a chip label (the file's kind) and its path. None until there is one. */
export function returnedValue(process: AgenticProcess): { label: string; path: string } | null {
  const path = (process.context_data as { output_value?: unknown } | undefined)?.output_value;
  if (typeof path !== 'string' || !path) return null;
  return { label: (path.split('/').pop() ?? path).replace(/\.value\.json$/, ''), path };
}

/** The newest session of a set (by `created_date`, as `newestBy` orders), or none. */
export function latestSession(sessions: ReadonlyMap<string, AgenticProcess>): AgenticProcess | null {
  return newestBy([...sessions.values()], () => 'latest').get('latest') ?? null;
}

/** The message a session was started on — its `flow_message-` context chip. */
export function sessionMessageId(process: AgenticProcess): string | null {
  const chip = (process.sharedContextEntities ?? []).find((tid) => tid.type === FlowMessage.type);
  return chip ? String(chip.id) : null;
}

/** The conversation a session is keyed to (`target_typeid_str`). */
function sessionConversationId(process: AgenticProcess): string | null {
  const target = String(process.target_typeid_str ?? '');
  return target.startsWith('conversation-') ? target.slice('conversation-'.length) : null;
}

const byRule = (p: AgenticProcess) => !!automationLineage(p);
const byHand = (p: AgenticProcess) => !automationLineage(p);

/** The newest session per key among those `keep` admits (newest wins: a rule run twice on one message shows its latest). */
function newestBy(
  processes: readonly AgenticProcess[],
  keyOf: (p: AgenticProcess) => string | null,
  keep: (p: AgenticProcess) => boolean = byRule,
): Map<string, AgenticProcess> {
  const out = new Map<string, AgenticProcess>();
  const started = processes.filter(keep);
  started.sort((a, b) => String(a.created_date ?? '').localeCompare(String(b.created_date ?? '')));
  for (const process of started) {
    const key = keyOf(process);
    if (key) out.set(key, process);
  }
  return out;
}

/** What a chip and the lifecycle line read of a session — the map is the same while this is. */
const signature = (sessions: ReadonlyMap<string, AgenticProcess>): string =>
  [...sessions]
    .map(([key, p]) => `${key}=${p.id}:${String(p.status ?? '')}:${p.name ?? ''}:${p.busy ? 1 : 0}:${String(p.context_data?.output_value ?? '')}`)
    .join('|');

/** The newest sessions per key, as ONE map for as long as nothing a reader shows has changed: the live query
 *  hands a new list on every change to any session of the conversation, and a new map would re-walk the feed. */
function useNewestBy(
  processes: readonly AgenticProcess[],
  keyOf: (p: AgenticProcess) => string | null,
  keep: (p: AgenticProcess) => boolean = byRule,
): ReadonlyMap<string, AgenticProcess> {
  const held = useRef<{ map: ReadonlyMap<string, AgenticProcess>; signature: string } | null>(null);
  return useMemo(() => {
    const map = newestBy(processes, keyOf, keep);
    const sig = signature(map);
    if (held.current?.signature !== sig) held.current = { map, signature: sig };
    return held.current.map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keyOf` and `keep` are module constants at every call site
  }, [processes]);
}

/** Every session keyed to this conversation (`target_typeid_str`) — live. */
function useConversationProcesses(conversationId: string | null | undefined): readonly AgenticProcess[] {
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
  return processes;
}

/** The newest session per message, both kinds from ONE live query: started by a rule (`automation`) and
 *  started by hand from the message's ⋮ menu (`manual`). */
export function useMessageSessions(conversationId: string | null | undefined): {
  automation: ReadonlyMap<string, AgenticProcess>;
  manual: ReadonlyMap<string, AgenticProcess>;
} {
  const processes = useConversationProcesses(conversationId);
  const automation = useNewestBy(processes, sessionMessageId);
  const manual = useNewestBy(processes, sessionMessageId, byHand);
  return { automation, manual };
}

export function useMessageAutomationSessions(
  conversationId: string | null | undefined,
): ReadonlyMap<string, AgenticProcess> {
  return useNewestBy(useConversationProcesses(conversationId), sessionMessageId);
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
  return useNewestBy(processes, sessionConversationId);
}
