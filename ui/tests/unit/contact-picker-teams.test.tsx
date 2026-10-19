/**
 * Messaging a whole team from the StreamInbox's new-conversation picker.
 *
 * Locked here:
 *  - Typing a team's name offers the team, as the project invite does — but only
 *    a team whose roster the user may read. A refused roster reaches the desk as
 *    an empty list, so a team with nobody besides the user is not offered at all.
 *  - Picking it adds every person on the team's roster as their own chip —
 *    the conversation is sent to each of them; the team itself is never a chip.
 *  - Members merge with people added one by one (no duplicates, self excluded).
 *  - Nested group rows and address-less rows on the roster are not added.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ConversationParticipant } from '@sdk';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { teamMemberParticipants } from '@src/components/contact-picker/use-team-suggestions';

const TEAM_ID = '550e8400-e29b-41d4-a716-446655440001';
const ROSTER = [
  { user_id: 'hub-me', email: 'me@example.com', name: 'Me', role: 'member' },
  { user_id: 'hub-alice', email: 'alice@example.com', name: 'Alice', role: 'member' },
  { user_id: 'hub-bob', email: 'Bob@Example.com', name: 'Bob', role: 'admin' },
  { user_id: 'team-sub', type: 'team', name: 'Sub team', role: 'member' },
  { name: 'Nobody' },
];

const sdk = vi.hoisted(() => ({ getMembers: vi.fn() }));
vi.mock('@sdk', async (importOriginal) => ({ ...(await importOriginal<object>()), getMembers: sdk.getMembers }));
vi.mock('@src/components/contact-picker/use-contacts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useContacts: () => ({ contacts: [], refetch: () => undefined }),
}));
vi.mock('@src/components/contact-picker/use-contacts-groups', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useContactsGroups: () => ({ groups: [] }),
}));
// The hub teams the desk knows the user is in.
const TEAM_ROWS = [{ id: TEAM_ID, name: 'initech', remote: true }];
vi.mock('@src/hooks/entity-hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntitiesQuery: (_req: unknown, opts: { enabled?: boolean }) => ({ data: opts.enabled ? TEAM_ROWS : [] }),
}));

function Harness({ initial, includeTeams = true }: { initial: ConversationParticipant[]; includeTeams?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ContactPicker value={value} onChange={setValue} excludeUserId="hub-me" includeTeams={includeTeams} />
      <output data-testid="picked">{value.map((p) => p.email).join(',')}</output>
    </>
  );
}

afterEach(() => {
  cleanup();
  sdk.getMembers.mockReset();
});

describe('ContactPicker — teams', () => {
  it('adds every team member next to a person added individually', async () => {
    sdk.getMembers.mockResolvedValue(ROSTER);
    render(<Harness initial={[{ email: 'carol@example.com', name: 'Carol' }]} />);

    fireEvent.change(screen.getByTestId('contact-input'), { target: { value: 'ini' } });
    fireEvent.click(await screen.findByTestId(`contact-team-option-${TEAM_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId('picked').textContent).toBe('carol@example.com,alice@example.com,bob@example.com'),
    );
    expect(String(sdk.getMembers.mock.calls[0][0])).toBe(`team-${TEAM_ID}`);
  });

  it('does not duplicate a member already picked by hand', async () => {
    sdk.getMembers.mockResolvedValue(ROSTER);
    render(<Harness initial={[{ user_id: 'hub-alice', email: 'alice@example.com', name: 'Alice' }]} />);

    fireEvent.change(screen.getByTestId('contact-input'), { target: { value: 'ini' } });
    fireEvent.click(await screen.findByTestId(`contact-team-option-${TEAM_ID}`));

    await waitFor(() => expect(screen.getByTestId('picked').textContent).toBe('alice@example.com,bob@example.com'));
  });

  it('does not offer a team whose roster the hub refused (empty)', async () => {
    sdk.getMembers.mockResolvedValue([]);
    render(<Harness initial={[]} />);
    fireEvent.change(screen.getByTestId('contact-input'), { target: { value: 'ini' } });
    await waitFor(() => expect(sdk.getMembers).toHaveBeenCalled());
    expect(screen.queryByTestId(`contact-team-option-${TEAM_ID}`)).toBeNull();
  });

  it('does not offer a team whose roster is only the user', async () => {
    sdk.getMembers.mockResolvedValue([ROSTER[0]]);
    render(<Harness initial={[]} />);
    fireEvent.change(screen.getByTestId('contact-input'), { target: { value: 'ini' } });
    await waitFor(() => expect(sdk.getMembers).toHaveBeenCalled());
    expect(screen.queryByTestId(`contact-team-option-${TEAM_ID}`)).toBeNull();
  });

  it('does not offer a team whose roster read failed', async () => {
    sdk.getMembers.mockRejectedValue(new Error('403'));
    render(<Harness initial={[]} />);
    fireEvent.change(screen.getByTestId('contact-input'), { target: { value: 'ini' } });
    await waitFor(() => expect(sdk.getMembers).toHaveBeenCalled());
    expect(screen.queryByTestId(`contact-team-option-${TEAM_ID}`)).toBeNull();
  });

  it('offers no teams unless the surface asks for them', () => {
    render(<Harness initial={[]} includeTeams={false} />);
    fireEvent.change(screen.getByTestId('contact-input'), { target: { value: 'ini' } });
    expect(screen.queryByTestId(`contact-team-option-${TEAM_ID}`)).toBeNull();
  });
});

describe('teamMemberParticipants', () => {
  it('keeps people with an address, drops nested groups and keyless rows', () => {
    expect(teamMemberParticipants(ROSTER)).toEqual([
      { user_id: 'hub-me', email: 'me@example.com', name: 'Me' },
      { user_id: 'hub-alice', email: 'alice@example.com', name: 'Alice' },
      { user_id: 'hub-bob', email: 'bob@example.com', name: 'Bob' },
    ]);
  });
});
