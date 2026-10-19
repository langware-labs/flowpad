/**
 * The Charts root of the project navigator reads as a tree: charts grouped by
 * the folder they live in (minus `agentic-assets/chart`), the non-chart assets
 * whose flow.json declares charts as their own rows, and a chart's own flow.json
 * charts nested under it — with a cycle guard.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DependencyDeclarer } from '@sdk';
import type { SearchResult } from '@src/hooks/use-asset-search';
import type { Browseable } from '@src/components/browseable-tree/types';

vi.mock('@sdk/client', () => ({ default: { get: vi.fn(), delete: vi.fn() } }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dataManager: { getAllTypeInfos: () => [{ type_name: 'chart', shape: { kind: 'file', ext: '.md' } }] },
}));

const { chartsRoot, chartFolderSegments } = await import('@src/components/browseable-tree/adapters/chartsRoot');

const ROOT = '/w/proj';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (type: string, n: number, ref: string, name: string): SearchResult =>
  ({ record_id: uuid(n), record_type: type, name, asset_ref: ref, scope: 'project', snippet: null, status: '', created_at: '', modified_at: '' }) as SearchResult;
const tid = (type: string, n: number) => `${type}-${uuid(n)}`;
const declarer = (type: string, n: number, name: string, path: string, charts: number[]): DependencyDeclarer => ({
  asset: tid(type, n),
  name,
  type,
  path,
  label: null,
  via_path: [],
  dependencies: charts.map((c) => ({ key: `k${c}`, source: tid('chart', c), typeid: tid('chart', c), name: `k${c}`, state: 'ready' })),
});

const overview = row('chart', 1, `${ROOT}/agentic-assets/chart/overview`, 'overview');
const hue = row('chart', 2, `${ROOT}/agentic-assets/chart/hue`, 'hue');
const shared = row('chart', 3, `${ROOT}/agentic-assets/chart/proxy-hop`, 'proxy-hop');
const docsChart = row('chart', 4, `${ROOT}/docs/network/spora-net/CHART.md`, 'spora-net');

const declarers: DependencyDeclarer[] = [
  declarer('chart', 1, 'overview', 'agentic-assets/chart/overview', [2, 3]),
  declarer('chart', 2, 'hue', 'agentic-assets/chart/hue', [3, 1]), // 1 is an ancestor: cycle
  declarer('credential', 9, 'philips-hue', 'agentic-assets/credential/philips-hue', [2]),
];

function makeRoot() {
  return chartsRoot(
    { type_name: 'chart', label: 'Charts', icon: null, creatable: true, browseable_by: 'standard' },
    {
      indexType: () => Promise.resolve(),
      projectRoot: ROOT,
      loadDeclarers: () => Promise.resolve(declarers),
      listCharts: () => Promise.resolve([overview, hue, shared, docsChart]),
    },
  );
}

const labels = (rows: Browseable[]) => rows.map((r) => r.label);

describe('chartsRoot', () => {
  it('folders: drops agentic-assets/chart, keeps docs/… folders', () => {
    expect(chartFolderSegments(overview.asset_ref, ROOT)).toEqual([]);
    expect(chartFolderSegments(docsChart.asset_ref, ROOT)).toEqual(['docs', 'network']);
    expect(chartFolderSegments('/elsewhere/agentic-assets/chart/x', ROOT)).toEqual([]);
  });

  it('lists folders first, then charts, then the parent assets', async () => {
    const top = await makeRoot().listChildren!();
    expect(labels(top)).toEqual(['docs', 'hue', 'overview', 'proxy-hop', 'philips-hue']);
    const docs = top[0];
    const network = (await docs.listChildren!())[0];
    expect(network.label).toBe('network');
    expect(labels(await network.listChildren!())).toEqual(['spora-net']);
  });

  it('a parent asset nests its declared charts and opens its own editor', async () => {
    const top = await makeRoot().listChildren!();
    const cred = top.find((r) => r.label === 'philips-hue')!;
    expect(cred.selectionKey).toBe(tid('credential', 9));
    expect(cred.pointer?.pointer).toContain('editor/credential/');
    const kids = await cred.listChildren!();
    expect(labels(kids)).toEqual(['hue']);
    expect(kids[0].selectionKey).toBe(tid('chart', 2));
  });

  it('nests sub-flow charts, the same entity under each parent; a non-declarer has no chevron', async () => {
    const top = await makeRoot().listChildren!();
    const ov = top.find((r) => r.label === 'overview')!;
    const kids = await ov.listChildren!();
    expect(labels(kids)).toEqual(['hue', 'proxy-hop']);
    expect(new Set([...top, ...kids].map((r) => r.id)).size).toBe(top.length + kids.length);
    const hueKids = await kids[0].listChildren!();
    // proxy-hop again (shared), but not overview: it is an ancestor.
    expect(labels(hueKids)).toEqual(['proxy-hop']);
    expect(hueKids[0].selectionKey).toBe(kids[1].selectionKey);
    expect(hueKids[0].hasChildren).toBe(false);
  });

  it('pathFor walks root › folders › chart for a chart under docs/', async () => {
    const root = makeRoot();
    const { DockPointer } = await import('@src/navigation/DockPointer');
    const chain = await root.pathFor(DockPointer.forAssetEditor('chart', docsChart.asset_ref.replace('/CHART.md', '')));
    expect(chain.map((n) => n.id)).toEqual([
      root.id,
      'charts-folder:docs',
      'charts-folder:docs/network',
      'asset:chart:w/proj/docs/network/spora-net',
    ]);
  });

  it('owns a chart opened on the project page, and the deep-link folders list real rows', async () => {
    const root = makeRoot();
    const { DockPointer } = await import('@src/navigation/DockPointer');
    const { ViewType } = await import('@src/types/ViewType');
    const editor = DockPointer.forAssetEditor('chart', docsChart.asset_ref);
    const onProject = new DockPointer(ViewType.PROJECT, `p1/${editor.pointer}`);
    expect(root.ownsPointer(onProject)).toBe(true);
    const chain = await root.pathFor(onProject);
    expect(chain.map((n) => n.id).slice(1, 3)).toEqual(['charts-folder:docs', 'charts-folder:docs/network']);
    expect(labels(await chain[2].listChildren!())).toEqual(['spora-net']);
  });
});
