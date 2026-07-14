import { dataManager, MessageAttachment, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { Download, FolderDown, Globe, Loader2, Play, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { ProjectSelectorModal, projectListToSelectorItems } from '@src/components/project-selector';
import { canonicalPath, useEnsureProject } from '@src/components/project-selector/use-ensure-project';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openDisplayTarget } from '@src/navigation/open-display-target';

/** One install-scope toggle: shows Uninstall when THIS scope is installed,
 *  Install (disabled while the other scope holds the install) otherwise. */
function ScopeButton({
  scope,
  installedScope,
  busy,
  installLabel,
  uninstallLabel,
  installIcon,
  onInstall,
  onUninstall,
  disabledTitle,
}: {
  scope: 'user' | 'project';
  installedScope: 'user' | 'project' | null;
  busy: boolean;
  installLabel: ReactNode;
  uninstallLabel: ReactNode;
  installIcon: ReactNode;
  onInstall: () => void;
  onUninstall: () => void;
  disabledTitle: string;
}) {
  const spinner = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null;
  const testIdSuffix = scope === 'user' ? 'global' : 'project';
  if (installedScope === scope) {
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={onUninstall} data-testid={`asset-uninstall-${testIdSuffix}`}>
        {spinner ?? <Trash2 className="h-3.5 w-3.5" />}
        {uninstallLabel}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={busy || installedScope != null}
      title={installedScope != null ? disabledTitle : undefined}
      onClick={onInstall}
      data-testid={`asset-install-${testIdSuffix}`}
    >
      {spinner ?? installIcon}
      {installLabel}
    </Button>
  );
}

/**
 * The review modal's header actions: Install in project / Install global /
 * Uninstall (per the single-scope model: the installed scope's button flips to
 * Uninstall, the other scope's Install is disabled) + Test it for skills.
 *
 * No optimistic state — the MessageAttachment UPDATE and the asset entity
 * CREATE/DELETE data-ops drive the re-render.
 */
export function AssetInstallActions({
  attachment,
  conversationProjectId,
}: {
  attachment: MessageAttachment;
  /** The conversation's mapped project — the picker's preselected default and
   *  the default install+run target. */
  conversationProjectId?: string | null;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  // Transient failure reason for a Git Download/Setup — shown inline; the
  // Download button stays clickable so the receiver can retry (each attachment
  // retries independently; a pull failure never indexes stale content).
  const [gitError, setGitError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { projects, isLoading: projectsLoading } = useAllProjects({ enabled: pickerOpen });
  const projectItems = useMemo(() => projectListToSelectorItems(projects), [projects]);
  const ensureProject = useEnsureProject();
  const { project: currentProject } = useProject();
  const { navigation } = useDockNavigation();

  const installedScope = attachment.effectiveScope;
  // Schema-derived, stamped backend-side at stage time — no type list here.
  const userScopeAllowed = attachment.user_scope_allowed !== false;
  // Reception verb, sourced from the backend TypeInfo (no per-type FE map). A type
  // with a setup_skill gets its own CTA verb ("Set up", "Run"); everything else
  // keeps the plain "Install in project".
  const typeInfo = dataManager.getTypeInfo?.(attachment.asset_type ?? '');
  const setupLabel = typeInfo?.setup_skill ? (typeInfo.reception_verb ?? null) : null;

  // Preselection: the conversation-mapped project wins; fall back to the
  // active project. Selector ids are canonical PATHS (ConversationRoute
  // idiom), so resolve the Project entity → mount path.
  const [preselectedPath, setPreselectedPath] = useState<string | null>(null);
  const openPicker = useCallback(() => {
    setPickerOpen(true);
    const pid = conversationProjectId ?? currentProject?.id ?? null;
    if (!pid) {
      setPreselectedPath(
        currentProject?.fs_storage_mount_path ? canonicalPath(currentProject.fs_storage_mount_path) : null,
      );
      return;
    }
    void dataManager
      .getByTypeId<Project>(new TypeId(Project.type, pid))
      .then((project) => {
        const path = project?.fs_storage_mount_path || project?.name || '';
        setPreselectedPath(path ? canonicalPath(path) : null);
      })
      .catch(() => setPreselectedPath(null));
  }, [conversationProjectId, currentProject?.id, currentProject?.fs_storage_mount_path]);

  const doInstall = useCallback(
    async (scope: 'user' | 'project', projectId?: string) => {
      setBusy(true);
      try {
        const show = await attachment.install(scope, projectId);
        notify.success({ title: t`Installed`, message: attachment.name ?? attachment.asset_type ?? '' });
        openDisplayTarget(show, navigation);
      } catch (err) {
        console.error('[asset-review] install failed', err);
        notify.error({ title: t`Install failed` });
      } finally {
        setBusy(false);
      }
    },
    [attachment, navigation, t],
  );

  // Git "Download": clone/pull the origin + index (no scope picker — placement
  // is repo-determined). Setup never runs here; it's a separate action below.
  const isGit = attachment.transfer_mode === 'git';
  const downloaded = attachment.effectiveScope != null;
  const doGitDownload = useCallback(async () => {
    setBusy(true);
    setGitError(null);
    try {
      // No install-scope selection for git: placement is repo-determined
      // (_resolve_git_checkout reuses/clones the checkout; the reindex derives
      // the owning project from the checkout path). 'user' scope carries no
      // project-mount dependency.
      const show = await attachment.install('user');
      notify.success({ title: t`Downloaded`, message: attachment.name ?? attachment.asset_type ?? '' });
      openDisplayTarget(show, navigation);
    } catch (err) {
      console.error('[asset-review] git download failed', err);
      const reason = err instanceof Error ? err.message : t`Download failed`;
      setGitError(reason);
      notify.error({ title: t`Download failed`, message: reason });
    } finally {
      setBusy(false);
    }
  }, [attachment, navigation, t]);

  const doGitSetup = useCallback(async () => {
    setBusy(true);
    try {
      const show = await attachment.runSetup();
      openDisplayTarget(show, navigation);
    } catch (err) {
      console.error('[asset-review] git setup failed', err);
      notify.error({ title: t`Setup failed` });
    } finally {
      setBusy(false);
    }
  }, [attachment, navigation, t]);

  const doUninstall = useCallback(async () => {
    setBusy(true);
    try {
      await attachment.uninstall();
      notify.success({ title: t`Uninstalled`, message: attachment.name ?? attachment.asset_type ?? '' });
    } catch (err) {
      console.error('[asset-review] uninstall failed', err);
      notify.error({ title: t`Uninstall failed` });
    } finally {
      setBusy(false);
    }
  }, [attachment, t]);

  const handleProjectPick = useCallback(
    async (id: string) => {
      const picked = projectItems.find((item) => item.id === id);
      if (!picked?.path) return;
      setBusy(true);
      try {
        const project = await ensureProject(picked.path, { select: false });
        if (!project.id) throw new Error('picked project has no id');
        const show = await attachment.install('project', project.id);
        notify.success({ title: t`Installed in project`, message: project.displayName });
        openDisplayTarget(show, navigation);
      } catch (err) {
        console.error('[asset-review] project install failed', err);
        notify.error({ title: t`Install failed` });
      } finally {
        setBusy(false);
      }
    },
    [attachment, ensureProject, projectItems, navigation, t],
  );

  // Git-shared assets never enter Copy & Install. A single Download clones/pulls
  // + indexes; Setup (when the type has a setup skill) is a separate optional
  // action offered only after a successful Download.
  if (isGit) {
    const spinner = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {!downloaded && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void doGitDownload()}
              data-testid="asset-git-download"
            >
              {spinner ?? <Download className="h-3.5 w-3.5" />}
              {gitError ? <Trans>Retry download</Trans> : <Trans>Download</Trans>}
            </Button>
          )}
          {downloaded && setupLabel && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void doGitSetup()}
              data-testid="asset-git-setup"
            >
              {spinner ?? <Play className="h-3.5 w-3.5" />}
              {setupLabel}
            </Button>
          )}
        </div>
        {gitError && (
          <p className="text-xs text-destructive" data-testid="asset-git-error">
            {gitError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ScopeButton
        scope="project"
        installedScope={installedScope}
        busy={busy}
        installLabel={setupLabel ?? <Trans>Install in project</Trans>}
        uninstallLabel={<Trans>Uninstall from project</Trans>}
        installIcon={<FolderDown className="h-3.5 w-3.5" />}
        onInstall={openPicker}
        onUninstall={() => void doUninstall()}
        disabledTitle={t`Already installed globally — uninstall first`}
      />
      {userScopeAllowed && (
        <ScopeButton
          scope="user"
          installedScope={installedScope}
          busy={busy}
          installLabel={<Trans>Install global</Trans>}
          uninstallLabel={<Trans>Uninstall</Trans>}
          installIcon={<Globe className="h-3.5 w-3.5" />}
          onInstall={() => void doInstall('user')}
          onUninstall={() => void doUninstall()}
          disabledTitle={t`Already installed in a project — uninstall first`}
        />
      )}
      <ProjectSelectorModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projects={projectItems}
        selectedId={preselectedPath}
        onSelect={(id) => void handleProjectPick(id)}
        isLoading={projectsLoading}
        title={setupLabel ?? t`Install in project`}
      />
    </div>
  );
}
