/**
 * A share as the person it was shared with sees it (`InviteCard`): the state it is in decides the
 * actions, and Open always lands on the shared thing's own page — never on Start, never a dead click.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ openDock: vi.fn(), answer: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock } }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  answerInvitation: h.answer,
}));

import { PageId, ViewType, invitationState, type InvitationState } from '@sdk';
import { InviteCard, type InviteView } from '@src/components/conversation/InviteCard';
import { buildDockPointer } from '@src/navigation/entity-pointer';
import { DockPointer, NODE_PARAM } from '@src/navigation/DockPointer';

const MACHINE = 'e731bec3-f849-42a7-96a5-38cb3252fdfa';
const view = (state: InvitationState, over: Partial<InviteView> = {}): InviteView => ({
  invitationId: '79caa9c9-82c3-42e4-99f2-31e1f5588cc2',
  state,
  targetType: 'compute_node',
  targetId: MACHINE,
  targetName: 'qa-cycle-manager (agent)',
  senderName: 'Ishay Sela',
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InviteCard', () => {
  it('pending: Accept and Decline answer the invitation', () => {
    render(<InviteCard invite={view('pending')} layout="card" />);
    fireEvent.click(screen.getByTestId('invite-accept'));
    expect(h.answer).toHaveBeenCalledWith('79caa9c9-82c3-42e4-99f2-31e1f5588cc2', 'accept');
    expect(screen.getByTestId('invite-decline')).toBeTruthy();
    expect(screen.queryByTestId('invite-open')).toBeNull();
  });

  it("the sharer's own copy reads the answer and offers no Accept", () => {
    render(<InviteCard invite={view('pending')} layout="card" mine />);
    expect(screen.queryByTestId('invite-accept')).toBeNull();
    expect(screen.getByTestId('invite-state').textContent).toMatch(/Waiting for an answer/);
  });

  it('accepted: Open lands on the machine page', () => {
    render(<InviteCard invite={view('accepted', { resolvedAt: new Date().toISOString() })} layout="line" />);
    expect(screen.getByTestId('invite-state').textContent).toMatch(/^Accepted · /);
    fireEvent.click(screen.getByTestId('invite-open'));
    const opened: DockPointer = h.openDock.mock.calls[0][0];
    expect(opened.viewType).toBe(ViewType.MACHINE);
    expect(opened.options?.[NODE_PARAM]).toBe(MACHINE);
  });

  it('declined: the line stays, with nothing to do', () => {
    render(<InviteCard invite={view('declined')} layout="line" />);
    expect(screen.getByTestId('invite-line').getAttribute('data-invite-state')).toBe('declined');
    expect(screen.queryByTestId('invite-open')).toBeNull();
    expect(screen.queryByTestId('invite-accept')).toBeNull();
  });

  it('revoked: Open is disabled and says why', () => {
    render(<InviteCard invite={view('revoked')} layout="card" />);
    const open = screen.getByTestId('invite-open');
    expect(open.disabled).toBe(true);
    expect(open.title).toBe('Ishay Sela stopped sharing this compute node');
  });
});

describe('where a shared thing opens', () => {
  it.each([
    ['compute_node', ViewType.MACHINE, undefined],
    ['team', ViewType.ORGANIZATION, PageId.HUB],
    ['organization', ViewType.ORGANIZATION, PageId.HUB],
    ['llm_endpoint', ViewType.LLM_ENDPOINTS, PageId.HUB],
    ['project', ViewType.PROJECT, undefined],
  ])('%s', (type, viewType, page) => {
    const p = buildDockPointer({ type, id: MACHINE }, undefined);
    expect(p?.viewType).toBe(viewType);
    if (page) expect(p?.page).toBe(page);
  });

  it('a team opens on its own page, an org on its members', () => {
    expect(buildDockPointer({ type: 'team', id: MACHINE }, undefined)?.pointer).toBe(`team/${MACHINE}`);
    expect(buildDockPointer({ type: 'organization', id: MACHINE }, undefined)?.options).toEqual({
      org: MACHINE,
      tab: 'members',
    });
  });
});

describe('the Stream Inbox filters are the URL', () => {
  it('Invites is a view, and the picked channels round-trip', () => {
    const base = DockPointer.forStreamInbox();
    const invites = base.withStreamInboxFilters({ view: 'invites' });
    expect(invites.streamInboxView).toBe('invites');
    const picked = base.withStreamInboxChannels(['slack', 'gmail']);
    expect(picked.streamInboxChannels).toEqual(['gmail', 'slack']);
    expect(base.streamInboxChannels).toBeNull();
    expect(base.withStreamInboxChannels([], true).streamInboxChannels).toEqual([]);
    expect(base.withStreamInboxChannels([]).streamInboxChannels).toBeNull();
  });

  it('a row written before status existed still reads its state', () => {
    expect(invitationState({})).toBe('pending');
    expect(invitationState({ accepted: true })).toBe('accepted');
    expect(invitationState({ accepted: true, status: 'revoked' })).toBe('revoked');
  });
});
