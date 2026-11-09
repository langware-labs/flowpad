/**
 * An agent's Deployments: every deployment it is the main agent of — this computer first — each a link to its
 * page in the PROJECT's Deployments. "Deploy" opens that page with the agent preset; clicks only navigate.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Deployment } from '@sdk';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), rows: [] as unknown[] }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: nav.rows, refetch: async () => undefined }),
}));
vi.mock('@src/components/agent-resources/AgentWebhooksSection', () => ({
  providerIcon: () => () => null,
  useAgentChannels: () => null,
}));

import { AgentPlacesColumn } from '@src/components/assets/editor/agent-profile/AgentPlacesColumn';

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const CLOUD_ID = '22222222-2222-4222-8222-222222222222';

const deployment = (id: string, local: boolean, state = 'running') =>
  new Deployment({
    id,
    name: local ? 'brief (local)' : 'brief-1',
    parent_type_id: `project-${PROJECT_ID}`,
    main_agent_id: `agent-${AGENT_ID}`,
    target: { provider: local ? 'local' : 'e2b', scope: 'machine' },
    status: { sync_state: 'current', provider_state: state },
  } as never);

function renderColumn(rows: Deployment[]) {
  nav.rows = rows;
  render(<AgentPlacesColumn agent={new Agent({ id: AGENT_ID, name: 'brief', project_id: PROJECT_ID } as never)} />);
}

afterEach(() => {
  cleanup();
  nav.openDock.mockReset();
});

describe('Deployments of an agent', () => {
  it('lists where it is main, this computer first, with each state', () => {
    renderColumn([deployment(CLOUD_ID, false, 'paused'), deployment(LOCAL_ID, true)]);
    const rows = screen.getAllByTestId(/^agent-place-row-/);
    expect(rows[0]).toHaveTextContent('This computer · not in the cloud');
    expect(rows[1]).toHaveTextContent('Cloud · brief-1');
    expect(screen.getByTestId(`agent-place-state-${LOCAL_ID}`)).toHaveTextContent('On');
    expect(screen.getByTestId(`agent-place-state-${CLOUD_ID}`)).toHaveTextContent('Paused');
  });

  it('a planned cloud deployment (refused, no machine) is "Not started", never "Running"', () => {
    renderColumn([deployment(CLOUD_ID, false, 'planned')]);
    expect(screen.getByTestId(`agent-place-state-${CLOUD_ID}`)).toHaveTextContent('Not started');
  });

  it('a row opens the deployment on its project — and only navigates', () => {
    renderColumn([deployment(CLOUD_ID, false)]);
    fireEvent.click(screen.getByTestId(`agent-place-row-${CLOUD_ID}`));
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    expect(nav.openDock.mock.calls[0][0]).toMatchObject({
      viewType: 'project',
      pointer: `${PROJECT_ID}/project-deployments`,
      options: { deployment: CLOUD_ID },
    });
  });

  it('with no deployment says it runs nowhere yet (Deploy lives on the editor header)', () => {
    renderColumn([]);
    expect(screen.getByTestId('agent-places-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-new-deployment')).toBeNull();
  });
});
