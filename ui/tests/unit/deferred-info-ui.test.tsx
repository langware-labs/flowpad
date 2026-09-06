import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataContext, snifferManager } from '@sdk';

const fixtures = vi.hoisted(() => ({
  context: { computeNode: null, snifferEnabled: false, snifferReady: false, isBootstrapping: false },
  flow: { flowData: [], clear: () => undefined },
  projects: { projects: [] },
  notify: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('@sdk/react/hooks', () => ({
  useContext: () => fixtures.context,
  useEntityData: () => fixtures.flow,
}));
vi.mock('@src/hooks/use-preference', () => ({ usePreference: () => [1000, () => undefined] }));
vi.mock('@src/hooks/use-claude-projects', () => ({ useProjectList: () => fixtures.projects }));
vi.mock('@src/notifications/notify', () => ({ notify: fixtures.notify, dismiss: vi.fn() }));

import { useHooksSniffer } from '@src/hooks/use-hooks-sniffer';
import { initNotificationIngest } from '@src/notifications/ingest';

afterEach(() => {
  cleanup();
  localStorage.removeItem('flowpad.snifferEnabled');
  vi.restoreAllMocks();
});

describe('deferred info UI subscriptions', () => {
  it('does not reconcile a stored sniffer preference while status is unknown', async () => {
    localStorage.setItem('flowpad.snifferEnabled', 'true');
    const enable = vi.spyOn(snifferManager, 'enable').mockResolvedValue({ enabled: true });
    const hook = renderHook(() => useHooksSniffer());
    expect(enable).not.toHaveBeenCalled();
    fixtures.context.snifferReady = true;
    await act(() => { hook.rerender(); return Promise.resolve(); });
    expect(enable).toHaveBeenCalledTimes(1);
    hook.rerender();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it('delivers a late notice once and removes its context subscription on cleanup', () => {
    dataContext.bootstrapInfo = { types: [] };
    const before = dataContext.listenerCount('context_changed');
    const stop = initNotificationIngest();
    expect(fixtures.notify).not.toHaveBeenCalled();
    dataContext.applyInfo({ notice: { id: 'recovery', level: 'warning', title: 'Recovered', message: 'Sign in again' } });
    expect(fixtures.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'recovery' }));
    dataContext.applyInfo({ sandbox_available: false });
    expect(fixtures.notify).toHaveBeenCalledTimes(1);
    stop();
    expect(dataContext.listenerCount('context_changed')).toBe(before);
  });
});
