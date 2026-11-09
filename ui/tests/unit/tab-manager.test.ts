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

describe('TabManager tab list versions', () => {
  type Listener = (...args: unknown[]) => void;
  function wired(gateway: TabGateway) {
    const handlers = new Map<string, Listener>();
    const connection = {
      on: vi.fn((event: string, handler: Listener) => handlers.set(event, handler)),
      off: vi.fn(),
    };
    const manager = new TabManager({ gateway, connection });
    managers.push(manager);
    manager.attachTabsChangedPing();
    const ping = (version?: string) => handlers.get('on_broadcast')?.({ broadcast_type: 'tabs_changed', version });
    return { manager, ping };
  }
  const listed = (version: string | undefined, ...ids: string[]) =>
    Object.assign(ids.map((id) => row(id) as Tab), version ? { version } : {});
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };

  it('a ping the held list already covers costs no re-list; a newer or unversioned one does', async () => {
    const listAll = vi.fn<TabGateway['listAll']>().mockResolvedValue(listed('e1:3', 'a'));
    const { manager, ping } = wired(gatewayWith(listAll));
    await manager.refresh();
    expect(listAll).toHaveBeenCalledTimes(1);

    ping('e1:3');
    ping('e1:2');
    await flush();
    expect(listAll).toHaveBeenCalledTimes(1);

    ping('e1:4');
    await flush();
    expect(listAll).toHaveBeenCalledTimes(2);
    ping('e2:1'); // another backend process: never covered
    await flush();
    expect(listAll).toHaveBeenCalledTimes(3);
    ping(undefined); // an older backend's ping
    await flush();
    expect(listAll).toHaveBeenCalledTimes(4);
  });

  it("a write's own ping is answered by the write: its global list is adopted, no re-list", async () => {
    const listAll = vi.fn<TabGateway['listAll']>().mockResolvedValue(listed('e1:1', 'a'));
    const gateway = gatewayWith(listAll);
    const answer = deferred<Tab[]>();
    gateway.setNameById = vi.fn(() => answer.promise) as TabGateway['setNameById'];
    const { manager, ping } = wired(gateway);
    await manager.refresh();

    const naming = manager.setName('a', 'renamed');
    ping('e1:2'); // the server pings before the write's answer lands
    await flush();
    expect(listAll).toHaveBeenCalledTimes(1);

    answer.resolve(Object.assign(listed(undefined, 'a'), { all: [row('a', 'renamed') as Tab, row('b') as Tab], version: 'e1:2' }));
    await naming;
    await flush();
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('a ping newer than the write still re-lists once the write lands', async () => {
    const listAll = vi.fn<TabGateway['listAll']>().mockResolvedValue(listed('e1:3', 'a', 'b', 'c'));
    const gateway = gatewayWith(listAll);
    const answer = deferred<Tab[]>();
    gateway.setNameById = vi.fn(() => answer.promise) as TabGateway['setNameById'];
    const { manager, ping } = wired(gateway);

    const naming = manager.setName('a', 'renamed');
    ping('e1:2');
    ping('e1:3'); // someone else's change after ours
    answer.resolve(Object.assign(listed(undefined, 'a'), { all: [row('a') as Tab, row('b') as Tab], version: 'e1:2' }));
    await naming;
    await flush();
    expect(listAll).toHaveBeenCalledTimes(1);
  });

  it('an answer older than the held list is not adopted', async () => {
    const stale = deferred<Tab[]>();
    const listAll = vi.fn<TabGateway['listAll']>().mockReturnValueOnce(stale.promise);
    const gateway = gatewayWith(listAll);
    gateway.setNameById = vi.fn(() =>
      Promise.resolve(
        Object.assign(listed(undefined, 'a'), { all: [row('a') as Tab, row('new') as Tab], version: 'e1:5' }),
      ),
    ) as TabGateway['setNameById'];
    const { manager } = wired(gateway);

    const refreshing = manager.refresh(); // started before the write
    await manager.setName('a', 'x');
    stale.resolve(listed('e1:4', 'a'));
    await refreshing;
    expect(manager.getSnapshot().map((t) => t.id)).toEqual(['a', 'new']);
  });
});

