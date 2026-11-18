/**
 * FlowchartChartView — RTL coverage, plus the pure flowchartModel helpers.
 *
 *   1. Start, questions and outcomes render with labelled exits; only questions are numbered.
 *   2. State and Notes sit beside the canvas, never in it, numbered like their question.
 *   3. Hovering a State row lights its node, and a node lights its row.
 *   4. The Table view lists every node with its state and where it leads.
 *   5. Clicking a node opens "Change this", which hands the request to `changes.request`.
 *   6. parseFlowchart drops malformed nodes and dangling edges; flowchartToMermaid keeps state and notes.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));

import { FlowchartChartView } from '@src/components/assets/editor/chart/FlowchartChartView';
import { flowchartToMermaid, parseFlowchart } from '@src/components/assets/editor/chart/flowchartModel';

const FLOW = {
  title: 'Where an order goes',
  nodes: [
    { id: 'start', kind: 'start', label: 'Customer places an order' },
    { id: 'paid', kind: 'question', label: 'Payment accepted?', state: 'The charge status', note: 'Retried once' },
    { id: 'stock', kind: 'question', label: 'In stock?', state: 'The warehouse count' },
    { id: 'ship', kind: 'outcome', label: 'Ship it' },
    { id: 'cancel', kind: 'outcome', label: 'Cancel the order' },
    { id: 'back', kind: 'outcome', label: 'Put on back order' },
  ],
  edges: [
    { from: 'start', to: 'paid' },
    { from: 'paid', to: 'stock', label: 'yes' },
    { from: 'paid', to: 'cancel', label: 'no' },
    { from: 'stock', to: 'ship', label: 'yes' },
    { from: 'stock', to: 'back', label: 'no' },
  ],
  notes: ['Every order is saved first'],
};

function makeFsRef(files: Record<string, string>) {
  return {
    path: '/w/p/agentic-assets/chart/order-flow',
    child(name: string) {
      return {
        path: `/w/p/agentic-assets/chart/order-flow/${name}`,
        readIfExists: () => Promise.resolve(files[name] ?? null),
        write: vi.fn(() => Promise.resolve()),
      };
    },
    open: vi.fn(),
  } as unknown as import('@sdk').FSRef;
}

const chart = {
  name: 'order-flow',
  typeId: { toString: () => 'chart-11111111-1111-4111-8111-111111111111' },
} as unknown as import('@sdk').Chart;

function renderView(changes?: import('@src/components/assets/editor/chart/chartControls').ChartChanges) {
  return render(
    <MemoryRouter>
      <FlowchartChartView fsRef={makeFsRef({ 'flowchart.json': JSON.stringify(FLOW) })} chart={chart} changes={changes} />
    </MemoryRouter>,
  );
}

const nodeOf = (id: string) =>
  screen.getAllByTestId('chart-flow-node').find((n) => n.getAttribute('data-target') === id)!;

describe('FlowchartChartView', () => {
  it('draws the start, numbered questions, outcomes and labelled exits', async () => {
    renderView();
    await screen.findByTestId('chart-flowchart-svg');
    const nodes = screen.getAllByTestId('chart-flow-node');
    expect(nodes.map((n) => n.getAttribute('data-kind'))).toEqual([
      'start', 'question', 'question', 'outcome', 'outcome', 'outcome',
    ]);
    expect(screen.getAllByTestId('chart-flow-number').map((n) => n.textContent)).toEqual(['1', '2']);
    expect(screen.getAllByTestId('chart-flow-edge')).toHaveLength(5);
    const canvas = screen.getByTestId('chart-flowchart-svg').textContent ?? '';
    expect(canvas).toContain('Payment accepted?');
    expect(canvas).toContain('yes');
  });

  it('keeps state and notes beside the canvas, numbered like their question', async () => {
    renderView();
    await screen.findByTestId('chart-flowchart-svg');
    const canvas = screen.getByTestId('chart-flowchart-svg').textContent ?? '';
    expect(canvas).not.toContain('The charge status');
    expect(canvas).not.toContain('Retried once');
    expect(screen.getByTestId('chart-side-state').textContent).toContain('1Payment accepted?The charge status');
    expect(screen.getByTestId('chart-side-state').textContent).toContain('2In stock?The warehouse count');
    const notes = screen.getByTestId('chart-side-notes').textContent ?? '';
    expect(notes).toContain('Retried once');
    expect(notes).toContain('Every order is saved first');
  });

  it('hovering a state row lights its node, and a node lights its row', async () => {
    renderView();
    await screen.findByTestId('chart-flowchart-svg');
    const row = screen.getAllByTestId('chart-side-row').find((r) => r.getAttribute('data-for') === 'stock')!;
    fireEvent.pointerEnter(row);
    expect(nodeOf('stock').getAttribute('class')).toContain('hot');
    fireEvent.pointerLeave(row);
    fireEvent.pointerMove(nodeOf('paid'), { clientX: 10, clientY: 10 });
    const lit = screen.getAllByTestId('chart-side-row').filter((r) => r.getAttribute('data-lit') === 'true');
    expect(lit.map((r) => r.getAttribute('data-for'))).toEqual(['paid', 'paid']); // its State row and its Note row
    expect(screen.getByTestId('chart-tooltip').textContent).toContain('1. Payment accepted?');
  });

  it('lists every node in the Table view with its state and where it leads', async () => {
    renderView();
    await screen.findByTestId('chart-flowchart-svg');
    fireEvent.click(screen.getByTestId('chart-view-table'));
    const rows = screen.getAllByTestId('chart-table-row').map((r) => r.textContent);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toContain('1Payment accepted?The charge statusyes → In stock? · no → Cancel the order');
  });

  it('a click on a node asks for a change on it', async () => {
    const request = vi.fn();
    renderView({ request, marks: new Map() });
    await screen.findByTestId('chart-flowchart-svg');
    fireEvent.click(nodeOf('ship'));
    fireEvent.change(screen.getByTestId('chart-change-text'), { target: { value: 'Say Send it' } });
    fireEvent.click(screen.getByTestId('chart-change-add'));
    expect(request).toHaveBeenCalledWith({ quote: 'ship · Ship it', instruction: 'Say Send it', runNow: false });
  });
});

describe('flowchartModel', () => {
  it('drops malformed nodes and edges that join nothing', () => {
    const value = parseFlowchart(
      JSON.stringify({
        nodes: [{ id: 'a', kind: 'start', label: 'A' }, { id: 'a', label: 'again' }, { label: 'no id' }, { id: 'b', kind: 'cloud' }],
        edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }],
        notes: ['one', 7, ''],
      }),
    );
    expect(value.nodes.map((n) => [n.id, n.kind, n.label])).toEqual([['a', 'start', 'A'], ['b', 'step', 'b']]);
    expect(value.edges).toEqual([{ from: 'a', to: 'b', label: undefined }]);
    expect(value.notes).toEqual(['one']);
    expect(parseFlowchart('not json').nodes).toEqual([]);
  });

  it('writes a mermaid flowchart that keeps the state and the notes as comments', () => {
    const text = flowchartToMermaid(parseFlowchart(JSON.stringify(FLOW)));
    expect(text).toContain('flowchart TD');
    expect(text).toContain('paid{"1 · Payment accepted?"}');
    expect(text).toContain('paid -- "yes" --> stock');
    expect(text).toContain('%% state 1: The charge status');
    expect(text).toContain('%% note: Every order is saved first');
  });
});
