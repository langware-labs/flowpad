/**
 * Preference registry — single source of truth for user-editable UI preferences.
 *
 * Mirrors the backend TypeInfo pattern: every preference ("tag") is enumed in
 * {@link PrefKey} and declared once as a {@link PrefInfo} in {@link PREF_REGISTRY}.
 * A preference is identified by the dotted string key `preferences.<category>.<name>`;
 * its {@link PrefInfo.dataType} drives how the stored value ("data") is rendered into a
 * control and parsed back out (see ui PrefControl). The store
 * ({@link InstancePreferences}) persists these as a flat JSON object keyed by PrefKey.
 */

import { TerminalType } from '../services/shell/builtInShells';

/** The four value shapes a preference can hold. Drives control rendering + (de)serialization. */
export enum PrefDataType {
  NUMBER = 'number',
  STRING = 'string',
  BOOL = 'bool',
  JSON = 'json',
}

/**
 * Every preference tag. The value IS the persisted key:
 * `preferences.<category>.<name>`. Keep this enum in sync with {@link PREF_REGISTRY}
 * (the registry-integrity test enforces a 1:1 mapping).
 */
export enum PrefKey {
  SHOW_SYSTEM_SKILLS = 'preferences.general.show_system_skills',
  DEFAULT_TERMINAL = 'preferences.general.default_terminal',
  BUFFER_SYNC_UPDATES = 'preferences.terminal.buffer_sync_updates',
  SOUND_ENABLED = 'preferences.notifications.sound_enabled',
  SOUND_KEY = 'preferences.notifications.sound_key',
  SHARE_MESSAGE_STATUS = 'preferences.notifications.share_message_status',
  SCROLLBACK_LINES = 'preferences.advanced.scrollback_lines',
  EXPERIMENTAL_FLAGS = 'preferences.advanced.experimental_flags',
  INDEXER_BACKEND = 'preferences.advanced.indexer_backend',

  // --- Auto-index a project on selection (the "Auto Index" tab) ---
  // Read backend-side via flow_sdk/fs_store/indexer/auto_index.py, which owns
  // the matching key constants and defaults. `AUTO_INDEX_ENABLED` gates the
  // other three in the UI (visibleWhen) — but that is presentation only; the
  // backend re-reads `enabled` itself and never infers it from visibility.
  AUTO_INDEX_ENABLED = 'preferences.auto_index.enabled',
  AUTO_INDEX_TYPE = 'preferences.auto_index.index_type',
  AUTO_INDEX_TRIGGER = 'preferences.auto_index.index_trigger',
  AUTO_INDEX_FUNCTION = 'preferences.auto_index.index_function',

  // --- Migrated from localStorage (see prefRegistry plan) ---
  // i18n / ui (boot keys read at module load, gate first paint)
  LOCALE = 'preferences.i18n.locale',
  VIEW_MODE = 'preferences.ui.view_mode',
  VIBE_MODEL_TIER = 'preferences.ui.vibe_model_tier',
  CHAT_SHOW_TOOLS = 'preferences.chat.show_tools',
  ONBOARDING_DISMISSED = 'preferences.ui.onboarding_dismissed',
  SHOW_SYSTEM_PROJECTS = 'preferences.ui.show_system_projects',
  // Per-folder indexing consent (macOS-TCC / cross-OS special folders):
  // 'ask' | 'skip' | 'allow' | 'denied'. Mirrors flow_sdk special_folders.py.
  INDEX_FOLDER_DOCUMENTS = 'preferences.indexing.folders.documents',
  INDEX_FOLDER_DESKTOP = 'preferences.indexing.folders.desktop',
  INDEX_FOLDER_DOWNLOADS = 'preferences.indexing.folders.downloads',
  // terminal
  TRACE_FILTERS = 'preferences.terminal.trace_filters',
  COLUMN_VISIBILITY = 'preferences.terminal.column_visibility',
  PROMPT_SORT_DIR = 'preferences.terminal.prompt_sort_dir',
  HISTORY_SORT_DIR = 'preferences.terminal.history_sort_dir',
  HISTORY_ALL_PROJECTS = 'preferences.terminal.history_all_projects',
  LAST_OPENER = 'preferences.terminal.last_opener',
  PINNED_OPENERS = 'preferences.terminal.pinned_openers',
  // assets / skills
  EDITOR_MODE = 'preferences.assets.editor_mode',
  TRANSCRIPT_MODE = 'preferences.assets.transcript_mode',
  AGENT_TRACE_TAB = 'preferences.assets.agent_trace_tab',
  SKILL_FAVORITE_INDICES = 'preferences.skills.favorite_indices',
  // errors
  ERROR_TIME_SPAN = 'preferences.errors.time_span',
  ERROR_STATUS_FILTER = 'preferences.errors.status_filter',
  ERROR_DEDUPLICATE = 'preferences.errors.deduplicate',
  // debug
  // Dev-only: which SPA page the local desktop server serves — 'desk' (default)
  // or 'hub'. Toggled from the version modal; read by the backend at bootstrap
  // to set supported_pages. Must match flow_sdk/server/routes/bootstrap.py.
  APP_PAGE = 'preferences.dev.app_page',
  // debug (sniffer)
  SNIFFER_MAX_EVENTS = 'preferences.debug.sniffer_max_events',
  SNIFFER_TIME_SPAN = 'preferences.debug.sniffer_time_span',
  SNIFFER_FILTERS = 'preferences.debug.sniffer_filters',
  EVENT_LAYERS = 'preferences.debug.event_layers',
  // onboarding
  ONBOARDING_WELCOME = 'preferences.onboarding.welcome',
}

