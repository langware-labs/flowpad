/**
 * `Activity` in TypeScript — the same verbs, the same addressing, over the REST route.
 *
 *     Activity.get('index').label('Indexing').total(5000);
 *     Activity.get('index/pdf').incSuccess();
 *     Activity.get('index/pdf').incError('encrypted', { ref: 'a.pdf' });
 *     await Activity.get('index').done('indexed 5,000');
 *
 * Verbs are camelCase here and snake_case in Python; the route accepts either, so this is
 * one vocabulary spelled the way each language spells things.
 *
 * Every verb is one POST. That is fine for a UI-driven bulk operation that reports at
 * intervals, and wrong inside a render or a tight loop — reach for the CLI's `--stdin`
 * form or a Python producer when the loop is hot. Calls are chained through a per-handle
 * promise so a burst arrives in the order it was issued rather than racing.
 *
 * Everything goes through `apiClient` with a PATH. The base URL, auth and the
 * `{status,data}` envelope are its business, and application code never touches a backend
 * URL — its response interceptor has already unwrapped to the payload, so what these
 * methods receive IS the spec, not an envelope around one.
 */

import apiClient from '../client';
import type { ActivityProgressSpec, ActivityState } from './types';

const BASE = '/api/v1/activity';

/**
 * A refusal or a spec?
 *
 * Refusals ride an HTTP 200 by repo convention (`ApiFailResponse.status_code` is a body
 * field), and the client's interceptor unwraps every 200 the same way — so a refusal
 * arrives here as `{ error_code: 'NOT_LIVE' }` in the exact position a spec would occupy.
 * Without this guard a caller asking about a finished activity gets an object that is not
 * a spec but is also not null, and every field read off it is `undefined`.
 */
function asSpec(payload: unknown): ActivityProgressSpec | null {
  const candidate = payload as (ActivityProgressSpec & { error_code?: string }) | null;
  if (!candidate || candidate.error_code || typeof candidate.path !== 'string') return null;
  return candidate;
}

interface VerbBody {
  value?: unknown;
  n?: number;
  message?: string;
  ref?: string | null;
  code?: string | null;
  counter?: string;
  scope?: string | null;
}

export class Activity {
  private constructor(
    readonly path: string,
    readonly scope?: string | null,
  ) {}

  /** The node at `path`, created on the backend by the first verb that reaches it. */
  static get(path: string, scope?: string | null): Activity {
    return new Activity(path.replace(/^\/+|\/+$/g, ''), scope ?? null);
  }

  /** The child called `name` — the same node `Activity.get('parent/name')` addresses. */
  child(name: string): Activity {
    return new Activity(`${this.path}/${name.replace(/^\/+|\/+$/g, '')}`, this.scope);
  }

  /** Chains verbs in issue order so a burst cannot arrive out of sequence. */
  private queue: Promise<ActivityProgressSpec | null> = Promise.resolve(null);

  private send(verb: string, body: VerbBody = {}): Promise<ActivityProgressSpec | null> {
    const payload = { ...body, scope: this.scope ?? undefined };
    this.queue = this.queue
      .then(() => apiClient.post(`${BASE}/${this.path}/${verb}`, payload))
      .then(asSpec)
      // A failed report must never take down whatever is being reported ON. The failure
      // is already logged by the client's own interceptor.
      .catch(() => null);
    return this.queue;
  }

  label(text: string) { return this.send('label', { value: text }); }
  icon(name: string) { return this.send('icon', { value: name }); }
  /** `null` means unknown, and unknown is not zero. */
  total(count: number | null) { return this.send('total', { value: count }); }
  current(item: string | null) { return this.send('current', { value: item }); }
  message(text: string) { return this.send('message', { value: text }); }

  incSuccess(n = 1) { return this.send('incSuccess', { value: n }); }
  /** Counts into `done` too: a skipped file is finished business. */
  incSkipped(n = 1) { return this.send('incSkipped', { value: n }); }
  /** Does NOT advance `done` — a thing that errored was not processed. */
  incError(message: string, opts: { ref?: string; code?: string; n?: number } = {}) {
    return this.send('incError', { message, ref: opts.ref, code: opts.code, n: opts.n ?? 1 });
  }
  inc(counter: string, n = 1) { return this.send('inc', { counter, n }); }

  block(message?: string) { return this.send('block', { message }); }
  pause(message?: string) { return this.send('pause', { message }); }
  resume() { return this.send('resume'); }
  done(message?: string) { return this.send('done', { message }); }
  fail(message?: string) { return this.send('fail', { message }); }
  cancel(message?: string) { return this.send('cancel', { message }); }
  reset() { return this.send('reset'); }

  /** The live tree, or `null` once it is no longer live. */
  async spec(): Promise<ActivityProgressSpec | null> {
    try {
      const res: unknown = await apiClient.get(`${BASE}/${this.path}`, {
        // Omit an absent scope: a query string cannot carry null, and `scope=` would ask
        // for an activity in a scope literally named "".
        params: this.scope ? { scope: this.scope } : {},
      });
      return asSpec(res);
    } catch {
      return null;
    }
  }

  async state(): Promise<ActivityState | null> {
    return (await this.spec())?.state ?? null;
  }
}

/** Live roots, for a client that wants the list without subscribing. */
export async function listActivities(scope?: string | null, allScopes = false): Promise<ActivityProgressSpec[]> {
  try {
    const params = allScopes ? { all: true } : scope ? { scope } : {};
    const res: unknown = await apiClient.get(BASE, { params });
    return Array.isArray(res) ? (res as ActivityProgressSpec[]) : [];
  } catch {
    return [];
  }
}
