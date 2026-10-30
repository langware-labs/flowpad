/**
 * C4ChartView — RTL coverage, plus the pure c4Model helpers.
 *
 *   1. c4.json elements, boundaries and relations render, with the level and a legend.
 *   2. A box with `ref` shows Open ↗, which opens that chart URL-first (navigation.openDock).
 *      The view has no comment bar and no Convert to Excalidraw.
 *   3. The Table view lists every element and relation.
 *   4. A dynamic chart numbers its relations.
 *   5. layoutC4 puts every card inside its boundary, nested boundaries inside their parent,
 *      and leaves out a boundary with nothing in it.
 *   6. c4ToMermaid writes a flowchart with subgraphs, shapes per kind and async arrows.
 *   7. Every box is a chip with its kind's icon; link chips open project files, data-type chips open
 *      their data_schema; an arrow with `ref` opens the chart it names.
 *   8. Clicking an element opens "Change this", which hands the request to `changes.request`;
 *      queued changes show as numbered marks.
 *   9. Fit / zoom in / zoom out move the canvas viewBox.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openDock, forKind, chartQuery, dataQuery } = vi.hoisted(() => ({
  openDock: vi.fn(),
  forKind: vi.fn(async (): Promise<unknown[]> => []),
  chartQuery: vi.fn(async (): Promise<unknown[]> => []),
  dataQuery: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('@sdk/client', () => ({ default: { get: dataQuery } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock } }),
}));

vi.mock('@sdk', async (orig) => {
  const actual = await orig<typeof import('@sdk')>();
  class ChartStub {
    static type = 'chart';
    static query = chartQuery;
  }
  return { ...actual, Chart: ChartStub, Dataset: { forKind } };
});

// eslint-disable-next-line import/first
import { C4ChartView } from '@src/components/assets/editor/chart/C4ChartView';
// eslint-disable-next-line import/first
import { CHIP_MAX_CHARS, chipText, c4ToMermaid, layoutC4, parseC4, wrap } from '@src/components/assets/editor/chart/c4Model';

const PROJECT = '22222222-2222-4222-8222-222222222222';

const C4 = {
  title: 'Shop — containers',
  level: 'container',
  elements: [
    { id: 'buyer', kind: 'person', label: 'Buyer', description: 'Orders things.' },
    { id: 'web', kind: 'container', label: 'Web app', tech: 'React', boundary: 'shop' },
    { id: 'api', kind: 'container', label: 'API', tech: 'FastAPI', boundary: 'shop', ref: 'shop-api-components' },
    { id: 'db', kind: 'database', label: 'Orders DB', tech: 'Postgres', boundary: 'shop' },
    { id: 'bus', kind: 'queue', label: 'Events', tech: 'Kafka', boundary: 'shop' },
    { id: 'pay', kind: 'system', label: 'Stripe', external: true },
  ],
  boundaries: [
    { id: 'shop', label: 'Shop', kind: 'system' },
    { id: 'empty', label: 'Nothing here', kind: 'zone' },
  ],
  relations: [
    { id: 'r1', from: 'buyer', to: 'web', label: 'Uses', tech: 'HTTPS' },
    { id: 'r2', from: 'web', to: 'api', label: 'Calls', tech: 'JSON' },
    { id: 'r3', from: 'api', to: 'db', label: 'Reads and writes' },
    { id: 'r4', from: 'api', to: 'bus', label: 'Publishes order events', style: 'async' },
    { id: 'r5', from: 'api', to: 'pay', label: 'Charges card' },
  ],
};

function makeFsRef(files: Record<string, string>) {
  return {
    path: '/w/p/agentic-assets/chart/shop-containers',
    child(name: string) {
      return {
        path: `/w/p/agentic-assets/chart/shop-containers/${name}`,
        readIfExists: async () => files[name] ?? null,
        write: vi.fn(async () => {}),
      };
    },
    open: vi.fn(),
  } as unknown as import('@sdk').FSRef;
}

const chart = {
  name: 'shop-containers',
  scope: 'project-1',
  typeId: { toString: () => 'chart-11111111-1111-4111-8111-111111111111' },
} as unknown as import('@sdk').Chart;

function renderView(value: unknown = C4, changes?: import('@src/components/assets/editor/chart/chartControls').ChartChanges) {
  return render(
    <MemoryRouter>
      <C4ChartView fsRef={makeFsRef({ 'c4.json': JSON.stringify(value) })} chart={chart} projectId={PROJECT} changes={changes} />
    </MemoryRouter>,
  );
}

const RICH = {
  level: 'code',
  elements: [
    {
      id: 'engine', kind: 'code', label: 'PricingEngine', tech: 'class',
      inputs: [{ name: 'cart', kind: 'shop.cart' }], returns: 'shop.price_quote',
      links: [{ label: 'PricingEngine.kt', href: 'src/pricing/PricingEngine.kt:12' }],
    },
    { id: 'fn', kind: 'function', label: 'apply-coupon' },
  ],
  boundaries: [],
  relations: [{ id: 'r1', from: 'engine', to: 'fn', label: 'Applies', data: 'shop.coupon', ref: 'coupon-flow' }],
};

describe('C4ChartView', () => {
  beforeEach(() => {
    openDock.mockClear();
    chartQuery.mockClear();
  });

  it('draws elements, the drawn boundary, relations, the level and a legend', async () => {
    renderView();
    await screen.findByTestId('chart-c4-svg');
    expect(screen.getAllByTestId('chart-c4-element')).toHaveLength(6);
    expect(screen.getAllByTestId('chart-c4-boundary')).toHaveLength(1); // the empty one is left out
    expect(screen.getAllByTestId('chart-c4-relation')).toHaveLength(5);
    expect(screen.getByTestId('chart-c4-level').textContent).toBe('container');
    const svgText = screen.getByTestId('chart-c4-svg').textContent ?? '';
    expect(svgText).toContain('Container · FastAPI');
    expect(svgText).toContain('External system');
    const legend = screen.getByTestId('chart-c4-legend').textContent ?? '';
    expect(legend).toContain('Person');
    expect(legend).toContain('Database');
    expect(legend).toContain('async');
  });

  it('Open ↗ on a box opens the chart it names', async () => {
    chartQuery.mockResolvedValueOnce([{ name: 'shop-api-components', asset_ref: '/w/p/agentic-assets/chart/shop-api-components' }]);
    renderView();
    const opens = await screen.findAllByTestId('chart-c4-open');
    expect(opens).toHaveLength(1);
    fireEvent.click(opens[0]);
    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    const pointer = (openDock.mock.calls[0] as unknown[])[0] as { pointer: string };
    expect(pointer.pointer).toContain('agentic-assets/chart/shop-api-components');
  });

  it('has no comment bar and no Convert to Excalidraw', async () => {
    renderView();
    await screen.findByTestId('chart-c4-svg');
    expect(screen.queryByTestId('chart-feedback-open')).toBeNull();
    expect(screen.queryByTestId('chart-convert-excalidraw')).toBeNull();
  });

  it('the Table view lists every element and relation', async () => {
    renderView();
    fireEvent.click(await screen.findByTestId('chart-view-table'));
    const rows = screen.getAllByTestId('chart-table-row');
    expect(rows).toHaveLength(6 + 5);
    expect(rows.map((r) => r.textContent).join('|')).toContain('Publishes order events (async)');
    expect(screen.queryByTestId('chart-c4-svg')).toBeNull();
  });

  it('numbers relations on a dynamic chart', async () => {
    renderView({ ...C4, level: 'dynamic' });
    await screen.findByTestId('chart-c4-svg');
    const r1 = screen.getAllByTestId('chart-c4-relation')[0];
    expect(r1.querySelector('.num')?.textContent).toBe('1');
  });
});

describe('C4ChartView — chips, links, calls, changes, zoom', () => {
  beforeEach(() => {
    openDock.mockClear();
    chartQuery.mockClear();
    dataQuery.mockClear();
  });

  it('gives every box its kind and an icon', async () => {
    renderView(RICH);
    const cards = await screen.findAllByTestId('chart-c4-element');
    expect(cards.map((c) => c.getAttribute('data-kind'))).toEqual(['code', 'function']);
    cards.forEach((c) => expect(c.querySelector('foreignObject')).not.toBeNull());
  });

  it('a link chip opens the project file it names', async () => {
    renderView(RICH);
    fireEvent.click(await screen.findByTestId('chart-c4-link'));
    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    const pointer = (openDock.mock.calls[0] as unknown[])[0] as { pointer: string };
    expect(pointer.pointer).toContain('w/p/src/pricing/PricingEngine.kt');
    expect(pointer.pointer).not.toContain(':12');
  });

  it('a data-type chip opens the data_schema of that kind', async () => {
    dataQuery.mockResolvedValueOnce([{ id: '33333333-3333-4333-8333-333333333333', asset_ref: '/w/p/agentic-assets/data_schema/shop.cart' }]);
    renderView(RICH);
    const types = await screen.findAllByTestId('chart-c4-type');
    expect(types).toHaveLength(3); // cart, returns, the arrow's data
    fireEvent.click(types.find((c) => c.textContent?.includes('cart: shop.cart'))!);
    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    const path = decodeURIComponent((dataQuery.mock.calls[0] as unknown[])[0] as string);
    expect(path).toContain('/graph/data_schema?');
    expect(path).toContain('shop.cart');
    const pointer = (openDock.mock.calls[0] as unknown[])[0] as { pointer: string };
    expect(pointer.pointer).toContain('data_schema-33333333-3333-4333-8333-333333333333');
  });

  it('an arrow with ref opens the chart it calls', async () => {
    chartQuery.mockResolvedValueOnce([{ name: 'coupon-flow', asset_ref: '/w/p/agentic-assets/chart/coupon-flow' }]);
    renderView(RICH);
    const rel = await screen.findByTestId('chart-c4-relation');
    fireEvent.click(rel.querySelector('[data-testid="chart-c4-open"]')!);
    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
  });

  it('clicking an element asks for a change and queued changes show as marks', async () => {
    const request = vi.fn();
    renderView(C4, { request, marks: new Map([['db · Orders DB', [1, 2]]]) });
    expect(await screen.findAllByTestId('chart-change-mark')).toHaveLength(1);
    const api = screen.getAllByTestId('chart-c4-element').find((c) => c.textContent?.includes('API'))!;
    fireEvent.click(api);
    fireEvent.change(await screen.findByTestId('chart-change-text'), { target: { value: 'Split into two services' } });
    fireEvent.click(screen.getByTestId('chart-change-run'));
    expect(request).toHaveBeenCalledWith({ quote: 'api · API', instruction: 'Split into two services', runNow: true });
    expect(screen.queryByTestId('chart-change-box')).toBeNull();
  });

  it('without a changes handler a click opens nothing', async () => {
    renderView(C4);
    fireEvent.click((await screen.findAllByTestId('chart-c4-element'))[0]);
    expect(screen.queryByTestId('chart-change-box')).toBeNull();
    expect(screen.queryByTestId('chart-change-whole')).toBeNull();
  });

  it('zoom in, zoom out and Fit move the canvas', async () => {
    renderView();
    const svg = await screen.findByTestId('chart-c4-svg');
    const fit = svg.getAttribute('viewBox');
    fireEvent.click(screen.getByTestId('chart-zoom-in'));
    expect(svg.getAttribute('viewBox')).not.toBe(fit);
    expect(svg.getAttribute('data-zoomed')).toBe('true');
    fireEvent.click(screen.getByTestId('chart-zoom-fit'));
    expect(svg.getAttribute('viewBox')).toBe(fit);
  });
});

describe('c4Model', () => {
  it('lays every card inside its boundary and an inner boundary inside its parent, and sibling boundaries apart', async () => {
    const value = parseC4(
      JSON.stringify({
        level: 'deployment',
        elements: [
          { id: 'a', kind: 'container', label: 'A', boundary: 'pod' },
          { id: 'b', kind: 'database', label: 'B', boundary: 'region' },
          { id: 'c', kind: 'container', label: 'C', boundary: 'pod2' },
        ],
        boundaries: [
          { id: 'region', label: 'eu-west-1', kind: 'deployment' },
          { id: 'pod', label: 'EKS pod', kind: 'deployment', parent: 'region' },
          { id: 'region2', label: 'us-east-1', kind: 'deployment' },
          { id: 'pod2', label: 'EKS pod', kind: 'deployment', parent: 'region2' },
        ],
        relations: [
          { id: 'r', from: 'a', to: 'b', label: 'SQL' },
          { id: 'r2', from: 'c', to: 'b', label: 'Replicates' },
        ],
      }),
    );
    const out = await layoutC4(value);
    const inside = (i: { x: number; y: number; w: number; h: number }, o: typeof i) =>
      i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
    const region = out.boxOf.get('region')!;
    const pod = out.boxOf.get('pod')!;
    expect(inside(out.cardOf.get('a')!, pod)).toBe(true);
    expect(inside(out.cardOf.get('b')!, region)).toBe(true);
    expect(inside(pod, region)).toBe(true);
    const r2 = out.boxOf.get('region2')!;
    const overlap = region.x < r2.x + r2.w && r2.x < region.x + region.w && region.y < r2.y + r2.h && r2.y < region.y + region.h;
    expect(overlap).toBe(false);
    expect(out.edges[0].d).toMatch(/^M/);
  });

  it('reads an unreadable file as an empty context chart', () => {
    expect(parseC4('not json')).toEqual({ title: undefined, level: 'context', direction: undefined, elements: [], boundaries: [], relations: [] });
  });

  it('a chip shows its whole label unless it is longer than the widest chip', () => {
    expect(chipText('PricingEngine.kt')).toBe('PricingEngine.kt');
    const long = 'x'.repeat(CHIP_MAX_CHARS + 5);
    expect(chipText(long)).toHaveLength(CHIP_MAX_CHARS);
    expect(chipText(long).endsWith('…')).toBe(true);
  });

  it('wraps to a line limit and marks the cut with an ellipsis at a word end', () => {
    expect(wrap('one two three four five six', 9, 2)).toEqual(['one two', 'three…']);
  });

  it('writes a flowchart with subgraphs, a shape per kind and dashed async arrows', () => {
    const m = c4ToMermaid(parseC4(JSON.stringify(C4)));
    expect(m.startsWith('flowchart LR\n')).toBe(true);
    expect(m).toContain('buyer(["Buyer<br/>[Person]"])');
    expect(m).toContain('subgraph b_shop["Shop [system]"]');
    expect(m).toContain('db[("Orders DB<br/>[Database · Postgres]")]');
    expect(m).toContain('bus[["Events<br/>[Queue · Kafka]"]]');
    expect(m).toContain('api -.->|"Publishes order events"| bus');
    expect(m).toContain('class pay external');
    expect(m).not.toContain('Nothing here');
  });
});
