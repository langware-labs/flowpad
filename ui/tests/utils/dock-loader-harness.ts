/**
 * Run the REAL dock loader (`loadAgentApp`) on a URL, with every backend request
 * recorded — docs/navigation/dock-loading.md, invariants I2-I4.
 *
 * The recording seam is `apiClient`: entity GETs, queries and `callAction` all
 * go through it, so "what did this navigation ask the backend for" is one list.
 * A request no responder answers fails like a 404, which is what an unknown row
 * is to a loader.
 *
 * Caller contract: the test file stubs `initSdk` (the SDK boot is not the unit
 * under test — see `stubSdkBoot`) and seeds the bootstrap with `seedBootstrap`.
 */
import { apiClient } from '@sdk/client';
import { dataContext } from '@sdk';
import { loadAgentApp } from '@src/routes/loaders/main-loader';
import { vi } from 'vitest';

export interface RecordedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path only — no origin, no query string. */
  path: string;
  body?: unknown;
}

/** Answer a request; `undefined` means "not mine" (the next responder, else 404). */
export type Responder = (req: RecordedRequest) => unknown;

export class NotFoundError extends Error {
  readonly response = { status: 404, data: { message: 'not found' } };
  readonly status = 404;
  constructor(path: string) {
    super(`404 ${path}`);
  }
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Spy on every `apiClient` verb. Returns the live request log. */
export function recordRequests(responders: Responder[] = []): RecordedRequest[] {
  const log: RecordedRequest[] = [];
  for (const verb of METHODS) {
    vi.spyOn(apiClient, verb).mockImplementation(((url: string, bodyOrConfig?: unknown) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      const req: RecordedRequest = {
        method: verb.toUpperCase() as RecordedRequest['method'],
        path,
        ...(verb === 'get' || verb === 'delete' ? {} : { body: bodyOrConfig }),
      };
      log.push(req);
      for (const respond of responders) {
        const out = respond(req);
        if (out !== undefined) return Promise.resolve(out);
      }
      return Promise.reject(new NotFoundError(path));
    }) as never);
  }
  return log;
}

export function seedBootstrap(info: Record<string, unknown> = {}): void {
  dataContext.bootstrapInfo = { supported_pages: ['desk', 'hub'], ...info };
}

export type LoaderOutcome =
  | { outcome: 'ok' }
  | { outcome: 'redirect'; status: number; location: string }
  | { outcome: 'error'; error: unknown };

/** The router's params for a dock/win URL: `/<layout>/:viewType/*`. */
export function dockParams(url: string): Record<string, string> {
  const [, , viewType = '', ...rest] = new URL(url, 'http://localhost').pathname.split('/');
  return { viewType: decodeURIComponent(viewType), '*': rest.map(decodeURIComponent).join('/') };
}

export async function runDockLoader(url: string): Promise<LoaderOutcome> {
  const request = new Request(new URL(url, 'http://localhost'));
  try {
    await loadAgentApp({ request, params: dockParams(url), context: {} } as never);
    return { outcome: 'ok' };
  } catch (error) {
    if (error instanceof Response) {
      return { outcome: 'redirect', status: error.status, location: error.headers.get('Location') ?? '' };
    }
    return { outcome: 'error', error };
  }
}

/** Requests a warm navigation may make: fire-and-forget recency stamps, never awaited by the loader. */
export const FIRE_AND_FORGET = [/\/activate$/];

export function blockingRequests(log: readonly RecordedRequest[]): RecordedRequest[] {
  return log.filter((r) => !FIRE_AND_FORGET.some((re) => re.test(r.path)));
}

interface FakeTabRow {
  id: string;
  pointer: string;
  target_type: string | null;
  target_id: string | null;
  project_id: string | null;
  name: string | null;
  visible: boolean;
  last_active_at: number;
  tab_order: number;
}

/** An in-memory `/graph/tab` backend: `new_tab` is get-or-create by pointer, `list_all` lists. */
export function fakeTabStore(): Responder & { rows: FakeTabRow[] } {
  const rows: FakeTabRow[] = [];
  const respond: Responder = (req) => {
    if (req.method === 'GET' && req.path.endsWith('/graph/tab/list_all')) return { tabs: rows.map((r) => ({ ...r })) };
    if (req.method === 'POST' && req.path.endsWith('/graph/tab/new_tab')) {
      const body = (req.body ?? {}) as Partial<FakeTabRow>;
      const pointer = String(body.pointer ?? '');
      let created = false;
      if (!rows.some((r) => r.pointer === pointer)) {
        created = true;
        rows.push({
          id: crypto.randomUUID(),
          pointer,
          target_type: body.target_type ?? null,
          target_id: body.target_id ?? null,
          project_id: body.project_id ?? null,
          name: body.name ?? null,
          visible: true,
          last_active_at: Date.now(),
          tab_order: rows.length,
        });
      }
      return { tabs: rows.map((r) => ({ ...r })), created };
    }
    if (req.method === 'POST' && /\/activate$/.test(req.path)) return {};
    return undefined;
  };
  return Object.assign(respond, { rows });
}
