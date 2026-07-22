import { v4 as uuidv4 } from 'uuid';
// Matching lives in the shared dot-taxonomy grammar (./grammar.ts), which the
// SDK barrel also re-exports (`topicMatches` et al. keep their import paths).
import { segmentsMatch } from './grammar';

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
export interface FlowEventCtx {
  /** Who caused it, in target form: `user:<id>`, `agentic_process:<id>`, `system`, `hub`. */
  actor?: string;
  /** Containment chain, innermost-first, entries in target form. */
  scope?: string[];
  /** Which tier emitted — required on every event; emit() fills `app` by default. */
  origin: TopicOrigin;
}

/**
 * The envelope — `FlowEvent` is THE consolidating name for a standard event
 * anywhere in the system (docs/flow-events.md). Python twin:
 * flow_sdk/topics/envelope.py; pinned by tests/fixtures/flow_event_contract.json.
 * `topic` is the only field routing ever reads.
 */
export interface FlowEvent {
  id: string;
  timestamp: string;
  /** Free dot-separated ontological string — the bus never interprets it. */
  topic: string;
  /** What the event is about: `type:id` form, or a named topic (wiki word). */
  target: string;
  data: Record<string, unknown>;
  ctx: FlowEventCtx;
}

export type FlowEventHandler = (event: FlowEvent) => void;

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
  handler: FlowEventHandler;
  filters?: TopicFilters;
}


/**
 * THE owner of the normative colon target form (`type:id`). Deliberately NOT
 * TypeId serialization — TypeId renders with a DASH (`type-id`); the bus
 * grammar is colon-separated (docs/topics.md). Twin: flow_sdk/topics/envelope.py.
 */
export function targetOf(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** Exact match, or `type:*` — pattern up to the first colon, then `*` for the rest. */
export function targetMatches(pattern: string, target: string): boolean {
  if (pattern === target || pattern === '*') return true;
  if (pattern.endsWith(':*')) return target.startsWith(pattern.slice(0, -1));
  return false;
}

export class TopicEventBus {
  private subs = new Map<symbol, Subscription>();

  /** The shared per-subscription predicate (pattern + target filter); the
   *  scope filter needs the built envelope, so it stays at the caller. */
  private static subMatches(sub: Subscription, topicSegments: string[], target: string): boolean {
    if (sub.pattern !== '*' && !segmentsMatch(sub.segments, topicSegments)) return false;
    if (sub.filters?.target !== undefined && !targetMatches(sub.filters.target, target)) return false;
    return true;
  }

  /**
   * Fire-and-forget. Fills `id`/`timestamp`, defaults `ctx.origin` to `app`.
   * Synchronous fan-out; a throwing handler never blocks emit or its peers.
   */
  emit(topic: string, target: string, data?: Record<string, unknown>, ctx?: Partial<FlowEventCtx>): FlowEvent | null {
    // Adapters re-emit hot streams (every entity data_op) — with no subscribers
    // at all, skip even the envelope allocation.
    if (this.subs.size === 0) return null;

    const topicSegments = topic.split('.');
    let event: FlowEvent | null = null; // built lazily on the first match
    for (const sub of this.subs.values()) {
      if (!TopicEventBus.subMatches(sub, topicSegments, target)) continue;
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
  on(pattern: string, handler: FlowEventHandler, filters?: TopicFilters): () => void {
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
    const topicSegments = event.topic.split('.');
    for (const sub of this.subs.values()) {
      if (!TopicEventBus.subMatches(sub, topicSegments, event.target)) continue;
      if (sub.filters?.scope?.length && !sub.filters.scope.some((s) => event.ctx.scope?.includes(s))) continue;
      try {
        sub.handler(event);
      } catch (e) {
        console.error('[EventBus] handler failed', { topic: event.topic, target: event.target }, e);
      }
    }
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
  ctx?: Partial<FlowEventCtx>,
): FlowEvent | null {
  return EventBus.emit(APP_TOPIC_PREFIX + subtopic, target, data, ctx);
}

export function onAppTopic(pattern: string, handler: FlowEventHandler, filters?: TopicFilters): () => void {
  return EventBus.on(APP_TOPIC_PREFIX + pattern, handler, filters);
}
