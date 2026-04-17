import { IncomingTaskDialog } from '@src/components/task-receive/IncomingTaskDialog';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { MemoIframeModal } from '@src/components/memo-panel/MemoIframeModal';
import { UsageBar } from '@src/components/cost-dashboard';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { NotificationFeed } from '@src/components/notification-feed';
import { type ProjectResourceListItem } from '@src/components/project-resource-list';
import { ProjectActivityStrip, BookmarkColumn } from '@src/components/project-activity-strip';
import { WorkflowStrip } from '@src/components/workflows-view/WorkflowStrip';
import { EventSnifferChip } from '@src/components/hooks/EventSnifferChip';
import { TerminalLineSessionInput } from '@src/components/session-input';
import { isSkillCreationTask, TaskStatus } from '@src/components/task-bar/task-utils';
import { useBookmarkMutations } from '@src/hooks/use-bookmark-mutations';
import { useClaudeErrorRecords } from '@src/hooks/useClaudeErrorRecords';
import { useAnnotations } from '@src/hooks/use-annotations';
import { useProjectBookmarks } from '@src/hooks/use-project-bookmarks';
import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { useTaskMutations } from '@src/hooks/use-task-mutations';
import { useClaudeProjectList } from '@src/hooks/use-claude-projects';
import { useSnifferContext } from '@src/contexts/SnifferContext';
import { useEventDrivenSessions } from '@src/hooks/use-event-driven-sessions';
import { useProjects } from '@src/hooks/use-projects';
import { useActAccordingToClassification } from '@src/hooks/use-act-according-to-classification';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { useForkInTerminal } from '@src/hooks/use-fork-in-terminal';
import { Annotation, claudeSessionManager, ContextEntitiesEnum, dataContext, Project, QueryRequest } from '@sdk';
import { refreshNotifications } from '@sdk/entities/notifications';
import { useAuth, useProject } from '@sdk/react/hooks';
import { useAgentContext } from '@src/contexts/agent-context';
import { useToast } from '@src/hooks/use-toast';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { ActivityProgressModal } from '@src/components/search-index/ActivityProgressModal';
import { WelcomeModal } from '@src/components/search-index/WelcomeModal';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type React from 'react';
import { SearchFilters, SearchResult } from '@src/hooks/use-record-search';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { InlineSearchResults } from './InlineSearchResults';
import { Loader2, PackageSearch, X, CheckCircle2, Hammer } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDevMode } from '@src/contexts/dev-mode-context';
import type { LastScanResult } from '@sdk';

const getSafeTimestamp = (value?: string | null): number => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const normalizePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

/**
 * HomeLanding - Welcome view with greeting and quick action buttons
 *
 * Layout:
 * - Top row: Usage bar
 * - Main row:
 *   - Left column: Project list (full height)
 *   - Right column: Greeting, session input, project buttons, and Quick Access
 * URL: /dock/home
 */
const _INDEX_APPROVED_KEY = 'flowpad-index-approved';
const _SCAN_DISMISSED_KEY = 'flowpad-scan-dismissed';

