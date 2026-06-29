/**
 * Toplog — topic-based runtime logging on the SDK/frontend side.
 *
 * Mirror of the backend `flow_sdk/toplog.py`. Sprinkle `toplog.log([topics], …)`
 * calls through frontend code; they stay silent until one of their topics is on.
 * Topics can be flipped at runtime from either side.
 *
 * The backend file `toplog.json` is the single source of truth. This manager:
 *   - keeps an in-memory mirror of `{enabled, filter}`,
 *   - seeds it on init via `GET /toplog/state`,
 *   - listens for live changes broadcast over WS (`on_toplog_state_msg`),
 *   - toggles via the `/toplog/*` routes (the frontend can't write the file).
 *
 * `log()` writes to `console` (the frontend has no Python logging). Semantics
 * match the backend: master `enabled` switch + OR over topics.
 */

import { EventEmitter } from 'events';
import apiClient from '../client';
import type { ToplogStateMessage } from '../websocket';

type Topics = string | string[];

function normalize(topics: Topics): string[] {
  return Array.isArray(topics) ? topics.map(String) : [String(topics)];
}

class ToplogManager extends EventEmitter {
  private _enabled = false;
  private _active = new Set<string>();
  private _initialized = false;

  get enabled(): boolean {
    return this._enabled;
  }

  /** Snapshot of the active topics. */
  activeTopics(): string[] {
    return Array.from(this._active);
  }

  /** Current state as the backend serializes it. */
  state(): { enabled: boolean; filter: Record<string, boolean> } {
    const filter: Record<string, boolean> = {};
    for (const t of this._active) filter[t] = true;
    return { enabled: this._enabled, filter };
  }

  /** Seed state from the backend and subscribe to live updates. Idempotent. */
  async bootstrap(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;

    const { ConnectionManager } = await import('../websocket');
    ConnectionManager.getInstance().on('on_toplog_state_msg', (msg: ToplogStateMessage) => {
      this._apply(msg);
    });

    try {
      const data = await apiClient.get<{ enabled: boolean; filter: Record<string, boolean> }>(
        '/toplog/state',
      );
      if (data) this._apply(data);
    } catch {
      // Backend unreachable at init — stays off until the first WS push.
    }
  }

  /** True iff the master switch is on AND any of `topics` is active (OR). */
  isOn(topics: Topics): boolean {
    if (!this._enabled) return false;
    return normalize(topics).some((t) => this._active.has(t));
  }

  /**
   * Emit `args` to the console iff the master switch is on AND at least one of
   * `topics` is active. Cheap no-op otherwise (note: JS evaluates `args` before
   * the call — wrap expensive payloads in `isOn()` if needed).
   */
  log(topics: Topics, ...args: unknown[]): void {
    if (!this._enabled) return;
    const matched = normalize(topics).filter((t) => this._active.has(t));
    if (matched.length === 0) return;
    // eslint-disable-next-line no-console
    console.log(`[toplog:${matched.join(',')}]`, ...args);
  }

  /** POST to a /toplog route and mirror the returned state locally. */
  private async _post(route: string, body: Record<string, unknown> = {}): Promise<void> {
    const data = await apiClient.post<{ enabled: boolean; filter: Record<string, boolean> }>(
      route,
      body,
    );
    if (data) this._apply(data);
  }

  /** Turn topics on via the backend route; the returned state mirrors locally. */
  async on(...topics: string[]): Promise<void> {
    await this._post('/toplog/on', { topics });
  }

  /** Turn topics off via the backend route. */
  async off(...topics: string[]): Promise<void> {
    await this._post('/toplog/off', { topics });
  }

  /** Flip the master switch on via the backend route. */
  async enable(): Promise<void> {
    await this._post('/toplog/enable');
  }

  /** Flip the master switch off via the backend route. */
  async disable(): Promise<void> {
    await this._post('/toplog/disable');
  }

  private _apply(state: { enabled: boolean; filter?: Record<string, boolean> }): void {
    this._enabled = !!state.enabled;
    this._active = new Set(
      Object.entries(state.filter || {})
        .filter(([, v]) => !!v)
        .map(([k]) => k),
    );
    this.emit('toplog_state_changed', this.state());
  }
}

export const toplog = new ToplogManager();
export default toplog;
