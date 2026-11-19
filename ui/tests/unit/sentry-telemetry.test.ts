/**
 * Browser error reporting, driven end to end through the REAL `@sentry/browser` with an in-memory
 * transport: what reaches the wire, to which DSN, and what never does.
 */
import { createTransport } from '@sentry/browser';
import type { ErrorEvent } from '@sentry/browser';
import { runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataContext, privacyManager } from '@sdk';
import {
  __testing,
  effectiveConfig,
  reportError,
  sanitizeEvent,
  sanitizeUrl,
  startSentryReaction,
} from '@src/telemetry/sentry';
import { realSdk } from './_real_sentry_sdk';

const DSN_A = 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/11';
const DSN_B = 'https://fedcba9876543210fedcba9876543210@o1.ingest.us.sentry.io/22';

interface Sent {
  url: string;
  event: Record<string, any>;
}
let sent: Sent[] = [];

/** Every event the SDK put on the wire, with the URL (i.e. the DSN's project) it went to. */
function captureTransport(options: { url: string }) {
  return createTransport(options as any, (request) => {
    const body = typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body);
    const lines = body.split('\n').filter(Boolean);
    for (let i = 1; i < lines.length; i += 2) {
      if (JSON.parse(lines[i]).type === 'event') sent.push({ url: options.url, event: JSON.parse(lines[i + 1]) });
    }
    return Promise.resolve({ statusCode: 200 });
  });
}

function setBootstrap(info: Record<string, unknown> | null) {
  runInAction(() => {
    dataContext.bootstrapInfo = info;
  });
}

const HUB = 'https://app.example.test';
const sandbox = (sentry_info: unknown) => ({
  runtime: { kind: 'sandbox' },
  desktop_info: { cloud_app_url: HUB },
  sentry_info,
});
const settle = async () => {
  for (let i = 0; i < 3; i++) await __testing.settled();
};
async function boom(message = 'boom') {
  reportError(new Error(message), 'boundary');
  await realSdk.getClient()?.flush(1000);
}

beforeEach(() => {
  sent = [];
  __testing.reset();
  __testing.backendOrigin = () => null; // the unit tier has no backend; the page origin stands in
  __testing.transport = captureTransport as any;
  __testing.load = () => Promise.resolve(realSdk); // the hub's script is not reachable here
  setBootstrap(null);
});

afterEach(async () => {
  setBootstrap(null);
  await settle();
  (privacyManager as any)._apply('connected');
  (privacyManager as any)._initialized = false; // seeding is once per page load; a test must not leak it
});

describe('which pages report', () => {
  it.each([
    ['desktop', { runtime: { kind: 'desktop' }, sentry_info: { dsn: DSN_A, environment: 'staging' } }],
    ['agent', { runtime: { kind: 'agent' }, sentry_info: { dsn: DSN_A, environment: 'staging' } }],
    ['sandbox, null', sandbox(null)],
    ['sandbox, absent (older backend)', { runtime: { kind: 'sandbox' } }],
    ['sandbox, secret DSN', sandbox({ dsn: 'https://k:s@o1.sentry.io/1', environment: 'staging' })],
    ['sandbox, unknown env', sandbox({ dsn: DSN_A, environment: 'local' })],
  ])('%s: off', (_label, bootstrap) => {
    expect(effectiveConfig(bootstrap, false)).toBeNull();
  });

  it('hub and sandbox with a valid value: on, unless privacy mode is Local', () => {
    const info = { dsn: DSN_A, environment: 'production' };
    expect(effectiveConfig({ runtime: { kind: 'hub' }, sentry_info: info }, false)?.runtimeKind).toBe('hub');
    expect(effectiveConfig(sandbox(info), false)?.dsn).toBe(DSN_A);
    expect(effectiveConfig(sandbox(info), true)).toBeNull();
  });
});

