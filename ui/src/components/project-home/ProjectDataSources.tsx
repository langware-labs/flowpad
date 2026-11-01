import { DataSource } from '@sdk';
import { t } from '@lingui/core/macro';
import { useSplitSources } from '@src/components/browseable-tree/adapters/dataSourcesRoot';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { sourceGlyphs } from '@src/components/data-sources/source-icon';
import { openSource } from '@src/components/data-sources/data-sources-pointer';

/** Project home: its data sources and its message channels, split by the same rule
 *  (and the same project membership) as the Project assets tree. */
export function ProjectDataSources({ projectId }: { projectId: string }) {
  const { data, channels, specFor } = useSplitSources(projectId);
  const { navigation } = useDockNavigation();
  if (!data.length && !channels.length) return null;
  const section = (title: string, sources: DataSource[], testId: string) =>
    sources.length ? (
      <TileSection title={title} data-testid={testId}>
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
    ) : null;
  return (
    <div data-testid="project-home-data-sources">
      {section(labelForType(DataSource.type), data, 'project-home-data-section')}
      {section(t`Message channels`, channels, 'project-home-channels-section')}
    </div>
  );
}
