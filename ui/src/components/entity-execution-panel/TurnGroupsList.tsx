import { FlowElementTypes } from '@sdk';
import { Fragment } from 'react';
import { ToolEntryRow } from '@src/components/floating-chat/ToolEntryRow';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
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
  const visibleGroups = groups.filter((g) => {
    if (g.kind !== 'message') return true;
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
        const isUser =
          g.kind === 'message' &&
          (g.flowData.elementType === FlowElementTypes.USER_MESSAGE ||
            g.flowData.attributes?.role === 'user');
        const node =
          g.kind === 'message' ? (
            g.flowData.attributes?.['is-meta'] === 'true' ? (
              <MetaMessageChip flowData={g.flowData} />
            ) : (
              <ExecutionMessage flowData={g.flowData} worker={worker} isUser={isUser} />
            )
          ) : (
            <ToolEntryRow events={g.events} />
          );
        // `display: contents` wrapper carries the role for read-back/tests without
        // generating a box (no layout impact). Assistant turns = message groups
        // that aren't the user echo; dense tool runs aren't a chat role.
        const role = g.kind === 'message' ? (isUser ? 'user' : 'assistant') : undefined;
        return (
          <Fragment key={key}>
            {i > 0 && <TurnDivider />}
            {role ? (
              <div className="contents" data-role={role}>
                {node}
              </div>
            ) : (
              node
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function isFlowpadPromptEnvelope(content: string): boolean {
  if (!content.includes('\n# User message\n')) return false;
  return content.startsWith("# You are the '") || content.startsWith('# Embedded agent specs');
}
