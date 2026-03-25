import { describe, it, expect, beforeEach } from 'vitest';
import { LineRegistry } from '../../registry/LineRegistry.js';
import type { EnrichedChunk, ExpectedLineCoord } from '../../types.js';

function coord(logicalLine: number, bufferRow: number, timestamp: number): ExpectedLineCoord {
  return { logicalLine, bufferRow, timestamp, pixelY: bufferRow * 14 };
}

function chunk(seq: number, coords: ExpectedLineCoord[]): EnrichedChunk {
  return {
    chunk: { seq, data: new Uint8Array(), timestamp: coords[0]?.timestamp ?? 0 },
    expectedLines: coords,
  };
}

describe('LineRegistry', () => {
  let reg: LineRegistry;

  beforeEach(() => {
    reg = new LineRegistry();
  });

  it('starts empty', () => {
    expect(reg.size()).toBe(0);
    expect(reg.all()).toEqual([]);
  });

  it('push registers by logicalLine, bufferRow, and timestamp', () => {
    const c = coord(1, 0, 1000);
    reg.push(chunk(1, [c]));

    expect(reg.getByLogicalLine(1)).toEqual(c);
    expect(reg.getByBufferRow(0)).toEqual(c);
    expect(reg.getByTimestamp(1000)).toEqual(c);
    expect(reg.size()).toBe(1);
  });

  it('push with multiple coords per chunk', () => {
    const c1 = coord(1, 0, 1000);
    const c2 = coord(2, 1, 1001);
    reg.push(chunk(1, [c1, c2]));

    expect(reg.size()).toBe(2);
    expect(reg.getByLogicalLine(1)).toEqual(c1);
    expect(reg.getByLogicalLine(2)).toEqual(c2);
  });

  it('later push overwrites earlier entry for the same logicalLine', () => {
    const c1 = coord(1, 0, 1000);
    const c2 = coord(1, 5, 2000); // same logicalLine, different position
    reg.push(chunk(1, [c1]));
    reg.push(chunk(2, [c2]));

    expect(reg.getByLogicalLine(1)).toEqual(c2);
  });

  it('all() returns all registered coords', () => {
    reg.push(chunk(1, [coord(1, 0, 1000)]));
    reg.push(chunk(2, [coord(2, 1, 2000), coord(3, 2, 3000)]));

    const all = reg.all();
    expect(all).toHaveLength(3);
    expect(all.map(c => c.logicalLine).sort()).toEqual([1, 2, 3]);
  });

  it('getByLogicalLine returns undefined for unknown line', () => {
    expect(reg.getByLogicalLine(99)).toBeUndefined();
  });

  it('getByBufferRow returns undefined for unknown row', () => {
    expect(reg.getByBufferRow(99)).toBeUndefined();
  });

  it('getByTimestamp returns undefined for unknown timestamp', () => {
    expect(reg.getByTimestamp(9999)).toBeUndefined();
  });

  // ─── evict ────────────────────────────────────────────────────────────────

  it('evict removes bufferRow lookup but keeps logicalLine and timestamp', () => {
    const c = coord(1, 0, 1000);
    reg.push(chunk(1, [c]));
    reg.evict(0);

    expect(reg.getByBufferRow(0)).toBeUndefined();
    expect(reg.getByLogicalLine(1)).toEqual(c); // still accessible by logicalLine
    expect(reg.getByTimestamp(1000)).toEqual(c); // still accessible by timestamp
  });

  it('evict on unknown row is a no-op', () => {
    expect(() => reg.evict(999)).not.toThrow();
  });

  it('all() still includes evicted coords (byLogical is source of truth)', () => {
    reg.push(chunk(1, [coord(1, 0, 1000)]));
    reg.evict(0);
    // all() iterates byLogical which still has the entry
    expect(reg.all()).toHaveLength(1);
  });

  it('size() reflects logical-line count, unchanged by evict', () => {
    reg.push(chunk(1, [coord(1, 0, 1000), coord(2, 1, 2000)]));
    reg.evict(0);
    expect(reg.size()).toBe(2);
  });
});
