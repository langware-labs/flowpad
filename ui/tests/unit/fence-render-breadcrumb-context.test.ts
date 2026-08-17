/**
 * The live half of a breadcrumb block — the cache in front of
 * `POST /api/v1/tags/context`.
 *
 * Everything here is about NOT hammering that route. Its `code` half is a live
 * filesystem walk, and the renderer that calls this is re-invoked on every
 * theme change and every debounce tick while the author types. The properties
 * pinned below (dedupe, TTL, negative caching, never-throw) are the difference
 * between one walk and a request storm.
 *
 * `Date.now` is stubbed rather than using fake timers: the module awaits real
 * promises, and a faked clock would stall them.
 */

import {
  __resetBreadcrumbContextCache,
  ensureBreadcrumbContext,
  invalidateBreadcrumbContext,
  peekBreadcrumbContext,
} from '@src/components/milkdown-editor/plugins/fence-render/renderers/breadcrumb-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('@sdk/client', () => ({ default: { post: (...args: unknown[]) => post(...args) } }));

const TAG = 'breadcrumb.test.catchup_login.rules';
const ROOT = '/repo';
const NOTE = 'FAILING? read this tag rules before editing';

/** One code site as the route reports it: path RELATIVE to `root`. */
function codeSite(path: string, line: number, tags: Record<string, string> = { [TAG]: NOTE }) {
  return { path, line, tags };
}

/** Resolves when the fetch settles. Only valid when a fetch actually starts. */
function ensure(tag = TAG, root = ROOT): Promise<void> {
  return new Promise<void>((resolve) => ensureBreadcrumbContext(tag, root, resolve));
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post.mockReset();
  post.mockResolvedValue({ code: [codeSite('tests/unit/test_catchup.py', 41)] });
});

afterEach(() => {
  __resetBreadcrumbContextCache();
  vi.restoreAllMocks();
});

describe('fetching the join', () => {
  /* `parts: ['code']` matters: the docs half would read and summarise every
   * bound doc, which for a breadcrumb tag is the page being rendered. */
  it('asks the route for the code sites alone, rooted at the project', async () => {
    await ensure();
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/v1/tags/context', {
      name: TAG,
      mode: 'line',
      root: ROOT,
      parts: ['code'],
    });
  });

  it('maps code sites to rows, carrying the capsule note', async () => {
    await ensure();
    expect(peekBreadcrumbContext(TAG, ROOT)?.sites).toEqual([
      { relPath: 'tests/unit/test_catchup.py', line: 41, note: NOTE },
    ]);
  });

  /* `scan_code_capsules` matches by hierarchy, so a site may carry a
   * DESCENDANT of the requested tag rather than the tag itself. */
  it('accepts a lone note under a descendant tag, but never guesses between several', async () => {
    post.mockResolvedValue({
      code: [
        codeSite('a.py', 1, { 'breadcrumb.test.catchup_login.rules.extra': 'only one' }),
        codeSite('b.py', 2, { 'x.one': 'first', 'x.two': 'second' }),
      ],
    });
    await ensure();
    const sites = peekBreadcrumbContext(TAG, ROOT)!.sites!;
    expect(sites[0].note).toBe('only one');
    expect(sites[1].note).toBeUndefined();
  });
});

describe('not hammering the route', () => {
  it('joins concurrent callers onto one request', async () => {
    const first = ensure();
    ensureBreadcrumbContext(TAG, ROOT, () => {});
    ensureBreadcrumbContext(TAG, ROOT, () => {});
    await first;
    expect(post).toHaveBeenCalledOnce();
  });

  it('serves a fresh entry from cache without a request', async () => {
    await ensure();
    now += 1_000;
    ensureBreadcrumbContext(TAG, ROOT, () => {});
    expect(post).toHaveBeenCalledOnce();
  });

  it('refetches once the entry has aged out', async () => {
    await ensure();
    now += 60_000;
    await ensure();
    expect(post).toHaveBeenCalledTimes(2);
  });

  /* The whole point of caching failures: without this, an unreachable backend
   * turns the renderer's typing debounce into a storm against a full walk. */
  it('caches a failure too, so a dead backend is asked once per TTL', async () => {
    post.mockRejectedValue(new Error('Network Error'));
    await ensure();
    now += 1_000;
    ensureBreadcrumbContext(TAG, ROOT, () => {});
    expect(post).toHaveBeenCalledOnce();
    expect(peekBreadcrumbContext(TAG, ROOT)?.error).toBe('Network Error');
  });

  it('keys the cache on both tag and root', async () => {
    await ensure();
    await ensure(TAG, '/other');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('refetches after an explicit invalidate', async () => {
    await ensure();
    invalidateBreadcrumbContext(TAG, ROOT);
    await ensure();
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('degrading without destroying', () => {
  it('never rejects, whatever the route does', async () => {
    post.mockRejectedValue(new Error('boom'));
    await expect(ensure()).resolves.toBeUndefined();
  });

  /* A failed refresh must not erase a good answer — the card keeps showing the
   * last live rows and only marks itself stale. */
  it('keeps the last good rows when a later refresh fails', async () => {
    await ensure();
    post.mockRejectedValue(new Error('gone'));
    now += 60_000;
    await ensure();

    const entry = peekBreadcrumbContext(TAG, ROOT)!;
    expect(entry.sites).toEqual([{ relPath: 'tests/unit/test_catchup.py', line: 41, note: NOTE }]);
    expect(entry.error).toBe('gone');
  });

  /* `root` is the DOCUMENT's project, which may not be the repo holding the
   * test. An empty answer is "I looked here", not "there are none". */
  it('does not replace rows with an empty result', async () => {
    await ensure();
    post.mockResolvedValue({ code: [] });
    now += 60_000;
    await ensure();

    const entry = peekBreadcrumbContext(TAG, ROOT)!;
    expect(entry.sites).toHaveLength(1);
    expect(entry.error).toBeNull();
  });

  it('tolerates a null envelope body', async () => {
    post.mockResolvedValue(null);
    await ensure();
    const entry = peekBreadcrumbContext(TAG, ROOT)!;
    expect(entry.error).toBeNull();
    expect(entry.sites).toBeNull();
  });

  it('reports in-flight while the first request is outstanding', async () => {
    const settled = ensure();
    expect(peekBreadcrumbContext(TAG, ROOT)).toMatchObject({ sites: null });
    expect(peekBreadcrumbContext(TAG, ROOT)?.inFlight).not.toBeNull();
    await settled;
    expect(peekBreadcrumbContext(TAG, ROOT)?.inFlight).toBeNull();
  });
});

/* A module-scope Map in a long-lived SPA grows for every breadcrumb doc the
 * user browses past, so it has to have a ceiling. */
describe('cache size', () => {
  it('evicts the oldest settled entry once full', async () => {
    for (let i = 0; i < 50; i++) {
      now += 1;
      await ensure(TAG, `/root-${i}`);
    }
    expect(peekBreadcrumbContext(TAG, '/root-0')).toBeDefined();

    now += 1;
    await ensure(TAG, '/root-50');

    expect(peekBreadcrumbContext(TAG, '/root-0')).toBeUndefined();
    expect(peekBreadcrumbContext(TAG, '/root-50')).toBeDefined();
  });
});
