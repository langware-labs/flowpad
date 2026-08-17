/**
 * System profile types for Claude Code environment information.
 * These types mirror the Python Pydantic models in flowpad/hub/types/system_profile.py
 */

import { ActionInfo } from '../../models/ActionInfo';
import { IResource } from '../../IResource';
import type { ClaudeSessionRecordData } from '../../resource_management/fs_records/claude/claude-session';
import { dataManager } from '../../APIEntity';

// ═══════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════

/**
 * Scope/location of a configuration item.
 */
export enum Scope {
  MANAGED = 'managed', // /Library/Application Support/ClaudeCode/
  USER = 'user', // ~/.claude/
  GLOBAL = 'global', // ~/.claude/ (alias for user)
  PROJECT = 'project', // .claude/
  LOCAL = 'local', // .claude/*.local.*
  LEGACY = 'legacy', // ~/.claude.json
  PLUGIN = 'plugin', // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
}

/**
 * Type of system profile item (similar to entity.type).
 */
export enum ItemType {
  PLUGIN = 'plugin',
  MARKETPLACE = 'marketplace',
  HOOK = 'hook',
  MCP_SERVER = 'mcp_server',
  AGENT = 'agent',
  COMMAND = 'command',
  CLAUDE_MD = 'claude_md',
  PROJECT = 'project',
  SESSION = 'session',
  PLAN = 'plan',
  DIRECTORY = 'directory',
  GITHUB_REPO = 'github_repo',
  SKILL = 'skill',
  TODO_FILE = 'todo_file',
}

// ═══════════════════════════════════════════════════════════════
// BASE INTERFACE - Extends IResource
// ═══════════════════════════════════════════════════════════════

/**
 * Base interface for all system profile items.
 * Extends IResource with SystemProfileItem-specific fields.
 */
export interface SystemProfileItem extends IResource {
  /** Scope: user/project/local/managed/etc */
  scope: string;
  /** Source file path */
  source_file?: string | null;
  /** Full path to item */
  path?: string | null;
  /** Links to Entity.id if resource is promoted to entity */
  entity_id?: string | null;
}

// ═══════════════════════════════════════════════════════════════
// DERIVED INTERFACES - All extend SystemProfileItem
// ═══════════════════════════════════════════════════════════════

/**
 * Plugin - inherits IResource fields plus plugin-specific fields.
 */
export interface PluginItem extends SystemProfileItem {
  type: ItemType.PLUGIN | string;
  version: string;
  marketplace?: string | null;
  enabled: boolean;
  plugin_key?: string | null;
}

/**
 * Marketplace - inherits IResource fields plus marketplace-specific fields.
 */
export interface MarketplaceItem extends SystemProfileItem {
  type: ItemType.MARKETPLACE | string;
  source: string;
  repo?: string | null;
  install_location?: string | null;
}

/**
 * Hook - inherits IResource fields plus hook-specific fields.
 */
export interface HookItem extends SystemProfileItem {
  type: ItemType.HOOK | string;
  event_type: string;
  matcher: string;
  command: string;
  hook_type: string;
  plugin_name?: string | null;
  /** flow_metadata.name from settings.json (present = FlowPad-managed hook) */
  flow_metadata_name?: string | null;
  /** flow_metadata.flowpad_hook_id from settings.json */
  flowpad_hook_id?: string | null;
}

/**
 * MCP Server - inherits IResource fields plus MCP-specific fields.
 */
