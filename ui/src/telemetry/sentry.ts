/**
 * Browser error reporting — errors only, privacy first, never in the way.
 *
 * Driven by state the existing bootstrap lifecycle already writes, never by a fetch of its own:
 * `dataContext.bootstrapInfo` (written by `initSdk`, `refreshSession`, and a sandbox's live
 * `sentry_info.changed`) and the privacy mode. Whenever the effective config changes, Sentry is
 * started, restarted with the new DSN/environment, or closed — no reload.
 *
 * On only when ALL hold: the backend sent a valid `sentry_info`, the page is the hub or a sandbox
 * (a desktop's bootstrap always sends null), privacy mode is not Local ("nothing may leave the
 * box"), and the hub's origin is known and safe.
 *
 * The SDK is NOT part of this open-source bundle. It is loaded at runtime from the hub, at the fixed
 * path `SDK_PATH` on the hub's own origin (the hub UI: its own origin; a sandbox, which runs this
 * OSS wheel and cannot serve it: `desktop_info.cloud_app_url`). Nothing in `sentry_info` -- or any other
 * config -- names a script URL, because a URL in config would run whatever script it points to. A
 * desktop never loads it. A hub that cannot serve it (down, older) just leaves Sentry off.
 *
 * Privacy: no replay, no tracing, no breadcrumbs, no data collection (`dataCollection`, v11's
 * successor to `sendDefaultPii: false`; its `infer_ip: 'never'` is carried onto the wire by the
 * sanitizer). Every event is REBUILT from an
 * allowlist (`sanitizeEvent`) — the error message is never sent, because a message can carry a
 * prompt or file contents — and then scanned; anything that still looks sensitive drops the whole
 * event. Any failure in here is swallowed: reporting must never affect the app.
 */

import { comparer, reaction } from 'mobx';
import { backendOrigin, dataContext, privacyManager, RuntimeKind, SentryEnvironment, type SentryInfo } from '@sdk';
import {
  SDK_CONTRACT,
  SDK_GLOBAL,
  SDK_PATH,
  type SentryEventLike,
  type SentryHintLike,
  type SentrySdk,
} from './sentry-contract';

declare const __UI_VERSION__: string | undefined;

type RuntimeKindReported = RuntimeKind.HUB | RuntimeKind.SANDBOX;
export type ErrorSite = 'router' | 'boundary';

export interface EffectiveConfig {
  dsn: string;
  environment: SentryInfo['environment'];
  runtimeKind: RuntimeKindReported;
  /** The hub's SDK script: the hub's own origin + the fixed `SDK_PATH`. */
  sdkUrl: string;
}

// Kept identical to `_DSN` in flow_sdk/schema/data_spec/sentry_info_spec.py (two runtimes, one rule): change both together.
const DSN_RE = /^https:\/\/[0-9a-f]{16,64}@[a-z0-9.-]+(?::[0-9]{1,5})?\/[0-9]{1,20}$/;
const ENVIRONMENTS = new Set<string>(Object.values(SentryEnvironment));

/**
 * Whether privacy mode is Local right now. The manager is seeded from the bootstrap payload a few
 * awaits AFTER `initSdk` stores it, and until then it only holds its default ("connected") -- so
 * until it is seeded the payload itself is the answer. After that the manager alone decides, which
 * is what lets a live toggle back to Connected turn reporting on again.
 */
function privacyIsLocal(): boolean {
  if (privacyManager.isLocal) return true;
  if (privacyManager.initialized) return false;
  return (dataContext.bootstrapInfo as { privacy_mode?: unknown } | null | undefined)?.privacy_mode === 'local';
}

