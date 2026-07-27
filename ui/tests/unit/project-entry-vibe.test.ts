import { AgenticProcess, Shell, Tab, type TabRow } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { agenticProcessIdForProjectEntry } from '@src/tabs/project-entry';
import { applyAllTabs } from '@src/tabs/all-tabs-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROC_OLD = '11111111-1111-4111-8111-111111111111';
const PROC_NEW = '22222222-2222-4222-8222-222222222222';
const PROC_DISABLED = '33333333-3333-4333-8333-333333333333';
const PROC_OTHER = '44444444-4444-4444-8444-444444444444';
const SHELL_ID = '55555555-5555-4555-8555-555555555555';
const TAB_1 = '90000000-0000-4000-8000-000000000001';
const TAB_2 = '90000000-0000-4000-8000-000000000002';
const TAB_3 = '90000000-0000-4000-8000-000000000003';
const TAB_4 = '90000000-0000-4000-8000-000000000004';
const TAB_5 = '90000000-0000-4000-8000-000000000005';
const TAB_6 = '90000000-0000-4000-8000-000000000006';
const TAB_7 = '90000000-0000-4000-8000-000000000007';

function row(overrides: Partial<TabRow>): TabRow {
  const targetType = overrides.target_type ?? AgenticProcess.type;
  const targetId = overrides.target_id ?? PROC_OLD;
  return {
    id: overrides.id ?? TAB_1,
    pointer:
      overrides.pointer ??
      DockPointer.forShell(`${targetType}-${targetId}`).toJSON() ??
      '',
    target_type: targetType,
    target_id: targetId,
    parent_tab_id: null,
    project_id: overrides.project_id ?? PROJECT_A,
    name: null,
    icon_key: null,
    worktree: false,
    tab_order: overrides.tab_order ?? 0,
    last_active_at: overrides.last_active_at ?? 0,
    status: null,
    is_disabled: overrides.is_disabled ?? false,
    ...overrides,
  };
}

describe('Vibe project entry resolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    applyAllTabs([]);
  });

  it('returns the active AgenticProcess tab for the destination project only', async () => {
    vi.spyOn(Tab, 'listAll').mockResolvedValue([
      new Tab(row({ id: TAB_1, target_id: PROC_OLD, project_id: PROJECT_A, last_active_at: 100 })),
      new Tab(row({ id: TAB_2, target_id: PROC_NEW, project_id: PROJECT_A, last_active_at: 200 })),
      new Tab(row({ id: TAB_3, target_id: PROC_DISABLED, project_id: PROJECT_A, last_active_at: 999, is_disabled: true })),
      new Tab(row({ id: TAB_4, target_type: Shell.type, target_id: SHELL_ID, project_id: PROJECT_A, last_active_at: 500 })),
      new Tab(row({ id: TAB_5, target_id: PROC_OTHER, project_id: PROJECT_B, last_active_at: 700 })),
    ]);

    await expect(agenticProcessIdForProjectEntry(PROJECT_A)).resolves.toBe(PROC_NEW);
  });

  it('returns null when the project has no AgenticProcess tab', async () => {
    vi.spyOn(Tab, 'listAll').mockResolvedValue([
      new Tab(row({ id: TAB_6, target_type: Shell.type, target_id: SHELL_ID, project_id: PROJECT_A, last_active_at: 500 })),
      new Tab(row({ id: TAB_7, target_id: PROC_OTHER, project_id: PROJECT_B, last_active_at: 700 })),
    ]);

    await expect(agenticProcessIdForProjectEntry(PROJECT_A)).resolves.toBeNull();
  });
});
