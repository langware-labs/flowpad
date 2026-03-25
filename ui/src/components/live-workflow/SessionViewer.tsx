import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgenticProcess,
  dataContext,
  dataManager,
  ProcessorStatus,
  QueryFilter,
  QueryRequest,
  TypeId,
} from '@sdk';
import { useContext, useEntityData, useProject } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus } from 'lucide-react';
import { filterClosedTabs, getNextSessionNumber, mergeSessionTabs } from './sessionTabUtils';
import { SessionActionButtons } from './SessionActionButtons';
import { SessionTabBar } from './SessionTabBar';
import { InterferenceBox, RunningArea } from './components';
import { useSessionProcess } from './hooks/useSessionProcess';
import { useWorkflowProgressInfo } from './hooks/useWorkflowProgressInfo';

interface SessionTab {
  id: string;
  name: string;
  favorite_index?: number | null;
}

const sessionTabsCache = new Map<string, SessionTab[]>();

const getSessionDisplayName = (process: AgenticProcess | null | undefined, fallback: string) => {
  if (process?.context_data && typeof process.context_data === 'object') {
    const displayName = process.context_data.display_name;
    if (typeof displayName === 'string' && displayName.trim().length > 0) {
      return displayName.trim();
    }
  }

  if (process?.instruction_content) {
    const trimmed = process.instruction_content.replace(/<!--.*?-->/g, '').trim();
    if (trimmed.length > 0) {
      return trimmed.substring(0, 30);
    }
  }

  return fallback;
};

/**
 * SessionViewer - Live execution view with session tabs
 *
 * Layout:
 * - SessionTabBar: Tab bar for multiple sessions
 * - RunningArea: Conversation/FlowData stream with status at bottom
 * - InterferenceBox: Compact prompt input
 *
 * URL: /dock/session/:processId
 */
