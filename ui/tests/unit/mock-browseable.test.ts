import { describe, it, expect } from 'vitest';
import {
  createMockRoot,
  createMockTree,
  createMockBrowseableKit,
  mockDelayFor,
  mockShouldError,
  mockPointerFor,
} from '@src/components/browseable-tree/MockBrowseable';

describe('MockBrowseable determinism', () => {
  it('same seed produces identical root ids and labels', () => {
    const a = createMockTree({ seed: 42 });
    const b = createMockTree({ seed: 42 });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.map((r) => r.label)).toEqual(b.map((r) => r.label));
  });

  it('different seeds may produce different children counts', async () => {
    const a = createMockRoot('same-name', { seed: 1 });
    const b = createMockRoot('same-name', { seed: 9999 });
    const [ac, bc] = await Promise.all([a.listChildren!(), b.listChildren!()]);
    // At least one of: different count OR different first-child id
    const different = ac.length !== bc.length || ac[0]?.id !== bc[0]?.id;
    expect(different).toBe(true);
  });

  it('same seed + same name produces identical subtree shape', async () => {
    const a = createMockRoot('root-0', { seed: 7 });
    const b = createMockRoot('root-0', { seed: 7 });
    const [ac, bc] = await Promise.all([a.listChildren!(), b.listChildren!()]);
    expect(ac.map((n) => n.id)).toEqual(bc.map((n) => n.id));
    expect(ac.map((n) => n.hasChildren)).toEqual(bc.map((n) => n.hasChildren));
  });
});

describe('MockBrowseable delays', () => {
  it('mockDelayFor returns baseDelayMs when jitterMs is 0', () => {
    expect(mockDelayFor('root-0', { seed: 1, baseDelayMs: 50, jitterMs: 0 })).toBe(50);
    expect(mockDelayFor('anything', { seed: 2, baseDelayMs: 0, jitterMs: 0 })).toBe(0);
  });

  it('delays fall within [base, base+jitter]', () => {
    const opts = { seed: 1, baseDelayMs: 20, jitterMs: 30 };
    for (const id of ['root-0', 'root-1', 'mock:alpha', 'mock:beta/child-2']) {
      const d = mockDelayFor(id, opts);
      expect(d).toBeGreaterThanOrEqual(20);
      expect(d).toBeLessThanOrEqual(50);
    }
  });

  it('same id + opts always returns the same delay', () => {
    const opts = { seed: 1, baseDelayMs: 10, jitterMs: 100 };
    expect(mockDelayFor('root-0', opts)).toBe(mockDelayFor('root-0', opts));
  });

  it('listChildren resolves after at least baseDelayMs', async () => {
    const root = createMockRoot('timed', { baseDelayMs: 20, jitterMs: 0 });
    const start = Date.now();
    await root.listChildren!();
    const elapsed = Date.now() - start;
    // Allow 5ms grace for timer slop
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it('listChildren resolves immediately when delays are 0', async () => {
    const root = createMockRoot('instant', { baseDelayMs: 0, jitterMs: 0 });
    const start = Date.now();
    await root.listChildren!();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(25);
  });
});

describe('MockBrowseable error injection', () => {
  it('errorRate=0 never errors', () => {
    for (const id of ['a', 'b', 'c', 'd', 'mock:x/y/z']) {
      expect(mockShouldError(id, { errorRate: 0 })).toBe(false);
    }
  });

  it('errorRate=1 always errors', () => {
    for (const id of ['a', 'b', 'c', 'd', 'mock:x/y/z']) {
      expect(mockShouldError(id, { errorRate: 1 })).toBe(true);
    }
  });

  it('listChildren rejects when errorRate=1', async () => {
    const root = createMockRoot('boom', { errorRate: 1 });
    await expect(root.listChildren!()).rejects.toThrow(/Mock failure/);
  });

  it('listChildren resolves when errorRate=0', async () => {
    const root = createMockRoot('ok', { errorRate: 0 });
    await expect(root.listChildren!()).resolves.toBeDefined();
  });
});

describe('MockBrowseable kit', () => {
  it('createMockBrowseableKit bundles roots with inspection helpers', () => {
    const kit = createMockBrowseableKit({ seed: 5, baseDelayMs: 1, jitterMs: 2 });
    expect(kit.roots.length).toBeGreaterThan(0);
    expect(kit.options.seed).toBe(5);
    expect(kit.options.baseDelayMs).toBe(1);
    expect(kit.options.jitterMs).toBe(2);
    const id = kit.roots[0].id;
    expect(kit.pointerFor(id).pointer).toBe(`mock/${id}`);
    expect(kit.delayFor(id)).toBeGreaterThanOrEqual(1);
    expect(kit.delayFor(id)).toBeLessThanOrEqual(3);
  });

  it('mockPointerFor produces stable pointer strings', () => {
    expect(mockPointerFor('a').pointer).toBe('mock/a');
    expect(mockPointerFor('x/y').pointer).toBe('mock/x/y');
  });
});
