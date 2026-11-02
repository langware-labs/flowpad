/**
 * ArchitectureChartView — RTL coverage, plus the pure architectureModel helpers.
 *
 *   1. Groups, tiers, parts (with their role) and labelled links render, with a role legend.
 *   2. A step badge opens the steps list with that step highlighted; a second click closes it.
 *   3. A part with `ref` shows Open ↗, which opens that chart URL-first (navigation.openDock).
 *   4. The Table view lists every part (with where it sits) and every link.
 *   5. Clicking a part opens "Change this", which hands the request to `changes.request`.
 *   6. layoutArchitecture puts groups left to right, tiers inside their group and parts inside their tier.
 *   7. architectureToMermaid writes subgraphs, db shapes and dashed / two-way arrows.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openDock, chartQuery } = vi.hoisted(() => ({
  openDock: vi.fn(),
  chartQuery: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
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
  return { ...actual, Chart: ChartStub };
});

import { ArchitectureChartView } from '@src/components/assets/editor/chart/ArchitectureChartView';
import {
  architectureToMermaid,
  layoutArchitecture,
  parseArchitecture,
} from '@src/components/assets/editor/chart/architectureModel';

const PROJECT = '22222222-2222-4222-8222-222222222222';

const ARCH = {
  title: 'Shop — where it runs',
  groups: [
    {
      id: 'device',
      label: 'Device',
      tiers: [{ id: 'clients', label: 'Clients', parts: [{ id: 'app', label: 'Shop app', sublabel: 'Flutter', role: 'client', step: 1 }] }],
    },
    {
      id: 'cloud',
      label: 'Cloud',
      sublabel: 'eu-west-1',
      tiers: [
        {
          id: 'svc',
          label: 'Services',
          parts: [
            { id: 'api', label: 'API', sublabel: 'FastAPI', role: 'service', step: 2, ref: 'shop-api-inside' },
            { id: 'jobs', label: 'Jobs', role: 'worker' },
          ],
        },
        { id: 'stores', label: 'Stores', parts: [{ id: 'db', label: 'Orders DB', sublabel: 'Postgres', role: 'db' }] },
      ],
    },
    { id: 'outside', label: 'Outside', parts: [{ id: 'pay', label: 'Stripe', role: 'external' }] },
  ],
  links: [
    { from: 'app', to: 'api', label: 'REST' },
    { from: 'svc', to: 'stores', label: 'read / write', both: true },
    { from: 'api', to: 'pay', label: 'charges', style: 'dashed' },
  ],
  steps: [
    { n: 2, text: 'The API stores the order.' },
    { n: 1, text: 'The app sends the order.' },
  ],
};

function makeFsRef(files: Record<string, string>) {
  return {
    path: '/w/p/agentic-assets/chart/shop-arch',
    child(name: string) {
      return {
        path: `/w/p/agentic-assets/chart/shop-arch/${name}`,
        readIfExists: () => Promise.resolve(files[name] ?? null),
        write: vi.fn(() => Promise.resolve()),
      };
    },
    open: vi.fn(),
  } as unknown as import('@sdk').FSRef;
}

const chart = {
  name: 'shop-arch',
  scope: 'project-1',
  typeId: { toString: () => 'chart-11111111-1111-4111-8111-111111111111' },
} as unknown as import('@sdk').Chart;

function renderView(value: unknown = ARCH, changes?: import('@src/components/assets/editor/chart/chartControls').ChartChanges) {
  return render(
    <MemoryRouter>
      <ArchitectureChartView fsRef={makeFsRef({ 'architecture.json': JSON.stringify(value) })} chart={chart} projectId={PROJECT} changes={changes} />
    </MemoryRouter>,
  );
}

describe('ArchitectureChartView', () => {
  beforeEach(() => {
    openDock.mockClear();
    chartQuery.mockClear();
  });

  it('draws groups, tiers, parts with their role, labelled links and a role legend', async () => {
    renderView();
    await screen.findByTestId('chart-architecture-svg');
    expect(screen.getAllByTestId('chart-architecture-group')).toHaveLength(3);
    expect(screen.getAllByTestId('chart-architecture-tier')).toHaveLength(4); // Outside's parts sit in an untitled tier
    const parts = screen.getAllByTestId('chart-architecture-part');
    expect(parts.map((p) => p.getAttribute('data-role'))).toEqual(['client', 'service', 'worker', 'db', 'external']);
    expect(screen.getAllByTestId('chart-architecture-link')).toHaveLength(3);
    const svgText = screen.getByTestId('chart-architecture-svg').textContent ?? '';
    expect(svgText).toContain('read / write');
    expect(svgText).toContain('eu-west-1');
    const legend = screen.getByTestId('chart-architecture-legend').textContent ?? '';
    for (const role of ['client', 'service', 'db', 'external']) expect(legend).toContain(role);
    expect(screen.getByTestId('chart-architecture-summary').textContent).toContain('5 parts · 3 links · 2 steps');
  });

  it('a step badge opens the steps list with that step lit, a second click closes it', async () => {
    renderView();
    const badges = await screen.findAllByTestId('chart-architecture-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['1', '2']);
    expect(screen.queryByTestId('chart-architecture-steps')).toBeNull();
    fireEvent.click(badges[1]);
    const steps = screen.getAllByTestId('chart-architecture-step');
    expect(steps.map((s) => s.textContent)).toEqual(['1The app sends the order.', '2The API stores the order.']);
    expect(steps[1].getAttribute('data-on')).toBe('true');
    fireEvent.click(screen.getAllByTestId('chart-architecture-badge')[1]);
    expect(screen.queryByTestId('chart-architecture-steps')).toBeNull();
  });

  it('Open ↗ on a part opens the chart it names', async () => {
    chartQuery.mockResolvedValueOnce([{ name: 'shop-api-inside', asset_ref: '/w/p/agentic-assets/chart/shop-api-inside' }]);
    renderView();
    const opens = await screen.findAllByTestId('chart-architecture-open');
    expect(opens).toHaveLength(1);
    fireEvent.click(opens[0]);
    await waitFor(() => expect(openDock).toHaveBeenCalledTimes(1));
    const pointer = (openDock.mock.calls[0] as unknown[])[0] as { pointer: string };
    expect(pointer.pointer).toContain('agentic-assets/chart/shop-api-inside');
  });

  it('the Table view lists every part with where it sits, and every link', async () => {
    renderView();
    fireEvent.click(await screen.findByTestId('chart-view-table'));
    const rows = screen.getAllByTestId('chart-table-row').map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(5 + 3);
    expect(rows.join('|')).toContain('Cloud › Services');
    expect(rows.join('|')).toContain('charges (dashed)');
    expect(screen.queryByTestId('chart-architecture-svg')).toBeNull();
  });

  it('clicking a part opens Change this, which hands the request on', async () => {
    const request = vi.fn();
    renderView(ARCH, { marks: new Map(), request });
    const parts = await screen.findAllByTestId('chart-architecture-part');
    fireEvent.click(parts[3], { clientX: 10, clientY: 10 });
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'make it Postgres 16' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0][0].quote).toBe('db · Orders DB');
  });
});

describe('architectureModel', () => {
  it('lays groups out left to right, tiers inside their group, parts inside their tier', () => {
    const layout = layoutArchitecture(parseArchitecture(JSON.stringify(ARCH)));
    const [a, b, c] = layout.groups;
    expect(a.x + a.w).toBeLessThan(b.x);
    expect(b.x + b.w).toBeLessThan(c.x);
    const inside = (o: { x: number; y: number; w: number; h: number }, i: { x: number; y: number; w: number; h: number }) =>
      i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
    const cloud = layout.boxOf.get('cloud')!;
    expect(inside(cloud, layout.boxOf.get('svc')!)).toBe(true);
    expect(inside(cloud, layout.boxOf.get('stores')!)).toBe(true);
    expect(inside(layout.boxOf.get('svc')!, layout.boxOf.get('api')!)).toBe(true);
    expect(layout.links).toHaveLength(3);
  });

  it('a link naming nothing is dropped; a broken file parses to nothing but never throws past JSON', () => {
    const v = parseArchitecture(JSON.stringify({ groups: [], links: [{ from: 'a', to: 'b' }, { from: 'a' }] }));
    expect(v.links).toHaveLength(1);
    expect(layoutArchitecture(v).links).toHaveLength(0);
    expect(parseArchitecture(null).groups).toEqual([]);
  });

  it('writes the Mermaid copy with subgraphs, db shapes and dashed / two-way arrows', () => {
    const mm = architectureToMermaid(parseArchitecture(JSON.stringify(ARCH)));
    expect(mm.startsWith('flowchart LR')).toBe(true);
    expect(mm).toContain('subgraph cloud["Cloud"]');
    expect(mm).toContain('subgraph svc["Services"]');
    expect(mm).toContain('db[("Orders DB<br/>Postgres")]');
    expect(mm).toContain('svc <-->|"read / write"| stores');
    expect(mm).toContain('api -.->|"charges"| pay');
    expect(mm).toContain('app["1. Shop app<br/>Flutter"]');
  });
});
