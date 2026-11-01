import { Trans } from '@lingui/react/macro';
import type { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { projectAppDock, useProjectApps } from '@src/components/top-nav-bar/use-project-apps';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** The project's apps — the same list the top-bar app button offers. Each opens as its own tab. */
export function ProjectApps({ project }: { project: Project }) {
  const apps = useProjectApps(project);
  const { navigation } = useDockNavigation();
  if (!apps.length) return null;
  return (
    <div data-testid="project-home-apps">
      <TileSection title={<Trans>Apps</Trans>}>
        {apps.map((entry) => (
          <DesktopTile
            key={entry.app.id}
            label={entry.app.displayName}
            Icon={iconForType(entry.app.type)}
            onClick={() =>
              navigation.openDock(projectAppDock(entry, String(project.id)), undefined, { topLevel: true })
            }
            data-testid="project-app-tile"
          />
        ))}
      </TileSection>
    </div>
  );
}
