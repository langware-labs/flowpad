import { IncomingTaskDialog } from '@src/components/task-receive/IncomingTaskDialog';
import { IncomingProjectDialog } from '@src/components/task-receive/IncomingProjectDialog';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { UsageBar } from '@src/components/cost-dashboard';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { NotificationFeed } from '@src/notifications';
import { RecentConversationsStrip } from '@src/components/project-activity-strip';
import { EventSnifferChip } from '@src/components/hooks/EventSnifferChip';
import { MiniDesktop } from '@src/components/quick-create';
import { SessionInput } from '@src/components/session-input/session-input';
import { useGlobalSearchScope } from '@src/hooks/use-global-search-scope';
import { AdvancedOnly, VibeSwap } from '@src/components/view-mode';
import { useProjects } from '@src/hooks/use-projects';
import { useProject } from '@src/hooks/useProject';
import { useFS } from '@src/hooks/useFS';
import { isCompleteGitOrigin, Project, TypeId } from '@sdk';
import { useStartVibeSession } from '@src/pages/flow-page/use-start-vibe-session';
import { useAuth } from '@sdk/react/hooks';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { ActivityIndicator } from '@src/components/search-index/ActivityIndicator';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type React from 'react';
import { SearchFilters, SearchResult } from '@src/hooks/use-record-search';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { InlineSearchResults } from './InlineSearchResults';
import { HomeFeedColumn } from './feed';
import { X, CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitOrigin, LastScanResult } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { VIBE_MODEL_DEFAULT, VibeModelSelect, type VibeModelTier } from '@src/pages/flow-page/vibe-model-select';
import { VibeWorkerSelect } from '@src/pages/flow-page/vibe-worker-select';
import { DEFAULT_WORKER_TYPE, type WorkerType } from '@src/components/workers/worker-types';

/**
 * HomeLanding - Welcome view with greeting and quick action buttons
 *
 * Layout:
 * - Top row: Usage bar
 * - Main row:
 *   - Left column: Inbox
 *   - Middle column: Greeting, session input, and Quick Access
 *   - Right column: Feed
 * URL: /dock/home
 */