export interface McpServerItem extends SystemProfileItem {
  type: ItemType.MCP_SERVER | string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Custom agent/subagent - inherits IResource fields.
 */
export interface AgentItem extends SystemProfileItem {
  type: ItemType.AGENT | string;
}

/**
 * Custom slash command - inherits IResource fields.
 */
export interface CommandItem extends SystemProfileItem {
  type: ItemType.COMMAND | string;
}

/**
 * CLAUDE.md instruction file - inherits IResource fields.
 */
export interface ClaudeMdItem extends SystemProfileItem {
  type: ItemType.CLAUDE_MD | string;
  size: number;
}

/**
 * Project - inherits IResource fields plus project-specific fields.
 */
export interface ProjectItem extends SystemProfileItem {
  type: ItemType.PROJECT | string;
  /**
   * Claude project directory name observed at ~/.claude/projects/<name>/.
   * Scanner-emitted transient — used as the API key when scanning Claude's
   * project-scoped resources. NOT stored on any Flow record.
   */
  encoded_name: string;
  cwd: string;
  session_count: number;
  total_messages: number;
}

/**
 * @deprecated Use ClaudeSessionRecordData from claude-session.ts instead.
 * SessionItem has been removed; the scan endpoint now returns ClaudeSessionRecordData.
 */
export type SessionItem = ClaudeSessionRecordData;

/**
 * Session analysis - analysis results for a session transcript.
 */

/**
 * Saved plan - inherits IResource fields plus plan-specific fields.
 * Plans are correlated to sessions via the slug field.
 */
export interface PlanItem extends SystemProfileItem {
  type: ItemType.PLAN | string;
  size: number;
  size_formatted: string;
  /** Plan slug (matches filename without extension) */
  slug: string;
  /** Session IDs that used this plan */
  session_ids: string[];
  /** Number of sessions using this plan */
  session_count: number;
}

/**
 * Directory info - inherits IResource fields plus directory-specific fields.
 */
export interface DirectoryItem extends SystemProfileItem {
  type: ItemType.DIRECTORY | string;
  count?: number | null;
  description: string;
  exists: boolean;
}

/**
 * GitHub repo mapping - inherits IResource fields plus repo-specific fields.
 */
export interface GitHubRepoItem extends SystemProfileItem {
  type: ItemType.GITHUB_REPO | string;
  paths: string[];
}

/**
 * Skill - inherits IResource fields plus skill-specific fields.
 */
export interface SkillItem extends SystemProfileItem {
  type: ItemType.SKILL | string;
  usage_count: number;
  favorite_index?: number | null;
}

/**
 * Individual todo item within a todo file.
 */
export interface TodoEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/**
 * Todo file - contains todo entries from a session.
 * Filename pattern: {session-id}-agent-{agent-id}.json
 */
export interface TodoFileItem extends SystemProfileItem {
  type: ItemType.TODO_FILE | string;
  /** Session ID this todo file belongs to */
  session_id: string;
  /** SubAgent ID (same as session_id for main agent, different for sub-agents) */
  agent_id: string;
  /** Whether this is a sub-agent todo file */
  is_sub_agent: boolean;
  /** Number of todo entries in the file */
  entry_count: number;
  /** Number of completed entries */
  completed_count: number;
  /** Number of pending entries */
  pending_count: number;
  /** Number of in-progress entries */
  in_progress_count: number;
  /** The actual todo entries (may be empty for summary view) */
  entries: TodoEntry[];
}

// ═══════════════════════════════════════════════════════════════
// NON-ITEM INTERFACES
// ═══════════════════════════════════════════════════════════════

/**
 * Aggregated transcript statistics across all sessions.
 */
export interface TranscriptStats {
  /** Number of sessions analyzed */
  sessions_analyzed: number;
  /** Total JSONL entries */
  total_entries: number;
  /** Total size of transcript files in bytes */
  total_size_bytes: number;

  /** Token usage */
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;

  /** Cost estimation */
  total_estimated_cost_usd: number;
  cost_breakdown: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  savings_from_cache_usd: number;

  /** Model usage: model name -> response count */
  models_used: Record<string, number>;
  primary_model?: string | null;

  /** Tool usage: tool name -> usage count */
  tools_used: Record<string, number>;
  total_tool_uses: number;

  /** Entry type breakdown */
  entry_types: Record<string, number>;

  /** Content type breakdown */
  content_types: Record<string, number>;

  /** Service tier tracking */
  service_tiers: Record<string, number>;

  /** Date range */
  oldest_session_date?: string | null;
  newest_session_date?: string | null;
}

// ═══════════════════════════════════════════════════════════════
// COST OVERVIEW INTERFACES
// ═══════════════════════════════════════════════════════════════

/**
 * Cost breakdown for a single session.
 */
export interface SessionCostBreakdown {
  session_id: string;
  cwd?: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  model?: string | null;
  modified_at?: string | null;
}

/**
 * Aggregated cost data for a time window (hourly, daily, weekly, monthly).
 */
export interface CostTimeWindow {
  // Identity
  window_key: string;
  window_type: 'hourly' | 'daily' | 'weekly' | 'monthly';
  window_start: string;
  window_end: string;

