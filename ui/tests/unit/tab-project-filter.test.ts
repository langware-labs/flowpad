/**
 * `terminalRowsForScope` (useTabs.ts) — the scope filter for the terminal strip +
 * body. `'project'` shows the active project's terminals PLUS projectless ones
 * (the backend `filter_for_project` view, decision 3); `'all'` shows every
 * project's terminals (the developer sessions view). Only terminal target types
 * (shell / agentic_process) are kept; content tabs are dropped.
 */
import { describe, expect, it } from 'vitest';
import { type TabRow } from '@sdk';
import { terminalRowsForScope } from '@src/tabs/useTabs';

function row(name: string, target_type: string, project_id: string | null): TabRow {
  return {
    id: `tab-${name}`,
    pointer: `shell|${target_type}-${name}`,
    target_type,
    target_id: name,
    project_id,
    name,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
  };
}

const rows: TabRow[] = [
  row('shellA', 'shell', 'projA'),
  row('procA', 'agentic_process', 'projA'),
  row('shellB', 'shell', 'projB'),
  row('shellFree', 'shell', null), // projectless terminal
  row('mdA', 'markdown', 'projA'), // content tab — never a terminal row
];

describe('terminalRowsForScope', () => {
  it("scope='project' keeps the project's terminals + projectless, drops other projects", () => {
    const names = terminalRowsForScope(rows, 'project', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA', 'shellFree']);
    expect(names).not.toContain('shellB'); // other project excluded
    expect(names).not.toContain('mdA'); // content tab dropped
  });

  it("scope='all' keeps every project's terminals", () => {
    const names = terminalRowsForScope(rows, 'all', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA', 'shellB', 'shellFree']);
    expect(names).not.toContain('mdA');
  });

  it('only terminal target types are kept', () => {
    expect(terminalRowsForScope([row('x', 'markdown', 'projA')], 'all', 'projA')).toEqual([]);
  });
});
