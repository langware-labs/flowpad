import { MessageAttachment, TypeId } from '@sdk';
import { gitOriginCloneUrl, type GitOrigin } from '@sdk/models/GitOrigin';
import { useEntity } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import {
  Cloud,
  ExternalLink,
  File,
  FolderDown,
  FolderInput,
  GitBranch,
  Globe,
  Loader2,
  Package,
  Trash2,
} from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ProjectSelectorModal, projectListToSelectorItems } from '@src/components/project-selector';
import { useEnsureProject } from '@src/components/project-selector/use-ensure-project';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { notify } from '@src/notifications';
import { buildDockPointer, iconForEntity } from '../EntityChip';
import { AssetInstallActions } from './AssetInstallActions';
import { StagedAssetViewer } from './StagedAssetViewer';

/** Where the asset's content actually comes from — the reviewer's trust signal.
 *  Derived from the MA row: a git transfer carries only the remote (installing
 *  clones/pulls it); staged bytes rode inside the .flowmsg; anything else is a
 *  hub-served reference fetched on open. */
function sourceOf(ma: MessageAttachment): { label: string; Icon: typeof Cloud; detail: string | null } {
  const origin = (ma.git_origin ?? null) as GitOrigin | null;
  if (ma.transfer_mode === 'git' || origin) {
    return { label: 'Git', Icon: GitBranch, detail: origin ? gitOriginCloneUrl(origin) : null };
  }
  if (ma.unpacked_path) return { label: 'Embedded in message', Icon: Package, detail: null };
  return { label: 'Cloud', Icon: Cloud, detail: null };
}

const isGitAttachment = (ma: MessageAttachment): boolean => ma.transfer_mode === 'git' || ma.git_origin != null;
const typeWordOf = (type?: string): string => {
  const t = type || 'file';
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ');
};
// Raw files have no backend TypeInfo icon — use the generic File glyph
// (sanctioned call-site special-case, mirroring FlowMessageBubble's chip).
const iconFor = (ma: MessageAttachment) => (ma.asset_type === 'file' ? File : iconForEntity(ma.asset_type ?? ''));

/** Invisible per-attachment live subscription. The `attachments` prop rides the
 *  conversation-wide QUERY, and WS UPDATE ops don't notify query watchers — so
 *  without a per-row `useEntity` an install from the open modal leaves that
 *  row's install state (and the batch buttons) stale until a remount. One of
 *  these is mounted per listed attachment; it reports the live row upward. */
function AttachmentLiveSubscriber({
  id,
  onUpdate,
}: {
  id: string;
  onUpdate: (id: string, ma: MessageAttachment) => void;
}) {
  const typeId = useMemo(() => new TypeId(MessageAttachment.type, id), [id]);
  const { data } = useEntity<MessageAttachment>(typeId);
  useEffect(() => {
    if (data) onUpdate(id, data);
  }, [data, id, onUpdate]);
  return null;
}

/**
 * Review modal for a received message's staged attachments (opened from a
 * dashed conversation chip). Two panes: a left rail listing every entity
 * attached to the message (the clicked one pinned first and selected by
 * default), and a right pane showing the selected one's default content view
 * (the md file — task.md, SKILL.md, …) via {@link StagedAssetViewer}.
 *
 * The install header stays on top. Install / Uninstall act on the WHOLE list
 * (batch): "Install in project" installs every attachment into the target
 * project, "Install global" into the user scope. "Open" jumps to the currently
 * selected entity's view. When the conversation isn't mapped to a project, a
 * top-right "Select project" button (the same picker as switch-project) chooses
 * the install target.
 *
 * All state flips live off the per-attachment MessageAttachment UPDATE via the
 * `AttachmentLiveSubscriber`s below — no optimistic writes anywhere.
 */
