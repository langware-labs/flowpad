/**
 * Frontend half of the front/back container-sort parity proof.
 *
 * Runs the SHARED matrix (`../fixtures/container-sort-matrix.json`) through
 * `sortContainer` and asserts the same expected id sequence that
 * `tests/unit/test_container_sort.py` asserts on `sort_container`. Same JSON,
 * same expectations both sides ⇒ desktop ordering agrees by construction.
 */
import { describe, expect, it } from 'vitest';
import matrix from '../fixtures/container-sort-matrix.json';
import { sortContainer } from '@src/lib/container-sort';

type Case = {
  name: string;
  rows: { id: string; order?: number; created_date?: string }[];
  expected: string[];
};

describe('container-sort parity matrix', () => {
  for (const c of (matrix as { cases: Case[] }).cases) {
    it(c.name, () => {
      expect(sortContainer(c.rows).map((r) => r.id)).toEqual(c.expected);
    });
  }
});
