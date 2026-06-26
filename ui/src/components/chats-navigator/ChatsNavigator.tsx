import { useCallback, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
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
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
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

  const [search, setSearch] = useState('');
  const [workers, setWorkers] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  const scope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? defaultScopeFilter(project?.id ?? null),
    [currentDock, project?.id],
  );

  const filters = useMemo(
    () => ({ scope, search, workers, favoritesOnly }),
    [scope, search, workers, favoritesOnly],
  );
  const { buckets, total, isLoading } = useChatHistory(filters);

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

  const toggleWorker = useCallback((value: string) => {
    setWorkers((prev) => (prev.includes(value) ? prev.filter((w) => w !== value) : [...prev, value]));
  }, []);

  // Open/resume by the durable `worker_id` (the on-disk session), NOT the
  // lazily-materialized AgenticProcess entity: `getByWorkerId` heals/materializes
  // the process from the transcript and attaches the live PTY. Gating on
  // `agentic_process_id` stranded on-disk-resumable sessions never opened through
  // this instance; it's now only a render hint (active-row highlight / favorite).
  const handleSelect = useCallback(
    (entry: WorkerHistoryEntry) => {
      if (!entry.worker_id) {
        notify.error({ title: 'Cannot open', message: 'This chat has no resumable session.' });
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
      notify.error({ title: 'Could not update', message: err instanceof Error ? err.message : String(err) });
    });
  }, []);

  const requestDelete = useCallback((entry: WorkerHistoryEntry) => {
    if (!entry.agentic_process_id) return;
    const process = AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id);
    setPendingDelete({ id: entry.agentic_process_id, title: pickHistoryTitle(process ?? null, entry) });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const process = AgenticProcess.getByIdFromCache<AgenticProcess>(pendingDelete.id);
    setPendingDelete(null);
    if (!process) return;
    try {
      await process.delete();
    } catch (err) {
      console.error('[ChatsNavigator] delete failed', err);
      notify.error({ title: 'Could not delete', message: err instanceof Error ? err.message : String(err) });
    }
  }, [pendingDelete]);

  const handleNewChat = useCallback(() => {
    void AgenticProcess.openTab('claude_code').catch((err) => {
      console.error('[ChatsNavigator] new chat failed', err);
      notify.error({ title: 'Could not start chat', message: err instanceof Error ? err.message : String(err) });
    });
  }, []);

  const descriptor: NavigatorDescriptor = useMemo(
    () => ({
      id: 'chats',
      header: {
        title: 'Chats',
        countBadge: total,
        toolbar: [
          {
            id: 'new-chat',
            icon: <Plus className="h-4 w-4" />,
            label: 'New chat',
            run: handleNewChat,
            visibleWhen: 'always',
          },
        ],
        filterBar: (
          <ChatsFilterBar
            search={search}
            onSearchChange={setSearch}
            scope={scope}
            currentProjectId={project?.id ?? null}
            currentProjectName={project?.getDisplayName() ?? project?.name ?? null}
            onScopeChange={handleScopeChange}
            workers={workers}
            onToggleWorker={toggleWorker}
            favoritesOnly={favoritesOnly}
            onToggleFavorites={() => setFavoritesOnly((v) => !v)}
          />
        ),
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
      search,
      scope,
      project,
      handleScopeChange,
      workers,
      toggleWorker,
      favoritesOnly,
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
        title="Delete chat?"
        description={`"${pendingDelete?.title ?? ''}" will be removed. This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
