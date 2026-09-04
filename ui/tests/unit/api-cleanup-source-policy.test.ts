/**
 * Every api-tier test that creates a Project must also be able to delete it.
 *
 * The tier creates REAL entities on a REAL backend, and the teardown sweep identifies
 * "ours" by name — `e2etest-<kind>-<runId>-<seq>` — because the backend is shared across
 * per-file forks and a neighbour's row must never be deleted by us. That scoping is sound,
 * and it is also the hazard: an entity named anything else is invisible to the sweep AND
 * to `assertNoLeaks`, so it survives a green run with nothing anywhere saying so.
 *
 * 1,550 `project` rows accumulated in a dev database exactly this way — one per test run,
 * 39 of them named `flow_tab_heal_p1` — until a Records Scanner reported ~1,200 projects
 * no human had made. Measured at the time: five files leaked 22 rows per run between them;
 * the files using a real cleanup mechanism leaked zero.
 *
 * A source policy rather than a runtime assertion, deliberately. Whether a row survives is
 * only observable across another file's whole teardown, which is the tier harness itself —
 * not something one test can assert about another. The runtime half of the contract (that
 * the sweep purges a marked name and cannot purge an ad-hoc one) lives in
 * `tests/api/cleanup_sweep_contract.test.ts`, where it has a backend to prove it against.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_DIR = resolve(__dirname, '../api');

/**
 * The mechanisms that actually delete a Project, measured rather than assumed: files using
 * one of these leaked zero rows per run. `trackCreatedRows` keeps its `(Project.type)`
 * argument — a file tracking only its AgenticProcess rows would otherwise pass while
 * leaking projects.
 */
const CLEANUP_SIGNALS = ['trackForCleanup', 'trackCreatedRows(Project.type)'];

describe('api tier — project cleanup policy', () => {
  it('no api test creates a Project the teardown sweep cannot remove', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(API_DIR).filter((f) => f.endsWith('.test.ts'))) {
      const src = readFileSync(resolve(API_DIR, file), 'utf8');
      if (!src.includes('new Project({')) continue;
      // File-level on purpose: a create and the cleanup covering it are often on different
      // lines — a constructor here, `await p.save()` there — so a line-level rule reports
      // the constructor and calls a covered file a leak.
      if (CLEANUP_SIGNALS.some((signal) => src.includes(signal))) continue;
      src.split('\n').forEach((line, i) => {
        if (line.includes('new Project({')) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'these creates are invisible to the teardown sweep and leak a row per run; ' +
        'wrap them in trackForCleanup() or name them with testEntityName()',
    ).toEqual([]);
  });
});
