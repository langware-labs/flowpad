import { dataManager, MessageAttachment, Project, TypeId } from '@sdk';
import { gitOriginCloneUrl, type GitOrigin } from '@sdk/models/GitOrigin';
import { useEntity } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Cloud, ExternalLink, File, FolderDown, GitBranch, Globe, Loader2, Package, Trash2 } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { editorForType } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';
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

/** Invisible per-attachment subscription to the underlying ASSET entity, used
 *  only to read its `parent_id` (tasks) so the left list can nest a child under
 *  its parent. Files (no entity) pass `typeId=null` and report no parent. */
function AssetParentSubscriber({
  maId,
  typeId,
  onParent,
}: {
  maId: string;
  typeId: TypeId | null;
  onParent: (maId: string, parentAssetId: string | null) => void;
}) {
  const { data } = useEntity<{ parent_id?: string | null }>(typeId);
  const parentAssetId = data?.parent_id ? String(data.parent_id) : null;
  useEffect(() => {
    onParent(maId, parentAssetId);
  }, [maId, parentAssetId, onParent]);
  return null;
}

/**
 * The selected attachment's content pane. As soon as the asset's entity resolves
 * with a readable `asset_ref` — which for a task happens at unpack, BEFORE any
 * install — we render that entity's own viewer via {@link AssetEditorRouter}
 * (task → task view, skill → skill view, …). We deliberately do NOT gate on
 * install scope: a staged task shows the task viewer straightaway. Only when no
 * entity/asset_ref is resolvable yet (e.g. a staged skill not materialized until
 * install, or a raw file) do we fall back to the raw staged-file preview.
 */
function SelectedEntityViewer({ attachment }: { attachment: MessageAttachment }) {
  const typeId = attachment.asset_type === 'file' ? null : attachment.targetTypeId;
  const editor = typeId ? editorForType(typeId.type) : undefined;
  const { data } = useEntity<{ asset_ref?: string | null }>(typeId);
  if (typeId && editor && data?.asset_ref) {
    const pointer = AssetDocPointer.forTypeId(editor, typeId).toPointer();
    return (
      <div className="h-[55vh] overflow-hidden rounded border border-border">
        <AssetEditorRouter key={pointer} pointer={pointer} />
      </div>
    );
  }
  return <StagedAssetViewer attachment={attachment} />;
}