export function isValidSentryInfo(value: unknown): value is SentryInfo {
  if (!value || typeof value !== 'object') return false;
  const { dsn, environment } = value as Record<string, unknown>;
  return typeof dsn === 'string' && DSN_RE.test(dsn) && typeof environment === 'string' && ENVIRONMENTS.has(environment);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where the hub's SDK script is: the hub's origin + the fixed path, or `null` when the origin is
 * unknown or not safe to run a script from (not https -- a local dev hub excepted -- or carrying
 * credentials). `pageOrigin` is the hub's own origin for a hub UI (the SDK config layer's backend
 * origin, so a split dev harness asks the hub and not the Vite port); a sandbox learns its hub from the
 * bootstrap (`desktop_info.cloud_app_url`, the hub's browser-app origin).
 */
export function sdkUrlFor(kind: RuntimeKindReported, bootstrap: unknown, pageOrigin: string): string | null {
  const raw =
    kind === RuntimeKind.HUB ? pageOrigin : (bootstrap as { desktop_info?: { cloud_app_url?: unknown } })?.desktop_info?.cloud_app_url;
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const safe = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!safe || url.username || url.password) return null;
  return url.origin + SDK_PATH;
}

/** What Sentry should be running with right now, or `null` for off. Pure. */
export function effectiveConfig(bootstrap: unknown, isLocal: boolean): EffectiveConfig | null {
  if (isLocal || !bootstrap || typeof bootstrap !== 'object') return null;
  const info = bootstrap as { sentry_info?: unknown; runtime?: { kind?: unknown } };
  const kind = info.runtime?.kind;
  if (kind !== RuntimeKind.HUB && kind !== RuntimeKind.SANDBOX) return null;
  if (!isValidSentryInfo(info.sentry_info)) return null;
  const sdkUrl = sdkUrlFor(kind, bootstrap, __testing.backendOrigin() ?? window.location.origin);
  if (!sdkUrl) return null;
  return { dsn: info.sentry_info.dsn, environment: info.sentry_info.environment, runtimeKind: kind, sdkUrl };
}

// ── the sanitizer ─────────────────────────────────────────────────────────────────────

const TYPE_RE = /^[A-Za-z_$][\w$]{0,63}$/;
/** The SDK's own dotted names (`auto.browser.global_handlers.onerror`): letters, digits, `_` and dots. */
const MECHANISM_RE = /^[A-Za-z_][\w]{0,31}(?:\.[A-Za-z_]\w{0,31}){0,5}$/;
const FUNCTION_RE = /^[\w$.<>]{1,80}$/;
const ASSET_RE = /\/assets\/([\w.-]{1,120}\.m?js)(?:[?#].*)?$/;
const SEGMENT_RE = /^[a-z-]{1,20}$/;
const CODE_RE = /^[A-Z0-9_]{1,40}$/;
const SITES = new Set<string>(['router', 'boundary']);
const MAX_FRAMES = 50;
const MAX_EXCEPTIONS = 3;
const MAX_STRING = 200;
const REDACTED = '[redacted]';

/** Last line of defence: one hit anywhere in the rebuilt event drops it. */
const DENY: RegExp[] = [
  /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/, // JWT
  /bearer\s/i,
  /\bsk-[\w-]{6,}/i,
  /flowpad-api-key/i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
  /\/Users\/|\/home\/|[A-Za-z]:\\/, // a local path
  /\b(?:ticket|token|grant|secret|password|api[_-]?key|code)=/i,
  /(?:[A-Za-z]{2,}[\s,;:]+){6,}/, // prose: six words in a row
];

function scrubFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof frame.function === 'string' && FUNCTION_RE.test(frame.function)) out.function = frame.function;
  if (typeof frame.lineno === 'number') out.lineno = frame.lineno;
  if (typeof frame.colno === 'number') out.colno = frame.colno;
  if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app;
  const asset = typeof frame.filename === 'string' ? ASSET_RE.exec(frame.filename) : null;
  // Only our own bundle files, and without the origin: a sandbox's hostname names the box.
  if (asset) out.filename = `app:///assets/${asset[1]}`;
  return out;
}

