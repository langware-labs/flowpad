import { DOCK_KEYWORD, ViewType } from '@sdk';

/**
 * Re-export ViewType from SDK for convenience
 */
export { ViewType };

/**
 * Hardcoded dock keyword - appears in URL as /dock/...
 * Not flexible by design for security, validation, and clarity
 */
export { DOCK_KEYWORD };

/**
 * Valid view slots that can appear in URLs
 * Extensible - add new slots here as needed
 */
export const VIEW_SLOTS = {
  TAB: 'tab',
  ACTIVE_VIEW: 'activeView',
} as const;

/**
 * Type alias for view slot values
 */
export type ViewSlot = (typeof VIEW_SLOTS)[keyof typeof VIEW_SLOTS];
/**
 * Type alias for view type string values
 */
export type ViewTypeValue = `${ViewType}`;

/**
 * Viewer metadata registry
 * Single source of truth for all viewer information
 */
export interface ViewerMeta {
  title: string;
  /** Icon component name (string to avoid JSX in shared package) */
  iconName:
    | 'Code'
    | 'Terminal'
    | 'Globe'
    | 'Variable'
    | 'GitCompare'
    | 'ListCheck'
    | 'Activity'
    | 'MessageSquare'
    | 'Monitor'
    | 'FileQuestion'
    | 'FileText'
    | 'Brain'
    | 'Hand'
    | 'Key'
    | 'KeyRound'
    | 'LogIn'
    | 'BookOpen'
    | 'ListChecks'
    | 'Webhook'
    | 'Cpu'
    | 'FolderOpen'
    | 'Sparkles'
    | 'Settings'
    | 'PlaySquare'
    | 'Eye'
    | 'Home'
    | 'Zap'
    | 'CheckSquare'
    | 'BadgeCheck'
    | 'SearchIcon'
    | 'Workflow'
    | 'GitGraph'
    | 'BrainCircuit'
    | 'Users'
    | 'Mail'
    | 'Stethoscope';
  /** Where this viewer renders: 'overview' tab or dedicated tab */
  tabLocation: 'overview' | 'dedicated';
  /** Can this viewer be manually added as a tab? */
  canAddAsTab: boolean;
  /**
   * How the content panel frames this surface: `'fullbleed'` takes over the whole
   * panel (no tab strip) — a landing like Home; `'workspace'` (default when
   * omitted) renders inside the tabbed workspace (strip + body). This is the one
   * "is the strip shown?" bit, separate from `DockPointer.tabHash` ("is this a chip?").
   */
  chrome?: 'fullbleed' | 'workspace';
  /**
   * When true, every sub-pointer of this viewType folds into ONE tab — the
   * pointer is dropped from tab identity (`DockPointer.tabHash`/`toJSON`). Use for
   * views whose pointer is in-view sub-navigation (category/field) rather than a
   * distinct entity, e.g. Preferences' category tabs. (Scope-keyed views fold
   * too, but into one tab PER SCOPE — see `scopeKeyed`.)
   */
  foldsPointer?: boolean;
  /**
   * When true, tab identity is the SCOPE FILTER (one tab per project/user/global
   * scope), not the sub-pointer: `tabHash` becomes `<viewType>|<scopeKey>` and
   * `toJSON` persists the scope options so reopen restores it. Use for scoped
   * browsers (Assets, Explorer) where in-tab navigation must stay in one chip.
   */
  scopeKeyed?: boolean;
}

