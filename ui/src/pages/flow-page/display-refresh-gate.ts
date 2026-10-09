import { type FlowData, FlowDataSource, FlowElementTypes } from '@sdk';

/**
 * Should the vibe display remount at this turn edge?
 *
 * The display refreshes on the agent's turn edge because the CLI stream carries
 * no per-file write signal (see `refreshStamp` in vibe-workspace.tsx). This gate
 * keeps that signal and only drops the edges that provably changed nothing:
 * a turn whose new frames hold no tool call outside a read-only allowlist,
 * while no backgrounded work is still running. Everything it cannot read —
 * an unknown tool, a nameless call, a reset stream — refreshes, which is the
 * behavior the gate replaced.
 *
 * Background work outlives its turn and may write after the edge, so while any
 * is open EVERY edge refreshes. What the stream shows of it (measured on a live
 * Claude vibe stream): `run_in_background` is not forwarded in a tool call's
 * args, so the start is the `task_started` status frame (`is_backgrounded`),
 * and the end is the `task_notification` status frame, both keyed by
 * `tool_use_id`. An `Agent`/`Task` call (or `run_in_background: true` when a
 * worker does forward it) also opens one, under its tool_use_id. A launch with
 * no id can never be matched to its end, so it stays open — the gate then
 * degrades to always-refresh, by design. A `task_notification` refreshes its
 * edge even when its launch was never seen: the history replay carries no
 * status frames, so work launched before a reload is only visible as it ends.
 *
 * The first edge after a mount judges a stream that includes the history
 * replay (`source: history`). Those frames predate the display that is now
 * showing, so they are bookkeeping only — never write evidence, and never a
 * background launch to hold open.
 */
export interface DisplayRefreshGate {
  /** Every frame already judged at an earlier edge (by identity). */
  readonly seen: ReadonlySet<FlowData>;
  /** Keys of background work launched and not yet seen completing. */
  readonly openBackground: ReadonlySet<string>;
  /** False until the first edge after a mount has been judged. */
  readonly primed: boolean;
}

export const EMPTY_DISPLAY_REFRESH_GATE: DisplayRefreshGate = Object.freeze({
  seen: new Set<FlowData>(),
  openBackground: new Set<string>(),
  primed: false,
});

/** Tools that cannot change what the display shows. Anything else may. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'TodoWrite',
  'AskUserQuestion',
]);

/** Tools whose work runs on after the call returns. */
const BACKGROUND_TOOLS = new Set(['Agent', 'Task']);

/** Opens with no id get a key nothing can close. */
const UNCLOSABLE = '\0unclosable';

function objectData(frame: FlowData): Record<string, unknown> | null {
  const d = frame.data as unknown;
  if (d && typeof d === 'object') return d as Record<string, unknown>;
  if (typeof d !== 'string' || !d.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(d) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * One top-level scalar of a status payload. Status frames carry their payload
 * as JSON text the backend truncates (measured: cut at 400 chars, mid-string),
 * so a long `task_notification` does not parse. The ids and flags sit near the
 * front, so a failed parse falls back to reading them by key.
 */
function statusField(frame: FlowData, key: string): unknown {
  const data = objectData(frame);
  if (data) return data[key];
  if (typeof frame.data !== 'string') return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*(?:"([^"\\\\]*)"|(true|false))`).exec(frame.data);
  if (!match) return undefined;
  return match[1] ?? match[2] === 'true';
}

interface FrameEffect {
  /** May have changed what the display shows. */
  mayWrite: boolean;
  opens: string[];
  closes: string[];
}

function effectOf(frame: FlowData): FrameEffect {
  const none: FrameEffect = { mayWrite: false, opens: [], closes: [] };
  if (frame.elementType === FlowElementTypes.TOOL_CALL) {
    const data = objectData(frame);
    const name = str(frame.attributes['tool-name']) ?? str(data?.tool_name);
    const id = str(frame.attributes['tool-use-id']) ?? str(data?.tool_use_id) ?? UNCLOSABLE;
    const args = data?.args as Record<string, unknown> | undefined;
    const backgrounded = (name !== null && BACKGROUND_TOOLS.has(name)) || args?.run_in_background === true;
    return {
      mayWrite: name === null || !READ_ONLY_TOOLS.has(name),
      opens: backgrounded ? [id] : [],
      closes: [],
    };
  }
  if (frame.elementType === FlowElementTypes.STATUS) {
    const subtype = frame.attributes['subtype'];
    if (subtype !== 'task_started' && subtype !== 'task_notification') return none;
    const keys = [str(statusField(frame, 'tool_use_id')), str(statusField(frame, 'task_id'))].filter(
      (k): k is string => k !== null,
    );
    // Its work ended inside this window, so whatever it wrote is new here.
    if (subtype === 'task_notification') return { mayWrite: true, opens: [], closes: keys };
    if (statusField(frame, 'is_backgrounded') !== true) return none;
    // One key per task: tool_use_id, the same key its Agent/Task call opened under.
    return { mayWrite: false, opens: [keys[0] ?? UNCLOSABLE], closes: [] };
  }
  return none;
}

/**
 * Judge the frames that arrived since the last edge and return the decision
 * plus the gate for the next edge. "New" is by frame identity, not index: the
 * stream is timestamp-sorted and retires optimistic echoes, so positions shift;
 * and a frame that lands after its own edge is simply judged at the next one.
 */
export function advanceDisplayRefreshGate(
  gate: DisplayRefreshGate,
  items: readonly FlowData[],
): { refresh: boolean; gate: DisplayRefreshGate } {
  // Reset: the stream was cleared or replaced since the last edge, so nothing
  // tells us what is new. Rebuild the background state from all of it.
  const reset = gate.seen.size > 0 && !items.some((f) => gate.seen.has(f));
  const open = new Set(reset ? [] : gate.openBackground);
  let refresh = reset || open.size > 0;
  for (const frame of items) {
    if (!reset && gate.seen.has(frame)) continue;
    const effect = effectOf(frame);
    const predatesMount = !gate.primed && frame.source === FlowDataSource.History;
    if (effect.mayWrite && !predatesMount) refresh = true;
    // A replayed launch can never be closed — the replay carries no status
    // frames — so opening on it would refresh every edge for the session. Work
    // still running from before the mount refreshes when its notification lands.
    if (!predatesMount) for (const key of effect.opens) open.add(key);
    for (const key of effect.closes) open.delete(key);
  }
  if (open.size > 0) refresh = true;
  return { refresh, gate: { seen: new Set(items), openBackground: open, primed: true } };
}
