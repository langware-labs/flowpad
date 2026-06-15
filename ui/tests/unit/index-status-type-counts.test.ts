/**
 * Unit tests for `typeCountsFromPerType` — the pure projection that turns the
 * single `index-status` `per_type` array into a `Map<type_name, entity_count>`.
 * The asset sidebar sources every type's count badge from this one map instead
 * of firing one `/search?limit=1` probe per type row (the request-amplification
 * that dominated the asset list page's load).
 */
import { describe, expect, it } from 'vitest';
import { typeCountsFromPerType, type IndexStatusPerType } from '@src/hooks/use-index-status';

const row = (type_name: string, entity_count: number): IndexStatusPerType => ({
  type_name,
  entity_count,
  last_indexed_at: null,
  stale: false,
  orphan_count: 0,
});

describe('typeCountsFromPerType', () => {
  it('maps each type_name to its entity_count', () => {
    const m = typeCountsFromPerType([row('markdown', 285), row('project', 78), row('skill', 0)]);
    expect(m.get('markdown')).toBe(285);
    expect(m.get('project')).toBe(78);
    expect(m.get('skill')).toBe(0);
    expect(m.size).toBe(3);
  });

  it('returns an empty map for undefined / empty input (loading / no data)', () => {
    expect(typeCountsFromPerType(undefined).size).toBe(0);
    expect(typeCountsFromPerType([]).size).toBe(0);
  });

  it('returns undefined for an unknown type (badge renders nothing)', () => {
    const m = typeCountsFromPerType([row('markdown', 285)]);
    expect(m.get('agent')).toBeUndefined();
  });

  it('preserves a zero count distinctly from "missing" (0 vs undefined)', () => {
    const m = typeCountsFromPerType([row('skill', 0)]);
    expect(m.get('skill')).toBe(0);
    expect(m.has('skill')).toBe(true);
  });
});