export interface PrefOption {
  value: string;
  label: string;
  /** When present, the control renders a preview button that plays this audio URL. */
  previewUrl?: string;
}

/** Value shapes a visibility rule can compare. JSON prefs can't be controllers. */
export type PrefScalar = string | number | boolean | null;

/**
 * Dependency rule: this pref only means anything while another pref holds a
 * given value — a master toggle gating its sub-options.
 *
 * One level only: the controller must not itself declare a `visibleWhen` (the
 * registry-integrity test asserts this), so evaluation is a single comparison
 * and a cycle is impossible.
 */
export interface PrefVisibility {
  /** The controlling pref. Same category, surfaced, and never `self`. */
  key: PrefKey;
  /** Show when the controller equals this value. */
  equals: PrefScalar;
}

export interface PrefInfo {
  key: PrefKey;
  /** Category bucket — drives the Preferences screen's tabs. */
  category: string;
  label: string;
  description?: string;
  /** Drives control rendering and value coercion. */
  dataType: PrefDataType;
  defaultValue: unknown;
  /** Static select options (STRING prefs). */
  options?: PrefOption[];
  /**
   * UI-resolved option source for options that can't live in the SDK layer
   * (e.g. the Vite-glob notification-sound manifest in `ui`). PrefControl maps
   * a known source string to its option list at render time.
   */
  optionsSource?: 'notification_sounds';
  /**
   * Render this pref as a control in the Preferences screen. Default **false**:
   * most prefs are contextual UI state (sort dirs, filters, modes) set via their
   * own in-place controls — registry-backed for storage/validation/reactivity but
   * not surfaced as a settings control.
   */
  surfaced?: boolean;
  /**
   * First-paint key: the store seeds it **synchronously** from localStorage in its
   * constructor (before the async backend `loadJson`) and **mirrors** it back to
   * localStorage on every `set`. Use for values read at module load that gate the
   * first render (locale → `<html lang/dir>`, viewMode → `data-view`), so prefMan
   * can own them without a flash-to-default on boot.
   */
  boot?: boolean;
  /**
   * The pre-migration localStorage key. On load the store adopts this key's value
   * when the backend file lacks the dotted key (one-time migration of an existing
   * user's choice); for `boot` keys it is also the synchronous seed + mirror key.
   * Defaults to the dotted PrefKey when omitted.
   */
  legacyLocalStorageKey?: string;
  /**
   * Show this pref in the Preferences screen only while its controller matches.
   * `PreferencesView` filters the row out entirely (it never mounts) rather than
   * disabling it, so a hidden pref also stops subscribing.
   *
   * Two properties worth knowing: hiding does **not** reset the stored value —
   * re-enabling the controller restores the user's previous choices; and
   * visibility is **not a gate**. Any runtime consumer must still check the
   * controller's own value. "The user can't see it" never implies "it's off".
   */
  visibleWhen?: PrefVisibility;
}

