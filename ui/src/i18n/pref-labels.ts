import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { PrefKey } from '@sdk';

/**
 * Localized copy for the PREFERENCES registry.
 *
 * Same shape and same reasoning as `type-labels.ts`: the registry
 * (`ts_sdk/src/preferences/prefRegistry.ts`) stays the authority for what a
 * preference is CALLED — its `label`, `description` and option labels are the
 * English wording, and they remain the fallback here. What the registry cannot
 * ship is a translation: it is a plain data module outside Lingui's extraction
 * root (`lingui.config.ts` includes `ui/src` only), so every word it handed the
 * Preferences screen arrived in English next to `<Trans>`-wrapped chrome.
 *
 * So this is a translation layer, NOT a second source of truth: each entry maps
 * a registry key to a Lingui message whose SOURCE TEXT is the registry's own
 * English wording, which keeps the two in step and lets `lingui extract` see the
 * strings. Anything absent from these maps falls through to the registry text
 * unchanged, so the failure mode for a newly added preference is "still
 * English", never a wrong word.
 *
 * Keyed by PrefKey / category id rather than by the English string, so two
 * preferences that happen to share a word don't share a translation.
 */

/** Preferences-screen tab names. Keyed by `PrefInfo.category`. */
const CATEGORY_LABELS: Record<string, MessageDescriptor> = {
  general: msg`General`,
  terminal: msg`Terminal`,
  notifications: msg`Notifications`,
  advanced: msg`Advanced`,
  auto_index: msg`Auto Index`,
  i18n: msg`I18n`,
  ui: msg`Ui`,
  chat: msg`Chat`,
  errors: msg`Errors`,
  debug: msg`Debug`,
  onboarding: msg`Onboarding`,
};

/** Row titles. Keyed by the dotted `PrefKey`. */
const PREF_LABELS: Partial<Record<PrefKey, MessageDescriptor>> = {
  [PrefKey.SHOW_SYSTEM_SKILLS]: msg`Show system skills`,
  [PrefKey.DEFAULT_TERMINAL]: msg`External terminal`,
  [PrefKey.BUFFER_SYNC_UPDATES]: msg`Buffer terminal sync updates`,
  [PrefKey.SOUND_ENABLED]: msg`Play a sound when an agent is waiting for me`,
  [PrefKey.SOUND_KEY]: msg`Sound`,
  [PrefKey.SHARE_MESSAGE_STATUS]: msg`Share message status`,
  [PrefKey.SCROLLBACK_LINES]: msg`Terminal scrollback lines`,
  [PrefKey.EXPERIMENTAL_FLAGS]: msg`Experimental flags`,
  [PrefKey.INDEXER_BACKEND]: msg`Indexer backend`,
  [PrefKey.AUTO_INDEX_ENABLED]: msg`Index project on selection`,
  [PrefKey.AUTO_INDEX_TYPE]: msg`Index depth`,
  [PrefKey.AUTO_INDEX_TRIGGER]: msg`Index when`,
  [PrefKey.AUTO_INDEX_FUNCTION]: msg`Run the walk in`,
  [PrefKey.LOCALE]: msg`Language`,
  [PrefKey.VIEW_MODE]: msg`View mode`,
  [PrefKey.SHOW_SYSTEM_PROJECTS]: msg`Show system projects`,
  [PrefKey.CHAT_SHOW_TOOLS]: msg`Show tool calls`,
  [PrefKey.ERROR_DEDUPLICATE]: msg`Deduplicate errors`,
  [PrefKey.SNIFFER_MAX_EVENTS]: msg`Max sniffer events`,
  [PrefKey.ONBOARDING_WELCOME]: msg`Regenerate onboarding assets on next start`,
};