  // Token Totals
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;

  // Cost Totals (USD)
  input_cost_usd: number;
  output_cost_usd: number;
  cache_write_cost_usd: number;
  cache_read_cost_usd: number;
  total_cost_usd: number;

  // Cache Efficiency
  cache_hit_rate: number;
  cache_savings_usd: number;
  cache_investment_usd: number;
  net_cache_roi_usd: number;

  // Activity Metrics
  session_count: number;
  message_count: number;
  tool_use_count: number;
  avg_cost_per_session: number;
  avg_tokens_per_session: number;

  // Breakdowns
  cost_by_model: Record<string, number>;
  tokens_by_model: Record<string, number>;
  sessions_by_model: Record<string, number>;
  cost_by_project: Record<string, number>;
  sessions_by_project: Record<string, number>;
}

/**
 * Cost summary for a specific model.
 */
export interface CostByModel {
  model: string;
  session_count: number;
  message_count: number;
  tool_use_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  cache_savings_usd: number;
  avg_cost_per_session: number;
}

/**
 * Cost summary for a specific project.
 */
export interface CostByProject {
  cwd: string;
  session_count: number;
  message_count: number;
  tool_use_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  cache_savings_usd: number;
  avg_cost_per_session: number;
  models_used: Record<string, number>;
  first_session_date?: string | null;
  last_session_date?: string | null;
}

/**
 * Complete cost overview with all aggregations.
 * Returned by the costOverview scanner.
 */
export interface CostOverview {
  generated_at: string;
  session_count: number;

  // Overall totals
  totals: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_creation_tokens: number;
    total_tokens: number;
    total_cost_usd: number;
    cache_savings_usd: number;
    cache_investment_usd: number;
    net_cache_roi_usd: number;
  };

  // Time-based aggregations (keyed by window_key)
  by_day: Record<string, CostTimeWindow>;
  by_week: Record<string, CostTimeWindow>;
  by_month: Record<string, CostTimeWindow>;

  // Model and project aggregations
  by_model: Record<string, CostByModel>;
  by_project: Record<string, CostByProject>;

  // Top expensive sessions
  top_sessions_by_cost: SessionCostBreakdown[];
}

/**
 * Aggregated counts - not an item.
 */
export interface SystemProfileSummary {
  totalProjects: number;
  totalSessions: number;
  totalPrompts: number;
  installedPlugins: number;
  marketplaces: number;
  mcpServers: number;
  customAgents: number;
  hooksConfigured: number;
  claudeMdFiles: number;
  githubRepos: number;
  todoFiles: number;
  startups: number;
  currentDirectory: string;
}

/**
 * Account info - not an item (singleton).
 */
export interface AccountInfo {
  loggedIn: boolean;
  email: string;
  displayName: string;
  organization: string;
  role: string;
  subscription: string;
  source: string;
}

// ═══════════════════════════════════════════════════════════════
// MAIN INTERFACE
// ═══════════════════════════════════════════════════════════════

/**
 * Main response model with all items inheriting from SystemProfileItem.
 *
 * Key features:
 * - All items implement IResource interface (id, type, name, created_at, modified_at, created_by, updated_by)
 * - All items have scope for location tracking
 * - All items have optional entity_id for linking to promoted entities
 * - recentItems: Pre-computed list of latest N items by modified_at
 */
export interface SystemProfile {
  /** Generation timestamp (ISO string) */
  generated: string;
  /** Machine hostname */
  machine: string;

  /** Summary and account (non-items) */
  summary: SystemProfileSummary;
  account: AccountInfo;

  /** All items extend SystemProfileItem */
  directories: DirectoryItem[];
  plugins: PluginItem[];
  marketplaces: MarketplaceItem[];
  hooks: HookItem[];
  mcpServers: McpServerItem[];
  agents: AgentItem[];
  commands: CommandItem[];
  claudeMdFiles: ClaudeMdItem[];
  plans: PlanItem[];
  projects: ProjectItem[];
  sessions: ClaudeSessionRecordData[];
  githubRepos: GitHubRepoItem[];
  skills: SkillItem[];
  todos: TodoFileItem[];

