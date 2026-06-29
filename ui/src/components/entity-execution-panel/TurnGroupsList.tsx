import { FlowElementTypes } from '@sdk';
import { ToolEntryRow } from '@src/components/floating-chat/ToolEntryRow';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
import ExecutionMessage from './execution-message/execution-message';
import { MetaMessageChip } from './MetaMessageChip';

/**
 * Renders a `groupTurnEvents` partition: text-shaped turns as
 * {@link ExecutionMessage} bubbles, contiguous tool/reasoning/status runs as a
 * single dense {@link ToolEntryRow} chip. Shared by the floating Flowpad
 * Assistant (via EntityExecutionPanel's dense layout) and the interactive
 * tab's Standard-mode SimpleChatPane so both render identical chat turns.
 */
export function TurnGroupsList({ groups, worker }: { groups: TurnGroup[]; worker?: string }) {
  return (
    <>
      {groups.map((g) =>
        g.kind === 'message' ? (
          g.flowData.attributes?.['is-meta'] === 'true' ? (
            <MetaMessageChip
              key={`meta-${g.flowData.id ?? g.flowData.timestamp ?? g.index}`}
              flowData={g.flowData}
            />
          ) : (
            <ExecutionMessage
              key={`msg-${g.flowData.id ?? g.flowData.timestamp ?? g.index}`}
              flowData={g.flowData}
              worker={worker}
              isUser={
                g.flowData.elementType === FlowElementTypes.USER_MESSAGE ||
                (g.flowData.attributes && g.flowData.attributes.role === 'user')
              }
            />
          )
        ) : (
          <ToolEntryRow key={`dense-${g.index}`} events={g.events} />
        ),
      )}
    </>
  );
}
