import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSdkMainRealm, disposeAllOwnedSdkRealms, type OwnedSdkMainRealm } from '../_sdk_realm';
import type { BootstrapInfo, DeferredInfo, ScanInfo } from '@sdk/models/BootstrapInfo';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let realm: OwnedSdkMainRealm;
let bootstrap: BootstrapInfo;

beforeEach(async () => {
  realm = await createSdkMainRealm('http://unit-tier-has-no-backend.invalid:80');
  bootstrap = { types: [], info_available: true, desktop_info: { cloud_url: 'https://hub.example' } };
  window.appReady = false;
  localStorage.clear();
  vi.spyOn(realm.sdk.dataManager, 'bootstrap').mockImplementation(() => Promise.resolve(bootstrap));
  vi.spyOn(realm.sdk.authManager, 'init').mockResolvedValue(undefined);
  vi.spyOn(realm.sdk.dataContext, 'initContext').mockResolvedValue(undefined);
  vi.spyOn(realm.sdk.cloudManager, 'seedBootstrap').mockResolvedValue(undefined);
  vi.spyOn(realm.sdk.cloudManager, 'startSubscriptions').mockResolvedValue(undefined);
  vi.spyOn(realm.sdk.cloudManager, 'refreshStatus').mockResolvedValue(null);
  const { privacyManager } = await import('@sdk/services/privacy_mode');
  vi.spyOn(privacyManager, 'startSubscriptions').mockResolvedValue(undefined);
});

afterEach(() => {
  disposeAllOwnedSdkRealms();
  vi.restoreAllMocks();
});

