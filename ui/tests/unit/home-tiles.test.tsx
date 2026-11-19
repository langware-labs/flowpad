import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ signedIn: true }));

vi.mock('@src/hooks/use-members', () => ({
  useMembers: () => ({
    members: [],
    ready: true,
    updating: false,
    stale: false,
    available: h.signedIn,
    reason: h.signedIn ? 'available' : 'unauthenticated',
    refresh: vi.fn(),
    removeMember: vi.fn(),
    setRole: vi.fn(),
  }),
}));
vi.mock('@src/components/conversation/useLocalUser', () => ({ useLocalUser: () => ({ localUser: { id: 'me' } }) }));
vi.mock('@src/components/asset-counters/issue-counters', async (original) => ({
  ...(await original<typeof import('@src/components/asset-counters/issue-counters')>()),
  useIssues: () => ({ issues: [], isLoading: false }),
}));

import type { Agent, Deployment } from '@sdk';
import { HomePropertiesPanel } from '@src/components/home-tiles/HomePropertiesPanel';
import { HomeTiles, type HomeTilesState } from '@src/components/home-tiles/HomeTiles';
import { resolveSelection, type HomeTile } from '@src/components/home-tiles/home-tiles-model';

const AGENT = '11111111-1111-4111-8111-111111111111';
const USED = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444444';
const S2 = '55555555-5555-4555-8555-555555555555';
const typeId = (value: string) => ({ toString: () => value });
const deployment = (id: string, name: string) =>
  ({ id, name, isLocal: false, typeId: typeId(`deployment-${id}`), status: { provider_state: 'running' } }) as unknown as Deployment;

const own: HomeTile = {
  key: `agent-${AGENT}`,
  kind: 'agent',
  label: 'Pirate',
  own: true,
  agent: { id: AGENT, name: 'pirate', displayName: 'Pirate', description: 'Answers like a pirate.', typeId: typeId(`agent-${AGENT}`) } as unknown as Agent,
  deployments: [deployment(D1, 'Team desk')],
  issueCount: 2,
  deploymentIssues: new Map(),
};
const used: HomeTile = {
  key: `agent-${USED}`,
  kind: 'agent',
  label: 'Support desk',
  own: false,
  deployments: [deployment(S1, 'Europe'), deployment(S2, 'US')],
  issueCount: 0,
  deploymentIssues: new Map(),
};

const sharedIdle: HomeTile = {
  key: `agent-${S1}`,
  kind: 'agent',
  label: 'Shared idle',
  own: false,
  agent: {
    id: S1,
    name: 'idle',
    displayName: 'Shared idle',
    description: 'Shared with you.',
    typeId: typeId(`agent-${S1}`),
  } as unknown as Agent,
  deployments: [],
  issueCount: 0,
  deploymentIssues: new Map(),
};

function state(tileKey: string | null, deploymentId: string | null = null): HomeTilesState {
  return {
    agents: [own, used],
    apps: [],
    selection: resolveSelection([own, used], tileKey, deploymentId),
    select: vi.fn(),
    open: vi.fn(),
    manage: vi.fn(),
    busyKey: null,
    ownIsLocal: true,
  };
}

/** The hub home: no Manage (Open already goes to the page), and what is yours is in the cloud. */
function hubState(tileKey: string | null): HomeTilesState {
  const agents = [own, sharedIdle];
  const selection = resolveSelection(agents, tileKey, null);
  return { ...state(null), agents, selection, manage: undefined, ownIsLocal: false };
}

afterEach(() => {
  cleanup();
  h.signedIn = true;
});

describe('home icons', () => {
  it('selects on a click, opens on a double click, and shows the counts', async () => {
    const user = userEvent.setup();
    const home = state(own.key);
    render(<HomeTiles home={home} />);
    const [mine, theirs] = screen.getAllByTestId('project-agent-tile');

    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(theirs).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByTestId('home-tile-deployments').map((el) => el.textContent)).toEqual(['1', '2']);
    expect(screen.getByTestId('home-tile-issues')).toHaveTextContent('2');

    await user.click(theirs);
    expect(home.select).toHaveBeenCalledWith(used.key);
    expect(home.open).not.toHaveBeenCalled();
    await user.dblClick(mine);
    expect(home.open).toHaveBeenCalledWith(own);
  });
});

