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

import { useContext } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useFS } from '@src/hooks/useFS';
import { useShell } from '@src/hooks/useShell';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { planNotePlugins } from './plan-note-plugin';
import { Button } from '@src/components/ui/button';
import { SendPlanNotificationDialog } from './SendPlanNotificationDialog';
import { Bookmark as BookmarkIcon, Copy, Send, ShieldOff, StickyNote, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@src/lib/utils';
import { AgenticProcess, Bookmark, QueryRequest } from '@sdk';
import './milkdown.css';

function parseFrontmatter(raw: string): { executed: boolean; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { executed: false, body: raw };
  const executed = /^executed:\s*true$/m.test(m[1]);
  return { executed, body: m[2] };
}

export const PlanEditor: React.FC = () => {
  const { agenticProcess } = useContext() as { agenticProcess: AgenticProcess | null };
  const { navigation, currentDock } = useDockNavigation();

  // Extract file path from the dock pointer
  // Pointer format: "agentic_process-<uuid>/<absolute-file-path>"
  const filePath = useMemo(
    () => currentDock?.pointer ? DockPointer.parsePlanPointer(currentDock.pointer)?.filePath ?? '' : '',
    [currentDock?.pointer],
  );
  const { shell } = useShell(agenticProcess?.shell_id);

  const computeNodeTypeId = useMemo(() => shell?.computeNodeTypeId ?? null, [shell?.compute_node_id]);
  const fs = useFS(computeNodeTypeId);

  // Get file content from cache
  const cached = filePath && computeNodeTypeId ? fs?.content(filePath) : null;
  const fileContent = (cached?.content as string) || '';
  const isDirty = cached?.isDirty || false;

  // Frontmatter: strip YAML header from display and read executed flag
  const { executed: isExecuted, body: displayContent } = useMemo(
    () => parseFrontmatter(fileContent),
    [fileContent],
  );

  // State
  const [isExecuting, setIsExecuting] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);

  // Bookmark state for this plan file
  const [planBookmark, setPlanBookmark] = useState<Bookmark | null>(null);
  useEffect(() => {
    if (!filePath) return;
    void Bookmark.query(new QueryRequest({ type: 'bookmark', query: null, scope: [] })).then((all) =>
      setPlanBookmark(all.find((b) => b.bookmark_type === 'plan' && b.data?.file_path === filePath) ?? null),
    );
  }, [filePath]);

  const handleBookmarkToggle = useCallback(async () => {
    if (planBookmark) {
      await planBookmark.delete();
      setPlanBookmark(null);
    } else if (agenticProcess) {
      const pointer = `${agenticProcess.typeId.toString()}/${filePath}`;
      const b = new Bookmark({
        bookmark_type: 'plan',
        title: filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Plan',
        data: { file_path: filePath, navigation_path: `/dock/plan/${pointer}` },
        status: 'open',
      });
      await b.save([]);
      setPlanBookmark(b);
    }
  }, [planBookmark, filePath, agenticProcess]);

  // Auto-download file content if not cached
  useEffect(() => {
    if (!filePath || !computeNodeTypeId) return;
    if (cached) return;

    const downloadContent = async () => {
      if (!fs) return;
      try {
        await fs.download(filePath, false);
      } catch (error) {
        console.error('[PlanEditor] Error downloading plan:', filePath, error);
      }
    };

    void downloadContent();
  }, [filePath, computeNodeTypeId, cached, fs]);

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
          navigation.openDock(agenticProcess.dockPointer);
        } catch (error) {
          console.error('[PlanEditor] Error:', error);
        } finally {
          setIsExecuting(false);
        }
      };
      void run();
    },
    [agenticProcess, filePath, fs, isDirty, navigation],
  );

  // Cancel — discard dirty cache and navigate back
  const handleCancel = useCallback(() => {
    if (filePath && fs) fs.invalidate(filePath, 'content');
    if (agenticProcess) navigation.openDock(agenticProcess.dockPointer);
  }, [filePath, fs, agenticProcess, navigation]);

  if (!filePath || !agenticProcess) {
    const message = !filePath && !agenticProcess
      ? 'No plan file or agentic process'
      : !filePath ? 'No plan file selected' : 'No agentic process in context';
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div>{message}</div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* File path header */}
      <div className="flex items-center gap-1.5 border-b border-border bg-background/80 px-4 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="flex-1 truncate" title={filePath}>{filePath}</span>
        <button
          type="button"
          title="Copy path"
          className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
          onClick={() => void navigator.clipboard.writeText(filePath)}
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>

      {/* Top action bar */}
      <div className="border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-2">
          {/* Execute Plan (clear context) */}
          <Button
            size="sm"
            variant="outline"
            disabled={isExecuting || isExecuted}
            onClick={() => saveAndRun(() => agenticProcess.executePlan(filePath, { clearContext: true }))}
            title={isExecuted ? 'Plan already executed' : 'Execute the plan, clearing context first. Full trust mode ON.'}
            className={cn((isExecuting || isExecuted) && 'opacity-50')}
          >
            <ShieldOff className="mr-2 h-4 w-4 text-amber-500" />
            Execute Plan (clear context)
          </Button>

          {/* Execute Plan [bypass ON] */}
          <Button
            size="sm"
            variant="outline"
            disabled={isExecuting || isExecuted}
            onClick={() => saveAndRun(() => agenticProcess.executePlan(filePath, { clearContext: false }))}
            title={isExecuted ? 'Plan already executed' : 'Execute the plan. Full trust mode ON.'}
            className={cn((isExecuting || isExecuted) && 'opacity-50')}
          >
            <ShieldOff className="mr-2 h-4 w-4 text-amber-500" />
            Execute Plan
          </Button>

          {/* Update Plan */}
          <Button
            size="sm"
            variant="outline"
            disabled={isExecuting}
            onClick={() => saveAndRun(() => agenticProcess.updatePlan(filePath))}
            title="Update plan based on <plan-note> sections"
            className={cn(isExecuting && 'opacity-50')}
          >
            <StickyNote className="mr-2 h-4 w-4" />
            Update Plan
          </Button>

          {/* Share as Task */}
          <Button
            size="sm"
            variant="outline"
            disabled={isExecuting}
            onClick={() => setShowShareDialog(true)}
            title="Package this plan as a spec and share it as a task with someone"
          >
            <Send className="mr-2 h-4 w-4" />
            Share as Task
          </Button>

          {/* Cancel */}
          <Button
            size="sm"
            variant="ghost"
            disabled={isExecuting}
            onClick={handleCancel}
            title="Discard changes and go back"
          >
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>

          {/* Bookmark toggle — icon-only, pushed to the right */}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-8 w-8 p-0"
            onClick={() => void handleBookmarkToggle()}
            title={planBookmark ? 'Remove bookmark' : 'Bookmark this plan'}
          >
            <BookmarkIcon className={cn('h-4 w-4', planBookmark && 'fill-current text-primary')} />
          </Button>
        </div>
      </div>

      <SendPlanNotificationDialog
        open={showShareDialog}
        onClose={() => setShowShareDialog(false)}
        planFilePath={filePath}
        planContent={fileContent}
        workdir={agenticProcess?.workdir}
      />

      {/* Editor body */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="plan-milkdown-editor">
          {cached ? (
            <MilkdownEditor content={displayContent} onChange={handleContentChange} readOnly={false} plugins={planNotePlugins} />
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
