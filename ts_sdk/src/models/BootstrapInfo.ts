import { Project, User, Visitor, Workspace } from '../entities';
import { ComputeNode } from '../entities/compute_node';
import { AgentHook } from '../entities/agent-hook';
import { WebDomain } from '../entities/web-domain';

/**
 * Environment information returned in bootstrap
 */
export interface EnvInfo {
  /** Current environment name (e.g., "desktop", "local", "development", "production") */
  env_name: string;
  /** FLOWPAD_CLOUD_API_URL if set */
  cloud_api_url?: string;
  /** App version (e.g., "0.1.28") */
  version?: string;
}

/**
 * Application paths - VFS-relative paths ready to use with fsManager.
 * All paths are relative to the storage mount (OS root), without leading slash.
 */
export interface AppPaths {
  /** Filesystem root ("/" on Unix, "C:\\" on Windows) */
  root: string;
  /** User home directory ("Users/shlom") */
  home: string;
  /** FlowPad workspace folder ("Users/shlom/Flowpad workspace") */
  workspace: string;
  /** Skills folder ("Users/shlom/Flowpad workspace/.claude/skills") */
  skills: string;
  /** User skills folder ("Users/shlom/.claude/skills") */
  user_skills: string;
  /** System skills folder ("Users/shlom/Flowpad workspace/.flow/system_assets/skills") */
  system_skills: string;
  /** System agents folder ("Users/shlom/Flowpad workspace/.flow/system_assets/agents") */
  system_agents: string;
  /** Logs folder ("Users/shlom/Flowpad workspace/.flow/logs") */
  logs: string;
  /** Settings file ("Users/shlom/Flowpad workspace/.flow/settings.json") */
  settings: string;
}

/**
 * Desktop/LLM information returned in bootstrap
 */
export interface LmInfo {
  /** Available LLM providers (Anthropic, OpenAI, etc.) */
  llm_providers: string[];
  /** Installed agent applications (Claude Code, Cursor, etc.) */
  installed_agents: string[];
  /** Whether cloud login is available (valid cloud token exists) */
  cloud_login_available: boolean;
  /** Application paths - all absolute, ready to use */
  paths?: AppPaths;
  /** @deprecated Use paths.home instead - Filesystem root (/ on Unix, C:\ on Windows) */
  home?: string;
  /** @deprecated Use paths.workspace instead - User workspace folder (~/Flowpad workspace) */
  workspace?: string;
  /** @deprecated Use paths.skills instead - Skills folder path (~/Flowpad workspace/.claude/skills) */
  skills?: string;
}

export interface ScanInfo {
  total_indexed: number;
  last_indexed_at: string | null;
  never_indexed: boolean;
  stale: boolean;
}

export interface BootstrapInfo {
  schemas?: any[];
  user?: User;
  domain?: WebDomain;
  visitor?: Visitor;
  default_project?: Project;
  default_workspace?: Workspace;
  default_compute_node?: ComputeNode;
  env?: EnvInfo;
  desktop_info?: LmInfo;
  sniffer_hook?: AgentHook;
  scan_info?: ScanInfo;
}
