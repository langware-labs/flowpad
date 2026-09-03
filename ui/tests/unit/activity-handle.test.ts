import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The TypeScript `Activity` handle — what it puts on the wire.
 *
 * The live-backend contract lives in `tests/api/activity_fe_contract.test.ts`; this pins
 * the two things a mock can prove better than a live server can: that every verb posts the
 * path and body it should, and that no code here ever constructs a backend URL.
 */

const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
const gets: Array<{ url: string; params: Record<string, unknown> }> = [];
let nextResponse: unknown = { path: 'index', done: 0 };

vi.mock('@sdk/client', () => ({
  default: {
    post: (url: string, body: Record<string, unknown>) => {
      posts.push({ url, body });
      return Promise.resolve(nextResponse);
    },
    get: (url: string, config?: { params?: Record<string, unknown> }) => {
      gets.push({ url, params: config?.params ?? {} });
      return Promise.resolve(nextResponse);
    },
  },
}));

import { Activity, listActivities } from '@sdk/activity';

describe('Activity handle (TypeScript)', () => {
  beforeEach(() => {
    posts.length = 0;
    gets.length = 0;
    nextResponse = { path: 'index', name: 'index', done: 0, children: [], errors: [], counters: {} };
  });

  it('addresses a node by path and a child by the same path plus a segment', () => {
    expect(Activity.get('index').path).toBe('index');
    expect(Activity.get('index').child('pdf').path).toBe('index/pdf');
    expect(Activity.get('/index/').path).toBe('index');
  });

  it('posts camelCase verbs — the spelling the route accepts from this side', async () => {
    await Activity.get('index').incSuccess(3);
    await Activity.get('index').incSkipped();
    await Activity.get('index').incError('boom', { ref: 'a.pdf' });

    expect(posts.map((p) => p.url)).toEqual([
      '/api/v1/activity/index/incSuccess',
      '/api/v1/activity/index/incSkipped',
      '/api/v1/activity/index/incError',
    ]);
  });

  it('sends each verb its own argument shape', async () => {
    await Activity.get('index').total(500);
    await Activity.get('index').incError('encrypted', { ref: 'a.pdf', code: 'E_ENC' });
    await Activity.get('index').inc('orphans', 17);
    await Activity.get('index').done('all good');

    expect(posts[0].body).toMatchObject({ value: 500 });
    expect(posts[1].body).toMatchObject({ message: 'encrypted', ref: 'a.pdf', code: 'E_ENC' });
    expect(posts[2].body).toMatchObject({ counter: 'orphans', n: 17 });
    expect(posts[3].body).toMatchObject({ message: 'all good' });
  });

  it('carries scope on every verb so a scoped activity stays scoped', async () => {
    await Activity.get('run', 'agentic_process-abc').incSuccess();

    expect(posts[0].body.scope).toBe('agentic_process-abc');
  });

  it('omits an absent scope rather than sending an empty one', async () => {
    await Activity.get('index').spec();

    expect(gets[0].params).toEqual({});
  });

  it('never constructs a backend URL — only paths', async () => {
    await Activity.get('index').incSuccess();
    await Activity.get('index').spec();
    await listActivities();

    for (const { url } of [...posts, ...gets]) {
      expect(url.startsWith('/api/v1/')).toBe(true);
      expect(url).not.toMatch(/https?:/);
    }
  });

  it('reads a refusal as "no activity", not as a spec', async () => {
    /**
     * Refusals ride an HTTP 200 by repo convention, and the client interceptor unwraps
     * every 200 alike — so a refusal lands in the exact position a spec would. Without the
     * guard a caller gets an object that is neither a spec nor null and every field read
     * off it is `undefined`.
     */
    nextResponse = { error_code: 'NOT_LIVE' };

    expect(await Activity.get('index').spec()).toBeNull();
    expect(await Activity.get('index').incSuccess()).toBeNull();
  });

  it('returns an empty list rather than a refusal object', async () => {
    nextResponse = { error_code: 'NOT_LIVE' };

    expect(await listActivities()).toEqual([]);
  });

  it('never lets a failed report break the caller', async () => {
    nextResponse = Promise.reject(new Error('backend down'));

    await expect(Activity.get('index').incSuccess()).resolves.toBeNull();
  });
});
