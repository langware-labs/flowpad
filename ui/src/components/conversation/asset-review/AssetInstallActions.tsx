import { dataManager, MessageAttachment, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { FolderDown, Globe, Loader2, Play, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { ProjectSelectorModal, projectListToSelectorItems } from '@src/components/project-selector';
import { canonicalPath, useEnsureProject } from '@src/components/project-selector/use-ensure-project';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { notify } from '@src/notifications';
import { TESTABLE_TYPES } from './test-prompt';
import { TestPromptDialog } from './TestPromptDialog';
import { useRunSkillWithProjectPrompt } from './useRunReceivedSkill';

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const { projects, isLoading: projectsLoading } = useAllProjects({ enabled: pickerOpen });
  const projectItems = useMemo(() => projectListToSelectorItems(projects), [projects]);
  const ensureProject = useEnsureProject();
  const { project: currentProject } = useProject();
  const { start: startSkillRun, picker: runPicker } = useRunSkillWithProjectPrompt();

  const installedScope = attachment.effectiveScope;
  // Schema-derived, stamped backend-side at stage time — no type list here.
  const userScopeAllowed = attachment.user_scope_allowed !== false;
  const testable = TESTABLE_TYPES.has(attachment.asset_type ?? '');

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
        await attachment.install(scope, projectId);
        notify.success({ title: t`Installed`, message: attachment.name ?? attachment.asset_type ?? '' });
      } catch (err) {
        console.error('[asset-review] install failed', err);
        notify.error({ title: t`Install failed` });
      } finally {
        setBusy(false);
      }
    },
    [attachment, t],
  );

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
        await attachment.install('project', project.id);
        notify.success({ title: t`Installed in project`, message: project.displayName });
      } catch (err) {
        console.error('[asset-review] project install failed', err);
        notify.error({ title: t`Install failed` });
      } finally {
        setBusy(false);
      }
    },
    [attachment, ensureProject, projectItems, t],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ScopeButton
        scope="project"
        installedScope={installedScope}
        busy={busy}
        installLabel={<Trans>Install in project</Trans>}
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
      {testable && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setTestOpen(true)} data-testid="asset-test-it">
          <Play className="h-3.5 w-3.5" />
          <Trans>Run</Trans>
        </Button>
      )}
      <ProjectSelectorModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projects={projectItems}
        selectedId={preselectedPath}
        onSelect={(id) => void handleProjectPick(id)}
        isLoading={projectsLoading}
        title={t`Install in project`}
      />
      {testOpen && (
        <TestPromptDialog
          open={testOpen}
          onClose={() => setTestOpen(false)}
          assetName={attachment.name ?? attachment.asset_type ?? ''}
          onRun={(prompt) =>
            startSkillRun(attachment, conversationProjectId ?? currentProject?.id ?? null, prompt)
          }
        />
      )}
      {runPicker}
    </div>
  );
}