/** Row help text. Keyed by the dotted `PrefKey`. */
const PREF_DESCRIPTIONS: Partial<Record<PrefKey, MessageDescriptor>> = {
  [PrefKey.SHOW_SYSTEM_SKILLS]: msg`Surface built-in system skills in the Assets browser.`,
  [PrefKey.DEFAULT_TERMINAL]: msg`The in-app terminal is always the primary shell. This controls whether a sidecar OS Terminal window is also opened.`,
  [PrefKey.BUFFER_SYNC_UPDATES]: msg`Buffer PTY writes between sync markers to prevent visible scroll jumps during TUI redraws.`,
  [PrefKey.SOUND_KEY]: msg`Plays each time an agentic process becomes ready for your input.`,
  [PrefKey.SHARE_MESSAGE_STATUS]: msg`Let other participants see when messages are delivered or read.`,
  [PrefKey.SCROLLBACK_LINES]: msg`How many lines of terminal output to retain in the scrollback buffer.`,
  [PrefKey.EXPERIMENTAL_FLAGS]: msg`Free-form JSON for experimental feature toggles. Invalid JSON is not saved.`,
  [PrefKey.INDEXER_BACKEND]: msg`Which engine runs filesystem indexing: the built-in Python FSIndexer, or the external Rust indexer (requires FLOWPAD_RS_INDEXER_BIN on the server; silently falls back to Python when unavailable). Takes effect on the next index run.`,
  [PrefKey.AUTO_INDEX_ENABLED]: msg`Index a project’s files when you open it, so its assets and search are ready without a manual index run.`,
  [PrefKey.AUTO_INDEX_TYPE]: msg`Fast re-reads only the files that changed since the last index. Full re-reads every file in the project.`,
  [PrefKey.AUTO_INDEX_TRIGGER]: msg`Project create indexes once, as the project is created. First selection indexes the first time you open a project. Every selection re-indexes on each switch into it — note that even a Fast run still walks the whole project, so this is the expensive option on large trees.`,
  [PrefKey.AUTO_INDEX_FUNCTION]: msg`Subprocess runs the file walk in a separate process, so a large or slow tree can’t stall the server (database writes stay in the server either way). Thread runs it in-process — lower startup cost, better for small projects. No effect when the Rust indexer backend is selected.`,
  [PrefKey.LOCALE]: msg`Interface language and text direction.`,
  [PrefKey.VIEW_MODE]: msg`Surface complexity: Vibe (simplest, creator), Standard (minimal), Advanced, or Dev.`,
  [PrefKey.SHOW_SYSTEM_PROJECTS]: msg`Include built-in system projects in the project picker.`,
  [PrefKey.CHAT_SHOW_TOOLS]: msg`Show tool calls, reasoning, and status chips in the chat transcript.`,
  [PrefKey.ERROR_DEDUPLICATE]: msg`Collapse repeated error records into a single row.`,
  [PrefKey.SNIFFER_MAX_EVENTS]: msg`How many hook-sniffer events to retain in the buffer.`,
  [PrefKey.ONBOARDING_WELCOME]: msg`When on, the server re-creates the Welcome bookmark + feed entry on the next start, then turns this off.`,
};

/**
 * Select-option labels, keyed `<PrefKey>:<option value>` so the same word under
 * two preferences can be translated differently.
 *
 * Deliberately partial. Engine and mode names that read as proper nouns in every
 * language — `Python (FSIndexer)`, `Rust (RSIndexer)`, and the view modes, whose
 * wording the footer View toggle also shows — are left to fall through to the
 * registry rather than translated in one place and not the other.
 */
const PREF_OPTION_LABELS: Record<string, MessageDescriptor> = {
  'preferences.general.default_terminal:builtin_xterm': msg`In-app only`,
  'preferences.general.default_terminal:external_terminal': msg`Also open sidecar OS Terminal`,
  'preferences.auto_index.index_type:fast': msg`Fast`,
  'preferences.auto_index.index_type:full': msg`Full`,
  'preferences.auto_index.index_trigger:project_create': msg`Project create`,
  'preferences.auto_index.index_trigger:first_selection': msg`First selection`,
  'preferences.auto_index.index_trigger:every_selection': msg`Every selection`,
  'preferences.auto_index.index_function:subprocess': msg`Subprocess`,
  'preferences.auto_index.index_function:thread': msg`Thread`,
};

/** Translate a Preferences tab name, falling back to the humanized category id. */
export function translatePrefCategory(category: string, fallback: string): string {
  const descriptor = CATEGORY_LABELS[category];
  return descriptor ? i18n._(descriptor) : fallback;
}

/** Translate a preference's row title, falling back to the registry's English. */
export function translatePrefLabel(key: string, fallback: string): string {
  const descriptor = PREF_LABELS[key as PrefKey];
  return descriptor ? i18n._(descriptor) : fallback;
}

/** Translate a preference's help text; `undefined` in ⇒ `undefined` out. */
export function translatePrefDescription(key: string, fallback?: string): string | undefined {
  const descriptor = PREF_DESCRIPTIONS[key as PrefKey];
  return descriptor ? i18n._(descriptor) : fallback;
}

/** Translate one select option's label, falling back to the registry's English. */
export function translatePrefOptionLabel(key: string, value: string, fallback: string): string {
  const descriptor = PREF_OPTION_LABELS[`${key}:${value}`];
  return descriptor ? i18n._(descriptor) : fallback;
}
