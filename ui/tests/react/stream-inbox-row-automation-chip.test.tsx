/**
 * The automation mark on a Stream Inbox row: ⚡ + who, tinted by the session's state; its click opens the
 * session by URL alone, while the row itself still opens the conversation.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { AgenticProcess, Conversation } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import '@src/i18n-init';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';

const openDock = vi.hoisted(() => vi.fn());
vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ cloudUser: { id: 'me-id', email: 'me@example.com' }, currentUser: null }),
  useCloudStatus: () => ({ isLoggedIn: true }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openDock }, currentDock: null }),
}));

import { ConversationListRow } from '@src/components/stream-inbox-view/StreamInboxView';
import { DockPointer } from '@src/navigation/DockPointer';

afterEach(() => {
  cleanup();
  openDock.mockClear();
});

function renderRow(mark?: AgenticProcess) {
  const conv = new Conversation({ id: '22222222-2222-4222-8222-222222222222', title: 'Charged twice for October', message_ids: '[]', updated_date: '2026-06-16T12:00:00Z' } as never);
  return render(
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <ConversationListRow
          conv={conv}
          isFocused={false}
          viewMode="all"
          searchActive={false}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
          onToggleRead={vi.fn()}
          onRequestDelete={vi.fn()}
          cloudUserId="me-id"
          onVisibilityChange={vi.fn()}
          attributionFor={() => null}
          refSetter={() => {}}
          automationMark={mark}
        />
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('Stream Inbox row automation mark', () => {
  it('shows nothing without a session', () => {
    renderRow();
    expect(screen.queryByTestId('stream-inbox-row-automation')).toBeNull();
  });

  it('shows ⚡ + who, tinted by state, and opens the session by URL alone', () => {
    const process = new AgenticProcess({ id: 'p-1', name: 'Billing helper', status: 'running' } as never);
    renderRow(process);
    const mark = screen.getByTestId('stream-inbox-row-automation');
    expect(mark.textContent).toContain('Billing helper');
    expect(mark.getAttribute('data-status')).toBe('running');
    fireEvent.click(mark);
    expect(openDock).toHaveBeenCalledTimes(1);
    expect(openDock.mock.calls[0][0].toUrl('/')).toBe(DockPointer.forProcessRuns({ run: 'p-1' }).toUrl('/'));
  });
});
