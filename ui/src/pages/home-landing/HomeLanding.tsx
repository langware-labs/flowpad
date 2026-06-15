import { IncomingTaskDialog } from '@src/components/task-receive/IncomingTaskDialog';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { UsageBar } from '@src/components/cost-dashboard';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { NotificationFeed, notify } from '@src/notifications';
import { type ProjectResourceListItem } from '@src/components/project-resource-list';
import { ProjectActivityStrip, RecentConversationsStrip, BookmarkColumn } from '@src/components/project-activity-strip';
import { EventSnifferChip } from '@src/components/hooks/EventSnifferChip';
import { MiniDesktop } from '@src/components/quick-create';
import { SessionInput } from '@src/components/session-input/session-input';
import { isSkillCreationTask, TaskStatus } from '@src/components/task-bar/task-utils';
import { useBookmarkMutations } from '@src/hooks/use-bookmark-mutations';
import { useClaudeErrorRecords } from '@src/hooks/useClaudeErrorRecords';
import { useAnnotations } from '@src/hooks/use-annotations';
import { useProjectBookmarks } from '@src/hooks/use-project-bookmarks';
import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { useTaskMutations } from '@src/hooks/use-task-mutations';
import { useProjectList } from '@src/hooks/use-claude-projects';
import { useGlobalSearchScope } from '@src/hooks/use-global-search-scope';
import { useSnifferContext } from '@src/contexts/SnifferContext';
import { AdvancedOnly } from '@src/components/view-mode';
import { useCollaborationRooms } from '@src/hooks/useCollaborationRooms';
import { useProjects } from '@src/hooks/use-projects';
import { useActAccordingToClassification } from '@src/hooks/use-act-according-to-classification';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { useForkInTerminal } from '@src/hooks/use-fork-in-terminal';
import { Annotation, claudeSessionManager, ContextEntitiesEnum, dataContext, Project, QueryRequest } from '@sdk';
import { refreshNotifications } from '@sdk/entities/notifications';
import { useAuth, useProject } from '@sdk/react/hooks';
import { useAgentContext } from '@src/contexts/agent-context';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { ActivityIndicator } from '@src/components/search-index/ActivityIndicator';
import { WelcomeModal } from '@src/components/search-index/WelcomeModal';
import { CommunityAssistanceDialog } from '@src/components/community-assistance-dialog/CommunityAssistanceDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type React from 'react';
import { SearchFilters, SearchResult } from '@src/hooks/use-record-search';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { InlineSearchResults } from './InlineSearchResults';
import { Feed } from './Feed';
import { PackageSearch, X, CheckCircle2, Hammer, Users } from 'lucide-react';
import { useInboxStore } from '@src/store/use-inbox-store';
import { listInboxMessages } from '@src/components/inbox-view/inbox-api';
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

  // Incoming task dialog — driven by URL params (email deep-link) or WS events.
  // Deep link shape:
  //   ?action=open&fm=<id>[&conversation_id=...&task_id=...&project_url=...&...]
  // The backend's /open handler unpacks the bundle and resolves
  // conversation_id / task_id from the FM's context, so we navigate directly
  // off the URL params — no FM lookup needed on the UI side.
  const { pendingTask, setPendingTask } = useIncomingTaskStore();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'open') return;
    const fmId = params.get('fm') || '';
    const convId = params.get('conversation_id') || '';
    const taskId = params.get('task_id') || '';
    const title = params.get('title') || 'Shared';
    const senderName = params.get('sender_name') || 'Someone';
    const projectUrl = params.get('project_url') || undefined;
    const branch = params.get('branch') || undefined;
    const repoId = params.get('repo_id') || undefined;

    // Clean URL so refreshing doesn't re-trigger
    const url = new URL(window.location.href);
    for (const key of ['action', 'fm', 'conversation_id', 'task_id', 'title', 'sender_name', 'project_url', 'branch', 'repo_id']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url.toString());

    if (projectUrl && taskId) {
      // REPO attachment — show pull/clone dialog before navigating in.
      setPendingTask({ taskId, taskTitle: title, senderName, projectUrl, branch, repoId });
      return;
    }

    if (convId) {
      navigation.openDock(DockPointer.forConversation(convId));
      return;
    }

    // Last resort: no convId in the deep link. If we have a taskId, open the
    // tasks dock; otherwise stay on home and let the strip surface the share
    // once inbox-fetch lands the FM. ``fmId`` is unused here but kept in the
    // URL params for diagnostics / future fallback.
    void fmId;
    if (taskId) {
      navigation.openDock(DockPointer.fromUrl('tasks', taskId));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { projects: claudeProjects, isLoading: isLoadingClaudeProjects } = useProjectList();
  const { project: currentProject } = useProject();
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
  const { archiveTask, removeTasks } = useTaskMutations({ refetch: taskRefetch, excludeTasks });
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
  const { busy, resetAndRescan, clearIndex, scanInfo, lastScanResult } = useSystemTools();
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

  const [showCommunityAssistance, setShowCommunityAssistance] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');

  // Inbox unread count — populates the shared store consumed by the sidebar
  // Inbox badge. The home Inbox row was removed; the Recent conversations strip
  // (now labelled "Inbox") is the home inbox surface and has its own refresh.
  const { setUnreadCount } = useInboxStore();
  useEffect(() => {
    void listInboxMessages().then((msgs) => setUnreadCount(msgs.filter((m) => !m.is_read).length));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);
  const { scope: searchScope, isLoading: searchScopeLoading } = useGlobalSearchScope();

  useEffect(() => { setSelectedResultIndex(-1); }, [searchQuery]);
  // Clear post-scan panel when user starts a real search
  useEffect(() => { if (searchQuery.trim().length >= 2) setPostScanResult(null); }, [searchQuery]);

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
      notify.error({ title: 'Project Required', message: 'Please select or create a project first.' });
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

  const { items: collaborationRoomRows } = useCollaborationRooms({
    projectId: currentProject?.typeId.id,
    limit: 20,
  });
  const activityItems = useMemo(
    () =>
      collaborationRoomRows.map((row) => ({
        id: row.id,
        name: row.name,
        type: 'collaboration_room' as const,
        // Subtitle = host. ProjectActivityStrip already renders the timestamp
        // (from modifiedAt) on the row, so the subtitle line reads:
        //   `<name>`  (big)
        //   `by <host> · <time-ago>`  (rendered across subtitle + timestamp slots)
        subtitle: row.hostName ? `by ${row.hostName}` : '',
        // `path`'s last segment is rendered as the chip — use the project name.
        path: row.projectName,
        modifiedAt: row.updatedAt,
      })),
    [collaborationRoomRows],
  );

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
        case 'collaboration_room': {
          const row = collaborationRoomRows.find((r) => r.id === resource.id);
          if (row && row.projectId) {
            navigation.openDock(
              DockPointer.forProject(row.projectId, { roomId: row.id }),
            );
          }
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
    [
      navigation,
      resourceNavigationOptions,
      selectedClaudeProjectEncodedName,
      handleSessionResume,
      collaborationRoomRows,
    ],
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
        notify.error({ title: 'Session unavailable', message: 'No session ID or working directory found.' });
        return;
      }
      await actOnClassification(resource.sessionId, cwd, command);
    },
    [actOnClassification, selectedClaudeProjectCwd],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top row: UsageBar + Search */}
      <div className="flex shrink-0 items-center gap-2 p-4">
        <AdvancedOnly className="w-72 shrink-0">
          <UsageBar />
        </AdvancedOnly>
        <div className="flex-1" />
        <div className="relative w-72 shrink-0">
          <RecordSearchBar
            query={searchQuery}
            filters={searchFilters}
            onQueryChange={setSearchQuery}
            onFiltersChange={setSearchFilters}
            onSubmit={handleSearchSubmit}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search..."
          />
          {searchQuery.trim().length >= 2 && (
            <div className="absolute right-0 top-full z-50 w-[600px] pt-1">
              <InlineSearchResults
                query={searchQuery}
                filters={searchFilters}
                scope={searchScope}
                scopeLoading={searchScopeLoading}
                selectedIndex={selectedResultIndex}
                onSelectedIndexChange={setSelectedResultIndex}
                onOpenFullSearch={handleSearchSubmit}
                onNavigateResult={handleNavigateResult}
              />
            </div>
          )}
        </div>
      </div>

      {/* Main row: Sidebar + Content */}
      <div className="flex min-h-0 flex-1 gap-6 px-4 pb-4">
        {/* Left column: Bookmarks / Todos */}
        <div className="w-72 shrink-0 flex flex-col gap-2">
          {/* Top spacer — mirrors the Inbox strip header height (h-9) so
              Bookmarks/Todos stay aligned with the Inbox column on the right. */}
          <div aria-hidden className="h-9 shrink-0" />

          <BookmarkColumn
            learningTasks={learningTasks}
            bookmarks={bookmarks}
            annotations={commentAnnotations}
            errorCount={errorCount}
            onErrorClick={() => navigation.openLens('heartbeat', 'errors', 'open')}
            onAddComment={createComment}
            onArchiveLearning={(task) => void archiveTask(task)}
            onArchiveAllLearnings={() => void removeTasks(learningTasks)}
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

        {/* Middle column: Main content + Quick Access.
            overflow-y-auto (not -hidden) so a tall section — e.g. an expanded
            Feed entry — scrolls into view instead of being clipped under the
            footer; min-h-0 lets it actually shrink to its flex track so the
            scroll engages. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {/* Main content area - shrink-0 so it never collapses */}
          <div className="flex shrink-0 flex-col items-center gap-6 pb-6 text-center">
            <h1 className="text-4xl font-bold tracking-tight">
              Hey{' '}
              <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
            </h1>

            <div className="w-full max-w-3xl flex flex-col items-end gap-2">
              <SessionInput
                placeholder="What would you like to work on?"
                value={draftPrompt}
                onChange={setDraftPrompt}
                onSubmit={(msg) => void handleSessionSubmit(msg)}
              />
              <div className="flex w-full flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-violet-600/60 bg-transparent px-2.5 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-50 dark:border-violet-400/60 dark:text-violet-400 dark:hover:bg-violet-950/40"
                  onClick={() => setShowCommunityAssistance(true)}
                >
                  <Users className="h-3 w-3" />
                  Community assistance
                </button>
              </div>
            </div>

            <Feed />

            <div className="w-full max-w-3xl">
              <MiniDesktop />
            </div>

            <ActivityIndicator
              variant="strip"
              className="w-full max-w-3xl flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors text-left"
            />

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

          {/* Notifications section */}
          <div className="w-full max-w-3xl shrink-0 self-center">
            <NotificationFeed />
          </div>

          {/* Event Sniffer chip (trace heartbeat), aligned to bottom of side
              columns — Advanced-only, hidden in Standard to tune down UI. */}
          <AdvancedOnly className="mt-auto w-full max-w-3xl shrink-0 self-center">
            <EventSnifferChip />
          </AdvancedOnly>
        </div>

        {/* Right column: Recent conversations */}
        <div className="w-72 shrink-0 flex flex-col gap-2">
          {/* Invisible spacer mirroring the left column's Inbox row so Recent conversations aligns with Todos */}
          <div aria-hidden className="h-9 shrink-0" />
          <RecentConversationsStrip />
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

      <CommunityAssistanceDialog
        open={showCommunityAssistance}
        onClose={() => setShowCommunityAssistance(false)}
      />

      {/* Incoming task dialog — pull/clone flow for shared tasks */}
      {pendingTask && (
        <IncomingTaskDialog
          open={!!pendingTask}
          taskId={pendingTask.taskId}
          taskTitle={pendingTask.taskTitle}
          senderName={pendingTask.senderName}
          projectUrl={pendingTask.projectUrl}
          branch={pendingTask.branch}
          repoId={pendingTask.repoId}
          onClose={() => setPendingTask(null)}
        />
      )}
    </div>
  );
}

export default HomeLanding;
