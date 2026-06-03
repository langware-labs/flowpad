/**
 * Phase-0 characterization: locks the current default-tab resolver
 * (`resolveDefaultTab`, load-shell.ts) before it is generalized into
 * `resolveActive`. Precedence today:
 *   1. dataContext.activeTerminalTargetTypeId (if pickable)
 *   2. dataContext.activeShellId (if a pickable shell tab matches)
 *   3. first pickable tab
 * "Pickable" = not disabled and not in excludeIds (by target string, target id,
 * transport shell id, or owning process id).
 *
 * Entity ids must be valid v4/v5 UUIDs (TypeId enforces the entity-id policy).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Shell, TypeId, dataContext } from '@sdk';
import { resolveDefaultTab } from '@src/routes/loaders/load-shell';
import { procTab, shellTab, uid } from '../utils/terminal-tab-fixtures';

beforeEach(() => {
  dataContext.setActiveTerminalTargetTypeId(null);
  dataContext.setActiveShellId('');
});
afterEach(() => {
  dataContext.setActiveTerminalTargetTypeId(null);
  dataContext.setActiveShellId('');
});

describe('resolveDefaultTab', () => {
  it('returns the first pickable tab when nothing is previously active', () => {
    const tabs = [shellTab('a'), shellTab('b')];
    expect(resolveDefaultTab(tabs)?.name).toBe('a');
  });

  it('prefers the previously-active target over the first tab', () => {
    const tabs = [shellTab('a'), shellTab('b')];
    dataContext.setActiveTerminalTargetTypeId(new TypeId(Shell.type, uid('b')));
    expect(resolveDefaultTab(tabs)?.name).toBe('b');
  });

  it('falls back to activeShellId when no active target matches', () => {
    const tabs = [shellTab('a'), shellTab('b')];
    dataContext.setActiveShellId(uid('b'));
    expect(resolveDefaultTab(tabs)?.name).toBe('b');
  });

  it('skips disabled tabs', () => {
    const tabs = [shellTab('a', 0, { isDisabled: true }), shellTab('b')];
    expect(resolveDefaultTab(tabs)?.name).toBe('b');
  });

  it('skips tabs whose target id is excluded', () => {
    const tabs = [shellTab('a'), shellTab('b')];
    expect(resolveDefaultTab(tabs, new Set([uid('a')]))?.name).toBe('b');
  });

  it('skips a process tab whose owning process id is excluded', () => {
    const tabs = [procTab('p1', 0, { shellId: uid('s1') }), shellTab('b')];
    expect(resolveDefaultTab(tabs, new Set([uid('p1')]))?.name).toBe('b');
  });

  it('skips a process tab whose transport shell id is excluded', () => {
    const tabs = [procTab('p1', 0, { shellId: uid('s1') }), shellTab('b')];
    expect(resolveDefaultTab(tabs, new Set([uid('s1')]))?.name).toBe('b');
  });

  it('returns null when nothing is pickable', () => {
    const tabs = [shellTab('a', 0, { isDisabled: true })];
    expect(resolveDefaultTab(tabs)).toBeNull();
  });
});
