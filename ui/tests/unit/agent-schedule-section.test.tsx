/**
 * The agent's Schedule tab: its schedules are child trigger assets, found by
 * containment; a click only navigates; writes go through the agent's verbs.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@sdk';

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

import { AgentScheduleSection } from '@src/components/assets/editor/agent-profile/AgentScheduleSection';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_KEY = `agent-${AGENT_ID}`;

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

afterEach(() => {
  cleanup();
  rows.triggers = [];
  vi.clearAllMocks();
});

function renderSection(autoLaunchPrompt = '') {
  const agent = new Agent({ id: AGENT_ID, name: 'triage', enabled: true });
  render(<AgentScheduleSection agent={agent} autoLaunchPrompt={autoLaunchPrompt} />);
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
    const agent = renderSection('Summarize the inbox');
    const add = vi.spyOn(agent, 'addSchedule').mockResolvedValue({} as never);

    fireEvent.click(screen.getByTestId('agent-schedule-add'));
    expect(screen.getByTestId('agent-schedule-prompt')).toHaveValue('Summarize the inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][0]).toMatchObject({
      name: 'Scheduled run',
      every: 'cron',
      expr: '0 9 * * *',
      prompt: 'Summarize the inbox',
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
});
