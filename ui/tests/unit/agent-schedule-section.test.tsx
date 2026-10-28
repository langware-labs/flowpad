/**
 * The agent's Schedule tab: its schedules are child trigger assets, found by
 * containment, plus every other schedule the overview says runs the agent (the
 * hub's among them); a click only navigates; writes go through the agent's
 * verbs, or — for a hub row — the Trigger SDK with hubReflect.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, Trigger, type AgentPlace, type AutomationSummary } from '@sdk';

const nav = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));

const rows = vi.hoisted(() => ({ triggers: [] as Record<string, unknown>[], refetch: vi.fn(), request: null as unknown }));
vi.mock('@sdk/react/hooks', async (original) => ({
  ...(await original<object>()),
  useEntitiesQuery: (request: unknown) => {
    rows.request = request;
    return { data: rows.triggers, isLoading: false, error: null, refetch: rows.refetch };
  },
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@src/components/assets/delete-asset-modal', () => ({ showDeleteAssetModal: vi.fn() }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: { id: 'p1' } }) }));
const gate = vi.hoisted(() => ({ fn: vi.fn(() => Promise.resolve({ ok: true as const })) }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => gate.fn }));
const placesState = vi.hoisted(() => ({ places: [] as unknown[] }));
vi.mock('@src/components/assets/editor/agent-profile/use-agent-places', () => ({
  useAgentPlaces: () => ({ places: placesState.places, reload: vi.fn() }),
}));
const overview = vi.hoisted(() => ({ rows: [] as unknown[], spy: null as unknown }));

import { AgentScheduleSection } from '@src/components/assets/editor/agent-profile/AgentScheduleSection';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_KEY = `agent-${AGENT_ID}`;
/** This computer's place; schedules with no `runs_on` (the legacy shape) show on it. */
const LOCAL_PLACE = '66666666-6666-4666-8666-666666666666';

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    name: 'Morning triage',
    trigger_type: 'schedule',
    parent_type_id: AGENT_KEY,
    scope: 'project',
    project_id: 'p1',
    enabled: true,
    counter: 2,
    expr: '0 9 * * *',
    sched_trigger_type: 'cron',
    timezone: 'Asia/Jerusalem',
    actions: [{ action_type: 'run_agent', prompt: 'Triage yesterday' }],
    ...overrides,
  };
}

beforeEach(() => {
  overview.spy = vi.spyOn(Trigger, 'overviewWithWarnings').mockImplementation(() =>
    Promise.resolve({ rows: overview.rows as AutomationSummary[], warnings: [] }),
  );
});

