import { Project, TypeId } from '@sdk';
import { DesktopSurface } from '@src/components/quick-create/DesktopSurface';
import { useEntity } from '@src/hooks/entity-hooks';
import { favoritesFilterForScope } from '@src/lib/bookmark-scope';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';

/**
 * DesktopPage — the full-page favorites desktop at /dock/desktop: the exact
 * same DesktopSurface the home MiniDesktop hosts, just with room to breathe
 * (large tiles, full viewport). URL-first sibling of the compact strip.
 *
 * Scope-keyed: `/dock/desktop?<scope>` pins the grid to that scope (e.g. a
 * project's favorites, opened from the project-home MiniDesktop's expand
 * affordance) and titles the page "<project> Desktop".
 */
export function DesktopPage() {
  const { currentDock } = useDockNavigation();
  // `scopeFilter` is a getter that re-allocates each access; memoize on the dock
  // so the filter/roots memo chain downstream stays stable across re-renders.
  const scope = useMemo(() => currentDock?.scopeFilter ?? null, [currentDock]);
  const projectId = scope?.mode === 'project' ? scope.activeProjectId ?? null : null;

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const filter = useMemo(() => favoritesFilterForScope(scope), [scope]);

  const projectName = project?.getDisplayName?.() ?? project?.name ?? null;

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">
        {projectName ? `${projectName} Desktop` : <Trans>Desktop</Trans>}
      </h1>
      <DesktopSurface size="large" filter={filter} />
    </div>
  );
}