export function HomeLanding() {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const { navigation } = useDockNavigation();
  useProjects();

  // Incoming task dialog — driven by URL params (email deep-link) or WS events.
  // Deep link shape:
  //   ?action=open&fm=<id>[&conversation_id=...&task_id=...&git_origin=...&...]
  // The backend's /open handler unpacks the bundle and resolves
  // conversation_id / task_id from the FM's context, so we navigate directly
  // off the URL params — no FM lookup needed on the UI side.
  const { pendingTask, setPendingTask } = useIncomingTaskStore();
  const { pendingProject, setPendingProject } = useIncomingProjectStore();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'open') return;
    const fmId = params.get('fm') || '';
    const convId = params.get('conversation_id') || '';
    const taskId = params.get('task_id') || '';
    const isTemplate = params.get('project_template') === '1';
    const title = params.get('title') || 'Shared';
    const senderName = params.get('sender_name') || 'Someone';
    const gitOriginParam = params.get('git_origin');
    let gitOrigin: GitOrigin | null = null;
    if (gitOriginParam) {
      try {
        const parsed = JSON.parse(gitOriginParam) as GitOrigin;
        gitOrigin = isCompleteGitOrigin(parsed) ? parsed : null;
      } catch {
        gitOrigin = null;
      }
    }

    // Clean URL so refreshing doesn't re-trigger
    const url = new URL(window.location.href);
    for (const key of ['action', 'fm', 'conversation_id', 'task_id', 'project_template', 'title', 'sender_name', 'git_origin']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url.toString());

    // Template launch: "X shared a project with you" — clone the template repo
    // into a fresh, indexed Project on THIS box. Checked before the task branch
    // because a template also carries a git_origin (but no task_id).
    if (isTemplate && gitOrigin) {
      setPendingProject({ gitOrigin, projectName: title, senderName });
      return;
    }

    if (gitOrigin && taskId) {
      setPendingTask({ taskId, taskTitle: title, senderName, gitOrigin });
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
  const { lastScanResult } = useSystemTools();
  const [postScanResult, setPostScanResult] = useState<LastScanResult | null>(null);

  // Detect scan completion: when lastScanResult changes to a new value, capture it for display
  const prevLastScanResultRef = useRef<LastScanResult | null>(null);
  useEffect(() => {
    if (lastScanResult && lastScanResult !== prevLastScanResultRef.current) {
      setPostScanResult(lastScanResult);
    }
    prevLastScanResultRef.current = lastScanResult;
  }, [lastScanResult]);

  const firstName = currentUser?.name?.split(' ')[0] || 'there';

  // Per-project home branding from the ACTIVE project's `.flow/customization/`
  // (see backend Project.customization). A `home_title` overrides the greeting;
  // `home.png` renders as the home background. Absent → today's default home.
  const { project } = useProject();
  const custom = project?.customization;
  const homeTitle = custom?.home_title || null; // already trimmed server-side
  const projectTypeId = useMemo(
    () => (project?.id ? new TypeId(Project.type, project.id) : undefined),
    [project?.id],
  );
  const fs = useFS(projectTypeId);
  const homeBgUrl =
    custom?.has_home_background && fs ? fs.getDownloadUrl('.flow/customization/home.png') : null;
  // Render the greeting: the `.flow/customization` override when set, else the
  // layout's default. One decision point, two heroes (standard + vibe).
  const greeting = (spanClassName: string, fallback: React.ReactNode): React.ReactNode =>
    homeTitle ? <span className={spanClassName}>{homeTitle}</span> : fallback;

  const [draftPrompt, setDraftPrompt] = useState('');

  // Inbox unread count: backend-owned (InboxManager.unread) — the sidebar pip
  // reads it via useInboxManager(); no per-view recount here anymore.

  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);
  const [vibeModel, setVibeModel] = useState<VibeModelTier>(VIBE_MODEL_DEFAULT);
  const [vibeWorker, setVibeWorker] = useState<WorkerType>(DEFAULT_WORKER_TYPE);
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

  // Both home inputs seed the same headless vibe build session (create the
  // chat process, embed the `vibe` persona, open the workspace, prompt —
  // uploading any attachments to the process input dir first). Same shared
  // path as flow-page's "New chat" starter.
  const handleVibeSubmit = useStartVibeSession();

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Per-project home background image (`.flow/customization/home.png`), with
          a scrim so foreground text stays legible. Rendered behind everything. */}
      {homeBgUrl && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center"
            style={{ backgroundImage: `url("${homeBgUrl}")` }}
            data-testid="home-custom-background"
          />
          <div aria-hidden className="pointer-events-none absolute inset-0 z-0 bg-background/60" />
        </>
      )}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
      <VibeSwap
        vibe={
          /* VibeHome — Lovable-style single centered column: the prompt is the
             hero CTA. Side columns, search, feed, usage and notifications are
             dropped (still mounted in the fallback). Reuses SessionInput; submit
             goes to handleVibeSubmit (seeds a headless build session). */
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4">
            <div
              aria-hidden
              className="vibe-hero-gradient pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
            />
            <div className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-6 text-center">
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
                {greeting(
                  'vibe-gradient-text',
                  <Trans>
                    Build something <span className="vibe-gradient-text">amazing</span>
                  </Trans>,
                )}
              </h1>
              <p className="text-lg text-muted-foreground">
                <Trans>Create apps and tools by chatting with AI</Trans>
              </p>
              <div className="w-full">
                <SessionInput
                  placeholder={t`What would you like to work on, ${firstName}?`}
                  value={draftPrompt}
                  onChange={setDraftPrompt}
                  allowAttachments
                  footerSlot={
                    <div className="flex min-w-0 items-center gap-1.5">
                      <VibeModelSelect value={vibeModel} onChange={setVibeModel} />
                      <VibeWorkerSelect value={vibeWorker} onChange={setVibeWorker} />
                    </div>
                  }
                  onSubmit={(msg, files) => void handleVibeSubmit(msg, files, vibeModel, vibeWorker)}
                />
              </div>
            </div>
          </div>
        }
        fallback={
          <>
      {/* Top row: UsageBar + Search */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 p-3 sm:flex-nowrap sm:p-4">
        <AdvancedOnly className="hidden w-72 shrink-0 md:block">
          <UsageBar />
        </AdvancedOnly>
        <div className="hidden flex-1 sm:block" />
        <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
          <RecordSearchBar
            query={searchQuery}
            filters={searchFilters}
            onQueryChange={setSearchQuery}
            onFiltersChange={setSearchFilters}
            onSubmit={handleSearchSubmit}
            onKeyDown={handleSearchKeyDown}
            placeholder={t`Search...`}
          />
          {searchQuery.trim().length >= 2 && (
            <div className="absolute right-0 top-full z-50 w-[calc(100vw-2rem)] max-w-[600px] pt-1">
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
      <div className="flex min-h-0 flex-1 gap-4 px-3 pb-3 lg:gap-6 lg:px-4 lg:pb-4">
        {/* Left column: Inbox */}
        <div className="hidden w-72 shrink-0 flex-col gap-2 lg:flex">
          {/* Invisible spacer mirroring the right Feed column so Inbox aligns with Feed */}
          <div aria-hidden className="h-9 shrink-0" />
          <RecentConversationsStrip />
        </div>

        {/* Middle column: Main content + Quick Access. The column itself never
            scrolls; side panels own their own scrolling. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden sm:gap-6">
          {/* Hero — fixed at the top, never scrolls */}
          <div className="flex shrink-0 flex-col items-center gap-6 text-center">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              {greeting(
                'bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent',
                <Trans>
                  Hey <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
                </Trans>,
              )}
            </h1>

            <div className="flex w-full max-w-3xl flex-col items-end gap-2">
              <SessionInput
                placeholder={t`What would you like to work on?`}
                value={draftPrompt}
                onChange={setDraftPrompt}
                onSubmit={(msg) => void handleVibeSubmit(msg)}
              />
            </div>
          </div>

          {/* Quick Access — fixed below the hero */}
          <div className="flex shrink-0 flex-col items-center gap-6 text-center">
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
                    <Trans>Scan & index complete — {postScanResult.grand_total.toLocaleString()} records found</Trans>
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
                  <p className="px-3 py-2 text-xs text-muted-foreground"><Trans>No records found on disk.</Trans></p>
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

        <div className="hidden min-h-0 lg:block">
          <HomeFeedColumn />
        </div>

      </div>
          </>
        }
      />

      {/* Incoming task dialog — pull/clone flow for shared tasks */}
      {pendingTask && (
        <IncomingTaskDialog
          open={!!pendingTask}
          taskId={pendingTask.taskId}
          taskTitle={pendingTask.taskTitle}
          senderName={pendingTask.senderName}
          gitOrigin={pendingTask.gitOrigin}
          onClose={() => setPendingTask(null)}
        />
      )}

      {/* Incoming project dialog — "X shared a project with you" template launch */}
      {pendingProject && (
        <IncomingProjectDialog
          open={!!pendingProject}
          gitOrigin={pendingProject.gitOrigin}
          projectName={pendingProject.projectName}
          senderName={pendingProject.senderName}
          onClose={() => setPendingProject(null)}
        />
      )}
      </div>
    </div>
  );
}

export default HomeLanding;
