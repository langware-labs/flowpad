import { IncomingTaskDialog } from '@src/components/task-receive/IncomingTaskDialog';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { UsageBar } from '@src/components/cost-dashboard';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { NotificationFeed, notify } from '@src/notifications';
import { RecentConversationsStrip } from '@src/components/project-activity-strip';
import { EventSnifferChip } from '@src/components/hooks/EventSnifferChip';
import { MiniDesktop } from '@src/components/quick-create';
import { SessionInput } from '@src/components/session-input/session-input';
import { useGlobalSearchScope } from '@src/hooks/use-global-search-scope';
import { AdvancedOnly, VibeSwap } from '@src/components/view-mode';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useProjects } from '@src/hooks/use-projects';
import { apiClient, ComputeNode, dataContext, isCompleteGitOrigin, PrefKey, ProcessKind, Project, TypeId } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { useAuth, useProject } from '@sdk/react/hooks';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { ActivityIndicator } from '@src/components/search-index/ActivityIndicator';
import { WelcomeModal } from '@src/components/search-index/WelcomeModal';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type React from 'react';
import { SearchFilters, SearchResult } from '@src/hooks/use-record-search';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { InlineSearchResults } from './InlineSearchResults';
import { HomeFeedColumn } from './feed';
import { X, CheckCircle2 } from 'lucide-react';
import { useInboxStore } from '@src/store/use-inbox-store';
import { listInboxMessages } from '@src/components/inbox-view/inbox-api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitOrigin, LastScanResult } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

// The vibe agent's asset_ref is stable for the app's lifetime — resolve once,
// reuse across builds. Raw graph route (not useEntitiesQuery) because system
// (SDK-shipped) agents only surface with include_system=true. Failed lookups
// are NOT cached so a late-indexed agent is picked up on the next submit.
let vibeAgentRefCache: string | null = null;
async function resolveVibeAgentRef(): Promise<string | null> {
  if (vibeAgentRefCache) return vibeAgentRefCache;
  const rows = await apiClient.get<{ name?: string; asset_ref?: string }[]>(
    '/graph/agent?include_system=true',
  );
  vibeAgentRefCache = (rows ?? []).find((r) => r.name === 'vibe')?.asset_ref ?? null;
  return vibeAgentRefCache;
}

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
const _SCAN_DISMISSED_KEY = 'flowpad-scan-dismissed';

