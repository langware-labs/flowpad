import { Trans } from '@lingui/react/macro';
import type { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { useOpenProjectApp, useProjectApps } from '@src/components/top-nav-bar/use-project-apps';

/** The project's apps — the same list the top-bar app button offers, each opened where it says it opens. */
export function ProjectApps({ project }: { project: Project }) {
  const apps = useProjectApps(project);
  const openApp = useOpenProjectApp(String(project.id));
  if (!apps.length) return null;
  return (
    <div data-testid="project-home-apps">
      <TileSection title={<Trans>Apps</Trans>}>
        {apps.map((entry) => (
          <DesktopTile
            key={entry.app.id}
            label={entry.app.displayName}
            Icon={iconForType(entry.app.type)}
            onClick={() => void openApp(entry)}
            data-testid="project-app-tile"
          />
        ))}
      </TileSection>
    </div>
  );
}
