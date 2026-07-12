/**
 * Unified-strip partition: workspace CHILDREN (`parent_tab_id` set — content
 * tabs a vibe workspace opened) never render as top-level chips. They live in
 * their workspace's child strip only, so vibe and standard mode never mix
 * chips. The parent (process) tab itself stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Tab, type ITab } from '@sdk';
import { applyAllTabs, getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { useCurrentTabs } from '@src/tabs/useTabs';

beforeEach(() => {
  // Unit tier has no backend: pin the store's one-time refresh to the seeded
  // snapshot; the filter under test runs over real Tab shapes.
  vi.spyOn(Tab, 'listAll').mockImplementation(async () => getAllTabsSnapshot());
});

afterEach(() => {
  applyAllTabs([]);
  vi.restoreAllMocks();
});

const AP = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(id: string, overrides: Partial<ITab> = {}): ITab {
  return {
    id,
    pointer: `{"viewType": "shell", "pointer": "shell-${id}"}`,
    target_type: 'shell',
    target_id: id,
    project_id: null,
    name: null,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
    visible: true,
    parent_tab_id: null,
    ...overrides,
  };
}

describe('useCurrentTabs partition', () => {
  it('excludes workspace children; keeps the parent process tab and plain tabs', () => {
    const processTab = row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      pointer: `{"viewType": "shell", "pointer": "agentic_process-${AP}"}`,
      target_type: 'agentic_process',
      target_id: AP,
    });
    const child = row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      pointer: '{"viewType": "editor", "pointer": "markdown-child"}',
      target_type: 'markdown',
      target_id: 'md-child',
      parent_tab_id: processTab.id,
    });
    const plain = row('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    applyAllTabs([processTab, child, plain]);

    const { result } = renderHook(() => useCurrentTabs());
    const ids = result.current.map((t) => t.id);
    expect(ids).toContain(processTab.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(child.id);
  });
});
