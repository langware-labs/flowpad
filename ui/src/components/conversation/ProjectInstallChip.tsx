import { Project, type TypeId } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useInstallSharedProjectAndOpen } from '@src/components/project-selector/use-ensure-project';
import { useProjects } from '@src/hooks/use-projects';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { withHomePage } from '@src/project-home-page/home-page-state';
import { cn } from '@src/lib/utils';

/** The chip's visible state — the "Project chip states" diagram (KTD10). */
export type ProjectChipState = 'waiting' | 'install' | 'installing' | 'open' | 'error' | 'unavailable';

const CHIP_CLASS =
  'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs';
const ACTION_CLASS =
  'inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/50 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10';

/**
 * A project reference in a message: **Install project** until the project is
 * installed on this machine, **Open project** once it is (R11, R13).
 *
 * Stated from the LOCAL Project row — installed means the row has a
 * `fs_storage_mount_path`, wherever the install happened. Not `chipStateFor`:
 * a hub-pushed membership row resolves as an entity long before any files
 * exist. The chip renders before the row arrives (waiting), and turns
 * unavailable when the row cannot be fetched at all (not found / no access).
 *
 * Install reuses `useInstallSharedProjectAndOpen` (clone the row's own Git
 * origin in place) and lands URL-first on the project's dock. A refused clone
 * shows an error and retry returns to Install. A hub-only
 * runtime has no local folder to install into, so the install action is hidden
 * there.
 */
export function ProjectInstallChip({
  typeId,
  name,
  entityRow,
  entityUnavailable,
}: {
  typeId: TypeId;
  /** Display-name fallback until the row arrives (the attachment's name). */
  name?: string | null;
  /** The row as the message chip's `useEntity` resolved it (undefined = loading). */
  entityRow?: Project | null;
  /** The per-TypeId fetch settled on not-found / refused. */
  entityUnavailable: boolean;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { projects } = useProjects();
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle');
  const [installed, setInstalled] = useState<Project | null>(null);

  const projectId = String(typeId.id);
  const listRow = projects?.find((p) => p.id === projectId) ?? null;
  const row = listRow ?? entityRow ?? null;
  const mountPath =
    installed?.fs_storage_mount_path || listRow?.fs_storage_mount_path || entityRow?.fs_storage_mount_path || null;
  const hubOnly = isHubOnly();

  // Landing: URL only — the project loader adopts the project into context.
  const landInProject = useCallback(
    (project: Project) => navigation.openDock(withHomePage(DockPointer.forProject(project.id))),
    [navigation],
  );
  const install = useInstallSharedProjectAndOpen(landInProject);

  const state: ProjectChipState =
    phase === 'installing'
      ? 'installing'
      : row && (mountPath || hubOnly)
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
      setInstalled(await install(target));
      setPhase('idle');
    } catch {
      setPhase('error');
    }
  };

  const Icon = iconForType(Project.type);
  const label = row?.name || name || t`Project`;

  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <span
        data-testid="project-install-chip"
        data-state={state}
        className={cn(CHIP_CLASS, state === 'unavailable' && 'text-muted-foreground')}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        {state === 'waiting' && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <Trans>Loading project…</Trans>
          </span>
        )}
        {state === 'unavailable' && (
          <span data-testid="project-install-unavailable">
            <Trans>Project unavailable</Trans>
          </span>
        )}
        {state === 'install' && !hubOnly && (
          <button
            type="button"
            data-testid="project-install-button"
            className={ACTION_CLASS}
            onClick={() => void handleInstall()}
          >
            <Trans>Install project</Trans>
          </button>
        )}
        {state === 'installing' && (
          <span data-testid="project-installing" className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <Trans>Installing…</Trans>
          </span>
        )}
        {state === 'open' && (
          <button
            type="button"
            data-testid="project-open-button"
            className={ACTION_CLASS}
            onClick={() => navigation.openDock(withHomePage(DockPointer.forProject(projectId)))}
          >
            <Trans>Open project</Trans>
          </button>
        )}
        {state === 'error' && (
          <button
            type="button"
            data-testid="project-install-retry"
            className={ACTION_CLASS}
            onClick={() => setPhase('idle')}
          >
            <Trans>Try again</Trans>
          </button>
        )}
      </span>
      {state === 'error' && (
        <span data-testid="project-install-error" role="alert" className="text-start text-[11px] text-destructive">
          <Trans>The project could not be installed.</Trans>
        </span>
      )}
    </span>
  );
}
