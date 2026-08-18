import { t } from '@lingui/core/macro';
import { FlowData, FlowElementTypes, WorkerStatus } from '@sdk';
import type { LucideIcon } from 'lucide-react';

import { getToolUseId } from '@src/components/floating-chat/groupTurnEvents';
import { describeEvent } from '@src/components/floating-chat/toolEventDescriptor';

/** What the agent is doing RIGHT NOW, phrased for the chat activity line. */
export interface CurrentActivity {
  /**
   * Identity of the underlying operation — the tool_use id when the frame
   * carries one, else the kind+detail pair. Lets consumers tell "a different
   * operation" from "the same operation re-derived on a new render", which is
   * what the minimum-display latch keys on.
   */
  key: string;
  icon: LucideIcon;
  /** Present-participle phrase — "Editing", "Running", "Searching". */
  label: string;
  /** The thing being acted on, shortened to fit one line. May be empty. */
  detail: string;
  /** The untruncated detail, for the tooltip. */
  title: string;
}

/**
 * Hard cap on the detail string. This is a payload guard, NOT the visual
 * limit — the line truncates with CSS at whatever width the pane has, so this
 * only exists to keep a pathological multi-KB command out of the DOM and the
 * tooltip. Keep it well above what fits on screen or it clips text the pane
 * had room for.
 */
const MAX_DETAIL = 200;

const FILE_KINDS = new Set(['file_read', 'file_write', 'file_edit']);

/**
 * Kinds whose detail is deliberately withheld from the line.
 *
 * A shell command is unbounded prose — pipelines, quoted heredocs, absolute
 * paths — and unlike a file path it has no short form that stays meaningful, so
 * any clipping of it reads as noise rather than information. It gets a
 * self-contained label instead ("Running command…") and no detail at all. The
 * command itself stays one click away in the turn's event list.
 */
const HIDDEN_DETAIL_KINDS = new Set(['shell_command']);

/**
 * Describe what the agent is doing in the CURRENT turn: the newest operation,
 * or null when the newest thing it did was think (or it has done neither).
 *
 * Null is a real answer, not a failure — it means "no operation is the current
 * story", and the caller falls back to the coarse phase label. That is what
 * makes the readout follow the agent between tools instead of freezing on the
 * last file it touched. Two independent signals produce it: a REASONING frame
 * newer than the last tool call, and the worker reporting THINKING.
 *
 * Deliberately the newest TOOL_CALL, not the newest *unanswered* one. Pairing a
 * call against its TOOL_RESULT reads as the stricter, more honest rule, but it
 * silently loses the common case: `Edit` / `Read` / `Write` finish so fast that
 * the unanswered state may never survive a render, so the operations the ticket
 * most wants named ("Editing file X") would essentially never appear. The
 * newest call is what the agent most recently reached for, which is the useful
 * answer whether or not its result has landed. `ChatActivityLine` holds each
 * one on screen for a minimum time so a fast operation is still readable —
 * see `useStickyActivity`.
 *
 * Dropping the pairing check puts the whole weight of correctness on
 * {@link currentTurnSlice}: with no "is it finished?" test left, a frame from an
 * earlier turn would be reported as current activity forever. The scoping is
 * what makes this rule safe, not an optimisation on top of it.
 */
export function describeCurrentActivity(
  events: readonly FlowData[],
  turnStartedAt: number | null,
  workerStatus: WorkerStatus | null = null,
): CurrentActivity | null {
  // The worker saying THINKING is the authoritative "that operation is over".
  // A reasoning FRAME is the same news, but only arrives when the model emits a
  // thinking block — plenty of turns think without one, and then the newest
  // frame stays the finished tool call and the line sits on "Reading" for as
  // long as the model deliberates. The status moves either way, so it is the
  // signal that actually unsticks the readout.
  if (workerStatus === WorkerStatus.THINKING) return null;

  const scoped = currentTurnSlice(events, turnStartedAt);

  for (let i = scoped.length - 1; i >= 0; i--) {
    const event = scoped[i];
    // Thinking supersedes the operation before it. Once the agent is reasoning
    // again, the last tool it ran is no longer what is happening — leaving
    // "Reading · foo.ts" up would keep asserting an operation that has already
    // finished. Returning null hands the line back to the generic phase label
    // ("Thinking"), and the caller's minimum-display window still applies, so
    // the operation cannot be cut short by a reasoning frame that lands
    // immediately after it.
    if (event.elementType === FlowElementTypes.REASONING) return null;
    if (event.elementType !== FlowElementTypes.TOOL_CALL) continue;
    const { kind, icon, label, detail } = describeEvent(event);
    const hideDetail = HIDDEN_DETAIL_KINDS.has(kind);
    return {
      // Keyed on the real detail even when it is not shown, so two different
      // commands stay two distinct operations to the display latch.
      key: getToolUseId(event) ?? `${kind}:${detail}`,
      icon,
      label: gerundFor(kind, label),
      detail: hideDetail ? '' : shorten(kind, detail),
      title: hideDetail ? '' : detail,
    };
  }

  return null;
}