function scrubException(value: Record<string, unknown>): Record<string, unknown> {
  const mechanism = (value.mechanism ?? {}) as Record<string, unknown>;
  const frames = ((value.stacktrace as { frames?: unknown[] } | undefined)?.frames ?? []).filter(
    (f): f is Record<string, unknown> => !!f && typeof f === 'object',
  );
  return {
    type: typeof value.type === 'string' && TYPE_RE.test(value.type) ? value.type : 'Error',
    // Never the message: it can carry a prompt, a file, a response body.
    value: REDACTED,
    mechanism: {
      type: typeof mechanism.type === 'string' && MECHANISM_RE.test(mechanism.type) ? mechanism.type : 'generic',
      handled: mechanism.handled === true,
    },
    ...(frames.length ? { stacktrace: { frames: frames.slice(-MAX_FRAMES).map(scrubFrame) } } : {}),
  };
}

/**
 * `app:///<first segment>/…` — the area of the app, never the entity, file or query.
 *
 * With `defaultIntegrations: false` no request integration runs, so the SDK does not set
 * `event.request.url` and in practice this answers `app:///`. It stays so that whatever URL an
 * integration may later provide is reduced here and never forwarded as it came.
 */
export function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== 'string') return 'app:///';
  let path = '/';
  try {
    path = new URL(raw, 'http://x').pathname;
  } catch {
    return 'app:///';
  }
  const [first, ...rest] = path.split('/').filter(Boolean);
  if (!first) return 'app:///';
  return `app:///${SEGMENT_RE.test(first) ? first : '…'}${rest.length ? '/…' : ''}`;
}

/** Structured, safe facts about the error itself: its class name and machine codes only. */
function structuredError(original: unknown): Record<string, unknown> | undefined {
  if (!original || typeof original !== 'object') return undefined;
  const err = original as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof err.name === 'string' && TYPE_RE.test(err.name)) out.name = err.name;
  const status = typeof err.status === 'number' ? err.status : err.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) out.status = status;
  const code = typeof err.code === 'string' ? err.code : err.error_code;
  if (typeof code === 'string' && CODE_RE.test(code)) out.code = code;
  return Object.keys(out).length ? out : undefined;
}

function passesDenyScan(event: unknown): boolean {
  let ok = true;
  JSON.stringify(event, (_key, v) => {
    if (typeof v === 'string' && (v.length > MAX_STRING || DENY.some((re) => re.test(v)))) ok = false;
    return v;
  });
  return ok;
}

/**
 * Rebuild `event` from the allowlist, or `null` to drop it. Anything not named below — the
 * message, `extra`, `user`, `breadcrumbs`, headers, cookies, request data, other contexts — is
 * never copied. An event that is not an exception is dropped.
 */
export function sanitizeEvent(event: SentryEventLike, hint?: SentryHintLike): SentryEventLike | null {
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const where = event.tags?.where;
  const runtimeKind = event.tags?.runtime_kind;
  const facts = structuredError(hint?.originalException);
  const out = {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'javascript',
    level: event.level === 'fatal' ? 'fatal' : 'error',
    environment: event.environment,
    release: event.release,
    exception: { values: values.slice(-MAX_EXCEPTIONS).map((v) => scrubException(v)) },
    tags: {
      ...(runtimeKind === 'hub' || runtimeKind === 'sandbox' ? { runtime_kind: runtimeKind } : {}),
      ...(typeof where === 'string' && SITES.has(where) ? { where } : {}),
    },
    request: { url: sanitizeUrl(event.request?.url) },
    ...(facts ? { contexts: { flowpad_error: facts } } : {}),
    // `infer_ip: 'never'` is the SDK's own instruction (from `dataCollection.userInfo: false`) that
    // Sentry must not infer the visitor's IP from the connection. Rebuilding `sdk` from name/version
    // alone used to drop it; it is set unconditionally so it can never be lost again.
    sdk: { ...(event.sdk ? { name: event.sdk.name, version: event.sdk.version } : {}), settings: { infer_ip: 'never' } },
  } as SentryEventLike;
  return passesDenyScan(out) ? out : null;
}

