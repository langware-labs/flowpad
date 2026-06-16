/**
 * Locks the `Tab` → `TerminalTab` MAPPING (`terminalTabFromTab` in useTabs.ts).
 * The strip renders from the `Tab` entity ALONE — no Shell/AgenticProcess scan —
 * so every chip value (name, icon, worktree, ordering, identity) must derive
 * from the Tab row. The cache is empty here (random UUIDs never collide with a
 * cached entity), proving a chip renders with zero entity hydration.
 */
import { describe, expect, it } from 'vitest';
import { AgenticProcess, Shell, Tab, TypeId } from '@sdk';
import { terminalTabFromTab } from '@src/tabs/useTabs';

describe('terminalTabFromTab — shell target', () => {
  it('maps a shell Tab row to a plain chip, icon/name/order from the Tab', () => {
    const row = terminalTabFromTab(
      new Tab({
        target_type: Shell.type,
        target_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'My Shell',
        icon_key: 'shell',
        tab_order: 2,
        project_id: 'proj-1',
        visible: true,
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.type).toBe('plain');
    expect(row!.icon).toBe('shell');
    expect(row!.processId).toBeNull();
    expect(row!.tabOrder).toBe(2);
    expect(row!.projectId).toBe('proj-1');
    expect(row!.name).toBe('My Shell');
    expect(row!.isDisabled).toBe(false);
    expect(row!.targetTypeId.toString()).toBe(
      new TypeId(Shell.type, 'aaaaaaaa-0000-4000-8000-000000000001').toString(),
    );
  });
});

describe('terminalTabFromTab — process target', () => {
  it('renders a codex chip with worktree badge from the Tab, no entity in cache', () => {
    const row = terminalTabFromTab(
      new Tab({
        target_type: AgenticProcess.type,
        target_id: 'bbbbbbbb-0000-4000-8000-000000000001',
        name: 'Agent',
        icon_key: 'codex',
        worktree: true,
        project_id: 'proj-2',
        visible: true,
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.type).toBe('claude'); // process-backed discriminator
    expect(row!.icon).toBe('codex'); // provider glyph from the Tab
    expect(row!.worktree).toBe(true); // worktree badge from the Tab
    expect(row!.processId).toBe('bbbbbbbb-0000-4000-8000-000000000001');
    expect(row!.name).toBe('Agent');
    expect(row!.projectId).toBe('proj-2');
    // tab identity is the AgenticProcess, NOT a transport shell
    expect(row!.targetTypeId.toString()).toBe(
      new TypeId(AgenticProcess.type, 'bbbbbbbb-0000-4000-8000-000000000001').toString(),
    );
    // no cached process → transport shell id is empty (loader hydrates on open)
    expect(row!.shellId).toBe('');
  });

  it('defaults icon to claude when the Tab carries none and nothing is cached', () => {
    const row = terminalTabFromTab(
      new Tab({
        target_type: AgenticProcess.type,
        target_id: 'bbbbbbbb-0000-4000-8000-000000000002',
        name: 'Legacy',
        visible: true,
      }),
    );
    expect(row!.icon).toBe('claude');
    expect(row!.worktree).toBe(false);
  });

  it('drops a target-less Tab row', () => {
    const row = terminalTabFromTab(
      new Tab({ target_type: Shell.type, target_id: null, visible: true }),
    );
    expect(row).toBeNull();
  });
});
