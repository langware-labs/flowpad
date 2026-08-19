import { AgenticProcess, FlowData, FlowElementTypes, PrefKey, type Agent } from '@sdk';
import { Fragment, memo, useMemo } from 'react';
import { ToolEntryRow } from '@src/components/floating-chat/ToolEntryRow';
import { planTurnFiles } from '@src/components/floating-chat/turnFiles';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
import { usePreference } from '@src/hooks/use-preference';
import ExecutionMessage from './execution-message/execution-message';
import { MetaMessageChip } from './MetaMessageChip';
import { TurnFilesChips } from './TurnFilesChips';
import { WorkerUnavailableNotice } from './WorkerUnavailableNotice';
import type { WorkerType } from '@src/components/workers/worker-types';

/**
 * Subtle book-style separator between turns: a short, centered hairline that
 * stops well short of either edge, rather than an edge-to-edge rule.
 */
function TurnDivider() {
  return (
    <div className="flex justify-center py-1" aria-hidden="true">
      <div className="h-px w-1/4 bg-border/50" />
    </div>
  );
}

/**
 * Is this group rendered at all?
 *
 * "Show tool calls" (default off) gates the dense tool/reasoning/status chips.
 * When off, dense (non-message) groups are dropped so the transcript shows only
 * user/assistant text turns. Toggled from the composer's Tools menu or
 * Preferences → Chat. The Flowpad prompt envelope is never shown.
 *
 * A group that paints NOTHING must also be excluded: the divider is decided per
 * visible group below, while the decision to render nothing happens two levels
 * down in the leaf renderers — so a silent group used to leave a hairline with
 * no message under it (FLOWPAD-1983).
 *
 * Exported because the turn-files plan has to agree with the render about
 * which rows exist — two copies of this rule would drift the first time either
 * is touched.
 */
export function isRenderedGroup(g: TurnGroup, showTools: boolean): boolean {
  if (g.kind === 'worker-unavailable') return true;
  // Mirrors ToolEntryRow's own `totalCount === 0 → null`: its `total` counts
  // every event exactly once (a result either fills its call's pair or lands
  // in `orphanResults`), so `total === 0` is precisely an empty run. A
  // committed dense group can be emptied after the fact by the grouper's
  // `retract`, when a refinement supersedes its only event.
  if (g.kind === 'dense') return showTools && g.events.length > 0;
  if (g.flowData.attributes?.['is-meta'] !== 'true') return paintsSomething(g.flowData);
  const content = g.flowData.content ?? '';
  return !isFlowpadPromptEnvelope(String(content));
}

/**
 * Renders a `groupTurnEvents` partition: text-shaped turns as
 * {@link ExecutionMessage} bubbles, contiguous tool/reasoning/status runs as a
 * single dense {@link ToolEntryRow} chip. Shared by the floating Flowpad
 * Assistant (via EntityExecutionPanel's dense layout) and the interactive
 * tab's Standard-mode SimpleChatPane so both render identical chat turns.
 *
 * Standard mode additionally opts into a per-turn "files touched" chip row —
 * see `showTurnFiles`.
 */
