/**
 * A Vibe tab reopens on what was last on screen inside it: its Display, or the
 * sub-tab landed on most recently (read off `last_active_at`).
 */
import { describe, expect, it } from 'vitest';
import { Tab, type TabRow } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { resumeDock } from '@src/tabs/project-entry';

const PROC = 'agentic_process-22222222-2222-4222-8222-222222222222';
const HOST_ID = '90000000-0000-4000-8000-000000000001';
const FILE = '/tmp/readme.md';

function tab(overrides: Partial<TabRow>): Tab {
  return new Tab({
    id: '90000000-0000-4000-8000-000000000009',
    pointer: '',
    target_type: null,
    target_id: null,
    parent_tab_id: null,
    project_id: null,
    name: null,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
    visible: true,
    ...overrides,
  } as TabRow);
}

const host = (at: number) =>
  tab({ id: HOST_ID, pointer: new DockPointer(ViewType.VIBE, PROC).toJSON() ?? '', last_active_at: at });
const child = (at: number, visible = true) =>
  tab({
    id: '90000000-0000-4000-8000-000000000002',
    pointer: DockPointer.forFile(FILE).withHost(PROC).toJSON() ?? '',
    parent_tab_id: HOST_ID,
    last_active_at: at,
    visible,
  });

describe('resumeDock', () => {
  it('reopens the sub-tab landed on after the Display, inside its Vibe tab', () => {
    const h = host(100);
    const dock = resumeDock(h, [h, child(200)]);
    expect(dock?.viewType).toBe(ViewType.EDITOR);
    expect(dock?.hostProcessId).toBe(PROC);
  });

  it('reopens the Display when it was on screen last', () => {
    const h = host(300);
    expect(resumeDock(h, [h, child(200)])?.viewType).toBe(ViewType.VIBE);
  });

  it('ignores a closed sub-tab', () => {
    const h = host(100);
    expect(resumeDock(h, [h, child(200, false)])?.viewType).toBe(ViewType.VIBE);
  });

  it('leaves a non-Vibe tab as its own dock', () => {
    const t = tab({ pointer: DockPointer.forFile(FILE).toJSON() ?? '' });
    expect(resumeDock(t, [t])?.viewType).toBe(ViewType.EDITOR);
  });
});
