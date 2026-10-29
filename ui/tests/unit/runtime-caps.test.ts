/**
 * What each runtime can do. Desktop-only features gate on these facts, so every
 * runtime kind must be classified — a new kind with no row would silently get
 * the desktop's answers.
 */
import { describe, expect, it } from 'vitest';
import { RUNTIME_CAPS, RuntimeKind, runtimeCaps } from '@sdk';

describe('runtime capabilities', () => {
  it('classifies every runtime kind', () => {
    for (const kind of Object.values(RuntimeKind)) expect(RUNTIME_CAPS[kind], `no row for ${kind}`).toBeTruthy();
  });

  it('the hub has no disk, no OS windows and no terminals', () => {
    expect(runtimeCaps(RuntimeKind.HUB)).toMatchObject({ localFiles: false, osDialogs: false, terminals: false });
  });

  it('cloud boxes have a disk but no OS windows, and the hub owns their sign-in', () => {
    for (const kind of [RuntimeKind.SANDBOX, RuntimeKind.AGENT])
      expect(runtimeCaps(kind)).toMatchObject({ localFiles: true, osDialogs: false, hubOwnsAccount: true });
  });

  it('nobody sits at an agent box', () => {
    expect(runtimeCaps(RuntimeKind.AGENT).attended).toBe(false);
    expect(runtimeCaps(RuntimeKind.SANDBOX).attended).toBe(true);
  });

  it('desktop and browser can do everything locally', () => {
    for (const kind of [RuntimeKind.DESKTOP, RuntimeKind.BROWSER])
      expect(runtimeCaps(kind)).toEqual({
        localFiles: true,
        osDialogs: true,
        attended: true,
        terminals: true,
        hubOwnsAccount: false,
      });
  });
});
