/**
 * Dock-URL round-trip for the open-side-windows state.
 *
 * `sideWindowsToDockOptions` / `dockOptionsToSideWindows` are the single home
 * for the `sideWindows`/`activeSideWindow` grammar; `DockPointer.sideWindows` /
 * `withSideWindows` are the generic accessors both the terminal and the
 * markdown side panel use. These tests pin the round-trip, the clean-URL
 * default-active rule, and the "unspecified → null" contract — mirroring
 * scope-filter-dock-roundtrip.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  dockOptionsToSideWindows,
  sideWindowsToDockOptions,
  type SideWindowsState,
} from '@src/lib/side-windows';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const CASES: Array<[string, SideWindowsState]> = [
  ['single window', { windows: ['chat'], active: 'chat' }],
  ['two windows, last active', { windows: ['chat', 'backlinks'], active: 'backlinks' }],
  ['two windows, first active', { windows: ['chat', 'backlinks'], active: 'chat' }],
  ['three windows, middle active', { windows: ['git', 'prompts', 'files'], active: 'prompts' }],
];

describe('side windows ⇄ dock options round-trip', () => {
  it.each(CASES)('round-trips %s', (_label, state) => {
    const opts = sideWindowsToDockOptions(state);
    const back = dockOptionsToSideWindows(opts);
    expect(back).not.toBeNull();
    expect(back!.windows).toEqual(state.windows);
    // active resolves to last-in-list when not explicitly stamped.
    const resolved = back!.active ?? back!.windows[back!.windows.length - 1] ?? null;
    expect(resolved).toBe(state.active);
  });

  it('omits activeSideWindow when active is the natural last-in-list default', () => {
    const opts = sideWindowsToDockOptions({ windows: ['chat', 'backlinks'], active: 'backlinks' });
    expect(opts.sideWindows).toBe('chat,backlinks');
    expect(opts.activeSideWindow).toBeUndefined();
  });

  it('stamps activeSideWindow only when it differs from the default', () => {
    const opts = sideWindowsToDockOptions({ windows: ['chat', 'backlinks'], active: 'chat' });
    expect(opts.activeSideWindow).toBe('chat');
  });

  it('dedupes and trims the window list', () => {
    const back = dockOptionsToSideWindows({ sideWindows: ' chat , chat ,backlinks' });
    expect(back!.windows).toEqual(['chat', 'backlinks']);
  });

  it('drops an active id that is not in the window list', () => {
    const back = dockOptionsToSideWindows({ sideWindows: 'chat', activeSideWindow: 'ghost' });
    expect(back!.active).toBeNull();
  });

  it('returns null when no side-window keys are present', () => {
    expect(dockOptionsToSideWindows(undefined)).toBeNull();
    expect(dockOptionsToSideWindows({})).toBeNull();
    expect(dockOptionsToSideWindows({ editorMode: 'editor' })).toBeNull();
  });
});

describe('DockPointer side-windows facility', () => {
  it('round-trips through withSideWindows / sideWindows', () => {
    const state: SideWindowsState = { windows: ['chat', 'backlinks'], active: 'chat' };
    const dp = new DockPointer(ViewType.ASSETS, 'editor/x').withSideWindows(state);
    expect(dp.sideWindows?.windows).toEqual(state.windows);
    expect(dp.sideWindows?.active).toBe('chat');
  });

  it('a bare pointer has no side windows', () => {
    expect(new DockPointer(ViewType.ASSETS, 'editor/x').sideWindows).toBeNull();
  });

  it('replaces stale side-window keys instead of accumulating them', () => {
    const dp = new DockPointer(ViewType.ASSETS, 'editor/x')
      .withSideWindows({ windows: ['chat', 'backlinks'], active: 'chat' })
      .withSideWindows({ windows: ['runs'], active: 'runs' });
    expect(dp.sideWindows?.windows).toEqual(['runs']);
    expect(dp.options?.activeSideWindow).toBeUndefined(); // runs is last-in-list → not stamped
  });

  it('preserves non-side-window options', () => {
    const base = new DockPointer(ViewType.ASSETS, 'editor/x', { editorMode: 'review' });
    const dp = base.withSideWindows({ windows: ['chat'], active: 'chat' });
    expect(dp.options?.editorMode).toBe('review');
  });

  it('survives a URL serialize → parse cycle', () => {
    const state: SideWindowsState = { windows: ['git', 'prompts'], active: 'git' };
    const dp = new DockPointer(ViewType.SESSION, 'agentic_process-abc').withSideWindows(state);
    const parsed = DockPointer.fromUrl(dp.toUrl());
    expect(parsed.sideWindows?.windows).toEqual(state.windows);
    expect(parsed.sideWindows?.active).toBe('git');
  });
});
