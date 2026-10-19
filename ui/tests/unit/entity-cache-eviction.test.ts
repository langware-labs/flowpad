/**
 * The entity cache lets go of a row once nothing references it — and frees what hangs off it.
 *
 * The rule (ts_sdk/src/FlowSync/store.ts, `_evict` / `evictIfUnreferenced`):
 *   - an entity leaves the cache ONE way, whatever the reason (a delete op, a removal, an
 *     identity switch, an eviction), and on the way out it frees what it owns: its flow-data
 *     stream, a shell's PTY connection, a process's loaded artifacts;
 *   - a row is evicted only when it is unreferenced (no subscriber, no watch, no live query
 *     holding it, no view listening to it) AND it is either RETIRED by its own type (a closed
 *     tab, a closed shell, an ended terminal session whose tab is closed) or a broadcast
 *     `create` this page never asked for;
 *   - everything else stays warm, and whatever was evicted loads again when asked for.
 *
 * Driven through the real `dataManager` and the real `Tab` / `Shell` / `AgenticProcess`
 * classes, entering where the app does: the entity constructors, `subscribe` / `watch` /
 * `watchQuery` and their releases, the WS handlers (`onDataOp`, `onFlowData`,
 * `onPtyOutputMessage`). The only stand-in is the HTTP boundary, `apiClient`.
 */
import { AgenticProcess, dataManager, ProcessStatus, QueryRequest, Shell, ShellStatus, Tab, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { ConnectionManager } from '@sdk/websocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Store = {
  entities: { size: number };
  subscriptions: { size: number };
  onDataOp(t: string, op: string, d: object | null): void;
  onFlowData(t: TypeId, json: object): void;
  onPtyOutputMessage(msg: object): void;
};
const store = dataManager as unknown as Store;

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const SAVED = { created_date: '2026-01-01T00:00:00Z', created_by: uuid(999_999) };
const tabId = (i: number) => new TypeId(Tab.type, uuid(i));
const shellId = (i: number) => new TypeId(Shell.type, uuid(100_000 + i));
const procId = (i: number) => new TypeId(AgenticProcess.type, uuid(200_000 + i));

const tabJson = (i: number, extra: object = {}) => ({ type: Tab.type, id: uuid(i), visible: true, ...SAVED, ...extra });
const shellJson = (i: number, extra: object = {}) => ({
  type: Shell.type,
  id: uuid(100_000 + i),
  status: ShellStatus.RUNNING,
  ...SAVED,
  ...extra,
});
const procJson = (i: number, extra: object = {}) => ({
  type: AgenticProcess.type,
  id: uuid(200_000 + i),
  status: ProcessStatus.RUNNING,
  visible: true,
  pty_mode: true,
  shell_id: uuid(100_000 + i),
  ...SAVED,
  ...extra,
});

const op = (typeId: TypeId, kind: 'create' | 'update' | 'delete', data: object | null) =>
  store.onDataOp(typeId.toString(), kind, data);
const cached = (typeId: TypeId) => dataManager.getByTypeIdFromCache(typeId);
const frame = (i: number) => ({ element_type: 'tool_call', flow_value: `call ${i}`, attributes: { i: String(i) } });
const rows = (entity: { flowDataStream: { ownItems: unknown[] } }) => entity.flowDataStream.ownItems.length;
/** What a PtyConnection keeps on the app-wide connection manager while it is alive. */
const reattachHooks = () =>
  ConnectionManager.getInstance().listenerCount('on_recovered') +
  ConnectionManager.getInstance().listenerCount('on_reconnected');

/** Every reference a test takes is given back after it, so none outlives its test. */
const leftovers: Array<() => unknown> = [];
function subscribe(typeId: TypeId, callback: (entity: unknown) => void = () => undefined): () => void {
  const off = dataManager.subscribe(typeId, callback);
  leftovers.push(off);
  return off;
}
async function watch(typeId: TypeId): Promise<() => Promise<void>> {
  const release = await dataManager.watch(typeId);
  leftovers.push(release);
  return release;
}
async function watchTabs(callback: (tabs: unknown[]) => void = () => undefined): Promise<() => void> {
  const stop = await dataManager.watchQuery(new QueryRequest({ type: Tab.type, callback }));
  leftovers.push(stop);
  return stop;
}

