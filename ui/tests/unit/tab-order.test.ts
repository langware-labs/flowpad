/**
 * Frontend half of the front/back tab-ordering parity proof.
 *
 * Runs the SHARED matrix (`../fixtures/tab-order-matrix.json`) through the pure
 * `tab-order` port and asserts the same `expectedOrder` / `expectedWrites` /
 * `expectedFiltered` that `tests/unit/test_tab_order.py` asserts on the backend.
 * Same JSON, same expectations on both sides ⇒ front and back agree on order for
 * every case by construction. If the predictOrder port ever drifts from
 * `flow_sdk/builtin/tab_order.py`, a case here breaks.
 */
import { describe, expect, it } from 'vitest';
import matrix from '../fixtures/tab-order-matrix.json';
import {
  changedIds,
  computeClose,
  computeInsertNew,
  computeReorder,
  filterForProject,
} from '@sdk/tabs';

type Case = {
  name: string;
  tabs: { id: string; project: string | null }[];
  op: 'reorder' | 'new_tab' | 'close' | 'reopen' | 'filter';
  args: Record<string, string | null>;
  expectedOrder: string[];
  expectedWrites?: string[];
  expectedFiltered?: Record<string, string[]>;
};

const cases = matrix.cases as unknown as Case[];

function projectMap(c: Case): Record<string, string | null> {
  const m: Record<string, string | null> = {};
  for (const t of c.tabs) m[t.id] = t.project;
  if (c.op === 'new_tab') m[c.args.new_id as string] = c.args.project ?? null;
  return m;
}

function apply(c: Case): string[] {
  const order = c.tabs.map((t) => t.id);
  const a = c.args;
  switch (c.op) {
    case 'reorder':
      return computeReorder(order, a.reorder_id as string, a.after_id, a.before_id);
    case 'new_tab':
      return computeInsertNew(order, a.new_id as string, a.after_id);
    case 'close':
      return computeClose(order, a.id as string);
    case 'reopen':
    case 'filter':
      return [...order];
  }
}

describe('tab-order (front/back parity matrix)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const inputOrder = c.tabs.map((t) => t.id);
      const result = apply(c);

      expect(result).toEqual(c.expectedOrder);

      if (c.expectedWrites !== undefined) {
        expect(changedIds(inputOrder, result)).toEqual(new Set(c.expectedWrites));
      }

      if (c.expectedFiltered) {
        const pmap = projectMap(c);
        for (const [key, expected] of Object.entries(c.expectedFiltered)) {
          const pid = key === 'null' ? null : key;
          expect(filterForProject(result, pmap, pid)).toEqual(expected);
        }
      }
    });
  }
});