afterEach(() => {
  cleanup();
  rows.triggers = [];
  overview.rows = [];
  placesState.places = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Every render gets a fresh query cache: the overview is read through react-query. */
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const CLOUD_MACHINE = '55555555-5555-4555-8555-555555555555';

function place(id: string, name: string, isLocal: boolean): AgentPlace {
  return {
    deployment: { id, name, kind: isLocal ? 'local' : 'e2b' },
    is_local: isLocal,
    overrides: {},
    schedule_count: 0,
    answers_email: false,
    behind: null,
    enabled: true,
  } as unknown as AgentPlace;
}

/** A hub trigger running this agent, as the overview reads it. */
function hubRow(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id: 'h1',
    name: 'Cloud digest',
    description: '',
    kind: 'schedule',
    group: 'project',
    project_id: 'p1',
    enabled: true,
    when: {
      kind: 'schedule',
      text: 'Daily at 07:00',
      schedule: { preset: 'daily', expr: '0 7 * * *', sched_type: 'cron', time: '07:00', timezone: 'UTC' },
    },
    then: [{ kind: 'run_agent', text: 'Run triage', target: AGENT_KEY, prompt: 'Digest the night' }],
    recent_failures: 0,
    recent_runs: 0,
    last_runs: [],
    passed_over: 0,
    fires: 3,
    tested: true,
    read_only: false,
    place: { kind: 'hub', label: 'Flowpad cloud' },
    agent_type_id: AGENT_KEY,
    source: 'hub',
    ...overrides,
  } as AutomationSummary;
}

function renderSection(autoLaunchPrompt = '') {
  const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
  render(<AgentScheduleSection agent={agent} autoLaunchPrompt={autoLaunchPrompt} deploymentId={LOCAL_PLACE} isLocal />);
  return agent;
}

describe('the agent schedule tab', () => {
  it('asks for the triggers that live INSIDE this agent, and lists only schedules', () => {
    rows.triggers = [schedule(), schedule({ id: 't2', name: 'a tag rule', trigger_type: 'tag' })];
    renderSection();

    // The containment query: parent_type_id == this agent (QueryFilter wraps the bare dict).
    const query = JSON.stringify((rows.request as { query?: unknown }).query);
    expect(query).toContain('"parent_type_id"');
    expect(query).toContain(`"${AGENT_KEY}"`);
    expect(screen.getByTestId('agent-schedule-0')).toHaveTextContent('Morning triage');
    expect(screen.getByTestId('agent-schedule-when-0')).toHaveTextContent('Daily at 09:00 (Asia/Jerusalem)');
    expect(screen.getByTestId('agent-schedule-0')).toHaveTextContent('Triage yesterday');
    expect(screen.queryByTestId('agent-schedule-1')).toBeNull();
  });

  it('clicking a schedule only navigates to its trigger', () => {
    rows.triggers = [schedule()];
    const agent = renderSection();
    const update = vi.spyOn(agent, 'updateSchedule');

    fireEvent.click(screen.getByTestId('agent-schedule-open-0'));

    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const pointer = nav.openDock.mock.calls[0][0] as { options?: Record<string, string> };
    expect(pointer.options?.trigger).toBe('t1');
    expect(pointer.options?.system).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('links to the runs this schedule started', () => {
    rows.triggers = [schedule()];
    renderSection();
    fireEvent.click(screen.getByTestId('agent-schedule-runs-0'));
    const pointer = nav.openDock.mock.calls[0][0] as { options?: Record<string, string> };
    expect(pointer.options?.trigger_id).toBe('t1');
  });

  it('pre-fills a new schedule with the auto-launch prompt and writes through the agent', async () => {
    const agent = renderSection('Summarize the stream inbox');
    const add = vi.spyOn(agent, 'addSchedule').mockResolvedValue({} as never);

    fireEvent.click(screen.getByTestId('agent-schedule-add'));
    expect(screen.getByTestId('agent-schedule-prompt')).toHaveValue('Summarize the stream inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][0]).toMatchObject({
      name: 'Scheduled run',
      every: 'cron',
      expr: '0 9 * * *',
      prompt: 'Summarize the stream inbox',
      enabled: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await waitFor(() => expect(rows.refetch).toHaveBeenCalled());
  });

  it('keeps a disabled schedule disabled when it is edited', async () => {
    rows.triggers = [schedule({ enabled: false })];
    const agent = renderSection();
    const update = vi.spyOn(agent, 'updateSchedule').mockResolvedValue({} as never);

    fireEvent.click(screen.getByTestId('agent-schedule-edit-0'));
    expect(screen.getByTestId('agent-schedule-prompt')).toHaveValue('Triage yesterday');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe('t1');
    expect(update.mock.calls[0][1]).toMatchObject({ enabled: false, prompt: 'Triage yesterday' });
  });

  it('refuses a schedule with no prompt', async () => {
    const agent = renderSection('');
    const add = vi.spyOn(agent, 'addSchedule');
    fireEvent.click(screen.getByTestId('agent-schedule-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const { notify } = await import('@src/notifications');
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(add).not.toHaveBeenCalled();
  });

  it('on a place, lists that place\'s schedules and legacy ones only on this computer', () => {
    const LOCAL = '44444444-4444-4444-8444-444444444444';
    rows.triggers = [
      schedule({ id: 'here', name: 'Here', runs_on: LOCAL }),
      schedule({ id: 'cloud', name: 'Cloud', runs_on: '55555555-5555-4555-8555-555555555555' }),
      schedule({ id: 'legacy', name: 'Legacy', runs_on: null }),
    ];
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    render(<AgentScheduleSection agent={agent} deploymentId={LOCAL} isLocal />);
    expect(screen.getByTestId('agent-schedule-0')).toHaveTextContent('Here');
    expect(screen.getByTestId('agent-schedule-1')).toHaveTextContent('Legacy');
    // The shared place badge, not an ad-hoc chip: a row no machine is named on runs on every machine.
    expect(screen.getByTestId('agent-schedule-place-0')).toHaveTextContent('This computer');
    expect(screen.getByTestId('agent-schedule-place-1')).toHaveTextContent('This computer · every machine');
    expect(screen.queryByTestId('agent-schedule-2')).toBeNull();
  });

  it('Run now on a cloud place fires on that machine, through the hub', async () => {
    const CLOUD = '55555555-5555-4555-8555-555555555555';
    rows.triggers = [schedule({ runs_on: CLOUD })];
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    const relay = vi.spyOn(agent, 'placeAction').mockResolvedValue({});
    render(<AgentScheduleSection agent={agent} deploymentId={CLOUD} isLocal={false} />);
    fireEvent.click(screen.getByTestId('agent-schedule-run-0'));
    await waitFor(() => expect(relay).toHaveBeenCalledWith(CLOUD, 'run_now', 't1'));
  });

  it('creates a schedule on its place', async () => {
    const LOCAL = '44444444-4444-4444-8444-444444444444';
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    const add = vi.spyOn(agent, 'addSchedule').mockResolvedValue({} as never);
    render(<AgentScheduleSection agent={agent} autoLaunchPrompt="Go" deploymentId={LOCAL} isLocal />);
    fireEvent.click(screen.getByTestId('agent-schedule-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][0]).toMatchObject({ runs_on: LOCAL, prompt: 'Go' });
  });

  it('Flowpad cloud lists the hub schedules that run this agent, and only those', async () => {
    overview.rows = [hubRow(), hubRow({ id: 'h2', name: 'Someone else', agent_type_id: 'agent-other' })];
    rows.triggers = [schedule()];
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    render(<AgentScheduleSection agent={agent} deploymentId="" isLocal={false} onHub />);
    await waitFor(() => expect(screen.getByTestId('agent-schedule-0')).toHaveTextContent('Cloud digest'));
    expect(screen.getByTestId('agent-schedule-place-0')).toHaveTextContent('Flowpad cloud');
    expect(screen.getByTestId('agent-schedule-when-0')).toHaveTextContent('Daily at 07:00');
    expect(screen.getByTestId('agent-schedule-0')).toHaveTextContent('Digest the night');
    expect(screen.queryByTestId('agent-schedule-1')).toBeNull();
  });

  it('a hub schedule does not show on this computer', async () => {
    overview.rows = [hubRow()];
    rows.triggers = [schedule({ runs_on: null })];
    renderSection();
    await waitFor(() => expect(overview.spy).toHaveBeenCalled());
    expect(screen.getByTestId('agent-schedule-0')).toHaveTextContent('Morning triage');
    expect(screen.queryByTestId('agent-schedule-1')).toBeNull();
  });

  it('a hub row is switched, run and deleted on the hub', async () => {
    overview.rows = [hubRow()];
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    const toggle = vi.spyOn(Trigger, 'setEnabled').mockResolvedValue({} as never);
    const fire = vi.spyOn(Trigger, 'fire').mockResolvedValue({});
    const own = vi.spyOn(agent, 'updateSchedule');
    render(<AgentScheduleSection agent={agent} deploymentId="" isLocal={false} onHub />);
    await waitFor(() => expect(screen.getByTestId('agent-schedule-0')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-schedule-enabled-0'));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith('h1', false, { hubReflect: true }));
    fireEvent.click(screen.getByTestId('agent-schedule-run-0'));
    await waitFor(() => expect(fire).toHaveBeenCalledWith('h1'));
    expect(own).not.toHaveBeenCalled();
  });

  it('the form offers this computer, each cloud machine, and Flowpad cloud once there is a prompt', () => {
    const LOCAL = '44444444-4444-4444-8444-444444444444';
    placesState.places = [place(LOCAL, 'mac', true), place(CLOUD_MACHINE, 'box-1', false)];
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    render(<AgentScheduleSection agent={agent} deploymentId={LOCAL} isLocal />);
    fireEvent.click(screen.getByTestId('agent-schedule-add'));
    const picker = screen.getByTestId<HTMLSelectElement>('runs-on-picker');
    const options = () => Array.from(picker.options).map((o) => o.textContent);
    expect(picker.value).toBe('local');
    // No prompt yet: Flowpad cloud runs only an agent with a prompt.
    expect(options()).toEqual(['This computer', 'Cloud · box-1']);
    fireEvent.change(screen.getByTestId('agent-schedule-prompt'), { target: { value: 'Go' } });
    expect(options()).toEqual(['This computer', 'Cloud · box-1', 'Flowpad cloud']);
  });

  it('a new schedule on Flowpad cloud is created on the hub, signed in first, with the zone sent', async () => {
    const LOCAL = '44444444-4444-4444-8444-444444444444';
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    const add = vi.spyOn(agent, 'addSchedule');
    const create = vi.spyOn(Trigger, 'createOnCloud').mockResolvedValue({} as never);
    render(<AgentScheduleSection agent={agent} autoLaunchPrompt="Go" deploymentId={LOCAL} isLocal />);
    fireEvent.click(screen.getByTestId('agent-schedule-add'));
    fireEvent.change(screen.getByTestId('runs-on-picker'), { target: { value: 'hub' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(gate.fn).toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toMatchObject({
      agent: AGENT_KEY,
      prompt: 'Go',
      expr: '0 9 * * *',
      sched_trigger_type: 'cron',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      project_id: 'p1',
    });
    expect(add).not.toHaveBeenCalled();
  });

  it('moving a schedule to Flowpad cloud says so, then creates it there and deletes it here', async () => {
    const LOCAL = '44444444-4444-4444-8444-444444444444';
    rows.triggers = [schedule({ runs_on: LOCAL })];
    const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
    const create = vi.spyOn(Trigger, 'createOnCloud').mockResolvedValue({} as never);
    const removeOwn = vi.spyOn(agent, 'removeSchedule').mockResolvedValue();
    const update = vi.spyOn(agent, 'updateSchedule');
    render(<AgentScheduleSection agent={agent} deploymentId={LOCAL} isLocal />);
    fireEvent.click(screen.getByTestId('agent-schedule-edit-0'));
    expect(screen.queryByTestId('runs-on-move')).toBeNull();
    fireEvent.change(screen.getByTestId('runs-on-picker'), { target: { value: 'hub' } });
    expect(screen.getByTestId('runs-on-move')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(removeOwn).toHaveBeenCalledWith('t1'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
