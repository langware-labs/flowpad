/**
 * Layout enum for view layouts
 * Determines which layout system to use for rendering views
 */
export enum Layout {
  DOCK = 'dock',
  DEV = 'dev',
  WIN = 'win',
}

/**
 * PageId — which SPA-surface ("page") a dock URL addresses. Sits between the
 * layout keyword and the viewType: `/<layout>/<page>/<viewType>/<pointer>`.
 * `desk` is today's desktop app and the default; it is NEVER emitted into a URL
 * (bare `/dock/<viewType>` == page `desk`), so existing URLs are unchanged.
 *
 * INVARIANT: no `ViewType` value may ever equal a `PageId` value. Parsing detects
 * the page positionally ("is the post-layout segment a known page id?"), so a
 * collision would silently reinterpret a viewType segment as a page. (`desktop`
 * is a ViewType but `desk` ≠ `desktop`; there is intentionally no `hub` viewType.)
 */
export enum PageId {
  DESK = 'desk',
  HUB = 'hub',
}

/** Type-guard: is `value` a known page id? Data-driven like `isValidView` /
 *  `isValidViewSlot`, so it tracks the enum automatically as pages are added. */
export function isValidPage(value: string | undefined | null): value is PageId {
  return value != null && Object.values(PageId).includes(value as PageId);
}

/**
 * Dev layout keyword - appears in URL as /dev/...
 * Not flexible by design for security, validation, and clarity
 */
export const DEV_KEYWORD = 'dev' as const;

/**
 * Focus-window layout keyword - appears in URL as /win/...
 * Mirrors every dock/<viewType>/<pointer> with a chrome-less window variant
 * (docs/tab-management.md Part 3 §7). Same loaders, same view component;
 * the tab content is the entire window.
 */
export const WIN_KEYWORD = 'win' as const;

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
  // Retired decode-only aliases; the loader redirects to /dock/credentials/<subview>
  // and `normalizeRetiredDockPointer` resolves saved tabs. See CREDENTIALS.
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
  API_KEYS = 'api-keys', // Retired decode-only alias; see ENVIRONMENT
  HOOKS = 'hooks', // Claude Code hooks configuration
  MACHINE = 'machine', // Machine overview (processes, network)
  EXPLORER = 'explorer', // File explorer view
  SKILLS = 'skills', // Claude Code skills editor
  AI_CONFIG = 'ai-config', // AI Configuration (LLM APIs, CLIs)
  SHOW = 'show', // MCP UI display dock pointer
  APPS = 'apps', // Skill UI apps - /dock/apps/<uname>/<router> mounts AppHost
  GRAPH = 'graph', // Built-in dep-graph viewer - /dock/graph/<type>/<id>
  WORLDVIEW = 'worldview', // Shared projections - /dock[/hub]/worldview/<world|organization|deployment>
  TAG = 'tag', // Tag taxonomy graph/tree - /dock/tag/graph[/<dot.name>]?view=tree
  SUBGRAPH = 'subgraph', // Generic entity-subgraph - /dock/subgraph/<projection>[/<focusKey>]
  K_BROWSER = 'k-browser', // Docs knowledge browser - /dock/k-browser/<vfs|typeid>/<value>
  LENS = 'lens', // Lens viewer for specialized content (e.g., transcripts)
  SESSION = 'session', // Live session view (simplified workflow without file)
  TASKS = 'tasks', // Task create/edit view
  SETTINGS = 'settings', // Claude Code settings viewer
  PREFERENCES = 'preferences', // User preferences screen (registry-driven, category tabs)
  AGENTIC_PROCESS = 'agentic_process', // Process terminal view (Layer 3)
  SEARCH = 'search', // Record semantic search view
  TRIGGERS = 'triggers', // Activation rules browser + editor
  CAPABILITIES = 'capabilities', // System capability checks/install/test
  GRAPH_WORKFLOWS = 'graph-workflows', // Flow-graph editor/observatory (GraphWorkflowManager) — dev mode
  PLAN = 'plan', // Plan viewer with Milkdown editor
  CRON = 'cron', // Scheduled cron jobs manager
  ASSETS = 'assets', // Assets - unified docs/skills/workflows tree
  PROJECT = 'project', // Collaboration on a project — meet, share tabs/docs/plans
  INBOX = 'inbox', // Inbox — received FlowMessages from hub
  CONVERSATION = 'conversation', // Single Conversation viewer (avatar bubbles + composer)
  SPEC = 'spec', // Single Spec viewer (shows spec metadata, plan link, generated tasks)
  GRAPH_CONTEXT = 'graph_context', // Frozen-context viewer - /dock/graph_context/<id>
  DIAGNOSIS = 'diagnosis', // Single FlowpadDiagnosis viewer - /dock/diagnosis/<id>
  DESKTOP = 'desktop', // Full-page favorites desktop (BrowseableGrid) - /dock/desktop
  LIVE_SESSION = 'live_session', // Live remote-worker session (terminal chat) - /dock/live_session/<id>
  ATLAS = 'atlas', // Retired decode-only alias; loader redirects to /dock/hub/worldview/…
  HUB_RECORDS = 'records', // Hub entity list by type (page=hub) - /dock/hub/records/<type>
  HUB_ENTITY = 'entity', // Hub single-entity viewer (page=hub) - /dock/hub/entity/<type>/<id>
  CREDENTIALS = 'credentials', // Env vars + OAuth connections + API keys - /dock/hub/credentials/<subview>[/<projectId>]
}

/**
 * CredentialsSubview enum for the credentials view's internal tabs.
 * Used as pointer in dock/credentials/:pointer URLs, optionally followed by a
 * project id: `credentials/environment/<projectId>`.
 */
export enum CredentialsSubview {
  ENVIRONMENT = 'environment',
  CONNECTIONS = 'connections',
  API_KEYS = 'api-keys',
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
  SECRETS = 'secrets', // Which project secrets this node may see. NOT E2B-gated
                       // — the local desktop node needs it just as much.
}

/**
 * AIConfigSubview enum for AI configuration sub-navigation
 * Used as pointer in dock/ai-config/:pointer URLs
 */
export enum AIConfigSubview {
  LLM_APIS = 'llm-apis',
  CLIS = 'clis',
}
