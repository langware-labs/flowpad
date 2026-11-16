/**
 * Browser error reporting — errors only, privacy first, never in the way.
 *
 * Driven by state the existing bootstrap lifecycle already writes, never by a fetch of its own:
 * `dataContext.bootstrapInfo` (written by `initSdk`, `refreshSession`, and a sandbox's live
 * `sentry_info_msg`) and the privacy mode. Whenever the effective config changes, Sentry is
 * started, restarted with the new DSN/environment, or closed — no reload.
 *
 * On only when ALL hold: the backend sent a valid `sentry_info`, the page is the hub or a sandbox
 * (a desktop's bootstrap always sends null), and privacy mode is not Local ("nothing may leave the
 * box"). The SDK is a lazy chunk (`./sentry-sdk`): a desktop never downloads it.
 *
 * Privacy: no replay, no tracing, no breadcrumbs, no data collection (`dataCollection`, v11's
 * successor to `sendDefaultPii: false`). Every event is REBUILT from an
 * allowlist (`sanitizeEvent`) — the error message is never sent, because a message can carry a
 * prompt or file contents — and then scanned; anything that still looks sensitive drops the whole
 * event. Any failure in here is swallowed: reporting must never affect the app.
 */

import type { ErrorEvent, EventHint } from '@sentry/browser';
import { comparer, reaction } from 'mobx';
import { dataContext, privacyManager, type SentryInfo } from '@sdk';

declare const __UI_VERSION__: string | undefined;

type SentryModule = typeof import('./sentry-sdk');
type RuntimeKindReported = 'hub' | 'sandbox';
export type ErrorSite = 'router' | 'boundary';

export interface EffectiveConfig {
  dsn: string;
  environment: SentryInfo['environment'];
  runtimeKind: RuntimeKindReported;
}

// Kept identical to `_DSN` in flow_sdk/schema/data_spec/sentry_info_spec.py (two runtimes, one rule): change both together.
const DSN_RE = /^https:\/\/[0-9a-f]{16,64}@[a-z0-9.-]+(?::\d{1,5})?\/\d{1,20}$/;
const ENVIRONMENTS = new Set(['development', 'staging', 'production']);

export function isValidSentryInfo(value: unknown): value is SentryInfo {
  if (!value || typeof value !== 'object') return false;
  const { dsn, environment } = value as Record<string, unknown>;
  return typeof dsn === 'string' && DSN_RE.test(dsn) && typeof environment === 'string' && ENVIRONMENTS.has(environment);
}

/** What Sentry should be running with right now, or `null` for off. Pure. */
export function effectiveConfig(bootstrap: unknown, isLocal: boolean): EffectiveConfig | null {
  if (isLocal || !bootstrap || typeof bootstrap !== 'object') return null;
  const info = bootstrap as { sentry_info?: unknown; runtime?: { kind?: unknown } };
  const kind = info.runtime?.kind;
  if (kind !== 'hub' && kind !== 'sandbox') return null;
  if (!isValidSentryInfo(info.sentry_info)) return null;
  return { dsn: info.sentry_info.dsn, environment: info.sentry_info.environment, runtimeKind: kind };
}

// ── the sanitizer ─────────────────────────────────────────────────────────────────────

const TYPE_RE = /^[A-Za-z_$][\w$]{0,63}$/;
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
      type: typeof mechanism.type === 'string' && TYPE_RE.test(mechanism.type) ? mechanism.type : 'generic',
      handled: mechanism.handled === true,
    },
    ...(frames.length ? { stacktrace: { frames: frames.slice(-MAX_FRAMES).map(scrubFrame) } } : {}),
  };
}

/** `app:///<first segment>/…` — the area of the app, never the entity, file or query. */
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
export function sanitizeEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
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
    exception: { values: values.slice(-MAX_EXCEPTIONS).map((v) => scrubException(v as Record<string, unknown>)) },
    tags: {
      ...(runtimeKind === 'hub' || runtimeKind === 'sandbox' ? { runtime_kind: runtimeKind } : {}),
      ...(typeof where === 'string' && SITES.has(where) ? { where } : {}),
    },
    request: { url: sanitizeUrl(event.request?.url) },
    ...(facts ? { contexts: { flowpad_error: facts } } : {}),
    ...(event.sdk ? { sdk: { name: event.sdk.name, version: event.sdk.version } } : {}),
  } as ErrorEvent;
  return passesDenyScan(out) ? out : null;
}

function safeSanitize(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  // Local privacy means nothing may leave the machine. The lifecycle below reacts to the toggle
  // asynchronously (and `close` would still flush what is queued), so the decision is also taken
  // here, synchronously, at the moment an event would be sent. Events already on the wire cannot be
  // recalled; nothing new gets there.
  if (privacyManager.isLocal) return null;
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

let sentry: SentryModule | null = null;
let active: EffectiveConfig | null = null;
let queue: Promise<void> = Promise.resolve();
let started = false;

/** Test seams: the module loader and a transport, so tests run the real SDK without a network. */
export const __testing = {
  load: (): Promise<SentryModule> => import('./sentry-sdk'),
  transport: undefined as NonNullable<Parameters<SentryModule['init']>[0]>['transport'],
  activeConfig: (): EffectiveConfig | null => active,
  settled: (): Promise<void> => queue,
  reset(): void {
    sentry = null;
    active = null;
    queue = Promise.resolve();
    started = false;
  },
};

function sameConfig(a: EffectiveConfig | null, b: EffectiveConfig | null): boolean {
  return a?.dsn === b?.dsn && a?.environment === b?.environment && a?.runtimeKind === b?.runtimeKind;
}

async function applyConfig(next: EffectiveConfig | null): Promise<void> {
  if (sameConfig(active, next)) return;
  if (active && sentry) {
    const previous = sentry.getClient();
    active = null;
    try {
      await previous?.close(2000);
    } catch {
      /* closing is best-effort */
    }
  }
  if (!next) return;
  try {
    const mod = (sentry ??= await __testing.load());
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
  const next = effectiveConfig(dataContext.bootstrapInfo, privacyManager.isLocal);
  queue = queue.then(() => applyConfig(next)).catch(() => undefined);
}

/**
 * Follow the effective config for the life of the page. Call once at startup, before the router
 * renders: it fires immediately (off until `initSdk` stores the bootstrap) and again on every
 * later write — sign-in refresh, a sandbox's live `sentry_info_msg`, a privacy toggle.
 */
export function startSentryReaction(): void {
  if (started) return;
  started = true;
  try {
    reaction(
      () => [dataContext.bootstrapInfo?.sentry_info, dataContext.bootstrapInfo?.runtime?.kind],
      reconcile,
      { fireImmediately: true, equals: comparer.structural },
    );
    privacyManager.on('privacy_mode_changed', reconcile);
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
