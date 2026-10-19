import { useEffect, useMemo } from 'react';
import { DataSource } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { parseDataSourcesPointer } from '@src/components/data-sources/data-sources-pointer';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { CountChip } from '../CountChip';
import { refreshNode } from '../refresh-store';
import { Browseable, BrowseableRoot } from '../types';

const ROOT_ID = 'configured-data-sources';
const EMPTY: DataSource[] = [];

/** Sources are instance-wide and open their operational page, not a generic asset editor. */
export function useDataSourcesRoot(): BrowseableRoot | null {
  const { data: sources = EMPTY } = useEntitiesQuery<DataSource>(sourcesQuery);
  const { specFor } = useSourceSpecs({ enabled: sources.length > 0 });
  const label = labelForType(DataSource.type);
  const root = useMemo<BrowseableRoot | null>(() => {
    if (!sources.length) return null;
    const Icon = iconForType(DataSource.type);
    const children: Browseable[] = [...sources]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((source) => {
        const SourceIcon = sourceIcon(specFor(source.provider), source.channel);
        return {
          id: `${ROOT_ID}:${source.id}`,
          kind: 'asset',
          label: source.displayName,
          icon: <SourceIcon className="h-3.5 w-3.5 shrink-0" />,
          hasChildren: false,
          pointer: DockPointer.forDataSources({ section: 'source', id: source.id, tab: null }),
        };
      });
    const node: BrowseableRoot = {
      id: ROOT_ID,
      kind: 'root',
      label,
      icon: <Icon className="h-4 w-4 shrink-0" />,
      badge: <CountChip count={sources.length} />,
      pointer: DockPointer.forDataSources(),
      hasChildren: true,
      listChildren: () => Promise.resolve(children),
      ownsPointer: (pointer) => pointer.viewType === node.pointer?.viewType,
      pathFor: (pointer) => {
        const route = parseDataSourcesPointer(pointer.pointer);
        const child = route.section === 'source' ? children.find((row) => row.id === `${ROOT_ID}:${route.id}`) : null;
        return Promise.resolve(child ? [node, child] : [node]);
      },
    };
    return node;
  }, [sources, specFor, label]);

  // The tree caches expanded children independently of the subscribed query.
  useEffect(() => refreshNode(ROOT_ID), [root]);
  return root;
}
