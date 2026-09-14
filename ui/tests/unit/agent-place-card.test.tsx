/**
 * One place card: its tab and open chat live in the URL; a click only navigates.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Deployment, type AgentPlace } from '@sdk';

type FakeDock = { options: Record<string, string>; withOption: (k: string, v: string | null) => FakeDock };
function dock(options: Record<string, string> = {}): FakeDock {
  return {
    options,
    withOption: (k, v) => {
      const next = { ...options };
      if (v) next[k] = v;
      else delete next[k];
      return dock(next);
    },
  };
}

const nav = vi.hoisted(() => ({ openDock: vi.fn(), current: null as unknown }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: nav.current }),
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentPlaceActivity', () => ({
  AgentPlaceActivity: () => <div data-testid="mock-activity" />,
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentScheduleSection', () => ({
  AgentScheduleSection: (props: { deploymentId?: string; isLocal?: boolean }) => (
    <div data-testid="mock-schedules" data-deployment={props.deploymentId} data-local={String(props.isLocal)} />
  ),
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentPlaceConfig', () => ({
  AgentPlaceConfig: () => <div data-testid="mock-config" />,
}));
vi.mock('@src/components/assets/editor/agent-profile/AgentPlaceEmail', () => ({
  AgentPlaceEmail: () => <div data-testid="mock-email" />,
}));
vi.mock('@src/components/assets/editor/agent-profile/DeployedAgentChatPanel', () => ({
  DeployedAgentChatPanel: () => <div data-testid="mock-chat" />,
}));
vi.mock('@src/notifications', () => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { AgentPlaceCard, placeTabOption } from '@src/components/assets/editor/agent-profile/AgentPlaceCard';

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
  vi.clearAllMocks();
});

function renderCard(p: AgentPlace, options: Record<string, string> = {}, pending = 0) {
  nav.current = dock(options);
  const agent = new Agent({ id: '33333333-3333-4333-8333-333333333333', name: 'brief', enabled: true });
  render(<AgentPlaceCard agent={agent} place={p} places={[p]} pendingChanges={pending} onChanged={vi.fn()} />);
}

describe('a place card', () => {
  it('names this computer, shows its version and opens on Activity', () => {
    renderCard(place(LOCAL_ID, true), {}, 2);
    expect(screen.getByTestId('agent-place-name')).toHaveTextContent('This computer');
    expect(screen.getByTestId('agent-place-version')).toHaveTextContent('2 not published');
    expect(screen.getByTestId('mock-activity')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-place-menu')).toBeNull();
  });

  it('shows the tab named in the URL and scopes schedules to this place', () => {
    renderCard(place(LOCAL_ID, true), { [placeTabOption(LOCAL_ID)]: 'schedules' });
    const schedules = screen.getByTestId('mock-schedules');
    expect(schedules).toHaveAttribute('data-deployment', LOCAL_ID);
    expect(schedules).toHaveAttribute('data-local', 'true');
  });

  it('switching tab only navigates', () => {
    renderCard(place(CLOUD_ID, false, { overrides: { model: 'sonnet' } }));
    fireEvent.mouseDown(screen.getByTestId('agent-place-tab-config'), { button: 0 });
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const pointer = nav.openDock.mock.calls[0][0] as FakeDock;
    expect(pointer.options[placeTabOption(CLOUD_ID)]).toBe('config');
  });

  it('a cloud machine has a menu and Chat opens its chat through the URL', () => {
    renderCard(place(CLOUD_ID, false));
    expect(screen.getByTestId('agent-place-name')).toHaveTextContent('Cloud · brief-1');
    expect(screen.getByTestId('agent-place-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-place-chat'));
    const pointer = nav.openDock.mock.calls[0][0] as FakeDock;
    expect(pointer.options.chat).toBe(CLOUD_ID);
  });

  it('renders the chat when the URL says it is open', () => {
    renderCard(place(CLOUD_ID, false), { chat: CLOUD_ID });
    expect(screen.getByTestId('mock-chat')).toBeInTheDocument();
  });

  it('each place has its own enabled switch, which writes that place only', async () => {
    const set = vi.spyOn(Agent.prototype, 'setPlaceEnabled').mockResolvedValue();
    renderCard(place(CLOUD_ID, false, { enabled: false, overrides: { model: 'sonnet' } }));
    const toggle = screen.getByTestId('agent-place-enabled');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    // The switch is not a Config override row.
    expect(screen.getByTestId('agent-place-tab-config')).toHaveTextContent('1');
    fireEvent.click(toggle);
    await waitFor(() => expect(set).toHaveBeenCalledWith(CLOUD_ID, true));
    set.mockRestore();
  });

  it('a cloud machine behind the published version offers Update', async () => {
    const update = vi.spyOn(Deployment.prototype, 'update').mockResolvedValue({});
    renderCard(place(CLOUD_ID, false, { behind: 3 }));
    const button = screen.getByTestId('agent-place-update');
    expect(button).toHaveTextContent('Behind by 3 · Update');
    fireEvent.click(button);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    update.mockRestore();
  });

  it('a cloud machine on the published version is up to date, and unknown says nothing', () => {
    renderCard(place(CLOUD_ID, false, { behind: 0 }));
    expect(screen.getByTestId('agent-place-version')).toHaveTextContent('Up to date');
    cleanup();
    renderCard(place(CLOUD_ID, false));
    expect(screen.queryByTestId('agent-place-version')).toBeNull();
    expect(screen.queryByTestId('agent-place-update')).toBeNull();
  });
});
