import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowData, FlowElementTypes, PrefKey, instancePreferences } from '@sdk';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';

function replayFlowData(
  elementType: string,
  flowValue: unknown,
  attributes: Record<string, string>,
  index: number,
): FlowData {
  const flowData = FlowData.fromJSON({
    flow_value: flowValue,
    index,
    created_time: `2026-07-10T06:00:00.${String(index).padStart(3, '0')}Z`,
    attributes: {
      'element-type': elementType,
      ...attributes,
    },
  });
  flowData.markReady();
  return flowData;
}

describe('ToolEntryRow replay results', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, true);
  });

  afterEach(() => {
    cleanup();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    ['replay is_error metadata', { is_error: 'true' }],
    ['stream outcome metadata', { outcome: 'error' }],
  ])('renders %s and paired string output', (_label, errorAttributes) => {
    const call = replayFlowData(
      FlowElementTypes.TOOL_CALL,
      {
        tool_name: 'exec_command',
        tool_use_id: 'd01-failing-command',
        tool_call_id: 'd01-failing-command',
        args: { cmd: "sh -c 'exit 7'" },
      },
      {
        'data-type': 'object',
        'tool-name': 'exec_command',
        'tool-use-id': 'd01-failing-command',
      },
      1,
    );
    const result = replayFlowData(
      FlowElementTypes.TOOL_RESULT,
      'D01 deterministic failure',
      {
        'data-type': 'string',
        'tool-name': 'exec_command',
        'tool-use-id': 'd01-failing-command',
        ...errorAttributes,
      },
      2,
    );

    render(<TurnGroupsList groups={groupTurnEvents([call, result])} />);

    fireEvent.click(screen.getByTestId('dense-tool-row-toggle'));
    const toolEntry = screen.getByTestId('tool-entry');
    expect(toolEntry).toHaveAttribute('data-state', 'error');

    fireEvent.click(toolEntry.querySelector('button')!);
    expect(screen.getByText('D01 deterministic failure')).toBeInTheDocument();
  });

  it('renders a replayed semantic operation as completed without a result', () => {
    const operation = replayFlowData(
      FlowElementTypes.TOOL_CALL,
      {
        tool_name: 'apply_patch',
        tool_use_id: 'patch-1',
        tool_call_id: 'patch-1',
        args: { file_path: 'completed.txt', content: 'done' },
      },
      {
        'data-type': 'object',
        'tool-name': 'apply_patch',
        'tool-use-id': 'patch-1',
        'observation-kind': 'replay',
        subtype: 'file_write',
      },
      3,
    );

    render(<TurnGroupsList groups={groupTurnEvents([operation])} />);

    fireEvent.click(screen.getByTestId('dense-tool-row-toggle'));
    const toolEntry = screen.getByTestId('tool-entry');
    expect(toolEntry).toHaveAttribute('data-state', 'done');

    fireEvent.click(toolEntry.querySelector('button')!);
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
  });

  it('does not leave a cancelled unmatched tool running (flowpad abort marker)', () => {
    // Shape of the durable marker `cancel-prompt` persists and `get-history`
    // merges (backend turn_abort.py): vendor-neutral subtype plus the semantic
    // `turn-terminated` attribute the grouping keys on.
    const call = replayFlowData(
      FlowElementTypes.TOOL_CALL,
      { tool_call_id: 'cancelled-headless', args: { cmd: 'sleep 600' } },
      { subtype: 'tool_use', 'tool-name': 'exec_command', 'tool-use-id': 'cancelled-headless' },
      6,
    );
    const marker = replayFlowData(
      FlowElementTypes.STATUS,
      { reason: 'user_interrupt' },
      { subtype: 'turn_aborted', 'turn-terminated': 'true', origin: 'flowpad' },
      7,
    );

    render(<TurnGroupsList groups={groupTurnEvents([call, marker])} />);
    fireEvent.click(screen.getByTestId('dense-tool-row-toggle'));

    expect(screen.getAllByTestId('tool-entry')[0]).toHaveAttribute('data-state', 'done');
  });

  it('does not leave an aborted unmatched tool running', () => {
    const call = replayFlowData(
      FlowElementTypes.TOOL_CALL,
      { tool_call_id: 'cancelled', args: { cmd: 'sleep 60' } },
      { subtype: 'tool_use', 'tool-name': 'exec_command', 'tool-use-id': 'cancelled' },
      4,
    );
    const aborted = replayFlowData(
      FlowElementTypes.STATUS,
      {},
      { subtype: 'event_msg.turn_aborted' },
      5,
    );

    render(<TurnGroupsList groups={groupTurnEvents([call, aborted])} />);
    fireEvent.click(screen.getByTestId('dense-tool-row-toggle'));

    expect(screen.getAllByTestId('tool-entry')[0]).toHaveAttribute('data-state', 'done');
  });
});
