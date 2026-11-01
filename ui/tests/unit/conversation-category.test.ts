/**
 * Unit tests for the shared conversation-category classifier.
 *
 * Pure logic — no backend. Covers the priority order of `primary` and the
 * viewer-relativity invariant: the SAME conversation is an invitation row for
 * the recipient but a normal row for the sender.
 */
import { describe, expect, it } from 'vitest';
import { Conversation, ConversationKind, FlowMessage, FlowMessageKind, Invitation } from '@sdk';
import { ConversationStatus } from '@sdk/entities/conversation';
import {
  chipsFor,
  conversationFacets,
  deskChipLabel,
  ticketChip,
  ticketState,
  type CategoryInputs,
} from '@src/components/conversation/conversation-category';

// Minimal shaped stand-ins — the classifier only reads the fields below.
function makeInputs(over: {
  kind?: ConversationKind;
  archived_at?: string | null;
  latestPtrTs?: string | null;
  firstKind?: FlowMessageKind;
  latestRead?: boolean;
  accepted?: boolean;
  recipientEmail?: string | null;
  viewerEmail?: string;
}): CategoryInputs {
  const conv = {
    kind: over.kind ?? ConversationKind.DIRECT,
    archived_at: over.archived_at ?? null,
  } as unknown as Conversation;
  const firstMessage = over.firstKind !== undefined ? ({ kind: over.firstKind } as unknown as FlowMessage) : null;
  const latestMessage = over.latestRead !== undefined ? ({ is_read: over.latestRead } as unknown as FlowMessage) : null;
  const invitation =
    over.recipientEmail !== undefined || over.accepted !== undefined
      ? ({ recipient_email: over.recipientEmail ?? null, accepted: over.accepted ?? false } as unknown as Invitation)
      : null;
  return {
    conv,
    firstMessage,
    latestMessage,
    latestPtrTs: over.latestPtrTs ?? null,
    invitation,
    viewer: { email: over.viewerEmail ?? 'me@x.test', cloudUserId: null },
  };
}

describe('conversationFacets', () => {
  it('plain direct conversation with a read latest message → active', () => {
    const f = conversationFacets(makeInputs({ latestRead: true }));
    expect(f).toEqual({ kind: 'direct', isInvitation: false, isArchived: false, isUnread: false });
  });

  it('hub runtime (no is_unread on the row): an unread latest message → unread', () => {
    const f = conversationFacets(makeInputs({ latestRead: false }));
    expect(f.isUnread).toBe(true);
  });

  it("the backend's is_unread wins over the latest message", () => {
    const stamped = (isUnread: boolean) =>
      conversationFacets({
        ...makeInputs({ latestRead: !isUnread }),
        conv: { is_unread: !isUnread } as unknown as Conversation,
      });
    // The latest message says one thing, the stamped flag the other: the row renders the flag.
    expect(stamped(true).isUnread).toBe(false);
    expect(stamped(false).isUnread).toBe(true);
  });

  it('helpdesk kind → helpdesk facet set', () => {
    const f = conversationFacets(makeInputs({ kind: ConversationKind.HELPDESK, latestRead: false }));
    expect(f.kind).toBe('helpdesk');
  });

  it('archived_at after the latest pointer ts → archived', () => {
    const f = conversationFacets(
      makeInputs({
        archived_at: '2026-06-10T12:00:00Z',
        latestPtrTs: '2026-06-10T11:00:00Z',
        latestRead: true,
      }),
    );
    expect(f.isArchived).toBe(true);
  });

  it('a message newer than archived_at auto-revives the row (not archived)', () => {
    const f = conversationFacets(
      makeInputs({
        archived_at: '2026-06-10T11:00:00Z',
        latestPtrTs: '2026-06-10T12:00:00Z',
        latestRead: true,
      }),
    );
    expect(f.isArchived).toBe(false);
  });

  it('pending invitation, viewer IS the recipient → invitation (always unread)', () => {
    const f = conversationFacets(
      makeInputs({
        firstKind: FlowMessageKind.INVITATION,
        accepted: false,
        recipientEmail: 'me@x.test',
        viewerEmail: 'me@x.test',
      }),
    );
    expect(f.isInvitation).toBe(true);
    expect(f.isUnread).toBe(true);
  });

  it('viewer-relativity: same invitation conversation is NOT an invitation row for the sender', () => {
    const f = conversationFacets(
      makeInputs({
        firstKind: FlowMessageKind.INVITATION,
        accepted: false,
        recipientEmail: 'other@x.test',
        viewerEmail: 'me@x.test', // I sent it; I'm not the recipient
        latestRead: true,
      }),
    );
    expect(f.isInvitation).toBe(false);
  });

  it('accepted invitation is no longer an invitation row', () => {
    const f = conversationFacets(
      makeInputs({
        firstKind: FlowMessageKind.INVITATION,
        accepted: true,
        recipientEmail: 'me@x.test',
        viewerEmail: 'me@x.test',
        latestRead: true,
      }),
    );
    expect(f.isInvitation).toBe(false);
  });

  it('orthogonal axes co-occur: a row can be invitation + helpdesk + archived at once', () => {
    const f = conversationFacets(
      makeInputs({
        kind: ConversationKind.HELPDESK,
        archived_at: '2026-06-10T12:00:00Z',
        latestPtrTs: '2026-06-10T11:00:00Z',
        firstKind: FlowMessageKind.INVITATION,
        accepted: false,
        recipientEmail: 'me@x.test',
        viewerEmail: 'me@x.test',
      }),
    );
    expect(f.isInvitation).toBe(true);
    expect(f.kind).toBe('helpdesk');
    expect(f.isArchived).toBe(true);
  });
});