export function TurnGroupsList({
  groups,
  worker,
  agent,
  onWorkerChange,
  showTurnFiles = false,
  process,
  turnActive = false,
}: {
  groups: TurnGroup[];
  worker?: string;
  /** The Agent the process runs as — signs assistant turns (avatar + name). */
  agent?: Agent | null;
  onWorkerChange?: (worker: WorkerType) => void | Promise<void>;
  /**
   * Opt-in: render a "files this turn touched" chip row under each ended turn.
   * Off by default, so the floating-assistant / vibe consumer is unaffected.
   */
  showTurnFiles?: boolean;
  /** The session those chips resolve their paths against. */
  process?: AgenticProcess | null;
  /**
   * The trailing turn is still running — its chips wait until it settles, since
   * a turn's file list isn't final until the turn is.
   *
   * NOTE for future consumers: pass the UNSPLIT groups. A caller that trims the
   * live tail with `splitLiveGroup` hides the in-flight turn's writes from this
   * trace entirely.
   */
  turnActive?: boolean;
}) {
  const [showTools] = usePreference<boolean>(PrefKey.CHAT_SHOW_TOOLS);
  const rendered = useMemo(() => groups.map((g) => isRenderedGroup(g, showTools)), [groups, showTools]);
  const visibleGroups = useMemo(() => groups.filter((_, i) => rendered[i]), [groups, rendered]);

  // Skin-layer rule (docs/viewmodes.md): the data is built unconditionally and
  // only the VIEW is gated, so toggling view mode never changes what the chat
  // computes. The plan reads every group — including the dense ones the
  // transcript is hiding — which is exactly the case this feature exists for.
  const turnFiles = useMemo(
    () => planTurnFiles(groups, rendered, { lastTurnEnded: !turnActive }),
    [groups, rendered, turnActive],
  );

  const chipsForRow = (row: number) => {
    if (!showTurnFiles) return null;
    const files = turnFiles.byRow.get(row);
    return files ? <TurnFilesChips files={files} process={process} /> : null;
  };

  return (
    <>
      {/* A turn whose every group was filtered out still touched files. */}
      {chipsForRow(-1)}
      {visibleGroups.map((g, i) => {
        // Partition index `i` is the tiebreaker: two messages can share a
        // timestamp (and lack an id), which collided on `id ?? timestamp` and
        // tripped React's duplicate-key warning (children duplicated/omitted)
        // — visible when the chat re-renders on a mode switch.
        const key =
          g.kind === 'message'
            ? `msg-${i}-${g.flowData.id ?? g.flowData.timestamp ?? ''}`
            : g.kind === 'worker-unavailable'
              ? `worker-unavailable-${i}-${g.flowData.timestamp ?? ''}`
              : `dense-${i}`;
        return (
          <Fragment key={key}>
            {i > 0 && <TurnDivider />}
            {/* TurnGroupRow stays memoized — that memo is what keeps a live
                frame from re-rendering the whole history (QA D10). The chip row
                is a sibling, and it sits BEFORE the next divider so it reads as
                part of the turn that produced it. */}
            <TurnGroupRow
              group={g}
              worker={worker}
              agent={agent}
              // useEntity keeps ONE object per entity and mutates it, so `agent`
              // is referentially stable across a rename / new avatar; the memo
              // needs a value that moves with the row to repaint.
              agentVersion={agent?.updated_date ?? null}
              onWorkerChange={onWorkerChange}
            />
            {chipsForRow(i)}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * One turn row, memoized on group identity. `useTurnGroups`'s incremental
 * grouper keeps committed groups referentially stable across live appends, so
 * a streaming frame re-renders ONLY the trailing (still-growing) group instead
 * of every row — the fix for QA issue D10's large-history render blowup.
 */
const TurnGroupRow = memo(function TurnGroupRow({
  group,
  worker,
  agent,
  onWorkerChange,
}: {
  group: TurnGroup;
  worker?: string;
  agent?: Agent | null;
  /** Memo key only — see the call site. */
  agentVersion?: unknown;
  onWorkerChange?: (worker: WorkerType) => void | Promise<void>;
}) {
  const isUser =
    group.kind === 'message' &&
    (group.flowData.elementType === FlowElementTypes.USER_MESSAGE || group.flowData.attributes?.role === 'user');
  const node =
    group.kind === 'worker-unavailable' ? (
      <WorkerUnavailableNotice flowData={group.flowData} worker={worker} onWorkerChange={onWorkerChange} />
    ) : group.kind === 'message' ? (
      group.flowData.attributes?.['is-meta'] === 'true' ? (
        <MetaMessageChip flowData={group.flowData} skillName={group.skillName} />
      ) : (
        <ExecutionMessage flowData={group.flowData} worker={worker} agent={agent} isUser={isUser} />
      )
    ) : (
      <ToolEntryRow events={group.events} />
    );
  // `display: contents` wrapper carries the role for read-back/tests without
  // generating a box (no layout impact). Assistant turns = message groups
  // that aren't the user echo; dense tool runs aren't a chat role.
  const role = group.kind === 'message' ? (isUser ? 'user' : 'assistant') : undefined;
  return role ? (
    <div className="contents" data-role={role}>
      {node}
    </div>
  ) : (
    node
  );
});

/**
 * Will {@link ExecutionMessage} paint anything for this frame? It early-returns
 * `null` on blank content, so without this the group still claimed a divider.
 *
 * `ready === false` means the frame is STILL STREAMING, and a streaming frame is
 * legitimately blank between its start tag and its first chunk (`content` falls
 * back to the accumulating `rawData`). Those chunks consolidate in place without
 * re-emitting the stream's `data` event, so nothing would re-run this filter —
 * dropping an in-flight frame here would hide the assistant's reply for the whole
 * turn. Keep it mounted and let ExecutionMessage decide frame by frame.
 */
function paintsSomething(flowData: FlowData): boolean {
  if (flowData.ready === false) return true;
  return !!String(flowData.content ?? '').trim();
}

function isFlowpadPromptEnvelope(content: string): boolean {
  if (!content.includes('\n# User message\n')) return false;
  return content.startsWith("# You are the '") || content.startsWith('# Embedded agent specs');
}