export function HomeLanding() {
  const { user } = useAuth();
  const { navigation } = useDockNavigation();
  useProjects();

  // Incoming task dialog — driven by URL params (email deep-link) or WS events
  const { pendingTask, setPendingTask } = useIncomingTaskStore();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('task_action') === 'open') {
      const taskId = params.get('task_id') || '';
      const taskTitle = params.get('task_title') || 'Shared task';
      const senderName = params.get('sender_name') || 'Someone';
      if (taskId) {
        setPendingTask({ taskId, taskTitle, senderName });
        // Clean URL so refreshing doesn't re-trigger
        const url = new URL(window.location.href);
        url.searchParams.delete('task_action');
        url.searchParams.delete('task_id');
        url.searchParams.delete('task_title');
        url.searchParams.delete('sender_name');
        url.searchParams.delete('project_url');
        url.searchParams.delete('branch');
        url.searchParams.delete('repo_id');
        window.history.replaceState(null, '', url.toString());
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { projects: claudeProjects, isLoading: isLoadingClaudeProjects } = useClaudeProjectList();
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const { events: snifferEvents } = useSnifferContext();

  // Per-session event counts for notification badges
  const sessionEventCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const evt of snifferEvents) {
      if (evt.session_id) {
        counts.set(evt.session_id, (counts.get(evt.session_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [snifferEvents]);

  // Skill creation tasks for the Learnings tab
  const { data: allTasks, refetch: taskRefetch, excludeTasks } = useProjectTasks();
  const { archiveTask } = useTaskMutations({ refetch: taskRefetch, excludeTasks });
  const learningTasks = useMemo(
    () => allTasks.filter((t) => t.status !== 'archived' && !t.archived_at),
    [allTasks],
  );

  // Bookmarks for the Bookmarks tab
  const { data: bookmarks, refetch: bookmarkRefetch, excludeBookmarks } = useProjectBookmarks();
  const { openDisplayCount: errorCount } = useClaudeErrorRecords();
  const { closeBookmark, deleteBookmark, remindBookmark } = useBookmarkMutations({ refetch: bookmarkRefetch, excludeBookmarks });

  // Comment annotations for the current project
  const { annotations: allAnnotations, refetch: annotationsRefetch } = useAnnotations(currentProject?.typeId ?? null);
  const commentAnnotations = useMemo(
    () => allAnnotations.filter((a) => a.labels?.includes('comment:')),
    [allAnnotations],
  );
  const createComment = useCallback(
    async (content: string) => {
      if (!currentProject?.typeId) return;
      const annotation = new Annotation({
        labels: ['comment:'],
        target_type: currentProject.typeId.type,
        target_id: currentProject.typeId.id,
        content,
        iso_timestamp: new Date().toISOString(),
      });
      await annotation.save([]);
      await annotationsRefetch();
    },
    [currentProject?.typeId, annotationsRefetch],
  );

  const devMode = useDevMode();
  const { busy, resetAndRescan, clearIndex, currentActivity, activityProgress, scanInfo, lastScanResult } = useSystemTools();
  const [progressOpen, setProgressOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [postScanResult, setPostScanResult] = useState<LastScanResult | null>(null);

  // Detect scan completion: when lastScanResult changes to a new value, capture it for display
  const prevLastScanResultRef = useRef<LastScanResult | null>(null);
  useEffect(() => {
    if (lastScanResult && lastScanResult !== prevLastScanResultRef.current) {
      setPostScanResult(lastScanResult);
    }
    prevLastScanResultRef.current = lastScanResult;
  }, [lastScanResult]);

  // Show welcome modal when never_indexed, unless user has already approved or dismissed this session.
  useEffect(() => {
    if (localStorage.getItem(_INDEX_APPROVED_KEY) || sessionStorage.getItem(_SCAN_DISMISSED_KEY) || !scanInfo) return;
    if (scanInfo.never_indexed) setShowWelcome(true);
  }, [scanInfo]);
  const firstName = user?.name?.split(' ')[0] || 'there';

  const [memoPanelOpen, setMemoPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);

  useEffect(() => { setSelectedResultIndex(-1); }, [searchQuery]);
  // Clear post-scan panel when user starts a real search
  useEffect(() => { if (searchQuery.trim().length >= 2) setPostScanResult(null); }, [searchQuery]);
  const [showSessionInput, setShowSessionInput] = useState(false);
  const sessionInputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSessionInput) return;
    const handler = (e: MouseEvent) => {
      if (sessionInputRef.current && !sessionInputRef.current.contains(e.target as Node)) {
        setShowSessionInput(false);
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [showSessionInput]);

  const handleSearchSubmit = useCallback(() => {
    if (searchQuery.trim()) {
      navigation.openSearch(searchQuery, searchFilters);
    } else {
      navigation.openSearch(undefined, searchFilters);
    }
  }, [navigation, searchQuery, searchFilters]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedResultIndex(0); }
    if (e.key === 'Escape') { setSelectedResultIndex(-1); }
  }, []);

  const handleNavigateResult = useCallback((result: SearchResult) => {
    void navigateToResult(result, navigation);
  }, [navigation]);

  const { resumeInTerminal } = useResumeInTerminal();
  const { forkInTerminal } = useForkInTerminal();

  // Get paths from desktop_info
  const paths = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths, []);
  const apiUrl = useMemo(() => {
    // Derive API URL from the current window location or use default
    const port = '9007';
    return `http://${window.location.hostname}:${port}`;
  }, []);
  const currentProjectPath = useMemo(
    () => normalizePath(currentProject?.fs_storage_mount_path || currentProject?.name || ''),
    [currentProject?.fs_storage_mount_path, currentProject?.name],
  );

  const selectedClaudeProjectEncodedName = useMemo(() => {
    if (!currentProject) return null;

    const byId = claudeProjects.find((project) => project.id === currentProject.id);
    if (byId?.encoded_name) return byId.encoded_name;

    if (!currentProjectPath) return null;
    const byPath = claudeProjects.find((project) => {
      const scanPath = normalizePath(project.cwd || project.name || '');
      return !!scanPath && scanPath === currentProjectPath;
    });
    return byPath?.encoded_name || null;
  }, [claudeProjects, currentProject, currentProjectPath]);

  const { actOnClassification, actingSessionId } = useActAccordingToClassification({
    onStarted: () => {
      void taskRefetch();
    },
    onCompleted: () => {
      void taskRefetch();
    },
  });

  const handleSessionSubmit = (message: string) => {
    if (!currentProject?.typeId) {
      toast({
        title: 'Project Required',
        description: 'Please select or create a project first.',
        variant: 'destructive',
      });
      return;
    }

    const workdir = currentProject.fs_storage_mount_path || currentProject.name || paths?.workspace || undefined;

    void (async () => {
      try {
        const agenticProcess = await claudeSessionManager.createAndStartSession({ workdir }, { instruction: message });
        void navigation.openShellProcess(agenticProcess.id);
      } catch (error) {
        console.error('[HomeLanding] Failed to create session:', error);
      }
    })();
  };

  const resourceNavigationOptions = useMemo(
    () =>
      selectedClaudeProjectEncodedName
        ? {
            scope: 'project',
            project: selectedClaudeProjectEncodedName,
          }
        : undefined,
    [selectedClaudeProjectEncodedName],
  );

  const { items: activityItems } = useEventDrivenSessions({
    snifferEvents,
    seedItems: [],
    fetchProject: async () => null,
  });

  const selectedClaudeProjectCwd = useMemo(() => {
    if (!selectedClaudeProjectEncodedName) return undefined;
    const match = claudeProjects.find((p) => p.encoded_name === selectedClaudeProjectEncodedName);
    return match?.cwd || undefined;
  }, [claudeProjects, selectedClaudeProjectEncodedName]);

  /**
   * Switch the current project context to match the given cwd.
   * Finds an existing Project entity by path or creates a new one,
   * then sets it as the active project so the terminal spawns there
   * and the footer path updates accordingly.
   */
  const switchProjectByCwd = useCallback(
    async (cwd: string) => {
      if (!dataContext.someone) return;
      const targetPath = normalizePath(cwd);
      if (!targetPath) return;

      // Skip if already on this project
      if (currentProjectPath && currentProjectPath === targetPath) return;

      const pathKey = targetPath.toLowerCase();
      const getPath = (p: Project) => normalizePath(p.fs_storage_mount_path || p.name || '').toLowerCase();

      const freshProjects = await Project.query(
        new QueryRequest({
          type: Project.type,
          query: null,
          scope: [],
          name: 'home-landing-switch-project',
        }),
      );
      let target = freshProjects.find((p) => getPath(p) === pathKey) || null;

      if (!target) {
        target = new Project({ name: targetPath });
        await target.save([dataContext.someone]);
      }
      await target.setupForDesktop();
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, target.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(target.fs_storage_mount_path ?? null);
    },
    [currentProjectPath],
  );

  /** Switch project context and resume a Claude session in the terminal. */
  const switchAndResume = useCallback(
    (sessionId: string, resource: ProjectResourceListItem) => {
      const sessionCwd = resource.path || selectedClaudeProjectCwd;
      const doSwitch = sessionCwd ? switchProjectByCwd(sessionCwd) : Promise.resolve();
      doSwitch
        .then(() => resumeInTerminal(sessionId, sessionCwd))
        .catch((err) => console.error('[HomeLanding] Failed to switch project for resume:', err));
    },
    [resumeInTerminal, selectedClaudeProjectCwd, switchProjectByCwd],
  );

  const handleSessionResume = useCallback(
    (resource: ProjectResourceListItem) => {
      if (!resource.sessionId) return;
      switchAndResume(resource.sessionId, resource);
    },
    [switchAndResume],
  );

  const handleResourceClick = useCallback(
    (resource: ProjectResourceListItem) => {
      if (resource.type === 'skill') {
        navigation.openDock(DockPointer.forSkills(resource.skillDockPath));
        return;
      }

      switch (resource.type) {
        case 'claude_session': {
          // Same behavior as the resume icon — switch project and open terminal
          handleSessionResume(resource);
          break;
        }
        case 'hook':
          navigation.openSystemProfile('hooks', resource.itemId, resourceNavigationOptions);
          break;
        case 'command':
          navigation.openSystemProfile('commands', resource.itemId, resourceNavigationOptions);
          break;
        case 'agent':
          navigation.openSystemProfile('agents', resource.itemId, resourceNavigationOptions);
          break;
        case 'todo':
          navigation.openSystemProfile('todos', resource.itemId, resourceNavigationOptions);
          break;
        case 'plugin':
          navigation.openSystemProfile('plugins', resource.itemId, resourceNavigationOptions);
          break;
        case 'mcp_server':
          navigation.openSystemProfile('projects', undefined, {
            project: selectedClaudeProjectEncodedName ?? undefined,
          });
          break;
        case 'claude_md':
          navigation.openSystemProfile('summary', undefined, resourceNavigationOptions);
          break;
        default:
          navigation.openSystemProfile();
      }
    },
    [navigation, resourceNavigationOptions, selectedClaudeProjectEncodedName, handleSessionResume],
  );

  const handleSessionTasks = useCallback(
    (resource: ProjectResourceListItem) => {
      if (resource.sessionId) {
        navigation.openLens('claude', 'tasks', resource.sessionId);
      }
    },
    [navigation],
  );


  const handleActAccordingToClassification = useCallback(
    async (resource: ProjectResourceListItem, command: string) => {
      const cwd = resource.path || selectedClaudeProjectCwd;
      if (!resource.sessionId || !cwd) {
        toast({
          title: 'Session unavailable',
          description: 'No session ID or working directory found.',
          variant: 'destructive',
        });
        return;
      }
      await actOnClassification(resource.sessionId, cwd, command);
    },
    [actOnClassification, toast, selectedClaudeProjectCwd],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top row: UsageBar */}
      <div className="flex shrink-0 items-center gap-2 p-4">
        <div className="w-72 shrink-0">
          <UsageBar />
        </div>
      </div>

      {/* Main row: Sidebar + Content */}
      <div className="flex min-h-0 flex-1 gap-6 px-4 pb-4">
        {/* Left column: Bookmarks */}
        <div className="w-72 shrink-0">
          <BookmarkColumn
            learningTasks={learningTasks}
            bookmarks={bookmarks}
            annotations={commentAnnotations}
            errorCount={errorCount}
            onErrorClick={() => navigation.openLens('heartbeat', 'errors', 'open')}
            onAddComment={createComment}
            onArchiveLearning={(task) => void archiveTask(task)}
            onCloseBookmark={(m) => void closeBookmark(m)}
            onDeleteBookmark={(m) => void deleteBookmark(m)}
            onRemindBookmark={(m, mins) => void remindBookmark(m, mins)}
            onOpenSession={(m) => m.session_id && resumeInTerminal(m.session_id, m.work_dir ?? undefined, m.created_date ?? undefined)}
            onForkSession={(m) => forkInTerminal(m.work_dir ?? undefined)}
            onRefresh={() => refreshNotifications(currentProject?.fs_storage_mount_path ?? undefined)}
            sessionEventCounts={sessionEventCounts}
            snifferEvents={snifferEvents}
          />
        </div>

        {/* Middle column: Main content + Quick Access */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Main content area - shrink-0 so it never collapses */}
          <div className="flex shrink-0 flex-col items-center gap-6 pb-6 text-center">
            <h1 className="text-4xl font-bold tracking-tight">
              Hey{' '}
              <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
            </h1>

            {showSessionInput ? (
              <div className="w-full max-w-3xl" ref={sessionInputRef}>
                <TerminalLineSessionInput
                  placeholder="Start new Claude Code session..."
                  onSubmit={(msg) => void handleSessionSubmit(msg)}
                />
              </div>
            ) : (
              <button
                className="cursor-pointer text-lg text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setShowSessionInput(true)}
              >
                What would you like to work on today?
              </button>
            )}

            <div className="w-full max-w-3xl flex items-start gap-2">
              <div className="flex-1">
                <RecordSearchBar
                  query={searchQuery}
                  filters={searchFilters}
                  onQueryChange={setSearchQuery}
                  onFiltersChange={setSearchFilters}
                  onSubmit={handleSearchSubmit}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search anything across your Claude Code projects"
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => void resetAndRescan()}
                    disabled={busy}
                  >
                    <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh search data</TooltipContent>
              </Tooltip>
              {devMode && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-orange-500 ring-1 ring-orange-500 shadow-[0_0_8px_2px_rgba(249,115,22,0.6)] animate-pulse"
                      onClick={() => void clearIndex()}
                      disabled={busy}
                    >
                      <Hammer className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Clear index (dev)</TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Activity strip — shown while any system activity is running */}
            {currentActivity && (
              <button
                onClick={() => setProgressOpen(true)}
                className="w-full max-w-3xl flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors text-left"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-primary" />
                <span className="text-muted-foreground shrink-0">
                  {currentActivity === 'archive' ? 'Archiving…'
                    : currentActivity === 'clear' ? 'Clearing index…'
                    : currentActivity === 'load_from_archive' ? 'Restoring…'
                    : currentActivity === 'scan' ? 'Scanning'
                    : 'Indexing'}
                </span>
                {activityProgress?.current && (
                  <span className="font-mono text-foreground truncate max-w-[180px]">
                    {activityProgress.current}
                  </span>
                )}
                {activityProgress?.current && activityProgress.counts?.[activityProgress.current] !== undefined && (
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {activityProgress.counts[activityProgress.current].toLocaleString()} recs
                  </span>
                )}
                {activityProgress?.recordsDone != null && activityProgress.recordsTotal != null && (
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {activityProgress.recordsDone.toLocaleString()}/{activityProgress.recordsTotal.toLocaleString()} recs
                  </span>
                )}
                {activityProgress && (
                  <>
                    <span className="ml-auto text-muted-foreground shrink-0 tabular-nums">
                      {activityProgress.jobDone != null && activityProgress.jobTotal != null
                        ? `${activityProgress.jobDone}/${activityProgress.jobTotal}`
                        : `${activityProgress.done.length}/${activityProgress.total}`}
                    </span>
                    <div className="h-1 w-20 rounded-full bg-muted overflow-hidden shrink-0">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{
                          width: `${activityProgress.recordsDone != null && activityProgress.recordsTotal
                            ? (activityProgress.recordsDone / activityProgress.recordsTotal) * 100
                            : activityProgress.jobDone != null && activityProgress.jobTotal
                            ? (activityProgress.jobDone / activityProgress.jobTotal) * 100
                            : (activityProgress.done.length / activityProgress.total) * 100}%`
                        }}
                      />
                    </div>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Post-scan results panel — shown after scan completes when user hasn't searched yet */}
          {postScanResult && searchQuery.trim().length < 2 && (
            <div className="w-full max-w-3xl self-center shrink-0">
              <div className="flex flex-col rounded-lg border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Scan & index complete — {postScanResult.grand_total.toLocaleString()} records found
                  </span>
                  <button
                    type="button"
                    onClick={() => setPostScanResult(null)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {postScanResult.types.filter((t) => t.count > 0).length > 0 ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2">
                    {postScanResult.types
                      .filter((t) => t.count > 0)
                      .sort((a, b) => b.count - a.count)
                      .map((t) => (
                        <span key={t.type} className="flex items-center gap-1 text-xs text-muted-foreground">
                          <span className="font-mono text-foreground">{t.type.replace('claude_', '')}</span>
                          <span className="tabular-nums">{t.count.toLocaleString()}</span>
                        </span>
                      ))}
                  </div>
                ) : (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No records found on disk.</p>
                )}
              </div>
            </div>
          )}

          {/* Inline search results */}
          <div className="w-full max-w-3xl self-center min-h-0 flex-1 relative z-10">
            <InlineSearchResults
              query={searchQuery}
              filters={searchFilters}
              selectedIndex={selectedResultIndex}
              onSelectedIndexChange={setSelectedResultIndex}
              onOpenFullSearch={handleSearchSubmit}
              onNavigateResult={handleNavigateResult}
            />
          </div>

          {/* Notifications section */}
          <div className="w-full max-w-3xl shrink-0 self-center">
            <NotificationFeed />
          </div>

          {/* Event Sniffer chip - aligned to bottom of side columns */}
          <div className="mt-auto w-full max-w-3xl shrink-0 self-center">
            <EventSnifferChip />
          </div>
        </div>

        {/* Right column: Workflows strip + Session list */}
        <div className="w-72 shrink-0 flex flex-col gap-2">
          <WorkflowStrip />
          <ProjectActivityStrip
            items={activityItems}
            isLoading={isLoadingClaudeProjects}
            onItemClick={handleResourceClick}
            onSessionResume={handleSessionResume}
            onSessionTasks={handleSessionTasks}
            onActAccordingToClassification={(item, cmd) => void handleActAccordingToClassification(item, cmd)}
            actingSessionId={actingSessionId}
            sessionEventCounts={sessionEventCounts}
            snifferEvents={snifferEvents}
            learningTasks={learningTasks}
          />
        </div>

      </div>

      {/* Welcome modal for first-time / not-yet-indexed users */}
      <WelcomeModal
        open={showWelcome}
        onStart={() => {
          localStorage.setItem(_INDEX_APPROVED_KEY, '1');
          setShowWelcome(false);
          void resetAndRescan();
        }}
        onSkip={() => {
          sessionStorage.setItem(_SCAN_DISMISSED_KEY, '1');
          setShowWelcome(false);
        }}
      />

      {/* Activity progress detail modal */}
      <ActivityProgressModal
        open={progressOpen}
        onOpenChange={setProgressOpen}
        progress={activityProgress}
        title={currentActivity ? (
          currentActivity === 'archive' ? 'Archiving…'
          : currentActivity === 'clear' ? 'Clearing index…'
          : currentActivity === 'load_from_archive' ? 'Restoring…'
          : currentActivity === 'scan' ? `Scanning… ${activityProgress?.done.length ?? 0}/${activityProgress?.total ?? 0}`
          : `Indexing… ${activityProgress?.done.length ?? 0}/${activityProgress?.total ?? 0}`
        ) : 'Activity'}
      />

      {/* Incoming task dialog — pull/clone flow for shared tasks */}
      {pendingTask && (
        <IncomingTaskDialog
          open={!!pendingTask}
          taskId={pendingTask.taskId}
          taskTitle={pendingTask.taskTitle}
          senderName={pendingTask.senderName}
          onClose={() => setPendingTask(null)}
        />
      )}
    </div>
  );
}

export default HomeLanding;