/**
 * Review modal for a received message's staged attachments (opened from a
 * dashed conversation chip). Two panes: a left rail listing every entity
 * attached to the message — nested as a shallow tree, a child (task with a
 * `parent_id` pointing at a sibling) indented under its parent — with the
 * clicked one selected by default; and a right pane showing the selected
 * entity's OWN viewer (task view, skill view, …) for installed assets, or a
 * bare staged-file preview for not-yet-installed ones ({@link SelectedEntityViewer}).
 *
 * The install header stays on top. Install / Uninstall act on the WHOLE list
 * (batch): "Install in project" installs every attachment into the target
 * project, "Install global" into the user scope. "Open" jumps to the currently
 * selected entity's view. When the conversation isn't mapped to a project,
 * "Install in project" opens the same picker switch-project uses to choose the
 * target, then installs.
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
   *  null, "Install in project" opens the picker to choose one. */
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

  // maId → its asset entity's parent_id (tasks). Drives left-list nesting.
  const [parentByMa, setParentByMa] = useState<Map<string, string | null>>(new Map());
  const applyParent = useCallback((maId: string, parentAssetId: string | null) => {
    setParentByMa((prev) => {
      if (prev.get(maId) === parentAssetId) return prev;
      const next = new Map(prev);
      next.set(maId, parentAssetId);
      return next;
    });
  }, []);

  const [selectedId, setSelectedId] = useState(initialAttachmentId);
  // Reopening the dialog (or clicking a different chip) re-pins the clicked one.
  useEffect(() => {
    if (open) setSelectedId(initialAttachmentId);
  }, [open, initialAttachmentId]);

  const selected = resolve(ordered.find((a) => a.id === selectedId) ?? ordered[0] ?? attachments[0]);
  const liveOrdered = useMemo(() => ordered.map(resolve), [ordered, resolve]);

  // Left-list rows as a shallow tree: a child (its entity's `parent_id` points at
  // another attachment in the list) is nested one level under that parent. The
  // clicked attachment's root group is kept first so the selection stays near the
  // top; everything else follows in arrival order.
  const rows = useMemo<{ a: MessageAttachment; depth: number }[]>(() => {
    const byAssetId = new Map<string, MessageAttachment>();
    for (const a of ordered) byAssetId.set(String(a.asset_id ?? ''), a);
    const parentMaOf = (a: MessageAttachment): string | null => {
      const pAsset = parentByMa.get(a.id);
      if (!pAsset) return null;
      const pMa = byAssetId.get(pAsset);
      return pMa && pMa.id !== a.id ? pMa.id : null;
    };
    const rootOf = (a: MessageAttachment): MessageAttachment => {
      let cur = a;
      const guard = new Set<string>();
      while (!guard.has(cur.id)) {
        guard.add(cur.id);
        const pid = parentMaOf(cur);
        const p = pid ? ordered.find((x) => x.id === pid) : null;
        if (!p) break;
        cur = p;
      }
      return cur;
    };
    const roots = ordered.filter((a) => !parentMaOf(a));
    const clickedRoot = rootOf(ordered.find((a) => a.id === selectedId) ?? ordered[0] ?? attachments[0]);
    const orderedRoots = clickedRoot ? [clickedRoot, ...roots.filter((r) => r.id !== clickedRoot.id)] : roots;
    const out: { a: MessageAttachment; depth: number }[] = [];
    const seen = new Set<string>();
    for (const r of orderedRoots) {
      if (seen.has(r.id)) continue;
      out.push({ a: r, depth: 0 });
      seen.add(r.id);
      for (const c of ordered)
        if (parentMaOf(c) === r.id && !seen.has(c.id)) {
          out.push({ a: c, depth: 1 });
          seen.add(c.id);
        }
    }
    for (const a of ordered) if (!seen.has(a.id)) out.push({ a, depth: 0 });
    return out;
  }, [ordered, parentByMa, selectedId, attachments]);

  // Non-git attachments are the ones the project/global scope buttons act on;
  // git rows install through their own Download/Setup flow (AssetInstallActions).
  const installable = useMemo(() => liveOrdered.filter((a) => !isGitAttachment(a)), [liveOrdered]);

  // Install target: the conversation mapping wins; otherwise the project the
  // user picks through the switch-project dialog on "Install in project".
  const [selectedProject, setSelectedProject] = useState<{ id: string; name: string } | null>(null);
  const targetProjectId = attachmentProjectId ?? selectedProject?.id ?? null;

  // Which scope action is in flight — ONLY that button spins; the others just
  // disable. A single `busy` boolean made every button spin at once.
  const [busyAction, setBusyAction] = useState<null | 'project' | 'global' | 'uninstall'>(null);
  const busy = busyAction != null;
  const [pickerOpen, setPickerOpen] = useState(false);

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
    setBusyAction('project');
    try {
      for (const a of installable) await a.install('project', projectId);
      notify.success({ title: t`Installed in project`, message: name ?? '' });
    } catch (err) {
      console.error('[asset-review] batch project install failed', err);
      notify.error({ title: t`Install failed` });
    } finally {
      setBusyAction(null);
    }
  };

  const handleInstallProject = () => {
    if (targetProjectId) {
      void installAllToProject(targetProjectId, selectedProject?.name);
      return;
    }
    // No target yet — open the switch-project dialog (Open folder / Create new
    // included) and install once a project is picked (handleProjectPicked).
    setPickerOpen(true);
  };

  const handleInstallGlobal = async () => {
    setBusyAction('global');
    try {
      for (const a of installable) await a.install('user');
      notify.success({ title: t`Installed`, message: t`${installable.length} attachments` });
    } catch (err) {
      console.error('[asset-review] batch global install failed', err);
      notify.error({ title: t`Install failed` });
    } finally {
      setBusyAction(null);
    }
  };

  const handleUninstallAll = async () => {
    setBusyAction('uninstall');
    try {
      for (const a of installable) if (a.effectiveScope != null) await a.uninstall();
      notify.success({ title: t`Uninstalled` });
    } catch (err) {
      console.error('[asset-review] batch uninstall failed', err);
      notify.error({ title: t`Uninstall failed` });
    } finally {
      setBusyAction(null);
    }
  };

  // Chosen via OpenProjectComponent (project row / Open folder / Create new) —
  // remember it as the target and install the whole list into it.
  const handleProjectPicked = async (project: Project) => {
    if (!project.id) return;
    setSelectedProject({ id: project.id, name: project.displayName });
    await installAllToProject(project.id, project.displayName);
  };

  // Advanced-mode affordance: once an asset is installed its entity exists, so
  // the modal offers a jump to the SELECTED entity's real view (e.g. the task
  // view). Staged/not-yet-installed → nothing to open, so it's hidden.
  const openSelected = async () => {
    const tid = selected.targetTypeId;
    if (!tid?.id) return;
    // Resolve the entity rather than hand `buildDockPointer` a {type, id} stub.
    // Most types need nothing more — they open by TypeId and the loader resolves
    // them — but a transcript is addressed by its FILE, so a stub silently
    // dropped its `asset_ref` and every install-then-Open fell through to the
    // session-id form, which cannot resolve on a machine that never ran the
    // session. Fetching here costs one request on an explicit click.
    const entity = await dataManager.getByTypeId<{ type: string; id: string }>(tid).catch(() => null);
    const pointer = buildDockPointer(entity ?? { type: tid.type, id: tid.id }, undefined);
    if (pointer) navigation.openDock(DockPointer.rebaseAssetsOntoProject(pointer, attachmentProjectId));
    onClose();
  };

  // Spinner ONLY on the button whose action is running — others just disable.
  const spinnerFor = (action: 'project' | 'global' | 'uninstall') =>
    busyAction === action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null;
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
        {/* Per-attachment subscriptions (render nothing): live MA row + the
            asset entity's parent_id for left-list nesting. */}
        {open && ordered.map((a) => <AttachmentLiveSubscriber key={`ma:${a.id}`} id={a.id} onUpdate={applyLive} />)}
        {open &&
          ordered.map((a) => (
            <AssetParentSubscriber
              key={`parent:${a.id}`}
              maId={a.id}
              typeId={a.asset_type === 'file' ? null : a.targetTypeId}
              onParent={applyParent}
            />
          ))}
        <DialogHeader>
          {/* Whole-popup title — the per-entity icon/name/type moved down to the
              selected-entity pane. Singular vs plural tracks the list size. */}
          <DialogTitle className="font-bold">
            {multi ? (
              <Trans>Received attachments — review before installing.</Trans>
            ) : (
              <Trans>Received attachment — review before installing.</Trans>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Review each attached asset and choose how to install it.</Trans>
          </DialogDescription>
        </DialogHeader>

        {/* Install header — buttons stay on top. Scope actions batch the whole
            list; Open acts on the selected entity. When no project is mapped,
            "Install in project" opens the picker to choose the target. */}
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
                  {spinnerFor('uninstall') ?? <Trash2 className="h-3.5 w-3.5" />}
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
                  {spinnerFor('project') ?? <FolderDown className="h-3.5 w-3.5" />}
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
                    {spinnerFor('uninstall') ?? <Trash2 className="h-3.5 w-3.5" />}
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
                    {spinnerFor('global') ?? <Globe className="h-3.5 w-3.5" />}
                    <Trans>Install global</Trans>
                  </Button>
                ))}
            </>
          )}
          {selectedInstalled && (
            <Button size="sm" variant="secondary" onClick={() => void openSelected()} data-testid="asset-open-entity">
              <ExternalLink className="h-3.5 w-3.5" />
              <Trans>Open</Trans>
            </Button>
          )}
        </div>

        {/* Two panes: entity list | selected entity's default content view. */}
        <div className="flex min-h-0 gap-3 border-t border-border pt-3">
          {multi && (
            <div className="max-h-[55vh] w-52 shrink-0 overflow-y-auto border-r border-border pr-2">
              {rows.map(({ a, depth }) => {
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
                    style={depth ? { paddingLeft: `${depth * 0.875 + 0.375}rem` } : undefined}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] transition-colors',
                      isSel ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                    )}
                  >
                    {depth > 0 && <span className="shrink-0 text-muted-foreground/50">└</span>}
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
            {/* Selected-entity header — icon, name and type chip, plus its
                description and provenance. Changes as the list selection moves. */}
            <div className="mb-3 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <SelectedIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate font-semibold">{selected.name ?? typeWordOf(selected.asset_type)}</span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                  {typeWordOf(selected.asset_type)}
                </span>
              </div>
              {selected.description && <p className="text-[12px] text-muted-foreground">{selected.description}</p>}
              <SourceRow ma={selected} />
            </div>
            <SelectedEntityViewer attachment={selected} />
          </div>
        </div>

        <OpenProjectComponent
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPicked={(project) => void handleProjectPicked(project)}
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