/** Default notification sound — stable key from the ui sound manifest (DEFAULT_SOUND_KEY). */
const DEFAULT_SOUND_KEY = 'supershort-ping';

/**
 * Per-folder indexing-consent tri-state (plus the OS-refused terminal state).
 * Shared by every `preferences.indexing.folders.*` pref. Mirrors the states in
 * flow_sdk/fs_store/indexer/special_folders.py.
 */
export const INDEX_FOLDER_OPTIONS: PrefOption[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Always index' },
  { value: 'skip', label: 'Never index' },
  { value: 'denied', label: 'Blocked by system' },
];

/**
 * Category id for the auto-index-on-selection prefs — also the Preferences tab
 * id, so `humanizeType` renders it as "Auto Index".
 *
 * Deliberately NOT `indexing`: that category holds only the hidden per-folder
 * consent prefs, and `preferences.test.tsx` asserts it never becomes a tab.
 */
export const CATEGORY_AUTO_INDEX = 'auto_index';

/** Depth of an auto-index run. Mirrors IndexType in auto_index.py. */
export const AUTO_INDEX_TYPE_OPTIONS: PrefOption[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'full', label: 'Full' },
];

/** When the auto-index fires. Mirrors IndexTrigger in auto_index.py. */
export const AUTO_INDEX_TRIGGER_OPTIONS: PrefOption[] = [
  { value: 'project_create', label: 'Project create' },
  { value: 'first_selection', label: 'First selection' },
  { value: 'every_selection', label: 'Every selection' },
];

/** Where the walk executes on the server. Mirrors ScanMode in indexer/builtin.py. */
export const AUTO_INDEX_FUNCTION_OPTIONS: PrefOption[] = [
  { value: 'subprocess', label: 'Subprocess' },
  { value: 'thread', label: 'Thread' },
];

/** One PrefInfo for a per-folder indexing-consent pref (Documents/Desktop/…). */
function indexFolderPref(key: PrefKey, folder: string): PrefInfo {
  return {
    key,
    category: 'indexing',
    label: `Index ${folder} folder`,
    description: `Ask before indexing projects in your ${folder} folder.`,
    dataType: PrefDataType.STRING,
    defaultValue: 'ask',
    options: INDEX_FOLDER_OPTIONS,
  };
}

