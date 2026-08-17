/**
 * CallTreeView renders the call-stack tree: nested frames, policy chips, the
 * metric toggle, and click-to-select (which seeks the timeline via onSelectFrame).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallTreeView } from '@src/components/assets/editor/agent-trace/CallTreeView';
import type { AgentTraceDoc, CallFrame } from '@src/components/assets/editor/agent-trace/trace-types';

// `view-mode-context` reads the current dock, which calls `useLocation()`.
// These tests render without a Router, so stub only that hook and keep the
// rest of the module real (a full mock would drop `useDockNavigation`).
vi.mock('@src/navigation/useDockNavigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/navigation/useDockNavigation')>()),
  useCurrentDock: () => null,
}));


afterEach(cleanup);

function frame(over: Partial<CallFrame>): CallFrame {
  return {
    id: 'f1',
    kind: 'tool',
    callable: 'Bash',
    label: 'Bash',
    lane_id: 'root',
    entry_id: null,
    context_policy: 'preserve',
    control_policy: 'call',
    state_scope: 'turn',
    mcp: false,
    start_ts: '2026-06-12T10:00:00Z',
    end_ts: '2026-06-12T10:00:01Z',
    self_cost_usd: 0,
    total_cost_usd: 0,
    self_duration_ms: 1000,
    total_duration_ms: 1000,
    tool_call_count: 1,
    issue_count: 0,
    worst_severity: 'info',
    issues_per_usd: null,
    issues_per_min: null,
    children: [],
    ...over,
  };
}

function docWithTree(tree: CallFrame): AgentTraceDoc {
  return {
    version: 2,
    name: 't',
    session_id: 's',
    worker_type: 'claude',
    generated_at: '',
    summary: {
      verdict: null, verdict_reason: null, duration_ms: 0, cost_usd: 0,
      issue_count: 0, divergence_count: 0, lane_count: 1, tool_call_count: 0,
    },
    lanes: [],
    call_tree: tree,
    events: [],
    markers: [],
    annotations: { goals: [], divergences: [], verdict: null, notes: [] },
  };
}

const TREE = frame({
  id: 'root', kind: 'session', callable: 'session', label: 'session',
  total_cost_usd: 100, total_duration_ms: 600000, issue_count: 5, worst_severity: 'attention',
  children: [
    frame({
      id: 'sk', kind: 'skill', callable: 'e2e-qa', label: 'skill: e2e-qa',
      context_policy: 'preserve', total_cost_usd: 90, total_duration_ms: 500000,
      issue_count: 4, worst_severity: 'attention', issues_per_usd: 0.04,
      children: [
        frame({ id: 'sub', kind: 'subagent', callable: 'qa-tester-1',
          context_policy: 'isolate', total_cost_usd: 10, issue_count: 2 }),
      ],
    }),
  ],
});

describe('CallTreeView', () => {
  it('renders nested frames with policy chips', () => {
    render(<CallTreeView doc={docWithTree(TREE)} selectedFrameId={null} onSelectFrame={vi.fn()} />);
    expect(screen.getByText('session')).toBeTruthy();
    expect(screen.getByText('e2e-qa')).toBeTruthy();
    // Default-open to depth 2 → the subagent under the skill is visible.
    expect(screen.getByText('qa-tester-1')).toBeTruthy();
    expect(screen.getAllByText('isolate').length).toBeGreaterThan(0);
  });

  it('selects a frame on click', () => {
    const onSelect = vi.fn();
    render(<CallTreeView doc={docWithTree(TREE)} selectedFrameId={null} onSelectFrame={onSelect} />);
    fireEvent.click(screen.getByText('e2e-qa'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'sk' }));
  });

  it('offers cost/time/issues metric toggle', () => {
    render(<CallTreeView doc={docWithTree(TREE)} selectedFrameId={null} onSelectFrame={vi.fn()} />);
    expect(screen.getByTestId('call-tree-metric-cost')).toBeTruthy();
    expect(screen.getByTestId('call-tree-metric-time')).toBeTruthy();
    fireEvent.click(screen.getByTestId('call-tree-metric-issues'));
    // Still renders after switching metric.
    expect(screen.getByText('session')).toBeTruthy();
  });

  it('shows empty state when call_tree is absent (pre-v2)', () => {
    const doc = docWithTree(TREE);
    delete (doc as { call_tree?: CallFrame }).call_tree;
    render(<CallTreeView doc={doc} selectedFrameId={null} onSelectFrame={vi.fn()} />);
    expect(screen.getByText(/Re-run the analysis/i)).toBeTruthy();
  });
});
