import Graph from 'graphology';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GraphView } from '@src/components/graph-view/GraphView';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadWorldView = vi.hoisted(() => vi.fn());
const syncWorldView = vi.hoisted(() => vi.fn());
const setUrlState = vi.hoisted(() => vi.fn());
const engineLayouts = vi.hoisted(() => [] as Array<string | undefined>);
const engineColorModes = vi.hoisted(() => [] as string[]);
const graphUrlState = vi.hoisted(() => ({ color: 'type' as 'type' | 'footprint' | 'cost' | 'activity' }));

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@src/components/graph-view/url-state', () => ({
  useGraphUrlState: () => ({
    state: { local: null, selected: null, depth: 0, color: graphUrlState.color },
    setState: setUrlState,
  }),
}));
vi.mock('@src/components/graph-view/graph/loadWorldView', () => ({ loadWorldView, syncWorldView }));
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
    }
    init() {}
    destroy() {}
    setTheme() {}
    setColorMode(mode: string) {
      engineColorModes.push(mode);
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
      return { root: null, depth: 6, visibleCount: 0 };
    }
    onNodeSelect() {
      return () => {};
    }
    onNodeDoubleClick() {
      return () => {};
    }
  },
}));

function graph(): Graph {
  const result = new Graph({ type: 'directed' });
  result.addNode('deployment-aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa', {
    label: 'Cloud WorldView',
    entityType: 'deployment',
    entityId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
  });
  return result;
}

describe('WorldView explicit sync', () => {
  afterEach(cleanup);

  beforeEach(() => {
    engineLayouts.length = 0;
    engineColorModes.length = 0;
    graphUrlState.color = 'type';
    setUrlState.mockReset();
    loadWorldView.mockReset().mockResolvedValue(graph());
    syncWorldView.mockReset().mockResolvedValue(graph());
  });

  it('loads locally on mount and invokes cloud sync only after clicking Sync', async () => {
    render(<GraphView surface="worldview" />);

    const button = await screen.findByRole('button', { name: /Sync/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(loadWorldView).toHaveBeenCalledTimes(1);
    expect(syncWorldView).not.toHaveBeenCalled();
    expect(engineLayouts).toEqual(['force']);

    fireEvent.click(button);

    await waitFor(() => expect(syncWorldView).toHaveBeenCalledTimes(1));
  });

  it('turns the compact color selector into URL-state navigation intent', async () => {
    render(<GraphView surface="worldview" />);
    await screen.findByLabelText('Entity type color legend');

    fireEvent.click(screen.getByRole('button', { name: 'Footprint' }));

    expect(setUrlState).toHaveBeenCalledWith({ color: 'footprint' });
    expect(engineColorModes).toContain('type');
  });

  it('shows neutral unknown coverage when an observation mode has no data', async () => {
    graphUrlState.color = 'cost';
    render(<GraphView surface="worldview" />);

    const legend = await screen.findByLabelText('Net cost observation color legend');
    expect(legend.textContent).toContain('0/1 coverage');
    expect(legend.textContent).toContain('Unknown · 1');
    expect(engineColorModes).toContain('cost');
  });
});