export const PREF_REGISTRY: Record<PrefKey, PrefInfo> = {
  [PrefKey.SHOW_SYSTEM_SKILLS]: {
    key: PrefKey.SHOW_SYSTEM_SKILLS,
    surfaced: true,
    category: 'general',
    label: 'Show system skills',
    description: 'Surface built-in system skills in the Assets browser.',
    dataType: PrefDataType.BOOL,
    defaultValue: true,
  },
  [PrefKey.DEFAULT_TERMINAL]: {
    key: PrefKey.DEFAULT_TERMINAL,
    surfaced: true,
    category: 'general',
    label: 'External terminal',
    description:
      'The in-app terminal is always the primary shell. This controls whether a sidecar OS Terminal window is also opened.',
    dataType: PrefDataType.STRING,
    defaultValue: TerminalType.BUILTIN_XTERM,
    options: [
      { value: TerminalType.BUILTIN_XTERM, label: 'In-app only' },
      { value: TerminalType.EXTERNAL_TERMINAL, label: 'Also open sidecar OS Terminal' },
    ],
  },
  [PrefKey.BUFFER_SYNC_UPDATES]: {
    key: PrefKey.BUFFER_SYNC_UPDATES,
    surfaced: true,
    category: 'terminal',
    label: 'Buffer terminal sync updates',
    description: 'Buffer PTY writes between sync markers to prevent visible scroll jumps during TUI redraws.',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.SOUND_ENABLED]: {
    key: PrefKey.SOUND_ENABLED,
    surfaced: true,
    category: 'notifications',
    label: 'Play a sound when an agent is waiting for me',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.SOUND_KEY]: {
    key: PrefKey.SOUND_KEY,
    surfaced: true,
    category: 'notifications',
    label: 'Sound',
    description: 'Plays each time an agentic process becomes ready for your input.',
    dataType: PrefDataType.STRING,
    defaultValue: DEFAULT_SOUND_KEY,
    optionsSource: 'notification_sounds',
  },
  [PrefKey.SHARE_MESSAGE_STATUS]: {
    key: PrefKey.SHARE_MESSAGE_STATUS,
    surfaced: true,
    category: 'notifications',
    label: 'Share message status',
    description: 'Let other participants see when messages are delivered or read.',
    dataType: PrefDataType.BOOL,
    defaultValue: true,
  },
  [PrefKey.SCROLLBACK_LINES]: {
    key: PrefKey.SCROLLBACK_LINES,
    surfaced: true,
    category: 'advanced',
    label: 'Terminal scrollback lines',
    description: 'How many lines of terminal output to retain in the scrollback buffer.',
    dataType: PrefDataType.NUMBER,
    defaultValue: 1000,
  },
  [PrefKey.EXPERIMENTAL_FLAGS]: {
    key: PrefKey.EXPERIMENTAL_FLAGS,
    surfaced: true,
    category: 'advanced',
    label: 'Experimental flags',
    description: 'Free-form JSON for experimental feature toggles. Invalid JSON is not saved.',
    dataType: PrefDataType.JSON,
    defaultValue: {},
  },
  [PrefKey.INDEXER_BACKEND]: {
    key: PrefKey.INDEXER_BACKEND,
    surfaced: true,
    category: 'advanced',
    label: 'Indexer backend',
    description:
      'Which engine runs filesystem indexing: the built-in Python FSIndexer, or the external Rust indexer (requires FLOWPAD_RS_INDEXER_BIN on the server; silently falls back to Python when unavailable). Takes effect on the next index run.',
    dataType: PrefDataType.STRING,
    defaultValue: 'python',
    options: [
      { value: 'python', label: 'Python (FSIndexer)' },
      { value: 'rust', label: 'Rust (RSIndexer)' },
    ],
  },

  // ===== Auto Index (project selection) =====
  // The BACKEND owns the trigger: it hooks the project `activate` action and
  // project create, and reads these keys with read_instance_pref. The frontend
  // only edits them — there is no client-side index call. Defaults here must stay
  // identical to auto_index.py's, because `default_prefs` is only written for a
  // missing/stub preferences.json, so upgraders fall back to the in-code default.
  [PrefKey.AUTO_INDEX_ENABLED]: {
    key: PrefKey.AUTO_INDEX_ENABLED,
    surfaced: true,
    category: CATEGORY_AUTO_INDEX,
    label: 'Index project on selection',
    description:
      'Index a project’s files when you open it, so its assets and search are ready without a manual index run.',
    dataType: PrefDataType.BOOL,
    defaultValue: true,
  },
  [PrefKey.AUTO_INDEX_TYPE]: {
    key: PrefKey.AUTO_INDEX_TYPE,
    surfaced: true,
    category: CATEGORY_AUTO_INDEX,
    visibleWhen: { key: PrefKey.AUTO_INDEX_ENABLED, equals: true },
    label: 'Index depth',
    description:
      'Fast re-reads only the files that changed since the last index. Full re-reads every file in the project.',
    dataType: PrefDataType.STRING,
    defaultValue: 'fast',
    options: AUTO_INDEX_TYPE_OPTIONS,
  },
  [PrefKey.AUTO_INDEX_TRIGGER]: {
    key: PrefKey.AUTO_INDEX_TRIGGER,
    surfaced: true,
    category: CATEGORY_AUTO_INDEX,
    visibleWhen: { key: PrefKey.AUTO_INDEX_ENABLED, equals: true },
    label: 'Index when',
    description:
      'Project create indexes once, as the project is created. First selection indexes the first time you open a project. Every selection re-indexes on each switch into it — note that even a Fast run still walks the whole project, so this is the expensive option on large trees.',
    dataType: PrefDataType.STRING,
    defaultValue: 'first_selection',
    options: AUTO_INDEX_TRIGGER_OPTIONS,
  },
  [PrefKey.AUTO_INDEX_FUNCTION]: {
    key: PrefKey.AUTO_INDEX_FUNCTION,
    surfaced: true,
    category: CATEGORY_AUTO_INDEX,
    visibleWhen: { key: PrefKey.AUTO_INDEX_ENABLED, equals: true },
    label: 'Run the walk in',
    description:
      'Subprocess runs the file walk in a separate process, so a large or slow tree can’t stall the server (database writes stay in the server either way). Thread runs it in-process — lower startup cost, better for small projects. No effect when the Rust indexer backend is selected.',
    dataType: PrefDataType.STRING,
    defaultValue: 'subprocess',
    options: AUTO_INDEX_FUNCTION_OPTIONS,
  },

  // ===== Migrated from localStorage =====
  // Boot keys (i18n.locale, ui.view_mode) are seeded synchronously
  // from localStorage at construction and mirrored back on set, so first paint is
  // correct before the backend loads.
  [PrefKey.LOCALE]: {
    key: PrefKey.LOCALE,
    surfaced: true,
    boot: true,
    legacyLocalStorageKey: 'locale',
    category: 'i18n',
    label: 'Language',
    description: 'Interface language and text direction.',
    dataType: PrefDataType.STRING,
    defaultValue: 'en-US',
  },
  [PrefKey.VIBE_MODEL_TIER]: {
    key: PrefKey.VIBE_MODEL_TIER,
    category: 'ui',
    label: 'Vibe model',
    description: 'Which model size a Vibe build starts on: Fast, Balanced or Accurate.',
    dataType: PrefDataType.STRING,
    // Balanced, matching the tier a Vibe session used before the composer could
    // choose one. Persisted because the choice is usually about COST, and a
    // preference that resets to the expensive default on every mount is worse
    // than no preference at all.
    defaultValue: 'md',
    options: [
      { value: 'sm', label: 'Fast' },
      { value: 'md', label: 'Balanced' },
      { value: 'lg', label: 'Accurate' },
    ],
  },
  [PrefKey.VIEW_MODE]: {
    key: PrefKey.VIEW_MODE,
    surfaced: true,
    boot: true,
    legacyLocalStorageKey: 'viewMode',
    category: 'ui',
    label: 'View mode',
    description: 'Surface complexity: Vibe (simplest, creator), Standard (minimal), Advanced, or Dev.',
    dataType: PrefDataType.STRING,
    // Vibe is the default; opt up to Standard/Advanced/Dev via the footer View toggle.
    defaultValue: 'vibe',
    options: [
      { value: 'vibe', label: 'Vibe' },
      { value: 'standard', label: 'Standard' },
      { value: 'advanced', label: 'Advanced' },
      { value: 'dev', label: 'Dev' },
    ],
  },
  [PrefKey.APP_PAGE]: {
    key: PrefKey.APP_PAGE,
    // Not surfaced in the Preferences screen: it's a dev-only debug toggle that
    // lives in the version modal. Not a boot key: the backend drives the actual
    // page selection via supported_pages at bootstrap, so no first-paint seed.
    category: 'debug',
    label: 'App page (dev)',
    description: "Which page the local server renders: 'desk' (default) or 'hub'. Dev-only.",
    dataType: PrefDataType.STRING,
    defaultValue: 'desk',
    options: [
      { value: 'desk', label: 'Desktop' },
      { value: 'hub', label: 'Hub' },
    ],
  },
  [PrefKey.CHAT_SHOW_TOOLS]: {
    key: PrefKey.CHAT_SHOW_TOOLS,
    surfaced: true,
    category: 'chat',
    label: 'Show tool calls',
    description: 'Show tool calls, reasoning, and status chips in the chat transcript.',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.ONBOARDING_DISMISSED]: {
    key: PrefKey.ONBOARDING_DISMISSED,
    legacyLocalStorageKey: 'flowpad-onboarding-dismissed',
    category: 'ui',
    label: 'Onboarding dismissed',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.SHOW_SYSTEM_PROJECTS]: {
    key: PrefKey.SHOW_SYSTEM_PROJECTS,
    surfaced: true,
    legacyLocalStorageKey: 'project-list-show-system',
    category: 'ui',
    label: 'Show system projects',
    description: 'Include built-in system projects in the project picker.',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.INDEX_FOLDER_DOCUMENTS]: indexFolderPref(PrefKey.INDEX_FOLDER_DOCUMENTS, 'Documents'),
  [PrefKey.INDEX_FOLDER_DESKTOP]: indexFolderPref(PrefKey.INDEX_FOLDER_DESKTOP, 'Desktop'),
  [PrefKey.INDEX_FOLDER_DOWNLOADS]: indexFolderPref(PrefKey.INDEX_FOLDER_DOWNLOADS, 'Downloads'),
  [PrefKey.TRACE_FILTERS]: {
    key: PrefKey.TRACE_FILTERS,
    legacyLocalStorageKey: 'traceFilters',
    category: 'terminal',
    label: 'Trace filters',
    dataType: PrefDataType.JSON,
    defaultValue: { events: true },
  },
  [PrefKey.COLUMN_VISIBILITY]: {
    key: PrefKey.COLUMN_VISIBILITY,
    legacyLocalStorageKey: 'colVisibility',
    category: 'terminal',
    label: 'Column visibility',
    dataType: PrefDataType.JSON,
    defaultValue: { trace: true, time: true, annotations: true },
  },
  [PrefKey.PROMPT_SORT_DIR]: {
    key: PrefKey.PROMPT_SORT_DIR,
    legacyLocalStorageKey: 'flowpad.promptIndexPanel.sortDir',
    category: 'terminal',
    label: 'Prompt index sort direction',
    dataType: PrefDataType.STRING,
    defaultValue: 'asc',
  },
  [PrefKey.HISTORY_SORT_DIR]: {
    key: PrefKey.HISTORY_SORT_DIR,
    legacyLocalStorageKey: 'flowpad.historyModal.sortDir',
    category: 'terminal',
    label: 'History sort direction',
    dataType: PrefDataType.STRING,
    defaultValue: 'desc',
  },
  [PrefKey.HISTORY_ALL_PROJECTS]: {
    key: PrefKey.HISTORY_ALL_PROJECTS,
    legacyLocalStorageKey: 'flowpad.historyModal.allProjects',
    category: 'terminal',
    label: 'History across all projects',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.LAST_OPENER]: {
    key: PrefKey.LAST_OPENER,
    legacyLocalStorageKey: 'flowpad.terminal.lastOpener',
    category: 'terminal',
    label: 'Last terminal opener',
    dataType: PrefDataType.JSON,
    defaultValue: null,
  },
  [PrefKey.PINNED_OPENERS]: {
    key: PrefKey.PINNED_OPENERS,
    legacyLocalStorageKey: 'flowpad.terminal.pinnedOpeners',
    category: 'terminal',
    label: 'Pinned terminal openers',
    dataType: PrefDataType.JSON,
    defaultValue: [],
  },
  [PrefKey.EDITOR_MODE]: {
    key: PrefKey.EDITOR_MODE,
    legacyLocalStorageKey: 'markdownEditor.mode',
    category: 'assets',
    label: 'Markdown editor mode',
    dataType: PrefDataType.STRING,
    defaultValue: 'view',
  },
  [PrefKey.TRANSCRIPT_MODE]: {
    key: PrefKey.TRANSCRIPT_MODE,
    legacyLocalStorageKey: 'transcript-viewer-mode',
    category: 'assets',
    label: 'Transcript viewer mode',
    dataType: PrefDataType.STRING,
    defaultValue: 'chat',
  },
  [PrefKey.AGENT_TRACE_TAB]: {
    key: PrefKey.AGENT_TRACE_TAB,
    legacyLocalStorageKey: 'agent-trace-tab',
    category: 'assets',
    label: 'Agent trace tab',
    dataType: PrefDataType.STRING,
    defaultValue: 'stack',
  },
  [PrefKey.SKILL_FAVORITE_INDICES]: {
    key: PrefKey.SKILL_FAVORITE_INDICES,
    legacyLocalStorageKey: 'flowpad.skills.favoriteIndex',
    category: 'skills',
    label: 'Skill favorite order',
    dataType: PrefDataType.JSON,
    defaultValue: {},
  },
  [PrefKey.ERROR_TIME_SPAN]: {
    key: PrefKey.ERROR_TIME_SPAN,
    legacyLocalStorageKey: 'flowpad-error-timespan',
    category: 'errors',
    label: 'Error time span',
    dataType: PrefDataType.STRING,
    defaultValue: '24h',
  },
  [PrefKey.ERROR_STATUS_FILTER]: {
    key: PrefKey.ERROR_STATUS_FILTER,
    legacyLocalStorageKey: 'flowpad-error-status',
    category: 'errors',
    label: 'Error status filter',
    dataType: PrefDataType.STRING,
    defaultValue: 'open',
  },
  [PrefKey.ERROR_DEDUPLICATE]: {
    key: PrefKey.ERROR_DEDUPLICATE,
    surfaced: true,
    legacyLocalStorageKey: 'flowpad-error-dedup',
    category: 'errors',
    label: 'Deduplicate errors',
    description: 'Collapse repeated error records into a single row.',
    dataType: PrefDataType.BOOL,
    defaultValue: true,
  },
  [PrefKey.SNIFFER_MAX_EVENTS]: {
    key: PrefKey.SNIFFER_MAX_EVENTS,
    surfaced: true,
    legacyLocalStorageKey: 'flowpad-sniffer-max-events',
    category: 'debug',
    label: 'Max sniffer events',
    description: 'How many hook-sniffer events to retain in the buffer.',
    dataType: PrefDataType.NUMBER,
    defaultValue: 100,
  },
  [PrefKey.SNIFFER_TIME_SPAN]: {
    key: PrefKey.SNIFFER_TIME_SPAN,
    legacyLocalStorageKey: 'flowpad-sniffer-timespan',
    category: 'debug',
    label: 'Sniffer time span',
    dataType: PrefDataType.STRING,
    defaultValue: '1M',
  },
  [PrefKey.SNIFFER_FILTERS]: {
    key: PrefKey.SNIFFER_FILTERS,
    legacyLocalStorageKey: 'flowpad-sniffer-filters',
    category: 'debug',
    label: 'Sniffer pipeline filters',
    dataType: PrefDataType.JSON,
    defaultValue: {},
  },
  [PrefKey.EVENT_LAYERS]: {
    key: PrefKey.EVENT_LAYERS,
    legacyLocalStorageKey: 'flowpad-sniffer-layers',
    category: 'debug',
    label: 'Event layers',
    dataType: PrefDataType.JSON,
    // Tri-state: null = show all (default/cleared), [] = show none, [subset] = subset.
    // null preserves the original semantics where the absent key meant "all".
    defaultValue: null,
  },
  [PrefKey.ONBOARDING_WELCOME]: {
    key: PrefKey.ONBOARDING_WELCOME,
    surfaced: true,
    category: 'onboarding',
    label: 'Regenerate onboarding assets on next start',
    description:
      'When on, the server re-creates the Welcome bookmark + feed entry on the next start, then turns this off.',
    dataType: PrefDataType.BOOL,
    // true so a fresh instance seeds; the backend flips it to false after seeding.
    defaultValue: true,
  },
};

