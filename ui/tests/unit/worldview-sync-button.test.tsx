import Graph from 'graphology';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GraphView } from '@src/components/graph-view/GraphView';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadWorldView = vi.hoisted(() => vi.fn());
const refreshWorldView = vi.hoisted(() => vi.fn());
const setUrlState = vi.hoisted(() => vi.fn());
const engineLayouts = vi.hoisted(() => [] as Array<string | undefined>);
const engineSignals = vi.hoisted(() => [] as string[]);
const engineRoots = vi.hoisted(() => [] as string[]);
const graphUrlState = vi.hoisted(() => ({
  projection: 'deployment' as 'world' | 'organization' | 'deployment',
  signal: 'type' as 'type' | 'footprint' | 'cost' | 'activity',
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@src/components/graph-view/url-state', () => ({
  useGraphUrlState: () => ({
    state: {
      projection: graphUrlState.projection,
      focus: null,
      selected: null,
      depth: 4,
      signal: graphUrlState.signal,
      hidden: new Set(),
      query: '',
    },
    setState: setUrlState,
  }),
}));
vi.mock('@src/components/graph-view/graph/loadWorldView', () => ({ loadWorldView, refreshWorldView }));
vi.mock('@src/components/graph-view/graph/loadDepGraph', async (importOriginal) => {
  const original = await importOriginal<typeof import('@src/components/graph-view/graph/loadDepGraph')>();
  return { ...original, loadDepGraph: vi.fn(), rebuildDepGraph: vi.fn() };
});
vi.mock('@src/components/graph-view/graph/graphEngine', () => ({
  GraphEngine: class {
    constructor(
      readonly graph: Graph,
      readonly layout?: string,
    ) {
      engineLayouts.push(layout);
      engineRoots.push(graph.nodes()[0] ?? '');
    }
    init() {}
    destroy() {}
    setTheme() {}
    setColorMode(mode: string) {
      engineSignals.push(mode);
    }
    setHiddenTypes() {}
    selectNode() {}
    getNodeData() {
      return null;
    }
    searchNodes() {
      return [];
    }
    setLocalMode() {
      return { root: null, depth: 4, visibleCount: 0 };
    }
    onNodeSelect() {
      return () => {};
    }
    onNodeDoubleClick() {
      return () => {};
    }
  },
}));

function graph(prefix = 'deployment'): Graph {
  const result = new Graph({ type: 'directed' });
  result.addNode(`${prefix}-aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa`, {
    label: 'Deployment WorldView',
    entityType: prefix,
    entityId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
  });
  return result;
}

describe('WorldView refresh', () => {
  afterEach(cleanup);

  beforeEach(() => {
    engineLayouts.length = 0;
    engineSignals.length = 0;
    engineRoots.length = 0;
    graphUrlState.projection = 'deployment';
    graphUrlState.signal = 'type';
    setUrlState.mockReset();
    loadWorldView.mockReset().mockImplementation((projection: string) => Promise.resolve(graph(projection)));
    refreshWorldView.mockReset().mockResolvedValue(graph());
  });

  it('loads one projection and refreshes it only after the explicit action', async () => {
    render(<GraphView surface="worldview" />);

    const button = await screen.findByRole('button', { name: /Refresh/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(loadWorldView).toHaveBeenCalledWith('deployment');
    expect(refreshWorldView).not.toHaveBeenCalled();
    expect(engineLayouts).toEqual(['circle']);

    fireEvent.click(button);

    await waitFor(() => expect(refreshWorldView).toHaveBeenCalledWith('deployment'));
  });

  it('turns the compact color selector into URL-state navigation intent', async () => {
    render(<GraphView surface="worldview" />);
    await screen.findByLabelText('Entity type color legend');

    fireEvent.click(screen.getByRole('button', { name: 'Footprint' }));

    expect(setUrlState).toHaveBeenCalledWith({ signal: 'footprint' });
    expect(engineSignals).toContain('type');
  });

  it('shows neutral unknown coverage when an observation signal has no data', async () => {
    graphUrlState.signal = 'cost';
    render(<GraphView surface="worldview" />);

    const legend = await screen.findByLabelText('Net cost observation color legend');
    expect(legend.textContent).toContain('0/1 coverage');
    expect(legend.textContent).toContain('Unknown · 1');
    expect(engineSignals).toContain('cost');
  });

  it('never renders a completed refresh under a different projection', async () => {
    let resolveRefresh: ((value: Graph) => void) | undefined;
    refreshWorldView.mockReturnValue(
      new Promise<Graph>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const rendered = render(<GraphView surface="worldview" />);
    const button = await screen.findByRole('button', { name: /Refresh/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);
    await waitFor(() => expect(refreshWorldView).toHaveBeenCalledWith('deployment'));

    graphUrlState.projection = 'world';
    rendered.rerender(<GraphView surface="worldview" />);
    await waitFor(() => expect(loadWorldView).toHaveBeenCalledWith('world'));

    await act(() => {
      resolveRefresh?.(graph('stale-refresh'));
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(loadWorldView.mock.calls.filter(([projection]) => projection === 'world')).toHaveLength(2);
    });

    expect(engineRoots).not.toContain('stale-refresh-aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa');
    expect(engineRoots.at(-1)).toBe('world-aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa');
  });
});
