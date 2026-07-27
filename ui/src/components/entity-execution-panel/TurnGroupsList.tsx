import { FlowElementTypes, PrefKey } from '@sdk';
import { Fragment, memo } from 'react';
import { ToolEntryRow } from '@src/components/floating-chat/ToolEntryRow';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
import { usePreference } from '@src/hooks/use-preference';
import ExecutionMessage from './execution-message/execution-message';
import { MetaMessageChip } from './MetaMessageChip';

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
 * Renders a `groupTurnEvents` partition: text-shaped turns as
 * {@link ExecutionMessage} bubbles, contiguous tool/reasoning/status runs as a
 * single dense {@link ToolEntryRow} chip. Shared by the floating Flowpad
 * Assistant (via EntityExecutionPanel's dense layout) and the interactive
 * tab's Standard-mode SimpleChatPane so both render identical chat turns.
 */
export function TurnGroupsList({ groups, worker }: { groups: TurnGroup[]; worker?: string }) {
  // "Show tool calls" (default off) gates the dense tool/reasoning/status chips.
  // When off, dense (non-message) groups are dropped so the transcript shows only
  // user/assistant text turns. Toggled from the composer's Tools menu or Preferences → Chat.
  const [showTools] = usePreference<boolean>(PrefKey.CHAT_SHOW_TOOLS);
  const visibleGroups = groups.filter((g) => {
    if (g.kind !== 'message') return showTools;
    if (g.flowData.attributes?.['is-meta'] !== 'true') return true;
    const content = g.flowData.content ?? '';
    return !isFlowpadPromptEnvelope(String(content));
  });

  return (
    <>
      {visibleGroups.map((g, i) => {
        // Partition index `i` is the tiebreaker: two messages can share a
        // timestamp (and lack an id), which collided on `id ?? timestamp` and
        // tripped React's duplicate-key warning (children duplicated/omitted)
        // — visible when the chat re-renders on a mode switch.
        const key =
          g.kind === 'message'
            ? `msg-${i}-${g.flowData.id ?? g.flowData.timestamp ?? ''}`
            : `dense-${i}`;
        return (
          <Fragment key={key}>
            {i > 0 && <TurnDivider />}
            <TurnGroupRow group={g} worker={worker} />
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
}: {
  group: TurnGroup;
  worker?: string;
}) {
  const isUser =
    group.kind === 'message' &&
    (group.flowData.elementType === FlowElementTypes.USER_MESSAGE ||
      group.flowData.attributes?.role === 'user');
  const node =
    group.kind === 'message' ? (
      group.flowData.attributes?.['is-meta'] === 'true' ? (
        <MetaMessageChip flowData={group.flowData} skillName={group.skillName} />
      ) : (
        <ExecutionMessage flowData={group.flowData} worker={worker} isUser={isUser} />
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

function isFlowpadPromptEnvelope(content: string): boolean {
  if (!content.includes('\n# User message\n')) return false;
  return content.startsWith("# You are the '") || content.startsWith('# Embedded agent specs');
}
