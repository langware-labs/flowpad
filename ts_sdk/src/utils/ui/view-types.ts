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
  // People-and-teams admin: the plain master-detail screen (tree + member table).
  // The org WORLDVIEW is the same data as a graph and stays the advanced view —
  // this is the one a school administrator opens to add a class or change a role.
  ORGANIZATION = 'organization', // /dock/hub/organization[/<type>/<id>]
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
  // The merged rules+events screen. TRIGGERS / SIGNALS / CRON are kept as
  // ALIASES onto it (same body, same navigator) rather than redirects, so every
  // bookmarked URL keeps working — the pattern CRON already used for TRIGGERS.
  EVENTS = 'events', // Rules and the events they fire on - /dock/events[?rule=<id>]
  TRIGGERS = 'triggers', // Alias of EVENTS (was: activation rules browser + editor)
  CAPABILITIES = 'capabilities', // System capability checks/install/test
  GRAPH_WORKFLOWS = 'graph-workflows', // Flow-graph editor/observatory (GraphWorkflowManager) — dev mode
  SIGNALS = 'signals', // Alias of EVENTS (was: global event-bus monitor + injector)
  DATA_SOURCES = 'data-sources', // Configured ingestion sources — /dock/data-sources
  RAG = 'rag', // Search indexes and the folders they cover — /dock/rag
  PROCESS_RUNS = 'process-runs', // AgenticProcess execution history — /dock/process-runs[/<processId>]
  PLAN = 'plan', // Plan viewer with Milkdown editor
  CRON = 'cron', // Scheduled cron jobs manager
  ASSETS = 'assets', // Assets - unified docs/skills/workflows tree
  PROJECT = 'project', // Collaboration on a project — meet, share tabs/docs/plans
  AGENT = 'agent', // Agent-owned surfaces — /dock/agent/<agent-id>/inbox
  INBOX = 'inbox', // Inbox — received FlowMessages from hub
  CONVERSATION = 'conversation', // Single Conversation viewer (avatar bubbles + composer)
  SPEC = 'spec', // Single Spec viewer (shows spec metadata, plan link, generated tasks)
  GRAPH_CONTEXT = 'graph_context', // Frozen-context viewer - /dock/graph_context/<id>
  DIAGNOSIS = 'diagnosis', // Single FlowpadDiagnosis viewer - /dock/diagnosis/<id>
  DESKTOP = 'desktop', // Full-page favorites desktop (BrowseableGrid) - /dock/desktop
  LIVE_SESSION = 'live_session', // Live remote-worker session (terminal chat) - /dock/live_session/<id>
  HELPDESK = 'helpdesk', // Helpdesk portal — guides + ask + my tickets - /dock/helpdesk/<projectId>[/article/<path>]
  ATLAS = 'atlas', // Retired decode-only alias; loader redirects to /dock/hub/worldview/…
  HUB_RECORDS = 'records', // Hub entity list by type (page=hub) - /dock/hub/records/<type>
  HUB_ENTITY = 'entity', // Hub single-entity viewer (page=hub) - /dock/hub/entity/<type>/<id>
  CREDENTIALS = 'credentials', // Env vars + OAuth connections + API keys - /dock/hub/credentials/<subview>[/<projectId>]
  // An Artifact-backed web app - /dock/app/artifact-<uuid>[?runtime=dev|served].
  // The artifact IS the address; which runtime serves it (a dev server's port, or
  // built output we host) is derived, never baked into the pointer, so a stale port
  // can never become the identity of an app. Mirrors `ViewType.APP` in
  // flow_sdk/core/dock_address.py — same value, same position.
  APP = 'app',
  LLM_ENDPOINTS = 'llm-endpoints', // Hub LLM endpoints (roots + chains) - /dock/hub/llm-endpoints[/<id>[/overview|usage|models]]
  TOKEN_PLAN = 'token-plan', // Hub token plan (me / team / org budgets) - /dock/hub/token-plan[/me|team[/<id>]|org]
  // DESK page: what funds this machine's harnesses (device logins, stored keys, hub endpoints)
  LLM_SOURCES = 'llm-sources', // /dock/llm-sources[/<worker>] -- the harness in focus
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
/**
 * TokenPlanKind enum for the hub token-plan scopes.
 * Used as the leading pointer segment in dock/hub/token-plan/:pointer URLs,
 * optionally followed by a team id: `token-plan/team/<teamId>`.
 * Mirrors `TokenPlanKind` in flow_sdk/core/dock_address.py.
 */
export enum TokenPlanKind {
  ME = 'me',
  TEAM = 'team',
  ORG = 'org',
}

export enum MachineSubview {
  PROCESSES = 'processes',
  NETWORK = 'network',
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