// ── Ticket state — waiting / picked / closed, from both sides ─────────────────

const REQUESTER = 'u-req';
const STAFF = 'u-staff';
const requesterMember = { user_id: REQUESTER, roles: ['owner'], name: 'Guest' };
const staffMember = { user_id: STAFF, roles: ['reader', 'runner'], name: 'Dana' };

function ticketInputs(over: {
  status?: ConversationStatus;
  members?: Array<Record<string, unknown>>;
  viewerId: string;
  staffView?: boolean;
  pickedUpBy?: string[];
}): CategoryInputs {
  const conv = {
    kind: ConversationKind.HELPDESK,
    status: over.status ?? ConversationStatus.OPEN,
    initiated_by: REQUESTER,
    members: over.members ?? [requesterMember],
    archived_at: null,
  } as unknown as Conversation;
  return {
    conv,
    viewer: { email: '', cloudUserId: over.viewerId, localUserId: null },
    staffView: over.staffView,
    pickedUpBy: over.pickedUpBy,
  };
}

const stateLabel = (inp: CategoryInputs) => {
  const f = conversationFacets(inp);
  return f.ticket ? ticketChip(f.ticket).label : null;
};

describe('ticketState', () => {
  it('waiting: only the requester is in it', () => {
    expect(ticketState({ status: 'open', initiatedBy: REQUESTER, members: [requesterMember] })).toBe('waiting');
  });
  it('picked: a member other than the requester', () => {
    expect(ticketState({ status: 'open', initiatedBy: REQUESTER, members: [requesterMember, staffMember] })).toBe(
      'picked',
    );
  });
  it('picked: the pool row names staff the roster lacks', () => {
    expect(ticketState({ status: 'open', initiatedBy: REQUESTER, members: [], pickedUpBy: [STAFF] })).toBe('picked');
  });
  it('closed wins over picked (D6: a reply to a closed ticket keeps it closed)', () => {
    expect(ticketState({ status: 'closed', initiatedBy: REQUESTER, members: [requesterMember, staffMember] })).toBe(
      'closed',
    );
  });
  it('the requester holding the owner role without initiated_by is not staff', () => {
    expect(ticketState({ status: 'open', initiatedBy: null, members: [requesterMember] })).toBe('waiting');
  });
});

describe('ticket chip labels', () => {
  it('requester: Waiting for pickup → Picked up → Closed', () => {
    expect(stateLabel(ticketInputs({ viewerId: REQUESTER }))).toBe('Waiting for pickup');
    expect(stateLabel(ticketInputs({ viewerId: REQUESTER, members: [requesterMember, staffMember] }))).toBe(
      'Picked up',
    );
    expect(stateLabel(ticketInputs({ viewerId: REQUESTER, status: ConversationStatus.CLOSED }))).toBe('Closed');
  });
  it('staff: Not picked up → Picked up by you / by <name> → Closed', () => {
    expect(stateLabel(ticketInputs({ viewerId: STAFF }))).toBe('Not picked up');
    expect(stateLabel(ticketInputs({ viewerId: STAFF, members: [requesterMember, staffMember] }))).toBe(
      'Picked up by you',
    );
    expect(stateLabel(ticketInputs({ viewerId: 'u-other', members: [requesterMember, staffMember] }))).toBe(
      'Picked up by Dana',
    );
    expect(
      stateLabel(
        ticketInputs({ viewerId: STAFF, members: [requesterMember, staffMember], status: ConversationStatus.CLOSED }),
      ),
    ).toBe('Closed');
  });
  it('staffView forces the desk side (a source-delivered row)', () => {
    expect(stateLabel(ticketInputs({ viewerId: REQUESTER, staffView: true }))).toBe('Not picked up');
  });
  it('chipsFor: Support + state for the requester; closed stays listed with its chip (D7)', () => {
    const f = conversationFacets(ticketInputs({ viewerId: REQUESTER, status: ConversationStatus.CLOSED }));
    expect(chipsFor(f).map((c) => c.key)).toEqual(['helpdesk', 'ticket-closed']);
    // A source-backed staff row drops the kind chip but keeps the state chip.
    const s = conversationFacets(ticketInputs({ viewerId: STAFF, staffView: true }));
    expect(chipsFor({ ...s, kind: 'direct' }).map((c) => c.key)).toEqual(['ticket-waiting']);
  });
  it('direct conversations have no ticket facet', () => {
    expect(conversationFacets(makeInputs({ latestRead: true })).ticket).toBeUndefined();
  });
});

describe('deskChipLabel', () => {
  it('names the desk', () => {
    expect(deskChipLabel('GTM Studio')).toBe('GTM Studio help desk');
    expect(deskChipLabel('Flowpad Support')).toBe('Flowpad help desk');
    expect(deskChipLabel('Flowpad help desk')).toBe('Flowpad help desk');
  });
});
