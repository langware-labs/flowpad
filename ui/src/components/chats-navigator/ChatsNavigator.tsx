import { useCallback, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AgenticProcess } from '@sdk';
import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProject } from '@src/hooks/useProject';
import { useContext } from '@src/hooks/useContext';
import { notify } from '@src/notifications';
import { defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import type { WorkerHistoryEntry, WorkerType } from '@src/hooks/useWorkerHistory';
import { pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { terminalProfile } from '@src/components/spotlight/profiles';
import { useChatHistory } from './useChatHistory';
import { ChatsFilterBar } from './ChatsFilterBar';
import { ChatsList } from './ChatsList';

/**
 * Chats left-menu — the navigator (Zone B) for the Shell/chat view. Lists past
 * chats (the existing worker-history list) grouped into time buckets, with the
 * scope filter pinned in the header like every other side menu (Assets/Triggers).
 * Clicking a chat opens/resumes it by `worker_id` via the `getByWorkerId` heal
 * (URL-first); star and delete are per-row side effects. Implements the planned
 * `navigatorRegistry: [ViewType.SHELL]: ChatsNavigator`.
 */
export function ChatsNavigator() {
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useProject();
  const { activeTerminalTargetTypeId } = useContext();
  const { resumeInTerminal } = useResumeInTerminal();
  const isAdvanced = useIsAdvanced();
  const { t } = useLingui();

  const [pendingDelete, setPendingDelete] = useState<{
    workerId: string;
    workerType: string | null;
    processId: string | null;
    title: string;
  } | null>(null);

  const scope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );

  const filters = useMemo(() => ({ scope, search: '' }), [scope]);
  const { buckets, total, isLoading, refetch } = useChatHistory(filters);

  // Active row = the process the Shell URL currently targets (URL-first).
  const activeProcessId =
    activeTerminalTargetTypeId?.type === AgenticProcess.type ? activeTerminalTargetTypeId.id : null;

  const handleScopeChange = useCallback(
    (next: ScopeFilter) => {
      const base = currentDock ?? DockPointer.forShell();
      navigation.openDock(base.withScopeFilter(next));
    },
    [currentDock, navigation],
  );

  // Open/resume by the durable `worker_id` (the on-disk session), NOT the
  // lazily-materialized AgenticProcess entity: `getByWorkerId` heals/materializes
  // the process from the transcript and attaches the live PTY. Gating on
  // `agentic_process_id` stranded on-disk-resumable sessions never opened through
  // this instance; it's now only a render hint (active-row highlight / favorite).
  const handleSelect = useCallback(
    (entry: WorkerHistoryEntry) => {
      if (!entry.worker_id) {
        notify.error({ title: t`Cannot open`, message: t`This chat has no resumable session.` });
        return;
      }
      resumeInTerminal(entry.worker_id, undefined, undefined, entry.worker_type);
    },
    [resumeInTerminal],
  );

  const handleToggleFavorite = useCallback((entry: WorkerHistoryEntry) => {
    const id = entry.agentic_process_id;
    if (!id) return;
    const process = AgenticProcess.getByIdFromCache<AgenticProcess>(id);
    if (!process) return;
    process.favorite_index = process.favorite_index != null ? null : Date.now();
    void process.save().catch((err) => {
      console.error('[ChatsNavigator] favorite toggle failed', err);
      notify.error({ title: t`Could not update`, message: err instanceof Error ? err.message : String(err) });
    });
  }, []);

  // Delete keys off the durable `worker_id` (the on-disk session), NOT the
  // lazily-materialized AgenticProcess entity — same identity inversion the open
  // path already fixed. Gating on `agentic_process_id` made any chat never opened
  // through this instance (agentic_process_id == null) undeletable: the dialog
  // never opened. The process id is kept only as a fast-path cache hint.
  const requestDelete = useCallback((entry: WorkerHistoryEntry) => {
    if (!entry.worker_id) return;
    const process = entry.agentic_process_id
      ? AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id)
      : null;
    setPendingDelete({
      workerId: entry.worker_id,
      workerType: entry.worker_type,
      processId: entry.agentic_process_id,
      title: pickHistoryTitle(process, entry),
    });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { processId, workerId, workerType } = pendingDelete;
    setPendingDelete(null);
    try {
      // Prefer the cached entity; for on-disk-only sessions resolve the durable
      // worker_id through the heal (`getByWorkerId`), exactly like the open path.
      // `delete()` tombstones the transcript, so the worker-history entry — which
      // both read paths re-derive from that file — disappears too.
      const process =
        (processId ? AgenticProcess.getByIdFromCache<AgenticProcess>(processId) : null) ??
        (await AgenticProcess.getByWorkerId(workerId, workerType));
      if (!process) return;
      await process.delete();
      refetch();
    } catch (err) {
      console.error('[ChatsNavigator] delete failed', err);
      notify.error({ title: t`Could not delete`, message: err instanceof Error ? err.message : String(err) });
    }
  }, [pendingDelete, refetch]);

  const handleNewChat = useCallback(
    (worker: WorkerType) => {
      // `claude` is the `claude_code` harness; codex/copilot map 1:1.
      const workerType = worker === 'claude' ? 'claude_code' : worker;
      // Standard → headless chat (no PTY); Advanced → interactive PTY terminal.
      void AgenticProcess.openTab(workerType, undefined, null, { ptyMode: isAdvanced }).catch((err) => {
        console.error('[ChatsNavigator] new chat failed', err);
        notify.error({ title: t`Could not start chat`, message: err instanceof Error ? err.message : String(err) });
      });
    },
    [isAdvanced],
  );

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'chats',
      header: {
        title: t`Chats`,
        countBadge: total,
        headerRight: (
          <ScopeFilterIconBar
            scope={scope}
            currentProjectId={project?.id ?? null}
            currentProjectName={project?.getDisplayName() ?? project?.name ?? null}
            onScopeChange={handleScopeChange}
          />
        ),
        filterBar: <ChatsFilterBar onNewChat={handleNewChat} />,
      },
      search: {
        recordTypes: terminalProfile.allowedEntityTypes ?? [],
        scope,
        routeViaTerminal: true,
        placeholder: t`Search chats…`,
      },
      customBody: (
        <ChatsList
          buckets={buckets}
          isLoading={isLoading}
          activeProcessId={activeProcessId}
          onSelect={handleSelect}
          onToggleFavorite={handleToggleFavorite}
          onDelete={requestDelete}
        />
      ),
    }),
    [
      total,
      handleNewChat,
      scope,
      project,
      handleScopeChange,
      buckets,
      isLoading,
      activeProcessId,
      handleSelect,
      handleToggleFavorite,
      requestDelete,
    ],
  );

  return (
    <>
      <NavigatorPanel descriptor={descriptor} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t`Delete chat?`}
        description={t`"${pendingDelete?.title ?? ''}" will be removed. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
