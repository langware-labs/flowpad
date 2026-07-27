import { FlowData, FlowElementTypes } from '@sdk';
import { useMemo, useRef } from 'react';

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
  | {
      kind: 'message';
      flowData: FlowData;
      index: number;
      /**
       * Set on the framework-injected (`is-meta`) message that follows a
       * dropped `Skill` tool call: the skill's name, lifted off that call's
       * structured payload. The chip prefers it over regexing the injected
       * body — see `MetaMessageChip`.
       */
      skillName?: string;
    }
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

/**
 * Transcript bookkeeping that is NOT "something the agent did": per-snapshot
 * token accounting and Claude's session-envelope lines (file-history snapshots,
 * queue operations, titles). A replayed transcript carries dozens of them, and
 * they buried the real operations under a wall of empty `{}` rows. Live
 * lifecycle STATUS frames (`init`, `task_started`, `rate-limit`) are NOT here —
 * those describe the run and stay visible.
 */
const NON_ACTIVITY_SUBTYPES = new Set<string>(['token_usage', 'meta', 'summary']);

const NO_LIVE_EVENTS: FlowData[] = [];

/**
 * Split the trailing "in-flight" dense group off a grouped turn stream: while a
 * turn is `active`, its still-running tool/reasoning events are the last dense
 * group, which a chat surface can surface separately (e.g. a live footer chip)
 * instead of inline. Returns the groups to render inline plus the live turn's
 * events (empty when idle or the last group is a message). The notion of a
 * "live group" lives here, next to `groupTurnEvents`, rather than in a consumer.
 */
export function splitLiveGroup(
  groups: TurnGroup[],
  active: boolean,
): { inlineGroups: TurnGroup[]; liveEvents: FlowData[] } {
  const last = active ? groups[groups.length - 1] : undefined;
  if (last?.kind === 'dense') {
    return { inlineGroups: groups.slice(0, -1), liveEvents: last.events };
  }
  return { inlineGroups: groups, liveEvents: NO_LIVE_EVENTS };
}

export function groupTurnEvents(items: readonly FlowData[]): TurnGroup[] {
  return createTurnGrouper().next(items);
}

/**
 * Incremental, identity-stable turn grouping.
 *
 * A live stream appends one frame at a time, and every appended frame used to
 * re-run `groupTurnEvents` over the WHOLE array AND hand every consumer brand
 * new group objects — so React re-rendered every turn row on every frame
 * (QA issue D10: 1,000+ frame histories made each frame an O(n) regroup plus
 * a full-list re-render). The grouper keeps the last input/output: when the
 * new items array is an append-only extension of the previous one (checked by
 * cheap reference-equality over the shared prefix), only the appended items
 * are consumed and every COMMITTED group keeps its object identity — so
 * memoized rows skip re-rendering. Only the trailing dense group (still
 * growing until the next message arrives) gets a fresh identity per call.
 *
 * Any non-append change (clear + force reload, truncation, in-place
 * replacement) falls back to a full rebuild — correctness never depends on
 * the append-only fast path.
 */
export interface TurnGrouper {
  next(items: readonly FlowData[]): TurnGroup[];
}

export function createTurnGrouper(): TurnGrouper {
  let prevItems: readonly FlowData[] = [];
  let lastOutput: TurnGroup[] = [];
  /** Frozen groups: message groups, and dense groups sealed by a later message. */
  let committed: TurnGroup[] = [];
  /** Trailing dense run, not yet sealed — rebuilt with fresh identity per call. */
  let tail: FlowData[] = [];
  let skillCallIds = new Set<string>();
  /** Name from the most recent dropped Skill call, awaiting its meta message. */
  let pendingSkillName: string | null = null;

  const reset = () => {
    committed = [];
    tail = [];
    skillCallIds = new Set<string>();
    pendingSkillName = null;
  };

  const consume = (item: FlowData) => {
    const t: string = item.elementType;
    if (MESSAGE_TYPES.has(t)) {
      if (tail.length > 0) {
        committed.push({ kind: 'dense', events: tail, index: committed.length });
        tail = [];
      }
      const isMeta = item.attributes['is-meta'] === 'true';
      const skillName = isMeta && pendingSkillName ? pendingSkillName : undefined;
      if (isMeta) pendingSkillName = null;
      committed.push({ kind: 'message', flowData: item, index: committed.length, skillName });
    } else if (DENSE_TYPES.has(t)) {
      // A `Skill` tool use is already represented in the chat by the skill's
      // meta-injection chip (MetaMessageChip, "Using skill: <name>") — the
      // injected body arrives as an isMeta USER_MESSAGE right after the call.
      // Keeping the TOOL_CALL/TOOL_RESULT in the dense stream too rendered
      // duplicate "Using Skill" chips around that one, so drop the pair here.
      if (NON_ACTIVITY_SUBTYPES.has(item.attributes['subtype'])) return;
      if (isSkillToolEvent(item, skillCallIds)) {
        const name = skillNameOf(item);
        if (name) pendingSkillName = name;
        return;
      }
      tail.push(item);
    }
    // Anything else (END, RESULT, CHECKPOINT, …) is intentionally dropped from
    // the visible chat — the dense surface is for "things the agent did", not
    // every internal stream marker.
  };

  const isAppendOnlyExtension = (items: readonly FlowData[]): boolean => {
    if (items.length < prevItems.length) return false;
    for (let i = 0; i < prevItems.length; i++) {
      if (items[i] !== prevItems[i]) return false;
    }
    return true;
  };

  return {
    next(items: readonly FlowData[]): TurnGroup[] {
      let start: number;
      if (isAppendOnlyExtension(items)) {
        if (items.length === prevItems.length) return lastOutput;
        start = prevItems.length;
      } else {
        reset();
        start = 0;
      }
      for (let i = start; i < items.length; i++) consume(items[i]);
      prevItems = items;
      lastOutput =
        tail.length > 0
          ? [...committed, { kind: 'dense', events: [...tail], index: committed.length }]
          : [...committed];
      return lastOutput;
    },
  };
}

