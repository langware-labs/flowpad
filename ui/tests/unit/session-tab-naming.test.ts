import { describe, expect, it } from 'vitest';
import { filterClosedTabs, getNextSessionNumber, mergeSessionTabs } from '@src/components/live-workflow/sessionTabUtils';

describe('getNextSessionNumber', () => {
  it('returns 1 for empty tabs', () => {
    expect(getNextSessionNumber([])).toBe(1);
  });

  it('returns 2 when one "Session 1" tab exists', () => {
    const tabs = [{ id: 'a', name: 'Session 1' }];
    expect(getNextSessionNumber(tabs)).toBe(2);
  });

  it('returns 4 when sessions 1-3 exist', () => {
    const tabs = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
      { id: 'c', name: 'Session 3' },
    ];
    expect(getNextSessionNumber(tabs)).toBe(4);
  });

  // FLOWPAD-1645: session renamed via instruction_content should still count
  it('returns 2 when one tab exists with a non-session name (e.g. "hi")', () => {
    const tabs = [{ id: 'a', name: 'hi' }];
    expect(getNextSessionNumber(tabs)).toBe(2);
  });

  it('returns 3 when two tabs exist but neither has a Session-N name', () => {
    const tabs = [
      { id: 'a', name: 'hi' },
      { id: 'b', name: 'fix the bug' },
    ];
    expect(getNextSessionNumber(tabs)).toBe(3);
  });

  it('returns max(parsed, count)+1 when mix of named and renamed tabs', () => {
    const tabs = [
      { id: 'a', name: 'hi' },
      { id: 'b', name: 'Session 1' },
    ];
    // 2 tabs, max parsed = 1 → max(1, 2) + 1 = 3
    expect(getNextSessionNumber(tabs)).toBe(3);
  });

  it('uses parsed number when it exceeds tab count', () => {
    const tabs = [{ id: 'a', name: 'Session 5' }];
    // 1 tab, max parsed = 5 → max(5, 1) + 1 = 6
    expect(getNextSessionNumber(tabs)).toBe(6);
  });

  it('handles case-insensitive session names', () => {
    const tabs = [{ id: 'a', name: 'session 3' }];
    expect(getNextSessionNumber(tabs)).toBe(4);
  });

  it('skips tabs with empty names', () => {
    const tabs = [
      { id: 'a', name: '' },
      { id: 'b', name: 'Session 2' },
    ];
    // 2 tabs, max parsed = 2 → max(2, 2) + 1 = 3
    expect(getNextSessionNumber(tabs)).toBe(3);
  });
});

describe('mergeSessionTabs', () => {
  // FLOWPAD-1645: closing a tab must not rename surviving tabs
  it('preserves existing names when incoming tabs have shifted fallback names', () => {
    // Before close: 3 sessions, first was prompted with "hi"
    const prev = [
      { id: 'a', name: 'hi' },
      { id: 'b', name: 'Session 2' },
      { id: 'c', name: 'Session 3' },
    ];

    // After closing tab "a", the backend re-fetches remaining 2 processes.
    // Because they are now at index 0 and 1, the fallback names shift:
    //   b → "Session 1", c → "Session 2"
    const incoming = [
      { id: 'b', name: 'Session 1' },
      { id: 'c', name: 'Session 2' },
    ];

    const merged = mergeSessionTabs(prev, incoming);

    // Tab b and c must keep their original names
    expect(merged.get('b')!.name).toBe('Session 2');
    expect(merged.get('c')!.name).toBe('Session 3');
    // Closed tab "a" should still be in map (from prev) but won't appear in incoming
    expect(merged.get('a')!.name).toBe('hi');
  });

  it('allows real name updates (from instruction_content) to overwrite existing names', () => {
    const prev = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
    ];

    // User prompted "hello world" in session a — display name changes
    const incoming = [
      { id: 'a', name: 'hello world' },
      { id: 'b', name: 'Session 2' },
    ];

    const merged = mergeSessionTabs(prev, incoming);

    expect(merged.get('a')!.name).toBe('hello world');
    expect(merged.get('b')!.name).toBe('Session 2');
  });

  it('adds new tabs that are not in prev', () => {
    const prev = [{ id: 'a', name: 'Session 1' }];
    const incoming = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
    ];

    const merged = mergeSessionTabs(prev, incoming);

    expect(merged.size).toBe(2);
    expect(merged.get('b')!.name).toBe('Session 2');
  });

  it('updates favorite_index even when preserving name', () => {
    const prev = [{ id: 'a', name: 'Session 3', favorite_index: 1000 }];
    // Incoming has shifted fallback name but updated favorite_index
    const incoming = [{ id: 'a', name: 'Session 1', favorite_index: 2000 }];

    const merged = mergeSessionTabs(prev, incoming);

    expect(merged.get('a')!.name).toBe('Session 3'); // name preserved
    expect(merged.get('a')!.favorite_index).toBe(2000); // index updated
  });

  it('preserves custom-renamed tabs during re-fetch', () => {
    // User manually renamed tab b to "My Project"
    const prev = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'My Project' },
    ];

    // After close of another tab, b's fallback becomes "Session 1"
    const incoming = [{ id: 'b', name: 'Session 1' }];

    const merged = mergeSessionTabs(prev, incoming);

    expect(merged.get('b')!.name).toBe('My Project');
  });

  it('works with empty prev', () => {
    const incoming = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
    ];

    const merged = mergeSessionTabs([], incoming);

    expect(merged.size).toBe(2);
    expect(merged.get('a')!.name).toBe('Session 1');
    expect(merged.get('b')!.name).toBe('Session 2');
  });
});

describe('filterClosedTabs', () => {
  it('returns all tabs when closedIds is empty', () => {
    const tabs = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
    ];
    const result = filterClosedTabs(tabs, new Set());
    expect(result).toHaveLength(2);
  });

  it('filters out a single closed session', () => {
    const tabs = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
    ];
    const result = filterClosedTabs(tabs, new Set(['a']));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('filters out multiple closed sessions', () => {
    const tabs = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
      { id: 'c', name: 'Session 3' },
    ];
    const result = filterClosedTabs(tabs, new Set(['a', 'c']));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  // Regression: closed active session must not reappear after backend re-fetch
  it('closed session does not reappear when backend results are filtered before merge', () => {
    // 2 sessions open: A (active), B. User closes A.
    // After close, local tabs = [B]. Backend still returns [A, B].
    const localTabsAfterClose = [{ id: 'b', name: 'Session 2' }];
    const backendResults = [
      { id: 'a', name: 'Session 1' },
      { id: 'b', name: 'Session 2' },
    ];

    const filtered = filterClosedTabs(backendResults, new Set(['a']));
    const merged = mergeSessionTabs(localTabsAfterClose, filtered);

    expect(merged.has('a')).toBe(false);
    expect(merged.has('b')).toBe(true);
    expect(merged.size).toBe(1);
  });
});