export function AssetReviewDialog({
  open,
  onClose,
  attachments,
  initialAttachmentId,
  attachmentProjectId,
}: {
  open: boolean;
  onClose: () => void;
  /** Every MessageAttachment on the message (entities + files). */
  attachments: MessageAttachment[];
  /** The clicked chip's attachment — default selection, pinned to the top. */
  initialAttachmentId: string;
  /** The conversation's mapped project (install target when present). When
   *  null, the "Select project" button is shown to choose one. */
  attachmentProjectId: string | null;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();

  // Clicked attachment first, then the rest — stable order for the left rail.
  const ordered = useMemo(() => {
    const initial = attachments.find((a) => a.id === initialAttachmentId);
    const rest = attachments.filter((a) => a.id !== initialAttachmentId);
    return initial ? [initial, ...rest] : attachments;
  }, [attachments, initialAttachmentId]);

  // Live rows keyed by id — merged over the (stale-on-UPDATE) query props.
  const [liveById, setLiveById] = useState<Map<string, MessageAttachment>>(new Map());
  const applyLive = useCallback((id: string, ma: MessageAttachment) => {
    setLiveById((prev) => {
      if (prev.get(id) === ma) return prev;
      const next = new Map(prev);
      next.set(id, ma);
      return next;
    });
  }, []);
  const resolve = useCallback((a: MessageAttachment) => liveById.get(a.id) ?? a, [liveById]);

  const [selectedId, setSelectedId] = useState(initialAttachmentId);
  // Reopening the dialog (or clicking a different chip) re-pins the clicked one.
  useEffect(() => {
    if (open) setSelectedId(initialAttachmentId);
  }, [open, initialAttachmentId]);

  const selected = resolve(ordered.find((a) => a.id === selectedId) ?? ordered[0] ?? attachments[0]);
  const liveOrdered = useMemo(() => ordered.map(resolve), [ordered, resolve]);

  // Non-git attachments are the ones the project/global scope buttons act on;
  // git rows install through their own Download/Setup flow (AssetInstallActions).
  const installable = useMemo(() => liveOrdered.filter((a) => !isGitAttachment(a)), [liveOrdered]);

  // Install target: the conversation mapping wins; otherwise the project the
  // user picks via the top-right "Select project" button.
  const [selectedProject, setSelectedProject] = useState<{ id: string; name: string } | null>(null);
  const targetProjectId = attachmentProjectId ?? selectedProject?.id ?? null;

  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Set when the picker was opened by "Install in project" (vs. the bare
  // "Select project" button) — install the whole list once a project resolves.
  const [installAfterPick, setInstallAfterPick] = useState(false);
  const { projects, isLoading: projectsLoading } = useAllProjects({ enabled: pickerOpen });
  const projectItems = useMemo(() => projectListToSelectorItems(projects), [projects]);
  const ensureProject = useEnsureProject();

  // ── Batch install state (over the non-git attachments) ───────────────────
  const scopes = installable.map((a) => a.effectiveScope);
  const anyProject = scopes.some((s) => s === 'project');
  const anyUser = scopes.some((s) => s === 'user');
  const allProject = installable.length > 0 && scopes.every((s) => s === 'project');
  const allUser = installable.length > 0 && scopes.every((s) => s === 'user');
  const userScopeAllowed = installable.every((a) => a.user_scope_allowed !== false);

  const selectedIsGit = isGitAttachment(selected);
  const selectedInstalled = selected.effectiveScope != null;

  const installAllToProject = async (projectId: string, name?: string) => {
    setBusy(true);
    try {
      for (const a of installable) await a.install('project', projectId);
      notify.success({ title: t`Installed in project`, message: name ?? '' });
    } catch (err) {
      console.error('[asset-review] batch project install failed', err);
      notify.error({ title: t`Install failed` });
    } finally {
      setBusy(false);
    }
  };

  const handleInstallProject = () => {
    if (targetProjectId) {
      void installAllToProject(targetProjectId, selectedProject?.name);
      return;
    }
    // No target yet — open the picker and install once one is chosen.
    setInstallAfterPick(true);
    setPickerOpen(true);
  };

  const handleInstallGlobal = async () => {
    setBusy(true);
    try {
      for (const a of installable) await a.install('user');
      notify.success({ title: t`Installed`, message: t`${installable.length} attachments` });
    } catch (err) {
      console.error('[asset-review] batch global install failed', err);
      notify.error({ title: t`Install failed` });
    } finally {
      setBusy(false);
    }
  };

  const handleUninstallAll = async () => {
    setBusy(true);
    try {
      for (const a of installable) if (a.effectiveScope != null) await a.uninstall();
      notify.success({ title: t`Uninstalled` });
    } catch (err) {
      console.error('[asset-review] batch uninstall failed', err);
      notify.error({ title: t`Uninstall failed` });
    } finally {
      setBusy(false);
    }
  };

  const handlePickProject = async (pathId: string) => {
    const item = projectItems.find((i) => i.id === pathId);
    if (!item?.path) return;
    setPickerOpen(false);
    const runInstall = installAfterPick;
    setInstallAfterPick(false);
    try {
      const project = await ensureProject(item.path, { select: false });
      if (!project.id) throw new Error('picked project has no id');
      setSelectedProject({ id: project.id, name: project.displayName });
      if (runInstall) await installAllToProject(project.id, project.displayName);
    } catch (err) {
      console.error('[asset-review] project selection failed', err);
      notify.error({ title: t`Install failed` });
    }
  };

  // Advanced-mode affordance: once an asset is installed its entity exists, so
  // the modal offers a jump to the SELECTED entity's real view (e.g. the task
  // view). Staged/not-yet-installed → nothing to open, so it's hidden.
  const openSelected = () => {
    const tid = selected.targetTypeId;
    if (!tid?.id) return;
    const pointer = buildDockPointer({ type: tid.type, id: tid.id }, undefined);
    if (pointer) navigation.openDock(DockPointer.rebaseAssetsOntoProject(pointer, attachmentProjectId));
    onClose();
  };

  const spinner = busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null;
  const SelectedIcon = iconFor(selected);
  const multi = ordered.length > 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl" data-testid="asset-review-dialog">
        {/* Per-attachment live subscriptions (render nothing). */}
        {open && ordered.map((a) => <AttachmentLiveSubscriber key={a.id} id={a.id} onUpdate={applyLive} />)}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SelectedIcon className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{selected.name ?? typeWordOf(selected.asset_type)}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
              {typeWordOf(selected.asset_type)}
            </span>
          </DialogTitle>
          {selected.description ? (
            <DialogDescription>{selected.description}</DialogDescription>
          ) : (
            <DialogDescription>
              <Trans>Received attachment — review before installing.</Trans>
            </DialogDescription>
          )}
          <SourceRow ma={selected} />
        </DialogHeader>

        {/* Install header — buttons stay on top. Scope actions batch the whole
            list; Open acts on the selected entity; Select project (when the
            conversation isn't mapped) chooses the install target. */}
        <div className="flex flex-wrap items-center gap-2">
          {selectedIsGit ? (
            <AssetInstallActions attachment={selected} conversationProjectId={attachmentProjectId} />
          ) : (
            <>
              {allProject ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleUninstallAll()}
                  data-testid="asset-uninstall-project"
                >
                  {spinner ?? <Trash2 className="h-3.5 w-3.5" />}
                  <Trans>Uninstall from project</Trans>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || anyUser}
                  title={anyUser ? t`Already installed globally — uninstall first` : undefined}
                  onClick={handleInstallProject}
                  data-testid="asset-install-project"
                >
                  {spinner ?? <FolderDown className="h-3.5 w-3.5" />}
                  <Trans>Install in project</Trans>
                </Button>
              )}
              {userScopeAllowed &&
                (allUser ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleUninstallAll()}
                    data-testid="asset-uninstall-global"
                  >
                    {spinner ?? <Trash2 className="h-3.5 w-3.5" />}
                    <Trans>Uninstall</Trans>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || anyProject}
                    title={anyProject ? t`Already installed in a project — uninstall first` : undefined}
                    onClick={() => void handleInstallGlobal()}
                    data-testid="asset-install-global"
                  >
                    {spinner ?? <Globe className="h-3.5 w-3.5" />}
                    <Trans>Install global</Trans>
                  </Button>
                ))}
            </>
          )}
          {selectedInstalled && (
            <Button size="sm" variant="secondary" onClick={openSelected} data-testid="asset-open-entity">
              <ExternalLink className="h-3.5 w-3.5" />
              <Trans>Open</Trans>
            </Button>
          )}
          {attachmentProjectId == null && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={busy}
              onClick={() => {
                setInstallAfterPick(false);
                setPickerOpen(true);
              }}
              data-testid="asset-select-project"
            >
              <FolderInput className="h-3.5 w-3.5" />
              {selectedProject ? (
                <span className="max-w-[10rem] truncate">{selectedProject.name}</span>
              ) : (
                <Trans>Select project</Trans>
              )}
            </Button>
          )}
        </div>

        {/* Two panes: entity list | selected entity's default content view. */}
        <div className="flex min-h-0 gap-3 border-t border-border pt-3">
          {multi && (
            <div className="max-h-[50vh] w-52 shrink-0 overflow-y-auto border-r border-border pr-2">
              {ordered.map((a) => {
                const r = resolve(a);
                const RowIcon = iconFor(r);
                const isSel = a.id === selectedId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedId(a.id)}
                    title={r.name ?? typeWordOf(r.asset_type)}
                    data-testid={`asset-review-row-${a.id}`}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] transition-colors',
                      isSel ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    <RowIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{r.name ?? typeWordOf(r.asset_type)}</span>
                    {r.effectiveScope != null && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        title={t`Installed`}
                        aria-label={t`Installed`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <StagedAssetViewer attachment={selected} />
          </div>
        </div>

        <ProjectSelectorModal
          open={pickerOpen}
          onOpenChange={(o) => {
            setPickerOpen(o);
            if (!o) setInstallAfterPick(false);
          }}
          projects={projectItems}
          selectedId={null}
          onSelect={(id) => void handlePickProject(id)}
          isLoading={projectsLoading}
          title={t`Install in project`}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Provenance line under the title: where installing pulls the content from. */
function SourceRow({ ma }: { ma: MessageAttachment }) {
  const { label, Icon, detail } = sourceOf(ma);
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="asset-review-source">
      <Icon className="h-3 w-3 shrink-0" />
      <span>
        <Trans>Source:</Trans> {label}
      </span>
      {detail && <span className="truncate font-mono text-[10px]">{detail}</span>}
    </div>
  );
}
