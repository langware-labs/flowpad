import { type MessageAttachment, Project, type TypeId } from '@sdk';
import { Trans } from '@lingui/react/macro';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { errorMessage, errorStatus } from '@src/lib/error-message';
import { useInstallSharedProjectAndOpen } from '@src/components/project-selector/use-ensure-project';
import { useProjects } from '@src/hooks/use-projects';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { withHomePage } from '@src/project-home-page/home-page-state';

/** What the review popup's project action shows (KTD10). */
export type ProjectInstallState =
  | 'waiting'
  | 'install'
  | 'installing'
  | 'open'
  | 'cloud-only'
  | 'error'
  | 'name-taken'
  | 'unavailable';

/** The backend's 409 when the shared project's name is already a project here. */
export interface NameConflict {
  attempted_name: string;
  suggested_name: string;
  existing_project_id: string;
}

/** The 409 `project_name_conflict` a project install refuses with, or null. */
export function nameConflictOf(err: unknown): NameConflict | null {
  if (errorStatus(err) !== 409) return null;
  const data = (err as { response?: { data?: { data?: Partial<NameConflict> & { project_name_conflict?: boolean } } } })
    .response?.data?.data;
  return data?.project_name_conflict && data.existing_project_id
    ? {
        attempted_name: data.attempted_name ?? '',
        suggested_name: data.suggested_name ?? '',
        existing_project_id: data.existing_project_id,
      }
    : null;
}

/** A linked Project can be opened without inventing a local checkout. */
export function isCloudOnlyProject(row?: Project | null): boolean {
  return row?.remote === true && !row.origin && !row.fs_storage_mount_path;
}

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
 * A project the invite's bundle staged (`attachment`) installs like any git
 * download: `attachment.install('user')` — the backend writes the row, clones
 * and records the install — and its install state is the attachment's, not the
 * local mount (a hub-mirrored row, or a checkout from the email link, is not an
 * install of this attachment). A project reference with no staged attachment
 * (an invite sent before projects rode the bundle) reuses
 * `useInstallSharedProjectAndOpen` (clone the row's own Git origin in place).
 * Either way it lands URL-first on the project's dock, then calls `onDone` so
 * the popup closes behind the navigation. A refused install shows the reason,
 * and retry returns to Install.
 *
 * When this desktop already has a project under the shared one's name (often
 * the same repo, set up earlier), the backend refuses with a 409 and the
 * receiver chooses: open the project they have, install this one under another
 * name, or cancel.
 */
export function ProjectInstallAction({
  typeId,
  entityRow,
  entityUnavailable,
  attachment,
  onDone,
}: {
  typeId: TypeId;
  /** The project as the invite's bundle staged it, when it did. */
  attachment?: MessageAttachment | null;
  /** The row as `useEntity` resolved it (undefined = loading). */
  entityRow?: Project | null;
  /** The per-TypeId fetch settled on not-found / refused. */
  entityUnavailable: boolean;
  /** Called once the popup's job is done: installed and landed, or opened. */
  onDone?: () => void;
}) {
  const { navigation } = useDockNavigation();
  const { row, installed: rowInstalled } = useLocalProject(typeId, entityRow);
  const installed = attachment ? attachment.installed : rowInstalled;
  // Require the resolved entity, not a stale collection row after a refused fetch.
  const cloudOnly = !attachment && !entityUnavailable && isCloudOnlyProject(entityRow);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error' | 'name-taken'>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NameConflict | null>(null);
  const [newName, setNewName] = useState('');

  const projectId = String(typeId.id);
  // Landing: URL only — the project loader adopts the project into context.
  const openProject = useCallback(
    (id: string) => navigation.openDock(withHomePage(DockPointer.forProject(id))),
    [navigation],
  );
  const landInProject = useCallback((project: Project) => openProject(project.id), [openProject]);
  const install = useInstallSharedProjectAndOpen(landInProject);

  const state: ProjectInstallState =
    phase === 'installing'
      ? 'installing'
      : cloudOnly
        ? 'cloud-only'
        : installed
          ? 'open'
          : phase === 'error'
            ? 'error'
            : phase === 'name-taken'
              ? 'name-taken'
              : row || attachment
                ? 'install'
                : entityUnavailable
                  ? 'unavailable'
                  : 'waiting';

  const handleInstall = async (name?: string) => {
    if (!attachment && !row) return;
    setPhase('installing');
    setReason(null);
    try {
      if (attachment) {
        await attachment.install('user', undefined, { name });
        openProject(projectId);
      } else if (row) {
        await install(row instanceof Project ? row : new Project(row as Partial<Project>));
      }
      setPhase('idle');
      onDone?.();
    } catch (err) {
      const taken = nameConflictOf(err);
      if (taken) {
        setConflict(taken);
        setNewName(taken.suggested_name);
        setPhase('name-taken');
        return;
      }
      setReason(errorMessage(err, '') || null);
      setPhase('error');
    }
  };

  const openExisting = () => {
    if (!conflict) return;
    openProject(conflict.existing_project_id);
    onDone?.();
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
        {/* Installed ('open'): the install action stays in place, greyed out, and
            the popup's usual Open button sits beside it — as for any installed
            shared entity. */}
        {(state === 'install' || state === 'installing' || state === 'open') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={state !== 'install'}
            onClick={() => void handleInstall()}
            data-testid="project-install-button"
          >
            {state === 'installing' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" data-testid="project-installing" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {row?.origin || attachment ? <Trans>Clone & Open</Trans> : <Trans>Install project</Trans>}
          </Button>
        )}
        {(state === 'open' || state === 'cloud-only') && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              openProject(projectId);
              onDone?.();
            }}
            data-testid="asset-open-entity"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {state === 'cloud-only' ? <Trans>Open project</Trans> : <Trans>Open</Trans>}
          </Button>
        )}
        {state === 'error' && (
          <Button size="sm" variant="secondary" onClick={() => setPhase('idle')} data-testid="project-install-retry">
            <Trans>Try again</Trans>
          </Button>
        )}
      </div>
      {state === 'name-taken' && conflict && (
        <div data-testid="project-name-taken" className="flex flex-col gap-2 text-xs">
          <p>
            <Trans>
              You already have a project named <strong>{conflict.attempted_name}</strong>. Open it, or install this one
              under another name.
            </Trans>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={openExisting} data-testid="project-name-taken-open">
              <ExternalLink className="h-3.5 w-3.5" />
              <Trans>Open my project</Trans>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={conflict.suggested_name}
              className="h-8 max-w-xs text-xs"
              data-testid="project-name-taken-input"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!newName.trim()}
              onClick={() => void handleInstall(newName.trim())}
              data-testid="project-name-taken-install"
            >
              <Download className="h-3.5 w-3.5" />
              <Trans>Install as this name</Trans>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPhase('idle')} data-testid="project-name-taken-cancel">
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      )}
      {state === 'error' && (
        <p data-testid="project-install-error" role="alert" className="text-xs text-destructive">
          <Trans>The project could not be installed.</Trans>
          {reason && <span className="block text-muted-foreground">{reason}</span>}
        </p>
      )}
    </div>
  );
}