/** An open terminal tab as the app leaves it: its Tab, its Shell (attached, with output), a view on the shell. */
async function openTerminal(i: number) {
  Tab.fromResponse([tabJson(i) as never]);
  const shell = new Shell(shellJson(i) as never);
  (shell.ptyConnection as unknown as { _wireReattachHooks(): void })._wireReattachHooks();
  await vi.dynamicImportSettled();
  store.onPtyOutputMessage({ shell_id: shell.id, data: btoa(`output of ${i}\r\n`), seq: 1 });
  return { shell, unsubscribe: subscribe(shell.typeId), unwatch: await watch(shell.typeId) };
}

/** The backend's side of "Close tab": the tab is soft-hidden (an update), the shell row is deleted. */
async function closeTerminal(i: number, view: { unsubscribe(): void; unwatch(): Promise<void> }) {
  op(tabId(i), 'update', tabJson(i, { visible: false }));
  op(shellId(i), 'delete', null);
  view.unsubscribe();
  await view.unwatch();
}

beforeEach(async () => {
  await dataManager.reset();
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const release of leftovers.splice(0)) await release();
  vi.restoreAllMocks();
});

describe('a closed terminal leaves nothing behind', () => {
  it('ten open/close cycles end where they started: no tab, no shell, no connection hook, no subscription key', async () => {
    const start = { entities: store.entities.size, hooks: reattachHooks(), subscriptions: store.subscriptions.size };
    const shells: Shell[] = [];

    for (let i = 1; i <= 10; i++) {
      const view = await openTerminal(i);
      shells.push(view.shell);
      expect(store.entities.size).toBe(start.entities + 2);
      expect(reattachHooks()).toBe(start.hooks + 2);
      expect(view.shell.ptyConnection.chunks.size).toBe(1);

      await closeTerminal(i, view);
      expect(store.entities.size).toBe(start.entities);
    }

    expect(reattachHooks()).toBe(start.hooks);
    expect(store.subscriptions.size).toBe(start.subscriptions);
    for (const shell of shells) expect(shell.ptyConnection.chunks.size).toBe(0);
  });

  it('a closed tab someone still subscribes to stays until that subscriber leaves', () => {
    Tab.fromResponse([tabJson(1) as never]);
    const seen: unknown[] = [];
    const unsubscribe = subscribe(tabId(1), (tab) => void seen.push(tab));

    op(tabId(1), 'update', tabJson(1, { visible: false }));
    expect(cached(tabId(1))).toMatchObject({ visible: false });
    expect(seen.at(-1)).toBe(cached(tabId(1)));

    unsubscribe();
    expect(cached(tabId(1))).toBeNull();
  });

  it('a watched row stays until its last watch is released', async () => {
    Tab.fromResponse([tabJson(1) as never]);
    const first = await watch(tabId(1));
    const second = await watch(tabId(1));
    op(tabId(1), 'update', tabJson(1, { visible: false }));

    await first();
    expect(cached(tabId(1))).not.toBeNull();
    await second();
    expect(cached(tabId(1))).toBeNull();
  });

  it('a closed shell is evicted with its PTY connection released', () => {
    const shell = new Shell(shellJson(1) as never);
    store.onPtyOutputMessage({ shell_id: shell.id, data: btoa('hello\r\n'), seq: 1 });
    const unsubscribe = subscribe(shell.typeId);

    op(shell.typeId, 'update', shellJson(1, { status: ShellStatus.CLOSED }));
    expect(cached(shell.typeId)).toBe(shell);
    expect(shell.ptyConnection.chunks.size).toBe(1);

    unsubscribe();
    expect(cached(shell.typeId)).toBeNull();
    expect(shell.ptyConnection.chunks.size).toBe(0);
  });
});

