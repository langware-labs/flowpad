/**
 * `terminalRowsForScope` (useTabs.ts) — the scope filter for the terminal strip +
 * body. Each tab belongs to EXACTLY one scope: `'project'` shows only the active
 * project's terminals (projectless terminals no longer bleed in — they live in
 * the Global scope, `projectId === null`); `'all'` shows every project's
 * terminals (the developer sessions view). Only terminal target types
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
  it("scope='project' keeps ONLY the project's terminals — projectless are excluded (no bleed)", () => {
    const names = terminalRowsForScope(rows, 'project', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA']);
    expect(names).not.toContain('shellFree'); // projectless lives in the Global scope only
    expect(names).not.toContain('shellB'); // other project excluded
    expect(names).not.toContain('mdA'); // content tab dropped
  });

  it("scope='project' with null projectId is the Global scope — ONLY projectless terminals", () => {
    const names = terminalRowsForScope(rows, 'project', null).map((r) => r.name);
    expect(names).toEqual(['shellFree']);
  });

  it("scope='all' keeps every project's terminals", () => {
    const names = terminalRowsForScope(rows, 'all', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA', 'shellB', 'shellFree']);
    expect(names).not.toContain('mdA');
  });

  it('only terminal target types are kept', () => {
    expect(terminalRowsForScope([row('x', 'markdown', 'projA')], 'all', 'projA')).toEqual([]);
  });

  it('deduplicates repeated dock keys while preserving backend order', () => {
    const duplicate = {
      ...row('shellA', 'shell', 'projA'),
      id: 'tab-shellA-duplicate',
      name: 'duplicate',
    };
    const names = terminalRowsForScope([rows[0], duplicate, rows[1]], 'all', 'projA').map((r) => r.name);
    expect(names).toEqual(['shellA', 'procA']);
  });
});
