import { Trans } from '@lingui/react/macro';
import type { Project } from '@sdk';
import type { ReactNode } from 'react';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { useOpenProjectApp, useProjectApps } from '@src/components/top-nav-bar/use-project-apps';
import { WebAppAvatar } from '@src/components/webapp-display/WebAppIcon';

/** The project's apps — the same list the top-bar app button offers, each opened where it says it opens. */
export function ProjectApps({
  project,
  headerExtra,
  fallback = null,
}: {
  project: Project;
  /** Shown beside the section title (e.g. counter chips). */
  headerExtra?: ReactNode;
  /** Rendered instead of the section when the project has no apps. */
  fallback?: ReactNode;
}) {
  const apps = useProjectApps(project);
  const openApp = useOpenProjectApp(String(project.id));
  if (!apps.length) return <>{fallback}</>;
  return (
    <div data-testid="project-home-apps">
      <TileSection title={<Trans>Apps</Trans>} headerExtra={headerExtra}>
        {apps.map((entry) => (
          <DesktopTile
            key={entry.app.id}
            label={entry.app.displayName}
            // The app's own face, never the type glyph — like the agents strip.
            iconSlot={<WebAppAvatar app={entry.app} className="h-9 w-9 text-sm" glyphClassName="h-5 w-5 text-xl" />}
            onClick={() => void openApp(entry)}
            data-testid="project-app-tile"
          />
        ))}
      </TileSection>
    </div>
  );
}
