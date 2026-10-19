/**
 * `terminalTabsForScope` — the SDK scope projection for the terminal strip +
 * body. Each tab belongs to EXACTLY one scope: `'project'` shows only the active
 * project's terminals (projectless terminals no longer bleed in — they live in
 * the Global scope, `projectId === null`); `'all'` shows every project's
 * terminals (the developer sessions view). Only terminal target types
 * (shell / agentic_process) are kept; content tabs are dropped.
 */
import { describe, expect, it } from 'vitest';
import { Tab } from '@sdk';
import { terminalTabsForScope } from '@sdk/tabs';

let tabIdCounter = 0;

function nextTabId(): string {
  tabIdCounter += 1;
  return `20000000-0000-4000-8000-${String(tabIdCounter).padStart(12, '0')}`;
}

function row(name: string, target_type: string, project_id: string | null): Tab {
  const tab = new Tab({
    id: nextTabId(),
    pointer: `shell|${target_type}-${name}`,
    target_type,
    target_id: name,
    visible: true,
  });
  Object.assign(tab, {
    project_id,
    name,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
  });
  return tab;
}

const rows: Tab[] = [
  row('shellA', 'shell', 'projA'),
  row('procA', 'agentic_process', 'projA'),
  row('shellB', 'shell', 'projB'),
  row('shellFree', 'shell', null), // projectless terminal
  row('mdA', 'markdown', 'projA'), // content tab — never a terminal row
];

describe('terminalTabsForScope', () => {
  it("scope='project' keeps ONLY the project's terminals — projectless are excluded (no bleed)", () => {
    const names = terminalTabsForScope(rows, 'project', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA']);
    expect(names).not.toContain('shellFree'); // projectless lives in the Global scope only
    expect(names).not.toContain('shellB'); // other project excluded
    expect(names).not.toContain('mdA'); // content tab dropped
  });

  it("scope='project' with null projectId is the Global scope — ONLY projectless terminals", () => {
    const names = terminalTabsForScope(rows, 'project', null).map((r) => r.name);
    expect(names).toEqual(['shellFree']);
  });

  it("scope='all' keeps every project's terminals", () => {
    const names = terminalTabsForScope(rows, 'all', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA', 'shellB', 'shellFree']);
    expect(names).not.toContain('mdA');
  });

  it('only terminal target types are kept', () => {
    expect(terminalTabsForScope([row('x', 'markdown', 'projA')], 'all', 'projA')).toEqual([]);
  });

  it('deduplicates repeated dock keys while preserving backend order', () => {
    const duplicate = row('duplicate', 'shell', 'projA');
    duplicate.pointer = rows[0].pointer;
    const names = terminalTabsForScope([rows[0], duplicate, rows[1]], 'all', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA']);
  });
});
