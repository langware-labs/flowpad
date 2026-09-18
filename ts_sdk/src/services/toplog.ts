/**
 * Toplog — tag-based runtime logging on the SDK/frontend side.
 *
 * Mirror of the backend `flow_sdk/toplog.py`. Sprinkle `toplog.log([tags], …)`
 * calls through frontend code; they stay silent until one of their tags is on.
 * Tags can be flipped at runtime from either side.
 *
 * The backend file `toplog.json` is the single source of truth. This manager:
 *   - keeps an in-memory mirror of `{enabled, filter}`,
 *   - seeds it on init via `GET /toplog/state`,
 *   - listens for live changes broadcast over WS (`on_toplog_state_msg`),
 *   - toggles via the `/toplog/*` routes (the frontend can't write the file).
 *
 * `log()` writes to `console` (the frontend has no Python logging) AND queues the
 * line for `POST /toplog/client-log`, flushed once a second, so the backend
 * writes it into the instance log under `toplog.client` — front and back land
 * in one timestamped trail an agent can tail. Semantics match the backend:
 * master `enabled` switch + OR over tags.
 */

import apiClient from '../client';
import { hubModeReady, isHubOnly } from '../utils/hub-runtime';
import type { ToplogStateMessage } from '../websocket';

type Tags = string | string[];
type ToplogState = { enabled: boolean; filter?: Record<string, boolean>; persist?: boolean };
type ClientLine = { tags: string[]; msg: string; ts: number };

/** One flush is ≤1s of lines; past this the queue drops and reports the count. */
const MAX_QUEUED_LINES = 500;
const FLUSH_INTERVAL_MS = 1000;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function normalize(tags: Tags): string[] {
  return Array.isArray(tags) ? tags.map(String) : [String(tags)];
}

/**
 * Deliberately NOT an EventEmitter. `on`/`off` here are the TAG TOGGLES (the
 * console API, mirrored from the backend routes) — they shadowed the emitter's
 * subscribe/unsubscribe, so nothing could ever have subscribed, and the state
 * event it used to emit had no possible listener.
 */
class ToplogManager {
  private _enabled = false;
  private _persist = false;
  private _active = new Set<string>();
  private _initialized = false;
  private _queue: ClientLine[] = [];
  private _dropped = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  get enabled(): boolean {
    return this._enabled;
  }

  /** Snapshot of the active tags. */
  activeTags(): string[] {
    return Array.from(this._active);
  }

  /** Current state as the backend serializes it. */
  state(): { enabled: boolean; filter: Record<string, boolean>; persist: boolean } {
    const filter: Record<string, boolean> = {};
    for (const t of this._active) filter[t] = true;
    return { enabled: this._enabled, filter, persist: this._persist };
  }

  /** Seed state from the backend and subscribe to live updates. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    const { ConnectionManager } = await import('../websocket');
    const connection = ConnectionManager.getInstance();
    connection.on('on_toplog_state_msg', (msg: ToplogStateMessage) => {
      this._apply(msg);
    });
    // A backend restart resets toplog.json (unless persisted) and broadcasts
    // before this client is back on the socket — re-seed so the mirror doesn't
    // keep tracing tags the backend already dropped.
    connection.on('on_reconnected', () => {
      void this._seed();
    });

    await this._seed();
  }

  private async _seed(): Promise<void> {
    // Wait for the hub-mode signal (this runs at init, possibly before bootstrap
    // seeds it), then decide. Hub mode: the hub backend has no `/toplog/state`
    // route (404) — skip the seed and stay off until a WS push arrives (if ever).
    await hubModeReady();
    if (isHubOnly()) return;

    try {
      const data = await apiClient.get<ToplogState>('/toplog/state');
      if (data) this._apply(data);
    } catch {
      // Backend unreachable — stays as-is until the next WS push or reconnect.
    }
  }

  /** True iff the master switch is on AND any of `tags` is active (OR). */
  isOn(tags: Tags): boolean {
    if (!this._enabled) return false;
    return normalize(tags).some((t) => this._active.has(t));
  }

  /**
   * Emit `args` to the console iff the master switch is on AND at least one of
   * `tags` is active. Cheap no-op otherwise (note: JS evaluates `args` before
   * the call — wrap expensive payloads in `isOn()` if needed).
   */
  log(tags: Tags, ...args: unknown[]): void {
    if (!this._enabled) return;
    const matched = normalize(tags).filter((t) => this._active.has(t));
    if (matched.length === 0) return;
    // eslint-disable-next-line no-console
    console.log(`[toplog:${matched.join(',')}]`, ...args);
    this._enqueue(matched, args);
  }

  /** Queue a line for the backend log; the flush timer starts on the first one. */
  private _enqueue(tags: string[], args: unknown[]): void {
    if (isHubOnly()) return; // the hub backend has no /toplog routes
    if (this._queue.length >= MAX_QUEUED_LINES) {
      this._dropped += 1;
    } else {
      this._queue.push({ tags, msg: args.map(formatArg).join(' '), ts: Date.now() });
    }
    if (this._flushTimer === null) {
      this._flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  /** Send the queued lines to `/toplog/client-log`. Best-effort: a failed POST
   * drops the batch rather than growing the queue behind a dead backend. */
  async flush(): Promise<void> {
    this._flushTimer = null;
    // Drops only happen once the queue is full, so an empty queue has none.
    if (this._queue.length === 0) return;
    const lines = this._queue;
    this._queue = [];
    if (this._dropped > 0) {
      lines.push({
        tags: lines[0].tags,
        msg: `toplog client queue overflow: ${this._dropped} lines dropped`,
        ts: Date.now(),
      });
    }
    this._dropped = 0;
    // Lines logged while this POST is in flight queue for the next tick, so a
    // line the request path itself emits costs one batch per second, not a loop.
    try {
      await apiClient.post('/toplog/client-log', { lines });
    } catch {
      // Backend unreachable — the console copy is all this batch gets.
    }
  }

  /** POST to a /toplog route and mirror the returned state locally. */
  private async _post(route: string, body: Record<string, unknown> = {}): Promise<void> {
    const data = await apiClient.post<ToplogState>(route, body);
    if (data) this._apply(data);
  }

  /** Turn tags on via the backend route; the returned state mirrors locally. */
  async on(...tags: string[]): Promise<void> {
    await this._post('/toplog/on', { tags });
  }

  /** Turn tags off via the backend route. */
  async off(...tags: string[]): Promise<void> {
    await this._post('/toplog/off', { tags });
  }

  /** Flip the master switch on via the backend route. */
  async enable(): Promise<void> {
    await this._post('/toplog/enable');
  }

  /** Flip the master switch off via the backend route. */
  async disable(): Promise<void> {
    await this._post('/toplog/disable');
  }

  /** Keep (true) or stop keeping (false) the state across a backend restart. */
  async persist(value = true): Promise<void> {
    await this._post('/toplog/persist', { persist: value });
  }

  private _apply(state: ToplogState): void {
    this._enabled = !!state.enabled;
    this._persist = !!state.persist;
    this._active = new Set(
      Object.entries(state.filter || {})
        .filter(([, v]) => !!v)
        .map(([k]) => k),
    );
  }
}

export const toplog = new ToplogManager();
export default toplog;