  /** Pre-computed latest N items by modified_at */
  recentItems: SystemProfileItem[];

  ideConnections: number;

  /** Transcript analysis (aggregated stats across all sessions) */
  transcriptStats: TranscriptStats;

  /** Cost overview with aggregations by time, model, and project */
  costOverview?: CostOverview;
}

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Utility functions for working with SystemProfile data.
 */
export const SystemProfileUtils = {
  /**
   * Get all items as flat array.
   */
  getAllItems(profile: SystemProfile): SystemProfileItem[] {
    return [
      ...profile.directories,
      ...profile.plugins,
      ...profile.marketplaces,
      ...profile.hooks,
      ...profile.mcpServers,
      ...profile.agents,
      ...profile.commands,
      ...profile.claudeMdFiles,
      ...profile.plans,
      ...profile.projects,
      ...profile.sessions,
      ...profile.githubRepos,
      ...profile.skills,
      ...profile.todos,
    ];
  },

  /**
   * Get latest N items sorted by modified_at.
   */
  getLatestItems(profile: SystemProfile, n: number = 10): SystemProfileItem[] {
    const items = this.getAllItems(profile);
    return items
      .filter((i) => i.modified_at)
      .sort((a, b) => new Date(b.modified_at!).getTime() - new Date(a.modified_at!).getTime())
      .slice(0, n);
  },

  /**
   * Find item by id for correlation with entity.id.
   */
  findById(profile: SystemProfile, resourceId: string): SystemProfileItem | undefined {
    return this.getAllItems(profile).find((i) => i.id === resourceId);
  },

  /**
   * Get items by scope.
   */
  getItemsByScope(profile: SystemProfile, scope: Scope | string): SystemProfileItem[] {
    return this.getAllItems(profile).filter((i) => i.scope === scope);
  },

  /**
   * Get items by type.
   */
  getItemsByType(profile: SystemProfile, itemType: ItemType | string): SystemProfileItem[] {
    return this.getAllItems(profile).filter((i) => i.type === itemType);
  },

  /**
   * Get the list key for an item type.
   */
  getListKeyForType(itemType: ItemType | string): keyof SystemProfile | null {
    const mapping: Record<string, keyof SystemProfile> = {
      [ItemType.PLUGIN]: 'plugins',
      [ItemType.MARKETPLACE]: 'marketplaces',
      [ItemType.HOOK]: 'hooks',
      [ItemType.MCP_SERVER]: 'mcpServers',
      [ItemType.AGENT]: 'agents',
      [ItemType.COMMAND]: 'commands',
      [ItemType.CLAUDE_MD]: 'claudeMdFiles',
      [ItemType.PROJECT]: 'projects',
      [ItemType.SESSION]: 'sessions',
      [ItemType.PLAN]: 'plans',
      [ItemType.DIRECTORY]: 'directories',
      [ItemType.GITHUB_REPO]: 'githubRepos',
      [ItemType.SKILL]: 'skills',
      [ItemType.TODO_FILE]: 'todos',
    };
    return mapping[itemType] || null;
  },

  /**
   * Update a single item in the profile (after targeted refresh).
   * Returns a new profile object with the updated item.
   */
  updateItem(profile: SystemProfile, item: SystemProfileItem): SystemProfile {
    const listKey = this.getListKeyForType(item.type);
    if (!listKey) return profile;

    // Create a shallow copy
    const newProfile = { ...profile };

    // Get the list and update
    const list = [...(profile[listKey] as SystemProfileItem[])];
    const index = list.findIndex((i) => i.id === item.id);
    if (index >= 0) {
      list[index] = item;
    } else {
      list.push(item);
    }

    // Update the list in the new profile
    (newProfile as Record<string, unknown>)[listKey] = list;

    // Recompute recentItems
    newProfile.recentItems = this.getLatestItems(newProfile, 10);
    return newProfile;
  },

  /**
   * Create an empty system profile.
   */
  createEmpty(): SystemProfile {
    return {
      generated: new Date().toISOString(),
      machine: 'unknown',
      summary: {
        totalProjects: 0,
        totalSessions: 0,
        totalPrompts: 0,
        installedPlugins: 0,
        marketplaces: 0,
        mcpServers: 0,
        customAgents: 0,
        hooksConfigured: 0,
        claudeMdFiles: 0,
        githubRepos: 0,
        todoFiles: 0,
        startups: 0,
        currentDirectory: '',
      },
      account: {
        loggedIn: false,
        email: '',
        displayName: '',
        organization: '',
        role: '',
        subscription: '',
        source: '~/.claude.json',
      },
      directories: [],
      plugins: [],
      marketplaces: [],
      hooks: [],
      mcpServers: [],
      agents: [],
      commands: [],
      claudeMdFiles: [],
      plans: [],
      projects: [],
      sessions: [],
      githubRepos: [],
      skills: [],
      todos: [],
      recentItems: [],
      ideConnections: 0,
      transcriptStats: {
        sessions_analyzed: 0,
        total_entries: 0,
        total_size_bytes: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        total_estimated_cost_usd: 0,
        cost_breakdown: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        savings_from_cache_usd: 0,
        models_used: {},
        primary_model: null,
        tools_used: {},
        total_tool_uses: 0,
        entry_types: {},
        content_types: {},
        service_tiers: {},
        oldest_session_date: null,
        newest_session_date: null,
      },
      costOverview: {
        generated_at: new Date().toISOString(),
        session_count: 0,
        totals: {
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cache_read_tokens: 0,
          total_cache_creation_tokens: 0,
          total_tokens: 0,
          total_cost_usd: 0,
          cache_savings_usd: 0,
          cache_investment_usd: 0,
          net_cache_roi_usd: 0,
        },
        by_day: {},
        by_week: {},
        by_month: {},
        by_model: {},
        by_project: {},
        top_sessions_by_cost: [],
      },
    };
  },
};

