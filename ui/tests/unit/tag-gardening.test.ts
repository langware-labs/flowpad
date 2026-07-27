// The tags gardening merge: blessed entities + bus-observed anonymous names
// → one taxonomy tree grouped by first segment. Pure-function slice of
// ui/src/components/browseable-tree/adapters/tagRoot.tsx.
import { describe, expect, it } from 'vitest';
import { mergeTagRows } from '@src/components/browseable-tree/adapters/tagRoot';

const OBS = { count: 3, first_ts: 't0', last_ts: 't1', last_target: 'x:1' };

describe('mergeTagRows', () => {
  it('groups by first segment, sorted, one row per name', () => {
    const byRoot = mergeTagRows(
      [
        { id: '1', name: 'flow.done' },
        { id: '2', name: 'flow.started' },
        { id: '3', name: 'entity.created' },
      ],
      { 'flow.done': OBS, 'zeta.web': OBS },
    );
    expect([...byRoot.keys()]).toEqual(['entity', 'flow', 'zeta']);
    expect(byRoot.get('flow')!.map((r) => r.name)).toEqual(['flow.done', 'flow.started']);
  });

  it('attaches observed stats to blessed rows and keeps anonymous rows separate', () => {
    const byRoot = mergeTagRows([{ id: '1', name: 'flow.done' }], {
      'flow.done': OBS,
      'flow.mystery': OBS,
    });
    const rows = byRoot.get('flow')!;
    const blessed = rows.find((r) => r.name === 'flow.done')!;
    const anonymous = rows.find((r) => r.name === 'flow.mystery')!;
    expect(blessed.blessed?.id).toBe('1');
    expect(blessed.observed).toEqual(OBS);
    expect(anonymous.blessed).toBeNull();
    expect(anonymous.observed).toEqual(OBS);
  });

  it('namespace tags group under their --ns-- marker', () => {
    const byRoot = mergeTagRows([{ id: '1', name: '--acme--.orders.created' }], {});
    expect(byRoot.get('--acme--')!.map((r) => r.name)).toEqual(['--acme--.orders.created']);
  });

  it('tolerates empty inputs', () => {
    expect(mergeTagRows([], {}).size).toBe(0);
  });
});