describe('what is still in use is never evicted', () => {
  it('releasing every reference to a row that is not retired keeps it warm', async () => {
    Tab.fromResponse([tabJson(1) as never]);
    const shell = new Shell(shellJson(1) as never);
    // Ended, but its tab is open: the session is on screen.
    const proc = new AgenticProcess(procJson(1, { status: ProcessStatus.STOPPED }) as never);

    for (const typeId of [tabId(1), shell.typeId, proc.typeId]) {
      const unsubscribe = subscribe(typeId);
      const unwatch = await watch(typeId);
      op(typeId, 'update', { type: typeId.type, id: typeId.id, name: 'renamed' });
      unsubscribe();
      await unwatch();
      expect(cached(typeId)).not.toBeNull();
    }
  });

  it('a live query holds its rows; once the query is gone only the retired ones leave', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson(1), tabJson(2)] as never);
    const stop = await watchTabs();

    op(tabId(1), 'update', tabJson(1, { visible: false }));
    expect(cached(tabId(1))).not.toBeNull();

    stop();
    expect(cached(tabId(1))).toBeNull();
    expect(cached(tabId(2))).not.toBeNull();
  });

  it('a view listening to the entity is a reference', () => {
    const [tab] = Tab.fromResponse([tabJson(1) as never]);
    const off = tab.on('change', () => undefined);

    op(tabId(1), 'update', tabJson(1, { visible: false }));
    expect(cached(tabId(1))).toBe(tab);

    off();
    subscribe(tabId(1))();
    expect(cached(tabId(1))).toBeNull();
  });

  it('a headless process (no tab) is not retired by ending', () => {
    const proc = new AgenticProcess(procJson(1, { pty_mode: false, visible: false }) as never);
    op(proc.typeId, 'update', procJson(1, { pty_mode: false, visible: false, status: ProcessStatus.STOPPED }));
    subscribe(proc.typeId)();
    expect(cached(proc.typeId)).toBe(proc);
  });
});

describe('a broadcast create this page never asked for is not kept', () => {
  it('creates nobody watches leave the cache as they found it', () => {
    const start = store.entities.size;
    for (let i = 1; i <= 50; i++) {
      op(tabId(i), 'create', tabJson(i));
      op(shellId(i), 'create', shellJson(i));
      op(procId(i), 'create', procJson(i));
    }
    expect(store.entities.size).toBe(start);
  });

  it('a create a live query takes is kept, and reaches the query', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([] as never);
    const seen: number[] = [];
    await watchTabs((tabs) => void seen.push(tabs.length));

    op(tabId(1), 'create', tabJson(1));
    expect(cached(tabId(1))).not.toBeNull();
    expect(seen).toEqual([0, 1]);
  });

  it('a create someone subscribed for is kept, and reaches the subscriber', () => {
    const seen: unknown[] = [];
    subscribe(tabId(1), (tab) => void seen.push(tab));

    op(tabId(1), 'create', tabJson(1));
    expect(cached(tabId(1))).not.toBeNull();
    expect(seen.at(-1)).toBe(cached(tabId(1)));
  });

  it('a create for an id this page is fetching is the fetched entity', async () => {
    let respond!: (json: object) => void;
    vi.spyOn(apiClient, 'get').mockImplementation((() => new Promise((resolve) => (respond = resolve))) as never);
    const fetching = dataManager.getByTypeId(tabId(1));

    op(tabId(1), 'create', tabJson(1, { name: 'from the op' }));
    respond(tabJson(1));

    expect(await fetching).toMatchObject({ name: 'from the op' });
    expect(cached(tabId(1))).not.toBeNull();
  });
});

