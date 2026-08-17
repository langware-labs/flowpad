/**
 * Unified-strip partition: workspace CHILDREN (`parent_tab_id` set — content
 * tabs a vibe workspace opened) never render as top-level chips. They live in
 * their workspace's child strip only, so vibe and standard mode never mix
 * chips. The parent (process) tab itself stays.
 */
import { describe, expect, it } from 'vitest';
import { Tab } from '@sdk';
import { topLevelTabsForProject } from '@sdk/tabs';

const AP = '5e11aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(id: string, overrides: Partial<Tab> = {}): Tab {
  const tab = new Tab({
    id,
    pointer: `{"viewType": "shell", "pointer": "shell-${id}"}`,
    target_type: 'shell',
    target_id: id,
    visible: true,
  });
  Object.assign(tab, {
    project_id: null,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
    parent_tab_id: null,
    ...overrides,
  });
  return tab;
}

describe('topLevelTabsForProject partition', () => {
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
    const ids = topLevelTabsForProject([processTab, child, plain], null).map((tab) => tab.id);
    expect(ids).toContain(processTab.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(child.id);
  });
});
