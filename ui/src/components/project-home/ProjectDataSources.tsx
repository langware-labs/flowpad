import { DataSource } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { sourceGlyphs } from '@src/components/data-sources/source-icon';
import { openSource } from '@src/components/data-sources/data-sources-pointer';

/** Configured sources are instance-wide, just like the dedicated sources page. */
export function ProjectDataSources() {
  const { data: sources = [] } = useEntitiesQuery<DataSource>(sourcesQuery);
  const { specFor } = useSourceSpecs({ enabled: sources.length > 0 });
  const { navigation } = useDockNavigation();
  if (!sources.length) return null;
  return (
    <div data-testid="project-home-data-sources">
      <TileSection title={labelForType(DataSource.type)}>
        {[...sources]
          .sort((a, b) => (a.name || a.provider).localeCompare(b.name || b.provider))
          .map((source) => (
            <DesktopTile
              key={source.id}
              label={source.name || source.provider || source.id.slice(0, 8)}
              iconSlot={
                <IconWithBadge {...sourceGlyphs(specFor(source.provider), source.channel)} className="size-7" />
              }
              onClick={() => openSource(navigation, source.id)}
              data-testid="project-source-tile"
            />
          ))}
      </TileSection>
    </div>
  );
}
