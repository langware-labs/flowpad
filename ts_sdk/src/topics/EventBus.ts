import { v4 as uuidv4 } from 'uuid';

/**
 * The unified event bus ("topics" system) — see docs/topics.md for the agreed
 * language. This is the APP-LOCAL slice: a plain in-process registry. Transport
 * (cross-tier bridges over the watch system) is designed but deferred; bridges,
 * when they arrive, are ordinary subscribers of this same bus.
 *
 * Naming rule: anything with `topic` in its name is the unified system;
 * `event`/`message`/`op` elsewhere is legacy.
 */

/** Which tier of the system emitted an event. Trust policy is per tier. */
export type TopicOrigin = 'app' | 'local_server' | 'hub' | 'sandbox';

/** Correlation only — enriches, never gates. Routing NEVER reads ctx. */
export interface TopicCtx {
  /** Who caused it, in target form: `user:<id>`, `agentic_process:<id>`, `system`, `hub`. */
  actor?: string;
  /** Containment chain, innermost-first, entries in target form. */
  scope?: string[];
  /** Which tier emitted — required on every event; emit() fills `app` by default. */
  origin: TopicOrigin;
}

/** The envelope. `topic` is the only field routing ever reads. */
export interface TopicEvent {
  id: string;
  timestamp: string;
  /** Free dot-separated ontological string — the bus never interprets it. */
  topic: string;
  /** What the event is about: `type:id` form, or a named topic (wiki word). */
  target: string;
  data: Record<string, unknown>;
  ctx: TopicCtx;
}

export type TopicHandler = (event: TopicEvent) => void;

export interface TopicFilters {
  /** Exact target, or a `type:*` glob (single trailing `*` after the first colon). */
  target?: string;
  /** Delivery filter over ctx.scope — reserved; matched only when provided AND the event carries scope. */
  scope?: string[];
}

interface Subscription {
  pattern: string;
  /** Pattern split once at subscribe time — emit is the hot path, not on(). */
  segments: string[];
  handler: TopicHandler;
  filters?: TopicFilters;
}

/** Segment-wise match against a pre-split pattern (see {@link topicMatches}). */
function segmentsMatch(p: string[], t: string[]): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && i === p.length - 1) return t.length >= i + 1;
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return t.length === p.length;
}

/**
 * Segment-wise glob over the dot path. `*` matches exactly one segment; a
 * TRAILING `*` matches any remaining suffix (so `app.*` matches
 * `app.route.loaded`). No partial-segment matching — `app.rou*` is not a thing.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*') return true;
  return segmentsMatch(pattern.split('.'), topic.split('.'));
}

/** Exact match, or `type:*` — pattern up to the first colon, then `*` for the rest. */
export function targetMatches(pattern: string, target: string): boolean {
  if (pattern === target || pattern === '*') return true;
  if (pattern.endsWith(':*')) return target.startsWith(pattern.slice(0, -1));
  return false;
}

export class TopicEventBus {
  private subs = new Map<symbol, Subscription>();

  /**
   * Fire-and-forget. Fills `id`/`timestamp`, defaults `ctx.origin` to `app`.
   * Synchronous fan-out; a throwing handler never blocks emit or its peers.
   */
  emit(topic: string, target: string, data?: Record<string, unknown>, ctx?: Partial<TopicCtx>): TopicEvent | null {
    // Adapters re-emit hot streams (every entity data_op) — with no subscribers
    // at all, skip even the envelope allocation.
    if (this.subs.size === 0) return null;

    const topicSegments = topic.split('.');
    let event: TopicEvent | null = null; // built lazily on the first match
    for (const sub of this.subs.values()) {
      if (sub.pattern !== '*' && !segmentsMatch(sub.segments, topicSegments)) continue;
      if (sub.filters?.target !== undefined && !targetMatches(sub.filters.target, target)) continue;
      event ??= {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        topic,
        target,
        data: data ?? {},
        ctx: { ...ctx, origin: ctx?.origin ?? 'app' },
      };
      if (sub.filters?.scope?.length && !sub.filters.scope.some((s) => event?.ctx.scope?.includes(s))) continue;
      try {
        sub.handler(event);
      } catch (e) {
        console.error('[EventBus] handler failed', { topic, target }, e);
      }
    }
    return event;
  }

  /** Subscribe. Returns the unsubscriber — subscription lifetime is the caller's job. */
  on(pattern: string, handler: TopicHandler, filters?: TopicFilters): () => void {
    const key = Symbol();
    this.subs.set(key, { pattern, segments: pattern.split('.'), handler, filters });
    return () => void this.subs.delete(key);
  }

  /** Test/teardown helper — drops every subscription. */
  clear(): void {
    this.subs.clear();
  }
}

/** The one app-tier bus instance. */
export const EventBus = new TopicEventBus();

// ── `app.` ontology sugar ──────────────────────────────────────────────────
// The sugar cuts a full topic into ontology prefix + subtopic. It is PURE
// string assembly: internally the bus only ever sees full topic strings.

export const APP_TOPIC_PREFIX = 'app.';

export function emitAppTopic(
  subtopic: string,
  target: string,
  data?: Record<string, unknown>,
  ctx?: Partial<TopicCtx>,
): TopicEvent | null {
  return EventBus.emit(APP_TOPIC_PREFIX + subtopic, target, data, ctx);
}

export function onAppTopic(pattern: string, handler: TopicHandler, filters?: TopicFilters): () => void {
  return EventBus.on(APP_TOPIC_PREFIX + pattern, handler, filters);
}
