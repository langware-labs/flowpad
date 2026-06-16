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
    | 'Users'
    | 'Inbox';
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
}

export const VIEWER_REGISTRY: Partial<Record<ViewType, ViewerMeta>> = {
  [ViewType.HOME]: {
    title: 'Home',
    iconName: 'Home',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    chrome: 'fullbleed',
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
    title: 'Shell',
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
  [ViewType.ENVIRONMENT]: {
    title: 'Environment',
    iconName: 'KeyRound',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.CONNECTIONS]: {
    title: 'Connections',
    iconName: 'LogIn',
    tabLocation: 'dedicated',
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
  [ViewType.API_KEYS]: {
    title: 'API Keys',
    iconName: 'Key',
    tabLocation: 'dedicated',
    canAddAsTab: true,
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
  [ViewType.EXECUTE_FLOW]: {
    title: 'Execute Flow',
    iconName: 'PlaySquare',
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
  [ViewType.AGENTIC_PROCESS]: {
    title: 'Process',
    iconName: 'Monitor',
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
  [ViewType.WORKFLOWS]: {
    title: 'Workflows',
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.ASSETS]: {
    title: 'Assets',
    iconName: 'BookOpen',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.PROJECT]: {
    title: 'Collaboration',
    iconName: 'Users',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.INBOX]: {
    title: 'Inbox',
    iconName: 'Inbox',
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
};