// ═══════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch full system profile directly from a compute node (no flow required).
 */
export async function fetchSystemProfileFromComputeNode(computeNodeId: string): Promise<SystemProfile> {
  const actionInfo = new ActionInfo('get-system-profile', 'compute_node', computeNodeId, 'GET');
  return (
    (await dataManager.callAction<undefined, SystemProfile>(actionInfo)) ||
    SystemProfileUtils.createEmpty()
  );
}


/**
 * Open a file or directory in the system's default application via compute node.
 *
 * Pass `{select: true}` to reveal a file in the OS file manager (Finder/Explorer)
 * with the file selected, instead of opening it in its default app. Folders ignore
 * the flag. Linux falls back to opening the parent directory.
 */
export async function openExternalFromComputeNode(
  computeNodeId: string,
  path: string,
  options?: { select?: boolean },
): Promise<{ opened: string; selected?: boolean } | null> {
  const actionInfo = new ActionInfo('open-external', 'compute_node', computeNodeId, 'POST');
  const body: Record<string, unknown> = { path };
  if (options?.select) body.select = true;
  actionInfo.bodyParameters = body;
  return dataManager.callAction<Record<string, unknown>, { opened: string; selected?: boolean } | null>(
    actionInfo,
  );
}

/**
 * Open an OS terminal and run a command via compute node.
 * Used for resuming Claude Code sessions from the UI.
 */
export async function openTerminalFromComputeNode(
  computeNodeId: string,
  command: string,
  cwd?: string,
): Promise<{ command: string; cwd: string | null } | null> {
  const actionInfo = new ActionInfo('open-terminal', 'compute_node', computeNodeId, 'POST');
  actionInfo.bodyParameters = { command, cwd };
  return dataManager.callAction<
    { command: string; cwd?: string },
    { command: string; cwd: string | null } | null
  >(actionInfo);
}

// ═══════════════════════════════════════════════════════════════
// PER-PROJECT LAZY SCANNING API
// ═══════════════════════════════════════════════════════════════

/**
 * Project summary returned by list-projects API.
 */