function safeSanitize(event: SentryEventLike, hint: SentryHintLike): SentryEventLike | null {
  // Local privacy means nothing may leave the machine. The lifecycle below reacts to the toggle
  // asynchronously (and `close` would still flush what is queued), so the decision is also taken
  // here, synchronously, at the moment an event would be sent. Events already on the wire cannot be
  // recalled; nothing new gets there.
  if (privacyIsLocal()) return null;
  try {
    const sanitized = sanitizeEvent(event, hint);
    // Never the content: only the fact, so the team can notice if the sanitizer starts dropping everything.
    if (!sanitized) console.debug('[sentry] an event was dropped by the sanitizer');
    return sanitized;
  } catch {
    console.debug('[sentry] an event was dropped: the sanitizer threw');
    return null; // fail closed
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────────────

let sentry: SentrySdk | null = null;
let active: EffectiveConfig | null = null;
/** What the lifecycle should be running NOW; a queued step whose config is no longer this is skipped. */
let desired: EffectiveConfig | null = null;
let queue: Promise<void> = Promise.resolve();
let started = false;
let stopReaction: (() => void) | null = null;
/**
 * Script URLs whose LOAD failed, so a privacy toggle or a DSN change does not re-request a 404. Not
 * permanent: it is cleared when the connection to the backend comes back (see `startSentryReaction`),
 * so a hub restart or a deploy that had not reached the route yet does not silence a long-lived tab.
 */
const failedLoads = new Set<string>();

function isSdk(candidate: unknown): candidate is SentrySdk {
  const sdk = candidate as Partial<SentrySdk> | null | undefined;
  return (
    !!sdk &&
    sdk.contract === SDK_CONTRACT &&
    typeof sdk.init === 'function' &&
    typeof sdk.getClient === 'function' &&
    typeof sdk.captureException === 'function' &&
    typeof sdk.globalHandlersIntegration === 'function' &&
    typeof sdk.linkedErrorsIntegration === 'function' &&
    typeof sdk.dedupeIntegration === 'function' &&
    typeof sdk.eventFiltersIntegration === 'function'
  );
}

/**
 * Load the hub's SDK script. No request leaks where the page is (`no-referrer`: a sandbox's URL
 * names the box). What came back must be the SDK AND speak this UI's contract: a hub that predates
 * the route answers its SPA shell (HTML, 200) at that path, which never defines the global. No
 * timeout is added -- a script that hangs just leaves Sentry off, and `applyConfig` re-checks the
 * desired config once it returns.
 */
function loadHubSdk(url: string): Promise<SentrySdk> {
  const present = (window as unknown as Record<string, unknown>)[SDK_GLOBAL];
  if (isSdk(present)) return Promise.resolve(present);
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.async = true;
    el.referrerPolicy = 'no-referrer';
    el.onload = () => {
      el.remove();
      const loaded = (window as unknown as Record<string, unknown>)[SDK_GLOBAL];
      if (isSdk(loaded)) resolve(loaded);
      else reject(new Error('the hub did not answer the SDK this UI speaks'));
    };
    el.onerror = () => {
      el.remove();
      reject(new Error('the SDK script could not be loaded'));
    };
    el.src = url;
    document.head.appendChild(el);
  });
}

/** Test seams: the loader and a transport, so tests run an SDK without the hub or a network. */
export const __testing = {
  load: loadHubSdk,
  backendOrigin: backendOrigin as () => string | null,
  transport: undefined as unknown,
  activeConfig: (): EffectiveConfig | null => active,
  settled: (): Promise<void> => queue,
  /** Back to a cold start: stops the reaction and its privacy listener, restores the seams. */
  reset(): void {
    stopReaction?.();
    stopReaction = null;
    sentry = null;
    active = null;
    desired = null;
    queue = Promise.resolve();
    started = false;
    failedLoads.clear();
    __testing.load = loadHubSdk;
    __testing.backendOrigin = backendOrigin;
    __testing.transport = undefined;
  },
};

function sameConfig(a: EffectiveConfig | null, b: EffectiveConfig | null): boolean {
  return (
    a?.dsn === b?.dsn && a?.environment === b?.environment && a?.runtimeKind === b?.runtimeKind && a?.sdkUrl === b?.sdkUrl
  );
}

