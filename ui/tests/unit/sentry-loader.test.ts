/**
 * Where the Sentry SDK comes from: the hub's script, loaded at runtime, from a fixed path on the hub's
 * origin. The SDK is not in this bundle; these tests drive the real loader against a stand-in for the
 * script (an object on `window.__FlowpadSentry`), so what is checked is the loader's decisions.
 */
import { runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataContext, privacyManager } from '@sdk';
import { __testing, effectiveConfig, sdkUrlFor, startSentryReaction } from '@src/telemetry/sentry';

const DSN_A = 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/11';
const DSN_B = 'https://fedcba9876543210fedcba9876543210@o1.ingest.us.sentry.io/22';
const HUB = 'https://app.example.test';
const SDK_URL = `${HUB}/api/v1/sentry-sdk/browser`;

const bootstrap = (over: Record<string, unknown> = {}, info: Record<string, unknown> = { dsn: DSN_A, environment: 'staging' }) => ({
  runtime: { kind: 'sandbox' },
  desktop_info: { cloud_app_url: HUB },
  sentry_info: info,
  ...over,
});

function setBootstrap(info: Record<string, unknown> | null) {
  runInAction(() => {
    dataContext.bootstrapInfo = info;
  });
}
/** Everything queued has finished. Only valid once no script is still waiting to "load". */
const settle = async () => {
  for (let i = 0; i < 4; i++) await __testing.settled();
};
/** Let the lifecycle run up to where it waits for the script (the queue itself cannot be awaited there). */
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** What the hub's script defines: the 8 names and its contract. Spies, so calls can be read back. */
function fakeSdk(contract = 1) {
  return {
    contract,
    init: vi.fn(),
    getClient: vi.fn(() => ({ close: vi.fn(() => Promise.resolve(true)), flush: vi.fn(() => Promise.resolve(true)) })),
    captureException: vi.fn(),
    globalHandlersIntegration: vi.fn(() => 'globalHandlers'),
    linkedErrorsIntegration: vi.fn(() => 'linkedErrors'),
    dedupeIntegration: vi.fn(() => 'dedupe'),
    eventFiltersIntegration: vi.fn(() => 'eventFilters'),
  };
}

let injected: HTMLScriptElement[] = [];
const defineGlobal = (sdk: object | undefined) => {
  (window as unknown as Record<string, unknown>).__FlowpadSentry = sdk;
};
/** The browser finished fetching script #n: it ran (defining the global, or not) and fired `load`. */
const loaded = (n: number, sdk?: object) => {
  defineGlobal(sdk);
  injected[n].onload?.(new Event('load'));
};

beforeEach(() => {
  __testing.reset();
  defineGlobal(undefined);
  injected = [];
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    if (node instanceof HTMLScriptElement) injected.push(node);
    return node;
  });
  setBootstrap(null);
});

afterEach(async () => {
  for (const el of injected) el.onerror?.(new Event('error')); // release any script a test left "loading"
  vi.restoreAllMocks();
  setBootstrap(null);
  await settle();
  defineGlobal(undefined);
  (privacyManager as unknown as { _apply(mode: string): void })._apply('connected');
});

describe('where the script comes from', () => {
  it.each([
    ['a sandbox: its hub, origin only', 'sandbox', { desktop_info: { cloud_app_url: `${HUB}/some/path?x=1#y` } }, 'https://x', SDK_URL],
    ['a local dev hub over http', 'sandbox', { desktop_info: { cloud_app_url: 'http://localhost:9007' } }, 'https://x', 'http://localhost:9007/api/v1/sentry-sdk/browser'],
    ['the hub UI: its own origin', 'hub', {}, 'https://hub.example.test', 'https://hub.example.test/api/v1/sentry-sdk/browser'],
  ])('%s', (_label, kind, boot, pageOrigin, expected) => {
    expect(sdkUrlFor(kind as 'hub' | 'sandbox', boot, pageOrigin)).toBe(expected);
  });

  it.each([
    ['http to a real host', { desktop_info: { cloud_app_url: 'http://app.example.test' } }],
    ['credentials in the URL', { desktop_info: { cloud_app_url: 'https://user:pw@app.example.test' } }],
    ['a javascript: URL', { desktop_info: { cloud_app_url: 'javascript:alert(1)' } }],
    ['another scheme', { desktop_info: { cloud_app_url: 'ftp://app.example.test' } }],
    ['not a URL', { desktop_info: { cloud_app_url: 'not a url' } }],
    ['no hub origin in the bootstrap', {}],
    ['a non-string origin', { desktop_info: { cloud_app_url: { href: HUB } } }],
  ])('refuses %s', (_label, boot) => {
    expect(sdkUrlFor('sandbox', boot, 'https://x')).toBeNull();
  });

  it('the hub UI refuses to load from an unsafe page origin', () => {
    expect(sdkUrlFor('hub', {}, 'http://evil.example.test')).toBeNull();
  });

  it('never takes the script from sentry_info, whatever it says', async () => {
    const info = { dsn: DSN_A, environment: 'staging', script_url: 'https://evil.example/x.js', sdk_url: 'https://evil.example/y.js', src: 'https://evil.example/z.js' };
    expect(effectiveConfig(bootstrap({}, info), false)?.sdkUrl).toBe(SDK_URL);
    startSentryReaction();
    setBootstrap(bootstrap({}, info));
    await tick();
    expect(injected.map((el) => el.src)).toEqual([SDK_URL]);
  });

  it('a sandbox that does not know its hub stays off and requests nothing', async () => {
    startSentryReaction();
    setBootstrap(bootstrap({ desktop_info: {} }));
    await tick();
    expect(injected).toEqual([]);
    expect(__testing.activeConfig()).toBeNull();
  });
});

