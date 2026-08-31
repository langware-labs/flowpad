import { afterEach, describe, expect, it } from 'vitest';
import {
  readDraft,
  resetComposerDrafts,
  writeDraft,
} from '@src/components/entity-execution-panel/composer-drafts';

const KEY = (scope: string) => `flowpad.composer.draft.${scope}`;

describe('composer drafts', () => {
  afterEach(() => {
    resetComposerDrafts();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('round-trips a draft per scope', () => {
    writeDraft('chat-a', 'hello');
    writeDraft('chat-b', 'goodbye');
    expect(readDraft('chat-a')).toBe('hello');
    expect(readDraft('chat-b')).toBe('goodbye');
  });

  it('lands in sessionStorage, so it outlives the heap a reload discards', () => {
    writeDraft('chat-a', 'survives F5');
    // Read straight out of storage: a module-scope Map would prove nothing,
    // since a reload takes the module with it.
    expect(sessionStorage.getItem(KEY('chat-a'))).toBe('survives F5');
    // sessionStorage, NOT localStorage — a draft must not outlive the window
    // it was typed into.
    expect(localStorage.getItem(KEY('chat-a'))).toBeNull();
  });

  it('an unknown scope reads empty rather than undefined', () => {
    expect(readDraft('never-typed-in')).toBe('');
  });

  it('an empty draft is dropped, not stored', () => {
    writeDraft('chat-a', 'hello');
    writeDraft('chat-a', '');
    expect(readDraft('chat-a')).toBe('');
    expect(sessionStorage.getItem(KEY('chat-a'))).toBeNull();
  });

  it('an absent scope is inert in both directions', () => {
    // Guards the shared-draft failure mode: a composer with no identity must
    // not read or write anyone else's text.
    writeDraft(undefined, 'orphan');
    expect(readDraft(undefined)).toBe('');
    expect(readDraft('')).toBe('');
  });

  it('reset clears our keys and leaves everyone else alone', () => {
    writeDraft('chat-a', 'hello');
    writeDraft('chat-b', 'goodbye');
    sessionStorage.setItem('flowpad.journey.dismissed', '1');

    resetComposerDrafts();

    expect(readDraft('chat-a')).toBe('');
    expect(readDraft('chat-b')).toBe('');
    expect(sessionStorage.getItem('flowpad.journey.dismissed')).toBe('1');
  });
});
