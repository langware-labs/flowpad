import React from 'react';
import { Folder } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import { resultTypeId } from '@src/navigation/record-type-nav';
import { ViewType } from '@src/types/ViewType';
import { TypeId, type DependencyDeclarer } from '@sdk';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';
import type { SearchResult } from '@src/hooks/use-asset-search';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';
import { DEFAULT_ASSET_FILTER } from '@src/components/assets/assetFilter';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { EntityIcon } from '@src/components/graph-view/ui/EntityIcon';
import { assetRowOpen } from '../open';
import {
  assetTypeRoot,
  buildAssetChild,
  fetchAssetsOfType,
  parseAssetPointer,
  type AssetTypeRootDeps,
} from './assetTypeRoot';

const CHART = 'chart';

export interface ChartsRootDeps extends AssetTypeRootDeps {
  /** The scoped project's folder (`fs_storage_mount_path`); chart folders are shown relative to it. */
  projectRoot: string;
  /** Every asset of the project whose own flow.json declares entries, each with its direct
   *  entries, not deduped (`project.dependencies({ declarers: true })`). */
  loadDeclarers: () => Promise<DependencyDeclarer[]>;
  /** The charts — injectable for tests; defaults to the `/search` the type roots use. */
  listCharts?: () => Promise<SearchResult[]>;
}

const trimSlashes = (p: string) => p.replace(/^\/+|\/+$/g, '');

/**
 * The folders a chart sits under, relative to the project: the asset's own folder is the
 * chart, so its parents are the folders — minus the `agentic-assets/chart` placement, where
 * a chart lives naturally (`docs/network/hue` → [docs, network]; `agentic-assets/chart/hue`
 * → []). A chart outside the project sits directly under Charts.
 */
export function chartFolderSegments(assetRef: string, projectRoot: string): string[] {
  const ref = trimSlashes(assetRef).replace(/\/CHART\.md$/i, '');
  const root = trimSlashes(projectRoot);
  if (!root || !ref.startsWith(`${root}/`)) return [];
  const segments = ref.slice(root.length + 1).split('/').slice(0, -1);
  const at = segments.findIndex((s, i) => s === 'agentic-assets' && segments[i + 1] === CHART);
  if (at >= 0) segments.splice(at, 2);
  return segments;
}

/** A project page's asset sub-pointer (`editor/chart/…`); null for any other view. */
const projectAssetPointer = (p: DockPointer): string | null =>
  p.viewType === ViewType.PROJECT ? DockPointer.splitProjectPointer(p.pointer).assetSubPointer || null : null;

const isChartTypeId = (typeid: string | null | undefined): typeid is string => !!typeid?.startsWith(`${CHART}-`);

/**
 * The Charts root of the project navigator: every chart of the project, grouped into the
 * folders it lives in, then every NON-chart asset whose flow.json declares charts (a
 * credential's connection chart) with those charts under it. A chart's own flow.json charts
 * nest under it, so a set reads as a tree (overview › vendor › shared sub-flows); a shared
 * chart appears under each parent, the same entity each time.
 *
 * Every row opens the asset's own editor through its pointer (URL-first), and selection
 * matches on the typeid, so whichever occurrence is on screen highlights.
 */
