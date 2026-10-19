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
        { id: '1', name: 'graph_workflow.done' },
        { id: '2', name: 'graph_workflow.started' },
        { id: '3', name: 'entity.created' },
      ],
      { 'graph_workflow.done': OBS, 'zeta.web': OBS },
    );
    expect([...byRoot.keys()]).toEqual(['entity', 'graph_workflow', 'zeta']);
    expect(byRoot.get('graph_workflow')!.map((r) => r.name)).toEqual(['graph_workflow.done', 'graph_workflow.started']);
  });

  it('attaches observed stats to blessed rows and keeps anonymous rows separate', () => {
    const byRoot = mergeTagRows([{ id: '1', name: 'graph_workflow.done' }], {
      'graph_workflow.done': OBS,
      'graph_workflow.mystery': OBS,
    });
    const rows = byRoot.get('graph_workflow')!;
    const blessed = rows.find((r) => r.name === 'graph_workflow.done')!;
    const anonymous = rows.find((r) => r.name === 'graph_workflow.mystery')!;
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
