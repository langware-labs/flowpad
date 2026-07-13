import { Trans, useLingui } from '@lingui/react/macro';
import { ContextEntitiesEnum, dataContext } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { ProjectSelectorModal } from '@src/components/project-selector';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { BindSecretDialog } from '@src/components/project-home/BindSecretDialog';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useProjects } from '@src/hooks/use-projects';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Folder, FolderOpen, GitBranch, KeyRound, type LucideIcon } from 'lucide-react';
import { showInputPrompt } from '@src/components/ui/input-prompt-modal';
import { useFavorites } from '@src/hooks/use-favorites';
import { useCallback, useMemo, useState, type ComponentType } from 'react';
import { projectRecencyMs } from '@src/lib/project-recency';
import { QUICK_CREATE_REGISTRY } from './registry';

interface QuickCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the per-type create dialog (name / folder / scope) for an asset type. */
  onPick: (type: string) => void;
}

/** Registry types deliberately absent from this launcher (still creatable
 *  from other surfaces like the Assets page and QuickCreateMenu). */
const HIDDEN_ASSET_TYPES = new Set(['workflow', 'dynamic_workflow']);

/** Icon components accept a className — both lucide icons and the brand SVGs. */
type TileIcon = ComponentType<{ className?: string }>;

interface DesktopTileProps {
  Icon: TileIcon;
  label: string;
  iconClassName?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * A single desktop-style icon tile — sized to match the home MiniDesktop /
 * favorites grid (square tile, icon over a truncated label).
 */
function DesktopTile({ Icon, label, iconClassName, disabled, onClick }: DesktopTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-20 w-20 flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-background text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer hover:border-primary hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className={cn('h-7 w-7', iconClassName)} />
      <span className="line-clamp-2 w-full break-words px-1 text-center text-[10px] font-medium leading-tight">
        {label}
      </span>
    </button>
  );
}

/**
 * QuickCreateModal — a desktop-grid launcher opened from the home "+" button.
 *
 * Mirrors the capabilities of {@link QuickCreateMenu} (which is kept for other
 * surfaces) but renders every option as a square icon tile, matching the home
 * desktop layout. Coding-agent sessions launch immediately; asset types defer
 * to the per-type create dialog via `onPick`; project actions reuse the shared
 * project dialogs.
 */
