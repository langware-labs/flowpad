import {
  TabLifecycleState,
  TabManager,
  type Tab,
  type TabGateway,
  type TabRow,
} from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

const managers: TabManager[] = [];

function row(id: string, name: string = id): TabRow {
  return {
    id,
    pointer: id,
    target_type: null,
    target_id: null,
    parent_tab_id: null,
    project_id: null,
    name,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatewayWith(listAll: TabGateway['listAll']): TabGateway {
  return {
    listAll,
    newTab: vi.fn(),
    getFromDockPointer: vi.fn(),
    resolveDockTarget: vi.fn(),
    activateById: vi.fn(),
    closeById: vi.fn(),
    closeManyByIds: vi.fn(),
    renameById: vi.fn(),
    setNameById: vi.fn(),
    reorder: vi.fn(),
  } as unknown as TabGateway;
}

afterEach(() => {
  for (const manager of managers) manager.resetForTests();
  managers.length = 0;
  vi.restoreAllMocks();
});

describe('TabManager canonical refresh', () => {
  it('coalesces concurrent callers onto one request plus one trailing refresh', async () => {
    const first = deferred<Tab[]>();
    const trailing = deferred<Tab[]>();
    const listAll = vi
      .fn<TabGateway['listAll']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);
    const manager = new TabManager({ gateway: gatewayWith(listAll) });
    managers.push(manager);

    const initialCall = manager.refresh();
    const joiningCall = manager.refresh();

    expect(joiningCall).toBe(initialCall);
    expect(listAll).toHaveBeenCalledTimes(1);

    first.resolve([row('first') as Tab]);
    await Promise.resolve();
    await Promise.resolve();
    expect(listAll).toHaveBeenCalledTimes(2);

    trailing.resolve([row('last') as Tab]);
    await expect(joiningCall).resolves.toEqual([expect.objectContaining({ id: 'last' })]);
    expect(manager.getSnapshot().map((tab) => tab.id)).toEqual(['last']);
  });

  it('reconciles lifecycle state before notifying tab subscribers', () => {
    const manager = new TabManager({ gateway: gatewayWith(vi.fn()) });
    managers.push(manager);
    const stale = row('stale');
    manager.lifecycle.set(stale.pointer, TabLifecycleState.Opening, { tabId: stale.id });
    const events: string[] = [];
    manager.lifecycle.subscribe(() => events.push('lifecycle'));
    manager.subscribe(() => {
      expect(manager.lifecycle.get(stale.pointer)).toBeNull();
      events.push('tabs');
    });

    manager.adoptGlobal([row('replacement')]);

    expect(events).toEqual(['lifecycle', 'tabs']);
  });

  it('consumes pending intent only when it decides the next tab', () => {
    const manager = new TabManager({ gateway: gatewayWith(vi.fn()) });
    managers.push(manager);
    const first = {
      ...row('first'),
      target_type: 'shell',
      target_id: 'first-target',
      tab_order: 0,
    } as Tab;
    const intended = {
      ...row('intended'),
      target_type: 'shell',
      target_id: 'intended-target',
      tab_order: 1,
    } as Tab;

    manager.setPendingIntent('shell-intended-target');
    expect(manager.resolveNext([first, intended])).toBe(intended);
    expect(manager.peekPendingIntent()).toBeNull();

    manager.setPendingIntent('shell-not-a-member');
    expect(manager.resolveNext([first, intended])).toBe(first);
    expect(manager.peekPendingIntent()).toBe('shell-not-a-member');
  });

  it('does not adopt a possibly scoped command response', async () => {
    const closeById = vi
      .fn<TabGateway['closeById']>()
      .mockResolvedValue([row('scoped-response') as Tab]);
    const gateway = { ...gatewayWith(vi.fn()), closeById };
    const manager = new TabManager({ gateway });
    managers.push(manager);
    manager.adoptGlobal([row('global-a'), row('global-b')]);

    await expect(manager.close('global-a')).resolves.toEqual([
      expect.objectContaining({ id: 'scoped-response' }),
    ]);

    expect(closeById).toHaveBeenCalledWith('global-a');
    expect(manager.getSnapshot().map((tab) => tab.id)).toEqual(['global-a', 'global-b']);
  });
});

describe('TabManager tabs_changed subscription', () => {
  it('attaches once, ignores unrelated broadcasts, and detaches on reset', async () => {
    type Listener = (...args: unknown[]) => void;
    const handlers = new Map<string, Listener>();
    const connection = {
      on: vi.fn((event: string, handler: Listener) => handlers.set(event, handler)),
      off: vi.fn((event: string, handler: Listener) => {
        if (handlers.get(event) === handler) handlers.delete(event);
      }),
    };
    const listAll = vi.fn<TabGateway['listAll']>().mockResolvedValue([]);
    const manager = new TabManager({ gateway: gatewayWith(listAll), connection });
    managers.push(manager);

    manager.attachTabsChangedPing();
    manager.attachTabsChangedPing();
    expect(connection.on).toHaveBeenCalledTimes(1);

    handlers.get('on_broadcast')?.({ broadcast_type: 'something_else' });
    await Promise.resolve();
    expect(listAll).not.toHaveBeenCalled();

    handlers.get('on_broadcast')?.({ broadcast_type: 'tabs_changed' });
    await Promise.resolve();
    expect(listAll).toHaveBeenCalledTimes(1);

    manager.resetForTests();
    expect(connection.off).toHaveBeenCalledTimes(1);
    expect(handlers.has('on_broadcast')).toBe(false);
  });
});