describe('SDK discovery after readiness', () => {
  it('completes initialization once while info remains pending', async () => {
    const pending = deferred<DeferredInfo>();
    const started = deferred<void>();
    const info = vi.spyOn(realm.sdk.dataManager, 'info').mockImplementation(() => {
      expect(window.appReady).toBe(true);
      started.resolve();
      return pending.promise;
    });
    await Promise.all([realm.main.initSdk(), realm.main.initSdk()]);
    expect(window.appReady).toBe(true);
    expect(info).not.toHaveBeenCalled();
    const lazy = realm.main.asyncSdkInit();
    expect(realm.main.asyncSdkInit()).toBe(lazy);
    await started.promise;
    expect(info).toHaveBeenCalledTimes(1);
    expect(realm.sdk.dataContext.snifferReady).toBe(false);
    pending.resolve({ sniffer_installed: false, sniffer_hook: null });
    await lazy;
    expect(realm.sdk.dataContext.snifferReady).toBe(true);
  });

  it('contains a rejected info request without changing SDK readiness', async () => {
    const pending = deferred<DeferredInfo>();
    const started = deferred<void>();
    vi.spyOn(realm.sdk.dataManager, 'info').mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await realm.main.initSdk();
    const lazy = realm.main.asyncSdkInit();
    await started.promise;
    pending.reject(new Error('info offline'));
    await lazy;
    expect(window.appReady).toBe(true);
    expect(realm.sdk.dataContext.bootstrapError).toBeNull();
    expect(realm.sdk.dataContext.snifferReady).toBe(false);
    expect(warning).toHaveBeenCalledWith('[info] Optional runtime information unavailable', expect.any(Error));
  });

  it('preserves early identity and paths and publishes deferred status and notice', async () => {
    const cloudBootstrap = vi.spyOn(realm.sdk.cloudManager, 'seedBootstrap');
    const early = { paths: { home: 'Users/test', workspace: 'Users/test/work' }, login: { user_id: 'local-login' } };
    bootstrap.desktop_info = early as BootstrapInfo['desktop_info'];
    const notice = { id: 'recovery', level: 'warning' as const, title: 'Recovered', message: 'Sign in again' };
    vi.spyOn(realm.sdk.dataManager, 'info').mockResolvedValue({
      desktop_info: { installed_agents: ['claude'], cloud_login_available: false }, notice,
      sandbox_available: false, sniffer_installed: false,
    });
    const observed: unknown[] = [];
    realm.sdk.dataContext.on(realm.sdk.ContextEventType.CONTEXT_CHANGED, () => {
      observed.push(realm.sdk.dataContext.bootstrapInfo?.notice?.id);
    });
    await realm.main.initSdk();
    await realm.main.asyncSdkInit();
    expect(realm.sdk.dataContext.desktopInfo).toMatchObject({ ...early, installed_agents: ['claude'] });
    expect(observed).toContain('recovery');
    expect(cloudBootstrap).toHaveBeenCalledTimes(1);
  });

  it.each([['desk'], ['hub']])('does not request info from legacy %j backends', async (page) => {
    bootstrap = { types: [], supported_pages: [page], sniffer_installed: false };
    const info = vi.spyOn(realm.sdk.dataManager, 'info');
    await realm.main.initSdk();
    await realm.main.asyncSdkInit();
    expect(info).not.toHaveBeenCalled();
    expect(window.appReady).toBe(true);
    expect(realm.sdk.dataContext.snifferReady).toBe(true);
  });

  it('still waits for hub identity before SDK readiness', async () => {
    bootstrap = { types: [], supported_pages: ['hub'] };
    const cloud = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(realm.sdk.cloudManager, 'seedBootstrap').mockImplementation(() => { started.resolve(); return cloud.promise; });
    const ready = realm.main.initSdk();
    await started.promise;
    expect(window.appReady).toBe(false);
    cloud.resolve();
    await ready;
    expect(window.appReady).toBe(true);
  });

  it('waits for required init when lazy init is requested early', async () => {
    const core = deferred<BootstrapInfo>();
    vi.spyOn(realm.sdk.dataManager, 'bootstrap').mockReturnValue(core.promise);
    const info = vi.spyOn(realm.sdk.dataManager, 'info').mockResolvedValue({ sniffer_installed: false });
    const lazy = realm.main.asyncSdkInit();
    expect(info).not.toHaveBeenCalled();
    core.resolve(bootstrap);
    await lazy;
    expect(info).toHaveBeenCalledTimes(1);
    expect(window.appReady).toBe(true);
  });

  it('starts no optional jobs if required initialization fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(realm.sdk.dataManager, 'bootstrap').mockRejectedValue(new Error('offline'));
    const info = vi.spyOn(realm.sdk.dataManager, 'info');
    const refreshStatus = vi.spyOn(realm.sdk.cloudManager, 'refreshStatus');
    await realm.main.asyncSdkInit();
    expect(info).not.toHaveBeenCalled();
    expect(refreshStatus).not.toHaveBeenCalled();
    expect(window.appReady).toBe(false);
  });

  it('starts independent services while cloud refresh is pending and keeps the snapshot shallow', async () => {
    const cloud = deferred<null>();
    const subscribed = deferred<void>();
    const startSubscriptions = vi.spyOn(realm.sdk.cloudManager, 'startSubscriptions').mockImplementation(() => {
      subscribed.resolve();
      return Promise.resolve();
    });
    vi.spyOn(realm.sdk.cloudManager, 'refreshStatus').mockReturnValue(cloud.promise);
    vi.spyOn(realm.sdk.dataManager, 'info').mockResolvedValue({ sniffer_installed: false });
    await realm.main.initSdk();
    expect(realm.sdk.dataContext.bootstrapInfo).toBe(bootstrap);
    const lazy = realm.main.asyncSdkInit();
    await subscribed.promise;
    expect(startSubscriptions).toHaveBeenCalledTimes(1);
    expect(window.appReady).toBe(true);
    cloud.resolve(null);
    await lazy;
  });

  it('registers live listeners before proactively connecting, independently of info', async () => {
    bootstrap.user = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', type: 'user' } as unknown as NonNullable<BootstrapInfo['user']>;
    const info = deferred<DeferredInfo>();
    vi.spyOn(realm.sdk.dataManager, 'info').mockReturnValue(info.promise);
    const listeners = deferred<void>();
    const started = deferred<void>();
    vi.spyOn(realm.sdk.cloudManager, 'startSubscriptions').mockImplementation(() => {
      started.resolve();
      return listeners.promise;
    });
    const connect = vi.spyOn(realm.sdk.connectionManager, 'connect').mockResolvedValue(undefined);
    await realm.main.initSdk();
    const lazy = realm.main.asyncSdkInit();
    await started.promise;
    expect(connect).not.toHaveBeenCalled();
    listeners.resolve();
    info.resolve({ sniffer_installed: false });
    await lazy;
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('caches bootstrap entities without fetching the project collection or compute node', async () => {
    const computeNode = { id: 'bd3fb15c-958d-46e8-9c6b-a6e34d7e6a45', type: 'compute_node', uname: 'local' } as unknown as NonNullable<BootstrapInfo['default_compute_node']>;
    const project = { id: '647908c3-55dc-4597-b3b6-1c1dd4b00886', type: 'project' } as unknown as NonNullable<BootstrapInfo['default_project']>;
    bootstrap.default_compute_node = computeNode;
    bootstrap.default_project = project;
    const fetch = vi.spyOn(realm.sdk.dataManager, 'fetchByTypeId');
    const query = vi.spyOn(realm.sdk.Project, 'query');
    await realm.main.initSdk();
    expect(fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(realm.sdk.dataContext.computeNode?.id).toBe(computeNode.id);
    expect(realm.sdk.dataContext.project).toBeNull();
    expect(realm.sdk.Project.getByIdFromCache(project.id)).toBeTruthy();
  });

  it('does not wait for a legacy sniffer watch', async () => {
    const watch = deferred<() => Promise<void>>();
    const hook = new realm.sdk.AgentHook({ id: 'ddc57282-dc04-4382-9bc6-5c048ee28c28' });
    bootstrap = { types: [], sniffer_installed: true, sniffer_hook: hook };
    vi.spyOn(realm.sdk.AgentHook.prototype, 'watch').mockReturnValue(watch.promise);
    await realm.main.initSdk();
    expect(window.appReady).toBe(true);
    expect(realm.sdk.dataContext.snifferReady).toBe(false);
    const lazy = realm.main.asyncSdkInit();
    watch.resolve(() => Promise.resolve());
    await lazy;
  });
});

describe('discovery snapshots never undo newer state', () => {
  it('keeps a scan status received while the info request was in flight', async () => {
    const pending = deferred<DeferredInfo>();
    vi.spyOn(realm.sdk.dataManager, 'callAction').mockReturnValue(pending.promise);
    const request = realm.sdk.dataManager.info();
    const live: ScanInfo = { total_indexed: 20, last_indexed_at: null, never_indexed: false, stale: false };
    realm.sdk.dataManager.setScanInfo(live);
    pending.resolve({ scan_info: { ...live, total_indexed: 1 } });
    await request;
    expect(realm.sdk.dataManager.scanInfo).toBe(live);
  });

  it('preserves a capability refresh instead of applying an older initial seed', () => {
    const manager = realm.sdk.capabilityManager;
    const live = { intents: [], capabilities: [], generated_at: 'later' };
    manager.setSummary(live);
    manager.seedSummary({ ...live, generated_at: 'earlier' });
    expect(manager.getCachedSummary()).toBe(live);
  });

  it('does not seed capabilities over an in-flight refresh', async () => {
    const { default: apiClient } = await import('@sdk/client');
    const pending = deferred<{ intents: []; capabilities: []; generated_at: string }>();
    vi.spyOn(apiClient, 'get').mockReturnValue(pending.promise);
    const manager = realm.sdk.capabilityManager;
    const refreshing = manager.getSummary();
    manager.seedSummary({ intents: [], capabilities: [], generated_at: 'older' });
    expect(manager.getCachedSummary()).toBeNull();
    pending.resolve({ intents: [], capabilities: [], generated_at: 'fresh' });
    await refreshing;
    expect(manager.getCachedSummary()?.generated_at).toBe('fresh');
  });

  it('keeps unknown sniffer state pending and explicit false resolved', async () => {
    const manager = realm.sdk.snifferManager;
    await manager.seed({ sniffer_hook: null, sniffer_installed: null });
    expect(realm.sdk.dataContext.snifferReady).toBe(false);
    await manager.seed({ sniffer_hook: null, sniffer_installed: false });
    expect(realm.sdk.dataContext.snifferReady).toBe(true);
    expect(realm.sdk.dataContext.snifferEnabled).toBe(false);
  });

  it('ignores sniffer info after an explicit command starts', async () => {
    const manager = realm.sdk.snifferManager;
    const revision = manager.revision;
    const command = deferred<unknown>();
    vi.spyOn(realm.sdk.dataManager, 'callAction').mockReturnValue(command.promise);
    const disabling = manager.disable();
    await manager.seed({ sniffer_installed: true }, revision);
    expect(realm.sdk.dataContext.snifferInstalled).toBe(false);
    command.resolve({ enabled: false, installed: false });
    await disabling;
    expect(realm.sdk.dataContext.snifferReady).toBe(true);
  });

  it('releases a late sniffer watch without reviving a disabled hook', async () => {
    const manager = realm.sdk.snifferManager;
    const watch = deferred<() => Promise<void>>();
    const started = deferred<void>();
    vi.spyOn(realm.sdk.AgentHook.prototype, 'watch').mockImplementation(() => { started.resolve(); return watch.promise; });
    const seeding = manager.seed({
      sniffer_installed: true,
      sniffer_hook: new realm.sdk.AgentHook({ id: 'ddc57282-dc04-4382-9bc6-5c048ee28c28' }),
    });
    await started.promise;
    vi.spyOn(realm.sdk.dataManager, 'callAction').mockResolvedValue({ enabled: false, installed: false });
    await manager.disable();
    const unwatch = vi.fn(() => Promise.resolve());
    watch.resolve(unwatch);
    await seeding;
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(manager.entity).toBeNull();
    expect(realm.sdk.dataContext.snifferHook).toBeNull();
    expect(realm.sdk.dataContext.snifferEnabled).toBe(false);
  });
});