describe('runtime configuration changes, without a reload', () => {
  it('starts, keeps, swaps and stops with the bootstrap it follows', async () => {
    startSentryReaction();
    await settle();
    expect(__testing.activeConfig()).toBeNull();

    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    await boom();
    expect(sent.map((s) => [s.url.includes('/11/'), s.event.environment])).toEqual([[true, 'staging']]);
    expect(sent[0].event.tags).toEqual({ runtime_kind: 'sandbox', where: 'boundary' });

    // A live `sentry_info.changed` lands through `applySentryInfo`: same value, no restart.
    const before = realSdk.getClient();
    dataContext.applySentryInfo({ dsn: DSN_A, environment: 'staging' });
    await settle();
    expect(realSdk.getClient()).toBe(before);

    // A new DSN and environment: the next event goes only to B.
    dataContext.applySentryInfo({ dsn: DSN_B, environment: 'production' });
    await settle();
    sent = [];
    await boom();
    expect(sent.map((s) => [s.url.includes('/22/'), s.event.environment])).toEqual([[true, 'production']]);

    // Removed: nothing is sent any more, even straight through the SDK.
    dataContext.applySentryInfo(null);
    await settle();
    sent = [];
    await boom();
    realSdk.captureException(new Error('after close'));
    await realSdk.getClient()?.flush(500);
    expect(sent).toEqual([]);
  });

  it('a Local privacy toggle stops reporting and Connected brings it back', async () => {
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    (privacyManager as any)._apply('local');
    await settle();
    expect(__testing.activeConfig()).toBeNull();
    (privacyManager as any)._apply('connected');
    await settle();
    expect(__testing.activeConfig()?.dsn).toBe(DSN_A);
  });

  it('a fresh bootstrap (a sign-in refresh) re-seeds the privacy manager, so a missed live message cannot keep reporting on', async () => {
    privacyManager.seedBootstrap('connected');
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    expect(__testing.activeConfig()?.dsn).toBe(DSN_A);
    privacyManager.adoptBootstrap('local'); // the backend says Local now; the live message never arrived
    await settle();
    expect(__testing.activeConfig()).toBeNull();
    privacyManager.adoptBootstrap('connected');
    await settle();
    expect(__testing.activeConfig()?.dsn).toBe(DSN_A);
  });

  it('Local privacy drops an event at send time, before the lifecycle has even stopped Sentry', async () => {
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    expect(__testing.activeConfig()?.dsn).toBe(DSN_A);

    // The toggle's reconcile is queued but has NOT run: Sentry is still active here, and `close`
    // would flush whatever is pending. An error in this window must still not leave.
    (privacyManager as any)._apply('local');
    expect(__testing.activeConfig()?.dsn).toBe(DSN_A);
    reportError(new Error('captured right after the user chose Local'), 'boundary');
    await realSdk.getClient()?.flush(1000);
    await settle();
    expect(sent).toEqual([]);
  });

  it('a Sentry that fails to load never reaches the app', async () => {
    __testing.load = () => Promise.reject(new Error('chunk failed'));
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    expect(__testing.activeConfig()).toBeNull();
    expect(() => reportError(new Error('x'), 'router')).not.toThrow();
  });
});

describe('review follow-ups', () => {
  it('tells Sentry not to infer the visitor\'s IP: `sdk.settings.infer_ip` survives the sanitizer', async () => {
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    await boom();
    expect(sent).toHaveLength(1);
    expect(sent[0].event.sdk?.settings?.infer_ip).toBe('never');
  });

  it('Local privacy in the bootstrap payload itself keeps Sentry off before the privacy manager is seeded', async () => {
    // `initSdk` stores the bootstrap, and only a few awaits later seeds the privacy manager from it:
    // in between, the manager still says "connected" although the payload says "local".
    expect(privacyManager.initialized).toBe(false);
    startSentryReaction();
    setBootstrap({ ...sandbox({ dsn: DSN_A, environment: 'staging' }), privacy_mode: 'local' });
    await settle();
    expect(__testing.activeConfig()).toBeNull();
    reportError(new Error('x'), 'boundary');
    expect(sent).toEqual([]);
  });

  it('resetting stops the reaction and its privacy listener, so tests do not stack them', () => {
    const baseline = privacyManager.listenerCount('privacy_mode_changed');
    startSentryReaction();
    expect(privacyManager.listenerCount('privacy_mode_changed')).toBe(baseline + 1);
    __testing.reset();
    expect(privacyManager.listenerCount('privacy_mode_changed')).toBe(baseline);
  });
});

