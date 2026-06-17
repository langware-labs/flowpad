/**
 * DockPointer.tabHash — the single knob that decides which pointers collapse to
 * the same content-panel Tab (docs/tab-management.md). The backend stores this
 * string verbatim as Tab.pointer (the natural key), so its stability + the
 * exclusions below are load-bearing.
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { Layout } from '@sdk';
import { describe, expect, it } from 'vitest';

describe('DockPointer.tabHash', () => {
  it('is stable for the same viewType + pointer', () => {
    const a = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-1');
    const b = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-1');
    expect(a.tabHash).toBe(b.tabHash);
  });

  it('differs when viewType or pointer differ', () => {
    const assets = new DockPointer(ViewType.ASSETS).tabHash;
    const shell = new DockPointer(ViewType.SHELL, 'shell-1').tabHash;
    const doc1 = new DockPointer(ViewType.ASSETS, 'doc-1').tabHash;
    const doc2 = new DockPointer(ViewType.ASSETS, 'doc-2').tabHash;
    expect(assets).not.toBe(shell);
    expect(doc1).not.toBe(doc2);
  });

  it('is null for surfaces that are not tabs (no chip)', () => {
    // A bare shell is the terminal HOST — its sessions are the tabs, not it.
    expect(new DockPointer(ViewType.SHELL).tabHash).toBeNull();
    // Home is an app landing, never a strip chip.
    expect(new DockPointer(ViewType.HOME, 'summary').tabHash).toBeNull();
    // A missing viewType has no tab.
    expect(new DockPointer(undefined, 'x').tabHash).toBeNull();
  });

  it('a shell WITH a session is a tab (the session is the identity)', () => {
    expect(new DockPointer(ViewType.SHELL, 'agentic_process-1').tabHash).toBe('shell|agentic_process-1');
  });

  it('excludes layout — a /win popout and the /dock view are ONE tab', () => {
    const dock = new DockPointer(ViewType.ASSETS, 'doc-1', {}, Layout.DOCK);
    const win = new DockPointer(ViewType.ASSETS, 'doc-1', {}, Layout.WIN);
    expect(dock.tabHash).toBe(win.tabHash);
  });

  it('excludes transient options (query params / slot)', () => {
    const plain = new DockPointer(ViewType.SEARCH, 'q').tabHash;
    const withOpts = new DockPointer(ViewType.SEARCH, 'q', { slot: 'activeView', x: '1' }).tabHash;
    expect(plain).toBe(withOpts);
  });

  it('round-trips through the strip split: `viewType|pointer`', () => {
    const p = new DockPointer(ViewType.ASSETS, 'editor/markdown/typeid/markdown-1');
    const hash = p.tabHash;
    const i = hash.indexOf('|');
    expect(hash.slice(0, i)).toBe(ViewType.ASSETS);
    expect(hash.slice(i + 1)).toBe('editor/markdown/typeid/markdown-1');
  });
});
