/**
 * Index-folder consent event contract — the frontend half of the macOS-TCC /
 * cross-OS special-folder gate.
 *
 * When a background scan finds a project inside a protected folder whose
 * consent state is still `ask`, the backend emits an `index_folder_consent`
 * event (see flow_sdk/fs_store/indexer/special_folders.py `consent_event`). The
 * UI parses it here and renders an Index / Skip prompt whose actions write the
 * matching `preferences.indexing.folders.<category>` pref. This module keeps the
 * event shape + category→PrefKey mapping in ONE place so the Python emitter and
 * the TS consumer can't drift.
 */
import { PrefKey } from './prefRegistry';

export const INDEX_FOLDER_CONSENT_KIND = 'index_folder_consent';

/** Tri-state (plus OS-refused terminal) persisted per folder. */
export type IndexFolderState = 'ask' | 'allow' | 'skip' | 'denied';

export interface IndexFolderConsentEvent {
  kind: typeof INDEX_FOLDER_CONSENT_KIND;
  /** Stable cross-OS category id. */
  category: string;
  /** Absolute path of the protected folder. */
  path: string;
  /** A sample project path found inside it (or null). */
  samplePath: string | null;
  /** Whether the OS itself shows a consent dialog on first read (macOS). */
  osPrompts: boolean;
}

/** Map a consent category to its PrefKey, or null for an unknown category. */
export function indexFolderPrefKey(category: string): PrefKey | null {
  switch (category) {
    case 'documents':
      return PrefKey.INDEX_FOLDER_DOCUMENTS;
    case 'desktop':
      return PrefKey.INDEX_FOLDER_DESKTOP;
    case 'downloads':
      return PrefKey.INDEX_FOLDER_DOWNLOADS;
    default:
      return null;
  }
}

/**
 * Parse a raw event/envelope-metadata object into an `IndexFolderConsentEvent`,
 * or null when it isn't a well-formed consent event for a known category.
 * Tolerates both snake_case (`sample_path`, `os_prompts`) from the Python
 * emitter and camelCase.
 */
export function parseIndexFolderConsent(raw: unknown): IndexFolderConsentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== INDEX_FOLDER_CONSENT_KIND) return null;
  const category = o.category;
  if (typeof category !== 'string' || indexFolderPrefKey(category) === null) return null;
  if (typeof o.path !== 'string' || o.path.length === 0) return null;
  const sample = (o.samplePath ?? o.sample_path ?? null) as unknown;
  return {
    kind: INDEX_FOLDER_CONSENT_KIND,
    category,
    path: o.path,
    samplePath: typeof sample === 'string' ? sample : null,
    osPrompts: Boolean(o.osPrompts ?? o.os_prompts ?? false),
  };
}

/** The pref value written when the user answers the consent prompt. */
export function consentAnswerToState(answer: 'index' | 'skip'): IndexFolderState {
  return answer === 'index' ? 'allow' : 'skip';
}
