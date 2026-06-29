/**
 * Preference registry — single source of truth for user-editable UI preferences.
 *
 * Mirrors the backend TypeInfo pattern: every preference ("topic") is enumed in
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
 * Every preference topic. The value IS the persisted key:
 * `preferences.<category>.<name>`. Keep this enum in sync with {@link PREF_REGISTRY}
 * (the registry-integrity test enforces a 1:1 mapping).
 */
export enum PrefKey {
  SHOW_SYSTEM_SKILLS = 'preferences.general.show_system_skills',
  DEFAULT_TERMINAL = 'preferences.general.default_terminal',
  BUFFER_SYNC_UPDATES = 'preferences.terminal.buffer_sync_updates',
  SOUND_ENABLED = 'preferences.notifications.sound_enabled',
  SOUND_KEY = 'preferences.notifications.sound_key',
  SCROLLBACK_LINES = 'preferences.advanced.scrollback_lines',
  EXPERIMENTAL_FLAGS = 'preferences.advanced.experimental_flags',
}

export interface PrefOption {
  value: string;
  label: string;
  /** When present, the control renders a preview button that plays this audio URL. */
  previewUrl?: string;
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
}

/** Default notification sound — stable key from the ui sound manifest (DEFAULT_SOUND_KEY). */
const DEFAULT_SOUND_KEY = 'supershort-ping';

export const PREF_REGISTRY: Record<PrefKey, PrefInfo> = {
  [PrefKey.SHOW_SYSTEM_SKILLS]: {
    key: PrefKey.SHOW_SYSTEM_SKILLS,
    category: 'general',
    label: 'Show system skills',
    description: 'Surface built-in system skills in the Assets browser.',
    dataType: PrefDataType.BOOL,
    defaultValue: true,
  },
  [PrefKey.DEFAULT_TERMINAL]: {
    key: PrefKey.DEFAULT_TERMINAL,
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
    category: 'terminal',
    label: 'Buffer terminal sync updates',
    description: 'Buffer PTY writes between sync markers to prevent visible scroll jumps during TUI redraws.',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.SOUND_ENABLED]: {
    key: PrefKey.SOUND_ENABLED,
    category: 'notifications',
    label: 'Play a sound when an agent is waiting for me',
    dataType: PrefDataType.BOOL,
    defaultValue: false,
  },
  [PrefKey.SOUND_KEY]: {
    key: PrefKey.SOUND_KEY,
    category: 'notifications',
    label: 'Sound',
    description: 'Plays each time an agentic process becomes ready for your input.',
    dataType: PrefDataType.STRING,
    defaultValue: DEFAULT_SOUND_KEY,
    optionsSource: 'notification_sounds',
  },
  [PrefKey.SCROLLBACK_LINES]: {
    key: PrefKey.SCROLLBACK_LINES,
    category: 'advanced',
    label: 'Terminal scrollback lines',
    description: 'How many lines of terminal output to retain in the scrollback buffer.',
    dataType: PrefDataType.NUMBER,
    defaultValue: 1000,
  },
  [PrefKey.EXPERIMENTAL_FLAGS]: {
    key: PrefKey.EXPERIMENTAL_FLAGS,
    category: 'advanced',
    label: 'Experimental flags',
    description: 'Free-form JSON for experimental feature toggles. Invalid JSON is not saved.',
    dataType: PrefDataType.JSON,
    defaultValue: {},
  },
};

/** All registered PrefInfos. */
export function getAllPrefInfos(): PrefInfo[] {
  return Object.values(PREF_REGISTRY);
}

/** Ordered, de-duplicated category list derived from the registry. Drives the tabs. */
export const PREF_CATEGORIES: string[] = (() => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const info of getAllPrefInfos()) {
    if (!seen.has(info.category)) {
      seen.add(info.category);
      ordered.push(info.category);
    }
  }
  return ordered;
})();

/** Preferences belonging to a category, in registry order. */
export function prefsForCategory(category: string): PrefInfo[] {
  return getAllPrefInfos().filter((info) => info.category === category);
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