/**
 * React binding for {@link createTurnGrouper}: one grouper per component
 * instance, re-grouping (incrementally) only when the items snapshot changes.
 * Committed groups keep referential identity across appends, so memoized row
 * components skip re-rendering on every live frame.
 */
export function useTurnGroups(items: FlowData[]): TurnGroup[] {
  const grouperRef = useRef<TurnGrouper | null>(null);
  if (grouperRef.current === null) grouperRef.current = createTurnGrouper();
  return useMemo(() => grouperRef.current!.next(items), [items]);
}

/** The worker-side tool name Claude uses to load a skill. */
const SKILL_TOOL_NAME = 'Skill';

function isSkillToolEvent(item: FlowData, skillCallIds: Set<string>): boolean {
  if (
    item.elementType === FlowElementTypes.TOOL_CALL &&
    item.attributes['tool-name'] === SKILL_TOOL_NAME
  ) {
    const id = getToolUseId(item);
    if (id) skillCallIds.add(id);
    return true;
  }
  if (item.elementType === FlowElementTypes.TOOL_RESULT) {
    const id = getToolUseId(item);
    return !!id && skillCallIds.has(id);
  }
  return false;
}

/**
 * The skill a `Skill` TOOL_CALL loaded, from the backend's structured payload.
 * Both the live stream and a replay carry it (`skill-name` attribute /
 * `skill_name` in the flow value), so the chip never has to parse prose.
 */
function skillNameOf(item: FlowData): string | null {
  const attr = item.attributes['skill-name'];
  if (attr) return attr;
  const data = item.data as { skill_name?: unknown; args?: { skill?: unknown } } | undefined;
  if (data && typeof data.skill_name === 'string' && data.skill_name) return data.skill_name;
  const skill = data?.args?.skill;
  return typeof skill === 'string' && skill ? skill : null;
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
  /** The turn ended explicitly (for example, turn_aborted) without a result. */
  terminated: boolean;
}

export function pairToolEvents(events: FlowData[]): {
  pairs: ToolPair[];
  others: FlowData[];
  orphanResults: FlowData[];
  /** How many entries the turn renders as: one per pair, plus non-tool events
   *  and orphan results. The single source of truth for the "N events this
   *  turn" count (the dense-row summary and the footer chip both read it). */
  total: number;
} {
  const pairs: ToolPair[] = [];
  const others: FlowData[] = [];
  const orphanResults: FlowData[] = [];
  const callIndexById = new Map<string, number>();

  for (const item of events) {
    const t = item.elementType;
    if (t === FlowElementTypes.TOOL_CALL) {
      const id = getToolUseId(item);
      const pairIndex = pairs.push({ call: item, result: null, terminated: false }) - 1;
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

  // A turn is terminated when the backend says so semantically
  // (`turn-terminated: "true"`, stamped on flowpad cancel markers AND on
  // replayed vendor abort events), with the raw codex event subtype kept as a
  // fallback for live/PTY streams that bypass the replay stamping path.
  const turnTerminated = others.some(
    (item) =>
      item.elementType === FlowElementTypes.STATUS &&
      (item.attributes['turn-terminated'] === 'true' ||
        item.attributes.subtype === 'event_msg.turn_aborted'),
  );
  if (turnTerminated) {
    for (const pair of pairs) {
      if (pair.result === null) pair.terminated = true;
    }
  }

  return { pairs, others, orphanResults, total: pairs.length + others.length + orphanResults.length };
}