describe('privacy-sensitive exception payloads', () => {
  const prompt =
    'Please summarise the attached contract for ACME and include the salary of every employee listed';
  const fileContents = 'export const OPENAI_KEY = "sk-live-abcdef123456";\nfunction secret() {}';

  it.each([
    ['a prompt', prompt],
    ['file contents', fileContents],
    ['a JWT', 'auth failed for eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl'],
    ['an email', 'no account for jane.doe@example.com'],
    ['a local path', 'ENOENT /Users/jane/projects/secret-plan.md'],
  ])('%s never leaves the browser', async (_label, message) => {
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    await boom(message);
    expect(sent).toHaveLength(1);
    const wire = JSON.stringify(sent[0].event);
    expect(wire).not.toContain(message.slice(0, 20));
    expect(sent[0].event.exception.values[0].value).toBe('[redacted]');
    expect(sent[0].event.user).toBeUndefined();
    expect(sent[0].event.breadcrumbs).toBeUndefined();
  });

  it('the real browser paths (uncaught error, unhandled rejection) are redacted too', async () => {
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    const err = Object.assign(new Error(prompt), { status: 503 });
    // The handlers Sentry's globalHandlers integration installed -- what a browser invokes.
    (globalThis as any).onerror(prompt, 'https://9007-abc.e2b.app/assets/index-abc123.js?ticket=zzz', 10, 5, err);
    (globalThis as any).onunhandledrejection({ reason: { prompt, file: fileContents }, promise: Promise.resolve() });
    await realSdk.getClient()?.flush(1000);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const wire = JSON.stringify(sent.map((s) => s.event));
    for (const secret of [prompt.slice(0, 20), 'sk-live', 'ticket=', 'OPENAI_KEY', 'e2b.app']) {
      expect(wire).not.toContain(secret);
    }
    for (const { event } of sent) {
      expect(event.exception.values.every((v: any) => v.value === '[redacted]')).toBe(true);
      expect(event.extra).toBeUndefined();
      expect(event.user).toBeUndefined();
      expect(event.request).toEqual({ url: 'app:///' });
    }
  });

  const base = (over: Partial<ErrorEvent> = {}): ErrorEvent =>
    ({
      type: undefined,
      event_id: 'e1',
      environment: 'staging',
      exception: { values: [{ type: 'TypeError', value: prompt, stacktrace: { frames: [] } }] },
      ...over,
    }) as ErrorEvent;

  it('keeps the SDK\'s dotted mechanism name, and nothing free-form in its place', () => {
    const mech = (type: string) =>
      sanitizeEvent(base({ exception: { values: [{ type: 'Error', value: prompt, mechanism: { type } }] } }))!.exception!
        .values![0].mechanism;
    expect(mech('auto.browser.global_handlers.onerror')).toEqual({ type: 'auto.browser.global_handlers.onerror', handled: false });
    expect(mech('see /Users/me/secret')).toEqual({ type: 'generic', handled: false });
  });

  it('keeps only the allowlist and structured facts', () => {
    const err = Object.assign(new Error(prompt), { status: 503, code: 'HUB_DOWN', body: prompt });
    const out = sanitizeEvent(
      base({
        user: { email: 'a@b.co' },
        extra: { body: prompt },
        breadcrumbs: [{ message: prompt }],
        request: { url: 'https://9007-abc.e2b.app/dock/file/secret.md?ticket=xyz#frag', headers: { Cookie: 'c' } },
        contexts: { browser: { name: 'x' } },
        tags: { where: 'boundary', runtime_kind: 'sandbox', other: 'x' },
      }),
      { originalException: err },
    )!;
    // What goes on the wire (undefined keys never serialize).
    expect(Object.keys(JSON.parse(JSON.stringify(out))).sort()).toEqual(
      ['contexts', 'environment', 'event_id', 'exception', 'level', 'platform', 'request', 'sdk', 'tags'].sort(),
    );
    expect(out.sdk).toEqual({ settings: { infer_ip: 'never' } }); // even for an event that carried no `sdk`
    expect(out.request).toEqual({ url: 'app:///dock/…' });
    expect(out.contexts).toEqual({ flowpad_error: { name: 'Error', status: 503, code: 'HUB_DOWN' } });
    expect(out.tags).toEqual({ runtime_kind: 'sandbox', where: 'boundary' });
  });

  it('frames keep only our bundle files, without the origin', () => {
    const out = sanitizeEvent(
      base({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'x',
              stacktrace: {
                frames: [
                  { filename: 'https://9007-abc.e2b.app/assets/index-a1b2.js?v=1', function: 'render', lineno: 3, colno: 9 },
                  { filename: 'blob:https://x/123', function: 'evil fn name with spaces', lineno: 1 },
                ],
              },
            },
          ],
        },
      }),
    )!;
    expect(out.exception!.values![0].stacktrace!.frames).toEqual([
      { filename: 'app:///assets/index-a1b2.js', function: 'render', lineno: 3, colno: 9 },
      { lineno: 1 },
    ]);
  });

  it('says that an event was dropped without saying anything about it', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    startSentryReaction();
    setBootstrap(sandbox({ dsn: DSN_A, environment: 'staging' }));
    await settle();
    // Not an exception, so the sanitizer drops it; its text must not reach the log either.
    (realSdk.getClient() as unknown as { captureEvent(e: object): void } | undefined)?.captureEvent({ message: prompt });
    await realSdk.getClient()?.flush(1000);
    expect(sent).toEqual([]);
    const lines = debug.mock.calls.map((call) => call.join(' '));
    expect(lines.some((line) => line.includes('dropped by the sanitizer'))).toBe(true);
    expect(lines.join('\n')).not.toContain(prompt.slice(0, 20));
    debug.mockRestore();
  });

  it('fails closed', () => {
    expect(sanitizeEvent({ type: undefined, message: prompt } as ErrorEvent)).toBeNull(); // not an exception
    // An allowed field still carrying something sensitive drops the whole event.
    expect(sanitizeEvent(base({ release: 'token=abc' }))).toBeNull();
    expect(sanitizeEvent(base({ environment: 'x'.repeat(500) }))).toBeNull();
    expect(sanitizeUrl('not a url at all %%%')).toMatch(/^app:\/\/\//);
  });
});