export function QuickCreateModal({ open, onOpenChange, onPick }: QuickCreateModalProps) {
  const { t } = useLingui();
  const { createFolder } = useFavorites();
  const { types: serverTypes } = useAssetTypes();
  const { project: currentProject } = useProject();
  const { projects, isLoading: isLoadingProjects } = useProjects();
  const { navigation } = useDockNavigation();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [bindSecretOpen, setBindSecretOpen] = useState(false);

  // Coding-agent sessions launch a live AgenticProcess immediately, then we
  // navigate to its terminal dock pointer (URL-first; the loader owns the view).
  const handleStartSession = useCallback(
    async (workerType: 'claude_code' | 'codex' | 'copilot') => {
      onOpenChange(false);
      const result = await navigation.openNewClaudeProcess({ workerType });
      if (!result) {
        notify.error({ title: t`Failed to start session` });
        return;
      }
      await navigation.openShellProcess(result.processId);
    },
    [navigation, onOpenChange],
  );

  const projectItems = useMemo(
    () =>
      (projects ?? []).map((p) => ({
        id: p.id,
        name: p.displayName,
        path: p.fs_storage_mount_path ?? '',
        modifiedAt: p.updated_date ?? null,
        recencyMs: projectRecencyMs({ last_active_at: p.last_active_at, modified_at: p.updated_date }),
      })),
    [projects],
  );

  const handleProjectSelect = useCallback(
    async (id: string) => {
      const picked = projects?.find((p) => p.id === id);
      if (!picked) return;
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, picked.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(picked.fs_storage_mount_path ?? null);
    },
    [projects],
  );

  // Intersection of the UI registry and the server-reported `creatable` types,
  // so the server stays authoritative for what's actually supported. Types in
  // HIDDEN_ASSET_TYPES are omitted from this launcher, and `agent` is surfaced
  // under its user-facing "Sub agent" name.
  const assetItems = useMemo(() => {
    const serverCreatable = new Set(serverTypes.filter((t) => t.creatable).map((t) => t.type_name));
    const enforce = serverCreatable.size > 0;
    return QUICK_CREATE_REGISTRY.filter((d) => !HIDDEN_ASSET_TYPES.has(d.type))
      .filter((d) => !enforce || serverCreatable.has(d.type))
      .map((d) => ({
        type: d.type,
        Icon: d.Icon as TileIcon,
        label:
          d.type === 'agent'
            ? t`Sub agent`
            : (d.label ?? serverTypes.find((t) => t.type_name === d.type)?.label ?? d.type),
      }));
  }, [serverTypes, t]);

  const sessionTiles: Array<{
    key: string;
    Icon: TileIcon;
    label: string;
    iconClassName: string;
    onClick: () => void;
  }> = [
    {
      key: 'claude_code',
      Icon: ClaudeIcon,
      label: t`Claude Code`,
      iconClassName: 'text-orange-500',
      onClick: () => void handleStartSession('claude_code'),
    },
    {
      key: 'codex',
      Icon: CodexIcon,
      label: t`Codex`,
      iconClassName: 'text-emerald-500',
      onClick: () => void handleStartSession('codex'),
    },
    {
      key: 'copilot',
      Icon: CopilotIcon,
      label: t`Copilot`,
      iconClassName: 'text-sky-500',
      onClick: () => void handleStartSession('copilot'),
    },
  ];

  const folderTiles: Array<{ key: string; Icon: LucideIcon; label: string; onClick: () => void }> = [
    {
      key: 'add-git-folder',
      Icon: GitBranch,
      label: t`Add Git folder`,
      // Placeholder — the Git-folder flow is not wired up yet.
      onClick: () => onOpenChange(false),
    },
  ];

  // Project-attachment tiles — secret bindings live on the Project entity, not
  // as creatable file assets, so they are hardcoded here rather than in
  // QUICK_CREATE_REGISTRY. This is the entry point for adding them: the
  // ProjectHome cards only render once non-empty.
  const projectAttachmentTiles: Array<{
    key: string;
    Icon: TileIcon;
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }> = [
    {
      key: 'secret',
      Icon: KeyRound,
      label: t`Secret`,
      disabled: !currentProject,
      onClick: () => {
        onOpenChange(false);
        setBindSecretOpen(true);
      },
    },
  ];

  // Desktop-only grouping for favorite tiles — a Bookmark entity, not a
  // file/scope asset, so deliberately a hardcoded tile (registry entries
  // are filtered by server `creatable` types and drive file creation).
  const desktopTiles: Array<{ key: string; Icon: LucideIcon; label: string; onClick: () => void }> = [
    {
      key: 'bookmark-folder',
      Icon: Folder,
      label: t`Bookmark folder`,
      onClick: () => {
        onOpenChange(false);
        showInputPrompt({
          title: t`New bookmark folder`,
          placeholder: t`Folder name`,
          onConfirm: async (name) => {
            await createFolder(name);
          },
        });
      },
    },
  ];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Trans>Create new</Trans>
            </DialogTitle>
            <DialogDescription>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  setProjectModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2 py-1 text-xs transition-colors hover:bg-accent"
                title={t`Switch project`}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Project</Trans>
                </span>
                <span className="max-w-[160px] truncate">{currentProject?.displayName ?? t`Select…`}</span>
              </button>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 pt-1">
            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                <Trans>New session</Trans>
              </h3>
              <div className="flex flex-wrap gap-3">
                {sessionTiles.map((t) => (
                  <DesktopTile
                    key={t.key}
                    Icon={t.Icon}
                    label={t.label}
                    iconClassName={t.iconClassName}
                    onClick={t.onClick}
                  />
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                <Trans>New asset</Trans>
              </h3>
              <div className="flex flex-wrap gap-3">
                {assetItems.map((item) => (
                  <DesktopTile
                    key={item.type}
                    Icon={item.Icon}
                    label={item.label}
                    onClick={() => {
                      onOpenChange(false);
                      onPick(item.type);
                    }}
                  />
                ))}
                {projectAttachmentTiles.map((tile) => (
                  <DesktopTile
                    key={tile.key}
                    Icon={tile.Icon}
                    label={tile.label}
                    disabled={tile.disabled}
                    onClick={tile.onClick}
                  />
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                <Trans>New folder</Trans>
              </h3>
              <div className="flex flex-wrap gap-3">
                {folderTiles.map((t) => (
                  <DesktopTile key={t.key} Icon={t.Icon} label={t.label} onClick={t.onClick} />
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                <Trans>Desktop</Trans>
              </h3>
              <div className="flex flex-wrap gap-3">
                {desktopTiles.map((t) => (
                  <DesktopTile key={t.key} Icon={t.Icon} label={t.label} onClick={t.onClick} />
                ))}
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <ProjectSelectorModal
        open={projectModalOpen}
        onOpenChange={setProjectModalOpen}
        projects={projectItems}
        selectedId={currentProject?.id ?? null}
        onSelect={(id) => void handleProjectSelect(id)}
        isLoading={isLoadingProjects}
      />
      <BindSecretDialog project={currentProject ?? null} open={bindSecretOpen} onOpenChange={setBindSecretOpen} />
    </>
  );
}