/** All registered PrefInfos (full registry — used by the store). */
export function getAllPrefInfos(): PrefInfo[] {
  return Object.values(PREF_REGISTRY);
}

/** PrefInfos surfaced as controls in the Preferences screen. */
export function getSurfacedPrefInfos(): PrefInfo[] {
  return getAllPrefInfos().filter((info) => info.surfaced);
}

/** Boot keys — seeded synchronously from localStorage + mirrored on set. */
export function getBootPrefInfos(): PrefInfo[] {
  return getAllPrefInfos().filter((info) => info.boot);
}

/** The localStorage key a pref reads/mirrors (legacy key, else the dotted PrefKey). */
export function storageKeyFor(info: PrefInfo): string {
  return info.legacyLocalStorageKey ?? info.key;
}

/**
 * Ordered, de-duplicated category list — **surfaced prefs only**, since this drives
 * the Preferences screen's tabs. Hidden contextual prefs never get a tab.
 */
export const PREF_CATEGORIES: string[] = (() => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const info of getSurfacedPrefInfos()) {
    if (!seen.has(info.category)) {
      seen.add(info.category);
      ordered.push(info.category);
    }
  }
  return ordered;
})();

/** Surfaced preferences belonging to a category, in registry order. */
/**
 * Surfaced prefs bucketed by category, computed once at module load.
 *
 * `prefsForCategory` used to re-scan the whole registry on every call, and the
 * Preferences screen calls it per category on every store change — so a single
 * unrelated `set()` re-filtered ~60 entries eight times over.
 */