export function chartsRoot(type: AssetTypeInfo, deps: ChartsRootDeps): BrowseableRoot {
  const base = assetTypeRoot(type, deps);
  const rootId = base.id;
  const filter = deps.filter ?? DEFAULT_ASSET_FILTER;
  const limit = deps.childrenPageSize ?? 200;
  const listCharts = deps.listCharts ?? (() => fetchAssetsOfType(CHART, filter, limit));
  const onAfterDelete = () => {
    refreshNode(rootId);
    deps.onDeleteComplete?.(CHART);
  };

  // Charts by typeid, filled by the root's listing; nested rows are built from it.
  let charts = new Map<string, SearchResult>();
  const loadCharts = async () => {
    const results = await listCharts();
    charts = new Map();
    for (const r of results) {
      const id = resultTypeId(r)?.toString();
      if (id && !charts.has(id)) charts.set(id, r);
    }
    return charts;
  };

  // Declared chart entries by declaring asset typeid, filled by the root's listing.
  let declared = new Map<string, string[]>();

  /** A chart row at `id`. `ancestry` = the typeids above it, so a flow.json cycle stops. */
  const chartNode = (r: SearchResult, id: string, ancestry: ReadonlySet<string>): Browseable => {
    const node = { ...buildAssetChild(CHART, r, false, rootId, onAfterDelete), id };
    const self = node.selectionKey;
    if (!self || !declared.get(self)?.length) return node;
    const below = new Set(ancestry).add(self);
    return { ...node, hasChildren: true, listChildren: () => Promise.resolve(chartChildren(self, id, below)) };
  };

  /** The charts one asset's own flow.json lists, as rows under `parentId`. */
  const chartChildren = (assetTypeId: string, parentId: string, ancestry: ReadonlySet<string>): Browseable[] =>
    (declared.get(assetTypeId) ?? []).flatMap((typeid) => {
      const r = ancestry.has(typeid) ? undefined : charts.get(typeid);
      return r ? [chartNode(r, `${parentId}>${typeid}`, ancestry)] : [];
    });

  /** Reads the declarers: chart entries per asset, and a row for each NON-chart declarer. */
  const loadDeclared = async (): Promise<DependencyDeclarer[]> => {
    let declarers: DependencyDeclarer[] = [];
    try {
      declarers = await deps.loadDeclarers();
    } catch {
      /* no declarers: charts still list, unnested */
    }
    declared = new Map();
    for (const d of declarers) {
      const ids = [...new Set(d.dependencies.map((e) => e.typeid).filter(isChartTypeId))];
      if (d.asset && ids.length) declared.set(d.asset, ids);
    }
    return declarers;
  };

  const parentNode = (d: DependencyDeclarer): Browseable | null => {
    const typeid = d.asset;
    const type = d.type;
    if (!typeid || !type || type === CHART || !declared.has(typeid)) return null;
    const id = `charts-parent:${typeid}`;
    const ref = d.path ? `${trimSlashes(deps.projectRoot)}/${trimSlashes(d.path)}` : '';
    return {
      id,
      kind: 'asset',
      label: d.name,
      icon: <EntityIcon type={type} density="compact" className="h-3.5 w-3.5 flex-shrink-0" />,
      hasChildren: true,
      ...assetRowOpen(
        { record_id: typeid, record_type: type, asset_ref: ref },
        DockPointer.forAssetEditorByTypeId(type, new TypeId(typeid)),
      ),
      selectionKey: typeid,
      listChildren: () => Promise.resolve(chartChildren(typeid, id, new Set([typeid]))),
    };
  };

  const folderNode = (path: string[], children: Browseable[]): Browseable => ({
    id: folderId(path),
    kind: 'folder',
    label: path[path.length - 1],
    icon: <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />,
    hasChildren: children.length > 0,
    pointer: null,
    listChildren: () => Promise.resolve(children),
  });
  const folderId = (path: string[]) => `charts-folder:${path.join('/')}`;
  const topId = (r: SearchResult) => `asset:${CHART}:${trimSlashes(r.asset_ref ?? '')}`;

  /** Folders first, then charts, at every level — built from the folder segments. */
  const groupByFolder = (results: SearchResult[]): Browseable[] => {
    interface Level {
      folders: Map<string, Level>;
      charts: SearchResult[];
    }
    const top: Level = { folders: new Map(), charts: [] };
    for (const r of results) {
      let level = top;
      for (const seg of chartFolderSegments(r.asset_ref ?? '', deps.projectRoot)) {
        let next = level.folders.get(seg);
        if (!next) level.folders.set(seg, (next = { folders: new Map(), charts: [] }));
        level = next;
      }
      level.charts.push(r);
    }
    const build = (level: Level, path: string[]): Browseable[] => [
      ...[...level.folders.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([seg, sub]) => folderNode([...path, seg], build(sub, [...path, seg]))),
      ...level.charts
        .map((r) => chartNode(r, topId(r), new Set()))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    return build(top, []);
  };

  // The last listing, so a deep-link's folder rows expand to the same children the root shows.
  let listing: Promise<Browseable[]> | null = null;
  const listRoot = () =>
    (listing = Promise.all([loadCharts(), loadDeclared()]).then(([loaded, declarers]) => [
      ...groupByFolder([...loaded.values()]),
      ...declarers
        .map(parentNode)
        .filter((n): n is Browseable => n !== null)
        .sort((a, b) => a.label.localeCompare(b.label)),
    ]));
  const folderChildren = async (path: string[]): Promise<Browseable[]> => {
    let rows = await (listing ?? listRoot());
    for (let i = 0; i < path.length; i++) {
      const folder = rows.find((r) => r.id === folderId(path.slice(0, i + 1)));
      rows = (await folder?.listChildren?.()) ?? [];
    }
    return rows;
  };

  const root: BrowseableRoot = {
    ...base,
    listChildren: listRoot,
    // The project page addresses an editor as its own sub-pointer, so a chart opened there
    // is owned too, not only one opened from the Assets page.
    ownsPointer: (p) => base.ownsPointer(p) || parseAssetPointer(projectAssetPointer(p)).typeName === CHART,
    pathFor: (p) => {
      const parsed = parseAssetPointer(projectAssetPointer(p) ?? p.pointer);
      if (parsed.mode === 'list') return Promise.resolve([]);
      if (!parsed.vfsPath) return Promise.resolve([root]);
      const segments = chartFolderSegments(parsed.vfsPath, deps.projectRoot);
      const folders = segments.map((_, i) => ({
        ...folderNode(segments.slice(0, i + 1), []),
        hasChildren: true,
        listChildren: () => folderChildren(segments.slice(0, i + 1)),
      }));
      const leaf: Browseable = {
        id: `asset:${CHART}:${trimSlashes(parsed.vfsPath)}`,
        kind: 'asset',
        label: parsed.vfsPath.split('/').pop() ?? parsed.vfsPath,
        hasChildren: false,
        pointer: DockPointer.forAssetEditor(CHART, parsed.vfsPath),
      };
      return Promise.resolve([root, ...folders, leaf]);
    },
  };
  return root;
}
