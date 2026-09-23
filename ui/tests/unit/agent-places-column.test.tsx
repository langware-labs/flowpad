/**
 * Deployments: one plain list — this computer first, then every cloud machine — under a single
 * "New deployment" button. A row says its state and when it was last active, and opens the
 * deployment's own page (WorldView, focused on it) by navigating.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentPlace } from '@sdk';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), hub: false }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav }),
}));
vi.mock('@sdk/utils/hub-runtime', () => ({ isHubOnly: () => nav.hub }));
vi.mock('@src/components/assets/editor/agent-profile/NewDeploymentDialog', () => ({
  NewDeploymentDialog: () => <div data-testid="mock-new-deployment" />,
}));

import { AgentPlacesColumn } from '@src/components/assets/editor/agent-profile/AgentPlacesColumn';

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const CLOUD_ID = '22222222-2222-4222-8222-222222222222';

function place(id: string, isLocal: boolean, extra: Partial<AgentPlace> = {}): AgentPlace {
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
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  nav.openDock.mockReset();
  nav.hub = false;
});

function renderColumn(places: AgentPlace[]) {
  vi.spyOn(Agent.prototype, 'listPlaces').mockResolvedValue(places);
  const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });
  render(<AgentPlacesColumn agent={agent} />);
}

describe('Deployments', () => {
  it('lists every deployment, this computer first, under one New deployment button', async () => {
    renderColumn([
      place(LOCAL_ID, true, { last_active: new Date(Date.now() - 5 * 60_000).toISOString() }),
      place(CLOUD_ID, false, { enabled: false }),
    ]);
    expect(await screen.findByTestId(`agent-place-row-${LOCAL_ID}`)).toHaveTextContent('Development · local');
    expect(screen.getByTestId(`agent-place-row-${CLOUD_ID}`)).toHaveTextContent('Cloud · brief-1');
    expect(screen.getByTestId(`agent-place-state-${LOCAL_ID}`)).toHaveTextContent('On');
    expect(screen.getByTestId(`agent-place-state-${CLOUD_ID}`)).toHaveTextContent('Off');
    expect(screen.getByTestId(`agent-place-last-active-${LOCAL_ID}`)).toHaveTextContent('5m ago');
    expect(screen.getByTestId(`agent-place-last-active-${CLOUD_ID}`)).toHaveTextContent('never');

    expect(screen.queryByTestId('mock-new-deployment')).toBeNull();
    expect(screen.getByTestId('agent-new-deployment')).toHaveTextContent('New deployment');
    fireEvent.click(screen.getByTestId('agent-new-deployment'));
    expect(screen.getByTestId('mock-new-deployment')).toBeInTheDocument();
  });

  it('a row opens the deployment’s own page — WorldView focused on it — and only navigates', async () => {
    renderColumn([place(LOCAL_ID, true), place(CLOUD_ID, false)]);
    fireEvent.click(await screen.findByTestId(`agent-place-row-${CLOUD_ID}`));
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const pointer = nav.openDock.mock.calls[0][0] as { options?: Record<string, string> };
    expect(pointer.options?.selected).toBe(`deployment-${CLOUD_ID}`);
    expect(pointer.options?.focus).toBe(`deployment-${CLOUD_ID}`);
  });

  it('on the hub there is no local deployment and no New deployment', async () => {
    nav.hub = true;
    renderColumn([place(LOCAL_ID, true), place(CLOUD_ID, false)]);
    expect(await screen.findByTestId(`agent-place-row-${CLOUD_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`agent-place-row-${LOCAL_ID}`)).toBeNull();
    expect(screen.queryByTestId('agent-new-deployment')).toBeNull();
  });

  it('an agent deployed nowhere says so — nothing is created by looking at it', async () => {
    renderColumn([]);
    expect(await screen.findByTestId('agent-places-empty')).toHaveTextContent('Not deployed yet');
    fireEvent.click(screen.getByTestId('agent-new-deployment'));
    expect(screen.getByTestId('mock-new-deployment')).toBeInTheDocument();
  });
});
