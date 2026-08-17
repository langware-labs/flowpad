/**
 * A `shell` display target addresses a terminal — it is never display CONTENT.
 *
 * Every other `flow show` kind resolves to something the display pane mounts.
 * A terminal is hosted as a workspace child tab instead (the same mechanism a
 * guided journey's terminal uses), so the show target must route to a dock
 * navigation and must never become the pinned `shown` payload.
 */

import { describe, expect, it, vi } from 'vitest';
import { shellIdFromShowTarget } from '@src/navigation/shell-show-target';
import { openDisplayTarget } from '@src/navigation/open-display-target';
import type { NavigationActions } from '@src/navigation';

const SHELL_ID = '39f71bb2-a275-417b-b10c-65c1438ae415';

describe('shellIdFromShowTarget', () => {
  it('extracts the id from a shell target', () => {
    expect(shellIdFromShowTarget({ kind: 'shell', type: 'shell', id: SHELL_ID })).toBe(SHELL_ID);
  });

  it.each([
    ['an entity target', { kind: 'entity', type: 'markdown', id: SHELL_ID }],
    ['a vfs target', { kind: 'vfs' }],
    ['a webapp target', { kind: 'webapp' }],
    ['an app target', { kind: 'app', id: SHELL_ID }],
    ['null', null],
    ['undefined', undefined],
  ])('is null for %s', (_label, target) => {
    expect(shellIdFromShowTarget(target)).toBeNull();
  });

  it('is null for a shell target with no id', () => {
    expect(shellIdFromShowTarget({ kind: 'shell', id: '   ' })).toBeNull();
  });
});

describe('openDisplayTarget', () => {
  function navStub() {
    return {
      openShell: vi.fn().mockResolvedValue(null),
      openWebApp: vi.fn(),
      openDock: vi.fn(),
      openFile: vi.fn(),
      openShellProcess: vi.fn(),
    } as unknown as NavigationActions & { openShell: ReturnType<typeof vi.fn> };
  }

  it('opens a shell target as its own dock, in vibe', () => {
    const nav = navStub();
    openDisplayTarget({ kind: 'shell', type: 'shell', id: SHELL_ID }, nav);

    expect(nav.openShell).toHaveBeenCalledWith(SHELL_ID, { viewMode: 'vibe' });
    // Not routed to an editor — `editorForType('shell')` is undefined, which is
    // exactly the dead end this kind exists to avoid.
    expect((nav as unknown as { openDock: ReturnType<typeof vi.fn> }).openDock).not.toHaveBeenCalled();
  });

  it('still routes a webapp target to the port preview', () => {
    const nav = navStub();
    openDisplayTarget({ kind: 'webapp', port: 3000 }, nav);

    expect((nav as unknown as { openWebApp: ReturnType<typeof vi.fn> }).openWebApp).toHaveBeenCalledWith('3000');
    expect(nav.openShell).not.toHaveBeenCalled();
  });
});
