import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { ProjectSelector } from '@src/components/project-selector';
import { SummaryDashboard } from '@src/components/summary-dashboard';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { SessionStatusDot } from '@src/components/ui/session-status-dot';
import { useProjectList, useClaudeProjectResources, getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { useClaudeHistory, type HistoryEntryResponse } from '@src/hooks/useClaudeHistory';
import { useSystemProfile } from '@src/hooks/use-system-profile';
import { type NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type AgentItem,
  type CommandItem,
  type DirectoryItem,
  type GitHubRepoItem,
  type HookItem,
  type MarketplaceItem,
  type PlanItem,
  type PluginItem,
  type SkillItem,
  type SystemProfile,
  type TodoEntry,
  type TodoFileItem,
} from '@sdk';
import {
  Activity,
  BarChart3,
  Bot,
  CheckCircle,
  CheckSquare,
  Clock,
  Command,
  Cpu,
  FileText,
  FolderOpen,
  GitBranch,
  HardDrive,
  Home,
  Loader2,
  Monitor,
  Plug,
  RefreshCw,
  Settings,
  Sparkles,
  Terminal,
  Timer,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Section types for navigation
 */
type SectionType =
  | 'summary'
  | 'transcripts'
  | 'plugins'
  | 'hooks'
  | 'directories'
  | 'repos'
  | 'sessions'
  | 'projects'
  | 'plans'
  | 'todos'
  | 'ide'
  | 'skills'
  | 'commands'
  | 'agents';

/**
 * Scope filter types and constants
 */
type ScopeFilter = 'all' | 'global' | 'project';
const GLOBAL_SCOPES = ['managed', 'user', 'global', 'legacy'];
const PROJECT_SCOPES = ['project', 'local'];

/**
 * Section button config
 */
interface SectionConfig {
  id: SectionType;
  label: string;
  icon: React.ElementType;
  badge?: string | number;
}

/**
 * LiveStatus - Displays comprehensive CLI status information
 *
 * URL-based navigation: /dock/system_profile/<tab>?item=<item>
 * - tab: summary, projects, sessions, skills, commands, agents, plugins, hooks, directories, repos, plans, ide
 * - item: optional item identifier within the tab
 */
export function LiveStatus() {
  const { currentDock, navigation } = useDockNavigation();

  // Read active section from URL (dock pointer), default to 'summary'
  const activeSection: SectionType = (currentDock?.pointer as SectionType) || 'summary';

  // Skip full system profile fetch when on projects tab (uses useResources with cache)
  const skipFullFetch = activeSection === 'projects';

  // Use system profile hook for data fetching with caching
  const { data, isLoading, error, refetch } = useSystemProfile({ skip: skipFullFetch });

  // History entries from fs-records (replaces data.sessions for Sessions + Transcripts tabs)
  const { entries: historyEntries, isLoading: historyLoading } = useClaudeHistory(100);

  // Read scope filter from URL options
  const scopeFilter: ScopeFilter = (currentDock?.options?.scope as ScopeFilter) || 'all';
  const selectedProjectEncoded = currentDock?.options?.project || null;

  // Navigate to a tab by updating the URL, preserving scope filter
  // Use null for project to explicitly clear it, undefined to keep current value
  const navigateToTab = (tab: SectionType, item?: string, options?: { scope?: string; project?: string | null }) => {
    const newScope = options?.scope ?? scopeFilter;
    // Clear project if explicitly set to null, or if scope is not 'project'
    const newProject =
      options?.project === null || (newScope !== 'project' && options?.scope !== undefined)
        ? undefined
        : (options?.project ?? selectedProjectEncoded ?? undefined);
    navigation.openSystemProfile(tab, item, {
      scope: newScope,
      project: newProject,
    });
  };

  // Compute filtered data based on scope filter
  const filteredData = useMemo(() => {
    if (!data) return null;

    // Find selected project if any
    const selectedProject = selectedProjectEncoded
      ? data.projects.find((p) => p.encoded_name === selectedProjectEncoded)
      : null;

    // Filter helper for items with scope
    const filterByScope = <T extends { scope?: string }>(items: T[]): T[] => {
      if (scopeFilter === 'all') return items;
      if (scopeFilter === 'global') return items.filter((i) => GLOBAL_SCOPES.includes(i.scope || ''));
      return items.filter((i) => PROJECT_SCOPES.includes(i.scope || ''));
    };

    // Filter helper for items by project path
    const filterByProject = <T extends { source_file?: string | null; path?: string | null }>(items: T[]): T[] => {
      if (!selectedProject?.cwd) return items;
      const prefix = `${selectedProject.cwd}/.claude/`;
      return items.filter((i) => {
        const p = i.source_file || i.path || '';
        return p.startsWith(prefix);
      });
    };

    // Combined filter for items with scope and path
    const filterItems = <T extends { scope?: string; source_file?: string | null; path?: string | null }>(
      items: T[],
    ): T[] => {
      let filtered = filterByScope(items);
      if (scopeFilter === 'project' && selectedProject) {
        filtered = filterByProject(filtered);
      }
      return filtered;
    };

    // Filter sessions by project (sessions don't have scope, they belong to projects)
    let sessions = data.sessions;
    if (scopeFilter === 'project' && selectedProject?.cwd) {
      sessions = sessions.filter((s) => s.cwd === selectedProject.cwd);
    }

    // Filter todos by project. Todos no longer carry a project field directly —
    // resolve via their session_id → that session's cwd.
    let todos = data.todos || [];
    if (scopeFilter === 'project' && selectedProject?.cwd) {
      const sessionCwds = new Map(data.sessions.map((s) => [s.session_id, s.cwd]));
      todos = todos.filter((t) => sessionCwds.get(t.session_id) === selectedProject.cwd);
    }

    return {
      ...data,
      sessions,
      todos,
      hooks: filterItems(data.hooks),
      mcpServers: filterItems(data.mcpServers),
      agents: filterItems(data.agents),
      commands: filterItems(data.commands),
      skills: filterItems(data.skills),
      claudeMdFiles: filterItems(data.claudeMdFiles),
      plugins: filterItems(data.plugins),
      // Keep unfiltered (no scope concept or always show all)
      projects: data.projects,
      directories: data.directories,
      githubRepos: data.githubRepos,
      plans: data.plans,
      marketplaces: data.marketplaces,
    };
  }, [data, scopeFilter, selectedProjectEncoded]);

  // Build sections with badges from filtered data
  const { t } = useLingui();
  const sections: SectionConfig[] = [
    { id: 'summary', label: t`Summary`, icon: Home },
    { id: 'transcripts', label: t`Transcripts`, icon: BarChart3 },
    { id: 'projects', label: t`Projects`, icon: Activity, badge: filteredData?.summary.totalProjects },
    { id: 'sessions', label: t`Sessions`, icon: Clock, badge: historyEntries.length },
    { id: 'skills', label: t`Skills`, icon: Sparkles, badge: filteredData?.skills.length },
    { id: 'commands', label: t`Commands`, icon: Command, badge: filteredData?.commands.length },
    { id: 'agents', label: t`Sub-agents`, icon: Bot, badge: filteredData?.agents.length },
    { id: 'plugins', label: t`Plugins`, icon: Plug, badge: filteredData?.plugins.length },
    { id: 'hooks', label: t`Hooks`, icon: Settings, badge: filteredData?.hooks.length },
    { id: 'directories', label: t`Directories`, icon: FolderOpen },
    { id: 'repos', label: t`Repos`, icon: GitBranch, badge: filteredData?.githubRepos.length },
    { id: 'plans', label: t`Plans`, icon: FileText, badge: filteredData?.plans.length },
    { id: 'todos', label: t`Todos`, icon: CheckSquare, badge: filteredData?.todos?.length },
    { id: 'ide', label: t`IDE`, icon: Monitor, badge: filteredData?.ideConnections },
  ];

  // Loading state - but don't block projects tab which uses its own data fetching
  if (isLoading && !skipFullFetch) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background">
        <FusionSpinner size="lg" className="text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>Loading system profile...</Trans>
        </p>
      </div>
    );
  }

  // Error state - but don't block projects tab which uses its own data fetching
  if ((error || !data) && !skipFullFetch) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background">
        <div className="text-center">
          <Terminal className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">{error || t`No data available`}</p>
          <button
            onClick={() => void refetch()}
            className="mt-4 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw className="h-4 w-4" />
            <Trans>Retry</Trans>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Terminal className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">
          <Trans>Claude Code Status</Trans>
        </span>
        {data?.machine && <span className="text-xs text-muted-foreground">• {data.machine}</span>}

        {/* Scope Filter */}
        <select
          value={scopeFilter}
          onChange={(e) => {
            const newScope = e.target.value as ScopeFilter;
            navigateToTab(activeSection, undefined, {
              scope: newScope,
              // Keep project only if staying in project scope, otherwise clear it
              project: newScope === 'project' ? selectedProjectEncoded : null,
            });
          }}
          className="ms-auto h-6 rounded border border-border bg-background px-1.5 text-xs"
        >
          <option value="all">
            <Trans>All</Trans>
          </option>
          <option value="global">
            <Trans>Global</Trans>
          </option>
          <option value="project">
            <Trans>Project</Trans>
          </option>
        </select>

        {/* Project Picker - only when scope = project */}
        {scopeFilter === 'project' && data && (
          <select
            value={selectedProjectEncoded || ''}
            onChange={(e) => {
              const projectValue = e.target.value;
              navigateToTab(activeSection, undefined, {
                scope: 'project',
                project: projectValue || null, // null to clear, string to set
              });
            }}
            className="h-6 max-w-[150px] rounded border border-border bg-background px-1.5 text-xs"
          >
            <option value="">
              <Trans>All Projects</Trans>
            </option>
            {[...data.projects]
              .sort((a, b) => b.session_count - a.session_count)
              .map((p) => (
                <option key={p.encoded_name} value={p.encoded_name}>
                  {p.name} ({p.session_count})
                </option>
              ))}
          </select>
        )}

        <button onClick={() => void refetch()} className="rounded p-1 hover:bg-muted" title={t`Refresh`}>
          <RefreshCw className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>

      {/* Section Toggle Buttons */}
      <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
        {sections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              onClick={() => navigateToTab(section.id)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon className="h-3 w-3" />
              <span>{section.label}</span>
              {section.badge !== undefined && Number(section.badge) > 0 && (
                <span
                  className={`ms-0.5 rounded-full px-1 text-[10px] ${
                    isActive ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted-foreground/20'
                  }`}
                >
                  {section.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto p-3">
        {activeSection === 'summary' && filteredData && (
          <SummarySection data={filteredData} onNavigate={(tab) => navigateToTab(tab as SectionType)} />
        )}
        {activeSection === 'transcripts' && (
          <TranscriptsSection entries={historyEntries} isLoading={historyLoading} navigation={navigation} />
        )}
        {activeSection === 'plugins' && filteredData && <PluginsSection data={filteredData} />}
        {activeSection === 'hooks' && filteredData && <HooksSection data={filteredData} />}
        {activeSection === 'directories' && filteredData && <DirectoriesSection data={filteredData} />}
        {activeSection === 'repos' && filteredData && <ReposSection data={filteredData} />}
        {activeSection === 'sessions' && (
          <SessionsSection
            entries={historyEntries}
            isLoading={historyLoading}
            selectedItemId={currentDock?.options?.item}
            navigation={navigation}
          />
        )}
        {activeSection === 'projects' && <ProjectsSection />}
        {activeSection === 'plans' && filteredData && <PlansSection data={filteredData} />}
        {activeSection === 'todos' && filteredData && <TodosSection data={filteredData} />}
        {activeSection === 'ide' && filteredData && <IDESection data={filteredData} />}
        {activeSection === 'skills' && filteredData && <SkillsSection data={filteredData} />}
        {activeSection === 'commands' && filteredData && <CommandsSection data={filteredData} />}
        {activeSection === 'agents' && filteredData && <AgentsSection data={filteredData} />}
      </div>
    </div>
  );
}

/**
 * Summary Section - Uses shared SummaryDashboard component
 * Shows aggregated stats across all projects with Projects card visible
 */
function SummarySection({ data, onNavigate }: { data: SystemProfile; onNavigate: (tab: string) => void }) {
  return (
    <div className="space-y-4">
      {/* Current Directory */}
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <HardDrive className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-muted-foreground">
            <Trans>Current Directory</Trans>
          </p>
          <p className="truncate font-mono text-xs">{data.summary.currentDirectory}</p>
        </div>
      </div>

      {/* Shared Summary Dashboard - shows all stats including Projects card */}
      <SummaryDashboard
        projectCwd={null} // Always show aggregated
        showProjectsCard={true} // Show Projects card in Summary tab
        onNavigate={onNavigate}
      />

      {/* Generated timestamp */}
      <p className="text-center text-[10px] text-muted-foreground">
        <Trans>Updated: {data.generated}</Trans>
      </p>
    </div>
  );
}

/**
 * Format number with K/M suffix
 */
function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

/**
 * Format duration from milliseconds to human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

/**
 * Compute aggregate stats from history entries with embedded sessions.
 */
function computeStatsFromHistory(entries: HistoryEntryResponse[]) {
  let sessionsAnalyzed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalDurationMs = 0;
  const modelsUsed: Record<string, number> = {};
  const toolsUsed: Record<string, number> = {};
  let totalToolUses = 0;
  const seenSessions = new Set<string>();

  for (const entry of entries) {
    const s = entry._session;
    if (!s || seenSessions.has(s.session_id)) continue;
    seenSessions.add(s.session_id);
    sessionsAnalyzed++;
    totalInputTokens += s.input_tokens || 0;
    totalOutputTokens += s.output_tokens || 0;
    totalCacheRead += s.cache_read_input_tokens || 0;
    totalCacheCreation += s.cache_creation_input_tokens || 0;
    totalDurationMs += s.duration_ms || 0;
    if (s.model) {
      modelsUsed[s.model] = (modelsUsed[s.model] || 0) + (s.assistant_message_count || 0);
    }
    if (s.tools_used) {
      for (const tool of s.tools_used) {
        toolsUsed[tool] = (toolsUsed[tool] || 0) + 1;
        totalToolUses++;
      }
    }
  }

  // Find primary model (most responses)
  const primaryModel = Object.entries(modelsUsed).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    sessionsAnalyzed,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    totalCacheCreation,
    totalDurationMs,
    modelsUsed,
    toolsUsed,
    totalToolUses,
    primaryModel,
  };
}

/**
 * Transcripts Section - Token usage, costs, and model statistics
 * Now powered by useClaudeHistory entries instead of SystemProfile.transcriptStats.
 */
function TranscriptsSection({
  entries,
  isLoading,
  navigation,
}: {
  entries: HistoryEntryResponse[];
  isLoading: boolean;
  navigation: NavigationActions;
}) {
  const { t } = useLingui();
  const stats = useMemo(() => computeStatsFromHistory(entries), [entries]);

  const handleEntryClick = (entry: HistoryEntryResponse) => {
    if (!entry.session_id) return;
    navigation.openLens('claude', 'transcript', entry.session_id);
  };

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="ms-2 text-sm text-muted-foreground">
          <Trans>Loading transcript data...</Trans>
        </span>
      </div>
    );
  }

  if (stats.sessionsAnalyzed === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground">
        <BarChart3 className="mx-auto mb-2 h-8 w-8 opacity-50" />
        <p>
          <Trans>No transcript data available</Trans>
        </p>
        <p className="text-xs">
          <Trans>Session data will appear after using Claude Code</Trans>
        </p>
      </div>
    );
  }

  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const cacheTokens = stats.totalCacheRead + stats.totalCacheCreation;

  return (
    <div className="space-y-4">
      {/* Header Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard
          icon={Activity}
          label={t`Sessions`}
          value={stats.sessionsAnalyzed.toString()}
          sublabel={t`analyzed`}
          color="blue"
        />
        <StatCard
          icon={Zap}
          label={t`Total Tokens`}
          value={formatNumber(totalTokens)}
          sublabel={`${formatNumber(stats.totalInputTokens)} in / ${formatNumber(stats.totalOutputTokens)} out`}
          color="purple"
        />
        <StatCard
          icon={Timer}
          label={t`Total Time`}
          value={formatDuration(stats.totalDurationMs)}
          sublabel={`across ${stats.sessionsAnalyzed} sessions`}
          color="green"
        />
        <StatCard
          icon={HardDrive}
          label={t`Cache Tokens`}
          value={formatNumber(cacheTokens)}
          sublabel={`${formatNumber(stats.totalCacheRead)} read / ${formatNumber(stats.totalCacheCreation)} write`}
          color="orange"
        />
      </div>

      {/* Token Breakdown */}
      <div className="rounded-lg border border-border bg-card p-3">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium">
          <Zap className="h-3.5 w-3.5 text-purple-500" />
          <Trans>Token Usage Breakdown</Trans>
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <TokenBar label={t`Input`} value={stats.totalInputTokens} total={totalTokens + cacheTokens} color="blue" />
          <TokenBar
            label={t`Output`}
            value={stats.totalOutputTokens}
            total={totalTokens + cacheTokens}
            color="purple"
          />
          <TokenBar
            label={t`Cache Read`}
            value={stats.totalCacheRead}
            total={totalTokens + cacheTokens}
            color="green"
          />
          <TokenBar
            label={t`Cache Write`}
            value={stats.totalCacheCreation}
            total={totalTokens + cacheTokens}
            color="orange"
          />
        </div>
      </div>

      {/* Model Usage */}
      {Object.keys(stats.modelsUsed).length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Bot className="h-3.5 w-3.5 text-blue-500" />
            <Trans>Models Used</Trans>
          </h3>
          <div className="space-y-1">
            {Object.entries(stats.modelsUsed)
              .sort((a, b) => b[1] - a[1])
              .map(([model, count]) => (
                <div key={model} className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
                  <span className="truncate font-mono text-xs">{model}</span>
                  <span className="text-xs text-muted-foreground">
                    {count} {count === 1 ? t`response` : t`responses`}
                    {model === stats.primaryModel && (
                      <span className="ms-1 rounded bg-blue-500/10 px-1 text-[10px] text-blue-600">
                        <Trans>primary</Trans>
                      </span>
                    )}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Tool Usage */}
      {stats.totalToolUses > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Terminal className="h-3.5 w-3.5 text-purple-500" />
            <Trans>Tools Used</Trans>
          </h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.toolsUsed)
              .sort((a, b) => b[1] - a[1])
              .map(([tool, count]) => (
                <div key={tool} className="rounded bg-muted/50 px-2 py-1">
                  <span className="font-mono text-xs font-medium">{tool}</span>
                  <span className="ms-1 text-xs text-muted-foreground">({count})</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Recent Sessions Table */}
      {entries.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-card p-3">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium">
            <FileText className="h-3.5 w-3.5 text-blue-500" />
            <Trans>Recent Transcripts</Trans>
            <span className="text-[10px] text-muted-foreground">
              <Trans>Click to view</Trans>
            </span>
          </h3>

          {/* Table Header */}
          <div className="grid grid-cols-[1fr_80px_60px_60px] gap-2 border-b border-border px-2 py-1 text-[10px] font-medium text-muted-foreground">
            <span>
              <Trans>Session</Trans>
            </span>
            <span>
              <Trans>Messages</Trans>
            </span>
            <span>
              <Trans>Tokens</Trans>
            </span>
            <span>
              <Trans>Duration</Trans>
            </span>
          </div>

          {/* Session Rows - show up to 20, deduplicated by session_id */}
          <div className="max-h-60 overflow-auto">
            {entries.slice(0, 20).map((entry) => {
              const s = entry._session;
              const tok = s ? (s.input_tokens || 0) + (s.output_tokens || 0) : 0;
              const hasSession = !!s;

              return (
                <button
                  key={entry.id}
                  onClick={() => handleEntryClick(entry)}
                  disabled={!hasSession}
                  className={`grid w-full grid-cols-[1fr_80px_60px_60px] items-center gap-2 rounded px-2 py-1.5 text-start transition-colors ${
                    hasSession
                      ? 'cursor-pointer hover:bg-primary/5 hover:text-primary'
                      : 'cursor-not-allowed opacity-60'
                  }`}
                  title={s?.jsonl_path || undefined}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {s?.status && <SessionStatusDot status={s.status} />}
                    <div className="min-w-0">
                      <span className="block truncate font-mono text-[10px]">
                        {s?.cwd || entry.display?.slice(0, 60) || entry.name}
                      </span>
                      <span className="block text-[9px] text-muted-foreground">
                        {entry.timestamp_ms ? new Date(entry.timestamp_ms).toLocaleString() : ''}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs">{s?.message_count ?? '-'}</span>
                  <span className="text-xs">{tok > 0 ? formatNumber(tok) : '-'}</span>
                  <span className="text-xs">{s?.duration_ms ? formatDuration(s.duration_ms) : '-'}</span>
                </button>
              );
            })}
          </div>

          {entries.length > 20 && (
            <p className="mt-1 text-center text-[10px] text-muted-foreground">
              <Trans>Showing 20 of {entries.length} entries</Trans>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Stat Card Component
 */
function StatCard({
  icon: Icon,
  label,
  value,
  sublabel,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sublabel?: string;
  color: 'blue' | 'purple' | 'green' | 'orange';
}) {
  const colorClasses = {
    blue: 'bg-blue-500/10 text-blue-500',
    purple: 'bg-purple-500/10 text-purple-500',
    green: 'bg-green-500/10 text-green-500',
    orange: 'bg-orange-500/10 text-orange-500',
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
      <div className={`flex h-8 w-8 items-center justify-center rounded ${colorClasses[color]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold leading-tight">{value}</p>
        <p className="text-[10px] text-muted-foreground">{label}</p>
        {sublabel && <p className="truncate text-[9px] text-muted-foreground/70">{sublabel}</p>}
      </div>
    </div>
  );
}

/**
 * Token Bar Component
 */
function TokenBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: 'blue' | 'purple' | 'green' | 'orange';
}) {
  const percentage = total > 0 ? (value / total) * 100 : 0;
  const colorClasses = {
    blue: 'bg-blue-500',
    purple: 'bg-purple-500',
    green: 'bg-green-500',
    orange: 'bg-orange-500',
  };

  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{formatNumber(value)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${colorClasses[color]} transition-all`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

/**
 * Plugins Section
 */
function PluginsSection({ data }: { data: SystemProfile }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-muted-foreground">
        <Trans>Installed Plugins</Trans>
      </h3>
      {data.plugins.length > 0 ? (
        <div className="space-y-2">
          {data.plugins.map((plugin: PluginItem) => (
            <div key={plugin.id} className="flex items-center justify-between rounded-lg bg-muted/50 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs">{plugin.name}</p>
                <p className="text-[10px] text-muted-foreground">v{plugin.version}</p>
              </div>
              <span className="text-[10px] text-muted-foreground">
                {plugin.modified_at ? new Date(plugin.modified_at).toLocaleDateString() : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          <Trans>No plugins installed</Trans>
        </p>
      )}

      <h3 className="mt-4 text-xs font-medium text-muted-foreground">
        <Trans>Marketplaces</Trans>
      </h3>
      {data.marketplaces.length > 0 ? (
        data.marketplaces.map((mp: MarketplaceItem) => (
          <div key={mp.id} className="rounded-lg bg-muted/50 px-2 py-1.5">
            <p className="text-xs font-medium">{mp.name}</p>
            <p className="text-[10px] text-muted-foreground">{mp.source}</p>
          </div>
        ))
      ) : (
        <p className="text-xs text-muted-foreground">
          <Trans>No marketplaces configured</Trans>
        </p>
      )}
    </div>
  );
}

/**
 * Hooks Section
 */
function HooksSection({ data }: { data: SystemProfile }) {
  const { t } = useLingui();
  // State for delete confirmation dialog - must be before any early returns
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [hookToDelete, setHookToDelete] = useState<HookItem | null>(null);

  if (data.hooks.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>No hooks configured</Trans>
      </p>
    );
  }

  // Helper to truncate from the beginning, showing end of string
  const truncateFromStart = (str: string, maxLen: number) => {
    if (str.length <= maxLen) return str;
    return '...' + str.slice(-(maxLen - 3));
  };

  // Helper to get short location from source_file
  // Shows the END of the directory path, removes .claude/settings*.json suffix
  const getShortLocation = (sourceFile: string | null | undefined) => {
    if (!sourceFile) return '-';

    // Remove the .claude/settings*.json suffix to get the base directory
    const basePath = sourceFile
      .replace(/\/.claude\/settings\.local\.json$/, '')
      .replace(/\/.claude\/settings\.json$/, '');

    // Determine if it's a local settings file
    const isLocal = sourceFile.includes('settings.local.json');

    // Show the end of the path (truncate from beginning)
    let displayPath = basePath;
    if (displayPath.length > 35) {
      displayPath = '...' + displayPath.slice(-32);
    }

    return isLocal ? `${displayPath} (local)` : displayPath;
  };

  // Helper to get scope badge color
  const getScopeBadgeClass = (scope: string) => {
    switch (scope) {
      case 'user':
      case 'global':
        return 'bg-blue-500/10 text-blue-600';
      case 'project':
        return 'bg-green-500/10 text-green-600';
      case 'local':
        return 'bg-purple-500/10 text-purple-600';
      case 'plugin':
        return 'bg-cyan-500/10 text-cyan-600';
      default:
        return 'bg-gray-500/10 text-gray-600';
    }
  };

  // Open delete confirmation dialog
  const handleDeleteClick = (hook: HookItem) => {
    setHookToDelete(hook);
    setDeleteDialogOpen(true);
  };

  // TODO: Implement actual delete
  const handleConfirmDelete = () => {
    if (hookToDelete) {
      // TODO: Implement actual deletion
      console.log('Delete hook:', hookToDelete.id);
    }
  };

  // TODO: Implement toggle enabled/disabled
  const handleToggleEnabled = (hook: HookItem, enabled: boolean) => {
    // TODO: Implement actual toggle
    console.log('Toggle hook:', hook.id, 'enabled:', enabled);
  };

  return (
    <div className="space-y-1">
      {/* Table Header */}
      <div className="grid grid-cols-[100px_55px_60px_minmax(150px,1fr)_minmax(120px,200px)_60px] gap-2 border-b border-border px-2 py-1 text-[10px] font-medium text-muted-foreground">
        <span>
          <Trans>Event</Trans>
        </span>
        <span>
          <Trans>Scope</Trans>
        </span>
        <span>
          <Trans>Matcher</Trans>
        </span>
        <span>
          <Trans>Command</Trans>
        </span>
        <span>
          <Trans>Location</Trans>
        </span>
        <span className="text-center">
          <Trans>Actions</Trans>
        </span>
      </div>

      {/* Table Rows */}
      {data.hooks.map((hook: HookItem) => (
        <div
          key={hook.id}
          className="grid grid-cols-[100px_55px_60px_minmax(150px,1fr)_minmax(120px,200px)_60px] items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50"
        >
          {/* Event Type - colored label */}
          <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-center text-[10px] font-medium text-orange-600">
            {hook.event_type}
          </span>

          {/* Scope */}
          <span
            className={`rounded px-1.5 py-0.5 text-center text-[10px] font-medium ${getScopeBadgeClass(hook.scope)}`}
          >
            {hook.scope}
          </span>

          {/* Matcher */}
          <span className="truncate text-[10px] text-muted-foreground" title={hook.matcher || '*'}>
            {hook.matcher || '*'}
          </span>

          {/* Command - truncated from start with tooltip */}
          <span className="cursor-help truncate font-mono text-[10px]" title={hook.command}>
            {truncateFromStart(hook.command, 50)}
          </span>

          {/* Location */}
          <span
            className="cursor-help truncate text-[10px] text-muted-foreground"
            title={hook.source_file || undefined}
          >
            {getShortLocation(hook.source_file)}
          </span>

          {/* Actions */}
          <div className="flex items-center justify-center gap-2">
            {/* Enable/Disable checkbox */}
            <input
              type="checkbox"
              defaultChecked={true}
              onChange={(e) => handleToggleEnabled(hook, e.target.checked)}
              className="h-3 w-3 cursor-pointer rounded border-muted-foreground"
              title={t`Enable/Disable hook`}
            />
            {/* Delete button */}
            <button
              onClick={() => handleDeleteClick(hook)}
              className="rounded p-0.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
              title={t`Delete hook`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
        </div>
      ))}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t`Delete Hook`}
        description={
          hookToDelete
            ? `Are you sure you want to delete the "${hookToDelete.event_type}" hook${hookToDelete.matcher ? ` with matcher "${hookToDelete.matcher}"` : ''}? This action cannot be undone.`
            : ''
        }
        confirmLabel={t`Delete`}
        cancelLabel={t`Cancel`}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

/**
 * Directories Section
 */
function DirectoriesSection({ data }: { data: SystemProfile }) {
  return (
    <div className="space-y-1">
      <p className="mb-2 font-mono text-xs text-muted-foreground">~/.claude/</p>
      {data.directories.map((dir: DirectoryItem) => (
        <div key={dir.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50">
          {dir.exists ? (
            <CheckCircle className="h-3 w-3 text-green-500" />
          ) : (
            <span className="h-3 w-3 text-center text-muted-foreground">·</span>
          )}
          <span className={`flex-1 font-mono text-xs ${dir.exists ? '' : 'text-muted-foreground'}`}>
            {dir.name}/
            {dir.count !== null && dir.count !== undefined && (
              <span className="text-muted-foreground"> ({dir.count})</span>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground">{dir.description}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Repos Section
 */
function ReposSection({ data }: { data: SystemProfile }) {
  if (data.githubRepos.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>No GitHub repos linked</Trans>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {data.githubRepos.map((repo: GitHubRepoItem) => (
        <div key={repo.id} className="rounded-lg bg-muted/50 px-2 py-1.5">
          <p className="text-xs font-medium text-primary">{repo.name}</p>
          <div className="mt-1 space-y-0.5">
            {repo.paths.map((path, i) => (
              <p key={i} className="truncate font-mono text-[10px] text-muted-foreground">
                {path}
              </p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Sessions Section
 */
function SessionsSection({
  entries,
  isLoading: loading,
  selectedItemId,
  navigation,
}: {
  entries: HistoryEntryResponse[];
  isLoading: boolean;
  selectedItemId?: string;
  navigation: NavigationActions;
}) {
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedItemId]);

  const handleEntryClick = (entry: HistoryEntryResponse) => {
    if (!entry.session_id) return;
    navigation.openLens('claude', 'transcript', entry.session_id);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">
          <Trans>Loading sessions...</Trans>
        </span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>No recent sessions</Trans>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const s = entry._session;
        const totalTokens = s ? (s.input_tokens || 0) + (s.output_tokens || 0) : 0;
        const isSelected = entry.session_id === selectedItemId || entry.id === selectedItemId;
        return (
          <div
            key={entry.id}
            ref={isSelected ? selectedRef : undefined}
            onClick={() => handleEntryClick(entry)}
            className={`cursor-pointer rounded-lg px-2 py-1.5 transition-colors ${
              isSelected ? 'bg-primary/10 ring-1 ring-primary' : 'bg-muted/50 hover:bg-muted'
            }`}
          >
            {/* Primary line: prompt text + status */}
            <div className="flex items-center gap-1.5">
              {s?.status && <SessionStatusDot status={s.status} />}
              <p className="truncate text-xs">{entry.display || entry.name}</p>
            </div>

            {/* Secondary line: metadata */}
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">
                {entry.timestamp_ms ? new Date(entry.timestamp_ms).toLocaleString() : ''}
              </span>
              {s && (
                <div className="flex gap-2 text-[10px]">
                  <span>
                    <span className="font-medium">{s.message_count}</span> <Trans>msgs</Trans>
                  </span>
                  <span>
                    <span className="font-medium">{s.tools_used?.length ?? 0}</span> <Trans>tools</Trans>
                  </span>
                </div>
              )}
              {s?.cwd && <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">{s.cwd}</span>}
              {s?.git_branch && (
                <span className="rounded bg-blue-500/10 px-1 py-0.5 text-[10px] text-blue-600">{s.git_branch}</span>
              )}
            </div>

            {/* Token and model info */}
            {s && totalTokens > 0 && (
              <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Zap className="h-2.5 w-2.5" />
                  {formatNumber(totalTokens)} tokens
                </span>
                {s.duration_ms > 0 && (
                  <span className="flex items-center gap-1">
                    <Timer className="h-2.5 w-2.5" />
                    {formatDuration(s.duration_ms)}
                  </span>
                )}
                {s.model && <span className="truncate font-mono text-[9px]">{s.model}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Projects Section - Two-column layout with project selector and summary dashboard
 *
 * Layout:
 * - Left: Narrow project list with selection state (fast ~50ms)
 * - Right: Summary dashboard showing project-specific stats when selected (lazy ~100ms)
 *
 * Uses new lazy loading hooks:
 * - useProjectList: Fast project enumeration (~50ms)
 * - useClaudeProjectResources: Per-project scan when selected (~100ms)
 */
function ProjectsSection() {
  const { currentDock, navigation } = useDockNavigation();

  // Fast project list (just enumeration, ~50ms)
  const { projects, isLoading: isLoadingProjects, error: projectsError } = useProjectList();

  // Get selected project from URL
  const selectedProjectEncoded = currentDock?.options?.project || null;

  // Lazy load selected project's resources (~100ms when selected)
  const {
    data: projectResources,
    isLoading: isLoadingResources,
    error: resourcesError,
  } = useClaudeProjectResources(selectedProjectEncoded);

  // Handle project selection - update URL
  const handleProjectSelect = (encodedName: string | null) => {
    navigation.openSystemProfile('projects', undefined, {
      project: encodedName ?? undefined,
    });
  };

  // Handle navigation to other tabs from the dashboard
  const handleNavigate = (tab: string) => {
    navigation.openSystemProfile(tab);
  };

  // Error state
  if (projectsError && projects.length === 0) {
    return <p className="text-xs text-destructive">Error loading projects: {projectsError}</p>;
  }

  // Empty state (no projects at all)
  if (!isLoadingProjects && projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <FolderOpen className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
            <Trans>No projects found</Trans>
          </p>
          <p className="text-xs text-muted-foreground">
            <Trans>Run Claude Code in a project directory to see it here.</Trans>
          </p>
        </div>
      </div>
    );
  }

  // ProjectSelector takes a generic id — pass encoded_name so callbacks land
  // in the same shape `handleProjectSelect` already expects.
  const projectItems = projects.map((p) => ({
    id: p.encoded_name,
    name: getProjectDisplayName(p),
    path: p.cwd || '',
    modifiedAt: p.modified_at ?? null,
  }));

  return (
    <div className="flex h-full gap-4">
      {/* Left: Project list (narrow) */}
      <div className="w-52 shrink-0">
        <ProjectSelector
          projects={projectItems}
          selectedId={selectedProjectEncoded}
          onSelect={handleProjectSelect}
          isLoading={isLoadingProjects}
        />
      </div>

      {/* Right: Summary dashboard or project resources */}
      <div className="flex-1 overflow-auto">
        {selectedProjectEncoded ? (
          // Show project-specific resources
          <ProjectResourcesDashboard
            projectEncodedName={selectedProjectEncoded}
            resources={projectResources}
            isLoading={isLoadingResources}
            error={resourcesError}
            onNavigate={handleNavigate}
          />
        ) : (
          // Show aggregated summary when no project selected
          <SummaryDashboard projectCwd={null} showProjectsCard={false} onNavigate={handleNavigate} />
        )}
      </div>
    </div>
  );
}

/**
 * Project Resources Dashboard - Shows resources for a selected project
 */
function ProjectResourcesDashboard({
  resources,
  isLoading,
  error,
}: {
  projectEncodedName: string;
  resources: import('@sdk').ScanProjectResponse | null;
  isLoading: boolean;
  error: string | null;
  onNavigate: (tab: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="ms-2 text-sm text-muted-foreground">
          <Trans>Loading project resources...</Trans>
        </span>
      </div>
    );
  }

  if (error) {
    return <p className="text-xs text-destructive">Error: {error}</p>;
  }

  if (!resources) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>Select a project to view resources</Trans>
      </p>
    );
  }

  const { summary, sessions, hooks, mcp_servers, total_session_count } = resources;

  return (
    <div className="space-y-4">
      {/* Project path */}
      {resources.project_cwd && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <p className="truncate font-mono text-xs">{resources.project_cwd}</p>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
          <Clock className="h-4 w-4 text-blue-500" />
          <div>
            <p className="text-sm font-bold">{summary.sessions}</p>
            <p className="text-[10px] text-muted-foreground">
              <Trans>Sessions</Trans>
              {total_session_count > summary.sessions && ` (${total_session_count} total)`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
          <Settings className="h-4 w-4 text-orange-500" />
          <div>
            <p className="text-sm font-bold">{summary.hooks}</p>
            <p className="text-[10px] text-muted-foreground">
              <Trans>Hooks</Trans>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
          <Plug className="h-4 w-4 text-green-500" />
          <div>
            <p className="text-sm font-bold">{summary.mcp_servers}</p>
            <p className="text-[10px] text-muted-foreground">
              <Trans>MCP Servers</Trans>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-2">
          <Sparkles className="h-4 w-4 text-purple-500" />
          <div>
            <p className="text-sm font-bold">{summary.skills}</p>
            <p className="text-[10px] text-muted-foreground">
              <Trans>Skills</Trans>
            </p>
          </div>
        </div>
      </div>

      {/* Recent sessions */}
      {sessions.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            <Trans>Recent Sessions</Trans>
          </h3>
          <div className="space-y-1">
            {sessions.slice(0, 5).map((session) => (
              <div key={session.id} className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
                <span className="truncate font-mono text-[10px]">{session.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {session.modified_at ? new Date(session.modified_at).toLocaleDateString() : ''}
                </span>
              </div>
            ))}
            {sessions.length > 5 && (
              <p className="text-center text-[10px] text-muted-foreground">
                <Trans>+{sessions.length - 5} more</Trans>
              </p>
            )}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {mcp_servers.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            <Trans>MCP Servers</Trans>
          </h3>
          <div className="space-y-1">
            {mcp_servers.map((server) => (
              <div key={server.id} className="rounded bg-muted/50 px-2 py-1">
                <span className="font-mono text-xs">{server.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hooks */}
      {hooks.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            <Trans>Hooks</Trans>
          </h3>
          <div className="space-y-1">
            {hooks.map((hook) => (
              <div key={hook.id} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1">
                <span className="rounded bg-orange-500/10 px-1 text-[10px] text-orange-600">{hook.event_type}</span>
                <span className="truncate font-mono text-[10px]">{hook.command}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scanned timestamp */}
      <p className="text-center text-[10px] text-muted-foreground">
        <Trans>Scanned: {resources.scanned_at}</Trans>
      </p>
    </div>
  );
}

/**
 * Plans Section
 */
function PlansSection({ data }: { data: SystemProfile }) {
  if (data.plans.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>No saved plans</Trans>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {data.plans.map((plan: PlanItem) => (
        <div key={plan.id} className="flex items-center justify-between rounded-lg bg-muted/50 px-2 py-1.5">
          <span className="truncate font-mono text-xs">{plan.name}</span>
          <div className="flex gap-2 text-[10px] text-muted-foreground">
            <span>{plan.modified_at ? new Date(plan.modified_at).toLocaleDateString() : ''}</span>
            <span>{plan.size_formatted}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Todos Section - Active task lists from Claude Code sessions
 */
function TodosSection({ data }: { data: SystemProfile }) {
  const [hideEmpty, setHideEmpty] = useState(true);
  const todos = data.todos || [];

  if (todos.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>No todo files found (~/.claude/todos/)</Trans>
      </p>
    );
  }

  // Filter out empty todos if hideEmpty is checked
  const filteredTodos = hideEmpty ? todos.filter((t) => t.entry_count > 0) : todos;

  // Sort by modified_at descending (most recent first)
  const sortedTodos = [...filteredTodos].sort((a, b) => {
    const aTime = a.modified_at ? new Date(a.modified_at).getTime() : 0;
    const bTime = b.modified_at ? new Date(b.modified_at).getTime() : 0;
    return bTime - aTime;
  });

  // Count how many are hidden
  const hiddenCount = todos.length - filteredTodos.length;

  return (
    <div className="space-y-3">
      {/* Header with filter */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">
          <Trans>Todo Files (~/.claude/todos/)</Trans>
        </h3>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
            className="h-3 w-3 rounded border-muted-foreground"
          />
          <Trans>Hide empty</Trans>
          {hiddenCount > 0 && <span className="text-[10px]">({hiddenCount})</span>}
        </label>
      </div>

      {/* Empty state when all todos are filtered */}
      {sortedTodos.length === 0 && (
        <p className="text-center text-xs text-muted-foreground">
          All {todos.length} todo files are empty.{' '}
          <button onClick={() => setHideEmpty(false)} className="text-primary underline">
            <Trans>Show all</Trans>
          </button>
        </p>
      )}

      {sortedTodos.map((todo: TodoFileItem) => (
        <div key={todo.id} className="rounded-lg border border-border bg-card p-2">
          {/* Header: Session info and timestamp */}
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs">{todo.name}</span>
              {todo.is_sub_agent && (
                <span className="rounded bg-purple-500/10 px-1 py-0.5 text-[10px] text-purple-600">
                  <Trans>sub-agent</Trans>
                </span>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground">
              {todo.modified_at ? new Date(todo.modified_at).toLocaleString() : ''}
            </span>
          </div>

          {/* Progress bar */}
          <div className="mb-2">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>
                {todo.completed_count}/{todo.entry_count} <Trans>completed</Trans>
              </span>
              <span>
                {todo.in_progress_count > 0 && (
                  <span className="text-yellow-600">
                    {todo.in_progress_count} <Trans>in progress</Trans>
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${todo.entry_count > 0 ? (todo.completed_count / todo.entry_count) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* Todo entries (if available) */}
          {todo.entries && todo.entries.length > 0 && (
            <div className="space-y-1">
              {todo.entries.map((entry: TodoEntry, idx: number) => (
                <div key={idx} className="flex items-start gap-2 rounded bg-muted/50 px-2 py-1">
                  <span
                    className={`mt-0.5 h-3 w-3 shrink-0 rounded-sm border ${
                      entry.status === 'completed'
                        ? 'border-green-500 bg-green-500'
                        : entry.status === 'in_progress'
                          ? 'border-yellow-500 bg-yellow-500/30'
                          : 'border-muted-foreground'
                    }`}
                  >
                    {entry.status === 'completed' && <CheckCircle className="h-3 w-3 text-white" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-xs ${
                        entry.status === 'completed'
                          ? 'text-muted-foreground line-through'
                          : entry.status === 'in_progress'
                            ? 'font-medium text-yellow-700 dark:text-yellow-400'
                            : ''
                      }`}
                    >
                      {entry.content}
                    </p>
                    {entry.status === 'in_progress' && entry.activeForm && (
                      <p className="text-[10px] italic text-muted-foreground">{entry.activeForm}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * IDE Section
 */
function IDESection({ data }: { data: SystemProfile }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
        <Cpu className="h-5 w-5 text-green-500" />
      </div>
      <div>
        <p className="text-lg font-bold">
          {data.ideConnections} <Trans>Active</Trans>
        </p>
        <p className="text-xs text-muted-foreground">
          <Trans>IDE Connections (VS Code, Cursor, etc.)</Trans>
        </p>
      </div>
    </div>
  );
}

/**
 * Skills Section - Skills & Usage Stats
 */
function SkillsSection({ data }: { data: SystemProfile }) {
  return (
    <div className="space-y-4">
      {/* Skills */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">
          <Trans>Skills (~/.claude/skills/)</Trans>
        </h3>
        {data.skills.length > 0 ? (
          <div className="space-y-1">
            {data.skills.map((skill: SkillItem) => (
              <div key={skill.id} className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
                <span className="font-mono text-xs">{skill.name}</span>
                {skill.usage_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {skill.usage_count} <Trans>uses</Trans>
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>No skills installed</Trans>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Commands Section
 */
function CommandsSection({ data }: { data: SystemProfile }) {
  // Separate global and project commands using scope constants
  const globalCommands = data.commands.filter((c: CommandItem) => GLOBAL_SCOPES.includes(c.scope || ''));
  const projectCommands = data.commands.filter((c: CommandItem) => PROJECT_SCOPES.includes(c.scope || ''));

  return (
    <div className="space-y-4">
      {/* Global Commands */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">
          <Trans>Global Commands (~/.claude/commands/)</Trans>
        </h3>
        {globalCommands.length > 0 ? (
          <div className="space-y-1">
            {globalCommands.map((cmd: CommandItem) => (
              <div key={cmd.id} className="rounded bg-muted/50 px-2 py-1 font-mono text-xs">
                {cmd.name}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>None</Trans>
          </p>
        )}
      </div>

      {/* Project Commands */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">
          <Trans>Project Commands (.claude/commands/)</Trans>
        </h3>
        {projectCommands.length > 0 ? (
          <div className="space-y-1">
            {projectCommands.map((cmd: CommandItem) => (
              <div key={cmd.id} className="rounded bg-muted/50 px-2 py-1 font-mono text-xs">
                {cmd.name}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>None</Trans>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Agents Section
 */
function AgentsSection({ data }: { data: SystemProfile }) {
  // Separate global and project agents using scope constants
  const globalAgents = data.agents.filter((a: AgentItem) => GLOBAL_SCOPES.includes(a.scope || ''));
  const projectAgents = data.agents.filter((a: AgentItem) => PROJECT_SCOPES.includes(a.scope || ''));

  return (
    <div className="space-y-4">
      {/* Global Agents */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">
          <Trans>Global Agents (~/.claude/agents/)</Trans>
        </h3>
        {globalAgents.length > 0 ? (
          <div className="space-y-1">
            {globalAgents.map((agent: AgentItem) => (
              <div key={agent.id} className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
                <span className="font-mono text-xs">{agent.name}</span>
                <span className="text-[10px] text-muted-foreground">{agent.scope}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>None</Trans>
          </p>
        )}
      </div>

      {/* Project Agents */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">
          <Trans>Project Agents (.claude/agents/)</Trans>
        </h3>
        {projectAgents.length > 0 ? (
          <div className="space-y-1">
            {projectAgents.map((agent: AgentItem) => (
              <div key={agent.id} className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
                <span className="font-mono text-xs">{agent.name}</span>
                <span className="text-[10px] text-muted-foreground">{agent.scope}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans>None</Trans>
          </p>
        )}
      </div>
    </div>
  );
}

export default LiveStatus;