export const VIEWER_REGISTRY: Partial<Record<ViewType, ViewerMeta>> = {
  [ViewType.HOME]: {
    title: 'Home',
    iconName: 'Home',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    chrome: 'fullbleed',
  },
  // Hub entity list by type (page=hub). Standard workspace chrome; the pointer
  // (the OSS entity type) selects which list, so it stays part of tab identity.
  [ViewType.HUB_RECORDS]: {
    title: 'Records',
    iconName: 'ListChecks',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  // Hub single-entity viewer (page=hub). Pointer = `<type>/<id>`.
  [ViewType.HUB_ENTITY]: {
    title: 'Entity',
    iconName: 'FileText',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SYSTEM_PROFILE]: {
    title: 'System Profile',
    iconName: 'Activity',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.ANALYSIS]: {
    title: 'Analysis',
    iconName: 'Sparkles',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.CHAT]: {
    title: 'Chat',
    iconName: 'MessageSquare',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.SHELL]: {
    title: 'Worker',
    iconName: 'Terminal',
    tabLocation: 'overview',
    canAddAsTab: true,
  },
  [ViewType.EDITOR]: {
    title: 'Code Editor',
    iconName: 'Code',
    tabLocation: 'overview',
    canAddAsTab: true,
  },
  [ViewType.WEB_APP]: {
    title: 'Web App',
    iconName: 'Globe',
    tabLocation: 'overview',
    canAddAsTab: true,
  },
  [ViewType.DIFF]: {
    title: 'Diff Viewer',
    iconName: 'GitCompare',
    tabLocation: 'overview',
    canAddAsTab: false, // Only opened via checkpoint clicks, not manually
  },
  [ViewType.ARTIFACTS]: {
    title: 'Artifacts',
    iconName: 'ListCheck',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.REASONING]: {
    title: 'Reasoning',
    iconName: 'Brain',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.UNSUPPORTED]: {
    title: 'Unsupported',
    iconName: 'FileQuestion',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.MARKDOWN]: {
    title: 'Markdown',
    iconName: 'FileText',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.DOCS]: {
    title: 'Docs',
    iconName: 'BookOpen',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.ASSISTANCE]: {
    title: 'Assistance',
    iconName: 'Hand',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SURVEY]: {
    title: 'Survey',
    iconName: 'ListChecks',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.HOOKS]: {
    title: 'Hooks',
    iconName: 'Webhook',
    tabLocation: 'dedicated',
    canAddAsTab: false, // Only accessible via dev menu, not as dock tab
  },
  [ViewType.MACHINE]: {
    title: 'Machine',
    iconName: 'Cpu',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.EXPLORER]: {
    title: 'Files',
    iconName: 'FolderOpen',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    scopeKeyed: true,
  },
  // ViewType.SKILLS removed — Skills folded into the Assets browser
  // (/dock/assets/list/skill). The enum value is retained in the SDK for
  // back-compat with persisted DockPointers but the registry no longer
  // surfaces it as a navigable view.
  [ViewType.AI_CONFIG]: {
    title: 'AI Configuration',
    iconName: 'Settings',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SHOW]: {
    title: 'Show',
    iconName: 'Eye',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.APPS]: {
    title: 'App',
    iconName: 'Sparkles',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.GRAPH]: {
    title: 'Graph',
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.WORLDVIEW]: {
    title: 'WorldView',
    iconName: 'GitGraph',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.TAG]: {
    title: 'Tag Graph',
    iconName: 'Hash',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    // <tag> in the pointer is in-view focus navigation — every focused
    // tag folds into one tab chip (PREFERENCES precedent).
    foldsPointer: true,
  },
  [ViewType.CREDENTIALS]: {
    title: 'Credentials',
    iconName: 'KeyRound',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    // The pointer is internal tab + project selection, so every combination
    // folds into one chip rather than spawning a tab per tab (PREFERENCES
    // precedent).
    foldsPointer: true,
  },
  [ViewType.SUBGRAPH]: {
    title: 'Subgraph',
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    foldsPointer: true,
  },
  [ViewType.K_BROWSER]: {
    title: 'Knowledge Browser',
    iconName: 'Brain',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.LENS]: {
    title: 'Lens',
    iconName: 'Eye',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  // ViewType.SESSION removed — legacy /dock/session URLs redirect to
  // /dock/shell/<agentic_process>. The old live-workflow viewer is gone.
  [ViewType.TASKS]: {
    title: 'Tasks',
    iconName: 'CheckSquare',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.SETTINGS]: {
    title: 'Settings',
    iconName: 'Settings',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.PREFERENCES]: {
    title: 'Preferences',
    iconName: 'Settings',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    foldsPointer: true,
  },
  [ViewType.AGENTIC_PROCESS]: {
    title: 'Process',
    iconName: 'Monitor',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.LIVE_SESSION]: {
    title: 'Live Session',
    iconName: 'Activity',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.SEARCH]: {
    title: 'Search',
    iconName: 'SearchIcon',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.TRIGGERS]: {
    title: 'Triggers',
    iconName: 'Zap',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.CAPABILITIES]: {
    title: 'Capabilities',
    iconName: 'BadgeCheck',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.GRAPH_WORKFLOWS]: {
    title: 'Graph Workflows',
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SIGNALS]: {
    title: 'Signals',
    iconName: 'RadioTower',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.PLAN]: {
    title: 'Plan',
    iconName: 'FileText',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.CRON]: {
    title: 'Cron',
    iconName: 'Zap',
    tabLocation: 'dedicated',
    canAddAsTab: false, // Only accessible via direct URL /dock/cron
  },
  [ViewType.ASSETS]: {
    title: 'Assets',
    iconName: 'BookOpen',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    scopeKeyed: true,
  },
  [ViewType.PROJECT]: {
    title: 'Collaboration',
    iconName: 'Users',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.INBOX]: {
    title: 'Inbox',
    iconName: 'Mail',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.CONVERSATION]: {
    title: 'Conversation',
    iconName: 'MessageSquare',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.SPEC]: {
    title: 'Spec',
    iconName: 'FileText',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.GRAPH_CONTEXT]: {
    title: 'Context',
    iconName: 'BrainCircuit',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.DIAGNOSIS]: {
    title: 'Diagnosis',
    iconName: 'Stethoscope',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.DESKTOP]: {
    title: 'Desktop',
    iconName: 'LayoutGrid',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    // One Desktop tab per scope: the global desktop (`desktop|all`) and a
    // project-scoped one (`desktop|project:<id>`) are distinct chips, and the
    // scope persists on the stored pointer so reopen restores the filter.
    scopeKeyed: true,
  },
};
