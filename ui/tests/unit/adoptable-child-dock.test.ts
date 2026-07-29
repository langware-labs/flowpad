/**
 * isAdoptableChildDock — the workspace-child allow-list.
 *
 * A vibe workspace groups what it opens under its process tab
 * (`Tab.parent_tab_id`). Content assets/files qualify, and so does a PLAIN
 * terminal: a shell opened from inside the workspace is content in its display.
 * What must never qualify is a workspace ANCHOR — the process's own dock shares
 * `ViewType.SHELL` with a terminal and is told apart only by its pointer, which
 * is exactly the distinction this suite pins. The backend mirrors it in
 * `_pointer_is_adoptable_child` (flow_sdk/builtin/tab.py).
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  isAdoptableChildDock,
  isPlainShellDock,
} from '@src/navigation/adoptable-child-dock';
import { ViewType } from '@src/types/ViewType';

const ID = '30c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const shellDock = (pointer: string) => new DockPointer(ViewType.SHELL, pointer);

describe('isPlainShellDock', () => {
  it.each([
    ['a shell- prefixed terminal', `shell-${ID}`, true],
    ['a bare-id terminal pointer', ID, true],
    ['the process anchor dock', `agentic_process-${ID}`, false],
    ['the new-terminal launcher landing', 'new_terminal', false],
    ['an empty pointer', '', false],
    ['a whitespace-only pointer', '   ', false],
  ])('%s → %s', (_label, pointer, expected) => {
    expect(isPlainShellDock(shellDock(pointer))).toBe(expected);
  });

  it('is false for every non-shell view type', () => {
    expect(isPlainShellDock(new DockPointer(ViewType.PROJECT, ID))).toBe(false);
    expect(isPlainShellDock(new DockPointer(ViewType.ASSETS, 'project-home'))).toBe(false);
    expect(isPlainShellDock(DockPointer.forFile('/project/src/main.ts'))).toBe(false);
  });
});

describe('isAdoptableChildDock', () => {
  it('adopts a plain terminal — the change this suite exists for', () => {
    expect(isAdoptableChildDock(shellDock(`shell-${ID}`))).toBe(true);
  });

  it('still adopts content assets and raw files', () => {
    const asset = new DockPointer(ViewType.ASSETS, `editor/markdown/typeid/markdown-${ID}`);
    expect(isAdoptableChildDock(asset)).toBe(true);
    expect(isAdoptableChildDock(DockPointer.forFile('/project/src/main.ts'))).toBe(true);
  });

  it('never adopts a workspace anchor or a navigation surface', () => {
    // The process dock is the anchor the workspace is mounted OVER; adopting it
    // nests a workspace inside itself (the shell-under-display corruption).
    expect(isAdoptableChildDock(shellDock(`agentic_process-${ID}`))).toBe(false);
    expect(isAdoptableChildDock(new DockPointer(ViewType.PROJECT, ID))).toBe(false);
    expect(isAdoptableChildDock(new DockPointer(ViewType.ASSETS, 'project-home'))).toBe(false);
  });
});
