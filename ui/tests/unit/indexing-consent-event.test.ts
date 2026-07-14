import {
  INDEX_FOLDER_CONSENT_KIND,
  PrefKey,
  consentAnswerToState,
  indexFolderPrefKey,
  parseIndexFolderConsent,
} from '@sdk';
import { describe, expect, it } from 'vitest';

/**
 * Contract test for the special-folder index-consent event — the frontend half
 * of the macOS-TCC / cross-OS indexing gate. The backend emits this event (from
 * flow_sdk/fs_store/indexer/special_folders.py `consent_event`) when a
 * background scan finds a project in a protected folder still set to `ask`; the
 * UI must reliably recognize it and map the category to the right PrefKey.
 */
describe('index_folder_consent event', () => {
  it('parses a well-formed backend (snake_case) event', () => {
    const raw = {
      kind: 'index_folder_consent',
      category: 'documents',
      path: '/Users/alice/Documents',
      sample_path: '/Users/alice/Documents/dev/flowpad-oss',
      os_prompts: true,
    };
    const ev = parseIndexFolderConsent(raw);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe(INDEX_FOLDER_CONSENT_KIND);
    expect(ev!.category).toBe('documents');
    expect(ev!.path).toBe('/Users/alice/Documents');
    expect(ev!.samplePath).toBe('/Users/alice/Documents/dev/flowpad-oss');
    expect(ev!.osPrompts).toBe(true);
  });

  it('maps every consent category to its PrefKey', () => {
    expect(indexFolderPrefKey('documents')).toBe(PrefKey.INDEX_FOLDER_DOCUMENTS);
    expect(indexFolderPrefKey('desktop')).toBe(PrefKey.INDEX_FOLDER_DESKTOP);
    expect(indexFolderPrefKey('downloads')).toBe(PrefKey.INDEX_FOLDER_DOWNLOADS);
  });

  it('rejects non-consent envelopes, unknown/media categories, and empty paths', () => {
    expect(parseIndexFolderConsent(null)).toBeNull();
    expect(parseIndexFolderConsent({ kind: 'something_else' })).toBeNull();
    // media is hard-skip on the backend — it must never produce a consent ask.
    expect(parseIndexFolderConsent({ kind: 'index_folder_consent', category: 'media', path: '/x' })).toBeNull();
    expect(parseIndexFolderConsent({ kind: 'index_folder_consent', category: 'documents', path: '' })).toBeNull();
    expect(indexFolderPrefKey('media')).toBeNull();
  });

  it('handles camelCase and missing optional fields', () => {
    const ev = parseIndexFolderConsent({
      kind: 'index_folder_consent',
      category: 'downloads',
      path: 'C:/Users/bob/Downloads',
      osPrompts: false,
    });
    expect(ev).not.toBeNull();
    expect(ev!.samplePath).toBeNull();
    expect(ev!.osPrompts).toBe(false);
  });

  it('answering the prompt maps to the right persisted state', () => {
    expect(consentAnswerToState('index')).toBe('allow');
    expect(consentAnswerToState('skip')).toBe('skip');
  });
});
