/**
 * Layout enum for view layouts
 * Determines which layout system to use for rendering views
 */
export enum Layout {
  DOCK = 'dock',
  DEV = 'dev',
}

/**
 * Dev layout keyword - appears in URL as /dev/...
 * Not flexible by design for security, validation, and clarity
 */
export const DEV_KEYWORD = 'dev' as const;

/**
 * ViewType enum for content panel views
 * Matches the focus values from backend flow state
 */
export enum ViewType {
  HOME = 'home', // Home/Landing page - simple view with link to system_profile
  SYSTEM_PROFILE = 'system_profile', // System Profile - Claude Code Status (LiveStatus)
  ANALYSIS = 'analysis', // Session analysis overview
  CHAT = 'chat',
  SHELL = 'shell',
  EDITOR = 'editor',
  WEB_APP = 'web-app',
  ENVIRONMENT = 'environment',
  CONNECTIONS = 'connections',
  ARTIFACTS = 'artifacts', // Renamed from RESULTS
  REASONING = 'reasoning',
  DIFF = 'diff',
  UNSUPPORTED = 'unsupported', // fallback viewer
  MARKDOWN = 'markdown',
  DOCS = 'docs',
  ASSISTANCE = 'assistance', // expert assistance tasks
  SURVEY = 'survey',
  API_KEYS = 'api-keys',
  HOOKS = 'hooks', // Claude Code hooks configuration
  MACHINE = 'machine', // Machine overview (processes, network)
  EXPLORER = 'explorer', // File explorer view
  SKILLS = 'skills', // Claude Code skills editor
  AI_CONFIG = 'ai-config', // AI Configuration (LLM APIs, CLIs)
  EXECUTE_FLOW = 'execute-flow', // Execute markdown instruction files
  SHOW = 'show', // MCP UI display dock pointer
  LENS = 'lens', // Lens viewer for specialized content (e.g., transcripts)
  SESSION = 'session', // Live session view (simplified workflow without file)
  TASKS = 'tasks', // Task create/edit view
  SETTINGS = 'settings', // Claude Code settings viewer
  AGENTIC_PROCESS = 'agentic_process', // Process terminal view (Layer 3)
  SEARCH = 'search', // Record semantic search view
  TRIGGERS = 'triggers', // Activation rules browser + editor
  PLAN = 'plan', // Plan viewer with Milkdown editor
  CRON = 'cron', // Scheduled cron jobs manager
  WORKFLOWS = 'workflows', // Workflows manager with markdown editor
  ASSETS = 'assets', // Assets - unified docs/skills/workflows tree
  PROJECT = 'project', // Collaboration on a project — meet, share tabs/docs/plans
}

/**
 * WebappSubview enum for webapp panel sub-navigation
 * Used as pointer in dock/web-app/:pointer URLs
 */
export enum WebappSubview {
  SHELL = 'webapp-shell',
  ARTIFACTS = 'webapp-artifacts',
}

/**
 * MachineSubview enum for machine overview sub-navigation
 * Used as pointer in dock/machine/:pointer URLs
 */
export enum MachineSubview {
  PROCESSES = 'processes',
  NETWORK = 'network',
  GATEWAY = 'gateway',
  METRICS = 'metrics', // E2B only - CPU/Memory charts
  LOGS = 'logs', // E2B only - sandbox logs
}

/**
 * AIConfigSubview enum for AI configuration sub-navigation
 * Used as pointer in dock/ai-config/:pointer URLs
 */
export enum AIConfigSubview {
  LLM_APIS = 'llm-apis',
  CLIS = 'clis',
}
