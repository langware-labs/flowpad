import type * as lucideExports from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
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
 * The merged Events screen and the three view types that are ALIASES of it.
 *
 * `triggers`, `signals` and `cron` used to be separate screens; they now render
 * the same body and the same navigator. They are kept as aliases rather than
 * deleted so bookmarked URLs and persisted tabs keep resolving — the pattern
 * `cron` already used for `triggers`.
 *
 * Anything that switches on "is this the events screen" must consult THIS set,
 * not `=== ViewType.EVENTS`, or old URLs silently lose their navigator, their
 * rail highlight, or their scope seeding.
 */
export const EVENTS_VIEW_TYPES: ReadonlySet<ViewType> = new Set([
  ViewType.EVENTS,
  ViewType.TRIGGERS,
  ViewType.SIGNALS,
  ViewType.CRON,
]);

/**
 * Viewer metadata registry
 * Single source of truth for all viewer information
 */
/** Every `lucide-react` export that is an icon component — what `lucideByName` can resolve. */
type LucideExportName = {
  [K in keyof typeof lucideExports]: (typeof lucideExports)[K] extends LucideIcon ? K : never;
}[keyof typeof lucideExports];

export interface ViewerMeta {
  title: MessageDescriptor;
  /**
   * Icon component name (a string, to keep JSX out of this shared module).
   *
   * Derived from `lucide-react`'s own export map rather than hand-listed. The
   * hand-maintained 40-name allowlist that used to sit here had drifted from
   * the table it constrains — `Building2`, `Hash`, `RadioTower` and
   * `LayoutGrid` were all in use below and all missing from it, 7 errors —
   * and every icon added since would have drifted the same way. `lucideByName`
   * resolves these against exactly this namespace, so this is the real
   * constraint, it still catches a typo, and it cannot go stale.
   *
   * The NAMESPACE, not lucide's `icons` map: the map has dropped the
   * deprecated aliases (`Home`, `FileQuestion`, `CheckSquare`, `SearchIcon`),
   * which the namespace still exports and `lucideByName` still resolves. The
   * map would have flagged four working icons as typos.
   */
  iconName: LucideExportName;
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
    title: msg`Home`,
    iconName: 'Home',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    chrome: 'fullbleed',
  },
  // Hub entity list by type (page=hub). Standard workspace chrome; the pointer
  // (the OSS entity type) selects which list, so it stays part of tab identity.
  [ViewType.HUB_RECORDS]: {
    title: msg`Records`,
    iconName: 'ListChecks',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  // Hub single-entity viewer (page=hub). Pointer = `<type>/<id>`.
  [ViewType.HUB_ENTITY]: {
    title: msg`Entity`,
    iconName: 'FileText',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SYSTEM_PROFILE]: {
    title: msg`System Profile`,
    iconName: 'Activity',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.ANALYSIS]: {
    title: msg`Analysis`,
    iconName: 'Sparkles',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.CHAT]: {
    title: msg`Chat`,
    iconName: 'MessageSquare',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.SHELL]: {
    title: msg`Worker`,
    iconName: 'Terminal',
    tabLocation: 'overview',
    canAddAsTab: true,
  },
  [ViewType.EDITOR]: {
    title: msg`Code Editor`,
    iconName: 'Code',
    tabLocation: 'overview',
    canAddAsTab: true,
  },
  [ViewType.WEB_APP]: {
    title: msg`Web App`,
    iconName: 'Globe',
    tabLocation: 'overview',
    canAddAsTab: true,
  },
  [ViewType.APP]: {
    title: msg`App`,
    iconName: 'Globe',
    tabLocation: 'overview',
    // Not manually openable: an app is reached by showing/running one, never by
    // picking "App" from a menu — its pointer is a specific artifact.
    canAddAsTab: false,
  },
  [ViewType.DIFF]: {
    title: msg`Diff Viewer`,
    iconName: 'GitCompare',
    tabLocation: 'overview',
    canAddAsTab: false, // Only opened via checkpoint clicks, not manually
  },
  [ViewType.ARTIFACTS]: {
    title: msg`Artifacts`,
    iconName: 'ListCheck',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.REASONING]: {
    title: msg`Reasoning`,
    iconName: 'Brain',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.UNSUPPORTED]: {
    title: msg`Unsupported`,
    iconName: 'FileQuestion',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.MARKDOWN]: {
    title: msg`Markdown`,
    iconName: 'FileText',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.DOCS]: {
    title: msg`Docs`,
    iconName: 'BookOpen',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.ASSISTANCE]: {
    title: msg`Assistance`,
    iconName: 'Hand',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SURVEY]: {
    title: msg`Survey`,
    iconName: 'ListChecks',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.HOOKS]: {
    title: msg`Hooks`,
    iconName: 'Webhook',
    tabLocation: 'dedicated',
    canAddAsTab: false, // Only accessible via dev menu, not as dock tab
  },
  [ViewType.MACHINE]: {
    title: msg`Machine`,
    iconName: 'Cpu',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.EXPLORER]: {
    title: msg`Files`,
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
    title: msg`AI Configuration`,
    iconName: 'Settings',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SHOW]: {
    title: msg`Show`,
    iconName: 'Eye',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.APPS]: {
    title: msg`App`,
    iconName: 'Sparkles',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.GRAPH]: {
    title: msg`Graph`,
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.WORLDVIEW]: {
    title: msg`WorldView`,
    iconName: 'GitGraph',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.ORGANIZATION]: {
    title: msg`Organization`,
    iconName: 'Building2',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.TAG]: {
    title: msg`Tag Graph`,
    iconName: 'Hash',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    // <tag> in the pointer is in-view focus navigation — every focused
    // tag folds into one tab chip (PREFERENCES precedent).
    foldsPointer: true,
  },
  [ViewType.CREDENTIALS]: {
    title: msg`Credentials`,
    iconName: 'KeyRound',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    // The pointer is internal tab + project selection, so every combination
    // folds into one chip rather than spawning a tab per tab (PREFERENCES
    // precedent).
    foldsPointer: true,
  },
  // Hub LLM endpoints (page=hub). Pointer = `<id>[/<overview|usage|models>]`:
  // in-view selection + tab, so it folds into one chip (CREDENTIALS precedent).
  [ViewType.LLM_ENDPOINTS]: {
    title: msg`LLM Endpoints`,
    iconName: 'Waypoints',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    foldsPointer: true,
  },
  // Hub token plan (page=hub). Pointer = the scope (`me` | `team[/<id>]` | `org`):
  // an in-view selection, so it folds into one chip (LLM_ENDPOINTS precedent).
  [ViewType.TOKEN_PLAN]: {
    title: msg`Token plan`,
    iconName: 'Gauge',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    foldsPointer: true,
  },
  // What funds this machine's harnesses (page=desk, NOT hub: a device token, a stored key
  // and the endpoint binding are all box facts, and the producing box action 404s on the
  // hub). Pointer = `<section>[/<key>]`, an in-view selection, so it folds into one chip.
  [ViewType.LLM_SOURCES]: {
    title: msg`LLM sources`,
    iconName: 'KeyRound',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    foldsPointer: true,
  },
  [ViewType.SUBGRAPH]: {
    title: msg`Subgraph`,
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    foldsPointer: true,
  },
  [ViewType.K_BROWSER]: {
    title: msg`Knowledge Browser`,
    iconName: 'Brain',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.LENS]: {
    title: msg`Lens`,
    iconName: 'Eye',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  // ViewType.SESSION removed — legacy /dock/session URLs redirect to
  // /dock/shell/<agentic_process>. The old live-workflow viewer is gone.
  [ViewType.TASKS]: {
    title: msg`Tasks`,
    iconName: 'CheckSquare',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.SETTINGS]: {
    title: msg`Settings`,
    iconName: 'Settings',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.PREFERENCES]: {
    title: msg`Preferences`,
    iconName: 'Settings',
    tabLocation: 'dedicated',
    canAddAsTab: false,
    foldsPointer: true,
  },
  [ViewType.AGENTIC_PROCESS]: {
    title: msg`Process`,
    iconName: 'Monitor',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.LIVE_SESSION]: {
    title: msg`Live Session`,
    iconName: 'Activity',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.HELPDESK]: {
    title: msg`Help desk`,
    iconName: 'LifeBuoy',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    // Reading a guide must not mint a tab per article — the portal is one
    // destination. NOT `chrome: 'fullbleed'`, which would drop the tab chip
    // entirely (DockPointer.tabHash returns null for it).
    foldsPointer: true,
  },
  [ViewType.SEARCH]: {
    title: msg`Search`,
    iconName: 'SearchIcon',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.EVENTS]: {
    title: msg`Events`,
    iconName: 'RadioTower',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  // Aliases of EVENTS — same screen, kept so old URLs and old tabs resolve.
  [ViewType.TRIGGERS]: {
    title: msg`Events`,
    iconName: 'RadioTower',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.CAPABILITIES]: {
    title: msg`Capabilities`,
    iconName: 'BadgeCheck',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.GRAPH_WORKFLOWS]: {
    title: msg`Graph Workflows`,
    iconName: 'Workflow',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.SIGNALS]: {
    title: msg`Events`,
    iconName: 'RadioTower',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  // `Antenna` matches DATA_SOURCE.icon in the backend TypeInfo, so the tab chip
  // and the type glyph (which comes from the registry via iconForType) agree.
  [ViewType.DATA_SOURCES]: {
    title: msg`Data sources`,
    iconName: 'Antenna',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  // `Brain` matches RAG_INDEX.icon in the backend TypeInfo, so the tab chip and the type glyph
  // (which comes from the registry via iconForType) agree.
  [ViewType.RAG]: {
    title: msg`Search indexes`,
    iconName: 'Brain',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.PROCESS_RUNS]: {
    title: msg`Runs`,
    iconName: 'History',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.PLAN]: {
    title: msg`Plan`,
    iconName: 'FileText',
    tabLocation: 'overview',
    canAddAsTab: false,
  },
  [ViewType.CRON]: {
    title: msg`Events`,
    iconName: 'RadioTower',
    tabLocation: 'dedicated',
    canAddAsTab: false, // Only accessible via direct URL /dock/cron
  },
  [ViewType.ASSETS]: {
    title: msg`Assets`,
    iconName: 'BookOpen',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    scopeKeyed: true,
  },
  [ViewType.PROJECT]: {
    title: msg`Collaboration`,
    iconName: 'Users',
    tabLocation: 'dedicated',
    canAddAsTab: true,
  },
  [ViewType.AGENT]: {
    title: msg`Agent`,
    iconName: 'Bot',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.INBOX]: {
    title: msg`Inbox`,
    iconName: 'Mail',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.CONVERSATION]: {
    title: msg`Conversation`,
    iconName: 'MessageSquare',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.SPEC]: {
    title: msg`Spec`,
    iconName: 'FileText',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.GRAPH_CONTEXT]: {
    title: msg`Context`,
    iconName: 'BrainCircuit',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.DIAGNOSIS]: {
    title: msg`Diagnosis`,
    iconName: 'Stethoscope',
    tabLocation: 'dedicated',
    canAddAsTab: false,
  },
  [ViewType.DESKTOP]: {
    title: msg`Desktop`,
    iconName: 'LayoutGrid',
    tabLocation: 'dedicated',
    canAddAsTab: true,
    // One Desktop tab per scope: the global desktop (`desktop|all`) and a
    // project-scoped one (`desktop|project:<id>`) are distinct chips, and the
    // scope persists on the stored pointer so reopen restores the filter.
    scopeKeyed: true,
  },
};

/**
 * The view's display title, translated.
 *
 * `VIEWER_REGISTRY` is module-level, so its titles are held as lazy `msg`
 * descriptors — an eager macro out there would bind the language at import and
 * never follow a locale switch. Read a title through here rather than off
 * `.title`, so the resolution happens once, at render, in one place.
 */
export function viewerTitle(viewType: ViewType | string | null | undefined): string | undefined {
  if (!viewType) return undefined;
  const descriptor = VIEWER_REGISTRY[viewType as ViewType]?.title;
  return descriptor ? i18n._(descriptor) : undefined;
}
