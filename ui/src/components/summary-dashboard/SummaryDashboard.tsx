import { useResources, SystemResourceType } from '@src/hooks/use-resources';
import {
  type AgentItem,
  type CommandItem,
  type HookItem,
  type PluginItem,
  type ProjectItem,
  type SkillItem,
  type TodoFileItem,
} from '@sdk';
import type { ClaudeSessionRecordData } from '@sdk/resource_management/fs_records/claude/claude-session';
import {
  Activity,
  Bot,
  CheckSquare,
  Clock,
  Command,
  FolderOpen,
  Loader2,
  Plug,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';

/**
 * Props for the SummaryDashboard component
 */
export interface SummaryDashboardProps {
  /** When set, shows project-specific data filtered by cwd; otherwise shows aggregated */
  projectCwd?: string | null;
  /** Show Projects card (true in Summary tab, false in Projects tab) */
  showProjectsCard?: boolean;
  /** Navigate to a tab */
  onNavigate?: (tab: string) => void;
}

/**
 * Stat card configuration
 */
interface StatCardConfig {
  id: string;
  label: string;
  icon: React.ElementType;
  count: number;
  isLoading: boolean;
  tab?: string;
  color?: 'blue' | 'purple' | 'green' | 'orange' | 'yellow' | 'pink' | 'cyan';
}

/**
 * SummaryDashboard - A reusable stats dashboard component
 *
 * Shows resource counts (projects, sessions, hooks, skills, etc.) in a grid of clickable cards.
 * Can be filtered by project or show aggregated counts.
 *
 * Used in:
 * - Summary tab: Shows all stats including Projects card
 * - Projects tab: Shows project-filtered stats without Projects card
 */
export function SummaryDashboard({ projectCwd, showProjectsCard = true, onNavigate }: SummaryDashboardProps) {
  // Fetch all resource types using the lazy loading hooks
  const { items: projects, isLoading: projectsLoading } = useResources<ProjectItem>(SystemResourceType.PROJECT);
  const { items: sessions, isLoading: sessionsLoading } = useResources<ClaudeSessionRecordData>(SystemResourceType.SESSION);
  const { items: hooks, isLoading: hooksLoading } = useResources<HookItem>(SystemResourceType.HOOK);
  const { items: skills, isLoading: skillsLoading } = useResources<SkillItem>(SystemResourceType.SKILL);
  const { items: commands, isLoading: commandsLoading } = useResources<CommandItem>(SystemResourceType.COMMAND);
  const { items: agents, isLoading: agentsLoading } = useResources<AgentItem>(SystemResourceType.AGENT);
  const { items: plugins, isLoading: pluginsLoading } = useResources<PluginItem>(SystemResourceType.PLUGIN);
  const { items: todos, isLoading: todosLoading } = useResources<TodoFileItem>(SystemResourceType.TODO);

  // Filter items by project if projectCwd is set
  const filteredCounts = useMemo(() => {
    if (!projectCwd) {
      // No filter - return all counts
      return {
        projects: projects.length,
        sessions: sessions.length,
        hooks: hooks.length,
        skills: skills.length,
        commands: commands.length,
        agents: agents.length,
        plugins: plugins.length,
        todos: todos.length,
      };
    }

    const projectPrefix = `${projectCwd}/.claude/`;

    // Filter sessions by cwd
    const filteredSessions = sessions.filter((s) => s.cwd === projectCwd);

    // Filter todos via the session they belong to.
    const sessionCwds = new Map(sessions.map((s) => [s.session_id, s.cwd]));
    const filteredTodos = todos.filter((t) => sessionCwds.get(t.session_id) === projectCwd);

    // Filter path-based items by project prefix
    const filterByPath = <T extends { source_file?: string | null; path?: string | null }>(items: T[]): T[] => {
      return items.filter((item) => {
        const path = item.source_file || item.path || '';
        return path.startsWith(projectPrefix);
      });
    };

    return {
      projects: 1, // When filtered, we have 1 project selected
      sessions: filteredSessions.length,
      hooks: filterByPath(hooks).length,
      skills: filterByPath(skills).length,
      commands: filterByPath(commands).length,
      agents: filterByPath(agents).length,
      plugins: filterByPath(plugins).length,
      todos: filteredTodos.length,
    };
  }, [projectCwd, projects, sessions, hooks, skills, commands, agents, plugins, todos]);

  // Build stat cards configuration
  const statCards: StatCardConfig[] = [
    ...(showProjectsCard
      ? [
          {
            id: 'projects',
            label: 'Projects',
            icon: FolderOpen,
            count: filteredCounts.projects,
            isLoading: projectsLoading,
            tab: 'projects',
            color: 'blue' as const,
          },
        ]
      : []),
    {
      id: 'sessions',
      label: 'Sessions',
      icon: Clock,
      count: filteredCounts.sessions,
      isLoading: sessionsLoading,
      tab: 'sessions',
      color: 'purple',
    },
    {
      id: 'hooks',
      label: 'Hooks',
      icon: Settings,
      count: filteredCounts.hooks,
      isLoading: hooksLoading,
      tab: 'hooks',
      color: 'orange',
    },
    {
      id: 'skills',
      label: 'Skills',
      icon: Sparkles,
      count: filteredCounts.skills,
      isLoading: skillsLoading,
      tab: 'skills',
      color: 'yellow',
    },
    {
      id: 'commands',
      label: 'Commands',
      icon: Command,
      count: filteredCounts.commands,
      isLoading: commandsLoading,
      tab: 'commands',
      color: 'green',
    },
    {
      id: 'agents',
      label: 'Agents',
      icon: Bot,
      count: filteredCounts.agents,
      isLoading: agentsLoading,
      tab: 'agents',
      color: 'pink',
    },
    {
      id: 'plugins',
      label: 'Plugins',
      icon: Plug,
      count: filteredCounts.plugins,
      isLoading: pluginsLoading,
      tab: 'plugins',
      color: 'cyan',
    },
    {
      id: 'todos',
      label: 'Todos',
      icon: CheckSquare,
      count: filteredCounts.todos,
      isLoading: todosLoading,
      tab: 'todos',
      color: 'green',
    },
  ];

  // Color classes for stat cards
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-500/10 text-blue-500',
    purple: 'bg-purple-500/10 text-purple-500',
    green: 'bg-green-500/10 text-green-500',
    orange: 'bg-orange-500/10 text-orange-500',
    yellow: 'bg-yellow-500/10 text-yellow-500',
    pink: 'bg-pink-500/10 text-pink-500',
    cyan: 'bg-cyan-500/10 text-cyan-500',
  };

  return (
    <div className="space-y-4">
      {/* Project context header (when filtered) */}
      {projectCwd && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <Activity className="h-4 w-4 text-primary" />
          <span className="text-xs text-muted-foreground">
            Showing stats for project:{' '}
            <span className="font-medium text-foreground">
              {projects.find((p) => p.cwd === projectCwd)?.name || projectCwd}
            </span>
          </span>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          const isClickable = !!stat.tab && !!onNavigate;
          const colorClass = colorClasses[stat.color || 'blue'];

          return (
            <button
              key={stat.id}
              onClick={() => stat.tab && onNavigate?.(stat.tab)}
              disabled={!isClickable}
              className={`flex items-center gap-2 rounded-lg border border-border bg-card p-2 text-left transition-colors ${
                isClickable ? 'cursor-pointer hover:border-primary hover:bg-primary/5' : 'cursor-default'
              }`}
            >
              <div className={`flex h-7 w-7 items-center justify-center rounded ${colorClass}`}>
                <Icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                {stat.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <p className="text-base font-bold leading-none">{stat.count}</p>
                )}
                <p className="text-[10px] text-muted-foreground">{stat.label}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Empty state hint */}
      {!projectCwd && projects.length === 0 && !projectsLoading && (
        <p className="text-center text-xs text-muted-foreground">
          No Claude Code data found. Run Claude Code in a project to see stats here.
        </p>
      )}
    </div>
  );
}

export default SummaryDashboard;
