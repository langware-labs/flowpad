/**
 * "Runs on": one environment at a time from a select — Development · local by
 * default — with Deploy beside it. The selection lives in the URL.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentPlace } from '@sdk';

import { fakeDock as dock } from './fake-dock';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), current: null as unknown, hub: false }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: nav.current }),
}));
vi.mock('@sdk/utils/hub-runtime', () => ({ isHubOnly: () => nav.hub }));
vi.mock('@src/components/assets/editor/agent-profile/AgentPlaceCard', () => ({
  AgentPlaceCard: (props: { place: AgentPlace }) => (
    <div data-testid="mock-card" data-deployment={props.place.deployment.id} />
  ),
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentAddCloudMachine', () => ({
  AgentAddCloudMachine: () => <div data-testid="mock-deploy-panel" />,
}));

import { AgentPlacesColumn, PLACE_OPTION } from '@src/components/assets/editor/agent-profile/AgentPlacesColumn';

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const CLOUD_ID = '22222222-2222-4222-8222-222222222222';

function place(id: string, isLocal: boolean): AgentPlace {
  return {
    deployment: {
      id,
      name: isLocal ? 'brief (local)' : 'brief-1',
      kind: 'runtime.agent',
      target: { provider: isLocal ? 'local' : 'e2b', scope: 'machine', location: null },
      status: { sync_state: 'current', provider_state: 'running' },
    },
    is_local: isLocal,
    overrides: {},
    schedule_count: 0,
    answers_email: isLocal,
    behind: null,
    enabled: true,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  nav.hub = false;
});

function renderColumn(options: Record<string, string> = {}) {
  nav.current = dock(options);
  vi.spyOn(Agent.prototype, 'listPlaces').mockResolvedValue([place(LOCAL_ID, true), place(CLOUD_ID, false)]);
  const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });
  render(<AgentPlacesColumn agent={agent} />);
}

describe('Runs on', () => {
  it('shows Development · local by default, with Deploy beside the select', async () => {
    renderColumn();
    expect(await screen.findByTestId('mock-card')).toHaveAttribute('data-deployment', LOCAL_ID);
    expect(screen.getByTestId('agent-place-select')).toHaveTextContent('Development · local');
    expect(screen.getAllByTestId('mock-card')).toHaveLength(1);
    expect(screen.queryByTestId('mock-deploy-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-add-cloud-machine'));
    expect(screen.getByTestId('mock-deploy-panel')).toBeInTheDocument();
  });

  it('shows the environment the URL names', async () => {
    renderColumn({ [PLACE_OPTION]: CLOUD_ID });
    expect(await screen.findByTestId('mock-card')).toHaveAttribute('data-deployment', CLOUD_ID);
    expect(screen.getByTestId('agent-place-select')).toHaveTextContent('Cloud · brief-1');
  });

  it('on the hub there is no local environment and no Deploy', async () => {
    nav.hub = true;
    renderColumn();
    expect(await screen.findByTestId('mock-card')).toHaveAttribute('data-deployment', CLOUD_ID);
    expect(screen.queryByTestId('agent-add-cloud-machine')).toBeNull();
  });
});
