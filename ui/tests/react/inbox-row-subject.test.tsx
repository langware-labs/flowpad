/**
 * Behavioural lock for the Inbox row subject (`ConversationListRow`).
 *
 * Regression: a conversation that carries a user-set / hub-synced ``title`` but
 * has NO linked task rendered the literal "(no subject)" placeholder, because
 * the subject was derived solely from ``task?.displayName`` and the
 * conversation's own ``title`` was never consulted. The fix falls back to
 * ``conv.title`` before the placeholder.
 *
 * This drives the REAL row + the REAL subject-derivation logic over a REAL
 * ``Conversation`` entity (no task, no messages). The only stand-ins are the
 * ambient boundary hooks ``useAuth`` (viewer identity) and ``useDockNavigation``
 * (router shortcut) — neither is the logic under test; they merely satisfy the
 * row's environment. Mirrors conversation-member-permissions.test.tsx.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Conversation } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({
    cloudUser: { id: 'me-id', email: 'me@example.com' },
    currentUser: null,
  }),
  useCloudStatus: () => ({ isLoggedIn: true }),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn() },
    currentDock: null,
  }),
}));

import { ConversationListRow } from '@src/components/inbox-view/InboxView';

function renderRow(conv: Conversation) {
  return render(
    <TooltipProvider>
      <ConversationListRow
        conv={conv}
        isFocused={false}
        viewMode="inbox"
        searchActive={false}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onToggleRead={vi.fn()}
        onRequestDelete={vi.fn()}
        cloudUserId="me-id"
        onVisibilityChange={vi.fn()}
        refSetter={() => {}}
      />
    </TooltipProvider>,
  );
}

describe('Inbox row subject', () => {
  it('shows the conversation title when there is no linked task', () => {
    // A titled, task-less conversation — exactly the shape that regressed to
    // "(no subject)". No message pointers so the row is not in a loading state.
    const conv = new Conversation({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'My Important Discussion',
      message_ids: '[]',
      updated_date: '2026-06-16T12:00:00Z',
    });

    renderRow(conv);

    const subjectLine = screen.getByTestId('inbox-row-subject-line');
    expect(subjectLine).toHaveTextContent('My Important Discussion');
    expect(subjectLine).not.toHaveTextContent('(no subject)');
  });

  it('still shows "(no subject)" when the conversation has no title and no task', () => {
    const conv = new Conversation({
      id: '22222222-2222-4222-8222-222222222222',
      message_ids: '[]',
      updated_date: '2026-06-16T12:00:00Z',
    });

    renderRow(conv);

    expect(screen.getByTestId('inbox-row-subject-line')).toHaveTextContent('(no subject)');
  });
});
