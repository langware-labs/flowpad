/**
 * The Org & teams cluster button: its existence gate and its door.
 *
 * The gate is the interesting half. `useHasOrgOrTeam` answers a membership
 * question out of a spend projection (`token_plan/me`) because that read is
 * today the only one covering team AND org together — so the button must appear
 * for either scope kind, for neither anything else, and must stay hidden while
 * membership is unavailable EVEN IF react-query still holds a plan from a
 * previous session (nothing clears that cache on sign-out).
 *
 * Written after the button reached `tests/react/rail-order-and-gates.test.tsx`
 * through CollapsedSidebar and crashed it with "No QueryClient set" — that file
 * now mocks the button out, so this is where its own behaviour lives.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewType } from '@src/types/ViewType';

const nav = vi.hoisted(() => ({ openTab: vi.fn() }));
const dock = vi.hoisted(() => ({ current: null as { viewType: ViewType } | null }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: dock.current }),
}));

/** The two leaves the gate is built from, driven per test. */
const membership = vi.hoisted(() => ({ available: true }));
vi.mock('@src/hooks/use-membership-availability', () => ({
  useMembershipAvailability: () => ({
    available: membership.available,
    reason: membership.available ? 'available' : 'unauthenticated',
  }),
}));

const plan = vi.hoisted(() => ({ scopes: [] as Array<{ kind: string }> | undefined }));
vi.mock('@src/components/token-plan/use-token-plan', () => ({
  useTokenPlan: () => ({ data: plan.scopes === undefined ? undefined : { scopes: plan.scopes } }),
}));

import { OrgTeamsButton } from '@src/components/collapsed-sidebar/OrgTeamsButton';

const button = () => screen.queryByTestId('org-teams-button');

beforeEach(() => {
  membership.available = true;
  plan.scopes = [];
  dock.current = null;
});

afterEach(() => {
  nav.openTab.mockClear();
  cleanup();
});

describe('Org & teams button — the existence gate', () => {
  it('stays hidden for a member of neither an org nor a team', () => {
    plan.scopes = [{ kind: 'user' }];
    render(<OrgTeamsButton />);
    expect(button()).toBeNull();
  });

  for (const kind of ['team', 'org']) {
    it(`appears on a ${kind} membership`, () => {
      plan.scopes = [{ kind: 'user' }, { kind }];
      render(<OrgTeamsButton />);
      expect(button()).toBeInTheDocument();
    });
  }

  it('stays hidden while membership is unavailable, even holding a stale plan', () => {
    // The `available &&` re-check in the hook, not redundant with `enabled`:
    // react-query serves cached data to a disabled observer, and signing out
    // clears no cache. Without the re-check this renders the button to a
    // signed-out client.
    membership.available = false;
    plan.scopes = [{ kind: 'org' }];
    render(<OrgTeamsButton />);
    expect(button()).toBeNull();
  });

  it('stays hidden before the plan has resolved', () => {
    plan.scopes = undefined;
    render(<OrgTeamsButton />);
    expect(button()).toBeNull();
  });
});

describe('Org & teams button — the door', () => {
  beforeEach(() => {
    plan.scopes = [{ kind: 'org' }];
  });

  it('opens the organization view', () => {
    render(<OrgTeamsButton />);
    fireEvent.click(button()!);
    expect(nav.openTab).toHaveBeenCalledWith(ViewType.ORGANIZATION);
  });

  it('renders pressed only while that view is the current dock', () => {
    // Asserted on classList tokens, not a substring: the ghost variant already
    // carries `hover:bg-accent`, which a `toContain` would match in both states.
    const { rerender } = render(<OrgTeamsButton />);
    expect(button()!.classList.contains('bg-accent')).toBe(false);

    dock.current = { viewType: ViewType.ORGANIZATION };
    rerender(<OrgTeamsButton />);
    expect(button()!.classList.contains('bg-accent')).toBe(true);
    expect(button()!.classList.contains('text-accent-foreground')).toBe(true);
  });
});