describe('an evicted row loads again when it is asked for', () => {
  it('a by-id read after eviction is one fetch and a usable entity', async () => {
    Tab.fromResponse([tabJson(1) as never]);
    op(tabId(1), 'update', tabJson(1, { visible: false }));
    expect(cached(tabId(1))).toBeNull();

    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(tabJson(1, { visible: false }) as never);
    const tab = await dataManager.getByTypeId<Tab>(tabId(1));
    expect(get).toHaveBeenCalledTimes(1);
    expect(tab).toMatchObject({ id: uuid(1), visible: false });
  });

  it('a reopened tab is rebuilt from the list response and updates like any other', () => {
    Tab.fromResponse([tabJson(1) as never]);
    op(tabId(1), 'update', tabJson(1, { visible: false }));

    const [reopened] = Tab.fromResponse([tabJson(1, { name: 'again' }) as never]);
    expect(cached(tabId(1))).toBe(reopened);
    op(tabId(1), 'update', tabJson(1, { name: 'renamed' }));
    expect(reopened.name).toBe('renamed');
  });
});

describe('an entity that leaves the cache frees its flow-data stream', () => {
  /** A terminal session with a mounted view: the process, a subscriber, a stream listener, transcript rows. */
  function sessionWithTranscript(frames: number) {
    const proc = new AgenticProcess(procJson(1) as never);
    const unsubscribe = subscribe(proc.typeId);
    const onData = () => undefined;
    proc.flowDataStream.on('data', onData);
    for (let i = 0; i < frames; i++) store.onFlowData(proc.typeId, frame(i));
    const leaveView = () => {
      proc.flowDataStream.off('data', onData);
      unsubscribe();
    };
    return { proc, leaveView };
  }

  it('an ended session whose tab is closed is evicted, and its transcript mirror goes with it', () => {
    const { proc, leaveView } = sessionWithTranscript(300);
    proc.applyArtifactEvent({
      tag: 'artifact.created',
      target: `artifact:${uuid(7)}`,
      data: { name: 'a.md' },
    } as never);
    expect(rows(proc)).toBe(300);
    expect(proc.artifacts).toHaveLength(1);

    // The worker ends: the tab is still open, the session is still on screen.
    op(proc.typeId, 'update', procJson(1, { status: ProcessStatus.STOPPED }));
    expect(cached(proc.typeId)).toBe(proc);

    // The tab closes while its panel is still mounted: the view's own references keep it.
    op(proc.typeId, 'update', procJson(1, { status: ProcessStatus.STOPPED, visible: false }));
    expect(cached(proc.typeId)).toBe(proc);
    expect(rows(proc)).toBe(300);

    // The panel unmounts: nothing references the session any more.
    leaveView();
    expect(cached(proc.typeId)).toBeNull();
    expect(rows(proc)).toBe(0);
    expect(proc.artifacts).toHaveLength(0);
    expect(proc.historyLoaded).toBe(false);

    // Frames that still arrive for it find no entity and add nothing.
    for (let i = 0; i < 50; i++) store.onFlowData(proc.typeId, frame(1000 + i));
    expect(rows(proc)).toBe(0);
  });

  it('a holder that outlives the cache entry is told the stream was emptied', () => {
    const proc = new AgenticProcess(procJson(1) as never);
    for (let i = 0; i < 20; i++) store.onFlowData(proc.typeId, frame(i));
    const cleared = vi.fn();
    proc.flowDataStream.on('clear', cleared);

    op(proc.typeId, 'delete', null);

    expect(cleared).toHaveBeenCalledTimes(1);
    expect(rows(proc)).toBe(0);
  });

  it('a removal and an identity switch release it too; a refetch does not', async () => {
    const removed = new AgenticProcess(procJson(1) as never);
    const switched = new AgenticProcess(procJson(2) as never);
    const refetched = new AgenticProcess(procJson(3) as never);
    for (const proc of [removed, switched, refetched]) {
      for (let i = 0; i < 20; i++) store.onFlowData(proc.typeId, frame(i));
    }

    dataManager.invalidateCacheByTypeId(refetched.typeId);
    expect(rows(refetched)).toBe(20);

    dataManager.removeEntityFromCache(removed.typeId);
    expect(rows(removed)).toBe(0);

    await dataManager.clearCache();
    expect(rows(switched)).toBe(0);
    expect(store.entities.size).toBe(0);
  });
});