export function HomeLanding() {
  const { t } = useLingui();
  const { user } = useAuth();
  const { navigation } = useDockNavigation();
  useProjects();

  // Incoming task dialog — driven by URL params (email deep-link) or WS events.
  // Deep link shape:
  //   ?action=open&fm=<id>[&conversation_id=...&task_id=...&git_origin=...&...]
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
    for (const key of ['action', 'fm', 'conversation_id', 'task_id', 'title', 'sender_name', 'git_origin']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url.toString());

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
  const { project: currentProject } = useProject();
  const { resetAndRescan, scanInfo, lastScanResult } = useSystemTools();
  const [showWelcome, setShowWelcome] = useState(false);
  const [indexApproved, setIndexApproved] = usePreference<boolean>(PrefKey.INDEXING_APPROVED);
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
    if (indexApproved || sessionStorage.getItem(_SCAN_DISMISSED_KEY) || !scanInfo) return;
    if (scanInfo.never_indexed) setShowWelcome(true);
  }, [scanInfo, indexApproved]);
  const firstName = user?.name?.split(' ')[0] || 'there';

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

  // Get paths from desktop_info
  const paths = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths, []);

  // Home submit opens its session in the vibe workspace (see the viewMode flag
  // on openShellProcess below), which hosts a HEADLESS project-Chat process —
  // not a PTY terminal. So the home session must BE that process model, else
  // the vibe chat can't attach to it and the prompt never runs. Delegate to
  // the vibe seed rather than the old PTY `createAndStartSession` path.
  const handleSessionSubmit = (message: string) => handleVibeSubmit(message);

  // Vibe submit — seed a HEADLESS chat process that the VibeWorkspace's side
  // chat attaches to (by the project-TypeId target), with the Flowpad Assistant
  // mounted so the web-app-builder skill is discoverable. Navigating to the
  // process's SHELL/agentic_process dock activates it (loader sets the active
  // process) and flow-page renders the chat↔display split.
  //
  // The session is bound to the SDK-shipped `vibe` agent (single embedded
  // agent ⇒ the driver's persona directive on every turn) — the agent body
  // carries the creator routing + the `flow show` presentation contract that
  // drives the vibe display. Best-effort: an un-indexed agent just means a
  // plain assistant session.
  const handleVibeSubmit = (message: string) => {
    if (!currentProject?.id) {
      notify.error({ title: t`Project Required`, message: t`Please select or create a project first.` });
      return;
    }
    const projectId = currentProject.id;
    // Key the build session to the project's id-based TypeId (NOT currentProject.typeId,
    // which is the uname form `project-@local` — VibeWorkspace's chat target must match
    // this exact string to attach to the same process).
    const target = new TypeId(Project.type, projectId).toString();
    const workdir = currentProject.fs_storage_mount_path || currentProject.name || paths?.workspace || undefined;

    void (async () => {
      try {
        const computeNode = await ComputeNode.getById('@local');
        if (!computeNode) throw new Error('No local compute node');
        const proc = await computeNode.createProcess(
          {
            workdir: workdir ?? undefined,
            projectId,
            targetVfsPath: target,
            processType: ProcessKind.Chat,
            loadFlowpadAssistant: true,
            outputFormat: 'stream-json',
          },
          // Headless JSON-stream transport — the vibe chat is a side panel, not
          // a terminal; PTY transport would pre-fill (not run) the first prompt.
          { pty_mode: false },
        );
        // Embed the vibe agent (persona) before the first turn.
        try {
          const vibeRef = await resolveVibeAgentRef();
          if (vibeRef) await proc.loadEmbeddedAgent(vibeRef);
          else console.warn('[Vibe] vibe agent not indexed; continuing without persona');
        } catch (e) {
          console.warn('[Vibe] failed to embed vibe agent; continuing without persona', e);
        }
        // Open the workspace FIRST — a headless prompt() resolves only when the
        // whole turn finishes, and the display must be mounted to catch the
        // agent's live `flow show` (on_show). Then fire the message verbatim —
        // it's a chat; the vibe persona routes building on its own.
        void navigation.openShellProcess(proc.id, { viewMode: ViewMode.Vibe });
        proc.prompt(message).catch((e) => console.error('[Vibe] prompt failed', e));
      } catch (error) {
        console.error('[HomeLanding] Failed to start vibe session:', error);
        notify.error({ title: t`Could not start`, message: t`Failed to start the build session.` });
      }
    })();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
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
                <Trans>
                  Build something <span className="vibe-gradient-text">amazing</span>
                </Trans>
              </h1>
              <p className="text-lg text-muted-foreground">
                <Trans>Create apps and tools by chatting with AI</Trans>
              </p>
              <div className="w-full">
                <SessionInput
                  placeholder={t`What would you like to build, ${firstName}?`}
                  value={draftPrompt}
                  onChange={setDraftPrompt}
                  onSubmit={(msg) => void handleVibeSubmit(msg)}
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
              <Trans>
                Hey <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">{firstName}</span>
              </Trans>
            </h1>

            <div className="flex w-full max-w-3xl flex-col items-end gap-2">
              <SessionInput
                placeholder={t`What would you like to work on?`}
                value={draftPrompt}
                onChange={setDraftPrompt}
                onSubmit={(msg) => void handleSessionSubmit(msg)}
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

        <div className="hidden lg:block">
          <HomeFeedColumn />
        </div>

      </div>
          </>
        }
      />

      {/* Welcome modal for first-time / not-yet-indexed users */}
      <WelcomeModal
        open={showWelcome}
        onStart={() => {
          setIndexApproved(true);
          setShowWelcome(false);
          void resetAndRescan();
        }}
        onSkip={() => {
          sessionStorage.setItem(_SCAN_DISMISSED_KEY, '1');
          setShowWelcome(false);
        }}
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
    </div>
  );
}

export default HomeLanding;
