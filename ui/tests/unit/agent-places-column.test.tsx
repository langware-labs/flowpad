/**
 * Deployments: one plain list — this computer first, then every cloud machine — under a single
 * "New deployment" button. A row says its state and when it was last active, and opens the
 * deployment's own page nested in the agent by navigating.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentPlace } from '@sdk';
import type { ActivityProgressSpec, ActivityState } from '@sdk/activity';
import { notify } from '@src/notifications';
import { __resetActivityStoreForTest, handleActivitySnapshot } from '@src/store/activity-store';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), hub: false }));
const { AGENT_URL } = vi.hoisted(() => ({ AGENT_URL: '/dock/assets/editor/agent/typeid/agent-33333333-3333-4333-8333-333333333333' }));
vi.mock('@src/navigation/useDockNavigation', async () => {
  const { DockPointer } = await import('@src/navigation/DockPointer');
  const currentDock = DockPointer.fromUrl(AGENT_URL);
  return { useDockNavigation: () => ({ navigation: nav, currentDock }) };
});
vi.mock('@sdk/utils/hub-runtime', () => ({ isHubOnly: () => nav.hub }));
vi.mock('@src/components/assets/editor/agent-profile/NewDeploymentDialog', () => ({
  NewDeploymentDialog: () => <div data-testid="mock-new-deployment" />,
}));
vi.mock('@src/notifications', () => ({ notify: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
// Watching registers this connection with the backend; there is none here.
const { useWatch } = vi.hoisted(() => ({ useWatch: vi.fn() }));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({ ...(await importOriginal<object>()), useWatch }));

import { AgentPlacesColumn } from '@src/components/assets/editor/agent-profile/AgentPlacesColumn';

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const CLOUD_ID = '22222222-2222-4222-8222-222222222222';

function place(id: string, isLocal: boolean, extra: Partial<AgentPlace> = {}): AgentPlace {
  return {
    deployment: {
      id,
      name: isLocal ? 'brief (local)' : 'brief-1',
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
  vi.mocked(notify.warning).mockClear();
  __resetActivityStoreForTest();
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

  it('a row opens the deployment’s own page nested in the agent — and only navigates', async () => {
    renderColumn([place(LOCAL_ID, true), place(CLOUD_ID, false)]);
    fireEvent.click(await screen.findByTestId(`agent-place-row-${CLOUD_ID}`));
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const pointer = nav.openDock.mock.calls[0][0] as { child: unknown; toUrl(): string };
    expect(pointer.child).toEqual({ section: 'deployment', typeId: `deployment-${CLOUD_ID}` });
    expect(pointer.toUrl()).toContain(`${AGENT_URL}/child/deployment/deployment-${CLOUD_ID}`);
  });

  it('on the hub there is no places call: nothing is listed and no New deployment', async () => {
    nav.hub = true;
    renderColumn([place(LOCAL_ID, true), place(CLOUD_ID, false)]);
    expect(await screen.findByTestId('agent-places-empty')).toBeInTheDocument();
    expect(Agent.prototype.listPlaces).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`agent-place-row-${CLOUD_ID}`)).toBeNull();
    expect(screen.queryByTestId(`agent-place-row-${LOCAL_ID}`)).toBeNull();
    expect(screen.queryByTestId('agent-new-deployment')).toBeNull();
  });

  it('watches the agent while open, so a deploy’s steps arrive after its dialog has closed', async () => {
    renderColumn([]);
    await screen.findByTestId('agent-places-empty');
    expect(useWatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent', id: '33333333-3333-4333-8333-333333333333' }),
      true,
    );
  });

  it('says once, however often the column mounts, what a deploy goes ahead without — and not for a finished one', async () => {
    const AGENT = 'agent-33333333-3333-4333-8333-333333333333';
    const node = (id: string, name: string, state: ActivityState, message: string | null, children: ActivityProgressSpec[] = []) =>
      ({
        activity_id: id, subject_entity: AGENT, path: name === 'deploy' ? name : `deploy/${name}`, name, label: name, state,
        message, done: 0, skipped: 0, errors_count: 0, errors: [], counters: {}, children, seq: 1,
      }) as ActivityProgressSpec;
    const deploy = (id: string, state: ActivityState) =>
      node(id, 'deploy', state, null, [node(id, 'readiness', 'completed', 'No LLM funding for brief: limit exceeded')]);

    act(() => handleActivitySnapshot(deploy('running-deploy', 'running')));
    for (let mounts = 0; mounts < 3; mounts++) {
      renderColumn([]);
      await screen.findByTestId('agent-places-empty');
      cleanup();
    }
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith(expect.objectContaining({ message: 'No LLM funding for brief: limit exceeded' }));

    act(() => handleActivitySnapshot(deploy('finished-deploy', 'completed')));
    renderColumn([]);
    await screen.findByTestId('agent-places-empty');
    expect(notify.warning).toHaveBeenCalledTimes(1);
  });

  it('an agent deployed nowhere says so — nothing is created by looking at it', async () => {
    renderColumn([]);
    expect(await screen.findByTestId('agent-places-empty')).toHaveTextContent('Not deployed yet');
    fireEvent.click(screen.getByTestId('agent-new-deployment'));
    expect(screen.getByTestId('mock-new-deployment')).toBeInTheDocument();
  });
});
