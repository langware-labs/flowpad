/**
 * SequenceChartView — RTL coverage.
 *
 *   1. chart.json participants and messages render (cards, numbered arrows, sub-flow block).
 *   2. A sub-flow's "Open ↗" resolves the chart named by `ref` and navigates to it — URL-first,
 *      through navigation.openDock only — without picking the block for a comment.
 *   3. The Table view lists every message with its sender and receiver names.
 *   4. Without a chartit.feedback dataset the toolbar shows the one-line reason and is disabled.
 *   5. sequenceToMermaid matches the backend rules.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openDock, forKind, chartQuery } = vi.hoisted(() => ({
  openDock: vi.fn(),
  forKind: vi.fn(async (): Promise<unknown[]> => []),
  chartQuery: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock } }),
}));

vi.mock('@sdk', async (orig) => {
  const actual = await orig<typeof import('@sdk')>();
  class ChartStub {
    static type = 'chart';
    static query = chartQuery;
  }
  return {
    ...actual,
    Chart: ChartStub,
    Dataset: { forKind },
  };
});

// eslint-disable-next-line import/first
import { SequenceChartView } from '@src/components/assets/editor/chart/SequenceChartView';
// eslint-disable-next-line import/first
import { sequenceToMermaid } from '@src/components/assets/editor/chart/sequenceToMermaid';

const PROJECT = '22222222-2222-4222-8222-222222222222';

const SEQUENCE = {
  participants: [
    { id: 'user', label: 'User\nbrowser' },
    { id: 'api', label: 'API' },
    { id: 'db', label: 'Database' },
  ],
  messages: [
    { id: 'm1', from: 'user', to: 'api', label: 'POST /login' },
    { id: 'm2', from: 'api', to: 'db', label: 'Check credentials', ref: 'auth-check', returns: 'user row' },
    { id: 'm3', from: 'api', to: 'api', label: 'Mint token' },
    { id: 'm4', from: 'api', to: 'user', label: '200 + token', style: 'dashed', note: 'cookie set' },
  ],
};

function makeFsRef(files: Record<string, string>) {
  return {
    path: '/w/p/agentic-assets/chart/login-flow',
    child(name: string) {
      return {
        path: `/w/p/agentic-assets/chart/login-flow/${name}`,
        readIfExists: async () => files[name] ?? null,
        write: vi.fn(async () => {}),
      };
    },
    open: vi.fn(),
  } as unknown as import('@sdk').FSRef;
}

const chart = {
  name: 'login-flow',
  scope: 'project-1',
  typeId: { toString: () => 'chart-11111111-1111-4111-8111-111111111111' },
} as unknown as import('@sdk').Chart;

function renderView() {
  return render(
    <MemoryRouter>
      <SequenceChartView
        fsRef={makeFsRef({ 'chart.json': JSON.stringify(SEQUENCE) })}
        chart={chart}
        projectId={PROJECT}
      />
    </MemoryRouter>,
  );
}

describe('SequenceChartView', () => {
  beforeEach(() => {
    openDock.mockClear();
    forKind.mockClear();
    chartQuery.mockClear();
  });

  it('draws participants, numbered messages and the sub-flow block', async () => {
    renderView();
    await screen.findByTestId('chart-sequence-svg');
    expect(screen.getAllByTestId('chart-participant')).toHaveLength(3);
    // m1, the sub-flow's dashed return, m3 (self-call), m4
    expect(screen.getAllByTestId('chart-message')).toHaveLength(4);
    expect(screen.getAllByTestId('chart-subflow')).toHaveLength(1);
    expect(screen.getByText('SUB-FLOW')).toBeInTheDocument();
    expect(screen.getByText('POST /login')).toBeInTheDocument();
    expect(screen.getByText('user row')).toBeInTheDocument();
    expect(screen.getByText('browser')).toBeInTheDocument();
  });

  it('Open ↗ on a sub-flow navigates to the chart named by its ref', async () => {
    const target = { name: 'auth-check', scope: 'project-1', dockPointer: { url: 'chart:auth-check' } };
    chartQuery.mockResolvedValueOnce([target]);
    renderView();
    fireEvent.click(await screen.findByTestId('chart-subflow-open'));
    await waitFor(() => expect(openDock).toHaveBeenCalledWith(target.dockPointer));
    const request = (chartQuery.mock.calls[0] as unknown[])[0] as { query: unknown };
    expect(JSON.stringify(request.query)).toContain('auth-check');
    // The open button never picks the block for a comment.
    expect(screen.queryByTestId('chart-feedback-panel')).toBeNull();
  });

  it('the Table view lists every message with sender and receiver', async () => {
    renderView();
    fireEvent.click(await screen.findByTestId('chart-view-table'));
    const rows = screen.getAllByTestId('chart-table-row');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('User');
    expect(rows[0].textContent).toContain('API');
    expect(rows[3].textContent).toContain('200 + token — cookie set');
    expect(screen.queryByTestId('chart-sequence-svg')).toBeNull();
  });

  it('turns feedback off with a one-line reason when the project has no chartit.feedback dataset', async () => {
    renderView();
    const reason = await screen.findByTestId('chart-feedback-reason');
    expect(reason.textContent).toMatch(/no chart-feedback dataset/);
    expect(forKind).toHaveBeenCalledWith('chartit.feedback', PROJECT);
    expect(screen.getByTestId('chart-feedback-open')).toBeDisabled();
  });
});

describe('sequenceToMermaid', () => {
  it('follows the backend rules: ids, ->> / -->>, a sub-flow as a Note with its return', () => {
    expect(sequenceToMermaid(SEQUENCE)).toBe(
      [
        'sequenceDiagram',
        '  participant user as User<br/>browser',
        '  participant api as API',
        '  participant db as Database',
        '  user->>api: POST /login',
        '  Note over api,db: ↗ Check credentials (chart auth-check)',
        '  db-->>api: user row',
        '  api->>api: Mint token',
        '  api-->>user: 200 + token',
        '  Note right of user: cookie set',
        '',
      ].join('\n'),
    );
  });

  it('never throws on an empty or malformed value', () => {
    expect(sequenceToMermaid(null)).toBe('sequenceDiagram\n  %% empty chart\n');
    expect(sequenceToMermaid({ participants: [], messages: [] })).toBe('sequenceDiagram\n  %% empty chart\n');
  });
});
