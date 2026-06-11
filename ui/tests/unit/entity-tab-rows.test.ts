/**
 * Entity-backed tab rows (tab-management.md Part 3 §3 "entity" column): the
 * wire→row mapping for non-terminal kinds (markdown/skill/workflow) and the
 * shared non-destructive merge invariant, generalized from the terminal rows.
 *
 * Entity ids must be valid v4/v5 UUIDs (TypeId enforces the entity-id policy),
 * so readable labels map to fixed valid UUIDs via `uid`.
 */
import { describe, expect, it } from 'vitest';
import {
  byEntityTabOrder,
  ENTITY_TAB_KINDS,
  mergePreservingOrder,
  toEntityTabRow,
  type EntityTabRow,
} from '@src/tabs/useTabs';
import { uid } from '../utils/terminal-tab-fixtures';

function row(label: string, tabOrder = 0, extra: Partial<EntityTabRow> = {}): EntityTabRow {
  return {
    ...toEntityTabRow('markdown', { id: uid(label), name: label, tab_order: tabOrder }),
    ...extra,
  };
}

describe('toEntityTabRow', () => {
  it('maps the wire entity onto the row shape, key = TypeId string', () => {
    const r = toEntityTabRow('skill', {
      id: uid('s1'),
      name: 'My skill',
      project_id: uid('proj'),
      tab_order: 3,
      last_active_at: 1717000000000,
    });
    expect(r.kind).toBe('skill');
    expect(r.typeId.type).toBe('skill');
    expect(r.typeId.id).toBe(uid('s1'));
    expect(r.key).toBe(`skill-${uid('s1')}`);
    expect(r.name).toBe('My skill');
    expect(r.projectId).toBe(uid('proj'));
    expect(r.tabOrder).toBe(3);
    expect(r.lastActiveAt).toBe(1717000000000);
  });

  it('defaults absent fields: name null, projectId null (global), order 0, recency null', () => {
    const r = toEntityTabRow('workflow', { id: uid('w1') });
    expect(r.name).toBeNull();
    expect(r.projectId).toBeNull();
    expect(r.tabOrder).toBe(0);
    expect(r.lastActiveAt).toBeNull();
  });

  it('onboarded kinds are exactly markdown/skill/workflow', () => {
    expect([...ENTITY_TAB_KINDS]).toEqual(['markdown', 'skill', 'workflow']);
  });
});

describe('mergePreservingOrder over entity rows (shared invariant)', () => {
  const keyOf = (r: EntityTabRow) => r.key;

  it('first fetch adopts server order (byEntityTabOrder)', () => {
    const fetched = [row('b', 2), row('a', 0), row('c', 1)];
    const merged = mergePreservingOrder([], fetched, false, keyOf, byEntityTabOrder);
    expect(merged.map((r) => r.name)).toEqual(['a', 'c', 'b']);
  });

  it('subsequent fetch keeps local order, refreshes in place, drops removed, appends new', () => {
    const prev = [row('a', 0), row('b', 1), row('gone', 2)];
    const fetched = [row('b', 1, { name: 'b-renamed' }), row('a', 0), row('new', 5)];
    const merged = mergePreservingOrder(prev, fetched, true, keyOf, byEntityTabOrder);
    // a/b keep their local indices (refreshed), 'gone' drops, 'new' appends.
    expect(merged.map((r) => r.key)).toEqual([row('a').key, row('b').key, row('new').key]);
    expect(merged[1].name).toBe('b-renamed');
  });
});