export interface ProjectListItem {
  /** Real Project entity id. Use this for ScopeFilter.projects and project routes. */
  id: string;
  /** Legacy fs-record project_id value, derived from uuid5(project:<cwd>). */
  record_project_id?: string;
  name: string;
  /**
   * Claude project directory name observed at ~/.claude/projects/<name>/.
   * Scanner-emitted transient — used as the API key when scanning Claude's
   * project-scoped resources. NOT stored on any Flow record.
   */
  encoded_name: string;
  cwd: string | null;
  session_count: number;
  claude_session_count?: number;
  codex_session_count?: number;
  copilot_session_count?: number;
  modified_at: string | null;
  /**
   * Epoch-ms of the last time the user OPENED this project (or one of its
   * assets) in the UI — the Project entity's `last_active_at`, stamped by the
   * generic `activate` action. Wins the recency sort; `modified_at`
   * (session-file mtimes) is the fallback.
   */
  last_active_at?: number | null;
  claude?: boolean;
  codex?: boolean;
  copilot?: boolean;
  worker_types?: string[];
  /** True when this project entry represents an SDK-shipped system project. */
  system?: boolean;
}

/**
 * Response from list-projects API.
 */
export interface ListProjectsResponse {
  projects: ProjectListItem[];
  total_count: number;
  claude_count?: number;
  codex_count?: number;
  copilot_count?: number;
  both_count?: number;
  none_count?: number;
}

/**
 * Response from scan-project API.
 */
export interface ScanProjectResponse {
  project_cwd: string | null;
  scanned_at: string;
  sessions: ClaudeSessionRecordData[];
  total_session_count: number;
  hooks: HookItem[];
  mcp_servers: McpServerItem[];
  commands: CommandItem[];
  agents: AgentItem[];
  skills: SkillItem[];
  claude_md: ClaudeMdItem[];
  todos: TodoFileItem[];
  summary: {
    sessions: number;
    hooks: number;
    mcp_servers: number;
    commands: number;
    agents: number;
    skills: number;
    claude_md: number;
    todos: number;
  };
}

/**
 * Indexer-backed project enumeration.
 * Use this for the project list sidebar.
 */
export async function listProjectsFromComputeNode(
  computeNodeId: string,
  signal?: AbortSignal,
): Promise<ListProjectsResponse> {
  const actionInfo = new ActionInfo('list-projects', 'compute_node', computeNodeId, 'GET');
  actionInfo.abortSignal = signal ?? null;
  return (
    (await dataManager.callAction<undefined, ListProjectsResponse>(actionInfo)) || {
      projects: [],
      total_count: 0,
    }
  );
}

/**
 * Fetch cost overview from compute node.
 * Returns comprehensive cost data aggregated by time windows, model, and project.
 */
export async function fetchCostOverviewFromComputeNode(
  computeNodeId: string,
  sessionLimit: number = 100,
): Promise<CostOverview> {
  const actionInfo = new ActionInfo('get-cost-overview', 'compute_node', computeNodeId, 'GET');
  actionInfo.queryParameters = { limit: sessionLimit };
  return (
    (await dataManager.callAction<undefined, CostOverview>(actionInfo)) || {
      generated_at: new Date().toISOString(),
      session_count: 0,
      totals: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        cache_savings_usd: 0,
        cache_investment_usd: 0,
        net_cache_roi_usd: 0,
      },
      by_day: {},
      by_week: {},
      by_month: {},
      by_model: {},
      by_project: {},
      top_sessions_by_cost: [],
    }
  );
}

/**
 * Scan all resources for a specific project (~100ms).
 * Use this when a project is selected.
 */
export async function scanProjectFromComputeNode(
  computeNodeId: string,
  projectEncodedName: string,
  limit: number = 100,
  includeSessions: boolean = true,
  signal?: AbortSignal,
): Promise<ScanProjectResponse> {
  const actionInfo = new ActionInfo('scan-project', 'compute_node', computeNodeId, 'GET');
  actionInfo.queryParameters = {
    project: projectEncodedName,
    limit,
    include_sessions: includeSessions,
  };
  actionInfo.abortSignal = signal ?? null;
  return (
    (await dataManager.callAction<undefined, ScanProjectResponse>(actionInfo)) || {
      project_cwd: null,
      scanned_at: new Date().toISOString(),
      sessions: [],
      total_session_count: 0,
      hooks: [],
      mcp_servers: [],
      commands: [],
      agents: [],
      skills: [],
      claude_md: [],
      todos: [],
      summary: {
        sessions: 0,
        hooks: 0,
        mcp_servers: 0,
        commands: 0,
        agents: 0,
        skills: 0,
        claude_md: 0,
        todos: 0,
      },
    }
  );
}

