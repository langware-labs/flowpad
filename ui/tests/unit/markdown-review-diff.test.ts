import { describe, it, expect } from 'vitest';
import {
  buildReviewParts,
  annotate,
  countChanges,
  countPending,
  type Decision,
} from '@src/lib/markdown-review-diff';

const OLD = 'The quick cat sat on the mat.';
const NEW = 'The quick dog sat on the warm mat.';

describe('buildReviewParts', () => {
  it('produces eq/ins/del runs with ids only on changes', () => {
    const parts = buildReviewParts(OLD, NEW);
    expect(parts.some((p) => p.type === 'ins')).toBe(true);
    expect(parts.some((p) => p.type === 'del')).toBe(true);
    expect(parts.some((p) => p.type === 'eq')).toBe(true);
    for (const p of parts) {
      if (p.type === 'eq') expect(p.id).toBeNull();
      else expect(typeof p.id).toBe('number');
    }
    // ids are unique and sequential over changes
    const ids = parts.filter((p) => p.id != null).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('annotate invariants', () => {
  const parts = buildReviewParts(OLD, NEW);

  it('Final reproduces the new version exactly', () => {
    expect(annotate(parts, {}, { final: true })).toBe(NEW);
  });

  it('all-rejected reproduces the old version exactly', () => {
    const rejectAll: Record<number, Decision> = {};
    for (let i = 1; i <= countChanges(parts); i++) rejectAll[i] = 'rejected';
    expect(annotate(parts, rejectAll)).toBe(OLD);
  });

  it('all-accepted reproduces the new version exactly', () => {
    const acceptAll: Record<number, Decision> = {};
    for (let i = 1; i <= countChanges(parts); i++) acceptAll[i] = 'accepted';
    expect(annotate(parts, acceptAll)).toBe(NEW);
  });

  it('pending wraps changes in rev-tagged ins/del marks', () => {
    const md = annotate(parts, {});
    expect(md).toMatch(/<ins class="rev-\d+">/);
    expect(md).toMatch(/<del class="rev-\d+">/);
  });
});

describe('counts', () => {
  const parts = buildReviewParts(OLD, NEW);
  it('countChanges totals ins+del; countPending drops resolved', () => {
    const total = countChanges(parts);
    expect(total).toBeGreaterThan(0);
    expect(countPending(parts, {})).toBe(total);
    expect(countPending(parts, { 1: 'accepted' })).toBe(total - 1);
  });
});
