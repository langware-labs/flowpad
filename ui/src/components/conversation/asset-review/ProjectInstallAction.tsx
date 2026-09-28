import { Project, type TypeId } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useInstallSharedProjectAndOpen } from '@src/components/project-selector/use-ensure-project';
import { useProjects } from '@src/hooks/use-projects';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { withHomePage } from '@src/project-home-page/home-page-state';

/** What the review popup's project action shows (KTD10). */
export type ProjectInstallState = 'waiting' | 'install' | 'installing' | 'open' | 'error' | 'unavailable';

/**
 * The shared project as this machine holds it. Installed means the LOCAL row
 * has a `fs_storage_mount_path`, wherever the install happened — not
 * `chipStateFor`: a hub-pushed membership row resolves as an entity long
 * before any files exist. A hub-only runtime has no local folder, so its row
 * counts as installed (it opens, it never installs).
 */
export function useLocalProject(typeId: TypeId, entityRow?: Project | null) {
  const { projects } = useProjects();
  const listRow = projects?.find((p) => p.id === String(typeId.id)) ?? null;
  const row = listRow ?? entityRow ?? null;
  const mountPath = listRow?.fs_storage_mount_path || entityRow?.fs_storage_mount_path || null;
  return { row, installed: !!row && (!!mountPath || isHubOnly()) };
}

/**
 * The review popup's action for a project: **Install project** in place of the
 * Install in project / Install global pair — a project is not installed INTO a
 * scope, it is cloned as itself. A git-backed project (it has an `origin`) says
 * so: **Clone & Open**. **Open project** once it is installed.
 *
 * Install reuses `useInstallSharedProjectAndOpen` (clone the row's own Git
 * origin in place) and lands URL-first on the project's dock, then calls
 * `onDone` so the popup closes behind the navigation. A refused clone shows an
 * error and retry returns to Install.
 */
export function ProjectInstallAction({
  typeId,
  entityRow,
  entityUnavailable,
  onDone,
}: {
  typeId: TypeId;
  /** The row as `useEntity` resolved it (undefined = loading). */
  entityRow?: Project | null;
  /** The per-TypeId fetch settled on not-found / refused. */
  entityUnavailable: boolean;
  /** Called once the popup's job is done: installed and landed, or opened. */
  onDone?: () => void;
}) {
  const { navigation } = useDockNavigation();
  const { row, installed } = useLocalProject(typeId, entityRow);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle');

  const projectId = String(typeId.id);
  // Landing: URL only — the project loader adopts the project into context.
  const landInProject = useCallback(
    (project: Project) => navigation.openDock(withHomePage(DockPointer.forProject(project.id))),
    [navigation],
  );
  const install = useInstallSharedProjectAndOpen(landInProject);

  const state: ProjectInstallState =
    phase === 'installing'
      ? 'installing'
      : installed
        ? 'open'
        : phase === 'error'
          ? 'error'
          : row
            ? 'install'
            : entityUnavailable
              ? 'unavailable'
              : 'waiting';

  const handleInstall = async () => {
    if (!row) return;
    setPhase('installing');
    try {
      const target = row instanceof Project ? row : new Project(row as Partial<Project>);
      await install(target);
      setPhase('idle');
      onDone?.();
    } catch {
      setPhase('error');
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="project-install-action" data-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        {state === 'waiting' && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <Trans>Loading project…</Trans>
          </span>
        )}
        {state === 'unavailable' && (
          <span className="text-xs text-muted-foreground" data-testid="project-install-unavailable">
            <Trans>Project unavailable</Trans>
          </span>
        )}
        {(state === 'install' || state === 'installing') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={state === 'installing'}
            onClick={() => void handleInstall()}
            data-testid="project-install-button"
          >
            {state === 'installing' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" data-testid="project-installing" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {row?.origin ? <Trans>Clone & Open</Trans> : <Trans>Install project</Trans>}
          </Button>
        )}
        {state === 'open' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              navigation.openDock(withHomePage(DockPointer.forProject(projectId)));
              onDone?.();
            }}
            data-testid="project-open-button"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <Trans>Open project</Trans>
          </Button>
        )}
        {state === 'error' && (
          <Button size="sm" variant="secondary" onClick={() => setPhase('idle')} data-testid="project-install-retry">
            <Trans>Try again</Trans>
          </Button>
        )}
      </div>
      {state === 'error' && (
        <p data-testid="project-install-error" role="alert" className="text-xs text-destructive">
          <Trans>The project could not be installed.</Trans>
        </p>
      )}
    </div>
  );
}
