import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { Browseable, BrowseableRoot, ToolbarAction } from './types';

/**
 * Mock Browseable data for tests and dev playgrounds.
 *
 * Uses a seeded RNG (mulberry32) so tree shape, delays, and error
 * injection are all deterministic given a seed. Promises simulate real
 * network latency so UI loading states can be asserted.
 */
export interface MockBrowseableOptions {
  /** RNG seed. Same seed → identical tree + delay sequence. Default `1`. */
  seed?: number;
  /** Minimum delay in ms before `listChildren` resolves. Default `0`. */
  baseDelayMs?: number;
  /** Additional random jitter added on top of `baseDelayMs`. Default `0`.
   *  Setting both to `0` makes listChildren resolve on next microtask. */
  jitterMs?: number;
  /** Probability (0..1) that `listChildren` rejects instead of resolving.
   *  Default `0`. */
  errorRate?: number;
}

interface ResolvedOptions {
  seed: number;
  baseDelayMs: number;
  jitterMs: number;
  errorRate: number;
}

function resolveOptions(opts?: MockBrowseableOptions): ResolvedOptions {
  return {
    seed: opts?.seed ?? 1,
    baseDelayMs: opts?.baseDelayMs ?? 0,
    jitterMs: opts?.jitterMs ?? 0,
    errorRate: opts?.errorRate ?? 0,
  };
}

/**
 * mulberry32 — tiny seeded RNG. Returns [0, 1).
 * https://stackoverflow.com/a/47593316
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string into a 32-bit integer (for per-node sub-seeds). */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Compute a deterministic delay for a given node id under the given opts. */
export function mockDelayFor(id: string, opts?: MockBrowseableOptions): number {
  const o = resolveOptions(opts);
  if (o.jitterMs === 0) return o.baseDelayMs;
  const rng = mulberry32(hashString(id) ^ o.seed);
  return o.baseDelayMs + Math.floor(rng() * (o.jitterMs + 1));
}

