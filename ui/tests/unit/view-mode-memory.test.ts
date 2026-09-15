/**
 * `ViewModeStore` — the one policy deciding which tab events mint `last_mode`.
 * Pure table + plain-object targets: no cache, no router, no mocks beyond `save`.
 */
import {
  shouldStore,
  VIEW_MODE_STORE,
  ViewModeEvent,
  ViewModeMemory,
  ViewModeStore,
} from '@sdk';
import { describe, expect, it, vi } from 'vitest';

const target = (last_mode: string | null = null) => ({ last_mode, save: vi.fn().mockResolvedValue(undefined) });

describe('shouldStore', () => {
  it.each([
    [ViewModeStore.TabCreate, [ViewModeEvent.TabCreate, ViewModeEvent.ModeSwitch]],
    [ViewModeStore.TabOpen, [ViewModeEvent.TabCreate, ViewModeEvent.TabOpen, ViewModeEvent.ModeSwitch]],
    [ViewModeStore.ModeSwitch, [ViewModeEvent.ModeSwitch]],
    [ViewModeStore.Never, []],
  ])('%s stores exactly %j', (policy, stored) => {
    for (const event of Object.values(ViewModeEvent)) {
      expect(shouldStore(policy, event)).toBe(stored.includes(event));
    }
  });

  it('defaults both scopes to mode switch only', () => {
    expect(VIEW_MODE_STORE).toEqual({ tab: ViewModeStore.ModeSwitch, project: ViewModeStore.ModeSwitch });
  });
});

describe('ViewModeMemory.record', () => {
  it('applies each scope policy independently', () => {
    const memory = new ViewModeMemory({ tab: ViewModeStore.TabOpen, project: ViewModeStore.ModeSwitch });
    const tab = target();
    const project = target();

    memory.record(ViewModeEvent.TabOpen, { tab, project }, 'advanced');

    expect(tab.last_mode).toBe('advanced');
    expect(tab.save).toHaveBeenCalledTimes(1);
    expect(project.save).not.toHaveBeenCalled();
  });

  it('never saves an unchanged mode', () => {
    const tab = target('vibe');
    new ViewModeMemory().record(ViewModeEvent.ModeSwitch, { tab }, 'vibe');
    expect(tab.save).not.toHaveBeenCalled();
  });

  it('Never writes nothing, even on a switch', () => {
    const tab = target();
    new ViewModeMemory({ tab: ViewModeStore.Never, project: ViewModeStore.Never }).record(
      ViewModeEvent.ModeSwitch,
      { tab },
      'dev',
    );
    expect(tab.save).not.toHaveBeenCalled();
  });
});
