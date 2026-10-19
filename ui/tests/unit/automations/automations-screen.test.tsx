/**
 * The Automations screen, simple first: a sentence per automation with its
 * health, groups by whose it is, built-ins folded, failures named up front;
 * the builder with presets and Test beside it; a run that says what broke.
 *
 * The hooks layer is mocked — the screen's only door to the backend — so these
 * pin what the person sees and what each click asks for.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AutomationRun, AutomationSummary } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), openFolder: vi.fn(), openMachinePath: vi.fn() }));
const dock = vi.hoisted(() => ({ current: null as null | { pointer?: string; options?: Record<string, string> } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: dock.current }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: { id: 'p1' } }) }));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@src/hooks/entity-hooks', () => ({
  // One answer for every entity query the screen makes: an agent to pick, and (as a data source) a channel.
  useEntitiesQuery: () => ({ data: [{ id: 'a1', name: 'Chief of Staff', channel: 'gmail' }] }),
}));

const state = vi.hoisted(() => ({
  automations: [] as AutomationSummary[],
  runs: [] as AutomationRun[],
  run: null as AutomationRun | null,
  tries: [] as Array<Record<string, unknown>>,
  mutate: {
    runOnce: vi.fn(),
    setEnabled: vi.fn(),
    save: vi.fn(),
    check: vi.fn(),
    remove: vi.fn(),
    decideOn: vi.fn(),
    tryRecent: vi.fn(),
  },
}));
const mutation = (fn: ReturnType<typeof vi.fn>) => ({
  mutate: fn,
  mutateAsync: fn,
  isPending: false,
  isSuccess: false,
  error: null,
  data: undefined,
  variables: undefined,
});
vi.mock('@src/hooks/automations/useAutomations', () => ({
  useAutomations: () => ({ data: state.automations, isLoading: false, error: null }),
  useAutomation: (id: string | null) => ({ automation: state.automations.find((a) => a.id === id) ?? null }),
  useAutomationTrigger: (id: string | null) => ({
    data:
      id === 'r1'
        ? {
            id,
            name: 'Refunds',
            trigger_type: 'tag',
            tag_pattern: 'stream_inbox.*.message.projected',
            tag_scope: ['data_source:ds-1'],
            gate: { sentence: 'asks for a refund' },
            then: { run_agent: { agent: 'agent-a1', prompt: 'Go' } },
            enabled: true,
            isMessageRule: true,
          }
        : id
      ? {
          id,
          name: 'Morning',
          trigger_type: 'schedule',
          expr: '0 9 * * 1-5',
          sched_trigger_type: 'cron',
          enabled: true,
          actions: [{ action_type: 'run_agent', target_type_id: 'agent-a1', prompt: 'Go' }],
        }
      : null,
    error: null,
  }),
  useAutomationRuns: () => ({ data: state.runs, isLoading: false, error: null }),
  useAutomationRun: () => ({ data: state.run, error: null }),
  useNextRuns: () => ({
    data: { times: ['2026-10-06T06:00:00+00:00', '2026-10-07T06:00:00+00:00'], schedule: {}, text: '' },
    error: null,
    isFetching: false,
  }),
  useBusMap: () => ({ data: { event_types: [], forwarded_patterns: [] } }),
  useAutomationSamples: () => ({ data: [], isFetching: false }),
  useRunOnce: () => mutation(state.mutate.runOnce),
  useSetAutomationEnabled: () => mutation(state.mutate.setEnabled),
  useSaveAutomation: () => mutation(state.mutate.save),
  useAutomationCheck: () => mutation(state.mutate.check),
  useDeleteAutomation: () => mutation(state.mutate.remove),
  useDiscoverRules: () => mutation(vi.fn()),
  useRuleCode: () => ({ data: '', error: null, save: mutation(vi.fn()) }),
  useDecideOn: () => mutation(state.mutate.decideOn),
  useDecideOnRecent: () => ({ data: state.tries, isFetching: false, error: null, refetch: state.mutate.tryRecent }),
  useRunnableAgents: () => ({ data: [{ id: 'a1', name: 'Chief of Staff' }] }),
  useStartedLastHour: () => 0,
}));

import { AutomationsView } from '@src/components/automations/AutomationsView';

const when = {
  kind: 'schedule' as const,
  text: 'Every weekday at 09:00',
  schedule: { preset: 'weekdays' as const, expr: '0 9 * * 1-5', sched_type: 'cron', time: '09:00' },
};
const then = [
  { kind: 'run_agent' as const, text: 'Run Chief of Staff', target_name: 'Chief of Staff', target: 'agent-a1' },
];

function automation(patch: Partial<AutomationSummary>): AutomationSummary {
  return {
    id: 'a',
    name: 'Morning',
    description: '',
    kind: 'schedule',
    group: 'mine',
    enabled: true,
    when,
    then,
    recent_failures: 0,
    recent_runs: 0,
    fires: 0,
    tested: true,
    read_only: false,
    ...patch,
  } as AutomationSummary;
}

function run(patch: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'r1',
    automation_name: 'Morning',
    ts: new Date().toISOString(),
    status: 'succeeded',
    is_test: false,
    why: 'Scheduled',
    actions: ['run_agent'],
    ...patch,
  } as AutomationRun;
}

beforeEach(() => {
  dock.current = null;
  state.automations = [];
  state.runs = [];
  state.run = null;
  state.tries = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('My automations', () => {
  it('with nothing yet, teaches what can start one', () => {
    render(<AutomationsView />);
    expect(screen.getByTestId('automation-kind-gallery')).toBeTruthy();
    fireEvent.click(screen.getByTestId('automation-kind-schedule'));
    const pointer = nav.openDock.mock.calls[0][0];
    expect(pointer.options).toEqual({ creating: 'schedule' });
  });

  it('with none of your own, Flowpad’s own are still listed, folded', () => {
    state.automations = [automation({ id: 'b', group: 'builtin', read_only: true })];
    render(<AutomationsView />);
    expect(screen.getByTestId('automation-kind-gallery')).toBeTruthy();
    fireEvent.click(screen.getByTestId('automations-builtin-toggle'));
    expect(screen.getByTestId('automation-row-b')).toBeTruthy();
  });

  it('a starter opens the builder prefilled', () => {
    render(<AutomationsView />);
    fireEvent.click(screen.getByTestId('automation-recipe-morning-briefing'));
    expect(nav.openDock.mock.calls[0][0].options).toEqual({ creating: 'schedule', recipe: 'morning-briefing' });
  });

  it('each row reads as the rule, with its last result and next run', () => {
    state.automations = [
      automation({ id: 'a1', last_run: run({ status: 'succeeded' }), next_run: '2026-10-06T06:00:00+00:00' }),
    ];
    render(<AutomationsView />);
    const row = screen.getByTestId('automation-row-a1');
    expect(row.textContent).toContain('Every weekday at 09:00');
    expect(row.textContent).toContain('run Chief of Staff');
    expect(within(screen.getByTestId('automation-last-a1')).getByText('Succeeded')).toBeTruthy();
  });

  it('groups by whose it is and folds Flowpad’s own into one healthy line', () => {
    state.automations = [
      automation({ id: 'p', group: 'project', project_id: 'p1' }),
      automation({ id: 'm', group: 'mine' }),
      automation({ id: 'b', group: 'builtin', read_only: true }),
    ];
    render(<AutomationsView />);
    expect(within(screen.getByTestId('automations-group-project')).getByTestId('automation-row-p')).toBeTruthy();
    expect(within(screen.getByTestId('automations-group-mine')).getByTestId('automation-row-m')).toBeTruthy();
    expect(screen.queryByTestId('automation-row-b')).toBeNull();
    expect(screen.getByTestId('automations-builtin-toggle').textContent).toContain('All healthy');
    fireEvent.click(screen.getByTestId('automations-builtin-toggle'));
    expect(screen.getByTestId('automation-row-b')).toBeTruthy();
  });

  it('a failure is named before anyone looks, and links to what went wrong', () => {
    state.automations = [
      automation({ id: 'f', name: 'Doc linter', last_run: run({ status: 'failed', error: 'boom' }) }),
    ];
    render(<AutomationsView />);
    const strip = screen.getByTestId('automations-attention');
    expect(strip.textContent).toContain('Doc linter failed');
    fireEvent.click(strip);
    const pointer = nav.openDock.mock.calls[0][0];
    expect([pointer.pointer, pointer.options]).toEqual(['runs', { status: 'failed' }]);
  });

  it('an untested rule says so instead of its next run', () => {
    state.automations = [automation({ id: 'u', tested: false })];
    render(<AutomationsView />);
    expect(screen.getByTestId('automation-untested-u').textContent).toContain('Not tested yet');
  });

  it('kind chips filter, and only kinds that exist are offered', () => {
    state.automations = [
      automation({ id: 's' }),
      automation({
        id: 'e',
        kind: 'event',
        when: { kind: 'event', text: '', event: { pattern: 'app.ready', title: 'App ready', description: '' } },
      }),
    ];
    render(<AutomationsView />);
    expect(screen.queryByTestId('automations-chip-file')).toBeNull();
    fireEvent.click(screen.getByTestId('automations-chip-event'));
    expect(screen.queryByTestId('automation-row-s')).toBeNull();
    expect(screen.getByTestId('automation-row-e').textContent).toContain('When App ready happens');
  });

  it('the switch and Run now act without opening the automation', () => {
    state.automations = [automation({ id: 'a1' })];
    render(<AutomationsView />);
    fireEvent.click(screen.getByTestId('automation-toggle-a1'));
    expect(state.mutate.setEnabled).toHaveBeenCalledWith({ triggerId: 'a1', enabled: false }, expect.anything());
    fireEvent.click(screen.getByTestId('automation-run-once-a1'));
    expect(state.mutate.runOnce).toHaveBeenCalledWith({ triggerId: 'a1' }, expect.anything());
    expect(nav.openDock).not.toHaveBeenCalled();
  });
});

describe('the builder', () => {
  it('a new schedule starts on presets, shows the next runs, and names what is missing', () => {
    dock.current = { options: { creating: 'schedule' } };
    render(<AutomationsView />);
    expect(screen.getByTestId('when-schedule-preset-weekdays').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('when-next-runs').textContent).not.toContain('No future run');
    expect(screen.getByTestId('automation-problems').textContent).toContain('Pick the agent to run.');
    // Cron is the escape hatch, not the default.
    expect(screen.queryByTestId('when-schedule-cron')).toBeNull();
    fireEvent.click(screen.getByTestId('when-schedule-preset-cron'));
    expect(screen.getByTestId('when-schedule-cron')).toBeTruthy();
  });

  it('Check on an unsaved automation sends the builder fields, nothing is saved', () => {
    dock.current = { options: { creating: 'schedule', recipe: 'morning-briefing' } };
    render(<AutomationsView />);
    fireEvent.click(screen.getByTestId('test-check'));
    const [args] = state.mutate.check.mock.calls[0];
    expect(args.triggerId).toBeNull();
    expect(args.spec).toMatchObject({ trigger_type: 'schedule', expr: '0 9 * * 1-5', name: 'Morning briefing' });
    expect(state.mutate.save).not.toHaveBeenCalled();
  });

  it('time zone, the saved expression and JSON are one click away, not in the way', () => {
    dock.current = { options: { creating: 'schedule' } };
    render(<AutomationsView />);
    expect(screen.queryByTestId('when-schedule-timezone')).toBeNull();
    fireEvent.click(screen.getByTestId('when-schedule-advanced'));
    expect(screen.getByTestId('when-schedule-timezone')).toBeTruthy();
    expect(screen.queryByTestId('automation-json-toggle')).toBeNull();
    fireEvent.click(screen.getByTestId('automation-advanced-toggle'));
    expect(screen.getByTestId('automation-json-toggle')).toBeTruthy();
  });

  it('a saved automation loads into the presets it was made with', () => {
    state.automations = [automation({ id: 'a1', tested: false })];
    dock.current = { options: { trigger: 'a1' } };
    render(<AutomationsView />);
    expect(screen.getByTestId('when-schedule-preset-weekdays').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByTestId('then-prompt') as HTMLTextAreaElement).value).toBe('Go');
    expect(screen.getByTestId('automation-untested').textContent).toContain('Not tested yet');
    expect((screen.getByTestId('automation-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Flowpad’s own can be checked and run, not changed', () => {
    state.automations = [automation({ id: 'b', group: 'builtin', read_only: true })];
    dock.current = { options: { trigger: 'b' } };
    render(<AutomationsView />);
    expect(screen.queryByTestId('automation-save')).toBeNull();
    expect(screen.queryByTestId('automation-delete')).toBeNull();
    expect(screen.getByTestId('test-check')).toBeTruthy();
  });

  it('agent activity is explained, not offered as a form', () => {
    dock.current = { options: { creating: 'agent_hook' } };
    render(<AutomationsView />);
    expect(screen.getByTestId('automation-agent-rules').textContent).toContain('trigger.py');
  });
});

describe('a run', () => {
  it('a failure says what went wrong first, and an event run can be replayed', () => {
    const failed = run({
      id: 'r9',
      trigger_id: 't1',
      status: 'failed',
      kind: 'event',
      error: 'OpenRouter daily limit reached',
      cause_tag: 'task.assigned',
      cause_target: 'task:1',
      cause_data: { title: 'Fix' },
    });
    state.run = failed;
    state.runs = [failed];
    dock.current = { pointer: 'runs', options: { run: 'r9' } };
    render(<AutomationsView />);
    expect(screen.getByTestId('run-detail-error').textContent).toContain('OpenRouter daily limit reached');
    expect(screen.getByTestId('run-detail-cause').textContent).toContain('Fix');
    fireEvent.click(screen.getByTestId('run-replay'));
    expect(state.mutate.runOnce).toHaveBeenCalledWith({
      triggerId: 't1',
      event: { tag: 'task.assigned', target: 'task:1', data: { title: 'Fix' } },
    });
  });

  it('a skip says why in words', () => {
    state.runs = [run({ id: 's1', status: 'skipped', reason_code: 'storm', why: 'x' })];
    dock.current = { pointer: 'runs' };
    render(<AutomationsView />);
    expect(screen.getByTestId('run-row-s1').textContent).toContain('fired too often');
  });
});

describe('what ran, and what it did', () => {
  it('each run says its kind', () => {
    state.runs = [run({ id: 'k1', kind: 'file', why: 'x', changed_path: '/w/a.md' })];
    dock.current = { pointer: 'runs' };
    render(<AutomationsView />);
    expect(screen.getByTestId('run-row-k1').querySelector('[data-kind="file"]')?.textContent).toContain('File');
  });

  it('a run shows its steps in words, and an agent step can be opened', () => {
    state.automations = [
      automation({
        id: 't1',
        then: [
          {
            kind: 'run_agent',
            text: 'Run Chief of Staff',
            target: 'agent-550e8400-e29b-41d4-a716-446655440000',
            target_name: 'Chief of Staff',
            prompt: 'Summarize',
          },
          {
            kind: 'builtin_step',
            text: 'Run transcript streamer route',
            target_name: 'transcript streamer route',
            detail: 'Routes a transcript change to its streamer.',
          },
        ],
      }),
    ];
    state.run = run({ id: 'r5', trigger_id: 't1', kind: 'schedule', actions: ['run_agent', 'callback'] });
    state.runs = [state.run];
    dock.current = { pointer: 'runs', options: { run: 'r5' } };
    render(<AutomationsView />);
    const steps = screen.getByTestId('then-steps');
    expect(steps.textContent).toContain('Chief of Staff');
    expect(steps.textContent).toContain('Routes a transcript change to its streamer.');
    expect(steps.textContent).not.toContain('callback');
    fireEvent.click(screen.getByTestId('then-step-open-0'));
    expect(nav.openDock.mock.calls.at(-1)?.[0].viewType).toBe('assets');
  });
});

describe('browsing what an automation is made of', () => {
  const watcher = () =>
    automation({
      id: 'w',
      kind: 'file',
      name: 'Claude Code chats',
      when: { kind: 'file', text: '', file: { path: '/Users/me/.claude/projects', glob: '*.jsonl', recursive: true, is_folder: true } },
    });

  it('the watched folder can be browsed from the list, without opening the automation', () => {
    state.automations = [watcher()];
    render(<AutomationsView />);
    fireEvent.click(screen.getByTestId('automation-browse-w'));
    expect(nav.openFolder).toHaveBeenCalledWith('/Users/me/.claude/projects');
    expect(nav.openDock).not.toHaveBeenCalled();
  });

  it('the name opens the trigger.json it is defined in, else its page', () => {
    state.automations = [automation({ id: 'f', asset_ref: '/w/agentic-assets/trigger/morning' }), watcher()];
    render(<AutomationsView />);
    fireEvent.click(screen.getByTestId('automation-name-f'));
    expect(nav.openMachinePath.mock.calls[0][0]).toBe('/w/agentic-assets/trigger/morning/trigger.json');
    fireEvent.click(screen.getByTestId('automation-name-w'));
    expect(nav.openDock.mock.calls[0][0].options).toEqual({ trigger: 'w' });
  });
});


describe('a rule on messages arriving', () => {
  it('is the first card, and its starters open the two-box screen', () => {
    render(<AutomationsView />);
    const cards = screen.getAllByTestId(/^automation-kind-(message|schedule|event|file|agent_hook)$/);
    expect(cards[0].getAttribute('data-testid')).toBe('automation-kind-message');
    fireEvent.click(screen.getByTestId('automation-recipe-refund-requests'));
    expect(nav.openDock.mock.calls[0][0].toUrl('/')).toBe('/dock/automations?creating=message&recipe=refund-requests');
  });

  it('a new rule from a message: two boxes, prefilled, saved as a gate and a then', () => {
    state.mutate.save.mockResolvedValue({ id: 'new-1' });
    dock.current = { options: { creating: 'message', source: 'a1', recipe: 'refund-requests' } };
    render(<AutomationsView />);
    expect(screen.getByTestId('message-rule-page')).toBeTruthy();
    const sentence = screen.getByTestId('message-rule-catch-text') as HTMLTextAreaElement;
    expect(sentence.value).toBe('asks for a refund or disputes a charge');
    expect(screen.getByTestId('message-rule-source-a1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByTestId('message-rule-agent'), { target: { value: 'agent-a1' } });
    fireEvent.click(screen.getByTestId('automation-save'));
    const { fields } = state.mutate.save.mock.calls[0][0];
    expect(fields).toMatchObject({
      trigger_type: 'tag',
      tag_pattern: 'stream_inbox.*.message.projected',
      tag_scope: ['data_source:a1'],
      gate: { sentence: 'asks for a refund or disputes a charge' },
      then: { run_agent: { agent: 'agent-a1' } },
      enabled: true,
    });
    expect(fields.name).toBe('Asks for a refund or disputes a charge → Chief of Staff');
  });

  it('the fast test asks the gate about the typed text, and the try list shows each verdict', async () => {
    state.tries = [
      { state: { message_id: 'm1', sender: 'Dana Levi <d@x>', subject: 'Charged twice', text: 'two charges' }, verdict: { met: true, confidence: 0.93 }, decided_at: null },
      { state: { message_id: 'm2', sender: 'Acme', subject: 'Invoice', text: 'attached' }, verdict: { caught: false, confidence: 0.08 }, decided_at: '2026-10-10T10:00:00Z' },
    ];
    state.automations = [automation({ id: 'r1', kind: 'event', when: { kind: 'event', text: '', event: { pattern: 'stream_inbox.*.message.projected', title: '', description: '' } } })];
    dock.current = { options: { trigger: 'r1' } };
    render(<AutomationsView />);
    fireEvent.change(screen.getByTestId('message-rule-sample'), { target: { value: 'I was billed twice' } });
    fireEvent.click(screen.getByTestId('message-rule-fast-test-run'));
    await waitFor(() => expect(state.mutate.decideOn).toHaveBeenCalledWith({ triggerId: 'r1', text: 'I was billed twice' }));
    // Edit the sentence: the fast test now tests the fields as typed, not the saved row.
    fireEvent.change(screen.getByTestId('message-rule-catch-text'), { target: { value: 'mentions a refund' } });
    fireEvent.click(screen.getByTestId('message-rule-fast-test-run'));
    await waitFor(() => expect(state.mutate.decideOn).toHaveBeenLastCalledWith(expect.objectContaining({ spec: expect.objectContaining({ gate: { sentence: 'mentions a refund' } }), text: 'I was billed twice' })));
    const rows = screen.getAllByTestId('message-rule-try-row');
    expect(rows.map((r) => r.getAttribute('data-verdict'))).toEqual(['yes', 'no']);
    expect(rows[1].textContent).toContain('decided');
  });
});