/**
 * The tail of the buffer that belongs to the turn running right now.
 *
 * Two independent cuts, because a resumed session violates both assumptions the
 * naive "read the trailing dense group" approach makes:
 *
 *  1. **History boundary.** Resuming hydrates the stream with the previous
 *     session's transcript, and those frames are stamped `replay` by every
 *     driver (`observation_kind` on the `ProcessEntry`, mirrored to an
 *     `observation-kind` attribute). Walking back from the end, the first
 *     replayed frame IS the boundary — nothing behind it is live, so we stop
 *     there rather than reaching further back for an older operation.
 *  2. **Turn boundary.** Within one live session the buffer still holds earlier
 *     turns. Anything stamped before the current turn started belongs to a
 *     previous one.
 *
 * Both cuts fail OPEN: a frame with no observation kind, or with an
 * unparseable timestamp, is kept. Losing the readout entirely is worse than
 * occasionally being one frame generous, and the pairing rule above is the
 * backstop for the generous case.
 */
function currentTurnSlice(events: readonly FlowData[], turnStartedAt: number | null): readonly FlowData[] {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (isReplayed(events[i])) {
      start = i + 1;
      break;
    }
  }
  const live = start === 0 ? events : events.slice(start);
  if (turnStartedAt == null) return live;
  const firstOfTurn = live.findIndex((event) => {
    const at = timestampMs(event);
    return at == null || at >= turnStartedAt;
  });
  // -1 means NOTHING here belongs to the current turn — an empty slice, not the
  // whole buffer. Collapsing that into the `<= 0` "start from the top" case is
  // how every frame of a finished turn gets reported as current activity.
  if (firstOfTurn < 0) return [];
  return firstOfTurn === 0 ? live : live.slice(firstOfTurn);
}

/** Was this frame observed on replay (i.e. it is history, not live activity)? */
function isReplayed(event: FlowData): boolean {
  const fromEntry = (event.processEntry as { observation_kind?: unknown } | null)?.observation_kind;
  if (typeof fromEntry === 'string') return fromEntry === 'replay';
  return event.attributes['observation-kind'] === 'replay';
}

/** Epoch ms for a frame, or null when it carries no parseable timestamp. */
function timestampMs(event: FlowData): number | null {
  if (!event.timestamp) return null;
  const ms = Date.parse(event.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The operation's verb in the progressive tense — the activity line reads as
 * "what is happening", where the chips read as "what happened" ("Edit · path").
 * Unrecognized kinds keep the descriptor's own label, which already reads as a
 * name ("flow show", "Grep") rather than a past-tense verb.
 */
function gerundFor(kind: string, fallback: string): string {
  switch (kind) {
    case 'file_read':
      return t`Reading`;
    case 'file_write':
      return t`Writing`;
    case 'file_edit':
      return t`Editing`;
    // Carries its own object because no detail follows it — see
    // HIDDEN_DETAIL_KINDS.
    case 'shell_command':
      return t`Running command…`;
    case 'search':
      return t`Searching`;
    case 'web_fetch':
      return t`Fetching`;
    case 'skill_call':
      return t`Using skill`;
    case 'agent_spawn':
      return t`Delegating to`;
    case 'todo_update':
      return t`Updating plan`;
    default:
      return fallback;
  }
}

/**
 * One line's worth of detail. A path collapses to its basename (the full path
 * stays in the tooltip) — a chat footer is too narrow for a repo-absolute path,
 * and the tail is the part that identifies the file. Everything else is
 * flattened to a single line and clipped.
 */
function shorten(kind: string, detail: string): string {
  if (!detail) return '';
  if (FILE_KINDS.has(kind)) {
    const segments = detail.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : detail;
  }
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL - 1)}…` : oneLine;
}