export function SessionViewer() {
  const { navigation } = useDockNavigation();
  const { project: currentProject } = useProject();
  const cacheKey = currentProject?.typeId?.id ?? 'global';

  // Get process from context (set by loader on initial load)
  const { agenticProcessTypeId } = useContext();
  const processId = agenticProcessTypeId?.id || '';

  // Track open session tabs (process IDs that have been opened)
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>(() => sessionTabsCache.get(cacheKey) ?? []);
  const [isLoadingTabs, setIsLoadingTabs] = useState(true);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const favoriteMaxRef = useRef(0);
  const favoriteGap = 1000;
  const closedSessionIdsRef = useRef<Set<string>>(new Set());

  const persistFavoriteIndex = useCallback(async (tabId: string, nextIndex: number | null, visible?: boolean) => {
    try {
      const body: Record<string, unknown> = { favorite_index: nextIndex };
      if (visible !== undefined) body.visible = visible;
      await fetch(`/api/v1/graph/agentic_process/${tabId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      console.warn('[SessionViewer] Failed to persist favorite_index:', tabId, error);
    }
  }, []);

  // Process management (consumes from context internally)
  const { process, state, completed, isRunning, abortProcess, appendInstruction, injectInstruction } =
    useSessionProcess();

  // FlowData stream
  const { flowData } = useEntityData(agenticProcessTypeId);

  // Progress info (elapsed time + status message + activity label + token usage)
  const { elapsedTime, statusMessage, activityLabel, tokenUsage } = useWorkflowProgressInfo(process, isRunning);

  // Session action buttons (analyze + resume in terminal)
  const workerSessionId = process?.worker_session_id ?? null;
  const sessionCwd = process?.workdir;

  // Load recent sessions as tabs
  useEffect(() => {
    const loadSessions = async () => {
      if (!currentProject?.typeId) {
        setSessionTabs([]);
        setIsLoadingTabs(false);
        return;
      }

      try {
        const query = new QueryRequest({
          type: AgenticProcess.type,
          scope: [currentProject.typeId],
          name: 'SessionViewer-tabs',
          query: new QueryFilter({ limit: 100, order_by: { updated_at: 'desc' }, match: { visible: true } as Record<string, unknown> }),
        });
        const processes = await dataManager.query<AgenticProcess>(query, false);

        const allFetchedTabs: SessionTab[] = processes.map((p, index) => ({
          id: p.id || `session-${index}`,
          name: getSessionDisplayName(p, `Session ${index + 1}`),
          favorite_index: p.favorite_index ?? null,
        }));
        const fetchedTabs = filterClosedTabs(allFetchedTabs, closedSessionIdsRef.current);

        const hasFavoriteIndexes = fetchedTabs.some(
          (tab) => tab.favorite_index !== null && tab.favorite_index !== undefined,
        );
        const ordered: SessionTab[] = [];
        const seen = new Set<string>();

        if (hasFavoriteIndexes) {
          const sortedByFavorite = [...fetchedTabs].sort((a, b) => {
            const aIndex = a.favorite_index ?? Number.POSITIVE_INFINITY;
            const bIndex = b.favorite_index ?? Number.POSITIVE_INFINITY;
            if (aIndex === bIndex) return 0;
            return aIndex - bIndex;
          });
          for (const tab of sortedByFavorite) {
            if (!seen.has(tab.id)) {
              ordered.push(tab);
              seen.add(tab.id);
            }
          }
        } else {
          for (const tab of fetchedTabs) {
            if (!seen.has(tab.id)) {
              ordered.push(tab);
              seen.add(tab.id);
            }
          }
        }

        if (processId && !seen.has(processId) && !closedSessionIdsRef.current.has(processId)) {
          const fallbackName = `Session ${getNextSessionNumber(ordered)}`;
          ordered.push({
            id: processId,
            name: getSessionDisplayName(process, fallbackName),
            favorite_index: null,
          });
        }

        setSessionTabs((prev) => {
          const mergedById = mergeSessionTabs(prev, ordered);
          if (processId && !mergedById.has(processId) && !closedSessionIdsRef.current.has(processId)) {
            const fallbackName = `Session ${getNextSessionNumber(Array.from(mergedById.values()))}`;
            mergedById.set(processId, {
              id: processId,
              name: getSessionDisplayName(process, fallbackName),
              favorite_index: null,
            });
          }
          const merged = Array.from(mergedById.values());
          const hasFavorite = merged.some((tab) => tab.favorite_index !== null && tab.favorite_index !== undefined);
          if (hasFavorite) {
            return merged.sort((a, b) => {
              const aIndex = a.favorite_index ?? Number.POSITIVE_INFINITY;
              const bIndex = b.favorite_index ?? Number.POSITIVE_INFINITY;
              if (aIndex === bIndex) return 0;
              return aIndex - bIndex;
            });
          }
          const prevOrder = prev.map((tab) => tab.id);
          const orderedIds = ordered.map((tab) => tab.id);
          const seen = new Set<string>();
          const result: SessionTab[] = [];
          for (const id of prevOrder) {
            const tab = mergedById.get(id);
            if (tab && !seen.has(id)) {
              result.push(tab);
              seen.add(id);
            }
          }
          for (const id of orderedIds) {
            const tab = mergedById.get(id);
            if (tab && !seen.has(id)) {
              result.push(tab);
              seen.add(id);
            }
          }
          if (processId && !seen.has(processId) && !closedSessionIdsRef.current.has(processId)) {
            const tab = mergedById.get(processId);
            if (tab) result.push(tab);
          }
          return result;
        });
      } catch (error) {
        console.error('[SessionViewer] Failed to load sessions:', error);
        setSessionTabs([]);
      } finally {
        setIsLoadingTabs(false);
      }
    };

    void loadSessions();
  }, [currentProject?.typeId, processId, process?.instruction_content]);

  // Add current process to tabs if not already there
  useEffect(() => {
    if (processId && !closedSessionIdsRef.current.has(processId) && !sessionTabs.find((t) => t.id === processId)) {
      const fallbackName = `Session ${getNextSessionNumber(sessionTabs)}`;
      const name = getSessionDisplayName(process, fallbackName);
      setSessionTabs((prev) => [...prev, { id: processId, name, favorite_index: null }]);
    }
  }, [processId, process?.instruction_content, sessionTabs]);

  useEffect(() => {
    if (cacheKey !== 'global' && sessionTabsCache.has('global') && !sessionTabsCache.has(cacheKey)) {
      sessionTabsCache.set(cacheKey, sessionTabsCache.get('global') || []);
    }
    const cached = sessionTabsCache.get(cacheKey);
    if (cached && cached.length > 0) {
      setSessionTabs(cached);
    }
  }, [cacheKey]);

  useEffect(() => {
    sessionTabsCache.set(cacheKey, sessionTabs);
  }, [cacheKey, sessionTabs]);

  useEffect(() => {
    if (processId) {
      setActiveTabId(processId);
    } else if (!isLoadingTabs) {
      setActiveTabId(null);
    }
  }, [processId, isLoadingTabs]);

  useEffect(() => {
    favoriteMaxRef.current = sessionTabs.reduce((max, tab) => Math.max(max, tab.favorite_index ?? 0), 0) || 0;
  }, [sessionTabs]);

  // Handle tab selection
  const handleSelectTab = useCallback(
    (selectedAgneticProcessId: string) => {
      setActiveTabId(selectedAgneticProcessId);
      void fetch(`/api/v1/graph/agentic_process/${selectedAgneticProcessId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible: true }),
      });
      void navigation.openShellProcess(selectedAgneticProcessId);
    },
    [navigation],
  );

  // Handle close tab
  const handleCloseTab = useCallback(
    (tabId: string): Promise<void> => {
      closedSessionIdsRef.current.add(tabId);
      void persistFavoriteIndex(tabId, null, false);
      setSessionTabs((prev) => {
        const nextTabs = prev.filter((t) => t.id !== tabId);
        sessionTabsCache.set(cacheKey, nextTabs);
        return nextTabs;
      });

      // If closing active tab, navigate to another or clear
      if (tabId === processId) {
        const remaining = sessionTabs.filter((t) => t.id !== tabId);
        if (remaining.length > 0) {
          void navigation.openSession(remaining[0].id);
        } else {
          navigation.openShellView();
        }
      }
      return Promise.resolve();
    },
    [cacheKey, processId, sessionTabs, navigation, persistFavoriteIndex],
  );

  // Handle adding a new session tab
  const handleAddSession = useCallback(async () => {
    try {
      // Get compute node from context (already loaded by loader)
      const computeNode = dataContext.computeNode;
      if (!computeNode) {
        console.error('[SessionViewer] No compute node available');
        return;
      }

      // Create processor and process
      const processor = await computeNode.createAgenticProcessor();
      console.log(
        '[SessionViewer] Creating process with projectId:',
        currentProject?.typeId?.id,
        'project:',
        currentProject?.name,
      );
      const newAgenticProcess = await processor.createProcess({
        projectId: currentProject?.typeId?.id,
        workdir: currentProject?.fs_storage_mount_path,
      }, { visible: true });

      if (newAgenticProcess?.id) {
        setActiveTabId(newAgenticProcess.id);

        const nextIndex = favoriteMaxRef.current + favoriteGap;
        const nextNumber = getNextSessionNumber(sessionTabs);
        const nextName = `Session ${nextNumber}`;
        void persistFavoriteIndex(newAgenticProcess.id, nextIndex);
        if (!sessionTabs.find((tab) => tab.id === newAgenticProcess.id)) {
          const nextTabs = [...sessionTabs, { id: newAgenticProcess.id, name: nextName, favorite_index: nextIndex }];
          sessionTabsCache.set(cacheKey, nextTabs);
          setSessionTabs(nextTabs);
        }
        // Navigate to the new session
        void navigation.openShellProcess(newAgenticProcess.id);
      }
    } catch (error) {
      console.error('[SessionViewer] Failed to create session:', error);
    }
  }, [cacheKey, currentProject?.fs_storage_mount_path, currentProject?.name, currentProject?.typeId?.id, navigation, persistFavoriteIndex, sessionTabs]);

  // Track dirty (none for sessions)
  const dirtyIds = useMemo(() => new Set<string>(), []);

  // Convert session tabs to tab bar format
  const tabEntries = useMemo(() => {
    return sessionTabs.map((tab, index) => ({
      id: tab.id,
      name: tab.name,
      tab_index: index,
    }));
  }, [sessionTabs]);

  const handleReorderTab = useCallback(
    (sourceId: string, targetId: string) => {
      setSessionTabs((prev) => {
        const sourceIndex = prev.findIndex((tab) => tab.id === sourceId);
        const targetIndex = prev.findIndex((tab) => tab.id === targetId);
        if (sourceIndex === -1 || targetIndex === -1) return prev;
        const next = [...prev];
        const [moved] = next.splice(sourceIndex, 1);
        next.splice(targetIndex, 0, moved);
        const before = next[targetIndex - 1]?.favorite_index ?? null;
        const after = next[targetIndex + 1]?.favorite_index ?? null;
        let nextIndex = moved.favorite_index ?? null;
        if (before === null && after === null) {
          nextIndex = favoriteGap;
        } else if (before === null && after !== null) {
          nextIndex = after - favoriteGap;
        } else if (before !== null && after === null) {
          nextIndex = before + favoriteGap;
        } else if (before !== null && after !== null) {
          const mid = Math.floor((before + after) / 2);
          nextIndex = mid === before ? before + 1 : mid;
        }
        moved.favorite_index = nextIndex;
        void persistFavoriteIndex(sourceId, nextIndex);
        return next;
      });
    },
    [persistFavoriteIndex],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      try {
        const typeId = new TypeId(AgenticProcess.type, sessionId);
        const entity = (dataManager.getByTypeIdFromCache<AgenticProcess>(typeId) ??
          (await dataContext.loadContextEntity(typeId))) as AgenticProcess | null;
        if (!entity) {
          console.warn('[SessionViewer] Cannot rename session, process not in cache:', sessionId);
          return;
        }
        const nextContextData = {
          ...(entity.context_data ?? {}),
          display_name: newName,
        };
        entity.context_data = nextContextData;
        await entity.save();
        setSessionTabs((prev) => prev.map((tab) => (tab.id === sessionId ? { ...tab, name: newName } : tab)));
      } catch (error) {
        console.error('[SessionViewer] Failed to rename session:', error);
      }
    },
    [currentProject?.typeId],
  );

  // Handle submit input (when waiting for input)
  const handleSubmitInput = useCallback(
    async (value: string) => {
      await appendInstruction(value);
    },
    [appendInstruction],
  );

  // Handle inject instruction
  const handleInjectInstruction = useCallback(
    async (content: string) => {
      await injectInstruction(content);
    },
    [injectInstruction],
  );

  // Handle abort
  const handleAbort = useCallback(() => {
    abortProcess();
  }, [abortProcess]);

  // Default state for display
  const defaultState = {
    status: ProcessorStatus.IDLE,
    index: 0,
    totalInstructions: 0,
    currentInstructionId: null,
    variables: {},
    waitingForInput: false,
    inputId: null,
    stack: [],
    debug: { enabled: false, breakpoints: [], stepMode: null },
    error: null,
    mdoContent: null,
  };

  const displayState = state
    ? completed && state.status !== ProcessorStatus.COMPLETE && state.status !== ProcessorStatus.ERROR
      ? { ...state, status: ProcessorStatus.COMPLETE }
      : state
    : defaultState;

  // Show empty state if no active process
  if (!processId && !isLoadingTabs) {
    return (
      <div className="flex h-full flex-col bg-background">
        {/* Session tabs - show even when empty for the + button */}
        <SessionTabBar
          sessions={tabEntries}
          activeSessionId={null}
          dirtySessionIds={dirtyIds}
          onCloseTab={handleCloseTab}
          onAddTab={handleAddSession}
          onSelectTab={handleSelectTab}
        />

        {/* Empty state */}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
          <p>No active session</p>
          <button
            onClick={() => void handleAddSession()}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Session
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Session tabs */}
      <SessionTabBar
        sessions={tabEntries}
        activeSessionId={activeTabId ?? processId}
        dirtySessionIds={dirtyIds}
        onCloseTab={handleCloseTab}
        onAddTab={handleAddSession}
        onSelectTab={handleSelectTab}
        onReorderTab={handleReorderTab}
        onRenameSession={handleRenameSession}
        actions={<SessionActionButtons workerSessionId={workerSessionId} sessionCwd={sessionCwd} />}
      />

      {/* Conversation/FlowData stream with status at bottom */}
      <RunningArea
        flowData={flowData}
        processState={displayState}
        isRunning={isRunning}
        elapsedTime={elapsedTime}
        statusMessage={statusMessage}
        activityLabel={activityLabel}
        tokenUsage={tokenUsage}
        onAbort={handleAbort}
        className="min-h-0 flex-1"
      />

      {/* Compact prompt input */}
      <InterferenceBox
        waitingForInput={state?.waitingForInput ?? false}
        inputId={state?.inputId ?? null}
        onSubmitInput={handleSubmitInput}
        onInjectInstruction={handleInjectInstruction}
        disabled={false}
        className="shrink-0 border-t"
      />
    </div>
  );
}