describe('loading it', () => {
  it('requests the script once, without the page URL, and starts Sentry only after it ran', async () => {
    const sdk = fakeSdk();
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    expect(injected).toHaveLength(1);
    expect(injected[0].src).toBe(SDK_URL);
    expect(injected[0].referrerPolicy).toBe('no-referrer');
    expect(sdk.init).not.toHaveBeenCalled();
    expect(__testing.activeConfig()).toBeNull();

    loaded(0, sdk);
    await settle();
    expect(sdk.init).toHaveBeenCalledOnce();
    const options = sdk.init.mock.calls[0][0];
    expect(options).toMatchObject({ dsn: DSN_A, environment: 'staging', defaultIntegrations: false, tracesSampleRate: 0, maxBreadcrumbs: 0 });
    expect(typeof options.beforeSend).toBe('function');
    expect(__testing.activeConfig()?.sdkUrl).toBe(SDK_URL);
  });

  it('reuses a global that is already there instead of fetching it again', async () => {
    const sdk = fakeSdk();
    defineGlobal(sdk);
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    expect(injected).toEqual([]);
    expect(sdk.init).toHaveBeenCalledOnce();
  });

  it.each([
    ['the hub answered something that is not the SDK (an older hub serves its HTML shell)', undefined],
    ['a script that speaks another contract', fakeSdk(2)],
    ['a script missing part of the surface', { contract: 1, init: vi.fn() }],
  ])('%s: stays off, and is not asked again', async (_label, answer) => {
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    loaded(0, answer);
    await settle();
    expect(__testing.activeConfig()).toBeNull();
    // A later reconcile (here: a different DSN on the same hub) must not re-request the failed script.
    setBootstrap(bootstrap({}, { dsn: DSN_B, environment: 'staging' }));
    await tick();
    expect(injected).toHaveLength(1);
  });

  it('a script that fails to load leaves Sentry off without throwing', async () => {
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    injected[0].onerror?.(new Event('error'));
    await settle();
    expect(__testing.activeConfig()).toBeNull();
  });

  it('never loads for a desktop, or without a sentry_info', async () => {
    startSentryReaction();
    setBootstrap(bootstrap({ runtime: { kind: 'desktop' } }));
    await tick();
    setBootstrap(bootstrap({}, null as unknown as Record<string, unknown>));
    await tick();
    expect(injected).toEqual([]);
  });
});

describe('the config changes while the script is still loading', () => {
  it('turned off in the meantime: nothing starts when it arrives', async () => {
    const sdk = fakeSdk();
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    setBootstrap(bootstrap({}, null as unknown as Record<string, unknown>));
    await tick();
    loaded(0, sdk);
    await settle();
    expect(sdk.init).not.toHaveBeenCalled();
    expect(__testing.activeConfig()).toBeNull();
  });

  it('Local privacy in the meantime: nothing starts when it arrives', async () => {
    const sdk = fakeSdk();
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    (privacyManager as unknown as { _apply(mode: string): void })._apply('local');
    loaded(0, sdk);
    await settle();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it('another DSN in the meantime: only the newest is started, from one script', async () => {
    const sdk = fakeSdk();
    startSentryReaction();
    setBootstrap(bootstrap());
    await tick();
    setBootstrap(bootstrap({}, { dsn: DSN_B, environment: 'production' }));
    await tick();
    loaded(0, sdk);
    await settle();
    expect(injected).toHaveLength(1);
    expect(sdk.init).toHaveBeenCalledOnce();
    expect(sdk.init.mock.calls[0][0]).toMatchObject({ dsn: DSN_B, environment: 'production' });
  });
});
