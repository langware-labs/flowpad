import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgNodeManagement } from '@src/components/organization/org-node-management';

/**
 * The Organization WorldView drawer's management section.
 *
 * Covers what the hub cannot: that the CONTROLS appear only for a caller who may
 * actually use them. The hub is the real gate (an out-of-ceiling change is a 403
 * either way), so these assert the UI does not offer an action it knows will be
 * refused — and, for group rows, that a class inside a school is renderable at all,
 * which the shared ``assignableRoles`` refuses because a group row has no user_id.
 */

const OWNER_ME = { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: 'owner', type: 'user' };
const A_MEMBER = { user_id: 'alice-id', email: 'alice@example.com', name: 'Alice', role: 'member', type: 'user' };
const A_TEAM = { user_id: null, id: 'team-1', name: 'Class 3B', role: 'member', type: 'team' };

vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({ localUser: { id: 'me-id', email: 'me@example.com' }, updateName: vi.fn() }),
}));

const membersMock = vi.fn();
vi.mock('@src/hooks/use-members', () => ({
  useMembers: (...args: unknown[]) => membersMock(...args),
}));

function mockRoster(members: unknown[], overrides: Record<string, unknown> = {}) {
  membersMock.mockReturnValue({
    members,
    ready: true,
    updating: false,
    stale: false,
    available: true,
    reason: 'available',
    refresh: vi.fn(),
    removeMember: vi.fn(),
    setRole: vi.fn(),
    ...overrides,
  });
}

describe('OrgNodeManagement', () => {
  // This project does not auto-cleanup between tests, so without this each render
  // stacks in the same container and the queries below match the PREVIOUS test's DOM.
  afterEach(() => cleanup());

  it('offers role and remove controls to an admin-or-above caller', () => {
    mockRoster([OWNER_ME, A_MEMBER]);
    render(<OrgNodeManagement nodeType="organization" nodeId="org-1" nodeLabel="Springfield High" />);

    // One control per manageable row — never for yourself (the hub bans self-change).
    expect(screen.getAllByTestId('member-role-select')).toHaveLength(1);
    expect(screen.getAllByTestId('member-remove')).toHaveLength(1);
    expect(screen.getByTestId('org-create-team')).toBeTruthy();
  });

  it('offers no controls to a caller below admin', () => {
    // Same roster, but "me" is only a member — assignableRoles returns nothing, so
    // the row must fall back to a static role label.
    mockRoster([{ ...OWNER_ME, role: 'member' }, A_MEMBER]);
    render(<OrgNodeManagement nodeType="organization" nodeId="org-1" nodeLabel="Springfield High" />);

    expect(screen.queryByTestId('member-role-select')).toBeNull();
    expect(screen.queryByTestId('member-remove')).toBeNull();
    expect(screen.queryByTestId('org-create-team')).toBeNull();
  });

  it('renders a team that is a member of the org as a manageable row', () => {
    // The regression this guards: the shared ``assignableRoles`` bails when a row
    // has no ``user_id``, which every group row has by nature — so a class inside a
    // school would render read-only while people beside it were editable.
    mockRoster([OWNER_ME, A_TEAM]);
    render(<OrgNodeManagement nodeType="organization" nodeId="org-1" nodeLabel="Springfield High" />);

    expect(screen.getByText('Class 3B')).toBeTruthy();
    expect(screen.getAllByTestId('member-role-select')).toHaveLength(1);
  });

  it('says so in Local mode instead of showing an empty roster', () => {
    mockRoster([], { available: false, reason: 'local' });
    render(<OrgNodeManagement nodeType="team" nodeId="team-1" nodeLabel="Class 3B" />);

    expect(screen.getByTestId('org-management-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('org-create-team')).toBeNull();
  });

  it('offers a sub-team on a class and a class on a school', () => {
    mockRoster([OWNER_ME]);
    const { unmount } = render(<OrgNodeManagement nodeType="organization" nodeId="org-1" nodeLabel="School" />);
    expect(screen.getByTestId('org-create-team').textContent).toContain('New class');
    unmount();

    mockRoster([OWNER_ME]);
    render(<OrgNodeManagement nodeType="team" nodeId="team-1" nodeLabel="Class 3B" />);
    expect(screen.getByTestId('org-create-team').textContent).toContain('New sub-team');
  });
});
