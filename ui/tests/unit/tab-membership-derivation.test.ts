/**
 * Phase-0 characterization: locks the current wire→tab MAPPING in
 * `useActiveTerminals` (`toShellTab` / `toProcessTab`) before the TabManager
 * refactor. The server decides MEMBERSHIP (pure_shells ∪ visible_processes,
 * see tests/unit/test_terminal_list_membership.py); the frontend just maps each
 * wire row to a `TerminalTab`. These assertions lock that mapping.
 *
 * Cache is empty here (random UUIDs never collide with cached entities), so all
 * values derive from the wire row, not from `getByIdFromCache`.
 */
import { describe, expect, it } from 'vitest';
import { AgenticProcess, Shell, ShellStatus, TypeId } from '@sdk';
import { toProcessTab, toShellTab } from '@src/hooks/useActiveTerminals';

describe('toShellTab', () => {
  it('maps a running shell wire row to a plain tab', () => {
    const tab = toShellTab({ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'running', tab_order: 2, project_id: 'proj-1', name: 'My Shell' });
    expect(tab.type).toBe('plain');
    expect(tab.processId).toBeNull();
    expect(tab.tabOrder).toBe(2);
    expect(tab.projectId).toBe('proj-1');
    expect(tab.name).toBe('My Shell');
    expect(tab.isDisabled).toBe(false);
    expect(tab.targetTypeId.toString()).toBe(new TypeId(Shell.type, 'aaaaaaaa-0000-4000-8000-000000000001').toString());
  });

  it('marks a CLOSING shell as disabled with a "Closing..." reason', () => {
    const tab = toShellTab({ id: 'aaaaaaaa-0000-4000-8000-000000000002', status: ShellStatus.CLOSING });
    expect(tab.isDisabled).toBe(true);
    expect(tab.statusReason).toBe('Closing...');
  });
});

describe('toProcessTab', () => {
  it('maps a visible process wire row to a claude tab keyed by the process id', () => {
    const tab = toProcessTab({ id: 'bbbbbbbb-0000-4000-8000-000000000001', shell_id: 'cccccccc-0000-4000-8000-000000000001', project_id: 'proj-2', name: 'Agent' });
    expect(tab.type).toBe('claude');
    expect(tab.processId).toBe('bbbbbbbb-0000-4000-8000-000000000001');
    expect(tab.name).toBe('Agent');
    expect(tab.projectId).toBe('proj-2');
    // tab identity is the AgenticProcess, NOT its transport shell
    expect(tab.targetTypeId.toString()).toBe(new TypeId(AgenticProcess.type, 'bbbbbbbb-0000-4000-8000-000000000001').toString());
    expect(tab.shellId).toBe('cccccccc-0000-4000-8000-000000000001');
  });
});
