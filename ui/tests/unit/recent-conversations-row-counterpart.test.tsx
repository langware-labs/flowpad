/**
 * R18 — the sharer's Recent conversations strip tells invite conversations apart.
 *
 * A project share opens one conversation per invitee, each titled after the
 * shared entity ("P"), with exactly two participants: the sharer and that
 * invitee. Labelled by title alone, the sharer saw N identical "P" rows. A
 * two-person conversation now leads with the counterpart's name.
 *
 * Drives the REAL `ConversationRow` over REAL `Conversation` entities (no
 * messages, no project/task links). Stand-ins are only the ambient boundary
 * hooks `useAuth` (viewer identity) and `useDockNavigation` (router shortcut),
 * mirroring tests/react/stream-inbox-row-subject.test.tsx. Unit tier: the row
 * needs no backend (no project, task or message links to resolve).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  useCurrentDock: () => null,
  useDockNavigation: () => ({
    navigation: { openDock: vi.fn() },
    currentDock: null,
  }),
}));

import { ConversationRow } from '@src/components/project-activity-strip/RecentConversationsStrip';

const ME = { user_id: 'me-id', name: 'Sharer', email: 'me@example.com', role: 'owner' };

function inviteConversation(id: string, invitee: { user_id: string; name: string; email: string }) {
  return new Conversation({
    id,
    title: 'P',
    message_ids: '[]',
    updated_date: '2026-09-27T12:00:00Z',
    members: [ME, { ...invitee, role: 'member' }],
  });
}

function renderRow(conv: Conversation) {
  return render(
    <TooltipProvider>
      <ConversationRow
        conv={conv}
        attributionFor={() => null}
        acceptingId={null}
        dismissingId={null}
        onAcceptInvitation={vi.fn()}
        onDismiss={vi.fn()}
        onHiddenChange={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe('Recent conversations row — two-person conversations', () => {
  afterEach(() => cleanup());

  it('labels two invite conversations for P with the two invitees names', () => {
    renderRow(
      inviteConversation('11111111-1111-4111-8111-111111111111', {
        user_id: 'bob-id',
        name: 'Bob',
        email: 'bob@example.com',
      }),
    );
    renderRow(
      inviteConversation('22222222-2222-4222-8222-222222222222', {
        user_id: 'carol-id',
        name: 'Carol',
        email: 'carol@example.com',
      }),
    );

    const labels = screen.getAllByTestId('conversation-from').map((el) => el.textContent ?? '');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('Bob');
    expect(labels[1]).toContain('Carol');
    // The entity title stays visible beside the name.
    expect(labels[0]).toContain('P');
    expect(labels[0]).not.toEqual(labels[1]);
  });

  it('leaves an untitled two-person row on its participant list', () => {
    const conv = new Conversation({
      id: '44444444-4444-4444-8444-444444444444',
      message_ids: '[]',
      updated_date: '2026-09-27T12:00:00Z',
      members: [ME, { user_id: 'bob-id', name: 'Bob', email: 'bob@example.com', role: 'member' }],
    });

    renderRow(conv);

    expect(screen.getByTestId('conversation-from').textContent).toBe('Sharer, Bob');
  });

  it('keeps the plain title for a group conversation', () => {
    const conv = new Conversation({
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Team sync',
      message_ids: '[]',
      updated_date: '2026-09-27T12:00:00Z',
      members: [
        ME,
        { user_id: 'bob-id', name: 'Bob', email: 'bob@example.com', role: 'member' },
        { user_id: 'carol-id', name: 'Carol', email: 'carol@example.com', role: 'member' },
      ],
    });

    renderRow(conv);

    expect(screen.getByTestId('conversation-from').textContent).toBe('Team sync');
  });
});
