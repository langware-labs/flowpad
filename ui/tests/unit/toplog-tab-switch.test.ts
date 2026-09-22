import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { tabSwitch } from '@src/navigation/tab-switch-state';
import { toplog, ViewType } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Force the toplog singleton's state without a backend round-trip. */
function setToplog(filter: Record<string, boolean>) {
  (toplog as any)._apply({ enabled: true, filter });
}

function tabSwitchLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.filter((c) => c[0] === '[toplog:tab_switch]').map((c) => String(c[1]));
}

/**
 * The `tab_switch` trail starts where a navigation that will actually move the
 * app is committed, and a click that moves nothing says so — both are what a
 * "the tab didn't switch" report is read from.
 */
describe('toplog tab_switch — start / noop', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.pushState({}, '', '/dock/shell/agentic_process-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = toplog as any;
    if (t._flushTimer !== null) clearTimeout(t._flushTimer);
    t._flushTimer = null;
    t._queue = [];
  });

  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    (toplog as any)._apply({ enabled: false, filter: {} });
    (toplog as any)._queue = [];
    vi.restoreAllMocks();
  });

  it('a navigation to a new dock writes one start line with a fresh switch id', () => {
    setToplog({ tab_switch: true });
    const before = tabSwitch.id;
    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, null);

    navigation.openDock(new DockPointer(ViewType.PREFERENCES, null));

    expect(navigate).toHaveBeenCalledTimes(1);
    const lines = tabSwitchLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(`^start sw=${before + 1} via=openDock from=shell:agentic_process-aaaaaaaa\\S* to=preferences: visibility=`),
    );
    expect(tabSwitch.id).toBe(before + 1);
    expect(tabSwitch.readyLogged).toBe(false);
  });

  it('opening the dock already shown writes a noop line and no start', () => {
    setToplog({ tab_switch: true });
    window.history.pushState({}, '', '/dock/preferences');
    const current = DockPointer.fromUrl('/dock/preferences');
    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, current);

    navigation.openDock(current);

    expect(navigate).not.toHaveBeenCalled();
    const lines = tabSwitchLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^noop sw=\d+ reason=same_dock to=preferences:/);
  });

  it('writes nothing while the tag is off', () => {
    setToplog({ navigation: true });
    const before = tabSwitch.id;
    const navigation = new NavigationActions(vi.fn(), null);

    navigation.openDock(new DockPointer(ViewType.PREFERENCES, null));

    expect(tabSwitchLines(logSpy)).toHaveLength(0);
    expect((toplog as any)._queue.some((l: { tags: string[] }) => l.tags.includes('tab_switch'))).toBe(false);
    expect(tabSwitch.id).toBe(before);
  });
});
