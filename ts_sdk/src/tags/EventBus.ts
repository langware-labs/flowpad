import { v4 as uuidv4 } from 'uuid';
// Matching lives in the shared dot-taxonomy grammar (./grammar.ts), which the
// SDK barrel also re-exports (`tagMatches` et al. keep their import paths).
import { segmentsMatch } from './grammar';

/**
 * The unified event bus ("tags" system) — see docs/tags.md for the agreed
 * language. This is the APP-LOCAL slice: a plain in-process registry. Transport
 * (cross-tier bridges over the watch system) is designed but deferred; bridges,
 * when they arrive, are ordinary subscribers of this same bus.
 *
 * Naming rule: anything with `tag` in its name is the unified system;
 * `event`/`message`/`op` elsewhere is legacy.
 */

/** Which tier of the system emitted an event. Trust policy is per tier. */
export type TagOrigin = 'app' | 'local_server' | 'hub' | 'sandbox';

/** Correlation only — enriches, never gates. Routing NEVER reads ctx. */
export interface FlowEventCtx {
  /** Who caused it, in target form: `user:<id>`, `agentic_process:<id>`, `system`, `hub`. */
  actor?: string;
  /** Containment chain, innermost-first, entries in target form. */
  scope?: string[];
  /** Which tier emitted — required on every event; emit() fills `app` by default. */
  origin: TagOrigin;
}

/**
 * The envelope — `FlowEvent` is THE consolidating name for a standard event
 * anywhere in the system (docs/flow-events.md). Python twin:
 * flow_sdk/tags/envelope.py; pinned by tests/fixtures/flow_event_contract.json.
 * `tag` is the only field routing ever reads.
 */
export interface FlowEvent {
  id: string;
  timestamp: string;
  /** Free dot-separated ontological string — the bus never interprets it. */
  tag: string;
  /** What the event is about: `type:id` form, or a named tag (wiki word). */
  target: string;
  data: Record<string, unknown>;
  ctx: FlowEventCtx;
}

export type FlowEventHandler = (event: FlowEvent) => void;

export interface TagFilters {
  /** Exact target, or a trailing-`*` prefix glob — `agent:*` (any of the type),
   *  `dock:shell/*` (any pointer under the view). See `targetMatches`. */
  target?: string;
  /** Delivery filter over ctx.scope — reserved; matched only when provided AND the event carries scope. */
  scope?: string[];
}

interface Subscription {
  pattern: string;
  /** Pattern split once at subscribe time — emit is the hot path, not on(). */
  segments: string[];
  handler: FlowEventHandler;
  filters?: TagFilters;
}

/**
 * THE owner of the normative colon target form (`type:id`). Deliberately NOT
 * TypeId serialization — TypeId renders with a DASH (`type-id`); the bus
 * grammar is colon-separated (docs/tags.md). Twin: flow_sdk/tags/envelope.py.
 */
export function targetOf(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** Exact match, or `type:*` — pattern up to the first colon, then `*` for the rest. */
export function targetMatches(pattern: string, target: string): boolean {
  if (pattern === target || pattern === '*') return true;
  // Trailing `*` = prefix glob — `agent:*` (any of the type), `dock:shell/*`
  // (any pointer under the view). Same grammar as tag trailing-`*`.
  if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
  return false;
}

export class TagEventBus {
  private subs = new Map<symbol, Subscription>();

  /** The shared per-subscription predicate (pattern + target filter). Scope
   *  stays separate so emit can reject it before allocating an envelope. */
  private static subMatches(sub: Subscription, tagSegments: string[], target: string): boolean {
    if (sub.pattern !== '*' && !segmentsMatch(sub.segments, tagSegments)) return false;
    if (sub.filters?.target !== undefined && !targetMatches(sub.filters.target, target)) return false;
    return true;
  }

  private static scopeMatches(sub: Subscription, scope: string[] | undefined): boolean {
    return !sub.filters?.scope?.length || sub.filters.scope.some((item) => scope?.includes(item));
  }

  private static invoke(sub: Subscription, event: FlowEvent): void {
    try {
      sub.handler(event);
    } catch (error) {
      console.error('[EventBus] handler failed', { tag: event.tag, target: event.target }, error);
    }
  }

  /**
   * Fire-and-forget. Fills `id`/`timestamp`, defaults `ctx.origin` to `app`.
   * Synchronous fan-out; a throwing handler never blocks emit or its peers.
   */
  emit(tag: string, target: string, data?: Record<string, unknown>, ctx?: Partial<FlowEventCtx>): FlowEvent | null {
    // Adapters re-emit hot streams (every entity data_op) — with no subscribers
    // at all, skip even the envelope allocation.
    if (this.subs.size === 0) return null;

    const tagSegments = tag.split('.');
    let event: FlowEvent | null = null; // built lazily on the first match
    for (const sub of this.subs.values()) {
      if (!TagEventBus.subMatches(sub, tagSegments, target)) continue;
      if (!TagEventBus.scopeMatches(sub, ctx?.scope)) continue;
      event ??= {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        tag,
        target,
        data: data ?? {},
        ctx: { ...ctx, origin: ctx?.origin ?? 'app' },
      };
      TagEventBus.invoke(sub, event);
    }
    return event;
  }

  /** Subscribe. Returns the unsubscriber — subscription lifetime is the caller's job. */
  on(pattern: string, handler: FlowEventHandler, filters?: TagFilters): () => void {
    const key = Symbol();
    this.subs.set(key, { pattern, segments: pattern.split('.'), handler, filters });
    return () => void this.subs.delete(key);
  }

  /**
   * Dispatch a PRE-BUILT envelope — the RELAY entry (WS bridge, future hub
   * bridge). id/timestamp/actor are never rewritten on relay; the sender
   * stamped `origin` for the arriving hop.
   */
  deliver(event: FlowEvent): void {
    const tagSegments = event.tag.split('.');
    for (const sub of this.subs.values()) {
      if (!TagEventBus.subMatches(sub, tagSegments, event.target)) continue;
      if (!TagEventBus.scopeMatches(sub, event.ctx.scope)) continue;
      TagEventBus.invoke(sub, event);
    }
  }

  /** Test/teardown helper — drops every subscription. */
  clear(): void {
    this.subs.clear();
  }
}

/** The one app-tier bus instance. */
export const EventBus = new TagEventBus();

// ── `app.` ontology sugar ──────────────────────────────────────────────────
// The sugar cuts a full tag into ontology prefix + subtag. It is PURE
// string assembly: internally the bus only ever sees full tag strings.

export const APP_TAG_PREFIX = 'app.';

export function emitAppTag(
  subtag: string,
  target: string,
  data?: Record<string, unknown>,
  ctx?: Partial<FlowEventCtx>,
): FlowEvent | null {
  return EventBus.emit(APP_TAG_PREFIX + subtag, target, data, ctx);
}

export function onAppTag(pattern: string, handler: FlowEventHandler, filters?: TagFilters): () => void {
  return EventBus.on(APP_TAG_PREFIX + pattern, handler, filters);
}