const PREFS_BY_CATEGORY: Record<string, PrefInfo[]> = (() => {
  const out: Record<string, PrefInfo[]> = {};
  for (const info of getSurfacedPrefInfos()) {
    (out[info.category] ??= []).push(info);
  }
  return out;
})();

export function prefsForCategory(category: string): PrefInfo[] {
  return PREFS_BY_CATEGORY[category] ?? [];
}

/**
 * Is `info` visible, given a reader for other prefs' current values?
 *
 * True whenever the pref declares no `visibleWhen`. The reader is injected so
 * this module stays free of any store import (it currently imports nothing but
 * `builtInShells`) and so the rule is trivially testable with a plain lookup.
 *
 * Strict equality is enough: `visibleWhen` controllers are BOOL/STRING/NUMBER
 * prefs, never JSON, so there is no structural compare to do.
 */
export function isPrefVisible(info: PrefInfo, read: (key: PrefKey) => unknown): boolean {
  const rule = info.visibleWhen;
  return !rule || read(rule.key) === rule.equals;
}

/** Surfaced prefs for a category, minus rows hidden by an unmet `visibleWhen`. */
export function visiblePrefsForCategory(
  category: string,
  read: (key: PrefKey) => unknown,
): PrefInfo[] {
  return prefsForCategory(category).filter((info) => isPrefVisible(info, read));
}

