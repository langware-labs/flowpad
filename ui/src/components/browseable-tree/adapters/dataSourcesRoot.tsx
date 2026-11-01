import { useEffect, useMemo } from 'react';
import type { ComponentType } from 'react';
import { t } from '@lingui/core/macro';
import { MessagesSquare } from 'lucide-react';
import { DataDriver, DataSource } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import {
  isMessageChannel,
  projectSourcesQuery,
  sourcesQuery,
  useSourceSpecs,
} from '@src/components/data-sources/use-source-specs';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { DataSourcesRoute, parseDataSourcesPointer } from '@src/components/data-sources/data-sources-pointer';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { CountChip } from '../CountChip';
import { refreshNode } from '../refresh-store';
import { Browseable, BrowseableRoot } from '../types';

const DATA_ROOT_ID = 'configured-data-sources';
const CHANNELS_ROOT_ID = 'message-channels';
const EMPTY: DataSource[] = [];

/** The sources in scope, split by the same rule the agent view uses (`isMessageChannel`).
 *  With a project, the server-scoped project query: a source an agent creates is placed in
 *  its agent's project, so the project holds its agents' sources (agent → project). The
 *  reverse never holds — an agent sees only what it owns. */
export function useSplitSources(projectId: string | null) {
  const query = useMemo(() => (projectId ? projectSourcesQuery(projectId) : sourcesQuery), [projectId]);
  const { data: sources = EMPTY } = useEntitiesQuery<DataSource>(query);
  const { specFor, loading } = useSourceSpecs({ enabled: sources.length > 0 });
  return useMemo(() => {
    const data: DataSource[] = [];
    const channels: DataSource[] = [];
    // Until the drivers load the split is unknown: show neither group rather than
    // flash channels under Data sources.
    if (!loading) for (const s of sources) (isMessageChannel(s, specFor(s.provider)) ? channels : data).push(s);
    return { data, channels, specFor };
  }, [sources, specFor, loading]);
}

function sourcesRoot(opts: {
  id: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  sources: DataSource[];
  specFor: (provider: string) => DataDriver | undefined;
  route?: DataSourcesRoute;
}): BrowseableRoot | null {
  const { id, label, Icon, sources, specFor, route } = opts;
  if (!sources.length) return null;
  const children: Browseable[] = [...sources]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((source) => {
      const SourceIcon = sourceIcon(specFor(source.provider), source.channel);
      return {
        id: `${id}:${source.id}`,
        kind: 'asset',
        label: source.displayName,
        icon: <SourceIcon className="h-3.5 w-3.5 shrink-0" />,
        hasChildren: false,
        pointer: DockPointer.forDataSources({ section: 'source', id: source.id, tab: null }),
      };
    });
  const childFor = (pointer: DockPointer) => {
    const r = parseDataSourcesPointer(pointer.pointer);
    return r.section === 'source' ? children.find((row) => row.id === `${id}:${r.id}`) : undefined;
  };
  const node: BrowseableRoot = {
    id,
    kind: 'root',
    label,
    icon: <Icon className="h-4 w-4 shrink-0" />,
    badge: <CountChip count={sources.length} />,
    pointer: DockPointer.forDataSources(route),
    hasChildren: true,
    listChildren: () => Promise.resolve(children),
    // Only claim a source page for a row this group holds; the two groups share a view.
    ownsPointer: (pointer) =>
      pointer.viewType === node.pointer?.viewType &&
      (!!childFor(pointer) || parseDataSourcesPointer(pointer.pointer).section === (route?.section ?? 'sources')),
    pathFor: (pointer) => {
      const child = childFor(pointer);
      return Promise.resolve(child ? [node, child] : [node]);
    },
  };
  return node;
}

type RootOpts = Parameters<typeof sourcesRoot>[0];

function useSourcesRoot(opts: RootOpts): BrowseableRoot | null {
  const { id, label, Icon, sources, specFor, route } = opts;
  const root = useMemo(
    () => sourcesRoot({ id, label, Icon, sources, specFor, route }),
    // `route` is a literal per call site; its section is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, label, Icon, sources, specFor, route?.section],
  );
  // The tree caches expanded children independently of the subscribed query.
  useEffect(() => refreshNode(id), [id, root]);
  return root;
}

/** "Data sources" and "Message channels" — sibling roots over one query. */
export function useDataSourcesRoots(projectId: string | null): {
  dataSourcesRoot: BrowseableRoot | null;
  channelsRoot: BrowseableRoot | null;
} {
  const { data, channels, specFor } = useSplitSources(projectId);
  const dataSourcesRoot = useSourcesRoot({
    id: DATA_ROOT_ID,
    label: labelForType(DataSource.type),
    Icon: iconForType(DataSource.type),
    sources: data,
    specFor,
  });
  const channelsRoot = useSourcesRoot({
    id: CHANNELS_ROOT_ID,
    label: t`Message channels`,
    Icon: MessagesSquare,
    sources: channels,
    specFor,
    route: { section: 'channels' },
  });
  return { dataSourcesRoot, channelsRoot };
}