async function applyConfig(next: EffectiveConfig | null): Promise<void> {
  if (!sameConfig(desired, next)) return; // a newer decision is queued right behind this one
  if (sameConfig(active, next)) return;
  if (active && sentry) {
    const previous = sentry.getClient();
    active = null;
    // Not awaited and given no timeout: the old client is its own object and winds itself down, and the
    // next `init` builds a fresh one. A pending event is sanitized, and `beforeSend` already refuses
    // anything once privacy is Local.
    void previous?.close().catch(() => undefined);
  }
  if (!next || failedLoads.has(next.sdkUrl)) return;
  let mod: SentrySdk;
  try {
    mod = sentry ??= await __testing.load(next.sdkUrl);
  } catch (e) {
    active = null;
    failedLoads.add(next.sdkUrl); // only a failed LOAD is remembered, not an `init` exception
    console.debug('[sentry] not started', e instanceof Error ? e.name : typeof e);
    return;
  }
  try {
    // The script may have taken a while: the config can have changed (turned off, Local, another DSN).
    if (!sameConfig(desired, next)) return;
    mod.init({
      dsn: next.dsn,
      environment: next.environment,
      release: typeof __UI_VERSION__ === 'string' && __UI_VERSION__ ? __UI_VERSION__ : undefined,
      // v11's replacement for `sendDefaultPii: false`: collect nothing about the person or the
      // traffic. The sanitizer would drop it anyway; this keeps it from being gathered at all.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
      },
      defaultIntegrations: false,
      integrations: [
        mod.globalHandlersIntegration(),
        mod.linkedErrorsIntegration({ limit: MAX_EXCEPTIONS }),
        mod.dedupeIntegration(),
        mod.eventFiltersIntegration(),
      ],
      ignoreErrors: [/ResizeObserver loop/],
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      sendClientReports: false,
      attachStacktrace: false,
      normalizeDepth: 2,
      maxValueLength: MAX_STRING,
      beforeSend: safeSanitize,
      beforeSendTransaction: () => null,
      initialScope: { tags: { runtime_kind: next.runtimeKind } },
      ...(__testing.transport ? { transport: __testing.transport } : {}),
    });
    active = next;
  } catch (e) {
    active = null;
    console.debug('[sentry] not started', e instanceof Error ? e.name : typeof e);
  }
}

function reconcile(): void {
  const next = effectiveConfig(dataContext.bootstrapInfo, privacyIsLocal());
  desired = next;
  queue = queue.then(() => applyConfig(next)).catch(() => undefined);
}

/**
 * Follow the effective config for the life of the page. Call once at startup, before the router
 * renders: it fires immediately (off until `initSdk` stores the bootstrap) and again on every
 * later write — sign-in refresh, a sandbox's live `sentry_info.changed`, a privacy toggle.
 */
export function startSentryReaction(): void {
  if (started) return;
  started = true;
  try {
    const dispose = reaction(
      () => [
        dataContext.bootstrapInfo?.sentry_info,
        dataContext.bootstrapInfo?.runtime?.kind,
        dataContext.bootstrapInfo?.privacy_mode,
        dataContext.bootstrapInfo?.desktop_info?.cloud_app_url,
      ],
      reconcile,
      { fireImmediately: true, equals: comparer.structural },
    );
    privacyManager.on('privacy_mode_changed', reconcile);
    // The backend (and with it the hub) is reachable again: give a script that failed another try.
    // No timer and no retry budget -- this only reacts to the connection coming back.
    const disposeReconnect = reaction(
      () => dataContext.localConnectionStatus === 'connected',
      (connected) => {
        if (!connected) return;
        failedLoads.clear();
        reconcile();
      },
    );
    stopReaction = () => {
      dispose();
      disposeReconnect();
      privacyManager.off('privacy_mode_changed', reconcile);
    };
  } catch {
    /* reporting must never affect startup */
  }
}

/** Report an error a boundary or the router caught (they never reach `window.onerror`). */
export function reportError(error: unknown, where: ErrorSite): void {
  if (!active || !sentry) return;
  try {
    sentry.captureException(error, { tags: { where } });
  } catch {
    /* never throw from a reporter */
  }
}
