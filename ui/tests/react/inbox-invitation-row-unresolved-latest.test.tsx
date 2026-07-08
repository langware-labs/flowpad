/**
 * Behavioural lock for the Inbox pending-invitation row (`ConversationListRow`)
 * when a LATER message's FlowMessage entity is unresolved locally.
 *
 * Regression (RCA debug_log.md #14, git_artifact_share_wizard test 2): the row's
 * visibility gate was `inLoadingState = !!lastPtr && !latestMessage`, which hid
 * the ENTIRE row — including a valid pending-invitation Accept row — whenever the
 * LATEST message pointer's FlowMessage entity hadn't materialized locally (e.g. a
 * pre-accept git-artifact share message that never resolves on the recipient).
 * But invitation-ness is driven by the FIRST message, so the gate contradicted
 * itself: the Accept row (testid + data-kind + button) vanished from the DOM and
 * the browser test polled forever.
 *
 * The fix exempts invitation rows from `inLoadingState` — they render from the
 * (materialized) first message regardless of a dangling latest pointer.
 *
 * This drives the REAL row over a REAL `Conversation` with TWO message pointers:
 * the first resolves to an INVITATION-kind FlowMessage (+ a pending Invitation for
 * the viewer); the second (latest) pointer's entity stays undefined. The stand-ins
 * are the boundary hooks: `useEntity` (per-pointer entity resolution — the exact
 * seam the bug lived behind), `useAuth` (viewer identity), `useDockNavigation`.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Conversation } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';

// Shared ids + fakes, hoisted so the vi.mock factory (itself hoisted) can close
// over them without touching outer ESM imports.
const { FIRST_ID, LAST_ID, INV_ID, firstMessageFake, invitationFake } = vi.hoisted(() => {
  const FIRST_ID = 'f1111111-1111-4111-8111-111111111111';
  const LAST_ID = 'a2222222-2222-4222-8222-222222222222'; // latest pointer — entity NEVER resolves
  const INV_ID = 'c3333333-3333-4333-8333-333333333333';
  return {
    FIRST_ID,
    LAST_ID,
    INV_ID,
    // Duck-typed FlowMessage: the row reads .kind, .sender_name, and
    // .firstContextOfType('invitation') off it. 'invitation' === FlowMessageKind.INVITATION.
    firstMessageFake: {
      id: FIRST_ID,
      kind: 'invitation',
      sender_name: 'Alice',
      is_read: false,
      sender_id: 'alice-id',
      firstContextOfType: (t: string) => (t === 'invitation' ? { type: 'invitation', id: INV_ID } : null),
    },
    // Pending invitation addressed to the viewer (me@example.com) → isInvitation true.
    invitationFake: { id: INV_ID, accepted: false, recipient_email: 'me@example.com' },
  };
});

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

// The seam the bug lived behind: per-pointer entity resolution. The first
// message resolves (invitation); the latest pointer's entity stays undefined
// (unresolved git-artifact message); the invitation entity resolves.
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: (typeId: { id?: string } | null | undefined) => {
    const id = typeId?.id;
    if (id === FIRST_ID) return { data: firstMessageFake };
    if (id === INV_ID) return { data: invitationFake };
    return { data: undefined }; // LAST_ID (latest) — deliberately unresolved
  },
  useEntitiesQuery: () => ({ data: [], isLoading: false }),
}));

import { ConversationListRow } from '@src/components/inbox-view/InboxView';

function invitationConvWithUnresolvedLatest(): Conversation {
  return new Conversation({
    id: '99999999-9999-4999-8999-999999999999',
    remote: true,
    message_ids: JSON.stringify([
      { typeid: `flow_message-${FIRST_ID}`, ts: '2026-07-08T10:00:00Z' },
      { typeid: `flow_message-${LAST_ID}`, ts: '2026-07-08T11:00:00Z' },
    ]),
    updated_date: '2026-07-08T11:00:00Z',
  });
}

function renderRow(conv: Conversation, onVisibilityChange = vi.fn()) {
  render(
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
        onVisibilityChange={onVisibilityChange}
        refSetter={() => {}}
      />
    </TooltipProvider>,
  );
  return onVisibilityChange;
}

describe('Inbox invitation row with an unresolved latest message (RCA #14)', () => {
  it('renders the row + testid + data-kind=invitation + Accept CTA even though the latest FlowMessage is unresolved', () => {
    renderRow(invitationConvWithUnresolvedLatest());

    const row = screen.getByTestId('inbox-conversation-row');
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('data-kind', 'invitation');
    // The Accept CTA must be present and actionable (the invitation id resolved).
    const accept = screen.getByTestId('inbox-accept-invitation-button');
    expect(accept).toBeInTheDocument();
    expect(accept).toHaveTextContent('Accept');
  });

  it('reports the row as VISIBLE (not hidden by the loading gate)', () => {
    const onVisibilityChange = renderRow(invitationConvWithUnresolvedLatest());
    // The last visibility report for this conv must be `true` — pre-fix it was
    // `false` because inLoadingState hid the invitation row.
    const calls = onVisibilityChange.mock.calls.filter(
      (c: unknown[]) => c[0] === '99999999-9999-4999-8999-999999999999',
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][1]).toBe(true);
  });
});