/** Default-value map keyed by dotted PrefKey — seeds the store. */
export function defaultPreferences(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const info of getAllPrefInfos()) {
    out[info.key] = info.defaultValue;
  }
  return out;
}

/**
 * Legacy flat-key → dotted PrefKey migration map. The old preferences.json used
 * bare field names; on load we re-key any of these to their PrefKey.
 */
export const LEGACY_KEY_MAP: Record<string, PrefKey> = {
  show_system_skills: PrefKey.SHOW_SYSTEM_SKILLS,
  default_terminal: PrefKey.DEFAULT_TERMINAL,
  buffer_sync_updates: PrefKey.BUFFER_SYNC_UPDATES,
  notification_sound_enabled: PrefKey.SOUND_ENABLED,
  notification_sound_key: PrefKey.SOUND_KEY,
};

/**
 * Decode a localStorage string into a pref value, matching how the legacy key
 * encoded it: STRING/BOOL/NUMBER were stored RAW (`'en-US'`, `'true'`, `'100'`),
 * only JSON prefs were `JSON.stringify`'d. Returns `undefined` if the raw value
 * can't be decoded (caller falls back to the default).
 */
export function parseStoredValue(info: PrefInfo, raw: string): unknown {
  if (info.dataType === PrefDataType.JSON) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return coercePrefValue(info.dataType, raw);
}

/**
 * Encode a pref value for localStorage in the same shape the legacy key used, so
 * a boot-key mirror stays interoperable with any not-yet-migrated reader: JSON
 * prefs are stringified, everything else is written raw.
 */
export function serializeStoredValue(info: PrefInfo, value: unknown): string {
  if (info.dataType === PrefDataType.JSON) {
    return JSON.stringify(value);
  }
  return String(value ?? '');
}

/** Coerce a raw (possibly JSON-parsed or UI-supplied) value to a pref's dataType. */
export function coercePrefValue(dataType: PrefDataType, value: unknown): unknown {
  switch (dataType) {
    case PrefDataType.BOOL:
      return value === true || value === 'true';
    case PrefDataType.NUMBER: {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case PrefDataType.STRING:
      return value == null ? '' : String(value);
    case PrefDataType.JSON:
      // Already a parsed value; stored as-is and serialized by the store.
      return value;
    default:
      return value;
  }
}
