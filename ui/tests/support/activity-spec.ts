import type { ActivityProgressSpec } from '@sdk/activity';

/** A complete `ActivityProgressSpec` with sensible defaults — override what the test is about. */
export function activitySpec(over: Partial<ActivityProgressSpec> = {}): ActivityProgressSpec {
  return {
    activity_id: 'a1',
    subject_entity: null,
    path: 'qa',
    name: 'qa',
    label: null,
    icon: null,
    state: 'running',
    current: null,
    message: null,
    done: 0,
    total: null,
    skipped: 0,
    errors_count: 0,
    errors: [],
    counters: {},
    children: [],
    started_at: '2026-10-03T12:00:00Z',
    updated_at: '2026-10-03T12:00:01Z',
    finished_at: null,
    seq: 1,
    ...over,
  };
}

/** The QA-cycle-shaped tree the pill and modal are built for: two planned phases, the
 *  second at work with one failure being debugged. */
export function qaTree(over: Partial<ActivityProgressSpec> = {}): ActivityProgressSpec {
  return activitySpec({
    label: 'QA cycle',
    children: [
      activitySpec({ path: 'qa/p02', name: 'p02', label: 'pytest API', state: 'completed', done: 2, total: 2, message: 'PASS · 2/2' }),
      activitySpec({
        path: 'qa/p05', name: 'p05', label: 'vitest API', state: 'blocked', done: 2, total: 3,
        message: '1 failing · 2 passed', errors_count: 1,
        errors: [{ message: 'expected 1 to be 2', ref: 'api/x.test.ts › fails', code: null, ts: '2026-10-03T12:00:02Z' }],
        counters: { runs: 2 },
        children: [
          activitySpec({
            path: 'qa/p05/fail-1', name: 'fail-1', label: 'api/x.test.ts › fails', children: [
              activitySpec({ path: 'qa/p05/fail-1/repro', name: 'repro', state: 'completed', message: 'reproduced 3/3' }),
              activitySpec({ path: 'qa/p05/fail-1/rca', name: 'rca', state: 'running', current: 'ws_manager.py' }),
              activitySpec({ path: 'qa/p05/fail-1/fix', name: 'fix', state: 'pending' }),
            ],
          }),
        ],
      }),
    ],
    ...over,
  });
}
