/**
 * The mirror contract between the TypeScript `ActivityProgressSpec` and the Python one.
 *
 * There is no JSON-Schema-to-TypeScript codegen in this repo, so the two halves of the
 * shape are kept in step by this test and nothing else. It drives a real activity through
 * the real `Activity` client against a live backend and asserts that every field the
 * TypeScript interface declares actually arrives — a field added on one side and not the
 * other fails HERE rather than as a silently-undefined value in somebody's footer chip.
 *
 * No mocks: that is the whole point of the tier and of this test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Activity, fraction, isTerminal, listActivities, type ActivityProgressSpec } from '@sdk/activity';
import { apiTestSetup } from '../utils/test-utils';

const ROOT = `e2etest-activity-${Date.now()}`;

/** Every key the TypeScript interface declares. Kept literal so a rename is caught. */
const MIRRORED_FIELDS: Array<keyof ActivityProgressSpec> = [
  'activity_id',
  'scope',
  'path',
  'name',
  'label',
  'icon',
  'state',
  'current',
  'message',
  'done',
  'total',
  'skipped',
  'errors_count',
  'errors',
  'counters',
  'children',
  'started_at',
  'updated_at',
  'finished_at',
  'seq',
];

describe('activity — frontend/backend shape contract', () => {
  beforeEach(async () => {
    await apiTestSetup();
  });

  afterEach(async () => {
    // Terminal evicts the tree; a leftover root would show on the next run's chip.
    await Activity.get(ROOT).cancel();
  });

  it('round-trips every field the TypeScript mirror declares', async () => {
    const act = Activity.get(ROOT);
    await act.label('Contract check');
    await act.icon('Search');
    await act.total(100);
    await act.current('~/notes/q3.md');
    await act.incSuccess(20);
    await act.incSkipped(5);
    await act.incError('encrypted', { ref: 'a.pdf', code: 'E_ENC' });
    await act.inc('orphans', 17);
    const spec = await act.message('half way');

    expect(spec).not.toBeNull();
    const received = spec as ActivityProgressSpec;

    for (const field of MIRRORED_FIELDS) {
      expect(received, `field '${String(field)}' is missing from the wire`).toHaveProperty(field);
    }

    expect(received.path).toBe(ROOT);
    expect(received.label).toBe('Contract check');
    expect(received.icon).toBe('Search');
    expect(received.total).toBe(100);
    expect(received.current).toBe('~/notes/q3.md');
    expect(received.done).toBe(25);
    expect(received.skipped).toBe(5);
    expect(received.errors_count).toBe(1);
    expect(received.errors[0].ref).toBe('a.pdf');
    expect(received.errors[0].code).toBe('E_ENC');
    expect(received.counters.orphans).toBe(17);
    expect(received.message).toBe('half way');
    expect(received.state).toBe('running');
    expect(typeof received.seq).toBe('number');
  });

  it('agrees with the backend on what fraction means', async () => {
    const act = Activity.get(ROOT);
    await act.total(4);
    const spec = (await act.incSuccess()) as ActivityProgressSpec;

    // The TS helper and the Python `fraction()` are separate implementations of one rule.
    expect(fraction(spec)).toBe(0.25);
  });

  it('reports an unknown total as unknown rather than as zero', async () => {
    const act = Activity.get(ROOT);
    const spec = (await act.incSuccess(7)) as ActivityProgressSpec;

    expect(spec.total).toBeNull();
    expect(fraction(spec)).toBeNull();
  });

  it('addresses children the same way on both sides', async () => {
    await Activity.get(ROOT).child('pdf').total(10);
    await Activity.get(`${ROOT}/pdf`).incSuccess(3);

    const tree = await Activity.get(ROOT).spec();

    expect(tree?.children).toHaveLength(1);
    expect(tree?.children[0].name).toBe('pdf');
    expect(tree?.children[0].done).toBe(3);
  });

  it('lists a live root and drops it once it is finished', async () => {
    await Activity.get(ROOT).incSuccess();

    const live = await listActivities(null, true);
    expect(live.map((a) => a.path)).toContain(ROOT);

    const finished = (await Activity.get(ROOT).done('all done')) as ActivityProgressSpec;
    expect(isTerminal(finished)).toBe(true);
    expect(finished.finished_at).not.toBeNull();

    const after = await listActivities(null, true);
    expect(after.map((a) => a.path)).not.toContain(ROOT);
    expect(await Activity.get(ROOT).spec()).toBeNull();
  });

  it('accepts the camelCase spelling the TypeScript side sends', async () => {
    // The client posts `incSuccess`; Python's verb is `inc_success`. One vocabulary.
    const spec = (await Activity.get(ROOT).incSuccess(2)) as ActivityProgressSpec;

    expect(spec.done).toBe(2);
  });
});
