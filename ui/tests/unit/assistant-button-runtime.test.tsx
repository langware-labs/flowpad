/**
 * On the hub the Flowpad Assistant button did nothing: the assistant runs from a project
 * on the backend's own disk, and the hub has none.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/floating-chat/floating-chat-context', () => ({
  useFloatingChat: () => ({ open: false, toggle: vi.fn() }),
}));

import { dataContext, RuntimeKind } from '@sdk';
import { FlowpadAssistantButton } from '@src/components/floating-chat/FlowpadAssistantButton';

afterEach(() => {
  cleanup();
  dataContext.bootstrapInfo = null as never;
});

describe('the Flowpad Assistant button', () => {
  it('is not shown on the hub', () => {
    dataContext.bootstrapInfo = { runtime: { kind: RuntimeKind.HUB } } as never;
    render(<FlowpadAssistantButton />);
    expect(screen.queryByTestId('flowpad-assistant-button')).toBeNull();
  });

  it.each([RuntimeKind.DESKTOP, RuntimeKind.SANDBOX])('is shown on %s', (kind) => {
    dataContext.bootstrapInfo = { runtime: { kind } } as never;
    render(<FlowpadAssistantButton />);
    expect(screen.getByTestId('flowpad-assistant-button')).toBeTruthy();
  });
});
