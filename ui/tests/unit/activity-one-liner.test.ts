import { describe, expect, it } from 'vitest';
import { activityOneLiner } from '@src/components/footer/activity-one-liner';
import { activitySpec, qaTree } from '../support/activity-spec';

describe('activityOneLiner', () => {
  it('reads root · steps ended · step at work › deepest running · failures', () => {
    expect(activityOneLiner(qaTree())).toBe('QA cycle · 1/2 · vitest API 2/3 (blocked) › rca · 1 failed');
  });

  it('shows a planned outline before any step starts', () => {
    const spec = activitySpec({
      label: 'QA cycle',
      children: [
        activitySpec({ path: 'qa/p02', name: 'p02', label: 'pytest API', state: 'pending', total: 2 }),
        activitySpec({ path: 'qa/p05', name: 'p05', label: 'vitest API', state: 'pending', total: 3 }),
      ],
    });
    expect(activityOneLiner(spec)).toBe('QA cycle · 0/2');
  });

  it('a leaf reads its own count and what is in hand', () => {
    expect(activityOneLiner(activitySpec({ label: 'Indexing', done: 40, total: 100, current: 'a.md' }))).toBe(
      'Indexing · 40/100 · a.md',
    );
  });

  it('a finished root reads as its receipt', () => {
    expect(activityOneLiner(qaTree({ state: 'completed', message: '1 PASS · 1 RED' }))).toBe('QA cycle — 1 PASS · 1 RED');
  });
});