/** Compute whether an id should error-inject under the given opts. */
export function mockShouldError(id: string, opts?: MockBrowseableOptions): boolean {
  const o = resolveOptions(opts);
  if (o.errorRate <= 0) return false;
  if (o.errorRate >= 1) return true;
  const rng = mulberry32(hashString(id + ':err') ^ o.seed);
  return rng() < o.errorRate;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a mock pointer. Uses the assets ViewType so the mock integrates
 * with the existing URL scheme, but callers should override via `overrides`
 * when they need a specific pointer.
 */
export function mockPointerFor(id: string): DockPointer {
  return new DockPointer(ViewType.ASSETS, `mock/${id}`);
}

/**
 * Create a single mock Browseable with overrides. Mirrors the inline-factory
 * convention used in `directory-tree.test.tsx`.
 */
export function createMockBrowseable(overrides: Partial<Browseable> & { id: string }): Browseable {
  return {
    kind: 'mock',
    label: overrides.id,
    hasChildren: false,
    pointer: mockPointerFor(overrides.id),
    ...overrides,
  };
}

/**
 * Build a deterministic tree of N roots × children × grandchildren using the
 * given seed. Every subtree's shape is a pure function of the seed and id.
 */
export function createMockTree(opts?: MockBrowseableOptions): BrowseableRoot[] {
  const o = resolveOptions(opts);
  const rootRng = mulberry32(o.seed);

  const rootCount = 3;
  const roots: BrowseableRoot[] = [];
  for (let i = 0; i < rootCount; i++) {
    const rootId = `root-${i}`;
    roots.push(createMockRoot(rootId, { ...opts, seed: o.seed + Math.floor(rootRng() * 1000) }));
  }
  return roots;
}

/**
 * Create a single mock root with lazy children. The subtree shape is
 * deterministic: same `name` + `opts` produce the same tree.
 */
export function createMockRoot(name: string, opts?: MockBrowseableOptions): BrowseableRoot {
  const o = resolveOptions(opts);
  const rootId = `mock:${name}`;
  const rootRng = mulberry32(hashString(rootId) ^ o.seed);
  const childCount = 4 + Math.floor(rootRng() * 5); // 4..8

  const children: Browseable[] = [];
  for (let i = 0; i < childCount; i++) {
    const childId = `${rootId}/child-${i}`;
    const childRng = mulberry32(hashString(childId) ^ o.seed);
    const hasGrandchildren = childRng() < 0.5;
    children.push(makeMockChild(childId, hasGrandchildren, o));
  }

  const root: BrowseableRoot = {
    id: rootId,
    kind: 'root',
    label: name,
    hasChildren: true,
    pointer: mockPointerFor(rootId),
    toolbar: makeMockToolbar(`${rootId}:toolbar`),
    listChildren: async () => {
      await sleep(mockDelayFor(rootId, o));
      if (mockShouldError(rootId, o)) {
        throw new Error(`Mock failure: cannot list children of ${rootId}`);
      }
      return children;
    },
    ownsPointer: (p) => !!p.pointer && p.pointer.startsWith(`mock/${rootId}`),
    pathFor: async (p) => pathFromPointer(p, root, children, o),
  };
  return root;
}

function makeMockChild(
  id: string,
  hasGrandchildren: boolean,
  o: ResolvedOptions,
): Browseable {
  const grandchildren: Browseable[] = hasGrandchildren
    ? Array.from({ length: 2 + Math.floor(mulberry32(hashString(id) ^ o.seed)() * 3) }, (_, j) =>
        makeMockLeaf(`${id}/gc-${j}`),
      )
    : [];

  return {
    id,
    kind: hasGrandchildren ? 'folder' : 'leaf',
    label: id.split('/').pop() ?? id,
    hasChildren: hasGrandchildren ? true : false,
    pointer: mockPointerFor(id),
    listChildren: hasGrandchildren
      ? async () => {
          await sleep(mockDelayFor(id, o));
          if (mockShouldError(id, o)) {
            throw new Error(`Mock failure: cannot list children of ${id}`);
          }
          return grandchildren;
        }
      : undefined,
  };
}

function makeMockLeaf(id: string): Browseable {
  return {
    id,
    kind: 'leaf',
    label: id.split('/').pop() ?? id,
    hasChildren: false,
    pointer: mockPointerFor(id),
  };
}

function makeMockToolbar(prefix: string): ToolbarAction[] {
  return [
    { id: `${prefix}:refresh`, icon: null, label: 'Refresh', run: () => {} },
    { id: `${prefix}:new`, icon: null, label: 'New', run: () => {} },
  ];
}

/**
 * Walk a pointer's mock id path to reconstruct the chain of Browseables.
 * The pointer format is `mock/<rootId>[/child/.../leaf]`. We traverse by
 * calling listChildren at each level, mirroring how a real adapter would.
 */
async function pathFromPointer(
  p: DockPointer,
  root: BrowseableRoot,
  cachedRootChildren: Browseable[],
  o: ResolvedOptions,
): Promise<Browseable[]> {
  const ptr = p.pointer ?? '';
  if (!ptr.startsWith('mock/')) return [root];
  const targetId = ptr.slice('mock/'.length);
  if (targetId === root.id) return [root];

  const chain: Browseable[] = [root];
  let currentChildren: Browseable[] = cachedRootChildren;
  let cursor = root.id;

  while (cursor !== targetId) {
    const next = currentChildren.find(
      (c) => c.id === targetId || targetId.startsWith(c.id + '/'),
    );
    if (!next) break;
    chain.push(next);
    if (next.id === targetId) break;
    if (!next.listChildren) break;
    currentChildren = await next.listChildren();
    cursor = next.id;
    // Hard cap depth to avoid runaway loops on malformed ids
    if (chain.length > 32) break;
  }
  return chain;
}

/**
 * Convenience: build a tree + surface the test-useful knobs on the returned
 * object so callers can reason about expected delays/paths.
 */
export interface MockBrowseableKit {
  roots: BrowseableRoot[];
  options: ResolvedOptions;
  delayFor: (id: string) => number;
  shouldError: (id: string) => boolean;
  pointerFor: (id: string) => DockPointer;
}

export function createMockBrowseableKit(opts?: MockBrowseableOptions): MockBrowseableKit {
  const options = resolveOptions(opts);
  return {
    roots: createMockTree(opts),
    options,
    delayFor: (id) => mockDelayFor(id, opts),
    shouldError: (id) => mockShouldError(id, opts),
    pointerFor: (id) => mockPointerFor(id),
  };
}