/**
 * Fetch all skills across user-level and all projects.
 * Uses the scan-item?type=skills endpoint which calls get_skills().
 */
export async function fetchAllSkillsFromComputeNode(computeNodeId: string): Promise<SkillItem[]> {
  const actionInfo = new ActionInfo('scan-item', 'compute_node', computeNodeId, 'GET');
  actionInfo.queryParameters = { type: 'skills' };
  return (await dataManager.callAction<undefined, SkillItem[]>(actionInfo)) || [];
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE USAGE / RATE-LIMIT INTERFACES
// ═══════════════════════════════════════════════════════════════
// CLAUDE CONTEXT WINDOW DATA  (/context command)
// ═══════════════════════════════════════════════════════════════

export interface ClaudeContextCategory {
  category: string;
  tokens: string;
  tokens_int: number;
  percentage: string;
  percentage_float: number;
}

export interface ClaudeContextMcpTool {
  tool: string;
  server: string;
  tokens: string;
  tokens_int: number;
}

export interface ClaudeContextAgent {
  agent_type: string;
  source: string;
  tokens: string;
  tokens_int: number;
}

export interface ClaudeContextMemoryFile {
  type: string;
  path: string;
  tokens: string;
  tokens_int: number;
}

export interface ClaudeContextSkill {
  skill: string;
  source: string;
  tokens: string;
  tokens_int: number;
}

export interface ClaudeContextData {
  model: string;
  tokens_used: number;
  tokens_total: number;
  tokens_free: number;
  tokens_pct: number;
  tokens_used_str: string;
  tokens_total_str: string;
  estimated_usage_by_category: ClaudeContextCategory[];
  mcp_tools: ClaudeContextMcpTool[];
  custom_agents: ClaudeContextAgent[];
  memory_files: ClaudeContextMemoryFile[];
  skills: ClaudeContextSkill[];
  session_id?: string | null;
  session_title?: string | null;
}

/**
 * Fetch full context window breakdown from the local claude /context command.
 * Zero API cost — runs entirely locally. Takes ~4s.
 * Returns null if the claude binary is unavailable or the command fails.
 */
export async function fetchClaudeContextFromComputeNode(
  computeNodeId: string,
  sessionId?: string,
): Promise<ClaudeContextData | null> {
  try {
    const actionInfo = new ActionInfo('get-claude-context', 'compute_node', computeNodeId, 'GET');
    if (sessionId) actionInfo.queryParameters = { session_id: sessionId };
    const d = await dataManager.callAction<undefined, Partial<ClaudeContextData> | null>(
      actionInfo,
    );
    if (!d || !d.model) return null;
    return {
      model: d.model ?? 'unknown',
      tokens_used: d.tokens_used ?? 0,
      tokens_total: d.tokens_total ?? 200000,
      tokens_free: d.tokens_free ?? 0,
      tokens_pct: d.tokens_pct ?? 0,
      tokens_used_str: d.tokens_used_str ?? '0',
      tokens_total_str: d.tokens_total_str ?? '200k',
      estimated_usage_by_category: d.estimated_usage_by_category ?? [],
      mcp_tools: d.mcp_tools ?? [],
      custom_agents: d.custom_agents ?? [],
      memory_files: d.memory_files ?? [],
      skills: d.skills ?? [],
      session_id: d.session_id ?? null,
      session_title: d.session_title ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Clear all skill usage counters from ~/.claude.json.
 */
export async function clearAllSkillUsage(computeNodeId: string): Promise<number> {
  const actionInfo = new ActionInfo('clear-skill-usage', 'compute_node', computeNodeId, 'GET');
  const result = await dataManager.callAction<undefined, { cleared?: number } | null>(actionInfo);
  return result?.cleared ?? 0;
}