describe('home icon pages', () => {
  it('shows 25 icons a page, and the arrows page back and forth', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 30 }, (_, i) => ({ ...used, key: `agent-many-${i}`, label: `Agent ${i}` }));
    render(<HomeTiles home={{ ...state(null), agents: many }} />);

    expect(screen.getAllByTestId('project-agent-tile')).toHaveLength(25);
    expect(screen.getByTestId('home-agents-pager')).toHaveTextContent('1–25 of 30');
    expect(screen.getByTestId('home-agents-prev')).toBeDisabled();
    await user.click(screen.getByTestId('home-agents-next'));
    expect(screen.getAllByTestId('project-agent-tile')).toHaveLength(5);
    expect(screen.getByTestId('home-agents-pager')).toHaveTextContent('26–30 of 30');
    expect(screen.getByTestId('home-agents-next')).toBeDisabled();
    await user.click(screen.getByTestId('home-agents-prev'));
    expect(screen.getAllByTestId('project-agent-tile')).toHaveLength(25);
  });

  it('shows no arrows when every icon fits on one page', () => {
    render(<HomeTiles home={state(null)} />);
    expect(screen.queryByTestId('home-agents-pager')).toBeNull();
  });
});

describe('home properties panel', () => {
  it('shows your agent with its deployments, Open and Manage, and the invite only after +', async () => {
    const user = userEvent.setup();
    const home = state(own.key);
    render(<HomePropertiesPanel home={home} />);

    expect(screen.getByTestId('home-properties')).toHaveAttribute('data-target', own.key);
    expect(screen.getAllByTestId('home-deployment-row')).toHaveLength(1);
    expect(screen.queryByTestId('home-access-invite-email')).toBeNull();
    await user.click(screen.getByTestId('home-access-invite-toggle'));
    expect(screen.getByTestId('home-access-invite-email')).toBeInTheDocument();

    await user.click(screen.getByTestId('home-properties-manage'));
    expect(home.manage).toHaveBeenCalledWith(own);
    await user.click(screen.getByTestId('home-deployment-row'));
    expect(home.select).toHaveBeenCalledWith(own.key, D1);
  });

  it('opens a listed deployment as a breadcrumbed sub view with no Manage', async () => {
    const user = userEvent.setup();
    const home = state(own.key, D1);
    render(<HomePropertiesPanel home={home} />);

    expect(screen.getByTestId('home-properties')).toHaveAttribute('data-target', `deployment-${D1}`);
    expect(screen.getByTestId('home-properties-title')).toHaveTextContent('Team desk');
    expect(screen.queryByTestId('home-properties-manage')).toBeNull();
    expect(screen.queryByTestId('home-deployment-row')).toBeNull();

    await user.click(screen.getByTestId('home-properties-open'));
    expect(home.open).toHaveBeenCalledWith(own, own.deployments[0]);
    await user.click(screen.getByTestId('home-properties-crumb-root'));
    expect(home.select).toHaveBeenCalledWith(own.key);
  });

  it('shows only the list for deployments of an agent that is not yours', () => {
    render(<HomePropertiesPanel home={state(used.key)} />);

    expect(screen.getAllByTestId('home-deployment-row')).toHaveLength(2);
    expect(screen.queryByTestId('home-properties-open')).toBeNull();
    expect(screen.queryByTestId('home-access')).toBeNull();
  });

  it('on the hub, shows your agent in the cloud with Open and no Manage', async () => {
    const user = userEvent.setup();
    const home = hubState(own.key);
    render(<HomePropertiesPanel home={home} />);

    expect(screen.getByTestId('home-properties')).toHaveAttribute('data-target', own.key);
    expect(screen.getByTestId('home-properties')).toHaveTextContent('Cloud');
    expect(screen.queryByTestId('home-properties-manage')).toBeNull();
    await user.click(screen.getByTestId('home-properties-open'));
    expect(home.open).toHaveBeenCalledWith(own, null);
  });

  it('on the hub, shows an agent shared with you that has no deployment as itself', () => {
    render(<HomePropertiesPanel home={hubState(sharedIdle.key)} />);

    expect(screen.getByTestId('home-properties')).toHaveAttribute('data-target', sharedIdle.key);
    expect(screen.getByText('Shared with you.')).toBeInTheDocument();
    expect(screen.getByTestId('home-properties-open')).toBeInTheDocument();
    expect(screen.queryByTestId('home-properties-manage')).toBeNull();
  });

  it('says why there is no roster when signed out, and offers no invite', () => {
    h.signedIn = false;
    render(<HomePropertiesPanel home={state(own.key)} />);

    expect(screen.getByTestId('home-access-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('home-access-invite-toggle')).toBeNull();
  });
});
