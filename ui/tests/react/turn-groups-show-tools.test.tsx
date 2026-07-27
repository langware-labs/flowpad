import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowElementTypes, PrefKey, instancePreferences } from '@sdk';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';

// Stub the heavy leaf renderers so the test isolates TurnGroupsList's own
// group-visibility logic (the "Show tool calls" gate) from their internals.
vi.mock('@src/components/floating-chat/ToolEntryRow', () => ({
  ToolEntryRow: () => <div data-testid="tool-entry-row" />,
}));
vi.mock('@src/components/entity-execution-panel/execution-message/execution-message', () => ({
  default: () => <div data-testid="execution-message" />,
}));
vi.mock('@src/components/entity-execution-panel/MetaMessageChip', () => ({
  MetaMessageChip: () => <div data-testid="meta-message-chip" />,
}));

import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';

const groups: TurnGroup[] = [
  {
    kind: 'message',
    index: 0,
    flowData: {
      id: 'u1',
      elementType: FlowElementTypes.USER_MESSAGE,
      content: 'hello',
    } as never,
  },
  { kind: 'dense', index: 1, events: [{ id: 'e1' } as never] },
];

describe('TurnGroupsList — Show tool calls gate', () => {
  beforeEach(() => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });
  afterEach(() => {
    cleanup();
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, false);
  });

  it('hides dense tool rows when the pref is off (default)', () => {
    render(<TurnGroupsList groups={groups} />);
    expect(screen.getByTestId('execution-message')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-entry-row')).not.toBeInTheDocument();
  });

  it('shows dense tool rows when the pref is on', () => {
    instancePreferences.set(PrefKey.CHAT_SHOW_TOOLS, true);
    render(<TurnGroupsList groups={groups} />);
    expect(screen.getByTestId('execution-message')).toBeInTheDocument();
    expect(screen.getByTestId('tool-entry-row')).toBeInTheDocument();
  });
});
