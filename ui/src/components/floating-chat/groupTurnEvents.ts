import { FlowData, FlowElementTypes } from '@sdk';

/**
 * Groups a flat FlowData stream into a sequence of "turn groups" suitable for
 * the dense floating-chat layout: text-shaped messages stay as-is, and any
 * contiguous run of tool/reasoning/status/error events between two messages
 * collapses into a single dense group that the UI renders as one row with an
 * expand toggle.
 *
 * Why this lives client-side: the worker drivers (Claude / Codex
 * `event_to_flowdata.py`) emit each event individually with no notion of
 * "turns" — turn boundaries are just where the assistant text resumes.
 */

export type TurnGroup =
  | { kind: 'message'; flowData: FlowData; index: number }
  | { kind: 'dense'; events: FlowData[]; index: number };

const MESSAGE_TYPES = new Set<string>([
  FlowElementTypes.USER_MESSAGE,
  FlowElementTypes.CHAT,
  FlowElementTypes.TEXT,
]);

const DENSE_TYPES = new Set<string>([
  FlowElementTypes.TOOL_CALL,
  FlowElementTypes.TOOL_RESULT,
  FlowElementTypes.REASONING,
  FlowElementTypes.STATUS,
  FlowElementTypes.ERROR,
]);

export function groupTurnEvents(items: FlowData[]): TurnGroup[] {
  const out: TurnGroup[] = [];
  let buffer: FlowData[] = [];

  const flushBuffer = () => {
    if (buffer.length > 0) {
      out.push({ kind: 'dense', events: buffer, index: out.length });
      buffer = [];
    }
  };

  for (const item of items) {
    const t: string = item.elementType;
    if (MESSAGE_TYPES.has(t)) {
      flushBuffer();
      out.push({ kind: 'message', flowData: item, index: out.length });
    } else if (DENSE_TYPES.has(t)) {
      buffer.push(item);
    }
    // Anything else (END, RESULT, CHECKPOINT, …) is intentionally dropped from
    // the visible chat — the dense surface is for "things the agent did", not
    // every internal stream marker.
  }
  flushBuffer();

  return out;
}

/**
 * Pull the tool_use_id off either side of a TOOL_CALL/TOOL_RESULT pair.
 * Claude's emitter stores the id at `data.tool_call_id` for both calls and
 * results, but TOOL_RESULT also exposes it in `attributes['tool-use-id']`.
 * Read both so a missing field on one side doesn't break correlation.
 */
export function getToolUseId(item: FlowData): string | null {
  const data = item.data as { tool_call_id?: unknown } | undefined;
  if (data && typeof data.tool_call_id === 'string' && data.tool_call_id) {
    return data.tool_call_id;
  }
  const attr = item.attributes['tool-use-id'];
  return typeof attr === 'string' && attr ? attr : null;
}

/**
 * Pair every TOOL_CALL with the first TOOL_RESULT carrying the same
 * tool_use_id (within a single dense group). A call without a matching result
 * is "in flight"; a result without a call is rendered standalone.
 */
export interface ToolPair {
  call: FlowData;
  result: FlowData | null;
}

export function pairToolEvents(events: FlowData[]): {
  pairs: ToolPair[];
  others: FlowData[];
  orphanResults: FlowData[];
} {
  const pairs: ToolPair[] = [];
  const others: FlowData[] = [];
  const orphanResults: FlowData[] = [];
  const callIndexById = new Map<string, number>();

  for (const item of events) {
    const t = item.elementType;
    if (t === FlowElementTypes.TOOL_CALL) {
      const id = getToolUseId(item);
      const pairIndex = pairs.push({ call: item, result: null }) - 1;
      if (id) callIndexById.set(id, pairIndex);
    } else if (t === FlowElementTypes.TOOL_RESULT) {
      const id = getToolUseId(item);
      const ix = id ? callIndexById.get(id) : undefined;
      if (ix !== undefined && pairs[ix].result === null) {
        pairs[ix].result = item;
      } else {
        orphanResults.push(item);
      }
    } else {
      others.push(item);
    }
  }

  return { pairs, others, orphanResults };
}
