/**
 * The teardown sweep's contract, and the guard that keeps tests inside it.
 *
 * The api tier creates real entities on a real backend, so every one it makes has to be
 * removable. The sweep identifies "ours" by NAME — `e2etest-<kind>-<runId>-<seq>` — because
 * the backend is shared across per-file forks and a neighbour's row must never be deleted
 * by us. That is sound, and it is also the whole hazard: an entity named anything else is
 * invisible to the sweep AND to the leak detector, so it survives a green run with nothing
 * anywhere saying so.
 *
 * That is not hypothetical. 1,550 `project` rows accumulated in a dev instance's database
 * this way — one per test run, 39 of them named `flow_tab_heal_p1` — until a Records
 * Scanner reported ~1,200 projects that no human had made.
 *
 * This is the runtime half. The source policy that keeps tests inside the contract lives in
 * `tests/unit/api-cleanup-source-policy.test.ts`, where it needs no backend to be honest.
 */

import apiClient, { GRAPH_API_PREFIX } from '@sdk/client';
import { Project } from '@sdk';
import { describe, expect, it } from 'vitest';
import { purgeRunScoped, testEntityName, trackForCleanup } from '../_cleanup';

/**
 * Does the BACKEND still hold this row?
 *
 * Asked of the live listing, not `Project.getById`: the SDK answers that from its client
 * cache, so a deleted row still comes back as an object and a survival check reads as a
 * purge. The sweep operates on the backend, so the assertion has to as well.
 */
async function existsOnBackend(id: string): Promise<boolean> {
  const data = (await apiClient.get(`${GRAPH_API_PREFIX}/project`)) as unknown;
  const rows = (Array.isArray(data) ? data : ((data as { data?: unknown[] })?.data ?? [])) as Array<{ id?: string }>;
  return rows.some((r) => r?.id === id);
}

describe('teardown sweep contract', () => {
  it('purges an entity named through testEntityName', async () => {
    const p = await new Project({ name: testEntityName('project') }).save([]);
    const id = p.typeId.id;

    await purgeRunScoped(['project']);

    expect(await existsOnBackend(id)).toBe(false);
  });

  it('CANNOT purge an entity named ad-hoc — the whole reason the policy exists', async () => {
    /**
     * The mechanism, stated as a contract rather than left implicit: the sweep matches on
     * the marker, so a name it does not recognise is a row nobody will ever remove. This
     * test tidies up after itself by id; the leaking tests did not.
     */
    // Tracked by id so the tier's own afterEach removes it: the point is that the NAME
    // is unsweepable, not that the row should outlive this test.
    const p = trackForCleanup(await new Project({ name: `/tmp/flow_adhoc_${Date.now()}` }).save([]));

    await purgeRunScoped(['project']);

    expect(await existsOnBackend(p.typeId.id)).toBe(true);
  });
});
