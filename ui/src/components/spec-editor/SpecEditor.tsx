/**
 * Plan Editor - dedicated viewer for plan .md files with action buttons
 * Shows plan content in Milkdown editor with 4 buttons:
 * 1. Execute Plan (clear context) [bypass ON]
 * 2. Execute Plan [bypass ON]
 * 3. Update Plan [based on <plan-note> sections]
 * 4. Cancel - discard changes and navigate back
 *
 * Changes are saved only on execute/update, not automatically.
 *
 * URL format: /dock/plan/agentic_process-<uuid>/<absolute-file-path>
 * The loader (main-loader.ts) sets CurrentProcessTypeId from the URL,
 * so useContext() provides the agenticProcess for FS access and navigation.
 */

import { AgenticProcess, Bookmark, BookmarkType, Plan, QueryRequest, Spec, TypeId, VFSPath } from '@sdk';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { useContext, useEntity } from '@sdk/react/hooks';
import { EditorWithSidePanel } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { Button } from '@src/components/ui/button';
import { useFS } from '@src/hooks/useFS';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { Bookmark as BookmarkIcon, Copy, FolderOpen, Save, Send, ShieldOff, StickyNote, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import './milkdown.css';
import { planNotePlugins } from './plan-note-plugin';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { fileShareSource, genericEntityShareSource } from '@src/hooks/share-sources';

function parseFrontmatter(raw: string): { executed: boolean; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { executed: false, body: raw };
  const executed = /^executed:\s*true$/m.test(m[1]);
  return { executed, body: m[2] };
}

export const SpecEditor: React.FC = () => {
  const { currentDock } = useDockNavigation();
  // Spec-entity mode: routed via /dock/spec/<specId>. Spec content lives on the
  // entity record, not on a plan file, so we render the body via MilkdownEditor
  // wrapped in EditorWithSidePanel (backlinks keyed on the spec TypeId).
  if (currentDock?.viewType === ViewType.SPEC) {
    return <SpecEntityEditor />;
  }
  return <PlanFileEditor />;
};

const PlanFileEditor: React.FC = () => {
  const { t } = useLingui();
  const { agenticProcess } = useContext() as { agenticProcess: AgenticProcess | null };
  const { navigation, currentDock } = useDockNavigation();

  // The plan is addressed by a stable ref in the dock pointer — independent of
  // any (possibly-dead) process: `typeid/plan-<uuid>` or `vfs/<node>/<path>`.
  const parsedRef = useMemo(
    () => (currentDock?.pointer ? DockPointer.parsePlanPointer(currentDock.pointer) : null),
    [currentDock?.pointer],
  );

  // typeid form → resolve the PLAN entity (its asset_ref is the abs file path).
  const planTypeId = useMemo(() => (parsedRef?.kind === 'typeid' ? parsedRef.planTypeId : null), [parsedRef]);
  const { data: plan } = useEntity<Plan>(planTypeId);

  // Resolve the abs file path + the compute node that hosts it, from the ref:
  //  - typeid: path = plan.asset_ref, node = local @local
  //  - vfs:    path = VFSPath.machinePath, node = the vfs compute-node root
  const { filePath, computeNodeTypeId } = useMemo(() => {
    if (parsedRef?.kind === 'vfs') {
      const v = VFSPath.parse(parsedRef.vfsValue);
      return { filePath: v.machinePath, computeNodeTypeId: v.typeId ?? null };
    }
    if (parsedRef?.kind === 'typeid') {
      return { filePath: plan?.asset_ref ?? '', computeNodeTypeId: LOCAL_COMPUTE_NODE };
    }
    return { filePath: '', computeNodeTypeId: null as TypeId | null };
  }, [parsedRef, plan?.asset_ref]);

  const fs = useFS(computeNodeTypeId ?? undefined);

  // Explicit fetch state — `fs.content()` returns null for BOTH "still loading"
  // and "fetch failed", so it can't drive a not-found vs spinner decision on its
  // own. We track the refetch promise outcome to turn an unreadable file into a
  // clear "not found" instead of an infinite spinner.
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');

  // Get file content from cache
  const cached = filePath && computeNodeTypeId ? fs?.content(filePath) : null;
  const fileContent = (cached?.content as string) || '';
  const isDirty = cached?.isDirty || false;

  // Execute/Update target the live process from context — only valid when a
  // process is in context AND it owns THIS plan file (so an unrelated ambient
  // session can't run the wrong plan against this file).
  const canRunPlan = !!agenticProcess && !!filePath && agenticProcess.plan_path === filePath;

  // Frontmatter: strip YAML header from display and read executed flag
  const { executed: isExecuted, body: displayContent } = useMemo(() => parseFrontmatter(fileContent), [fileContent]);

  // State
  const [isExecuting, setIsExecuting] = useState(false);

  // Shared run/update button state — the two Execute buttons and Update Plan all
  // gate on a runnable process; only the trailing title clause differs.
  const executeDisabled = isExecuting || isExecuted || !canRunPlan;
  const updateDisabled = isExecuting || !canRunPlan;
  const executeTitle = (clearContext: boolean) =>
    !canRunPlan
      ? t`Open this plan from its session to run it`
      : isExecuted
        ? t`Plan already executed`
        : clearContext
          ? t`Execute the plan, clearing context first. Full trust mode ON.`
          : t`Execute the plan. Full trust mode ON.`;
  const [showShareDialog, setShowShareDialog] = useState(false);
  // Share the plan like any other entity: the .md file rides as a FILE
  // attachment. No Spec/Task is minted. Stable while the dialog is open.
  const shareSource = useMemo(
    () => (computeNodeTypeId && filePath ? fileShareSource({ computeNodeTypeId, absPath: filePath }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showShareDialog, filePath, computeNodeTypeId?.id],
  );

  // Bookmark state for this plan file
  const [planBookmark, setPlanBookmark] = useState<Bookmark | null>(null);
  useEffect(() => {
    if (!filePath) return;
    void Bookmark.query(new QueryRequest({ type: 'bookmark', query: null, scope: [] })).then((all) =>
      setPlanBookmark(all.find((b) => b.bookmark_type === BookmarkType.PLAN && b.data?.file_path === filePath) ?? null),
    );
  }, [filePath]);

  const handleBookmarkToggle = useCallback(async () => {
    if (planBookmark) {
      await planBookmark.delete();
      setPlanBookmark(null);
    } else if (filePath) {
      // Prefer the stable typeid form when the PLAN entity is resolved; fall
      // back to the (still process-independent) vfs path form otherwise.
      const planPointer = (plan?.typeId ? DockPointer.forPlan(plan.typeId) : DockPointer.forPlanByPath(filePath))
        .pointer;
      const b = new Bookmark({
        bookmark_type: BookmarkType.PLAN,
        title: filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Plan',
        data: { file_path: filePath, navigation_path: `/dock/plan/${planPointer}` },
        status: 'open',
      });
      await b.save([]);
      setPlanBookmark(b);
    }
  }, [planBookmark, filePath, plan?.typeId]);

  // Refetch on nav — Update Plan rewrites the file via the agent. Drives the
  // explicit fetch-state machine: loading → loaded | error. Runs once per
  // (computeNode, filePath) so entity hydration re-renders don't re-toast /
  // re-discard dirty edits.
  const fsRef = useRef(fs);
  fsRef.current = fs;
  const computeNodeId = computeNodeTypeId?.id ?? null;
  useEffect(() => {
    if (!filePath || !computeNodeId || !fsRef.current) return;
    setFetchState('loading');
    void fsRef.current
      .refetch(filePath)
      .then(() => setFetchState('loaded'))
      .catch((error) => {
        console.error('[SpecEditor] Error refetching plan:', filePath, error);
        setFetchState('error');
      });
  }, [filePath, computeNodeId]);

  // Stable onChange ref — MilkdownEditor's useEditor depends on [onChange],
  // so a changing identity would re-initialize the editor and lose focus.
  const onChangeRef = useRef((_v: string) => {});
  onChangeRef.current = (value: string) => {
    if (!filePath || value === fileContent || !fs) return;
    fs.setContent(filePath, value, true);
  };
  const handleContentChange = useCallback((v: string) => onChangeRef.current(v), []);

  // Save dirty content, run an action, then navigate to the process PTY
  const saveAndRun = useCallback(
    (action: () => Promise<void>) => {
      const run = async () => {
        if (!agenticProcess || !filePath) return;
        setIsExecuting(true);
        try {
          if (fs && isDirty) await fs.writeBack(filePath);
          void action();
          navigation.openDock(agenticProcess.terminalDockPointer);
        } catch (error) {
          console.error('[SepcEditor] Error:', error);
        } finally {
          setIsExecuting(false);
        }
      };
      void run();
    },
    [agenticProcess, filePath, fs, isDirty, navigation],
  );

  // Cancel — discard dirty cache and navigate back. Prefer the owning process'
  // terminal; fall back to the inbox when the plan was opened without a process
  // (bookmark / stale link) so Cancel is never a silent no-op.
  const handleCancel = useCallback(() => {
    if (filePath && fs) fs.invalidate(filePath, 'content');
    navigation.openDock(agenticProcess ? agenticProcess.terminalDockPointer : DockPointer.forInbox());
  }, [filePath, fs, agenticProcess, navigation]);

  // File path not yet known. In typeid form the loader already guaranteed the
  // PLAN entity exists, so an empty path just means it's still hydrating →
  // a brief spinner (never an infinite one: a missing entity is a render_error
  // page from the loader, a missing file is the `error` state below).
  if (!filePath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {/* Always offer a way out: a plan pointer that never resolves to a file
            path (stale bookmark / mis-minted vfs pointer with no sub-path) would
            otherwise strand the user on an infinite spinner with no close. */}
        <Button size="sm" variant="outline" onClick={handleCancel} title={t`Go back`}>
          <X className="me-2 h-4 w-4" />
          <Trans>Go back</Trans>
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* File path header */}
      <div className="flex items-center gap-1.5 border-b border-border bg-background/80 px-4 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate" title={filePath}>
          {filePath}
        </span>
        <button
          type="button"
          title={t`Copy path`}
          className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
          onClick={() => void navigator.clipboard.writeText(filePath)}
        >
          <Copy className="h-3 w-3" />
        </button>
        <button
          type="button"
          title={t`Show in folder (selects file for drag-and-drop)`}
          className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={!computeNodeTypeId}
          onClick={() => {
            if (!computeNodeTypeId) return;
            void openExternalFromComputeNode(computeNodeTypeId.id, filePath, { select: true });
          }}
        >
          <FolderOpen className="h-3 w-3" />
        </button>
        <span className="flex-1" />
      </div>

      {/* Top action bar */}
      <div className="border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-2">
          {/* Execute Plan (clear context) */}
          <Button
            size="sm"
            variant="outline"
            disabled={executeDisabled}
            onClick={() => saveAndRun(() => agenticProcess!.executePlan(filePath, { clearContext: true }))}
            title={executeTitle(true)}
            className={cn(executeDisabled && 'opacity-50')}
          >
            <ShieldOff className="me-2 h-4 w-4 text-amber-500" />
            <Trans>Execute Plan (clear context)</Trans>
          </Button>

          {/* Execute Plan [bypass ON] */}
          <Button
            size="sm"
            variant="outline"
            disabled={executeDisabled}
            onClick={() => saveAndRun(() => agenticProcess!.executePlan(filePath, { clearContext: false }))}
            title={executeTitle(false)}
            className={cn(executeDisabled && 'opacity-50')}
          >
            <ShieldOff className="me-2 h-4 w-4 text-amber-500" />
            <Trans>Execute Plan</Trans>
          </Button>

          {/* Update Plan */}
          <Button
            size="sm"
            variant="outline"
            disabled={updateDisabled}
            onClick={() => saveAndRun(() => agenticProcess!.updatePlan(filePath))}
            title={
              !canRunPlan
                ? t`Open this plan from its session to update it`
                : t`Update plan based on <plan-note> sections`
            }
            className={cn(updateDisabled && 'opacity-50')}
          >
            <StickyNote className="me-2 h-4 w-4" />
            <Trans>Update Plan</Trans>
          </Button>

          {/* Share — the plan file rides as a plain file attachment */}
          <Button
            size="sm"
            variant="outline"
            disabled={isExecuting || !computeNodeTypeId || !filePath}
            onClick={() => setShowShareDialog(true)}
            title={t`Share this plan with someone`}
          >
            <Send className="me-2 h-4 w-4" />
            <Trans>Share</Trans>
          </Button>

          {/* Cancel */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isExecuting}
            onClick={handleCancel}
            title={t`Discard changes and go back`}
          >
            <X className="me-2 h-4 w-4" />
            <Trans>Cancel</Trans>
          </Button>

          {/* Bookmark toggle — icon-only, pushed to the right */}
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto h-8 w-8 p-0"
            onClick={() => void handleBookmarkToggle()}
            title={planBookmark ? t`Remove bookmark` : t`Bookmark this plan`}
          >
            <BookmarkIcon className={cn('h-4 w-4', planBookmark && 'fill-current text-primary')} />
          </Button>
        </div>
      </div>

      {shareSource && (
        <ShareToConversationDialog
          open={showShareDialog}
          onClose={() => setShowShareDialog(false)}
          source={shareSource}
        />
      )}

      {/* Editor body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="plan-milkdown-editor">
          {cached ? (
            <MilkdownEditor
              content={displayContent}
              onChange={handleContentChange}
              editorMode="editor"
              plugins={planNotePlugins}
            />
          ) : fetchState === 'error' ? (
            // The file couldn't be read (deleted on disk, unreadable). Clear
            // message instead of an infinite spinner.
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <div className="text-base font-semibold text-foreground">
                <Trans>Plan file not found</Trans>
              </div>
              <div className="font-mono text-xs">{filePath}</div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Spec-entity mode renderer. Loads a Spec by id from the dock pointer and
 * shows its body in MilkdownEditor wrapped in EditorWithSidePanel — same
 * editing surface as workflow / markdown asset views, with chat + backlinks
 * keyed on the spec TypeId.
 *
 * Edits stay in local state and only commit to the entity on an explicit
 * Save click — autosave-on-every-keystroke would race itself into a storm
 * of overlapping PUTs and a stuck ref status.
 */
const SpecEntityEditor: React.FC = () => {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const specId = useMemo(() => {
    const head = currentDock?.pointer?.split('/')[0];
    return head || null;
  }, [currentDock?.pointer]);

  const specTypeId = useMemo(() => (specId ? new TypeId(Spec.type, specId) : null), [specId]);
  const { data: spec } = useEntity<Spec>(specTypeId);

  const [localContent, setLocalContent] = useState<string | null>(null);
  useEffect(() => {
    if (spec?.content != null && localContent == null) setLocalContent(spec.content);
  }, [spec?.content, localContent]);

  // Edits only update local state — no spec.content mutation, no spec.save().
  // Saving is explicit via the Save button below.
  const handleContentChange = useCallback((v: string) => setLocalContent(v), []);

  const [showShareDialog, setShowShareDialog] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Share the spec like any other entity — it rides as a TYPE_ID attachment.
  // No Task is minted. Stable while the dialog is open (resolve-once reset).
  const shareSource = useMemo(
    () => (specTypeId ? genericEntityShareSource(specTypeId, { typeLabel: 'PLAN' }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showShareDialog, specTypeId?.id],
  );

  const isDirty = !!spec && localContent != null && localContent !== spec.content;

  const handleSave = useCallback(async () => {
    if (!spec || localContent == null || localContent === spec.content) return;
    setIsSaving(true);
    try {
      spec.content = localContent;
      await spec.save();
    } catch (e) {
      console.error('[SpecEntityEditor] save failed', e);
    } finally {
      setIsSaving(false);
    }
  }, [spec, localContent]);

  if (!specId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>No spec specified.</Trans>
      </div>
    );
  }
  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading spec…</Trans>
      </div>
    );
  }

  const chatTarget = specTypeId?.toString() ?? null;

  return (
    <div className="relative flex h-full flex-col">
      {/* Top action bar — same shape as PlanFileEditor's, with only the
          buttons that apply to a Spec record (no filePath / no AgenticProcess
          means Execute Plan / Update Plan / Bookmark are skipped). */}
      <div className="border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            title={isDirty ? t`Save changes` : t`No unsaved changes`}
          >
            <Save className="me-2 h-4 w-4" />
            {isSaving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowShareDialog(true)}
            title={t`Share this plan with someone`}
          >
            <Send className="me-2 h-4 w-4" />
            <Trans>Share</Trans>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigation.openDock(DockPointer.forInbox())}
            title={isDirty ? t`Discard unsaved changes and go back to inbox` : t`Go back to inbox`}
          >
            <X className="me-2 h-4 w-4" />
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </div>

      {shareSource && (
        <ShareToConversationDialog
          open={showShareDialog}
          onClose={() => setShowShareDialog(false)}
          source={shareSource}
        />
      )}

      <div className="min-h-0 flex-1">
        <EditorWithSidePanel target={chatTarget}>
          <div className="plan-milkdown-editor h-full overflow-auto">
            <MilkdownEditor content={localContent ?? ''} onChange={handleContentChange} editorMode="editor" />
          </div>
        </EditorWithSidePanel>
      </div>
    </div>
  );
};
